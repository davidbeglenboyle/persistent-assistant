import { createBot } from "./bot";
import { getOrCreateSession } from "./session";

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatId = process.env.TELEGRAM_CHAT_ID;

if (!token) {
  console.error("TELEGRAM_BOT_TOKEN not set");
  process.exit(1);
}

if (!chatId) {
  console.error("TELEGRAM_CHAT_ID not set");
  process.exit(1);
}

const session = getOrCreateSession();
console.log(`Telegram-Claude Bridge starting...`);
console.log(`Session: ${session.sessionId}`);
console.log(`Messages so far: ${session.messageCount}`);
console.log(`Allowed chat ID: ${chatId}`);
console.log();

const bot = createBot(token, Number(chatId));

// Catch middleware errors so grammy doesn't stop the bot and throw
bot.catch((err) => {
  console.error(`Error handling update ${err.ctx?.update?.update_id}:`, err.error);
});

bot.start({
  onStart: (botInfo) => {
    console.log(`Bot @${botInfo.username} is running. Send messages via Telegram.`);
  },
}).catch((err) => {
  console.error("Bot polling fatal error:", err);
  process.exit(1);
});

// Safety net — log unhandled rejections but don't crash
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down...");
  bot.stop();
  process.exit(0);
});

process.on("SIGTERM", () => {
  bot.stop();
  process.exit(0);
});
