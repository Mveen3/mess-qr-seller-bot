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
const { loadBlocklist, getBlockedNumbers } = require('./utils/blocklist');
const groupReactions = require('./utils/groupReactions');


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
            '--disable-extensions',
            '--disable-default-apps',
            '--disable-translate',
            '--disable-sync',
            '--no-zygote',
            '--single-process',
        ],
    },
    // Don't cache WhatsApp Web version — always fetch the latest to avoid
    // stale-cache errors when WhatsApp updates its internal module structure.
    webVersionCache: {
        type: 'none',
    },
});

let targetChats = [];

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

        const blocked = getBlockedNumbers();
        if (blocked.length > 0) {
            console.log(`⛔ Ignoring messages from: ${blocked.join(', ')}\n`);
        }

        // ── Monkey-patch WWebJS methods to fix broken IDB calls ──────
        // The library's getChatModel, getContact, and getContactModel crash with
        // "No key or key range specified" (minified as 'r') when IDB is queried
        // (groupMetadata, BusinessProfile, Blocklist). We wrap them in try/catch.
        await client.pupPage.evaluate(() => {
            // 1. Patch getChatModel
            const origGetChatModel = window.WWebJS.getChatModel;
            window.WWebJS.getChatModel = async (chat, opts = {}) => {
                if (!chat) return null;
                const { isChannel = false } = opts;

                const model = chat.serialize();
                model.isGroup = false;
                model.isMuted = chat.mute?.expiration !== 0;

                if (isChannel) {
                    try {
                        model.isChannel = window
                            .require('WAWebChatGetters')
                            .getIsNewsletter(chat);
                    } catch (_) { /* skip */ }
                } else {
                    model.formattedTitle = chat.formattedTitle;
                }

                if (chat.groupMetadata) {
                    model.isGroup = true;
                    try {
                        const chatWid = window
                            .require('WAWebWidFactory')
                            .createWid(chat.id._serialized);
                        const groupMetadata =
                            window.require('WAWebCollections').GroupMetadata ||
                            window.require('WAWebCollections').WAWebGroupMetadataCollection;
                        await groupMetadata.update(chatWid);
                    } catch (_) {
                        // skip IDB
                    }

                    try {
                        const { toPn } = window.require('WAWebLidMigrationUtils');
                        const serializedMetadata = chat.groupMetadata.serialize();
                        for (const p of serializedMetadata.participants || []) {
                            p.id = toPn(p.id) ?? p.id;
                        }
                        model.groupMetadata = serializedMetadata;
                    } catch (_) {
                        model.groupMetadata = chat.groupMetadata.serialize
                            ? chat.groupMetadata.serialize()
                            : {};
                    }
                    model.isReadOnly = chat.groupMetadata.announce;
                }

                if (chat.newsletterMetadata) {
                    try {
                        const newsletterMetadata =
                            window.require('WAWebCollections')
                                .NewsletterMetadataCollection ||
                            window.require('WAWebCollections')
                                .WAWebNewsletterMetadataCollection;
                        await newsletterMetadata.update(chat.id);
                        model.channelMetadata = chat.newsletterMetadata.serialize();
                        model.channelMetadata.createdAtTs =
                            chat.newsletterMetadata.creationTime;
                    } catch (_) { }
                }

                model.lastMessage = null;
                if (model.msgs && model.msgs.length) {
                    try {
                        const lastMessage = chat.lastReceivedKey
                            ? window
                                .require('WAWebCollections')
                                .Msg.get(chat.lastReceivedKey._serialized) ||
                            (
                                await window
                                    .require('WAWebCollections')
                                    .Msg.getMessagesById([
                                        chat.lastReceivedKey._serialized,
                                    ])
                            )?.messages?.[0]
                            : null;
                        if (lastMessage) {
                            model.lastMessage =
                                window.WWebJS.getMessageModel(lastMessage);
                        }
                    } catch (_) { }
                }

                return model;
            };

            // 2. Patch getContactModel
            const origGetContactModel = window.WWebJS.getContactModel;
            window.WWebJS.getContactModel = (contact) => {
                let res = contact.serialize();
                const wid = window
                    .require('WAWebWidFactory')
                    .createWidFromWidLike(contact.id);

                if (wid && wid.isLid() && contact.phoneNumber) {
                    res.id = contact.phoneNumber;
                }

                res.isBusiness = contact.isBusiness === undefined ? false : contact.isBusiness;

                if (contact.businessProfile) {
                    try {
                        res.businessProfile = contact.businessProfile.serialize();
                    } catch (e) { }
                }

                res.isBlocked = contact.isContactBlocked;
                if (!res.isBlocked) {
                    try {
                        const alt = window
                            .require('WAWebApiContact')
                            .getAlternateUserWid(wid);
                        if (alt) {
                            res.isBlocked = !!window
                                .require('WAWebCollections')
                                .Blocklist.get(alt);
                        }
                    } catch (e) {
                        // skip Blocklist.get IDB errors
                    }
                }

                const ContactMethods = window.require('WAWebContactGetters');
                try { res.isMe = ContactMethods.getIsMe(contact); } catch (e) { }
                try { res.isUser = ContactMethods.getIsUser(contact); } catch (e) { }
                try { res.isGroup = ContactMethods.getIsGroup(contact); } catch (e) { }
                try { res.isWAContact = ContactMethods.getIsWAContact(contact); } catch (e) { }
                try { res.userid = ContactMethods.getUserid(contact); } catch (e) { }
                try { res.verifiedName = ContactMethods.getVerifiedName(contact); } catch (e) { }
                try { res.verifiedLevel = ContactMethods.getVerifiedLevel(contact); } catch (e) { }
                try { res.statusMute = ContactMethods.getStatusMute(contact); } catch (e) { }
                try { res.name = ContactMethods.getName(contact); } catch (e) { }
                try { res.shortName = ContactMethods.getShortName(contact); } catch (e) { }
                try { res.pushname = ContactMethods.getPushname(contact); } catch (e) { }

                try {
                    const { getIsMyContact } = window.require('WAWebFrontendContactGetters');
                    res.isMyContact = getIsMyContact(contact);
                } catch (e) { }
                try { res.isEnterprise = ContactMethods.getIsEnterprise(contact); } catch (e) { }

                return res;
            };

            // 3. Patch getContact
            const origGetContact = window.WWebJS.getContact;
            window.WWebJS.getContact = async (contactId) => {
                const contactWid = window
                    .require('WAWebWidFactory')
                    .createWid(contactId);
                const contact = await window
                    .require('WAWebCollections')
                    .Contact.find(contactWid);

                if (contact.isBusiness || contact.isEnterprise) {
                    try {
                        const bizProfile = await window
                            .require('WAWebCollections')
                            .BusinessProfile.find(contactWid);
                        bizProfile.profileOptions && (contact.businessProfile = bizProfile);
                    } catch (e) {
                        // skip BusinessProfile.find IDB errors
                    }
                }
                return window.WWebJS.getContactModel(contact);
            };
        });

        // Resolve groups straight from the in-page chat collection. client.getChats()
        // serialises every chat through getChatModel, which hits IndexedDB and
        // intermittently returns undefined ("Cannot read properties of undefined
        // (reading 'map')") — we only need each group's id and name.
        const configuredGroups = config.GROUP_NAMES || [];
        const { groups, available } = await groupReactions.resolveTargetGroups(configuredGroups);
        targetChats = groups;

        if (targetChats.length === 0) {
            console.error(`❌ No target groups found from your configuration: ${configuredGroups.join(', ')}`);
            console.error(`   Available groups you are in:`);
            available.forEach((c) => console.log(`   • ${c.name || '(unnamed)'}`));
            console.error('\nPlease update GROUP_NAME in Setting.txt and restart.');
            return;
        }

        console.log(`🎯 Target groups found (${targetChats.length}):`);
        targetChats.forEach((c) => console.log(`   • "${c.name}" (${c.id})`));
        console.log('');

        startScheduler(
            async (text) => {
                for (const chat of targetChats) {
                    try {
                        const sent = await client.sendMessage(chat.id, text);
                        // Remember exactly what we posted so reactions never have to
                        // rediscover it by re-reading history later.
                        groupReactions.trackSentMessage(sent, chat.id);
                    } catch (err) {
                        console.error(`❌ [Main] Failed to send scheduled message to ${chat.name}:`, err.message);
                    }
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
        console.error('❌ [Main] Full error:', err);
        console.error('❌ [Main] Stack:', err.stack);
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

client.on('message_edit', async (msg, newBody, prevBody) => {
    try {
        const normalizedNewBody = typeof newBody === 'string' ? newBody.trim() : '';
        const normalizedPrevBody = typeof prevBody === 'string' ? prevBody.trim() : '';
        const normalizedCurrentBody = typeof msg.body === 'string' ? msg.body.trim() : '';

        if (!normalizedNewBody || (normalizedNewBody === normalizedPrevBody && normalizedNewBody === normalizedCurrentBody)) {
            return;
        }

        msg.body = newBody; // Ensure body is updated



        if (msg.fromMe) {
            await handleOwnGroupMessage(msg);
            return;
        }

        if (msg.from && (msg.from.endsWith('@broadcast') || msg.from.endsWith('@g.us'))) return;

        await handleMessage(msg, client);
    } catch (err) {
        console.error('❌ [Main] Error handling edited message:', err.message);
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
    // Runs before the menu so mess-blocklist.txt is created (if missing) and
    // ready to edit well before the bot connects.
    loadBlocklist();

    runOpts = await showMenu();

    // Apply CLI overrides to global config
    applyOverrides({
        ENABLE_NEGOTIATION: runOpts.ENABLE_NEGOTIATION,
        DEFAULT_PRICE: runOpts.DEFAULT_PRICE,
    });

    console.log('🔌 Connecting to WhatsApp…\n');
    client.initialize();
})();
