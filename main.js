'use strict';

const originalEmitWarning = process.emitWarning;
process.emitWarning = function patchedEmitWarning(warning, ...args) {
    const warningCode =
        (warning && typeof warning === 'object' && warning.code) ||
        (typeof args[1] === 'string' ? args[1] : null);

    if (warningCode === 'DEP0040') return;
    return originalEmitWarning.call(this, warning, ...args);
};

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const config = require('./utils/config');
const { applyOverrides } = require('./utils/config');
const { showMenu } = require('./utils/menu');
const { startScheduler, stopScheduler } = require('./utils/priceScheduler');
const { handleMessage, handleOwnGroupMessage, isSold, handleUnsoldStop, setClient } = require('./utils/messageHandler');

// ─── Runtime state set by CLI menu ──────────────────────────
let runOpts = {};

// ─── Create Client ──────────────────────────────────────────
const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--disable-gpu',
        ],
    },
});

let targetChat = null;

// ─── QR Event ───────────────────────────────────────────────
client.on('qr', (qr) => {
    console.log('\n📱 Scan this QR code to log in:\n');
    qrcode.generate(qr, { small: true });
});

// ─── Authentication Events ──────────────────────────────────
client.on('authenticated', () => {
    console.log('🔐 [Auth] Authenticated successfully.');
});

client.on('auth_failure', (msg) => {
    console.error('🔐 [Auth] Authentication failure:', msg);
});

// ─── Ready Event ────────────────────────────────────────────
client.on('ready', async () => {
    try {
        console.log('✅ WhatsApp client is ready!');
        console.log(`👤 Logged in as: ${client.info.pushname} (${client.info.wid.user})\n`);

        setClient(client);

        const chats = await client.getChats();
        targetChat = chats.find((c) => c.isGroup && c.name === config.GROUP_NAME);

        if (!targetChat) {
            console.error(`❌ Group "${config.GROUP_NAME}" not found! Available groups:`);
            chats.filter((c) => c.isGroup).forEach((c) => console.log(`   • ${c.name}`));
            console.error('\nPlease update GROUP_NAME in Setting.txt and restart.');
            return;
        }

        console.log(`🎯 Target group found: "${targetChat.name}" (${targetChat.id._serialized})\n`);

        startScheduler(
            async (text) => {
                try {
                    await targetChat.sendMessage(text);
                } catch (err) {
                    console.error('❌ [Main] Failed to send scheduled message:', err.message);
                }
            },
            async () => {
                console.log('🛑 [Main] Auto-stop triggered — time limit reached without sale.');
                handleUnsoldStop();
            },
            isSold,
            {
                meal: runOpts._meal,
                mess: runOpts._mess,
                numMessages: runOpts._numMessages,
            },
        );
    } catch (err) {
        console.error('❌ [Main] Error in ready handler:', err.message);
    }
});

// ─── Message Event ──────────────────────────────────────────
client.on('message_create', async (msg) => {
    try {
        if (msg.fromMe) {
            await handleOwnGroupMessage(msg);
            return;
        }

        // Extra safety: ignore status updates and group messages at main level too
        if (msg.from.endsWith('@broadcast') || msg.from.endsWith('@g.us')) return;

        await handleMessage(msg, client);
    } catch (err) {
        console.error('❌ [Main] Error handling message:', err.message);
    }
});

// ─── Disconnection & Reconnect ──────────────────────────────
client.on('disconnected', (reason) => {
    console.warn('⚠️  [Main] Client disconnected:', reason);
    console.log('🔄 [Main] Attempting to reconnect…');
    setTimeout(() => {
        try {
            client.initialize();
        } catch (err) {
            console.error('❌ [Main] Reconnect failed:', err.message);
        }
    }, 5000);
});

// ─── Global Error Handlers ──────────────────────────────────
process.on('uncaughtException', (err) => {
    console.error('💥 [Uncaught Exception]', err);
});

process.on('unhandledRejection', (reason) => {
    console.error('💥 [Unhandled Rejection]', reason);
});

// ─── Graceful Shutdown ──────────────────────────────────────
process.on('SIGINT', async () => {
    console.log('\n👋 Shutting down gracefully…');
    stopScheduler();
    try {
        await client.destroy();
    } catch (_) { /* ignore */ }
    process.exit(0);
});

// ─── Start ──────────────────────────────────────────────────
(async () => {
    console.log('🚀 Mess QR Selling Bot\n');

    runOpts = await showMenu();

    // Apply CLI overrides to global config
    applyOverrides({
        ENABLE_NEGOTIATION: runOpts.ENABLE_NEGOTIATION,
        PAYMENT_VERIFICATION_ENABLED: runOpts.PAYMENT_VERIFICATION_ENABLED,
        DEFAULT_PRICE: runOpts.DEFAULT_PRICE,
    });

    console.log('🔌 Connecting to WhatsApp…\n');
    client.initialize();
})();
