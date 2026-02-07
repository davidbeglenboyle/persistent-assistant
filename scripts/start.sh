#!/bin/bash
# persistent-assistant — startup wrapper
# Loads credentials from .env file, macOS Keychain, or environment variables

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# 1. Load .env file if present
if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  source "$PROJECT_DIR/.env"
  set +a
fi

# 2. Try macOS Keychain if env vars not already set
if [ -z "$TELEGRAM_BOT_TOKEN" ] && command -v security &>/dev/null; then
  TELEGRAM_BOT_TOKEN=$(security find-generic-password -s "TELEGRAM_BOT_TOKEN" -w 2>/dev/null)
  TELEGRAM_CHAT_ID=$(security find-generic-password -s "TELEGRAM_CHAT_ID" -w 2>/dev/null)
fi

# 3. Validate
if [ -z "$TELEGRAM_BOT_TOKEN" ]; then
  echo "Error: TELEGRAM_BOT_TOKEN not set"
  echo ""
  echo "Three ways to provide credentials:"
  echo "  1. Copy .env.example to .env and fill in values"
  echo "  2. Export environment variables before running this script"
  echo "  3. macOS: store in Keychain with:"
  echo "     security add-generic-password -s TELEGRAM_BOT_TOKEN -a persistent-assistant -w YOUR_TOKEN"
  exit 1
fi

if [ -z "$TELEGRAM_CHAT_ID" ]; then
  echo "Error: TELEGRAM_CHAT_ID not set"
  echo ""
  echo "To find your chat ID, message @userinfobot on Telegram."
  exit 1
fi

export TELEGRAM_BOT_TOKEN
export TELEGRAM_CHAT_ID

cd "$PROJECT_DIR" || exit 1
exec npx tsx src/index.ts
