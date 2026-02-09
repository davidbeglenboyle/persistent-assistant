/**
 * Email-Claude Bridge — main entrypoint.
 *
 * Polls Gmail for unread emails with a configurable keyword in the subject.
 * Spawns Claude Code per email, replies in the same thread.
 *
 * Environment variables:
 *   GMAIL_ALLOWED_SENDER  — email address allowed to trigger the bridge (required)
 *   GMAIL_KEYWORD         — subject prefix to match (default: "CLAUDE")
 *   GMAIL_POLL_INTERVAL   — seconds between polls (default: 60)
 *   GMAIL_SESSION_FILE    — path to session state file (default: ~/.claude-email-session)
 *   GMAIL_CONFIG_DIR      — path to OAuth credentials (default: ~/.config/gmail-bridge)
 *
 * Start with: npm run email
 */

import {
  pollForEmails,
  markAsRead,
  replyToThread,
  extractPrompt,
  isAllowedSender,
  getAuth,
} from "./gmail";
import { runClaude } from "./claude";
import { enqueue } from "./queue";
import { logExchange } from "./logger";

import * as fs from "fs";
import * as crypto from "crypto";
import * as path from "path";
import * as os from "os";

// --- Configuration from environment ---

const ALLOWED_SENDER = process.env.GMAIL_ALLOWED_SENDER;
if (!ALLOWED_SENDER) {
  console.error("GMAIL_ALLOWED_SENDER not set");
  console.error("Set this to your email address, e.g.:");
  console.error("  export GMAIL_ALLOWED_SENDER=you@example.com");
  process.exit(1);
}

const KEYWORD = process.env.GMAIL_KEYWORD || "CLAUDE";
const POLL_INTERVAL_MS = (parseInt(process.env.GMAIL_POLL_INTERVAL || "60", 10)) * 1000;
const SESSION_FILE = process.env.GMAIL_SESSION_FILE ||
  path.join(os.homedir(), ".claude-email-session");

// --- Session management (separate from Telegram) ---

interface SessionState {
  sessionId: string;
  createdAt: string;
  messageCount: number;
}

function loadSession(): SessionState | null {
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function saveSession(state: SessionState): void {
  fs.writeFileSync(SESSION_FILE, JSON.stringify(state, null, 2));
}

function getOrCreateSession(): SessionState {
  const existing = loadSession();
  if (existing) return existing;
  const state: SessionState = {
    sessionId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    messageCount: 0,
  };
  saveSession(state);
  return state;
}

function newSession(): SessionState {
  const state: SessionState = {
    sessionId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    messageCount: 0,
  };
  saveSession(state);
  return state;
}

function incrementMessage(): void {
  const state = getOrCreateSession();
  state.messageCount++;
  saveSession(state);
}

// --- Active session tracking ---

const activeSessions = new Set<string>();

// --- Email processing ---

async function processEmail(email: {
  id: string;
  threadId: string;
  subject: string;
  body: string;
  from: string;
  to: string;
  messageId: string;
}): Promise<void> {
  // Security: verify sender
  if (!isAllowedSender(email.from, ALLOWED_SENDER)) {
    console.log(`  REJECTED: email from ${email.from} (not ${ALLOWED_SENDER})`);
    await markAsRead(email.id);
    return;
  }

  const { prompt, isNewSession } = extractPrompt(email, KEYWORD);

  if (!prompt.trim()) {
    console.log("  Empty prompt — skipping");
    await markAsRead(email.id);
    return;
  }

  console.log(`  Subject: ${email.subject}`);
  console.log(`  Prompt: ${prompt.slice(0, 100)}${prompt.length > 100 ? "..." : ""}`);

  if (isNewSession) {
    const session = newSession();
    activeSessions.delete(session.sessionId);
    console.log(`  New session: ${session.sessionId}`);
  }

  const session = getOrCreateSession();
  const isFirst = !activeSessions.has(session.sessionId);

  console.log(`  Session: ${session.sessionId.slice(0, 8)}... (${isFirst ? "new" : "resume"})`);

  const result = await runClaude(session.sessionId, prompt, isFirst);

  if (!result.isError) {
    activeSessions.add(session.sessionId);
    incrementMessage();
  }

  // Log the exchange
  logExchange(email.subject, result.result, result.toolCalls);

  // Build response
  let responseText = result.result;

  if (result.permissionDenials.length > 0) {
    const denials = result.permissionDenials.map((d) => {
      const input = JSON.stringify(d.tool_input || {}).slice(0, 80);
      return `  - ${d.tool_name}: ${input}`;
    });
    responseText += `\n\nPermission needed for:\n${denials.join("\n")}\nReply to this email with "yes" to approve.`;
  }

  // Mark as read BEFORE replying (so the reply doesn't trigger re-processing)
  await markAsRead(email.id);

  // Reply in the same thread — ONLY to the allowed sender
  await replyToThread(
    email.threadId,
    email.messageId,
    email.subject,
    responseText,
    ALLOWED_SENDER
  );

  console.log(`  Replied (${(result.durationMs / 1000).toFixed(1)}s, ${result.toolCalls.length} tools)`);
}

async function poll(): Promise<void> {
  try {
    const emails = await pollForEmails(KEYWORD);

    if (emails.length > 0) {
      console.log(`\n[${new Date().toLocaleTimeString("en-GB")}] Found ${emails.length} email(s)`);

      // Process oldest first (Gmail returns newest first)
      for (const email of emails.reverse()) {
        await enqueue(async () => {
          await processEmail(email);
        });
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("No messages matched")) {
      console.error(`Poll error: ${message}`);
    }
  }
}

// --- Main ---

async function main(): Promise<void> {
  try {
    getAuth();
    console.log("Gmail OAuth: authenticated");
  } catch (err) {
    console.error(`Gmail auth failed: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const session = getOrCreateSession();
  if (session.messageCount > 0) {
    activeSessions.add(session.sessionId);
  }

  console.log(`Email-Claude Bridge starting...`);
  console.log(`Session: ${session.sessionId}`);
  console.log(`Messages so far: ${session.messageCount}`);
  console.log(`Allowed sender: ${ALLOWED_SENDER}`);
  console.log(`Keyword: ${KEYWORD}`);
  console.log(`Poll interval: ${POLL_INTERVAL_MS / 1000}s`);
  console.log();

  await poll();
  setInterval(poll, POLL_INTERVAL_MS);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received — shutting down...");
  process.exit(0);
});

process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});
