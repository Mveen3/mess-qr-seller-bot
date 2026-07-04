'use strict';

const { extractPrice } = require('./priceParser');
const config = require('./config');

let globalClient = null;
let targetGroups = [];
let targetMess = '';
let baseMaxPrice = 40;
let targetMeal = '';

let isBought = false;
let contactedSellers = new Set(); 
let priorityQueue = []; 
let activeTransaction = null; 

const sleep = ms => new Promise(res => setTimeout(res, ms));

function getISTTime() {
    return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
}

function getMins(timeStr) {
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + m;
}

function detectTargetMealAndScanTime() {
    const now = getISTTime();
    const nowMins = now.getHours() * 60 + now.getMinutes();

    let scanStartMins = 0;
    let target = 'breakfast';
    let mealStartMins = getMins(config.MEAL_TIMINGS.breakfast.start);

    const bEnd = getMins(config.MEAL_TIMINGS.breakfast.end) + 30;
    const lEnd = getMins(config.MEAL_TIMINGS.lunch.end) + 30;
    const dEnd = getMins(config.MEAL_TIMINGS.dinner.end) + 30;

    if (nowMins < bEnd) {
        target = 'breakfast';
        mealStartMins = getMins(config.MEAL_TIMINGS.breakfast.start);
        scanStartMins = 0; 
    } else if (nowMins < lEnd) {
        target = 'lunch';
        mealStartMins = getMins(config.MEAL_TIMINGS.lunch.start);
        scanStartMins = bEnd;
    } else if (nowMins < dEnd) {
        target = 'dinner';
        mealStartMins = getMins(config.MEAL_TIMINGS.dinner.start);
        scanStartMins = lEnd;
    } else {
        target = 'breakfast'; 
        mealStartMins = getMins(config.MEAL_TIMINGS.breakfast.start);
        scanStartMins = dEnd; 
    }

    const scanDate = new Date(now);
    scanDate.setHours(Math.floor(scanStartMins / 60), scanStartMins % 60, 0, 0);

    return { target, mealStartMins, scanStartTime: Math.floor(scanDate.getTime() / 1000) };
}

function getCurrentMaxPrice(mealStartMins) {
    const now = getISTTime();
    const nowMins = now.getHours() * 60 + now.getMinutes();
    
    if (nowMins < mealStartMins) return baseMaxPrice;
    
    const elapsedMins = nowMins - mealStartMins;
    const dropCount = Math.floor(elapsedMins / 30);
    return Math.max(0, baseMaxPrice - (dropCount * 5));
}

async function startBuying(client, chats, mess, price) {
    globalClient = client;
    targetGroups = chats;
    targetMess = mess.toLowerCase();
    baseMaxPrice = price;
    isBought = false;
    contactedSellers.clear();
    priorityQueue = [];
    activeTransaction = null;
    
    const { target, mealStartMins, scanStartTime } = detectTargetMealAndScanTime();
    targetMeal = target;
    const currentMaxPrice = getCurrentMaxPrice(mealStartMins);
    
    console.log(`\n🛒 [Buyer] Target Meal: ${targetMeal.toUpperCase()}`);
    console.log(`🛒 [Buyer] Searching for "${mess}" across ${chats.length} groups.`);
    console.log(`🛒 [Buyer] Base Max Price: ₹${baseMaxPrice} | Current Max Price: ₹${currentMaxPrice}`);
    console.log(`🛒 [Buyer] Scanning messages from ${new Date(scanStartTime * 1000).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}...`);

    for (const chat of targetGroups) {
        try {
            console.log(`🛒 [Buyer] Scanning old messages in ${chat.name}...`);
            const messages = await chat.fetchMessages({ limit: 100 });
            
            // Sort newest to oldest
            messages.sort((a, b) => b.timestamp - a.timestamp);
            
            for (const msg of messages) {
                if (isBought) break;
                if (msg.timestamp < scanStartTime) continue;
                
                await processGroupMessage(msg, currentMaxPrice);
                await sleep(500); 
            }
        } catch (err) {
            console.error(`❌ [Buyer] Error scanning ${chat.name}:`, err.message);
        }
    }
    
    console.log(`\n🛒 [Buyer] Old message scan complete. Listening for new messages...\n`);
}

async function hasTickReaction(msg) {
    try {
        if (!msg.hasReaction) return false;
        if (typeof msg.getReactions !== 'function') return true; 
        
        const reactions = await msg.getReactions();
        return reactions.some(r => r.aggregateEmoji === '✅' || r.id === '✅');
    } catch (err) {
        return false;
    }
}

async function processGroupMessage(msg, currentMaxPrice) {
    if (isBought || msg.fromMe) return;
    
    const text = (msg.body || '').toLowerCase();
    
    if (!text.includes('sell') || !text.includes(targetMess)) {
        return;
    }
    
    const isTicked = await hasTickReaction(msg);
    if (isTicked) return;
    
    const senderId = msg.author || msg.from; 
    if (!senderId || contactedSellers.has(senderId)) return;
    
    const price = extractPrice(text);
    if (price !== null && price > currentMaxPrice) return;
    
    try {
        const contact = await globalClient.getContactById(senderId);
        const dmChat = await contact.getChat();
        
        if (price !== null && price <= currentMaxPrice) {
            await dmChat.sendMessage('Still available?');
            console.log(`📩 [Buyer] DM'd ${contact.name || senderId}: Still available? (Price was ₹${price})`);
        } else {
            await dmChat.sendMessage('How much?');
            console.log(`📩 [Buyer] DM'd ${contact.name || senderId}: How much?`);
        }
        
        contactedSellers.add(senderId);
    } catch (err) {
        console.error(`❌ [Buyer] Failed to DM ${senderId}:`, err.message);
    }
}

async function processQueue() {
    if (isBought || activeTransaction !== null || priorityQueue.length === 0) return;

    // Sort queue: lowest price first, then earliest time
    priorityQueue.sort((a, b) => {
        if (a.price !== b.price) return a.price - b.price;
        return a.time - b.time;
    });

    const bestSeller = priorityQueue.shift();
    
    activeTransaction = {
        id: bestSeller.id,
        chat: bestSeller.chat,
        timer: null
    };

    console.log(`\n🎯 [Buyer] Processing seller ${bestSeller.id} (Price: ₹${bestSeller.price})`);
    
    try {
        await bestSeller.chat.sendMessage("This transaction is handled by an automated system. Please send the QR. I will send you the payment as soon as I see this chat. Thanks.");
        await sleep(1000);
        await bestSeller.chat.sendMessage("If you are not trusting the bot and are not sending the QR please reply the keyword - 'Trust issue' so that bot can bought the QR from someone else.");
        
        activeTransaction.timer = setTimeout(async () => {
            if (activeTransaction && activeTransaction.id === bestSeller.id && !isBought) {
                console.log(`⏳ [Buyer] Seller ${bestSeller.id} timed out (60s).`);
                try {
                    await bestSeller.chat.sendMessage("Moved on to next person.");
                } catch (e) {}
                activeTransaction = null;
                processQueue();
            }
        }, 60000);
    } catch (err) {
        console.error(`❌ [Buyer] Failed to message seller ${bestSeller.id}:`, err.message);
        activeTransaction = null;
        processQueue();
    }
}

async function handleMessage(msg) {
    if (msg.fromMe) return;
    const chat = await msg.getChat();
    const senderId = msg.author || msg.from;
    
    if (chat.isGroup) {
        if (!isBought && targetGroups.some(g => g.id._serialized === chat.id._serialized)) {
            const { mealStartMins } = detectTargetMealAndScanTime();
            const currentMaxPrice = getCurrentMaxPrice(mealStartMins);
            await processGroupMessage(msg, currentMaxPrice);
        }
        return;
    }
    
    const text = (msg.body || '').toLowerCase();
    const price = extractPrice(text);
    const isYes = text.includes('yes') || text.includes('available') || text.includes('haan');
    const { mealStartMins } = detectTargetMealAndScanTime();
    const currentMaxPrice = getCurrentMaxPrice(mealStartMins);
    const isGoodPrice = price !== null && price <= currentMaxPrice;
    
    if (isBought) {
        if (contactedSellers.has(senderId)) {
            if (msg.hasMedia || isYes || isGoodPrice) {
                await chat.sendMessage("Sorry bought from someone");
            }
        }
        return;
    }
    
    if (activeTransaction && activeTransaction.id === senderId) {
        if (msg.hasMedia) {
            console.log(`🎉 [Buyer] Received QR from ${senderId}! Marking as bought.`);
            clearTimeout(activeTransaction.timer);
            isBought = true;
            
            try {
                await chat.pin();
                console.log(`📌 [Buyer] Pinned chat with ${senderId}.`);
            } catch (err) {
                console.error(`❌ [Buyer] Failed to pin chat:`, err.message);
            }
            
            for (const other of priorityQueue) {
                try {
                    await other.chat.sendMessage("Sorry bought from someone");
                } catch (err) {}
            }
            priorityQueue = [];
            activeTransaction = null;
        } else if (text.includes('trust issue')) {
            console.log(`🛑 [Buyer] Seller ${senderId} reported trust issue.`);
            clearTimeout(activeTransaction.timer);
            try {
                await chat.sendMessage("Thanks.");
            } catch (err) {}
            activeTransaction = null;
            processQueue();
        }
        return;
    }
    
    if (contactedSellers.has(senderId)) {
        if (isYes || isGoodPrice) {
            const finalPrice = isGoodPrice ? price : currentMaxPrice; 
            
            const existing = priorityQueue.find(p => p.id === senderId);
            if (!existing) {
                priorityQueue.push({
                    id: senderId,
                    price: finalPrice,
                    time: Date.now(),
                    chat: chat
                });
                console.log(`🛒 [Buyer] Seller ${senderId} added to priority queue (Price: ₹${finalPrice}).`);
                processQueue();
            }
        }
    }
}

module.exports = { startBuying, handleMessage };
