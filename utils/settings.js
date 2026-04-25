'use strict';

const path = require('path');

const settings = {
    // ─── Target Group ───────────────────────────────────────────
    GROUP_NAME: 'Mess Buy Sell @ IIITH - 2',
        // GROUP_NAME: 'Temp', // for testing

    // ─── Seller Info ────────────────────────────────────────────
    UPI_ID: 'mveen@upi',
    QR_IMAGE_PATH: path.resolve(__dirname, 'qr.png'),
    PHONE_NUMBER: '8948966418',

    // ─── Meal Configuration ─────────────────────────────────────
    MEAL_TIMINGS: {
        breakfast: { start: '07:30', end: '09:30' },
        lunch: { start: '12:30', end: '14:30' },
        dinner: { start: '19:30', end: '21:30' },
    },

    MESS_NAMES: ['Palash', 'Kadamba Veg', 'Kadamba NV', 'Yuktahar'],

    DEFAULT_MEAL: 'breakfast',
    DEFAULT_MESS: 'Kadamba Veg',
    DEFAULT_NUM_MESSAGES: 4,

    // ─── Pricing ────────────────────────────────────────────────
    DEFAULT_PRICE: 30,
    PRICE_DROP: 5,           // decrease per scheduled message

    // ─── Negotiation ───────────────────────────────────────────
    ENABLE_NEGOTIATION: false,
    NEGOTIATION_MARGIN: 5,

    // ─── Payment Verification ──────────────────────────────────
    PAYMENT_VERIFICATION_ENABLED: true, // default ON
    SBI_BANKING_CHAT_ID: '919022690226@c.us',
    SBI_MINI_STATEMENT_COMMAND: 'Get Mini Statement📄',
    PAYMENT_VERIFICATION_TIMEOUT_MS: 45 * 1000,
    PAYMENT_VERIFICATION_FOLLOWUP_TIMEOUT_MS: 12 * 1000,
    PAYMENT_VERIFICATION_LOG_PATH: path.resolve(__dirname, 'payment_verification_log.json'),

    // ─── Buyer Timeout (ms) ────────────────────────────────────
    BUYER_INACTIVITY_MS: 90 * 1000,    // 1.5 min — window for second buyer
    BUYER_TIMEOUT_WARNING_MS: 30 * 1000,    // 30s warning before moving

    // ─── Buyer Detection Keywords ───────────────────────────────
    BUYER_KEYWORDS: [
        'buy','?', 'want', 'wants', 'available', 'available?','avail',
        'interested', 'need', 'qr', 'breakfast',
        'still', 'selling', 'sold', 'price','yes',
        'how much', 'take', 'wanna', 'is it there',
        // Hinglish
        'kharidna', 'chahiye', 'dedo', 'dega', 'dede', 'bechna',
        'kitne', 'kitna', 'chaiye', 'lelo', 'bech','bhejo','bhej',
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

    paymentInstructionMessage: (paymentVerificationEnabled = settings.PAYMENT_VERIFICATION_ENABLED) =>
        paymentVerificationEnabled
            ? `_This transaction is handled by an automated system. Please reply with_ *DONE* _so that system can verify your payment and send the QR._`
            : `_This transaction is handled by an automated system. Please reply with_ *DONE* _so that system can send the QR._`,

    paymentVerificationInProgressMessage: () =>
        `Please wait while the system verifies your payment.`,

    paymentVerificationInProgressAlreadyMessage: () =>
        `Payment verification is already in progress. Please wait a few seconds.`,

    paymentVerificationNoNewCreditMessage: () =>
        `I could not detect your payment in the latest bank statement yet. If you have already paid, please share a payment screenshot. Otherwise, please wait a moment and reply with *DONE* again.`,

    paymentVerificationInsufficientAmountMessage: (expectedAmount, receivedAmount) =>
        `I detected ₹${receivedAmount.toFixed(2)} credited, but the current price is ₹${expectedAmount}. Please pay the remaining amount and reply with *DONE* again. If you have already paid the full amount, please share a payment screenshot.`,

    paymentVerificationSystemErrorMessage: () =>
        `I could not verify payment right now due to a temporary issue. Please try again by sending *DONE* in a minute.`,

    paymentVerificationScreenshotAcceptedMessage: () =>
        `Apologies for the delay in verification. I have accepted your payment screenshot and I am sending the QR now.`,

    soldMessage: () =>
        `Sorry, already sold!`,

    unrecognizedMessage: () =>
        `Could not understand your message. Please reply with _*DONE*_ after completing the payment.`,

    timeoutWarningMessage: () =>
        `⏳ Waiting for your payment confirmation for the next 30 seconds, else will move to the next buyer.`,

    timeoutFinalMessage: () =>
        `Moved to the next buyer. If you still want it, reply with _*WANTS*_ and I'll notify you if the QR is still available.`,

    saleConfirmMessage: (buyerName, mealType) =>
        `Thank you, ${buyerName}.\nEnjoy your ${mealType}!\n\n_PS: If you were just testing the bot out of curiosity and didn't actually wants, please reply with_ *TESTING* _so the system can serve other buyers._`,

    saleConfirmPaidMessage: (buyerName, mealType) =>
        `Thank you, ${buyerName}.\nEnjoy your ${mealType}!`,

    testRevertedMessage: () =>
        `Got it! Thanks for letting me know!`,

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
