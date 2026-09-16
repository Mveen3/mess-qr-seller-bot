'use strict';

const fs = require('fs');
const path = require('path');

const CSV_HEADER = 'phone,name,total_spent,last_updated\n';

/**
 * Reduce any phone-number-like string to its 10-digit national number.
 */
function normalizePhoneNumber(value) {
    if (value === undefined || value === null) return null;
    const digits = String(value).replace(/\D/g, '');
    if (digits.length < 10) return null;
    return digits.slice(-10);
}

/**
 * Extract 10-digit phone number from a WhatsApp WID string or object.
 */
function widToPhoneNumber(wid) {
    if (!wid) return null;
    if (typeof wid === 'object') {
        const serialized =
            wid._serialized || (wid.user ? `${wid.user}@${wid.server || 'c.us'}` : null);
        return widToPhoneNumber(serialized);
    }

    const text = String(wid);
    const atIndex = text.indexOf('@');
    if (atIndex === -1) return normalizePhoneNumber(text);

    const server = text.slice(atIndex + 1).toLowerCase();
    if (server === 'lid') return null; // LID is not a phone number

    return normalizePhoneNumber(text.slice(0, atIndex));
}

/**
 * Resolve a unique buyer identifier (10-digit phone number, or raw WID if phone unavailable).
 */
function resolveBuyerPhone(contact, senderId) {
    const contactPhone = contact?.number || contact?.phoneNumber;
    const normalizedContactPhone = normalizePhoneNumber(contactPhone);
    if (normalizedContactPhone) return normalizedContactPhone;

    const widPhone = widToPhoneNumber(senderId);
    if (widPhone) return widPhone;

    return senderId ? String(senderId).trim() : 'unknown';
}

/**
 * Escape a string for CSV format.
 */
function escapeCsvField(field) {
    if (field === null || field === undefined) return '';
    const str = String(field);
    if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
        return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

/**
 * Unescape a CSV field.
 */
function unescapeCsvField(field) {
    if (!field) return '';
    let str = field.trim();
    if (str.startsWith('"') && str.endsWith('"')) {
        str = str.slice(1, -1).replace(/""/g, '"');
    }
    return str;
}

/**
 * Format current date (or given date) as DD/MM/YYYY in Asia/Kolkata timezone.
 */
function getTodayDateFormatted(date = new Date()) {
    const parts = new Intl.DateTimeFormat('en-IN', {
        timeZone: 'Asia/Kolkata',
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
    }).formatToParts(date);

    const day = parts.find((p) => p.type === 'day')?.value || '';
    const month = parts.find((p) => p.type === 'month')?.value || '';
    const year = parts.find((p) => p.type === 'year')?.value || '';
    return `${day}/${month}/${year}`;
}

/**
 * Normalize any date string to DD/MM/YYYY without time.
 */
function normalizeDateStr(value) {
    if (!value || typeof value !== 'string') return getTodayDateFormatted();
    // Strip time portion if present (e.g. "16/9/2026, 3:07:01 pm" -> "16/9/2026")
    const datePart = value.split(',')[0].trim();
    const parts = datePart.split('/');
    if (parts.length === 3) {
        const d = parts[0].padStart(2, '0');
        const m = parts[1].padStart(2, '0');
        const y = parts[2];
        return `${d}/${m}/${y}`;
    }
    return datePart;
}

/**
 * Parse lines of a CSV file.
 */
function parseCsv(content) {
    const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length === 0) return [];

    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const line = lines[i];
        // Parse CSV row respecting quotes
        const tokens = [];
        let inQuotes = false;
        let token = '';

        for (let j = 0; j < line.length; j++) {
            const char = line[j];
            if (char === '"') {
                inQuotes = !inQuotes;
                token += char;
            } else if (char === ',' && !inQuotes) {
                tokens.push(token);
                token = '';
            } else {
                token += char;
            }
        }
        tokens.push(token);

        if (tokens.length >= 3) {
            const phone = unescapeCsvField(tokens[0]);
            const name = unescapeCsvField(tokens[1]);
            const totalSpent = Number(unescapeCsvField(tokens[2])) || 0;
            const lastUpdated = tokens[3] ? normalizeDateStr(unescapeCsvField(tokens[3])) : getTodayDateFormatted();
            rows.push({ phone, name, totalSpent, lastUpdated });
        }
    }
    return rows;
}

/**
 * Load records from CSV file. If file does not exist, initialize it.
 */
function loadRecords(filePath) {
    const resolvedPath = path.resolve(filePath);
    if (!fs.existsSync(resolvedPath)) {
        try {
            fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
            fs.writeFileSync(resolvedPath, CSV_HEADER, 'utf8');
            console.log(`📝 [Loyalty] Created ${path.basename(resolvedPath)} in ${path.dirname(resolvedPath)}/ with headers.`);
        } catch (err) {
            console.error(`❌ [Loyalty] Error initializing CSV at ${resolvedPath}:`, err.message);
        }
        return [];
    }

    try {
        const content = fs.readFileSync(resolvedPath, 'utf8');
        return parseCsv(content);
    } catch (err) {
        console.error(`❌ [Loyalty] Error reading CSV at ${resolvedPath}:`, err.message);
        return [];
    }
}

/**
 * Save records to CSV file.
 */
function saveRecords(filePath, records) {
    const resolvedPath = path.resolve(filePath);
    try {
        let content = CSV_HEADER;
        for (const r of records) {
            content += `${escapeCsvField(r.phone)},${escapeCsvField(r.name)},${r.totalSpent},${escapeCsvField(r.lastUpdated)}\n`;
        }
        fs.writeFileSync(resolvedPath, content, 'utf8');
    } catch (err) {
        console.error(`❌ [Loyalty] Error saving CSV to ${resolvedPath}:`, err.message);
    }
}

/**
 * Get buyer loyalty record by phone or senderId.
 */
function getBuyer(filePath, phoneOrId) {
    const records = loadRecords(filePath);
    const normalized = normalizePhoneNumber(phoneOrId) || String(phoneOrId).trim();
    const found = records.find((r) => r.phone === normalized || r.phone === phoneOrId);
    return found || null;
}

/**
 * Check if a buyer has reached or exceeded the loyalty target.
 */
function isFreeMealEligible(filePath, phoneOrId, target = 170) {
    const buyer = getBuyer(filePath, phoneOrId);
    if (!buyer) return false;
    return buyer.totalSpent >= target;
}

/**
 * Record a paid purchase for a buyer.
 */
function recordPurchase(filePath, phoneOrId, name, amount, target = 170) {
    const records = loadRecords(filePath);
    const normalized = normalizePhoneNumber(phoneOrId) || String(phoneOrId).trim();
    const purchaseAmount = Math.max(0, Number(amount) || 0);
    const nowStr = getTodayDateFormatted();

    let buyer = records.find((r) => r.phone === normalized || r.phone === phoneOrId);
    const previousTotal = buyer ? buyer.totalSpent : 0;
    const newTotal = previousTotal + purchaseAmount;

    if (buyer) {
        buyer.totalSpent = newTotal;
        if (name) buyer.name = name;
        buyer.lastUpdated = nowStr;
    } else {
        buyer = {
            phone: normalized,
            name: name || '',
            totalSpent: newTotal,
            lastUpdated: nowStr,
        };
        records.push(buyer);
    }

    saveRecords(filePath, records);

    const remaining = Math.max(0, target - newTotal);
    const isFreeNext = newTotal >= target;

    return {
        phone: normalized,
        name: buyer.name,
        previousTotal,
        newTotal,
        amount: purchaseAmount,
        target,
        remaining,
        isFreeNext,
    };
}

/**
 * Claim a free meal: resets buyer's total purchase to 0.
 */
function claimFreeMeal(filePath, phoneOrId, name) {
    const records = loadRecords(filePath);
    const normalized = normalizePhoneNumber(phoneOrId) || String(phoneOrId).trim();
    const nowStr = getTodayDateFormatted();

    let buyer = records.find((r) => r.phone === normalized || r.phone === phoneOrId);
    const previousTotal = buyer ? buyer.totalSpent : 0;

    if (buyer) {
        buyer.totalSpent = 0;
        if (name) buyer.name = name;
        buyer.lastUpdated = nowStr;
    } else {
        buyer = {
            phone: normalized,
            name: name || '',
            totalSpent: 0,
            lastUpdated: nowStr,
        };
        records.push(buyer);
    }

    saveRecords(filePath, records);

    return {
        phone: normalized,
        name: buyer.name,
        previousTotal,
        newTotal: 0,
    };
}

/**
 * Revert a purchase or a claimed free meal (e.g. if buyer replied 'TESTING').
 */
function revertBuyerAction(filePath, phoneOrId, { wasFreeMeal, amount, previousTotal }) {
    const records = loadRecords(filePath);
    const normalized = normalizePhoneNumber(phoneOrId) || String(phoneOrId).trim();
    const nowStr = getTodayDateFormatted();

    const buyer = records.find((r) => r.phone === normalized || r.phone === phoneOrId);
    if (!buyer) return;

    if (wasFreeMeal) {
        // Restore previous total so the earned free meal isn't lost
        buyer.totalSpent = previousTotal !== undefined ? previousTotal : 170;
        console.log(`🔄 [Loyalty] Restored free meal eligibility for ${buyer.phone} (total: ₹${buyer.totalSpent}).`);
    } else {
        // Subtract today's added purchase price
        const deduction = Number(amount) || 0;
        const newTotal = previousTotal !== undefined
            ? Math.max(0, previousTotal)
            : Math.max(0, buyer.totalSpent - deduction);
        console.log(`🔄 [Loyalty] Buyer replied TESTING. Subtracted ₹${deduction} from ${buyer.phone} (was: ₹${buyer.totalSpent}, now: ₹${newTotal}).`);
        buyer.totalSpent = newTotal;
    }
    buyer.lastUpdated = nowStr;

    saveRecords(filePath, records);
}

module.exports = {
    normalizePhoneNumber,
    widToPhoneNumber,
    resolveBuyerPhone,
    getTodayDateFormatted,
    normalizeDateStr,
    loadRecords,
    saveRecords,
    getBuyer,
    isFreeMealEligible,
    recordPurchase,
    claimFreeMeal,
    revertBuyerAction,
    ensureLoyaltyFile: loadRecords,
};
