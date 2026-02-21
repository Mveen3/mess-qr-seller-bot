'use strict';

function extractPrice(text) {
    if (!text || typeof text !== 'string') return null;

    const cleaned = text
        .replace(/₹/g, '')
        .replace(/rs\.?/gi, '')
        .replace(/inr/gi, '')
        .trim();

    const match = cleaned.match(/\b(\d+)\b/);
    if (match) {
        const num = parseInt(match[1], 10);
        if (num > 0 && num <= 500) return num;
    }

    return null;
}

module.exports = { extractPrice };
