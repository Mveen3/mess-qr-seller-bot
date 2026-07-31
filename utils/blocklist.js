'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const BLOCKLIST_FILE_PATH = path.resolve(PROJECT_ROOT, 'mess-blocklist.txt');

// Re-stat the file at most this often so edits take effect without a restart.
const RELOAD_CHECK_INTERVAL_MS = 5000;

let blockedNumbers = new Set();
let loadedMtimeMs = null;
let loadedSize = null;
let lastCheckedMs = 0;
let hasLoadedOnce = false;

// ─── Normalisation ──────────────────────────────────────────

/**
 * Reduce any phone-number-ish string to its 10-digit national number.
 *
 * WhatsApp hands us the same person in many shapes — "+91-89468 93829",
 * "894-6893829", "0918946893829", "918946893829@c.us" — so we throw away every
 * non-digit and keep the last 10 digits. Country codes (91 / 0091) and the
 * trunk "0" always sit in front of the subscriber number, so the tail is the
 * stable identity.
 */
function normalizeNumber(value) {
    if (value === undefined || value === null) return null;

    const digits = String(value).replace(/\D/g, '');
    if (digits.length < 10) return null;

    return digits.slice(-10);
}

/**
 * Same as normalizeNumber, but WID-aware (accepts "9189...@c.us" strings or
 * whatsapp-web.js WID objects).
 *
 * LIDs are deliberately rejected: a "@lid" is an opaque WhatsApp-internal id,
 * not a phone number, so slicing its last 10 digits could collide with a real
 * blocked number by pure chance.
 */
function widToNumber(wid) {
    if (!wid) return null;

    if (typeof wid === 'object') {
        const serialized =
            wid._serialized || (wid.user ? `${wid.user}@${wid.server || 'c.us'}` : null);
        return widToNumber(serialized);
    }

    const text = String(wid);
    const atIndex = text.indexOf('@');
    if (atIndex === -1) return normalizeNumber(text);

    const server = text.slice(atIndex + 1).toLowerCase();
    if (server === 'lid') return null;

    return normalizeNumber(text.slice(0, atIndex));
}

// ─── Default file ───────────────────────────────────────────

// mess-blocklist.txt is git-ignored, so a fresh clone won't have one. Rather
// than silently blocking nobody, we write this self-documenting template on
// startup and let the user fill it in.
const DEFAULT_BLOCKLIST_TEMPLATE = `# Blocked numbers — messages from these people are ignored completely.
# No reply, no read receipt, no queue slot, not counted in the sale report.
#
# One number per line, 10 digits:
#   8946893829
#
# Formatting is forgiving — country codes, +, -, spaces and brackets are
# stripped before matching, so all of these mean the same person:
#   +91-8946893829   /   89468 93829   /   894-6893829   /   918946893829
#
# Lines starting with # are comments. Edits take effect within ~5 seconds,
# no restart needed.

`;

/** Create mess-blocklist.txt from the template if it isn't there yet. */
function ensureBlocklistFile() {
    try {
        if (fs.existsSync(BLOCKLIST_FILE_PATH)) return false;

        fs.writeFileSync(BLOCKLIST_FILE_PATH, DEFAULT_BLOCKLIST_TEMPLATE, 'utf8');
        console.log(`📝 [Blocklist] Created ${path.basename(BLOCKLIST_FILE_PATH)} in the project root — add numbers you want ignored, one per line.`);
        return true;
    } catch (err) {
        console.error('❌ [Blocklist] Could not create blocklist file:', err.message);
        return false;
    }
}

// ─── Loading ────────────────────────────────────────────────

function parseBlocklistFile(filePath) {
    const numbers = new Set();
    const invalid = [];

    const fileContent = fs.readFileSync(filePath, 'utf8');
    const lines = fileContent.split(/\r?\n/);

    lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return;

        const normalized = normalizeNumber(trimmed);
        if (normalized) {
            numbers.add(normalized);
        } else {
            invalid.push(`line ${index + 1}: "${trimmed}"`);
        }
    });

    return { numbers, invalid };
}

function loadBlocklist({ silent = false } = {}) {
    try {
        ensureBlocklistFile();

        // Still missing means the write failed (read-only dir, permissions) —
        // carry on with an empty list instead of crashing the bot.
        if (!fs.existsSync(BLOCKLIST_FILE_PATH)) {
            blockedNumbers = new Set();
            loadedMtimeMs = null;
            loadedSize = null;
            hasLoadedOnce = true;
            return blockedNumbers;
        }

        const stats = fs.statSync(BLOCKLIST_FILE_PATH);
        const { numbers, invalid } = parseBlocklistFile(BLOCKLIST_FILE_PATH);

        blockedNumbers = numbers;
        loadedMtimeMs = stats.mtimeMs;
        loadedSize = stats.size;
        hasLoadedOnce = true;

        if (!silent) {
            console.log(`⛔ [Blocklist] Loaded ${numbers.size} blocked number(s).`);
            if (invalid.length > 0) {
                console.warn(`⚠️  [Blocklist] Skipped ${invalid.length} unusable line(s): ${invalid.join(', ')}`);
            }
        }
    } catch (err) {
        console.error('❌ [Blocklist] Failed to read blocklist:', err.message);
        blockedNumbers = new Set();
        loadedMtimeMs = null;
        loadedSize = null;
        hasLoadedOnce = true;
    }

    return blockedNumbers;
}

/** Reload only when the file actually changed, and at most every few seconds. */
function ensureLoaded() {
    const now = Date.now();

    if (!hasLoadedOnce) {
        loadBlocklist();
        lastCheckedMs = now;
        return;
    }

    if (now - lastCheckedMs < RELOAD_CHECK_INTERVAL_MS) return;
    lastCheckedMs = now;

    try {
        if (!fs.existsSync(BLOCKLIST_FILE_PATH)) {
            if (loadedMtimeMs !== null) loadBlocklist();
            return;
        }

        const stats = fs.statSync(BLOCKLIST_FILE_PATH);
        if (stats.mtimeMs !== loadedMtimeMs || stats.size !== loadedSize) {
            loadBlocklist();
        }
    } catch (_) {
        // Keep the numbers we already have rather than failing open on a
        // transient stat error.
    }
}

// ─── Lookups ────────────────────────────────────────────────

function isBlockedNumber(value) {
    ensureLoaded();
    if (blockedNumbers.size === 0) return false;

    const normalized = normalizeNumber(value);
    return normalized !== null && blockedNumbers.has(normalized);
}

function isBlockedWid(wid) {
    ensureLoaded();
    if (blockedNumbers.size === 0) return false;

    const normalized = widToNumber(wid);
    return normalized !== null && blockedNumbers.has(normalized);
}

/**
 * Second-pass check once a Contact has been resolved. Needed because a chat
 * addressed by "@lid" only reveals the real phone number on the contact.
 */
function isBlockedContact(contact) {
    if (!contact) return false;
    ensureLoaded();
    if (blockedNumbers.size === 0) return false;

    if (isBlockedWid(contact.id)) return true;
    if (isBlockedWid(contact.phoneNumber)) return true;

    // contact.number mirrors contact.id.user, so only trust it when the WID is
    // a real phone WID and not a LID.
    if (widToNumber(contact.id) !== null && isBlockedNumber(contact.number)) return true;

    return false;
}

function getBlockedNumbers() {
    ensureLoaded();
    return Array.from(blockedNumbers);
}

module.exports = {
    BLOCKLIST_FILE_PATH,
    ensureBlocklistFile,
    loadBlocklist,
    normalizeNumber,
    widToNumber,
    isBlockedNumber,
    isBlockedWid,
    isBlockedContact,
    getBlockedNumbers,
};
