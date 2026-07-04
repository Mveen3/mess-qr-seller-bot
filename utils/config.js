'use strict';

const fs = require('fs');
const path = require('path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const SETTINGS_FILE_PATH = path.resolve(PROJECT_ROOT, 'Setting.txt');

const DEFAULTS = {
    GROUP_NAMES: ['Mess Buy Sell @ IIITH - 2'],
    UPI_ID: 'mveen@upi',
    PHONE_NUMBER: '8948966418',
    QR_IMAGE_PATH: 'utils/qr.png',

    MEAL_BREAKFAST_START: '07:30',
    MEAL_BREAKFAST_END: '09:30',
    MEAL_LUNCH_START: '12:30',
    MEAL_LUNCH_END: '14:30',
    MEAL_DINNER_START: '19:30',
    MEAL_DINNER_END: '21:30',

    MESS_NAMES: ['Palash', 'Kadamba Veg', 'Kadamba NV', 'Yuktahar'],
    DEFAULT_MEAL: 'breakfast',
    DEFAULT_MESS: 'Kadamba Veg',
    DEFAULT_NUM_MESSAGES: 4,
    DEFAULT_PRICE: 30,
    PRICE_DROP: 5,

    ENABLE_NEGOTIATION: false,
    NEGOTIATION_MARGIN: 5,

    BUYER_INACTIVITY_MS: 90 * 1000,
    BUYER_TIMEOUT_WARNING_MS: 30 * 1000,

    BUYER_KEYWORDS: [
        'buy', '?', 'want', 'wants', 'available', 'available?', 'avail',
        'interested', 'need', 'qr', 'breakfast',
        'still', 'selling', 'sold', 'price', 'yes',
        'how much', 'take', 'wanna', 'is it there',
        'kharidna', 'chahiye', 'dedo', 'dega', 'dede', 'bechna',
        'kitne', 'kitna', 'chaiye', 'lelo', 'bech', 'bhejo', 'bhej',
    ],

    DONE_KEYWORDS: [
        'done', 'paid', 'sent', 'payment done',
        'transferred', 'completed', 'successful',
        'money sent', 'confirm', 'confirmed',
        'pay kiya', 'pay kar diya', 'paid bro',
        'ho gaya', 'hogaya', 'kar diya', 'kardiya',
        'bhej diya', 'bhejdiya', 'de diya', 'dediya',
        'krdiya', 'hogya', 'krdya', 'bhejdia',
        'payment hogaya', 'payment hogya',
    ],

    SELL_MESSAGE_TEMPLATE: 'Sell {messName} {mealTypeCapitalized} @{price}',
    PAYMENT_INSTRUCTION_MESSAGE:
        '_This transaction is handled by an automated system. Please reply with_ *DONE* _so that system can send the QR._',
    SOLD_MESSAGE: 'Sorry, already sold!',
    UNRECOGNIZED_MESSAGE:
        'Could not understand your message. Please reply with _*DONE*_ after completing the payment.',
    TIMEOUT_WARNING_MESSAGE:
        '⏳ Waiting for your payment confirmation for the next 30 seconds, else will move to the next buyer.',
    TIMEOUT_FINAL_MESSAGE:
        "Moved to the next buyer. If you still want it, reply with _*WANTS*_ and I'll notify you if the QR is still available.",
    SALE_CONFIRM_MESSAGE:
        'Thank you, {buyerName}.\\nEnjoy your {mealType}!\\n\\n_PS: If you were just testing the bot out of curiosity and didn\'t actually wants, please reply with_ *TESTING* _so the system can serve other buyers._',
    TEST_REVERTED_MESSAGE: 'Got it! Thanks for letting me know!',
    NEGOTIATION_ACCEPTED_MESSAGE: '✅ Offer of ₹{price} accepted!',
    PAY_VIA_PHONE_MESSAGE: 'You can also pay ₹{price} on the same number ie {phone}',
};

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
            (value.startsWith('\'') && value.endsWith('\''))
        ) {
            value = value.slice(1, -1);
        }

        parsed[key] = value;
    }

    return parsed;
}

function decodeText(value) {
    return String(value).replace(/\\n/g, '\n').replace(/\\t/g, '\t');
}

function getText(raw, key) {
    const value = raw[key];
    if (value === undefined || value === '') return decodeText(DEFAULTS[key]);
    return decodeText(value);
}

function getNumber(raw, key) {
    const value = raw[key];
    if (value === undefined || value === '') return DEFAULTS[key];

    const number = Number(value);
    return Number.isFinite(number) ? number : DEFAULTS[key];
}

function getBoolean(raw, key) {
    const value = raw[key];
    if (value === undefined || value === '') return DEFAULTS[key];

    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'off'].includes(normalized)) return false;
    return DEFAULTS[key];
}

function getList(raw, key) {
    const value = raw[key];
    if (value === undefined || value.trim() === '') return [...DEFAULTS[key]];

    return value
        .split(',')
        .map((item) => decodeText(item).trim())
        .filter(Boolean);
}

function resolveProjectPath(rawValue, fallbackRelativePath) {
    const normalized = rawValue && rawValue.trim() ? rawValue.trim() : fallbackRelativePath;
    if (path.isAbsolute(normalized)) return normalized;
    return path.resolve(PROJECT_ROOT, normalized);
}

function applyTemplate(template, variables) {
    return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key) => {
        if (!Object.prototype.hasOwnProperty.call(variables, key)) return match;
        return String(variables[key]);
    });
}

const rawSettings = parseSettingsFile(SETTINGS_FILE_PATH);

const settings = {
    GROUP_NAMES: (() => {
        // Support both GROUP_NAMES and GROUP_NAME keys in Setting.txt
        const raw = rawSettings.GROUP_NAMES || rawSettings.GROUP_NAME;
        if (!raw || !raw.trim()) return [...DEFAULTS.GROUP_NAMES];
        return raw.split(',').map((s) => s.trim()).filter(Boolean);
    })(),
    UPI_ID: getText(rawSettings, 'UPI_ID'),
    PHONE_NUMBER: getText(rawSettings, 'PHONE_NUMBER'),
    QR_IMAGE_PATH: resolveProjectPath(rawSettings.QR_IMAGE_PATH, DEFAULTS.QR_IMAGE_PATH),

    MEAL_TIMINGS: {
        breakfast: {
            start: getText(rawSettings, 'MEAL_BREAKFAST_START'),
            end: getText(rawSettings, 'MEAL_BREAKFAST_END'),
        },
        lunch: {
            start: getText(rawSettings, 'MEAL_LUNCH_START'),
            end: getText(rawSettings, 'MEAL_LUNCH_END'),
        },
        dinner: {
            start: getText(rawSettings, 'MEAL_DINNER_START'),
            end: getText(rawSettings, 'MEAL_DINNER_END'),
        },
    },

    MESS_NAMES: getList(rawSettings, 'MESS_NAMES'),
    DEFAULT_MEAL: getText(rawSettings, 'DEFAULT_MEAL'),
    DEFAULT_MESS: getText(rawSettings, 'DEFAULT_MESS'),
    DEFAULT_NUM_MESSAGES: getNumber(rawSettings, 'DEFAULT_NUM_MESSAGES'),

    DEFAULT_PRICE: getNumber(rawSettings, 'DEFAULT_PRICE'),
    PRICE_DROP: getNumber(rawSettings, 'PRICE_DROP'),

    ENABLE_NEGOTIATION: getBoolean(rawSettings, 'ENABLE_NEGOTIATION'),
    NEGOTIATION_MARGIN: getNumber(rawSettings, 'NEGOTIATION_MARGIN'),

    BUYER_INACTIVITY_MS: getNumber(rawSettings, 'BUYER_INACTIVITY_MS'),
    BUYER_TIMEOUT_WARNING_MS: getNumber(rawSettings, 'BUYER_TIMEOUT_WARNING_MS'),

    BUYER_KEYWORDS: getList(rawSettings, 'BUYER_KEYWORDS'),
    DONE_KEYWORDS: getList(rawSettings, 'DONE_KEYWORDS'),
};

settings.sellMessage = (messName, mealType, price) =>
    applyTemplate(getText(rawSettings, 'SELL_MESSAGE_TEMPLATE'), {
        messName,
        mealType,
        mealTypeCapitalized: mealType.charAt(0).toUpperCase() + mealType.slice(1),
        price,
    });

settings.paymentInstructionMessage = () =>
    getText(rawSettings, 'PAYMENT_INSTRUCTION_MESSAGE');

settings.soldMessage = () => getText(rawSettings, 'SOLD_MESSAGE');
settings.unrecognizedMessage = () => getText(rawSettings, 'UNRECOGNIZED_MESSAGE');
settings.timeoutWarningMessage = () => getText(rawSettings, 'TIMEOUT_WARNING_MESSAGE');
settings.timeoutFinalMessage = () => getText(rawSettings, 'TIMEOUT_FINAL_MESSAGE');

settings.saleConfirmMessage = (buyerName, mealType) =>
    applyTemplate(getText(rawSettings, 'SALE_CONFIRM_MESSAGE'), { buyerName, mealType });

settings.testRevertedMessage = () => getText(rawSettings, 'TEST_REVERTED_MESSAGE');

settings.negotiationAcceptedMessage = (price) =>
    applyTemplate(getText(rawSettings, 'NEGOTIATION_ACCEPTED_MESSAGE'), { price });

settings.payViaPhoneMessage = (price, phone) =>
    applyTemplate(getText(rawSettings, 'PAY_VIA_PHONE_MESSAGE'), { price, phone });

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
