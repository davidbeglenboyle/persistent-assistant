/**
 * Email-Claude Bridge — main entrypoint.
 *
 * Polls Gmail for emails matching a configured trigger (plus-address or subject keyword).
 * Spawns Claude Code per email, replies in the same thread.
 * Downloads attachments to disk and includes paths in the prompt so Claude can read them.
 *
 * Environment variables:
 *   GMAIL_ALLOWED_SENDER  — email address allowed to trigger the bridge (required)
 *   GMAIL_TRIGGER_ADDRESS — plus-address trigger, e.g. you+claude@gmail.com (optional)
 *                           When set, polls for emails TO this address instead of keyword mode
 *   GMAIL_KEYWORD         — subject prefix to match in keyword mode (default: "CLAUDE")
 *   GMAIL_POLL_INTERVAL   — seconds between polls (default: 60)
 *   GMAIL_SESSION_FILE    — path to session state file (default: ~/.claude-email-session)
 *   GMAIL_CONFIG_DIR      — path to OAuth credentials (default: ~/.config/gmail-bridge)
 *   GMAIL_ATTACHMENT_DIR  — where to save attachments (default: /tmp/email-bridge-attachments)
 *
 * Start with: npm run email
 */

import {
  pollForEmails,
  markAsProcessed,
  markAsRead,
  replyToThread,
  extractPrompt,
  isAllowedSender,
  getAuth,
  type AttachmentInfo,
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

const TRIGGER_ADDRESS = process.env.GMAIL_TRIGGER_ADDRESS; // Optional: plus-address mode
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
  attachments: AttachmentInfo[];
}): Promise<void> {
  // Security: verify sender
  if (!isAllowedSender(email.from, ALLOWED_SENDER)) {
    console.log(`  REJECTED: email from ${email.from} (not ${ALLOWED_SENDER})`);
    markAsProcessed(email.id);
    return;
  }

  const { prompt, isNewSession } = extractPrompt(email, {
    triggerAddress: TRIGGER_ADDRESS,
    keyword: KEYWORD,
  });

  if (!prompt.trim()) {
    console.log("  Empty prompt — skipping");
    markAsProcessed(email.id);
    return;
  }

  // Build attachment context for Claude
  let fullPrompt = prompt;
  if (email.attachments.length > 0) {
    const formatSize = (bytes: number): string => {
      if (bytes < 1024) return `${bytes}B`;
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
    };

    const attachmentList = email.attachments.map((a) =>
      `  - ${a.filename} (${formatSize(a.sizeBytes)}, ${a.mimeType}) → ${a.localPath}`
    ).join("\n");

    fullPrompt += `\n\n---\nATTACHMENTS SAVED TO DISK:\n${attachmentList}\n\nThese files have been downloaded from the email. You can read them with your Read tool. For large files (>100KB), consider using a sub-agent to summarise them rather than reading directly into your context window.`;
  }

  console.log(`  Subject: ${email.subject}`);
  console.log(`  Prompt: ${prompt.slice(0, 100)}${prompt.length > 100 ? "..." : ""}`);
  if (email.attachments.length > 0) {
    console.log(`  Attachments: ${email.attachments.length} file(s)`);
  }

  if (isNewSession) {
    const session = newSession();
    activeSessions.delete(session.sessionId);
    console.log(`  New session: ${session.sessionId}`);
  }

  const session = getOrCreateSession();
  const isFirst = !activeSessions.has(session.sessionId);

  console.log(`  Session: ${session.sessionId.slice(0, 8)}... (${isFirst ? "new" : "resume"})`);

  const result = await runClaude(session.sessionId, fullPrompt, isFirst);

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

  // Mark as processed BEFORE replying (so the reply doesn't trigger re-processing)
  markAsProcessed(email.id);
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
    const emails = await pollForEmails({
      triggerAddress: TRIGGER_ADDRESS,
      keyword: KEYWORD,
      allowedSender: ALLOWED_SENDER,
    });

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

  const triggerMode = TRIGGER_ADDRESS
    ? `plus-address (${TRIGGER_ADDRESS})`
    : `keyword ("${KEYWORD}:" in subject)`;

  console.log(`Email-Claude Bridge starting...`);
  console.log(`Session: ${session.sessionId}`);
  console.log(`Messages so far: ${session.messageCount}`);
  console.log(`Allowed sender: ${ALLOWED_SENDER}`);
  console.log(`Trigger: ${triggerMode}`);
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
