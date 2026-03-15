'use strict';

const fs = require('fs');
const { MessageMedia } = require('whatsapp-web.js');
const config = require('./settings');
const { isBuyerKeyword, isDoneKeyword } = require('./keywordMatcher');
const { extractPrice } = require('./priceParser');
const { getCurrentPrice, stopScheduler, getCurrentMeal, restartScheduler } = require('./priceScheduler');

// ─── State ──────────────────────────────────────────────────
let sold = false;
let currentBuyer = null;       // { id, name, chatId, chat, assignedAt }
let inactivityTimer = null;    // 3-min silent drop timer
let warningTimeout = null;     // 30s payment warning timer
let reactOwnGroupMessages = false;
let reactedGroupMessages = new Map(); // msgId -> message object (for removing reactions)
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

// ═══════════════════════════════════════════════════════════════
//  MAIN MESSAGE HANDLER
// ═══════════════════════════════════════════════════════════════

async function handleMessage(msg, client) {
    try {
        stats.messagesReceived++;

        const senderId = msg.from;

        // ── Filter: only respond to personal DMs ────────────────
        if (senderId.endsWith('@broadcast') || senderId.endsWith('@g.us')) {
            return; // ignore status updates and group messages
        }

        const contact = await msg.getContact();
        const senderName = contact.pushname || contact.name || senderId;
        const body = (msg.body || '').trim();
        const chat = await msg.getChat();

        const me = client.info.wid._serialized;
        if (senderId === me) return;

        console.log(`📩 [Handler] DM from ${senderName}: "${body}"`);

        // ── Already sold ────────────────────────────────────────
        if (sold) {
            // Un-sell if the ACTUAL buyer types "testing"
            if (stats.buyerId === senderId && body.toLowerCase() === 'testing') {
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
            const paymentSignal = isPaymentSignal(msg, price);

            if (msg.hasMedia || isDoneKeyword(body) || paymentSignal) {
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
        // ── Within 3-min window → warn current buyer, queue new buyer ──
        clearInactivityTimer();

        const alreadyQueued = buyerQueue.some((b) => b.id === senderId);
        if (!alreadyQueued) {
            buyerQueue.push({ id: senderId, name: senderName, chatId: chat.id._serialized });
            console.log(`🔢 [Handler] ${senderName} queued (position ${buyerQueue.length}).`);
        }

        startPaymentWarningTimer();
    } else {
        // ── After 3-min window → silently drop old buyer, assign new one ──
        console.log(`⏱️  [Handler] ${currentBuyer.name} exceeded 3-min window — silently dropping.`);
        releaseBuyer();
        await assignBuyer(chat, senderId, senderName);
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
        await chat.sendMessage(config.payViaPhoneMessage(price, config.PHONE_NUMBER));

        await chat.sendMessage(config.paymentInstructionMessage());
        console.log('📤 [Handler] Payment instruction sent.');
    } catch (err) {
        console.error('❌ [Handler] Error sending buyer messages:', err.message);
    }

    // Start 3-min inactivity timer (silently drops if no second buyer)
    startInactivityTimer();
}

// ═══════════════════════════════════════════════════════════════
//  TIMERS
// ═══════════════════════════════════════════════════════════════

/**
 * 3-minute inactivity timer.
 * If no second buyer arrives within this window, the current buyer
 * is silently released (no messages sent).
 */
function startInactivityTimer() {
    clearInactivityTimer();
    console.log(`⏱️  [Timer] Started 3-min inactivity timer for ${currentBuyer.name}`);

    inactivityTimer = setTimeout(() => {
        if (sold || !currentBuyer) return;
        console.log(`⏱️  [Timer] ${currentBuyer.name} — 3 min elapsed, no second buyer. Silently releasing.`);
        releaseBuyer();
    }, config.BUYER_INACTIVITY_MS);
}

function clearInactivityTimer() {
    if (inactivityTimer) { clearTimeout(inactivityTimer); inactivityTimer = null; }
}

/**
 * 30-second payment warning timer.
 * Only triggered when a second buyer arrives within 3-min window.
 * Sends the warning message, then after 30s moves to the next buyer.
 */
function startPaymentWarningTimer() {
    clearAllTimers();
    const chat = currentBuyer?.chat;
    if (!chat) return;

    console.log(`⏳ [Timer] Sending 30s payment warning to ${currentBuyer.name}`);

    // Send warning immediately
    (async () => {
        try {
            await chat.sendMessage(config.timeoutWarningMessage());
        } catch (err) {
            console.error('❌ [Timer] Error sending warning:', err.message);
        }
    })();

    // After 30s, move to next buyer
    warningTimeout = setTimeout(async () => {
        try {
            if (sold || !currentBuyer) return;
            console.log(`⏱️  [Timer] ${currentBuyer.name} timed out — moving to next buyer.`);
            await chat.sendMessage(config.timeoutFinalMessage());
            releaseBuyer();
            await tryNextBuyer();
        } catch (err) {
            console.error('❌ [Timer] Error in warning timeout:', err.message);
        }
    }, config.BUYER_TIMEOUT_WARNING_MS);
}

function clearAllTimers() {
    clearInactivityTimer();
    if (warningTimeout) { clearTimeout(warningTimeout); warningTimeout = null; }
}

function getMessageKey(msg) {
    return msg?.id?._serialized || msg?.id?.id || null;
}

async function reactToRecentOwnGroupMessages(limit = 500) {
    if (!globalClient || !reactOwnGroupMessages) return;

    try {
        const chats = await globalClient.getChats();
        const targetGroup = chats.find((c) => c.isGroup && c.name === config.GROUP_NAME);
        if (!targetGroup) {
            console.warn(`⚠️  [Handler] Could not find target group "${config.GROUP_NAME}" for backfill reactions.`);
            return;
        }

        const messages = await targetGroup.fetchMessages({ limit });
        for (const message of messages) {
            if (!message.fromMe) continue;

            const key = getMessageKey(message);
            if (!key || reactedGroupMessages.has(key)) continue;

            try {
                await message.react('✅');
                reactedGroupMessages.set(key, message);
            } catch (err) {
                console.error('❌ [Handler] Failed to add backfill reaction:', err.message);
            }
        }

        console.log(`✅ [Handler] Backfill reactions completed for recent messages in "${config.GROUP_NAME}".`);
    } catch (err) {
        console.error('❌ [Handler] Error while backfilling group reactions:', err.message);
    }
}

async function removeAllTrackedReactions() {
    for (const [key, message] of reactedGroupMessages.entries()) {
        try {
            await message.react('');
        } catch (err) {
            console.error(`❌ [Handler] Failed to remove reaction from message ${key}:`, err.message);
        }
    }

    reactedGroupMessages.clear();

    if (!globalClient) return;

    try {
        const chats = await globalClient.getChats();
        const targetGroup = chats.find((c) => c.isGroup && c.name === config.GROUP_NAME);
        if (!targetGroup) return;

        const messages = await targetGroup.fetchMessages({ limit: 500 });
        for (const message of messages) {
            if (!message.fromMe) continue;

            try {
                await message.react('');
            } catch (err) {
                console.error('❌ [Handler] Failed to remove backfill reaction:', err.message);
            }
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
        if (key) reactedGroupMessages.set(key, msg);

        console.log(`✅ [Handler] Reacted to your group message in "${chat.name}".`);
    } catch (err) {
        console.error('❌ [Handler] Failed to react on own group message:', err.message);
    }
}

let globalClient = null;
function setClient(client) { globalClient = client; }

module.exports = { handleMessage, handleOwnGroupMessage, isSold, handleUnsoldStop, setClient };
