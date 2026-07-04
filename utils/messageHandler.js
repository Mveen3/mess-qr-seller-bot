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
let buyerQueue = [];
let stats = {
    messagesReceived: 0,
    negotiations: 0,
    soldPrice: null,
    buyerName: null,
    buyerId: null,
    timeSold: null,
};

function isSold() { return sold; }

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

function extractRupeeAmount(text) {
    if (!text || typeof text !== 'string') return null;

    const match = text.match(/₹\s*([0-9]+(?:\.[0-9]{1,2})?)/i);
    if (!match) return null;

    const amount = Number(match[1]);
    return Number.isFinite(amount) ? amount : null;
}

function isWhatsAppPaySignal(msg) {
    const type = (msg?.type || '').toLowerCase();
    return type.includes('payment');
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

            if (whatsappPaySignal || msg.hasMedia || doneKeyword || paymentSignal) {
                if (whatsappPaySignal) {
                    console.log(`💳 [Handler] WhatsApp Pay signal detected for ${senderName}.`);
                } else if (paymentSignal) {
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

        await chat.sendMessage(config.paymentInstructionMessage());
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

async function findTargetGroupChats() {
    if (!globalClient) return [];

    const chats = await globalClient.getChats();
    const configuredGroups = config.GROUP_NAMES || [];
    return chats.filter((c) => c.isGroup && c.name && configuredGroups.includes(c.name.trim()));
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
    const targetGroups = await findTargetGroupChats();
    if (!targetGroups || targetGroups.length === 0) {
        console.warn(`⚠️  [Handler] Could not find any target groups for backfill reactions.`);
        return { targetGroups: [], messages: [] };
    }

    try {
        const messages = [];

        for (const targetGroup of targetGroups) {
            const messageIds = await fetchOwnMessageIdsCompat(targetGroup.id._serialized, limit);
            for (const messageId of messageIds) {
                try {
                    const message = await globalClient.getMessageById(messageId);
                    if (!message || !message.fromMe) continue;
                    messages.push(message);
                } catch (err) {
                    console.error(`❌ [Handler] Failed to hydrate message ${messageId}:`, err.message);
                }
            }
        }

        return { targetGroups, messages };
    } catch (err) {
        console.error('❌ [Handler] Failed to load recent own group messages for reactions:', err.message);
        return { targetGroups, messages: [] };
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
        const { targetGroups, messages } = await fetchOwnGroupMessagesForBackfill(limit);
        if (targetGroups.length === 0) return;

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

        console.log(`✅ [Handler] Backfill reactions completed for ${reactedCount} recent messages across ${targetGroups.length} groups.`);
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
        const { targetGroups, messages } = await fetchOwnGroupMessagesForBackfill(500);
        if (targetGroups.length === 0) return;

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

async function completeSale(chat, buyerName) {
    sold = true;
    reactOwnGroupMessages = true;
    allowTestingRevert = true;
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

        await chat.sendMessage(config.saleConfirmMessage(buyerName, getCurrentMeal()));
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
        const configuredGroups = config.GROUP_NAMES || [];
        if (!chat.name || !configuredGroups.includes(chat.name.trim())) return;

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
}

module.exports = { handleMessage, handleOwnGroupMessage, isSold, handleUnsoldStop, setClient };
