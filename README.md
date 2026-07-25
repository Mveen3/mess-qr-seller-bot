# Mess QR Selling Bot

WhatsApp automation bot for selling mess QR slots with scheduled price drops, DM buyer handling, and queue management.

## Features

1. Scheduled group posts for breakfast/lunch/dinner windows.
2. Dynamic price drops across configured message slots.
3. Buyer intent detection from DM keywords.
4. Buyer queue with inactivity timeout and warning message.
5. Optional negotiation mode with configurable margin.
6. Auto-complete sale on WhatsApp Pay signal, payment screenshot, or `DONE` keyword.
7. ✅ reactions on group sell messages when sold; removed on `CURIOUS` revert.
8. QR delivery + sale confirmation + report after successful sale.
9. `CURIOUS` revert for the actual buyer to mark the QR unsold and restart scheduler.

## How It Works

1. Bot sends sell messages in the target group at scheduled intervals with dropping prices.
2. When a buyer DMs a keyword like "buy", "want", etc., the bot assigns them and sends UPI/phone details.
3. Sale completes automatically when the buyer:
   - Sends payment via **WhatsApp Pay** (detected instantly).
   - Sends a **photo/screenshot** (assumed payment proof).
   - Replies with **DONE** or any payment confirmation keyword.
4. On sale completion, the bot sends the QR image, confirms the sale, and adds ✅ reactions to group sell messages.
5. If the buyer replies with **CURIOUS**, the sale is reverted, ✅ reactions are removed, and the scheduler restarts.

## Project Structure

- `main.js`: Client bootstrap, auth lifecycle, scheduler startup, message routing.
- `Setting.txt`: All runtime configuration (the single source of truth).
- `utils/config.js`: Reads and parses `Setting.txt`, exposes settings and message template functions.
- `utils/menu.js`: Interactive CLI setup prompts (price, meal, mess, negotiation, message count).
- `utils/priceScheduler.js`: Timed posting and auto-stop logic.
- `utils/messageHandler.js`: DM flow, buyer queueing, sale completion, reaction management.
- `utils/keywordMatcher.js`: Buyer/done intent matching.
- `utils/priceParser.js`: Price extraction from negotiation messages.
- `utils/`: Directory where the bot automatically looks for your QR image (any `.png`, `.jpg`, `.jpeg`).

## Setup

1. Install Node.js 18 or newer.
2. Install dependencies:

```bash
npm install
```

3. Drop your QR image (any `.png`, `.jpg`, `.jpeg`) into the `utils/` folder. The bot will automatically find it!.
4. Update key values in `Setting.txt`: `GROUP_NAME`, `UPI_ID`, `PHONE_NUMBER`, `MESS_NAMES`, `DEFAULT_PRICE`.

## Run

```bash
node main.js
```

At startup:

1. Configure settings (price, negotiation, meal, mess, number of messages).
2. On first login, scan the WhatsApp QR in terminal.
3. Bot loads groups, starts scheduler, and listens to DMs.

## Important Config Flags

- `BUYER_INACTIVITY_MS=90000` — Time before moving to the next buyer.
- `BUYER_TIMEOUT_WARNING_MS=30000` — Warning sent before timeout.
- `ENABLE_NEGOTIATION=true|false` — Allow price negotiation via DM.
- `NEGOTIATION_MARGIN=5` — Max discount below current price.
- `PRICE_DROP=5` — Price drop between scheduled messages.

## Stop

Press `Ctrl+C` to stop gracefully.
