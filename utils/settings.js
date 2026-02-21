'use strict';

const path = require('path');

const settings = {
    // ─── Target Group ───────────────────────────────────────────
    GROUP_NAME: 'Mess Buy Sell @ IIITH - 2',

    // ─── Seller Info ────────────────────────────────────────────
    UPI_ID: 'mveen@upi',
    QR_IMAGE_PATH: path.resolve(__dirname, 'qr.png'),
    PHONE_NUMBER: '8XXXXXXXX8',

    // ─── Meal Configuration ─────────────────────────────────────
    MEAL_TIMINGS: {
        breakfast: { start: '07:30', end: '09:30' },
        lunch: { start: '12:30', end: '14:30' },
        dinner: { start: '19:30', end: '21:30' },
    },

    MESS_NAMES: ['Palash', 'Kadamba Veg', 'Kadamba NV', 'Yuktahar'],

    DEFAULT_MEAL: 'breakfast',
    DEFAULT_MESS: 'Palash',
    DEFAULT_NUM_MESSAGES: 4,

    // ─── Pricing ────────────────────────────────────────────────
    DEFAULT_PRICE: 30,
    PRICE_DROP: 5,           // decrease per scheduled message

    // ─── Negotiation ───────────────────────────────────────────
    ENABLE_NEGOTIATION: false,
    NEGOTIATION_MARGIN: 5,

    // ─── Buyer Timeout (ms) ────────────────────────────────────
    BUYER_INACTIVITY_MS: 3 * 60 * 1000,    // 3 min — window for second buyer
    BUYER_TIMEOUT_WARNING_MS: 30 * 1000,    // 30s warning before moving

    // ─── Buyer Detection Keywords ───────────────────────────────
    BUYER_KEYWORDS: [
        'buy', 'want', 'wants', 'available', 'available?',
        'interested', 'need', 'qr', 'breakfast',
        'still', 'selling', 'sold?', 'price',
        'how much', 'take', 'wanna',
        // Hinglish
        'kharidna', 'chahiye', 'dedo', 'dega', 'dede', 'bechna',
        'kitne', 'kitna', 'chaiye', 'lelo', 'bech',
    ],

    // ─── Sale Completion Keywords ───────────────────────────────
    DONE_KEYWORDS: [
        'done', 'paid', 'sent', 'payment done',
        'transferred', 'completed', 'successful',
        'money sent', 'confirm', 'confirmed',
        'pay kiya', 'pay kar diya', 'paid bro',
        // Hinglish
        'ho gaya', 'hogaya', 'kar diya', 'kardiya',
        'bhej diya', 'bhejdiya', 'de diya', 'dediya',
        'krdiya', 'hogya', 'krdya', 'bhejdia',
        'payment hogaya', 'payment hogya',
    ],

    // ─── Bot Messages (customisable) ───────────────────────────

    sellMessage: (messName, mealType, price) =>
        `Sell ${messName} ${mealType.charAt(0).toUpperCase() + mealType.slice(1)} @${price}`,

    paymentInstructionMessage: () =>
        `This transaction is handled by an automated system. Please reply with _*done*_ after payment so that the system can confirm and deliver the QR.`,

    soldMessage: () =>
        `Sorry, already sold!`,

    unrecognizedMessage: () =>
        `Could not understand your message. Please reply with _*done*_ after completing the payment.`,

    timeoutWarningMessage: () =>
        `⏳ Waiting for your payment confirmation for the next 30 seconds, else will move to the next buyer.`,

    timeoutFinalMessage: () =>
        `Moved to the next buyer. If you still want it, reply with _*wants*_ and I'll notify you if the QR is still available.`,

    saleConfirmMessage: (buyerName) =>
        `✅ Payment confirmed!\nThank you, ${buyerName}.\nEnjoy your meal!`,

    negotiationAcceptedMessage: (price) =>
        `✅ Offer of ₹${price} accepted!`,

    payViaPhoneMessage: (price, phone) =>
        `You can also pay ₹${price} on the same number ie ${phone}`,
};


function applyOverrides(overrides) {
    for (const [key, value] of Object.entries(overrides)) {
        if (key in settings) {
            settings[key] = value;
        }
    }
}

module.exports = settings;
module.exports.applyOverrides = applyOverrides;
