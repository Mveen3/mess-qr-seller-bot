'use strict';

const readline = require('readline');
const config = require('./settings');

function createInterface() {
    return readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
}

function ask(rl, question) {
    return new Promise((resolve) => {
        rl.question(question, (answer) => resolve(answer.trim()));
    });
}

/**
 * Detect the meal type based on current time.
 */
function detectMeal() {
    const now = new Date();
    const nowMins = now.getHours() * 60 + now.getMinutes();

    for (const [meal, { start, end }] of Object.entries(config.MEAL_TIMINGS)) {
        const [eH, eM] = end.split(':').map(Number);
        // Pick the first meal whose end time hasn't passed yet
        if (nowMins < eH * 60 + eM) return meal;
    }
    return config.DEFAULT_MEAL;
}

async function showMenu() {
    const rl = createInterface();

    console.log(`
══════════════════════════════════════
      🍽️  Mess QR Selling Bot         
══════════════════════════════════════
  [0]  Run with default settings     
  [1]  Run with custom settings      
══════════════════════════════════════
`);

    const choice = await ask(rl, '👉 Enter your choice [0/1] (default: 0): ');

    if (choice === '0' || choice === '') {
        rl.close();
        const meal = detectMeal();
        console.log(`\n✅ Using default settings — ${config.DEFAULT_MESS} ${meal.charAt(0).toUpperCase() + meal.slice(1)} @ ₹${config.DEFAULT_PRICE}\n`);
        return {
            ENABLE_NEGOTIATION: config.ENABLE_NEGOTIATION,
            PAYMENT_VERIFICATION_ENABLED: config.PAYMENT_VERIFICATION_ENABLED,
            DEFAULT_PRICE: config.DEFAULT_PRICE,
            _meal: meal,
            _mess: config.DEFAULT_MESS,
            _numMessages: config.DEFAULT_NUM_MESSAGES,
        };
    }

    // ─── Custom settings ────────────────────────────────────────
    console.log('\n📝 Custom settings (press Enter to use default)\n');

    // 1. Negotiation
    const negoInput = await ask(rl, `  Enable negotiation? [0=No / 1=Yes] (default: 0): `);
    const enableNegotiation = negoInput === '1';

    // 2. Payment verification
    const paymentVerifyDefault = config.PAYMENT_VERIFICATION_ENABLED ? '1' : '0';
    const paymentVerifyInput = await ask(
        rl,
        `  Enable payment verification? [0=No / 1=Yes] (default: ${paymentVerifyDefault}): `
    );
    const enablePaymentVerification = paymentVerifyInput === ''
        ? config.PAYMENT_VERIFICATION_ENABLED
        : paymentVerifyInput === '1';

    // 3. Starting price
    const priceInput = await ask(rl, `  Starting price? (default: ${config.DEFAULT_PRICE}): `);
    const price = priceInput ? parseInt(priceInput, 10) : config.DEFAULT_PRICE;

    // 4. Meal type
    const detectedMeal = detectMeal();
    const mealInput = await ask(
        rl,
        `  Meal type? [breakfast/lunch/dinner] (default: ${detectedMeal}): `
    );
    const meal = ['breakfast', 'lunch', 'dinner'].includes(mealInput.toLowerCase())
        ? mealInput.toLowerCase()
        : detectedMeal;

    // 5. Mess name
    const messOptions = config.MESS_NAMES.join(' / ');
    const messInput = await ask(rl, `  Mess name? [${messOptions}] (default: ${config.DEFAULT_MESS}): `);
    const mess = config.MESS_NAMES.find(
        (m) => m.toLowerCase() === (messInput || '').toLowerCase()
    ) || config.DEFAULT_MESS;

    // 6. Number of messages
    const numInput = await ask(rl, `  Number of messages to send? (default: ${config.DEFAULT_NUM_MESSAGES}): `);
    const numMessages = numInput ? parseInt(numInput, 10) : config.DEFAULT_NUM_MESSAGES;

    rl.close();

    console.log(`
──────────────────────────────────────
  ✅ Custom settings applied          
──────────────────────────────────────
  Negotiation : ${enableNegotiation ? 'Yes' : 'No'}${' '.repeat(21 - (enableNegotiation ? 3 : 2))}
  Verify Pay  : ${enablePaymentVerification ? 'Yes' : 'No'}${' '.repeat(21 - (enablePaymentVerification ? 3 : 2))}
  Price       : ₹${price}${' '.repeat(20 - String(price).length)}
  Meal        : ${meal.charAt(0).toUpperCase() + meal.slice(1)}${' '.repeat(22 - meal.length)}
  Mess        : ${mess}${' '.repeat(22 - mess.length)}
  Messages    : ${numMessages}${' '.repeat(22 - String(numMessages).length)}
──────────────────────────────────────
`);

    return {
        ENABLE_NEGOTIATION: enableNegotiation,
        PAYMENT_VERIFICATION_ENABLED: enablePaymentVerification,
        DEFAULT_PRICE: price,
        _meal: meal,
        _mess: mess,
        _numMessages: numMessages,
    };
}

module.exports = { showMenu };
