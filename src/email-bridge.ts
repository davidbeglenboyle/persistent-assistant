/**
 * Email-Claude Bridge — main entrypoint.
 *
 * Polls Gmail for emails matching a configured trigger (plus-address or subject keyword).
 * Spawns Claude Code per email, replies in the same thread.
 * Downloads attachments to disk and includes paths in the prompt so Claude can read them.
 * Each unique subject line gets its own Claude session (Re:/Fwd: stripped).
 *
 * Environment variables:
 *   GMAIL_ALLOWED_SENDER  — email address allowed to trigger the bridge (required)
 *   GMAIL_TRIGGER_ADDRESS — plus-address trigger, e.g. you+claude@gmail.com (optional)
 *                           When set, polls for emails TO this address instead of keyword mode
 *   GMAIL_KEYWORD         — subject prefix to match in keyword mode (default: "CLAUDE")
 *   GMAIL_POLL_INTERVAL   — seconds between polls (default: 60)
 *   GMAIL_SESSIONS_FILE   — path to sessions state file (default: ~/.claude-email-sessions.json)
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
  subjectToKey,
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

const ALLOWED_SENDER: string = process.env.GMAIL_ALLOWED_SENDER || "";
if (!ALLOWED_SENDER) {
  console.error("GMAIL_ALLOWED_SENDER not set");
  console.error("Set this to your email address, e.g.:");
  console.error("  export GMAIL_ALLOWED_SENDER=you@example.com");
  process.exit(1);
}

const TRIGGER_ADDRESS = process.env.GMAIL_TRIGGER_ADDRESS; // Optional: plus-address mode
const KEYWORD = process.env.GMAIL_KEYWORD || "CLAUDE";
const POLL_INTERVAL_MS = (parseInt(process.env.GMAIL_POLL_INTERVAL || "60", 10)) * 1000;
const SESSIONS_FILE = process.env.GMAIL_SESSIONS_FILE ||
  path.join(os.homedir(), ".claude-email-sessions.json");

// --- Rate limiting ---

const RATE_WINDOW_MS = 5 * 60 * 1000; // 5-minute sliding window
const RATE_MAX_PER_WINDOW = 3;
const sessionInvocations = new Map<string, number[]>();

function isRateLimited(sessionKey: string): boolean {
  const now = Date.now();
  const timestamps = sessionInvocations.get(sessionKey) || [];

  // Prune entries older than the window
  const recent = timestamps.filter((t) => now - t < RATE_WINDOW_MS);
  sessionInvocations.set(sessionKey, recent);

  return recent.length >= RATE_MAX_PER_WINDOW;
}

function recordInvocation(sessionKey: string): void {
  const timestamps = sessionInvocations.get(sessionKey) || [];
  timestamps.push(Date.now());
  sessionInvocations.set(sessionKey, timestamps);
}

// --- Deferred retry queue for capacity errors ---

interface DeferredEmail {
  email: {
    id: string;
    threadId: string;
    subject: string;
    body: string;
    from: string;
    to: string;
    messageId: string;
    attachments: AttachmentInfo[];
  };
  deferredAt: number;
  attempts: number;
}

const deferredEmails = new Map<string, DeferredEmail>();
const DEFER_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes between retries
const MAX_DEFER_ATTEMPTS = 3;

function isCapacityError(message: string): boolean {
  return /too many concurrent/i.test(message) || /api timeout/i.test(message);
}

// --- Network resilience with exponential backoff ---

let consecutiveErrors = 0;
let errorStartTime = 0;
const MAX_BACKOFF_MS = 5 * 60 * 1000; // Cap at 5 minutes

function getBackoffMs(): number {
  if (consecutiveErrors === 0) return POLL_INTERVAL_MS;
  // Exponential backoff: base interval * 2^(errors-1), capped
  const backoff = POLL_INTERVAL_MS * Math.pow(2, consecutiveErrors - 1);
  return Math.min(backoff, MAX_BACKOFF_MS);
}

// --- Heartbeat ---

let pollCount = 0;
const HEARTBEAT_INTERVAL = 10; // Log every N polls

// --- Per-subject session management ---

interface SessionState {
  sessionId: string;
  createdAt: string;
  messageCount: number;
  subject: string;
}

interface SessionsMap {
  [subjectKey: string]: SessionState;
}

function loadSessions(): SessionsMap {
  try {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf-8"));
  } catch {
    return {};
  }
}

function saveSessions(sessions: SessionsMap): void {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

function getOrCreateSession(sKey: string, rawSubject: string): SessionState {
  const sessions = loadSessions();
  if (sessions[sKey]) return sessions[sKey];
  const state: SessionState = {
    sessionId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    messageCount: 0,
    subject: rawSubject,
  };
  sessions[sKey] = state;
  saveSessions(sessions);
  return state;
}

function newSession(sKey: string, rawSubject: string): SessionState {
  const sessions = loadSessions();
  const state: SessionState = {
    sessionId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    messageCount: 0,
    subject: rawSubject,
  };
  sessions[sKey] = state;
  saveSessions(sessions);
  return state;
}

function incrementMessage(sKey: string): void {
  const sessions = loadSessions();
  const state = sessions[sKey];
  if (!state) return;
  state.messageCount++;
  saveSessions(sessions);
}

// --- Active session tracking ---

const activeSessions = new Set<string>();

// --- Graceful shutdown ---

let shuttingDown = false;

function handleShutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received — shutting down gracefully...`);
  console.log(`  Deferred emails: ${deferredEmails.size}`);
  console.log(`  Active sessions: ${activeSessions.size}`);
  process.exit(0);
}

process.on("SIGINT", () => handleShutdown("SIGINT"));
process.on("SIGTERM", () => handleShutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
  // Don't exit — log and continue
});

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
    return;
  }

  const { prompt, isNewSession } = extractPrompt(email, {
    triggerAddress: TRIGGER_ADDRESS,
    keyword: KEYWORD,
  });

  if (!prompt.trim()) {
    console.log("  Empty prompt — skipping");
    return;
  }

  // Derive session key from subject line
  const sKey = subjectToKey(email.subject, TRIGGER_ADDRESS ? undefined : KEYWORD);

  // Rate limiting check
  if (isRateLimited(sKey)) {
    console.log(`  Rate limited: "${sKey}" (${RATE_MAX_PER_WINDOW} invocations in ${RATE_WINDOW_MS / 1000}s window)`);
    await replyToThread(
      email.threadId,
      email.messageId,
      email.subject,
      "Rate limit reached for this session. Please wait a few minutes before sending another message.",
      ALLOWED_SENDER
    );
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
  console.log(`  Session key: "${sKey}"`);
  console.log(`  Prompt: ${prompt.slice(0, 100)}${prompt.length > 100 ? "..." : ""}`);
  if (email.attachments.length > 0) {
    console.log(`  Attachments: ${email.attachments.length} file(s)`);
  }

  // Handle explicit NEW: session request (forces fresh session for this subject)
  if (isNewSession) {
    const session = newSession(sKey, email.subject);
    activeSessions.delete(session.sessionId);
    console.log(`  New session (forced): ${session.sessionId}`);
  }

  let session = getOrCreateSession(sKey, email.subject);
  const isFirst = !activeSessions.has(session.sessionId);

  console.log(`  Session: ${session.sessionId.slice(0, 8)}... (${isFirst ? "new" : "resume"}, ${session.messageCount} msgs)`);

  // Record the invocation for rate limiting
  recordInvocation(sKey);

  let result = await runClaude(session.sessionId, fullPrompt, isFirst);

  // Handle dead session: create a new session and retry once
  if (result.deadSession) {
    console.log(`  Dead session detected — creating new session and retrying`);
    session = newSession(sKey, email.subject);
    activeSessions.delete(session.sessionId);
    result = await runClaude(session.sessionId, fullPrompt, true);
  }

  // Handle capacity errors: defer for retry instead of sending error reply
  if (result.isError && isCapacityError(result.result)) {
    const existing = deferredEmails.get(email.id);
    const attempts = existing ? existing.attempts + 1 : 1;

    if (attempts <= MAX_DEFER_ATTEMPTS) {
      console.log(`  Capacity error — deferring (attempt ${attempts}/${MAX_DEFER_ATTEMPTS})`);
      deferredEmails.set(email.id, {
        email,
        deferredAt: Date.now(),
        attempts,
      });
      return; // Don't reply with error — will retry later
    }
    console.log(`  Capacity error — max defer attempts reached, sending error reply`);
  }

  if (!result.isError) {
    activeSessions.add(session.sessionId);
    incrementMessage(sKey);
  }

  // Log the exchange
  logExchange(email.subject, result.result, result.toolCalls, "email");

  // Build response
  let responseText = result.result;

  if (result.permissionDenials.length > 0) {
    const denials = result.permissionDenials.map((d) => {
      const input = JSON.stringify(d.tool_input || {}).slice(0, 80);
      return `  - ${d.tool_name}: ${input}`;
    });
    responseText += `\n\nPermission needed for:\n${denials.join("\n")}\nReply to this email with "yes" to approve.`;
  }

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

// --- Hard timeout wrapper for Gmail poll ---

const POLL_TIMEOUT_MS = 45_000; // 45 seconds

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms / 1000}s`));
    }, ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

// --- Poll cycle ---

async function poll(): Promise<void> {
  if (shuttingDown) return;

  pollCount++;

  // Heartbeat logging
  if (pollCount % HEARTBEAT_INTERVAL === 0) {
    const deferred = deferredEmails.size;
    const sessions = activeSessions.size;
    console.log(`[${new Date().toLocaleTimeString("en-GB")}] Heartbeat: poll #${pollCount}, ${sessions} active sessions, ${deferred} deferred emails`);
  }

  try {
    const emails = await withTimeout(
      pollForEmails({
        triggerAddress: TRIGGER_ADDRESS,
        keyword: KEYWORD,
        allowedSender: ALLOWED_SENDER,
      }),
      POLL_TIMEOUT_MS,
      "Gmail poll"
    );

    // Recovery: clear error state on success
    if (consecutiveErrors > 0) {
      const downtime = ((Date.now() - errorStartTime) / 1000).toFixed(0);
      console.log(`[${new Date().toLocaleTimeString("en-GB")}] Recovered after ${consecutiveErrors} consecutive errors (${downtime}s downtime)`);
      consecutiveErrors = 0;
      errorStartTime = 0;
    }

    if (emails.length > 0) {
      console.log(`\n[${new Date().toLocaleTimeString("en-GB")}] Found ${emails.length} email(s)`);

      // Process oldest first (Gmail returns newest first)
      for (const email of emails.reverse()) {
        // Mark as processed BEFORE queueing to prevent race condition
        // where a second poll picks up the same email
        markAsProcessed(email.id);

        await enqueue("email", async () => {
          await processEmail(email);
        });
      }
    }

    // Process one deferred email per cycle if cooldown has passed
    for (const [emailId, deferred] of deferredEmails) {
      if (Date.now() - deferred.deferredAt >= DEFER_COOLDOWN_MS) {
        console.log(`[${new Date().toLocaleTimeString("en-GB")}] Retrying deferred email: ${deferred.email.subject} (attempt ${deferred.attempts + 1})`);
        deferredEmails.delete(emailId);
        await enqueue("email", async () => {
          await processEmail(deferred.email);
        });
        break; // Only one per cycle
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes("No messages matched")) {
      if (consecutiveErrors === 0) {
        errorStartTime = Date.now();
      }
      consecutiveErrors++;
      console.error(`Poll error (${consecutiveErrors} consecutive): ${message}`);
    }
  }

  // Schedule next poll with backoff
  if (!shuttingDown) {
    const nextInterval = getBackoffMs();
    if (nextInterval !== POLL_INTERVAL_MS) {
      console.log(`  Next poll in ${(nextInterval / 1000).toFixed(0)}s (backoff)`);
    }
    setTimeout(poll, nextInterval);
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

  // Load existing sessions and pre-populate activeSessions
  const sessions = loadSessions();
  const sessionCount = Object.keys(sessions).length;
  for (const state of Object.values(sessions)) {
    if (state.messageCount > 0) {
      activeSessions.add(state.sessionId);
    }
  }

  const triggerMode = TRIGGER_ADDRESS
    ? `plus-address (${TRIGGER_ADDRESS})`
    : `keyword ("${KEYWORD}:" in subject)`;

  console.log(`Email-Claude Bridge starting...`);
  console.log(`Active sessions: ${sessionCount}`);
  console.log(`Allowed sender: ${ALLOWED_SENDER}`);
  console.log(`Trigger: ${triggerMode}`);
  console.log(`Poll interval: ${POLL_INTERVAL_MS / 1000}s`);
  console.log(`Rate limit: ${RATE_MAX_PER_WINDOW} per ${RATE_WINDOW_MS / 60000}min per session`);
  console.log();

  // Use self-scheduling setTimeout instead of setInterval (allows variable intervals)
  await poll();
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
