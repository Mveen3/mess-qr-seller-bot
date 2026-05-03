# Mess QR Selling Bot

WhatsApp automation bot for selling mess QR slots with scheduled price drops, DM buyer handling, queue management, and optional SBI balance-based payment verification.

## Features

1. Scheduled group posts for breakfast/lunch/dinner windows.
2. Dynamic price drops across configured message slots.
3. Buyer intent detection from DM keywords.
4. Buyer queue with inactivity timeout and warning message.
5. Optional negotiation mode with configurable margin.
6. Optional payment verification through SBI WhatsApp Banking balance checks.
7. Screenshot fallback flow if auto-verification is delayed.
8. QR delivery + sale confirmation + report after successful sale.
9. `TESTING` revert for the actual buyer to mark the QR unsold and restart scheduler.

## How Payment Verification Works

When verification is enabled:

1. Bot asks SBI WhatsApp Banking for balance using `SBI_BALANCE_COMMAND`.
2. Bot parses messages like `Available Balance in A/c ... Rs. *1474.13 CR*` (multiline and formatted text supported).
3. Verification uses balance increase (`latestBalance - knownBalance`) to detect credited payment.
4. If credited amount is below expected price, buyer is asked to pay the remaining amount.
5. If no credit is detected, buyer is asked to retry with `DONE` or share screenshot.
6. If buyer shares screenshot after insufficient/no-credit prompt, payment can be accepted.

Verified and partial attempts are written to `PAYMENT_VERIFICATION_LOG_PATH`.

## Project Structure

- `main.js`: client bootstrap, auth lifecycle, scheduler startup.
- `Setting.txt`: user-editable runtime configuration.
- `utils/config.js`: settings parser + defaults + message templates.
- `utils/priceScheduler.js`: timed posting and auto-stop logic.
- `utils/messageHandler.js`: DM flow, queueing, payment verification, sale completion.
- `utils/keywordMatcher.js`: buyer/done intent matching.
- `utils/priceParser.js`: negotiation number extraction.

## Setup

1. Install Node.js 16 or newer.
2. Install dependencies:

```bash
npm install
```

3. Put your QR image at `utils/qr.png` (or change `QR_IMAGE_PATH` in `Setting.txt`).
4. Update key values in `Setting.txt`: `GROUP_NAME`, `UPI_ID`, `PHONE_NUMBER`, `MESS_NAMES`, `DEFAULT_PRICE`, and `SBI_BANKING_CHAT_ID` (if verification is enabled).

## Run

```bash
node main.js
```

At startup:

1. Choose default mode (`0`) or custom mode (`1`).
2. On first login, scan the WhatsApp QR in terminal.
3. Bot loads group, starts scheduler, and listens to DMs.

## Important Config Flags

- `PAYMENT_VERIFICATION_ENABLED=true|false`
- `PAYMENT_VERIFICATION_TIMEOUT_MS=45000`
- `BUYER_INACTIVITY_MS=90000`
- `BUYER_TIMEOUT_WARNING_MS=30000`
- `ENABLE_NEGOTIATION=true|false`
- `NEGOTIATION_MARGIN=5`

## Stop

Press `Ctrl+C` to stop gracefully.
