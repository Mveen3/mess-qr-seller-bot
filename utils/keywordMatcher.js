'use strict';

const { BUYER_KEYWORDS, DONE_KEYWORDS } = require('./settings');

function isBuyerKeyword(text) {
    const lower = text.toLowerCase();
    return BUYER_KEYWORDS.some((kw) => {
        const regex = new RegExp(`\\b${escapeRegex(kw)}\\b`, 'i');
        return regex.test(lower);
    });
}

function isDoneKeyword(text) {
    const lower = text.toLowerCase();
    return DONE_KEYWORDS.some((kw) => lower.includes(kw));
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = { isBuyerKeyword, isDoneKeyword };
