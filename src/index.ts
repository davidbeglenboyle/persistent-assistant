import { createBot } from "./bot";
import { getAllSessions } from "./session";

const token = process.env.TELEGRAM_BOT_TOKEN;
const chatIdEnv = process.env.TELEGRAM_CHAT_ID;

// Mode: "dm" for direct messages (backward compatible), "group" for forum topics
const mode = (process.env.BRIDGE_MODE || "dm") as "dm" | "group";

if (!token) {
  console.error("TELEGRAM_BOT_TOKEN not set");
  process.exit(1);
}

if (!chatIdEnv) {
  console.error("TELEGRAM_CHAT_ID not set");
  process.exit(1);
}

// Support multiple chat IDs (comma-separated) for group mode
// e.g. "12345,-100987654" allows both a DM and a group
const allowedChatIds = chatIdEnv.split(",").map((id) => Number(id.trim()));

const sessions = getAllSessions();
console.log(`Telegram-Claude Bridge starting (${mode} mode)...`);
console.log(`Active sessions: ${sessions.length}`);
for (const { topicId, state } of sessions) {
  const label = topicId === "general" ? "General" : `Topic ${topicId}`;
  console.log(`  ${label}: ${state.sessionId.slice(0, 8)}... (${state.messageCount} msgs)`);
}
console.log(`Allowed chat IDs: ${allowedChatIds.join(", ")}`);
console.log();

const bot = createBot(token, allowedChatIds, mode);

// Catch middleware errors so grammy doesn't stop the bot and throw
bot.catch((err) => {
  console.error(`Error handling update ${err.ctx?.update?.update_id}:`, err.error);
});

bot.start({
  onStart: (botInfo) => {
    console.log(`Bot @${botInfo.username} is running (${mode} mode). Send messages via Telegram.`);
  },
}).catch((err) => {
  console.error("Bot polling fatal error:", err);
  process.exit(1); // Exit so launchd/systemd restarts
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
