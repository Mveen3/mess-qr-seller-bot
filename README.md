# 🍽️ Mess QR Seller Bot

## The Problem

At IIIT Hyderabad, mess charges are deducted for all 30 days — whether you eat or not. You can cancel only **5 meals per month**. For students like me who'd never wake up at 7:30 AM, that means paying ₹1300+ for breakfasts we'll never touch.

So I built a system. Students who *do* go to the mess cancel their 5 days and buy their QR codes from students like me through a WhatsApp group — **"Mess Buy Sell @ IIITH"**. They pay ₹15–30 instead of ₹44. I earn money from a meal that otherwise I won't eat anyway. **Win-win.**

But there was still one catch — **I had to wake up at 7:30 AM to post the sell message.** The very thing I was trying to avoid.

So I automated it.

## What This Bot Does

This bot runs 24/7, and each morning (or lunch/dinner) it:

1. 📢 Posts a sell message in the group at scheduled times with auto price drops
2. 🤖 Detects buyers who DM you with keywords like *"buy"*, *"want"*, *"available"*
3. 💳 Sends your UPI ID + payment instructions automatically
4. ✅ Delivers the QR image after the buyer confirms payment
5. 🛑 Stops accepting buyers once the sale is complete

No more alarms. No more missed breakfasts. Just set it up once and sleep in peace.

---

## Setup

1. Install [Node.js](https://nodejs.org/) (v16+)
2. Open terminal in this folder:
   ```
   npm install
   ```
3. Put your **UPI QR image** as `utils/qr.png`

## Configuration

Open `utils/settings.js` and update:

| Field | What to change |
|-------|---------------|
| `UPI_ID` | Your UPI ID |
| `PHONE_NUMBER` | Your phone number |
| `GROUP_NAME` | Your WhatsApp group name |
| `MESS_NAMES` | Available mess options |
| `DEFAULT_PRICE` | Starting price |

## Run

```
node main.js
```

- **First time** — scan the QR shown in terminal with WhatsApp
- **After that** — auto-logs in, no QR needed

## Stop

Press `Ctrl+C` in the terminal.

---

## 🤖 LLM Declaration

The concept, approach, and system design are entirely my own. The code was written with the LLM.