import { createBot } from "./bot";
import { getAllSessions } from "./session";
import { queueLength } from "./queue";
import { execFileSync } from "child_process";

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
  console.log(`  ${label}: ${state.sessionId?.slice(0, 8) ?? '???'}... (${state.messageCount ?? 0} msgs)`);
}
console.log(`Allowed chat IDs: ${allowedChatIds.join(", ")}`);
console.log();

// Health check: verify Claude CLI is reachable
try {
  const claudeBin = process.env.CLAUDE_PATH || "claude";
  const version = execFileSync(claudeBin, ["--version"], {
    timeout: 10_000,
    encoding: "utf-8",
  }).trim();
  console.log(`Claude CLI: ${version}`);
} catch {
  console.warn("Warning: could not run 'claude --version'. Check CLAUDE_PATH or install Claude Code CLI.");
}

const bot = createBot(token, allowedChatIds, mode);

// Catch middleware errors so grammy doesn't stop the bot and throw
bot.catch((err) => {
  console.error(`Error handling update ${err.ctx?.update?.update_id}:`, err.error);
});

// 409 retry constants — Telegram rejects polling if a previous connection lingers
const MAX_409_RETRIES = 5;
const RETRY_DELAY_MS = 35_000;
const INITIAL_DELAY_MS = 35_000;

const startTime = Date.now();

async function startWithRetry(): Promise<void> {
  // Initial delay to let any previous instance's Telegram connection expire
  console.log(`Waiting ${INITIAL_DELAY_MS / 1000}s before starting polling...`);
  await new Promise((r) => setTimeout(r, INITIAL_DELAY_MS));

  // Drop any leftover webhook so long-polling works cleanly
  await bot.api.deleteWebhook({ drop_pending_updates: false });

  for (let attempt = 1; attempt <= MAX_409_RETRIES; attempt++) {
    try {
      await bot.start({
        onStart: (botInfo) => {
          console.log(`Bot @${botInfo.username} is running (${mode} mode). Send messages via Telegram.`);
        },
      });
      return; // bot.start() resolved normally (e.g. bot.stop() called)
    } catch (err: unknown) {
      const is409 =
        err instanceof Error && (err.message.includes("409") || err.message.includes("Conflict"));
      if (is409 && attempt < MAX_409_RETRIES) {
        console.warn(`409 Conflict on attempt ${attempt}/${MAX_409_RETRIES}. Retrying in ${RETRY_DELAY_MS / 1000}s...`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      } else {
        console.error("Bot polling fatal error:", err);
        process.exit(1);
      }
    }
  }
}

startWithRetry();

// Heartbeat: log uptime and queue depth every 30 minutes
setInterval(() => {
  const uptimeMin = Math.round((Date.now() - startTime) / 60_000);
  const depth = queueLength();
  console.log(`[heartbeat] uptime=${uptimeMin}m queue=${depth}`);
}, 30 * 60_000);

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
