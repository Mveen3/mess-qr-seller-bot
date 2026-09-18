const config = require('./config');
const { BUYER_KEYWORDS, DONE_KEYWORDS } = config;

function isBuyerKeyword(text) {
    const lower = normalizeText(text);
    if (!lower) return null;

    const matched = BUYER_KEYWORDS.find((kw) => {
        const keyword = normalizeText(kw);
        if (!keyword) return false;

        // Punctuation-only triggers like "?" cannot be matched with word boundaries.
        if (!/[a-z0-9]/i.test(keyword)) {
            return lower.includes(keyword);
        }

        const regex = new RegExp(`(^|[^a-z0-9])${escapeRegex(keyword)}([^a-z0-9]|$)`, 'i');
        return regex.test(lower);
    });
    return matched || null;
}

function isDoneKeyword(text) {
    const lower = normalizeText(text);
    if (!lower) return null;
    const matched = DONE_KEYWORDS.find((kw) => {
        const keyword = normalizeText(kw);
        return keyword ? lower.includes(keyword) : false;
    });
    return matched || null;
}

/**
 * Detects if a message or quoted reply contains "Sell <mess name> <meal type>" as a substring.
 * E.g. "Sell Kadamba Veg Breakfast @35", "Sell Palash Lunch @30", etc.
 */
function isSellMessageSubstring(text) {
    if (!text || typeof text !== 'string') return false;
    const clean = text.trim();
    if (!clean) return false;

    // Pattern 1: "Sell <mess name> <meal type>"
    const sellRegex = /\bsell\s+([a-z0-9\s\-_/]+?)\s+(breakfast|lunch|dinner|snacks|snack|tiffin|bf|bkfst)\b/i;
    if (sellRegex.test(clean)) {
        return true;
    }

    // Pattern 2: Fallback check matching "sell" with configured mess names and meal types
    const lower = clean.toLowerCase();
    if (lower.includes('sell')) {
        const knownMeals = ['breakfast', 'lunch', 'dinner', 'snacks', 'snack', 'tiffin', 'bf'];
        const hasMeal = knownMeals.some((m) => lower.includes(m));
        if (hasMeal) {
            const messList = [
                ...(config.MESS_NAMES || []),
                config.DEFAULT_MESS,
            ].filter(Boolean);

            const hasMess = messList.some((m) => lower.includes(m.toLowerCase().trim()));
            if (hasMess) return true;
        }
    }

    return false;
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeText(value) {
    return typeof value === 'string' ? value.toLowerCase().trim() : '';
}

module.exports = { isBuyerKeyword, isDoneKeyword, isSellMessageSubstring };
