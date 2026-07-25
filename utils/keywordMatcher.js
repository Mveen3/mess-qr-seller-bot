'use strict';

const { BUYER_KEYWORDS, DONE_KEYWORDS } = require('./config');

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

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeText(value) {
    return typeof value === 'string' ? value.toLowerCase().trim() : '';
}

module.exports = { isBuyerKeyword, isDoneKeyword };
