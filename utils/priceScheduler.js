'use strict';

const config = require('./config');

let timers = [];
let currentPrice = null;
let stopped = false;

// Store arguments for restart
let storedSendMessageFn = null;
let storedOnStopFn = null;
let storedIsSoldFn = null;
let storedOpts = null;

let testingStartDate = null;

/**
 * Compute equally-spaced send times between meal start and end.
 * @param {string} meal — 'breakfast', 'lunch', or 'dinner'
 * @param {number} numMessages — how many messages to schedule
 * @returns {{ times: Date[], stopTime: Date }}
 */
function computeSchedule(meal, numMessages) {
    const timing = config.MEAL_TIMINGS[meal];
    if (!timing) throw new Error(`Unknown meal type: ${meal}`);
    const safeNumMessages = Number.isFinite(numMessages) ? Math.max(1, Math.floor(numMessages)) : 1;

    const today = new Date();

    const startDate = new Date(today);
    const endDate = new Date(today);

    if (config.TESTING) {
        // In testing mode, start 60 seconds from now so the first message isn't skipped.
        // We preserve this start time globally so that if the scheduler restarts (e.g. buyer says "curious"),
        // the testing timeline isn't completely reset, allowing it to accurately resume the current price.
        if (!testingStartDate) {
            testingStartDate = new Date(today.getTime() + 60 * 1000);
        }
        console.log('🧪 [Scheduler] TESTING mode is ON — bypassing meal timing.');
        startDate.setTime(testingStartDate.getTime());
        endDate.setTime(testingStartDate.getTime() + safeNumMessages * 30 * 1000);
    } else {
        const [startH, startM] = timing.start.split(':').map(Number);
        const [endH, endM] = timing.end.split(':').map(Number);

        startDate.setHours(startH, startM, 0, 0);
        endDate.setHours(endH, endM, 0, 0);

        // If the meal window already ended today, schedule for tomorrow
        if (endDate.getTime() < Date.now()) {
            startDate.setDate(startDate.getDate() + 1);
            endDate.setDate(endDate.getDate() + 1);
        }
    }
    const totalMs = endDate.getTime() - startDate.getTime();
    const intervalMs = safeNumMessages > 1 ? totalMs / safeNumMessages : totalMs;

    const times = [];
    for (let i = 0; i < safeNumMessages; i++) {
        times.push(new Date(startDate.getTime() + i * intervalMs));
    }

    return { times, stopTime: endDate };
}

/**
 * Start the dynamic scheduler.
 * @param {Function} sendMessageFn — async (text) => {}
 * @param {Function} onStopFn — called when auto-stop fires
 * @param {Function} isSoldFn — () => boolean
 * @param {object}   opts — { meal, mess, numMessages }
 */
function startScheduler(sendMessageFn, onStopFn, isSoldFn, opts) {
    stopped = false;
    currentPrice = Number.isFinite(config.DEFAULT_PRICE) && config.DEFAULT_PRICE > 0 ? config.DEFAULT_PRICE : 1;

    const meal = config.MEAL_TIMINGS[opts?.meal] ? opts.meal : config.DEFAULT_MEAL;
    const mess = typeof opts?.mess === 'string' && opts.mess.trim() ? opts.mess.trim() : config.DEFAULT_MESS;
    const numMessages = Number.isFinite(opts?.numMessages)
        ? Math.max(1, Math.floor(opts.numMessages))
        : Math.max(1, Math.floor(config.DEFAULT_NUM_MESSAGES));
    const normalizedOpts = { meal, mess, numMessages };

    // Save for a potential restart
    storedSendMessageFn = sendMessageFn;
    storedOnStopFn = onStopFn;
    storedIsSoldFn = isSoldFn;
    storedOpts = normalizedOpts;

    const { times, stopTime } = computeSchedule(meal, numMessages);
    const now = Date.now();

    console.log(`💰 [Scheduler] Starting price: ₹${currentPrice}`);
    console.log(`📅 [Scheduler] Meal: ${meal} | Mess: ${mess} | Messages: ${numMessages}`);
    console.log(`📅 [Scheduler] Schedule:`);

    let priceForStep = currentPrice;
    const priceDrop = Number.isFinite(config.PRICE_DROP) && config.PRICE_DROP > 0 ? config.PRICE_DROP : 0;

    for (let i = 0; i < times.length; i++) {
        const sendTime = times[i];
        const delayMs = sendTime.getTime() - now;
        const price = priceForStep;

        const timeStr = sendTime.toLocaleTimeString('en-IN', {
            hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata',
        });
        console.log(`   ⏰ ${timeStr} — ₹${price}`);

        if (delayMs > 0) {
            const timer = setTimeout(async () => {
                try {
                    if (stopped || isSoldFn()) {
                        console.log(`⏭️  [Scheduler] Skipping ₹${price} — already ${isSoldFn() ? 'sold' : 'stopped'}`);
                        return;
                    }
                    currentPrice = price;
                    const text = config.sellMessage(mess, meal, price);
                    console.log(`📤 [Scheduler] Sending: "${text}"`);
                    await sendMessageFn(text);
                } catch (err) {
                    console.error('❌ [Scheduler] Error sending price message:', err.message);
                }
            }, delayMs);

            timers.push(timer);
        } else {
            // Time already passed — skip this slot
            console.log(`   ⏭️  (skipped — time already passed)`);
            // Update the current price so that buyers messaging *now* get the correct active price
            currentPrice = price;
        }

        priceForStep = Math.max(priceForStep - priceDrop, 0);
    }

    // Auto-stop timer
    const stopDelay = stopTime.getTime() - now;
    if (stopDelay > 0) {
        const stopTimer = setTimeout(async () => {
            try {
                if (stopped || isSoldFn()) return;
                console.log('🛑 [Scheduler] Stop time reached — shutting down.');
                stopScheduler();
                if (onStopFn) await onStopFn();
            } catch (err) {
                console.error('❌ [Scheduler] Error in stop handler:', err.message);
            }
        }, stopDelay);
        timers.push(stopTimer);

        const stopStr = stopTime.toLocaleTimeString('en-IN', {
            hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata',
        });
        console.log(`   🛑 Auto-stop at ${stopStr}`);
    }

    console.log('📅 [Scheduler] All timers registered.\n');
}

function stopScheduler() {
    stopped = true;
    for (const t of timers) {
        clearTimeout(t);
    }
    timers = [];
    console.log('🛑 [Scheduler] All timers stopped.');
}

function getCurrentPrice() { return currentPrice; }
function setCurrentPrice(price) { currentPrice = price; }
function getCurrentMeal() { return storedOpts ? storedOpts.meal : config.DEFAULT_MEAL; }

function restartScheduler() {
    console.log('🔄 [Scheduler] Restarting scheduler after un-sale...');
    stopScheduler();
    if (storedSendMessageFn && storedOpts) {
        startScheduler(storedSendMessageFn, storedOnStopFn, storedIsSoldFn, storedOpts);
    }
}

module.exports = { startScheduler, stopScheduler, getCurrentPrice, setCurrentPrice, getCurrentMeal, restartScheduler };
