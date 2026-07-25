'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SETTINGS_FILE_PATH = path.resolve(PROJECT_ROOT, 'Setting.txt');

// ─── Parse Setting.txt ─────────────────────────────────────

function parseSettingsFile(filePath) {
    if (!fs.existsSync(filePath)) {
        throw new Error(`Missing Setting.txt at ${filePath}`);
    }

    const fileContent = fs.readFileSync(filePath, 'utf8');
    const lines = fileContent.split(/\r?\n/);
    const parsed = {};

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;

        const separatorIndex = trimmed.indexOf('=');
        if (separatorIndex === -1) continue;

        const key = trimmed.slice(0, separatorIndex).trim();
        let value = trimmed.slice(separatorIndex + 1).trim();

        if (
            (value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))
        ) {
            value = value.slice(1, -1);
        }

        parsed[key] = value;
    }

    return parsed;
}

// ─── Helpers ────────────────────────────────────────────────

function decodeText(value) {
    if (value === undefined || value === null) return '';
    return String(value).replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

function getText(raw, key) {
    return decodeText(raw[key]);
}

function getNumber(raw, key) {
    const value = raw[key];
    if (value === undefined || value === '') return 0;
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
}

function getBoolean(raw, key) {
    const value = raw[key];
    if (value === undefined || value === '') return false;
    const normalized = value.trim().toLowerCase();
    return ['true', '1', 'yes', 'y', 'on'].includes(normalized);
}

function getList(raw, key) {
    const value = raw[key];
    if (value === undefined || value.trim() === '') return [];
    return value
        .split(',')
        .map((item) => decodeText(item).trim())
        .filter(Boolean);
}

function resolveProjectPath(rawValue) {
    const normalized = (rawValue || '').trim();
    if (!normalized) return '';
    if (path.isAbsolute(normalized)) return normalized;
    return path.resolve(PROJECT_ROOT, normalized);
}

function applyTemplate(template, variables) {
    return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => {
        if (!Object.prototype.hasOwnProperty.call(variables, key)) return match;
        return String(variables[key]);
    });
}

// ─── Read Setting.txt & build config ────────────────────────

const raw = parseSettingsFile(SETTINGS_FILE_PATH);

const settings = {
    TESTING: getBoolean(raw, 'TESTING'),
    TESTING_GROUP_NAME: getList(raw, 'TESTING_GROUP_NAME'),

    GROUP_NAMES: (() => {
        const testing = getBoolean(raw, 'TESTING');
        if (testing) {
            return getList(raw, 'TESTING_GROUP_NAME');
        }
        return getList(raw, 'GROUP_NAME').length ? getList(raw, 'GROUP_NAME') : getList(raw, 'GROUP_NAMES');
    })(),

    UPI_ID: getText(raw, 'UPI_ID'),
    PHONE_NUMBER: getText(raw, 'PHONE_NUMBER'),
    QR_IMAGE_PATH: resolveProjectPath(raw.QR_IMAGE_PATH),

    MEAL_TIMINGS: {
        breakfast: {
            start: getText(raw, 'MEAL_BREAKFAST_START'),
            end: getText(raw, 'MEAL_BREAKFAST_END'),
        },
        lunch: {
            start: getText(raw, 'MEAL_LUNCH_START'),
            end: getText(raw, 'MEAL_LUNCH_END'),
        },
        dinner: {
            start: getText(raw, 'MEAL_DINNER_START'),
            end: getText(raw, 'MEAL_DINNER_END'),
        },
    },

    MESS_NAMES: getList(raw, 'MESS_NAMES'),
    DEFAULT_MEAL: getText(raw, 'DEFAULT_MEAL'),
    DEFAULT_MESS: getText(raw, 'DEFAULT_MESS'),
    DEFAULT_NUM_MESSAGES: getNumber(raw, 'DEFAULT_NUM_MESSAGES'),

    DEFAULT_PRICE: getNumber(raw, 'DEFAULT_PRICE'),
    PRICE_DROP: getNumber(raw, 'PRICE_DROP'),

    ENABLE_NEGOTIATION: getBoolean(raw, 'ENABLE_NEGOTIATION'),
    NEGOTIATION_MARGIN: getNumber(raw, 'NEGOTIATION_MARGIN'),

    BUYER_INACTIVITY_MS: getNumber(raw, 'BUYER_INACTIVITY_MS'),
    BUYER_TIMEOUT_WARNING_MS: getNumber(raw, 'BUYER_TIMEOUT_WARNING_MS'),

    BUYER_KEYWORDS: getList(raw, 'BUYER_KEYWORDS'),
    DONE_KEYWORDS: getList(raw, 'DONE_KEYWORDS'),
};

// ─── Template message functions ─────────────────────────────

settings.sellMessage = (messName, mealType, price) =>
    applyTemplate(getText(raw, 'SELL_MESSAGE_TEMPLATE'), {
        messName,
        mealType,
        mealTypeCapitalized: mealType.charAt(0).toUpperCase() + mealType.slice(1),
        price,
    });

settings.paymentInstructionMessage = () => getText(raw, 'PAYMENT_INSTRUCTION_MESSAGE');
settings.soldMessage = () => getText(raw, 'SOLD_MESSAGE');
settings.unrecognizedMessage = () => getText(raw, 'UNRECOGNIZED_MESSAGE');
settings.timeoutWarningMessage = () => getText(raw, 'TIMEOUT_WARNING_MESSAGE');
settings.timeoutFinalMessage = () => getText(raw, 'TIMEOUT_FINAL_MESSAGE');

settings.saleConfirmMessage = (buyerName, mealType) =>
    applyTemplate(getText(raw, 'SALE_CONFIRM_MESSAGE'), { buyerName, mealType });

settings.testRevertedMessage = () => getText(raw, 'TEST_REVERTED_MESSAGE');

settings.negotiationAcceptedMessage = (price) =>
    applyTemplate(getText(raw, 'NEGOTIATION_ACCEPTED_MESSAGE'), { price });

settings.payViaPhoneMessage = (price, phone) =>
    applyTemplate(getText(raw, 'PAY_VIA_PHONE_MESSAGE'), { price, phone });

// ─── Runtime overrides (from CLI menu) ──────────────────────

function applyOverrides(overrides) {
    for (const [key, value] of Object.entries(overrides)) {
        if (key in settings && typeof settings[key] !== 'function') {
            settings[key] = value;
        }
    }
}

module.exports = settings;
module.exports.applyOverrides = applyOverrides;
module.exports.SETTINGS_FILE_PATH = SETTINGS_FILE_PATH;
