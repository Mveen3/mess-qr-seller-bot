'use strict';

const fs = require('fs');
const path = require('path');
const { MessageMedia } = require('whatsapp-web.js');
const config = require('./config');
const { isBuyerKeyword, isDoneKeyword } = require('./keywordMatcher');
const { extractPrice } = require('./priceParser');
const { getCurrentPrice, stopScheduler, getCurrentMeal, restartScheduler } = require('./priceScheduler');

// ─── State ──────────────────────────────────────────────────
let sold = false;
let currentBuyer = null;       // { id, name, chatId, chat, assignedAt }
let queueTimer = null;         // Timer that triggers moving to next buyer
let queueWarningTimer = null;  // Timer that warns current buyer before timeout
let reactOwnGroupMessages = false;
let reactedGroupMessages = new Set(); // msgIds with applied reactions (for removing later)
let allowTestingRevert = true;
let paymentVerificationInProgress = false;
let pendingScreenshotPaymentProof = null; // { buyerId, setAt, reason }
let buyerQueue = [];
let currentBuyerPaidAmount = 0;
let sbiKnownBalance = null;
const knownSbiSenderIds = new Set([config.SBI_BANKING_CHAT_ID]);
let stats = {
    messagesReceived: 0,
    negotiations: 0,
    soldPrice: null,
    buyerName: null,
    buyerId: null,
    timeSold: null,
};

function isSold() { return sold; }

function extractRupeeAmount(text) {
    if (!text || typeof text !== 'string') return null;

    const match = text.match(/₹\s*([0-9]+(?:\.[0-9]{1,2})?)/i);
    if (!match) return null;

    const amount = Number(match[1]);
    return Number.isFinite(amount) ? amount : null;
}

function isPaymentSignal(msg, currentPrice) {
    const type = (msg?.type || '').toLowerCase();
    const body = (msg?.body || '').trim();
    const bodyLower = body.toLowerCase();

    const paymentTypeHit = type.includes('payment') || type.includes('pay');

    const paymentTextHit = [
        'completed',
        'sent to you',
        'sent to naveenmishra',
        'sent to naveen mishra',
    ].some((pattern) => bodyLower.includes(pattern));

    const hasRupeeSymbol = body.includes('₹');
    const amount = extractRupeeAmount(body);
    const amountEnough = amount !== null && currentPrice !== null && amount >= currentPrice;

    if (paymentTypeHit) return true;
    if (paymentTextHit) return true;
    if (hasRupeeSymbol && amountEnough) return true;

    return false;
}

function isWhatsAppPaySignal(msg) {
    const type = (msg?.type || '').toLowerCase();
    return type.includes('payment');
}

function rememberSbiSender(senderId) {
    if (!senderId) return;
    knownSbiSenderIds.add(senderId);
}

function looksLikeSbiBotPrompt(text) {
    if (!text || typeof text !== 'string') return false;

    const normalized = normalizeSbiMessageText(text).toLowerCase();
    return (
        normalized.includes('dear customer') ||
        normalized.includes("it seems you've been inactive") ||
        normalized.includes('please clear this chat for safety') ||
        normalized.includes('available balance in a/c') ||
        normalized.includes('please wait while we fetch your balance details') ||
        normalized.includes('balance details') ||
        normalized.includes('mini statement') ||
        normalized.includes('get balance') ||
        normalized.includes('get mini statement') ||
        normalized.includes('debit card services') ||
        normalized.includes('interest certificate') ||
        normalized.includes('tap below to explore more services') ||
        normalized.includes('would you like to view more transactions') ||
        normalized.includes('please choose from any of the options below') ||
        normalized.includes('please choose appropriate options given below') ||
        normalized.includes('to continue, please type "hi" to access the main menu') ||
        normalized.includes("to continue, please type 'hi' to access the main menu")
    );
}

function isSbiBankingSender(senderId, body = '', options = {}) {
    const allowHeuristic = options.allowHeuristic === true;

    if (!senderId) return false;
    if (knownSbiSenderIds.has(senderId)) return true;
    if (!allowHeuristic) return false;

    if (looksLikeMiniStatementMessage(body) || looksLikeBalanceMessage(body) || looksLikeSbiBotPrompt(body)) {
        rememberSbiSender(senderId);
        return true;
    }

    return false;
}

function getTodayLogKey() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

function getTodayStatementDateKey() {
    return new Date().toLocaleDateString('en-GB', { timeZone: 'Asia/Kolkata' });
}

function normalizeStatementLine(line) {
    return String(line || '').replace(/\s+/g, ' ').trim();
}

function normalizeSbiMessageText(text) {
    return String(text || '')
        .replace(/[\u200e\u200f]/g, '')
        .replace(/[\u00a0]/g, ' ')
        .replace(/[*_~`]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
}

function ensureParentDirForFile(filePath) {
    if (!filePath) return;

    const parentDir = path.dirname(filePath);
    if (!fs.existsSync(parentDir)) {
        fs.mkdirSync(parentDir, { recursive: true });
    }
}

function ensureDailyPaymentVerificationLog() {
    const logPath = config.PAYMENT_VERIFICATION_LOG_PATH;
    const today = getTodayLogKey();

    if (!logPath) {
        return { date: today, transactions: [] };
    }

    ensureParentDirForFile(logPath);

    let data = null;
    if (fs.existsSync(logPath)) {
        try {
            data = JSON.parse(fs.readFileSync(logPath, 'utf8'));
        } catch (err) {
            console.warn(`⚠️  [Handler] Payment verification log is unreadable. Recreating it: ${err.message}`);
        }
    }

    const transactions = Array.isArray(data?.transactions) ? data.transactions : [];
    if (!data || data.date !== today) {
        const freshLog = { date: today, transactions: [] };
        fs.writeFileSync(logPath, JSON.stringify(freshLog, null, 2), 'utf8');
        console.log(`🗂️  [Handler] Initialized daily payment verification log for ${today}.`);
        return freshLog;
    }

    return { date: today, transactions };
}

function persistPaymentVerificationLog(logData) {
    const logPath = config.PAYMENT_VERIFICATION_LOG_PATH;
    if (!logPath) return;

    ensureParentDirForFile(logPath);
    fs.writeFileSync(logPath, JSON.stringify(logData, null, 2), 'utf8');
}

function looksLikeMiniStatementMessage(text) {
    if (!text || typeof text !== 'string') return false;

    const normalized = normalizeSbiMessageText(text);
    if (!/available balance in a\/c/i.test(normalized)) return false;
    if (!/\d{2}\/\d{2}\/\d{4}\s*:/.test(normalized)) return false;
    return true;
}

function looksLikeBalanceMessage(text) {
    if (!text || typeof text !== 'string') return false;

    const normalized = normalizeSbiMessageText(text);
    if (!/available balance in a\/c/i.test(normalized)) return false;
    if (!/rs\.?\s*[0-9,]+(?:\.[0-9]{1,2})?\s*(?:cr|dr)?\b/i.test(normalized)) return false;
    return true;
}

function parseAvailableBalance(text) {
    if (!text || typeof text !== 'string') return null;

    const normalized = normalizeSbiMessageText(text);
    const contextMatch = normalized.match(
        /available balance in a\/c[^:]*:\s*rs\.?\s*([0-9,]+(?:\.[0-9]{1,2})?)\s*(?:cr|dr)?\b/i
    );
    const fallbackMatch = normalized.match(/rs\.?\s*([0-9,]+(?:\.[0-9]{1,2})?)\s*(?:cr|dr)?\b/i);
    const match = contextMatch || fallbackMatch;
    if (!match) return null;

    const amount = Number(match[1].replace(/,/g, ''));
    return Number.isFinite(amount) ? amount : null;
}

function waitForIncomingMessage(filterFn, timeoutMs) {
    if (!globalClient) {
        return Promise.reject(new Error('WhatsApp client is not ready.'));
    }

    return new Promise((resolve, reject) => {
        let settled = false;
        let timer = null;

        const cleanup = () => {
            if (timer) clearTimeout(timer);
            globalClient.removeListener('message_create', onMessageCreate);
        };

        const finish = (fn, value) => {
            if (settled) return;
            settled = true;
            cleanup();
            fn(value);
        };

        const onMessageCreate = (incomingMsg) => {
            try {
                if (incomingMsg?.fromMe) return;
                if (!filterFn(incomingMsg)) return;
                finish(resolve, incomingMsg);
            } catch (_) {
                // Ignore malformed incoming messages and continue waiting.
            }
        };

        timer = setTimeout(() => {
            finish(reject, new Error('Timed out waiting for expected WhatsApp message.'));
        }, timeoutMs);

        globalClient.on('message_create', onMessageCreate);
    });
}

async function fetchAccountBalanceFromSbi() {
    if (!globalClient) throw new Error('WhatsApp client is not ready.');

    const balanceWaitPromise = waitForIncomingMessage(
        (incomingMsg) => {
            const incomingBody = (incomingMsg.body || '').trim();
            if (!looksLikeBalanceMessage(incomingBody)) return false;
            return isSbiBankingSender(incomingMsg.from, incomingBody, { allowHeuristic: true });
        },
        config.PAYMENT_VERIFICATION_TIMEOUT_MS
    );

    const balanceCommand = config.SBI_BALANCE_COMMAND || 'Get Balance💸';
    await globalClient.sendMessage(config.SBI_BANKING_CHAT_ID, balanceCommand);
    console.log('🏦 [Handler] Requested account balance from SBI WhatsApp banking.');

    const balanceMsg = await balanceWaitPromise;

    rememberSbiSender(balanceMsg?.from);
    const availableBalance = parseAvailableBalance((balanceMsg.body || '').trim());
    if (!Number.isFinite(availableBalance)) {
        throw new Error('Unable to parse account balance from SBI response.');
    }

    return availableBalance;
}

async function initializeSbiBalanceBaseline() {
    try {
        sbiKnownBalance = await fetchAccountBalanceFromSbi();
        console.log('🏦 [Handler] SBI balance baseline initialized.');
    } catch (err) {
        sbiKnownBalance = null;
        console.error('❌ [Handler] Failed to initialize SBI balance baseline:', err.message);
    }
}

function clearCurrentBuyerPaidAmount() {
    currentBuyerPaidAmount = 0;
}

function appendVerifiedPaymentToLog(logData, verificationEntry) {
    if (!logData) return;

    if (!Array.isArray(logData.transactions)) {
        logData.transactions = [];
    }

    logData.transactions.push({
        buyerName: verificationEntry.buyerName,
        meal: getCurrentMeal(),
        expectedPrice: Number(verificationEntry.expectedPrice),
        receivedAmount: Number(verificationEntry.receivedAmount),
        creditedThisCheck: Number(verificationEntry.creditedThisCheck),
        verifiedAt: new Date().toISOString(),
    });
    persistPaymentVerificationLog(logData);
}

function appendPartialPaymentAttemptToLog(logData, buyerName, expectedPrice, receivedAmount, creditedThisCheck) {
    if (!logData) return;
    if (!Array.isArray(logData.partialAttempts)) {
        logData.partialAttempts = [];
    }

    const expected = Number(expectedPrice);
    const received = Number(receivedAmount);
    const remainingAmount = Math.max(expected - received, 0);
    logData.partialAttempts.push({
        buyerName,
        meal: getCurrentMeal(),
        expectedPrice: expected,
        receivedAmount: received,
        creditedThisCheck: Number(creditedThisCheck),
        remainingAmount,
        checkedAt: new Date().toISOString(),
    });

    persistPaymentVerificationLog(logData);
}

function setPendingScreenshotPaymentProof(buyerId, reason) {
    if (!buyerId) return;

    pendingScreenshotPaymentProof = {
        buyerId,
        reason,
        setAt: Date.now(),
    };
}

function clearPendingScreenshotPaymentProof() {
    pendingScreenshotPaymentProof = null;
}

function canUseScreenshotPaymentProof(senderId) {
    if (!pendingScreenshotPaymentProof) return false;
    return pendingScreenshotPaymentProof.buyerId === senderId;
}

async function verifyPaymentAndCompleteSale(chat, buyerName, currentPrice) {
    if (paymentVerificationInProgress) {
        await chat.sendMessage(config.paymentVerificationInProgressAlreadyMessage());
        return;
    }

    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
        await chat.sendMessage(config.paymentVerificationSystemErrorMessage());
        return;
    }

    clearPendingScreenshotPaymentProof();
    paymentVerificationInProgress = true;
    clearAllTimers();

    try {
        await chat.sendMessage(config.paymentVerificationInProgressMessage());

        const logData = ensureDailyPaymentVerificationLog();
        if (!Number.isFinite(sbiKnownBalance)) {
            sbiKnownBalance = await fetchAccountBalanceFromSbi();
            currentBuyerPaidAmount = 0;
        }

        const latestBalance = await fetchAccountBalanceFromSbi();
        const balanceDelta = latestBalance - sbiKnownBalance;
        sbiKnownBalance = latestBalance;

        const creditedThisCheck = balanceDelta > 0 ? balanceDelta : 0;
        if (creditedThisCheck > 0) {
            currentBuyerPaidAmount += creditedThisCheck;
        }

        if (currentBuyerPaidAmount + 0.009 < currentPrice) {
            setPendingScreenshotPaymentProof(currentBuyer?.id, 'insufficient_amount');
            appendPartialPaymentAttemptToLog(
                logData,
                buyerName,
                currentPrice,
                currentBuyerPaidAmount,
                creditedThisCheck
            );

            if (currentBuyerPaidAmount > 0) {
                await chat.sendMessage(
                    config.paymentVerificationInsufficientAmountMessage(currentPrice, currentBuyerPaidAmount)
                );
            } else {
                await chat.sendMessage(config.paymentVerificationNoNewCreditMessage());
            }

            if (buyerQueue.length > 0) {
                scheduleNextBuyer(config.BUYER_INACTIVITY_MS);
            }
            return;
        }

        clearPendingScreenshotPaymentProof();
        appendVerifiedPaymentToLog(logData, {
            buyerName,
            expectedPrice: currentPrice,
            receivedAmount: currentBuyerPaidAmount,
            creditedThisCheck,
        });
        console.log('💳 [Handler] Verified payment via SBI balance increase.');
        clearCurrentBuyerPaidAmount();

        await completeSale(chat, buyerName, {
            confirmedPayment: true,
            allowBuyerTestingRevert: false,
        });
    } catch (err) {
        console.error('❌ [Handler] Payment verification failed:', err.message);
        await chat.sendMessage(config.paymentVerificationSystemErrorMessage());

        if (buyerQueue.length > 0) {
            scheduleNextBuyer(config.BUYER_INACTIVITY_MS);
        }
    } finally {
        paymentVerificationInProgress = false;
    }
}

// ═══════════════════════════════════════════════════════════════
//  MAIN MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════════

async function handleMessage(msg, client) {
    try {
        const senderId = msg.from;
        const body = (msg.body || '').trim();

        // ── Filter: only respond to personal DMs ────────────────
        if (senderId.endsWith('@broadcast') || senderId.endsWith('@g.us')) {
            return; // ignore status updates and group messages
        }

        // Ignore SBI banking chat traffic from normal buyer handling flow.
        // Heuristic matching is enabled here to handle SBI sender-id variations.
        if (isSbiBankingSender(senderId, body, { allowHeuristic: true })) return;

        const contact = await msg.getContact();
        const senderName = contact.pushname || contact.name || senderId;
        const chat = await msg.getChat();

        const me = client.info.wid._serialized;
        if (senderId === me) return;

        stats.messagesReceived++;
        console.log(`📩 [Handler] DM from ${senderName}: "${body}"`);

        // ── Already sold ────────────────────────────────────────
        if (sold) {
            // Un-sell if the ACTUAL buyer types "testing"
            if (allowTestingRevert && stats.buyerId === senderId && body.toLowerCase() === 'testing') {
                await revertSale(chat, senderName);
                return;
            }

            if (isBuyerKeyword(body)) {
                await chat.sendMessage(config.soldMessage());
                console.log(`🚫 [Handler] Replied "Sorry Sold" to ${senderName}.`);
            }
            return;
        }

        // ── Current buyer says "done", sends screenshot, or payment-signal arrives ────────────────
        if (currentBuyer && senderId === currentBuyer.id) {
            const price = getCurrentPrice();
            const doneKeyword = isDoneKeyword(body);
            const paymentSignal = isPaymentSignal(msg, price);
            const whatsappPaySignal = isWhatsAppPaySignal(msg);

            if (whatsappPaySignal) {
                console.log(`💳 [Handler] WhatsApp Pay signal detected for ${senderName}. Skipping SBI verification.`);
                await completeSale(chat, senderName, {
                    confirmedPayment: true,
                    allowBuyerTestingRevert: false,
                });
                return;
            }

            if (config.PAYMENT_VERIFICATION_ENABLED) {
                if (msg.hasMedia && canUseScreenshotPaymentProof(senderId)) {
                    clearPendingScreenshotPaymentProof();
                    await chat.sendMessage(config.paymentVerificationScreenshotAcceptedMessage());
                    await completeSale(chat, senderName, {
                        confirmedPayment: true,
                        allowBuyerTestingRevert: false,
                    });
                    return;
                }

                if (doneKeyword) {
                    await verifyPaymentAndCompleteSale(chat, senderName, price);
                    return;
                }

                if (msg.hasMedia || paymentSignal) {
                    await chat.sendMessage(config.paymentVerificationNoNewCreditMessage());
                    return;
                }
            } else if (msg.hasMedia || doneKeyword || paymentSignal) {
                if (paymentSignal) {
                    console.log(`💳 [Handler] Payment signal detected for ${senderName} (type: ${msg.type || 'unknown'}).`);
                }
                await completeSale(chat, senderName);
                return;
            }
        }

        // ── Negotiation (only if enabled) ───────────────────────
        if (config.ENABLE_NEGOTIATION) {
            const offeredPrice = extractPrice(body);
            if (offeredPrice !== null) {
                await handleNegotiation(chat, senderId, senderName, offeredPrice);
                return;
            }
        }

        // ── Buyer keyword ───────────────────────────────────────
        if (isBuyerKeyword(body)) {
            await handleBuyerIntent(chat, senderId, senderName, client);
            return;
        }

        // ── Unrecognized message from current buyer ─────────────
        if (currentBuyer && senderId === currentBuyer.id) {
            await chat.sendMessage(config.unrecognizedMessage());
            console.log(`❓ [Handler] Sent unrecognized-message prompt to ${senderName}.`);
            return;
        }
    } catch (err) {
        console.error('❌ [Handler] Error processing message:', err.message);
    }
}

// ═══════════════════════════════════════════════════════════════
//  BUYER INTENT
// ═══════════════════════════════════════════════════════════════

async function handleBuyerIntent(chat, senderId, senderName, client) {
    // Already the current buyer
    if (currentBuyer && currentBuyer.id === senderId) {
        console.log(`ℹ️  [Handler] ${senderName} is already the current buyer.`);
        return;
    }

    // No current buyer → assign directly
    if (!currentBuyer) {
        await assignBuyer(chat, senderId, senderName);
        return;
    }

    // There IS a current buyer — a second buyer has arrived
    const elapsed = Date.now() - currentBuyer.assignedAt;

    if (elapsed < config.BUYER_INACTIVITY_MS) {
        // ── Within 90s window → queue new buyer and schedule timeout ──
        const alreadyQueued = buyerQueue.some((b) => b.id === senderId);
        if (!alreadyQueued) {
            buyerQueue.push({ id: senderId, name: senderName, chatId: chat.id._serialized });
            console.log(`🔢 [Handler] ${senderName} queued (position ${buyerQueue.length}).`);
        }

        scheduleNextBuyer(config.BUYER_INACTIVITY_MS - elapsed);
    } else {
        // ── After 90s window → immediate move to next buyer ──
        console.log(`⏱️  [Handler] ${currentBuyer.name} exceeded 90s window. Sending timeout msg & assigning new buyer.`);
        
        const alreadyQueued = buyerQueue.some((b) => b.id === senderId);
        if (!alreadyQueued) {
            buyerQueue.push({ id: senderId, name: senderName, chatId: chat.id._serialized });
        }
        
        await moveNextBuyer();
    }
}

// ═══════════════════════════════════════════════════════════════
//  ASSIGN BUYER
// ═══════════════════════════════════════════════════════════════

async function assignBuyer(chat, senderId, senderName) {
    clearPendingScreenshotPaymentProof();
    clearCurrentBuyerPaidAmount();
    currentBuyer = {
        id: senderId,
        name: senderName,
        chatId: chat.id._serialized,
        chat,
        assignedAt: Date.now(),
    };
    console.log(`🛒 [Handler] Buyer assigned: ${senderName}`);

    try {
        await chat.sendMessage(config.UPI_ID);
        console.log('📤 [Handler] UPI ID sent.');

        const price = getCurrentPrice();
        const safePrice = Number.isFinite(price) && price > 0 ? price : config.DEFAULT_PRICE;
        await chat.sendMessage(config.payViaPhoneMessage(safePrice, config.PHONE_NUMBER));

        await chat.sendMessage(config.paymentInstructionMessage(config.PAYMENT_VERIFICATION_ENABLED));
        console.log('📤 [Handler] Payment instruction sent.');
    } catch (err) {
        console.error('❌ [Handler] Error sending buyer messages:', err.message);
    }

    if (buyerQueue.length > 0) {
        scheduleNextBuyer(config.BUYER_INACTIVITY_MS);
    }
}

// ═══════════════════════════════════════════════════════════════
//  TIMERS & QUEUES
// ═══════════════════════════════════════════════════════════════

function scheduleNextBuyer(delayMs) {
    if (queueTimer) return; // Wait until current timer finishes

    const safeDelayMs = Math.max(0, Number(delayMs) || 0);
    console.log(`⏱️  [Timer] Checking queue in ${Math.round(safeDelayMs / 1000)}s...`);

    const warningDelayMs = safeDelayMs - config.BUYER_TIMEOUT_WARNING_MS;
    const warningBuyerId = currentBuyer?.id || null;
    if (warningDelayMs > 0 && currentBuyer?.chat && buyerQueue.length > 0) {
        queueWarningTimer = setTimeout(async () => {
            queueWarningTimer = null;
            if (sold || !currentBuyer) return;
            if (!warningBuyerId || currentBuyer.id !== warningBuyerId) return;
            if (buyerQueue.length === 0) return;

            try {
                await currentBuyer.chat.sendMessage(config.timeoutWarningMessage());
                console.log(`⏳ [Timer] Sent timeout warning to ${currentBuyer.name}.`);
            } catch (err) {
                console.error('❌ [Timer] Error sending timeout warning:', err.message);
            }
        }, warningDelayMs);
    }

    queueTimer = setTimeout(async () => {
        queueTimer = null;
        if (sold || !currentBuyer) return;

        console.log(`⏱️  [Timer] ${currentBuyer.name} ran out of time. Checking queue.`);
        await moveNextBuyer();
    }, safeDelayMs);
}

async function moveNextBuyer() {
    if (!currentBuyer) return;

    try {
        await currentBuyer.chat.sendMessage(config.timeoutFinalMessage());
    } catch (err) {
        console.error('❌ [Timer] Error notifying leaving buyer:', err.message);
    }
    
    releaseBuyer();
    await tryNextBuyer();
}

function clearAllTimers() {
    if (queueTimer) { clearTimeout(queueTimer); queueTimer = null; }
    if (queueWarningTimer) { clearTimeout(queueWarningTimer); queueWarningTimer = null; }
}

function getMessageKey(msg) {
    return msg?.id?._serialized || msg?.id?.id || null;
}

async function findTargetGroupChat() {
    if (!globalClient) return null;

    const chats = await globalClient.getChats();
    return chats.find((c) => c.isGroup && c.name === config.GROUP_NAME) || null;
}

async function fetchOwnMessageIdsCompat(chatId, limit = 500) {
    if (!globalClient?.pupPage || !chatId) return [];

    return globalClient.pupPage.evaluate(async (serializedChatId, maxLimit) => {
        const limitValue = Number.isFinite(maxLimit) && maxLimit > 0 ? maxLimit : 500;

        const toMessageId = (msg) => {
            const id = msg?.id;
            if (!id) return null;
            return id._serialized || id.id || null;
        };

        const isOwnNonNotificationMessage = (msg) =>
            Boolean(msg) && !msg.isNotification && (msg?.id?.fromMe === true || msg?.fromMe === true);

        const getChatModel = async () => {
            const widFactory = window.Store?.WidFactory;
            const chatStore = window.Store?.Chat;
            if (!widFactory || !chatStore) return null;

            const wid = widFactory.createWid(serializedChatId);
            return chatStore.get(wid) || await chatStore.find(wid);
        };

        const chat = await getChatModel();
        if (!chat?.msgs) return [];

        const seen = new Set();
        const collected = [];

        const collectBatch = (messages) => {
            if (!Array.isArray(messages)) return false;

            const orderedMessages = [...messages].sort((a, b) => (a?.t || 0) - (b?.t || 0));
            for (const message of orderedMessages) {
                if (!isOwnNonNotificationMessage(message)) continue;

                const messageId = toMessageId(message);
                if (!messageId || seen.has(messageId)) continue;

                seen.add(messageId);
                collected.push(messageId);
                if (collected.length >= limitValue) return true;
            }

            return false;
        };

        const getLoadedMessages = () => {
            if (!chat.msgs) return [];
            if (typeof chat.msgs.getModelsArray === 'function') return chat.msgs.getModelsArray();
            if (Array.isArray(chat.msgs.models)) return chat.msgs.models;
            return [];
        };

        collectBatch(getLoadedMessages());

        const loaders = [];
        const conversationMsgs = window.Store?.ConversationMsgs;
        if (conversationMsgs?.loadEarlierMsgs) {
            loaders.push(() => conversationMsgs.loadEarlierMsgs(chat, chat.msgs));
            loaders.push(() => conversationMsgs.loadEarlierMsgs(chat.msgs, chat));
            loaders.push(() => conversationMsgs.loadEarlierMsgs(chat));
            loaders.push(() => conversationMsgs.loadEarlierMsgs(chat.msgs));
        }

        const msgStore = window.Store?.Msg;
        if (msgStore?.loadEarlierMsgs) {
            loaders.push(() => msgStore.loadEarlierMsgs(chat, chat.msgs));
            loaders.push(() => msgStore.loadEarlierMsgs(chat.msgs, chat));
            loaders.push(() => msgStore.loadEarlierMsgs(chat));
            loaders.push(() => msgStore.loadEarlierMsgs(chat.msgs));
        }

        let noProgressRounds = 0;
        while (collected.length < limitValue && loaders.length > 0 && noProgressRounds < 3) {
            let progress = false;

            for (const loadEarlier of loaders) {
                try {
                    const loaded = await loadEarlier();
                    const before = collected.length;

                    if (Array.isArray(loaded)) {
                        collectBatch(loaded);
                    } else if (Array.isArray(loaded?.messages)) {
                        collectBatch(loaded.messages);
                    } else if (Array.isArray(loaded?.models)) {
                        collectBatch(loaded.models);
                    }

                    if (collected.length > before) {
                        progress = true;
                        break;
                    }
                } catch (_) {
                    // Try the next loadEarlier signature.
                }
            }

            const beforeLoaded = collected.length;
            collectBatch(getLoadedMessages());
            if (collected.length > beforeLoaded) {
                progress = true;
            }

            noProgressRounds = progress ? 0 : noProgressRounds + 1;
        }

        if (collected.length > limitValue) {
            return collected.slice(collected.length - limitValue);
        }

        return collected;
    }, chatId, limit);
}

async function fetchOwnGroupMessagesForBackfill(limit = 500) {
    const targetGroup = await findTargetGroupChat();
    if (!targetGroup) {
        console.warn(`⚠️  [Handler] Could not find target group "${config.GROUP_NAME}" for backfill reactions.`);
        return { targetGroup: null, messages: [] };
    }

    try {
        const messageIds = await fetchOwnMessageIdsCompat(targetGroup.id._serialized, limit);
        const messages = [];

        for (const messageId of messageIds) {
            try {
                const message = await globalClient.getMessageById(messageId);
                if (!message || !message.fromMe) continue;
                messages.push(message);
            } catch (err) {
                console.error(`❌ [Handler] Failed to hydrate message ${messageId}:`, err.message);
            }
        }

        return { targetGroup, messages };
    } catch (err) {
        console.error('❌ [Handler] Failed to load recent own group messages for reactions:', err.message);
        return { targetGroup, messages: [] };
    }
}

async function removeReactionByMessageId(messageId) {
    if (!globalClient || !messageId) return;

    try {
        const message = await globalClient.getMessageById(messageId);
        if (!message) return;

        await message.react('');
    } catch (err) {
        console.error(`❌ [Handler] Failed to remove reaction from message ${messageId}:`, err.message);
    }
}

async function reactToRecentOwnGroupMessages(limit = 500) {
    if (!globalClient || !reactOwnGroupMessages) return;

    try {
        const { targetGroup, messages } = await fetchOwnGroupMessagesForBackfill(limit);
        if (!targetGroup) return;

        let reactedCount = 0;
        for (const message of messages) {
            const key = getMessageKey(message);
            if (!key || reactedGroupMessages.has(key)) continue;

            try {
                await message.react('✅');
                reactedGroupMessages.add(key);
                reactedCount++;
            } catch (err) {
                console.error('❌ [Handler] Failed to add backfill reaction:', err.message);
            }
        }

        console.log(`✅ [Handler] Backfill reactions completed for ${reactedCount} recent messages in "${config.GROUP_NAME}".`);
    } catch (err) {
        console.error('❌ [Handler] Error while backfilling group reactions:', err.message);
    }
}

async function removeAllTrackedReactions() {
    for (const key of reactedGroupMessages.values()) {
        await removeReactionByMessageId(key);
    }

    reactedGroupMessages.clear();

    if (!globalClient) return;

    try {
        const { targetGroup, messages } = await fetchOwnGroupMessagesForBackfill(500);
        if (!targetGroup) return;

        for (const message of messages) {
            if (!message.fromMe) continue;
            const key = getMessageKey(message);
            if (!key) continue;
            await removeReactionByMessageId(key);
        }
    } catch (err) {
        console.error('❌ [Handler] Error while removing group reactions:', err.message);
    }

    console.log('🧹 [Handler] Cleared ✅ reactions from your target-group messages.');
}

function releaseBuyer() {
    clearAllTimers();
    clearPendingScreenshotPaymentProof();
    clearCurrentBuyerPaidAmount();
    currentBuyer = null;
    console.log('🔄 [Handler] Buyer reservation released.');
}

async function tryNextBuyer() {
    if (buyerQueue.length === 0) {
        console.log('📭 [Handler] No more buyers in queue.');
        return;
    }
    const next = buyerQueue.shift();
    console.log(`➡️  [Handler] Trying next buyer: ${next.name}`);

    try {
        const chat = await globalClient.getChatById(next.chatId);
        await assignBuyer(chat, next.id, next.name);
    } catch (err) {
        console.error('❌ [Handler] Error assigning next buyer:', err.message);
        await tryNextBuyer();
    }
}

// ═══════════════════════════════════════════════════════════════
//  NEGOTIATION
// ═══════════════════════════════════════════════════════════════

async function handleNegotiation(chat, senderId, senderName, offeredPrice) {
    stats.negotiations++;
    const price = getCurrentPrice();

    if (price === null) {
        console.log(`💬 [Handler] Negotiation from ${senderName}: ₹${offeredPrice} — no active price, ignoring.`);
        return;
    }

    const minAcceptable = price - config.NEGOTIATION_MARGIN;

    if (offeredPrice >= minAcceptable) {
        console.log(`✅ [Handler] Negotiation ACCEPTED: ${senderName} ₹${offeredPrice} (min: ₹${minAcceptable})`);
        await chat.sendMessage(config.negotiationAcceptedMessage(offeredPrice));

        if (!currentBuyer) {
            await assignBuyer(chat, senderId, senderName);
        } else if (currentBuyer.id !== senderId) {
            const alreadyQueued = buyerQueue.some((b) => b.id === senderId);
            if (!alreadyQueued) {
                buyerQueue.push({ id: senderId, name: senderName, chatId: chat.id._serialized });
            }
            
            const elapsed = Date.now() - currentBuyer.assignedAt;
            if (elapsed < config.BUYER_INACTIVITY_MS) {
                scheduleNextBuyer(config.BUYER_INACTIVITY_MS - elapsed);
            } else {
                await moveNextBuyer();
            }
        }
    } else {
        console.log(`❌ [Handler] Negotiation REJECTED: ${senderName} ₹${offeredPrice} (min: ₹${minAcceptable})`);
    }
}

// ═══════════════════════════════════════════════════════════════
//  SALE COMPLETION
// ═══════════════════════════════════════════════════════════════

async function completeSale(chat, buyerName, options = {}) {
    const confirmedPayment = options.confirmedPayment === true;
    const allowBuyerTestingRevert = options.allowBuyerTestingRevert !== undefined
        ? options.allowBuyerTestingRevert
        : !confirmedPayment;

    sold = true;
    reactOwnGroupMessages = true;
    allowTestingRevert = allowBuyerTestingRevert;
    clearPendingScreenshotPaymentProof();
    clearCurrentBuyerPaidAmount();
    reactedGroupMessages.clear();
    stats.soldPrice = getCurrentPrice();
    stats.buyerName = buyerName;
    stats.buyerId = currentBuyer ? currentBuyer.id : null;
    stats.timeSold = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

    clearAllTimers();
    stopScheduler();

    console.log(`\n🎉 [Handler] SOLD to ${buyerName}!`);

    try {
        if (fs.existsSync(config.QR_IMAGE_PATH)) {
            const media = MessageMedia.fromFilePath(config.QR_IMAGE_PATH);
            await chat.sendMessage(media);
            console.log('📤 [Handler] QR image sent to buyer.');
        } else {
            console.warn('⚠️  [Handler] QR image not found at', config.QR_IMAGE_PATH);
        }

        if (confirmedPayment) {
            await chat.sendMessage(config.saleConfirmPaidMessage(buyerName, getCurrentMeal()));
        } else {
            await chat.sendMessage(config.saleConfirmMessage(buyerName, getCurrentMeal()));
        }
    } catch (err) {
        console.error('❌ [Handler] Error sending sold confirmation:', err.message);
    }

    await reactToRecentOwnGroupMessages();
    printReport();
}

async function revertSale(chat, buyerName) {
    sold = false;
    currentBuyer = null;
    reactOwnGroupMessages = false;
    allowTestingRevert = true;
    paymentVerificationInProgress = false;
    clearPendingScreenshotPaymentProof();
    clearCurrentBuyerPaidAmount();
    await removeAllTrackedReactions();
    stats.soldPrice = null;
    stats.buyerName = null;
    stats.buyerId = null;
    stats.timeSold = null;

    console.log(`\n⏪ [Handler] UNSOLD — ${buyerName} was just testing.`);

    try {
        await chat.sendMessage(config.testRevertedMessage());
    } catch (err) {
        console.error('❌ [Handler] Error sending revert confirmation:', err.message);
    }

    restartScheduler();
}

function handleUnsoldStop() {
    sold = true;
    reactOwnGroupMessages = false;
    allowTestingRevert = false;
    paymentVerificationInProgress = false;
    clearPendingScreenshotPaymentProof();
    clearCurrentBuyerPaidAmount();
    reactedGroupMessages.clear();
    clearAllTimers();
    printReport();
}

function printReport() {
    const date = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
    const wasSold = stats.soldPrice !== null;

    console.log(`
═════════════════════════════════════════════
          SALE REPORT                   
═════════════════════════════════════════════
  Date:              ${date.padEnd(14)}     
  Sold:              ${(wasSold ? 'Yes' : 'No').padEnd(14)}     
  Sold Price:        ${(wasSold ? '₹' + stats.soldPrice : '—').padEnd(14)}
  Buyer Name:        ${(stats.buyerName || '—').padEnd(14)}     
  Time Sold:         ${(stats.timeSold || '—').padEnd(14)}     
  Messages Received: ${String(stats.messagesReceived).padEnd(14)}     
  Negotiations:      ${String(stats.negotiations).padEnd(14)}
═════════════════════════════════════════════
`);
}

async function handleOwnGroupMessage(msg) {
    try {
        if (!msg.fromMe || !reactOwnGroupMessages) return;

        const chat = await msg.getChat();
        if (!chat?.isGroup) return;
        if (chat.name !== config.GROUP_NAME) return;

        await msg.react('✅');
        const key = getMessageKey(msg);
        if (key) reactedGroupMessages.add(key);

        console.log(`✅ [Handler] Reacted to your group message in "${chat.name}".`);
    } catch (err) {
        console.error('❌ [Handler] Failed to react on own group message:', err.message);
    }
}

let globalClient = null;
function setClient(client) {
    globalClient = client;

    try {
        ensureDailyPaymentVerificationLog();
    } catch (err) {
        console.error('❌ [Handler] Failed to initialize daily payment verification log:', err.message);
    }

    void initializeSbiBalanceBaseline();
}

module.exports = { handleMessage, handleOwnGroupMessage, isSold, handleUnsoldStop, setClient };
