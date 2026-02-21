'use strict';

const fs = require('fs');
const { MessageMedia } = require('whatsapp-web.js');
const config = require('./settings');
const { isBuyerKeyword, isDoneKeyword } = require('./keywordMatcher');
const { extractPrice } = require('./priceParser');
const { getCurrentPrice, stopScheduler } = require('./priceScheduler');

// ─── State ──────────────────────────────────────────────────
let sold = false;
let currentBuyer = null;       // { id, name, chatId, chat, assignedAt }
let inactivityTimer = null;    // 3-min silent drop timer
let warningTimeout = null;     // 30s payment warning timer
let buyerQueue = [];
let stats = {
    messagesReceived: 0,
    negotiations: 0,
    soldPrice: null,
    buyerName: null,
    timeSold: null,
};

function isSold() { return sold; }

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
            if (isBuyerKeyword(body)) {
                await chat.sendMessage(config.soldMessage());
                console.log(`🚫 [Handler] Replied "Sorry Sold" to ${senderName}.`);
            }
            return;
        }

        // ── Current buyer says "done" ───────────────────────────
        if (currentBuyer && senderId === currentBuyer.id && isDoneKeyword(body)) {
            await completeSale(chat, senderName);
            return;
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
    stats.soldPrice = getCurrentPrice();
    stats.buyerName = buyerName;
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

        await chat.sendMessage(config.saleConfirmMessage(buyerName));
    } catch (err) {
        console.error('❌ [Handler] Error sending sold confirmation:', err.message);
    }

    printReport();
}

function handleUnsoldStop() {
    sold = true;
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

let globalClient = null;
function setClient(client) { globalClient = client; }

module.exports = { handleMessage, isSold, handleUnsoldStop, setClient };
