'use strict';

const config = require('./settings');

let timers = [];
let currentPrice = null;
let stopped = false;

/**
 * Compute equally-spaced send times between meal start and end.
 * @param {string} meal — 'breakfast', 'lunch', or 'dinner'
 * @param {number} numMessages — how many messages to schedule
 * @returns {{ times: Date[], stopTime: Date }}
 */
function computeSchedule(meal, numMessages) {
    const timing = config.MEAL_TIMINGS[meal];
    if (!timing) throw new Error(`Unknown meal type: ${meal}`);

    const today = new Date();

    const [startH, startM] = timing.start.split(':').map(Number);
    const [endH, endM] = timing.end.split(':').map(Number);

    const startDate = new Date(today);
    startDate.setHours(startH, startM, 0, 0);

    const endDate = new Date(today);
    endDate.setHours(endH, endM, 0, 0);

    // If the meal window already ended today, schedule for tomorrow
    if (endDate.getTime() < Date.now()) {
        startDate.setDate(startDate.getDate() + 1);
        endDate.setDate(endDate.getDate() + 1);
    }
    const totalMs = endDate.getTime() - startDate.getTime();
    const intervalMs = numMessages > 1 ? totalMs / numMessages : totalMs;

    const times = [];
    for (let i = 0; i < numMessages; i++) {
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
    currentPrice = config.DEFAULT_PRICE;

    const { meal, mess, numMessages } = opts;
    const { times, stopTime } = computeSchedule(meal, numMessages);
    const now = Date.now();

    console.log(`💰 [Scheduler] Starting price: ₹${currentPrice}`);
    console.log(`📅 [Scheduler] Meal: ${meal} | Mess: ${mess} | Messages: ${numMessages}`);
    console.log(`📅 [Scheduler] Schedule:`);

    let priceForStep = config.DEFAULT_PRICE;

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
            // Don't update currentPrice — it stays at DEFAULT_PRICE
        }

        priceForStep = Math.max(priceForStep - config.PRICE_DROP, 0);
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

module.exports = { startScheduler, stopScheduler, getCurrentPrice, setCurrentPrice };
