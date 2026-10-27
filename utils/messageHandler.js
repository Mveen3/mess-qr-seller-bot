'use strict';

const fs = require('fs');
const path = require('path');
const { MessageMedia } = require('whatsapp-web.js');
const config = require('./config');
const { isBuyerKeyword, isDoneKeyword, isTimeKeyword, isSellMessageSubstring } = require('./keywordMatcher');
const { isBlockedWid, isBlockedContact } = require('./blocklist');
const { extractPrice } = require('./priceParser');
const { getCurrentPrice, stopScheduler, getCurrentMeal, restartScheduler } = require('./priceScheduler');
const groupReactions = require('./groupReactions');
const loyalty = require('./loyalty');

// ─── State ──────────────────────────────────────────────────
let sold = false;
let currentBuyer = null;       // { id, name, phone, isFreeMeal, chatId, chat, assignedAt }
let queueTimer = null;         // Timer that triggers moving to next buyer
let queueWarningTimer = null;  // Timer that warns current buyer before timeout
let reactOwnGroupMessages = false;
let allowTestingRevert = true;
let buyerQueue = [];
let stats = {
    messagesReceived: 0,
    negotiations: 0,
    soldPrice: null,
    buyerName: null,
    buyerId: null,
    timeSold: null,
    isFreeMeal: false,
    loyaltyRecord: null,
};

function isSold() { return sold; }

function isPaymentSignal(msg, currentPrice) {
    const type = (msg?.type || '').toLowerCase();
    const body = (msg?.body || '').trim();
    const bodyLower = body.toLowerCase();

    const paymentTypeHit = type.includes('payment') || type.includes('pay');

    const paymentTextHit = [
        '₹',
        'completed',
        'sent to',
        'sent to you',
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

/**
 * Extract quoted message text safely from incoming message.
 */
async function getQuotedText(msg) {
    if (!msg) return '';

    // Check synchronous properties on msg._data.quotedMsg (fastest)
    if (msg._data?.quotedMsg) {
        const qm = msg._data.quotedMsg;
        const text = qm.body || qm.caption || qm.text || '';
        if (typeof text === 'string' && text.trim().length > 0) {
            return text.trim();
        }
    }

    // Check msg.quotedMsg
    if (msg.quotedMsg) {
        const text = msg.quotedMsg.body || msg.quotedMsg.caption || '';
        if (typeof text === 'string' && text.trim().length > 0) {
            return text.trim();
        }
    }

    // Fallback: asynchronous call to getQuotedMessage()
    if (msg.hasQuotedMsg && typeof msg.getQuotedMessage === 'function') {
        try {
            const quoted = await msg.getQuotedMessage();
            if (quoted) {
                const text = quoted.body || quoted._data?.caption || quoted._data?.body || '';
                if (typeof text === 'string' && text.trim().length > 0) {
                    return text.trim();
                }
            }
        } catch (_) {
            // ignore
        }
    }

    return '';
}

// ═══════════════════════════════════════════════════════════════
//  MAIN MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════════

async function handleMessage(msg, client) {
    try {
        const senderId = msg.from;
        if (msg._data && msg._data.subtype === 'bot_typing_placeholder') {
            return;
        }

        // ── Blocklist: bail out before reading, replying or queueing ──
        if (isBlockedWid(senderId)) {
            console.log(`⛔ [Blocklist] Ignored message from ${senderId}.`);
            return;
        }

        let body = msg.body;
        if (!body && msg._data) {
            body = msg._data.body || msg._data.caption || msg._data.text || '';
        }
        body = (body || '').trim();

        let contact = null;
        try {
            contact = await msg.getContact();
        } catch (_) {
            // Silently fallback if WhatsApp Web contact store is incomplete
        }
        const senderName = contact?.pushname || contact?.name || senderId;

        // A chat addressed by "@lid" hides the phone number in msg.from, so
        // re-check now that the contact has resolved it.
        if (isBlockedContact(contact)) {
            console.log(`⛔ [Blocklist] Ignored message from ${senderName} (${senderId}).`);
            return;
        }



        // ── Filter: only respond to personal DMs ────────────────
        if (senderId.endsWith('@broadcast') || senderId.endsWith('@g.us')) {
            return; // ignore status updates and group messages
        }
        const chat = await msg.getChat();

        const me = client.info.wid._serialized;
        if (senderId === me) return;



        const quotedText = await getQuotedText(msg);
        const sellReplyMatch = isSellMessageSubstring(quotedText)
            ? quotedText
            : (isSellMessageSubstring(body) ? body : null);

        stats.messagesReceived++;
        const quoteLog = quotedText ? ` (reply to: "${quotedText.replace(/\r?\n/g, ' ')}")` : '';
        console.log(`📩 [Handler] DM from ${senderName}: "${body}"${quoteLog}`);

        // ── Already sold ────────────────────────────────────────
        if (sold) {
            // Un-sell if the ACTUAL buyer types "testing"
            if (allowTestingRevert && stats.buyerId === senderId && body.toLowerCase() === 'testing') {
                await revertSale(chat, senderName);
                return;
            }

            const buyerKwSold = isBuyerKeyword(body);
            if (buyerKwSold || sellReplyMatch) {
                await chat.sendMessage(config.soldMessage());
                const trigger = buyerKwSold
                    ? `keyword: "${buyerKwSold}"`
                    : `sell message reply ("${sellReplyMatch.slice(0, 40)}")`;
                console.log(`🚫 [Handler] Replied "Sorry Sold" to ${senderName}. Triggered by ${trigger}`);
            }
            return;
        }

        // ── Current buyer says "done", sends screenshot, or payment-signal arrives ────────────────
        if (currentBuyer && senderId === currentBuyer.id) {
            if (!currentBuyer.phone) {
                const capturedPhone = extractPhoneNumberFromText(body);
                if (capturedPhone) {
                    currentBuyer.phone = capturedPhone;
                    console.log(`📱 [Handler] Captured buyer phone ${capturedPhone} from message text.`);
                }
            }
            const price = getCurrentPrice();
            const doneKeyword = isDoneKeyword(body);
            const paymentSignal = isPaymentSignal(msg, price);
            const whatsappPaySignal = isWhatsAppPaySignal(msg);
            const freeMealClaimKeyword = currentBuyer.isFreeMeal && (
                doneKeyword ||
                isBuyerKeyword(body) ||
                sellReplyMatch ||
                /^(ok|yes|claim|free|qr|dedo|bhejo|haan|send)$/i.test(body.trim())
            );

            if (whatsappPaySignal || msg.hasMedia || doneKeyword || paymentSignal || freeMealClaimKeyword) {
                if (currentBuyer.isFreeMeal) {
                    console.log(`🎁 [Loyalty] Free meal claim signal from ${senderName}: "${body}"`);
                } else if (whatsappPaySignal) {
                    console.log(`💳 [Handler] WhatsApp Pay signal detected for ${senderName}.`);
                } else if (paymentSignal) {
                    console.log(`💳 [Handler] Payment signal detected for ${senderName} (type: ${msg.type || 'unknown'}).`);
                } else if (msg.hasMedia) {
                    console.log(`📸 [Handler] Media (screenshot) received from ${senderName}.`);
                } else if (doneKeyword) {
                    console.log(`💬 [Handler] "Done" keyword detected for ${senderName}: "${doneKeyword}"`);
                }
                await completeSale(chat, senderName);
                return;
            }

            // Check for TIME extension request from current buyer
            const timeKeyword = isTimeKeyword(body);
            if (timeKeyword) {
                console.log(`⏱️  [Handler] Time extension keyword detected for ${senderName}: "${timeKeyword}"`);
                await handleTimeExtension(chat, senderName);
                return;
            }
        }

        // ── Check if this message is a reply to the sell template ──
        const isQuotedSellMsg = isSellMessageSubstring(quotedText);
        let replyContent = body;
        if (!isQuotedSellMsg && isSellMessageSubstring(body)) {
            // Strip the template part so the original @<price> is not mistaken for a counter-offer
            replyContent = body.replace(/Sell\s+[\w\s]+@(₹\s*)?\d+/i, '').trim();
        }

        // Check if there is an integer (number) in the user's reply/text
        const hasIntegerInReply = sellReplyMatch ? /\d+/.test(replyContent) : false;
        const offeredPrice = extractPrice(replyContent);

        // A user is attempting to negotiate if:
        // 1. They replied to the sell message and their reply text contains an integer, OR
        // 2. Their direct message contains a recognized price offer.
        const isNegotiationAttempt = (sellReplyMatch && hasIntegerInReply) || (!sellReplyMatch && offeredPrice !== null);

        if (isNegotiationAttempt) {
            if (config.ENABLE_NEGOTIATION) {
                const priceToEvaluate = offeredPrice !== null ? offeredPrice : parseInt(replyContent.match(/\d+/)[0], 10);
                if (Number.isFinite(priceToEvaluate) && priceToEvaluate > 0) {
                    await handleNegotiation(chat, senderId, senderName, priceToEvaluate, contact);
                    return;
                }
            } else {
                await handleNegotiationDisabled(chat, senderId, senderName, contact);
                return;
            }
        }

        // ── Buyer keyword OR Non-negotiation Sell message reply ─────────────────
        const buyerKw = isBuyerKeyword(body);
        if (buyerKw || sellReplyMatch) {
            const trigger = buyerKw
                ? `keyword: "${buyerKw}"`
                : `sell message reply ("${sellReplyMatch.slice(0, 40)}")`;
            console.log(`🎯 [Handler] Buyer intent triggered by ${trigger}`);
            await handleBuyerIntent(chat, senderId, senderName, client, contact);
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

async function handleBuyerIntent(chat, senderId, senderName, client, contact = null) {
    // Already the current buyer
    if (currentBuyer && currentBuyer.id === senderId) {
        console.log(`ℹ️  [Handler] ${senderName} is already the current buyer.`);
        return;
    }

    // No current buyer → assign directly
    if (!currentBuyer) {
        await assignBuyer(chat, senderId, senderName, contact);
        return;
    }

    // There IS a current buyer — a second buyer has arrived
    const alreadyQueued = buyerQueue.some((b) => b.id === senderId);
    if (!alreadyQueued) {
        buyerQueue.push({ id: senderId, name: senderName, chatId: chat.id._serialized, contact });
        console.log(`🔢 [Handler] ${senderName} queued (position ${buyerQueue.length}).`);
    }

    if (!queueTimer) {
        console.log(`⏱️  [Handler] Current buyer has no active timer. Moving to next buyer.`);
        await moveNextBuyer();
    }
}

// ═══════════════════════════════════════════════════════════════
//  BUYER PHONE RESOLUTION HELPERS
// ═══════════════════════════════════════════════════════════════

/**
 * Extract a 10-digit Indian phone number from text if present.
 */
function extractPhoneNumberFromText(text) {
    if (!text || typeof text !== 'string') return null;
    const match = text.match(/(?:\+?91[\s-]?)?([6-9]\d{9})\b/);
    if (match && match[1]) {
        return loyalty.normalizePhoneNumber(match[1]);
    }
    return null;
}

/**
 * Asynchronously resolve a buyer's 10-digit Indian phone number.
 * First checks contact and chat, then queries WhatsApp Web via Puppeteer
 * if the sender is an LID.
 */
async function resolveBuyerPhoneAsync(contact, senderId, chat = null) {
    // 1. Direct loyalty check
    const directPhone = loyalty.resolveBuyerPhone(contact, senderId);
    if (directPhone) return directPhone;

    // 2. Chat ID check (if chat is @c.us)
    const chatPhone = loyalty.widToPhoneNumber(chat?.id);
    if (chatPhone) return chatPhone;

    // 3. If sender or contact is an LID, query WhatsApp Web via Puppeteer
    const isLid = (typeof senderId === 'string' && senderId.endsWith('@lid')) ||
                  (contact?.id && (contact.id.server === 'lid' || String(contact.id._serialized || contact.id).endsWith('@lid')));

    if (isLid && globalClient?.pupPage) {
        try {
            const targetId = String(contact?.id?._serialized || contact?.id || senderId);
            const resolvedUser = await globalClient.pupPage.evaluate(async (idStr) => {
                const widFactory = window.require('WAWebWidFactory');
                const wid = widFactory.createWid(idStr);
                let phoneWid = null;
                try {
                    phoneWid = window.require('WAWebApiContact').getPhoneNumber(wid);
                } catch (_) { }
                if (!phoneWid) {
                    try {
                        const { toPn } = window.require('WAWebLidMigrationUtils');
                        phoneWid = toPn(wid);
                    } catch (_) { }
                }
                if (!phoneWid) {
                    try {
                        phoneWid = window.require('WAWebApiContact').getAlternateUserWid(wid);
                    } catch (_) { }
                }
                if (!phoneWid && window.WWebJS?.enforceLidAndPnRetrieval) {
                    try {
                        const res = await window.WWebJS.enforceLidAndPnRetrieval(idStr);
                        if (res?.phone) phoneWid = res.phone;
                    } catch (_) { }
                }
                return phoneWid?.user || (phoneWid?._serialized ? phoneWid._serialized.split('@')[0] : null);
            }, targetId);

            if (resolvedUser) {
                const normalized = loyalty.normalizePhoneNumber(resolvedUser);
                if (normalized) return normalized;
            }
        } catch (err) {
            console.warn('⚠️  [Handler] Async phone resolution from LID failed:', err.message);
        }
    }

    return null;
}

// ═══════════════════════════════════════════════════════════════
//  ASSIGN BUYER
// ═══════════════════════════════════════════════════════════════

async function assignBuyer(chat, senderId, senderName, contact = null, agreedPrice = null) {
    const buyerPhone = await resolveBuyerPhoneAsync(contact, senderId, chat);
    const freeEligible = buyerPhone
        ? loyalty.isFreeMealEligible(config.LOYALTY_CSV_PATH, buyerPhone, config.LOYALTY_TARGET)
        : false;
    const price = getCurrentPrice();
    const safePrice = Number.isFinite(price) && price > 0 ? price : config.DEFAULT_PRICE;
    const finalPrice = (Number.isFinite(agreedPrice) && agreedPrice > 0) ? agreedPrice : safePrice;

    currentBuyer = {
        id: senderId,
        name: senderName,
        phone: buyerPhone,
        isFreeMeal: freeEligible,
        chatId: chat.id._serialized,
        chat,
        assignedAt: Date.now(),
        agreedPrice: finalPrice,
        hasExtendedTime: false,
    };
    console.log(`🛒 [Handler] Buyer assigned: ${senderName} (phone: ${buyerPhone || 'unresolved'}, freeEligible: ${freeEligible}, price: ₹${finalPrice})`);

    try {
        if (freeEligible) {
            await sendTextWithFallbacks(chat, buyerPhone, senderId, config.freeMealAssignMessage(senderName, getCurrentMeal()));
            console.log('🎁 [Loyalty] Sent free meal claim prompt to buyer.');
        } else {
            await sendTextWithFallbacks(chat, buyerPhone, senderId, config.payViaPhoneMessage(finalPrice, config.UPI_ID));
            console.log('📤 [Handler] Payment details sent.');

            await sendTextWithFallbacks(chat, buyerPhone, senderId, config.paymentInstructionMessage());
            console.log('📤 [Handler] Payment instruction sent.');
        }
    } catch (err) {
        console.error('❌ [Handler] Error sending buyer messages:', err.message);
    }

    // Always start inactivity timer for the assigned buyer
    scheduleNextBuyer(config.BUYER_INACTIVITY_MS);
}

// ═══════════════════════════════════════════════════════════════
//  TIMERS & QUEUES
// ═══════════════════════════════════════════════════════════════

function scheduleNextBuyer(delayMs) {
    if (queueTimer) return; // Wait until current timer finishes

    const safeDelayMs = Math.max(0, Number(delayMs) || 0);
    console.log(`⏱️  [Timer] Inactivity timer scheduled for ${Math.round(safeDelayMs / 1000)}s...`);

    const warningDelayMs = safeDelayMs - config.BUYER_TIMEOUT_WARNING_MS;
    const warningBuyerId = currentBuyer?.id || null;
    const buyerPhone = currentBuyer?.phone || null;
    const buyerChat = currentBuyer?.chat || null;

    if (warningDelayMs > 0 && buyerChat) {
        queueWarningTimer = setTimeout(async () => {
            queueWarningTimer = null;
            if (sold || !currentBuyer) return;
            if (!warningBuyerId || currentBuyer.id !== warningBuyerId) return;
            if (isBlockedWid(currentBuyer.id)) return; // blocked mid-purchase

            try {
                await sendTextWithFallbacks(buyerChat, buyerPhone, warningBuyerId, config.timeoutWarningMessage());
                console.log(`⏳ [Timer] Sent timeout warning (30s left) to ${currentBuyer.name}.`);

                await sendTextWithFallbacks(buyerChat, buyerPhone, warningBuyerId, config.timePromptMessage());
                console.log(`⏳ [Timer] Sent time extension prompt to ${currentBuyer.name}.`);
            } catch (err) {
                console.error('❌ [Timer] Error sending timeout warning:', err.message);
            }
        }, warningDelayMs);
    }

    queueTimer = setTimeout(async () => {
        queueTimer = null;
        if (sold || !currentBuyer) return;
        if (!warningBuyerId || currentBuyer.id !== warningBuyerId) return;

        console.log(`⏱️  [Timer] ${currentBuyer.name} ran out of time. Moving to next buyer.`);
        await moveNextBuyer();
    }, safeDelayMs);
}

function scheduleTimeExtension() {
    clearAllTimers();
    if (!currentBuyer) return;

    const extendMs = config.BUYER_EXTEND_TIME_MS || 60000;
    const warnMs = config.BUYER_EXTEND_WARNING_MS || 10000;
    const warningDelayMs = Math.max(0, extendMs - warnMs);
    const buyerId = currentBuyer.id;
    const buyerPhone = currentBuyer.phone || null;
    const buyerChat = currentBuyer.chat || null;
    const buyerName = currentBuyer.name;

    console.log(`⏱️  [Timer] Extension active: ${Math.round(extendMs / 1000)}s total, warning in ${Math.round(warningDelayMs / 1000)}s.`);

    if (warningDelayMs > 0 && buyerChat) {
        queueWarningTimer = setTimeout(async () => {
            queueWarningTimer = null;
            if (sold || !currentBuyer) return;
            if (currentBuyer.id !== buyerId) return;
            if (isBlockedWid(buyerId)) return;

            try {
                await sendTextWithFallbacks(buyerChat, buyerPhone, buyerId, config.timeExtensionWarningMessage());
                console.log(`⏳ [Timer] Sent extension warning (10s left) to ${buyerName}.`);
            } catch (err) {
                console.error('❌ [Timer] Error sending extension warning:', err.message);
            }
        }, warningDelayMs);
    }

    queueTimer = setTimeout(async () => {
        queueTimer = null;
        if (sold || !currentBuyer) return;
        if (currentBuyer.id !== buyerId) return;

        console.log(`⏱️  [Timer] ${buyerName}'s extension expired. Moving to next buyer.`);
        await moveNextBuyer();
    }, extendMs);
}

async function handleTimeExtension(chat, senderName) {
    if (!currentBuyer) return;

    if (currentBuyer.hasExtendedTime) {
        console.log(`⏳ [Timer] ${senderName} requested extra time again; already used.`);
        await sendTextWithFallbacks(chat, currentBuyer.phone, currentBuyer.id, config.timeExtensionAlreadyUsedMessage());
        return;
    }

    currentBuyer.hasExtendedTime = true;
    currentBuyer.extendedAt = Date.now();
    clearAllTimers();

    console.log(`⏳ [Timer] Extra 60s extension granted to ${senderName}.`);
    await sendTextWithFallbacks(chat, currentBuyer.phone, currentBuyer.id, config.timeExtensionGrantedMessage());

    scheduleTimeExtension();
}

async function moveNextBuyer() {
    if (!currentBuyer) return;

    if (isBlockedWid(currentBuyer.id)) {
        console.log(`⛔ [Blocklist] ${currentBuyer.name} was blocked mid-purchase — dropping silently.`);
    } else {
        try {
            await sendTextWithFallbacks(currentBuyer.chat, currentBuyer.phone, currentBuyer.id, config.timeoutFinalMessage());
            console.log(`⏱️  [Handler] Sent timeout final message to ${currentBuyer.name}.`);
        } catch (err) {
            console.error('❌ [Timer] Error notifying leaving buyer:', err.message);
        }
    }

    releaseBuyer();
    await tryNextBuyer();
}

function clearAllTimers() {
    if (queueTimer) { clearTimeout(queueTimer); queueTimer = null; }
    if (queueWarningTimer) { clearTimeout(queueWarningTimer); queueWarningTimer = null; }
}

async function reactToRecentOwnGroupMessages() {
    if (!globalClient || !reactOwnGroupMessages) return;

    try {
        await groupReactions.reactToGroupMessages();
    } catch (err) {
        console.error('❌ [Handler] Error while marking group messages as sold:', err.message);
    }
}

async function removeAllTrackedReactions() {
    if (!globalClient) return;

    try {
        await groupReactions.clearGroupReactions();
    } catch (err) {
        console.error('❌ [Handler] Error while removing group reactions:', err.message);
    }
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

    if (isBlockedWid(next.id)) {
        console.log(`⛔ [Blocklist] Skipping queued buyer ${next.name} — number is blocked.`);
        await tryNextBuyer();
        return;
    }

    console.log(`➡️  [Handler] Trying next buyer: ${next.name}`);

    try {
        const chat = await globalClient.getChatById(next.chatId);
        await assignBuyer(chat, next.id, next.name, next.contact || null, next.agreedPrice || null);
    } catch (err) {
        console.error('❌ [Handler] Error assigning next buyer:', err.message);
        await tryNextBuyer();
    }
}

// ═══════════════════════════════════════════════════════════════
//  NEGOTIATION
// ═══════════════════════════════════════════════════════════════

async function handleNegotiation(chat, senderId, senderName, offeredPrice, contact = null) {
    stats.negotiations++;
    const price = getCurrentPrice();

    if (price === null) {
        console.log(`💬 [Handler] Negotiation from ${senderName}: ₹${offeredPrice} — no active price, ignoring.`);
        return;
    }

    const minAcceptable = price - config.NEGOTIATION_MARGIN;

    if (offeredPrice >= minAcceptable) {
        console.log(`✅ [Handler] Negotiation ACCEPTED: ${senderName} ₹${offeredPrice} (min: ₹${minAcceptable})`);
        await sendTextWithFallbacks(chat, null, senderId, config.negotiationAcceptedMessage(offeredPrice));

        if (!currentBuyer) {
            await assignBuyer(chat, senderId, senderName, contact, offeredPrice);
        } else if (currentBuyer.id === senderId) {
            currentBuyer.agreedPrice = offeredPrice;
            await sendTextWithFallbacks(chat, currentBuyer.phone, senderId, config.payViaPhoneMessage(offeredPrice, config.UPI_ID));
            await sendTextWithFallbacks(chat, currentBuyer.phone, senderId, config.paymentInstructionMessage());
        } else {
            const alreadyQueued = buyerQueue.some((b) => b.id === senderId);
            if (!alreadyQueued) {
                buyerQueue.push({ id: senderId, name: senderName, chatId: chat.id._serialized, contact, agreedPrice: offeredPrice });
                console.log(`🔢 [Handler] ${senderName} queued with offer ₹${offeredPrice} (position ${buyerQueue.length}).`);
            }

            if (!queueTimer) {
                await moveNextBuyer();
            }
        }
    } else {
        console.log(`💬 [Handler] Negotiation below threshold from ${senderName}: offered ₹${offeredPrice} (counter-offering min: ₹${minAcceptable})`);
        // 1. Ask politely that seller can accept up to minAcceptable
        await sendTextWithFallbacks(chat, null, senderId, config.negotiationCounterOfferMessage(minAcceptable));

        // 2 & 3. Send payment instruction & transaction notice via assignBuyer
        if (!currentBuyer) {
            await assignBuyer(chat, senderId, senderName, contact, minAcceptable);
        } else if (currentBuyer.id === senderId) {
            currentBuyer.agreedPrice = minAcceptable;
            await sendTextWithFallbacks(chat, currentBuyer.phone, senderId, config.payViaPhoneMessage(minAcceptable, config.UPI_ID));
            await sendTextWithFallbacks(chat, currentBuyer.phone, senderId, config.paymentInstructionMessage());
        } else {
            const alreadyQueued = buyerQueue.some((b) => b.id === senderId);
            if (!alreadyQueued) {
                buyerQueue.push({ id: senderId, name: senderName, chatId: chat.id._serialized, contact, agreedPrice: minAcceptable });
                console.log(`🔢 [Handler] ${senderName} queued with counter-offer ₹${minAcceptable} (position ${buyerQueue.length}).`);
            }

            if (!queueTimer) {
                await moveNextBuyer();
            }
        }
    }
}

async function handleNegotiationDisabled(chat, senderId, senderName, contact = null) {
    const price = getCurrentPrice();
    const safePrice = Number.isFinite(price) && price > 0 ? price : config.DEFAULT_PRICE;

    console.log(`💬 [Handler] Negotiation attempt from ${senderName} while negotiation is OFF: informing fixed price ₹${safePrice}.`);
    // 1. Respond politely that negotiation is not possible
    await sendTextWithFallbacks(chat, null, senderId, config.negotiationDisabledMessage(safePrice));

    // 2 & 3. Send payment details and transaction instruction via assignBuyer
    if (!currentBuyer) {
        await assignBuyer(chat, senderId, senderName, contact, safePrice);
    } else if (currentBuyer.id === senderId) {
        currentBuyer.agreedPrice = safePrice;
        await sendTextWithFallbacks(chat, currentBuyer.phone, senderId, config.payViaPhoneMessage(safePrice, config.UPI_ID));
        await sendTextWithFallbacks(chat, currentBuyer.phone, senderId, config.paymentInstructionMessage());
    } else {
        const alreadyQueued = buyerQueue.some((b) => b.id === senderId);
        if (!alreadyQueued) {
            buyerQueue.push({ id: senderId, name: senderName, chatId: chat.id._serialized, contact, agreedPrice: safePrice });
            console.log(`🔢 [Handler] ${senderName} queued with fixed price ₹${safePrice} (position ${buyerQueue.length}).`);
        }

        if (!queueTimer) {
            await moveNextBuyer();
        }
    }
}

// ═══════════════════════════════════════════════════════════════
//  RESILIENT DELIVERY HELPERS
// ═══════════════════════════════════════════════════════════════

/**
 * Resolve a canonical @c.us phone JID from phone number or senderId.
 */
function getStandardJid(phone, senderId) {
    if (senderId && typeof senderId === 'string' && senderId.endsWith('@c.us')) {
        return senderId;
    }
    if (phone) {
        const digits = String(phone).replace(/\D/g, '');
        if (digits.length === 10) {
            return `91${digits}@c.us`;
        }
        if (digits.length > 10) {
            return `${digits}@c.us`;
        }
    }
    return null;
}

/**
 * Deliver QR media with multi-layer fallbacks:
 * 1. Direct send via active chat (with patched browser memoizer & media sanitation)
 * 2. Fallback send as document via active chat
 * 3. Direct in-page Puppeteer evaluation fallback targeting active chat
 * 4. Fallback via standard phone JID (@c.us) ONLY for non-LID senders
 */
async function sendMediaWithFallbacks(chat, buyerPhone, senderId, mediaPath) {
    if (!fs.existsSync(mediaPath)) {
        console.warn('⚠️  [Handler] QR image not found at', mediaPath);
        return false;
    }

    let media;
    try {
        media = MessageMedia.fromFilePath(mediaPath);
    } catch (readErr) {
        console.error('❌ [Handler] Failed to read QR image file:', readErr.message);
        return false;
    }

    const chatId = chat?.id?._serialized || (typeof senderId === 'string' ? senderId : null);
    const isLid = typeof senderId === 'string' && senderId.endsWith('@lid');
    const standardJid = getStandardJid(buyerPhone, senderId);

    // Attempt 1: Direct send via the active chat
    if (chat && typeof chat.sendMessage === 'function') {
        try {
            await chat.sendMessage(media);
            console.log('📤 [Handler] QR image sent to buyer.');
            return true;
        } catch (err1) {
            console.warn(`⚠️  [Handler] Direct QR send to chat failed: ${err1.message}`);
        }
    }

    // Attempt 2: Fallback as document via active chat
    if (chat && typeof chat.sendMessage === 'function') {
        try {
            await chat.sendMessage(media, { sendMediaAsDocument: true });
            console.log('📤 [Handler] QR image sent as document fallback.');
            return true;
        } catch (err2) {
            console.warn(`⚠️  [Handler] Fallback QR send as document failed: ${err2.message}`);
        }
    }

    // Attempt 3: Direct browser evaluate fallback using active chat ID
    if (globalClient?.pupPage && chatId) {
        try {
            const directSent = await globalClient.pupPage.evaluate(async (targetChatId, mediaData) => {
                const targetChat = await window.WWebJS.getChat(targetChatId, { getAsModel: false });
                if (!targetChat) return false;
                const res = await window.WWebJS.sendMessage(targetChat, '', { media: mediaData });
                return Boolean(res);
            }, chatId, media);

            if (directSent) {
                console.log('📤 [Handler] QR image sent via browser evaluation fallback.');
                return true;
            }
        } catch (err3) {
            console.warn(`⚠️  [Handler] Direct browser evaluate QR send failed: ${err3.message}`);
        }
    }

    // Attempt 4: Fallback to standard JID ONLY if sender is NOT an @lid
    // (Sending to @c.us when the user only exists as an @lid triggers "No LID for user")
    if (!isLid && globalClient && standardJid && (!chat || chat.id?._serialized !== standardJid)) {
        try {
            await globalClient.sendMessage(standardJid, media);
            console.log(`📤 [Handler] QR image sent via fallback phone JID (${standardJid}).`);
            return true;
        } catch (err4) {
            console.warn(`⚠️  [Handler] Fallback QR send via phone JID failed: ${err4.message}`);
        }
    }

    console.error('❌ [Handler] All automated QR delivery attempts failed.');
    return false;
}

/**
 * Deliver text message with fallback to phone JID.
 */
async function sendTextWithFallbacks(chat, buyerPhone, senderId, textMessage) {
    if (chat && typeof chat.sendMessage === 'function') {
        try {
            await chat.sendMessage(textMessage);
            return true;
        } catch (err1) {
            console.warn(`⚠️  [Handler] Direct text send failed: ${err1.message}`);
        }
    }

    const isLid = typeof senderId === 'string' && senderId.endsWith('@lid');
    const standardJid = getStandardJid(buyerPhone, senderId);
    if (!isLid && globalClient && standardJid) {
        try {
            await globalClient.sendMessage(standardJid, textMessage);
            return true;
        } catch (err2) {
            console.error(`❌ [Handler] Fallback text send failed: ${err2.message}`);
        }
    }

    return false;
}

// ═══════════════════════════════════════════════════════════════
//  SALE COMPLETION
// ═══════════════════════════════════════════════════════════════

async function completeSale(chat, buyerName) {
    sold = true;
    reactOwnGroupMessages = true;
    allowTestingRevert = true;
    const isFree = Boolean(currentBuyer && currentBuyer.isFreeMeal);
    const activePrice = getCurrentPrice();
    let buyerPhone = currentBuyer?.phone;
    if (!buyerPhone) {
        buyerPhone = await resolveBuyerPhoneAsync(null, stats.buyerId, chat);
    }
    const senderId = currentBuyer?.id || stats.buyerId;

    stats.isFreeMeal = isFree;
    stats.soldPrice = isFree ? 0 : (currentBuyer?.agreedPrice || activePrice);
    stats.buyerName = buyerName;
    stats.buyerId = senderId;
    stats.timeSold = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });

    clearAllTimers();
    stopScheduler();

    console.log(`\n🎉 [Handler] SOLD to ${buyerName}! (Free Meal: ${isFree})`);

    // ── 1. Record Loyalty First (Independently protected) ─────────────────
    let loyaltyStatus = '';
    try {
        if (buyerPhone) {
            if (isFree) {
                const claimResult = loyalty.claimFreeMeal(config.LOYALTY_CSV_PATH, buyerPhone, buyerName);
                stats.loyaltyRecord = {
                    phone: buyerPhone,
                    wasFreeMeal: true,
                    amount: 0,
                    previousTotal: claimResult ? claimResult.previousTotal : 0,
                };
                console.log(`🎁 [Loyalty] FREE meal delivered to ${buyerName} (${buyerPhone}). Total purchases reset to 0 in CSV.`);
            } else {
                const finalPrice = Number.isFinite(stats.soldPrice) && stats.soldPrice > 0 ? stats.soldPrice : config.DEFAULT_PRICE;
                const purchaseResult = loyalty.recordPurchase(
                    config.LOYALTY_CSV_PATH,
                    buyerPhone,
                    buyerName,
                    finalPrice,
                    config.LOYALTY_TARGET
                );
                if (purchaseResult) {
                    stats.loyaltyRecord = {
                        phone: buyerPhone,
                        wasFreeMeal: false,
                        amount: finalPrice,
                        previousTotal: purchaseResult.previousTotal,
                    };

                    loyaltyStatus = purchaseResult.isFreeNext
                        ? config.loyaltyReachedMessage(config.LOYALTY_TARGET)
                        : config.loyaltyProgressMessage(purchaseResult.newTotal, config.LOYALTY_TARGET, purchaseResult.remaining);

                    console.log(`💳 [Loyalty] Purchase recorded: ₹${finalPrice} for ${buyerName} (${buyerPhone}). New total: ₹${purchaseResult.newTotal}/${config.LOYALTY_TARGET}.`);
                }
            }
        } else {
            console.warn(`⚠️  [Loyalty] Buyer phone could not be resolved for ${buyerName} (${senderId}). Skipping CSV record to avoid storing non-phone identifier.`);
        }
    } catch (loyaltyErr) {
        console.error('❌ [Loyalty] Error updating purchase record:', loyaltyErr.message);
    }

    // ── 2. Deliver QR Media Resiliently ──────────────────────────────────
    let qrDelivered = false;
    try {
        qrDelivered = await sendMediaWithFallbacks(chat, buyerPhone, senderId, config.QR_IMAGE_PATH);
    } catch (qrErr) {
        console.error('❌ [Handler] Error in QR delivery pipeline:', qrErr.message);
    }

    // ── 3. Send Sale Confirmation Text Resiliently ───────────────────────
    try {
        let confirmText = isFree
            ? config.freeMealConfirmMessage(buyerName, getCurrentMeal())
            : config.saleConfirmMessage(buyerName, getCurrentMeal(), loyaltyStatus);

        if (!qrDelivered && fs.existsSync(config.QR_IMAGE_PATH)) {
            confirmText += '\n\n⚠️ (Note: QR image could not be sent automatically. Please message here if needed!)';
        }

        const sent = await sendTextWithFallbacks(chat, buyerPhone, senderId, confirmText);
        if (sent) {
            console.log(`📤 [Handler] Sale confirmation message sent to ${buyerName}.`);
        }
    } catch (msgErr) {
        console.error('❌ [Handler] Error sending sale confirmation message:', msgErr.message);
    }

    // ── 4. React to Group Messages & Print Report ────────────────────────
    try {
        await reactToRecentOwnGroupMessages();
    } catch (reactErr) {
        console.error('❌ [Reactions] Error marking group messages:', reactErr.message);
    }

    printReport();
}

async function revertSale(chat, buyerName) {
    sold = false;
    currentBuyer = null;
    reactOwnGroupMessages = false;
    allowTestingRevert = true;
    await removeAllTrackedReactions();

    if (stats.loyaltyRecord) {
        loyalty.revertBuyerAction(config.LOYALTY_CSV_PATH, stats.loyaltyRecord.phone, stats.loyaltyRecord);
        console.log(`🔄 [Loyalty] Reverted loyalty update for ${stats.loyaltyRecord.phone}.`);
        stats.loyaltyRecord = null;
    }

    stats.soldPrice = null;
    stats.buyerName = null;
    stats.buyerId = null;
    stats.timeSold = null;
    stats.isFreeMeal = false;

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
    clearAllTimers();
    printReport();
}

function printReport() {
    const date = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
    const wasSold = stats.soldPrice !== null;
    const soldPriceDisplay = wasSold
        ? (stats.isFreeMeal ? '₹0 (Free Meal)' : '₹' + stats.soldPrice)
        : '—';

    console.log(`
═════════════════════════════════════════════
          SALE REPORT                   
═════════════════════════════════════════════
  Date:              ${date.padEnd(14)}     
  Sold:              ${(wasSold ? 'Yes' : 'No').padEnd(14)}     
  Sold Price:        ${soldPriceDisplay.padEnd(14)}
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

        // Derive the chat from the message key instead of msg.getChat(): that
        // call goes through getChatModel, which hits IndexedDB and is the most
        // breakage-prone part of the library.
        const chatId = (msg.id && typeof msg.id.remote === 'string' ? msg.id.remote : null) || msg.to || msg.from;
        if (!chatId || !chatId.endsWith('@g.us')) return;

        const group = groupReactions.getTargetGroups().find((g) => g.id === chatId);
        if (!group) return;

        const reacted = await groupReactions.reactToSingleMessage(msg, chatId);
        if (reacted) {
            console.log(`✅ [Handler] Reacted to your group message in "${group.name}".`);
        }
    } catch (err) {
        console.error('❌ [Handler] Failed to react on own group message:', err.message);
    }
}

let globalClient = null;
function setClient(client) {
    globalClient = client;
    groupReactions.setClient(client);
}

module.exports = { handleMessage, handleOwnGroupMessage, isSold, handleUnsoldStop, setClient };
