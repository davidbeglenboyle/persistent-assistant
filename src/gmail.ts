/**
 * Gmail API client — poll for emails, read body, download attachments, reply in-thread.
 *
 * Supports two trigger modes (configured via environment):
 *   1. Plus-address: emails sent TO a plus-addressed email (e.g. you+claude@gmail.com)
 *   2. Subject keyword: emails FROM you with a keyword prefix in the subject
 *
 * Privacy model:
 * - Only processes emails from the configured allowed sender
 * - Only replies to the sender — never adds CC/BCC
 * - Never infers or adds recipients, even if mentioned in the body
 */

import * as fs from "fs";
import * as path from "path";
import { google, gmail_v1 } from "googleapis";
import type { OAuth2Client } from "google-auth-library";

const CONFIG_DIR = process.env.GMAIL_CONFIG_DIR ||
  path.join(process.env.HOME || "", ".config", "gmail-bridge");
const CREDENTIALS_PATH = path.join(CONFIG_DIR, "credentials.json");
const TOKEN_PATH = path.join(CONFIG_DIR, "token.json");

let cachedAuth: OAuth2Client | null = null;

export function getAuth(): OAuth2Client {
  if (cachedAuth) return cachedAuth;

  if (!fs.existsSync(CREDENTIALS_PATH)) {
    throw new Error(`Credentials not found: ${CREDENTIALS_PATH}\nRun: npx tsx scripts/setup-gmail-oauth.ts`);
  }
  if (!fs.existsSync(TOKEN_PATH)) {
    throw new Error(`Token not found: ${TOKEN_PATH}\nRun: npx tsx scripts/setup-gmail-oauth.ts`);
  }

  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
  const { client_id, client_secret } = credentials.installed || credentials.web || {};

  const oauth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    "http://localhost:3847/oauth2callback"
  );

  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
  oauth2Client.setCredentials(token);

  // Auto-refresh and save updated tokens
  oauth2Client.on("tokens", (newTokens) => {
    const existing = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf-8"));
    const merged = { ...existing, ...newTokens };
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2));
    console.log("  Token refreshed and saved");
  });

  cachedAuth = oauth2Client;
  return oauth2Client;
}

function getGmail(): gmail_v1.Gmail {
  return google.gmail({ version: "v1", auth: getAuth() });
}

export interface AttachmentInfo {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  localPath: string; // Where we saved it on disk
}

export interface EmailMessage {
  id: string;
  threadId: string;
  subject: string;
  body: string;
  from: string;
  to: string;
  messageId: string; // RFC 2822 Message-ID for threading
  attachments: AttachmentInfo[];
}

/**
 * Track processed message IDs to avoid re-processing.
 * Persisted to disk so restarts don't reprocess old emails.
 *
 * Why not use is:unread? When you email yourself via Gmail, the message
 * lands in Sent without the UNREAD label. Gmail treats self-emails as
 * "already seen" because you sent them. Using processed-ID tracking
 * works reliably for both self-emails and forwarded emails.
 */
const PROCESSED_FILE = process.env.GMAIL_PROCESSED_FILE ||
  path.join(process.env.HOME || "", ".email-bridge-processed.json");

function loadProcessedIds(): Set<string> {
  try {
    const data = fs.readFileSync(PROCESSED_FILE, "utf-8");
    return new Set(JSON.parse(data));
  } catch {
    return new Set();
  }
}

function saveProcessedIds(ids: Set<string>): void {
  const arr = [...ids].slice(-500); // Keep last 500 to prevent unbounded growth
  fs.writeFileSync(PROCESSED_FILE, JSON.stringify(arr));
}

const processedIds = loadProcessedIds();

export function markAsProcessed(messageId: string): void {
  processedIds.add(messageId);
  saveProcessedIds(processedIds);
}

const ATTACHMENT_DIR = process.env.GMAIL_ATTACHMENT_DIR || "/tmp/email-bridge-attachments";

/**
 * Download all attachments from a Gmail message to disk.
 * Returns metadata for each attachment including the local file path.
 *
 * Gmail stores attachments as separate resources referenced by attachmentId.
 * Small attachments (<~5KB) are inlined in the message payload; larger ones
 * require a separate attachments.get() call.
 */
async function downloadAttachments(
  gmail: gmail_v1.Gmail,
  gmailMessageId: string,
  parts: gmail_v1.Schema$MessagePart[],
): Promise<AttachmentInfo[]> {
  const attachments: AttachmentInfo[] = [];
  const msgDir = path.join(ATTACHMENT_DIR, gmailMessageId);

  // Flatten nested parts (multipart/mixed > multipart/alternative + attachments)
  const allParts: gmail_v1.Schema$MessagePart[] = [];
  for (const part of parts) {
    allParts.push(part);
    if (part.parts) {
      for (const nested of part.parts) {
        allParts.push(nested);
      }
    }
  }

  const attachmentParts = allParts.filter(
    (p) => p.filename && p.filename.length > 0 && p.body
  );

  if (attachmentParts.length === 0) return [];

  // Create directory for this message's attachments
  fs.mkdirSync(msgDir, { recursive: true });

  for (const part of attachmentParts) {
    const filename = part.filename!;
    const mimeType = part.mimeType || "application/octet-stream";

    let data: Buffer;

    if (part.body?.attachmentId) {
      // Large attachment — fetch separately
      const res = await gmail.users.messages.attachments.get({
        userId: "me",
        messageId: gmailMessageId,
        id: part.body.attachmentId,
      });
      data = Buffer.from(res.data.data || "", "base64url");
    } else if (part.body?.data) {
      // Small inline attachment
      data = Buffer.from(part.body.data, "base64url");
    } else {
      continue;
    }

    // Sanitize filename (remove path separators, limit length)
    const safeName = filename.replace(/[/\\]/g, "_").slice(0, 200);
    const localPath = path.join(msgDir, safeName);

    fs.writeFileSync(localPath, data);

    attachments.push({
      filename: safeName,
      mimeType,
      sizeBytes: data.length,
      localPath,
    });

    console.log(`  Attachment: ${safeName} (${(data.length / 1024).toFixed(0)}KB, ${mimeType})`);
  }

  return attachments;
}

/**
 * Poll for recent emails using either plus-address or keyword trigger.
 *
 * Plus-address mode (GMAIL_TRIGGER_ADDRESS set):
 *   Searches for emails sent TO the trigger address. No subject prefix required.
 *   The plus-address is the trigger — forward any email to it.
 *
 * Keyword mode (default, GMAIL_KEYWORD set):
 *   Searches for emails FROM you with the keyword in the subject.
 *   Requires "KEYWORD: prompt" format in subject line.
 *
 * Both modes use local processed-ID tracking instead of is:unread.
 */
export async function pollForEmails(config: {
  triggerAddress?: string;
  keyword: string;
  allowedSender: string;
}): Promise<EmailMessage[]> {
  const gmail = getGmail();

  // Build search query based on trigger mode
  const query = config.triggerAddress
    ? `to:${config.triggerAddress} newer_than:7d`
    : `from:me subject:${config.keyword} newer_than:7d`;

  const res = await gmail.users.messages.list({
    userId: "me",
    q: query,
    maxResults: 10,
  });

  const messageIds = res.data.messages || [];
  if (messageIds.length === 0) return [];

  const emails: EmailMessage[] = [];
  const keywordPattern = new RegExp(`^${config.keyword}\\s*(NEW\\s*)?:`, "i");

  for (const msg of messageIds) {
    if (!msg.id) continue;

    // Skip already-processed messages (check before fetching full message)
    if (processedIds.has(msg.id)) {
      continue;
    }

    const full = await gmail.users.messages.get({
      userId: "me",
      id: msg.id,
      format: "full",
    });

    const headers = full.data.payload?.headers || [];
    const getHeader = (name: string): string =>
      headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || "";

    const from = getHeader("From");
    const to = getHeader("To");
    const subject = getHeader("Subject");
    const messageId = getHeader("Message-ID");

    if (config.triggerAddress) {
      // Plus-address mode: verify To: header contains the trigger address
      if (!to.toLowerCase().includes(config.triggerAddress.toLowerCase())) {
        markAsProcessed(msg.id);
        continue;
      }
    } else {
      // Keyword mode: verify subject starts with KEYWORD: or KEYWORD NEW:
      const stripped = subject.replace(/^(Re:\s*)+/i, "").trim();
      if (!keywordPattern.test(stripped)) {
        markAsProcessed(msg.id);
        continue;
      }
    }

    // Loop prevention: skip messages sent by this bridge (Claude's replies).
    // Replies have a different To: address (no plus-address) or no keyword in subject,
    // but Gmail thread search can return all messages in a matching thread.
    const labelIds = full.data.labelIds || [];
    if (labelIds.includes("SENT") && !labelIds.includes("INBOX")) {
      // Message was sent (not received) — this is Claude's own reply
      markAsProcessed(msg.id);
      continue;
    }

    // Extract body text (prefer plain text, fall back to HTML)
    let body = "";
    const payload = full.data.payload;

    if (payload?.mimeType === "text/plain" && payload.body?.data) {
      body = Buffer.from(payload.body.data, "base64url").toString("utf-8");
    } else if (payload?.parts) {
      // Multipart — find text/plain first, then text/html
      const textPart = payload.parts.find((p) => p.mimeType === "text/plain");
      const htmlPart = payload.parts.find((p) => p.mimeType === "text/html");
      // Also check nested parts (multipart/alternative inside multipart/mixed)
      const nestedTextPart = !textPart ? payload.parts
        .filter((p) => p.parts)
        .flatMap((p) => p.parts || [])
        .find((p) => p.mimeType === "text/plain") : null;
      const part = textPart || nestedTextPart || htmlPart;
      if (part?.body?.data) {
        body = Buffer.from(part.body.data, "base64url").toString("utf-8");
        if (!textPart && !nestedTextPart && htmlPart) {
          // Strip HTML tags for a rough plain text version
          body = body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        }
      }
    }

    // Cap body at 30KB to prevent extremely long forwarded threads
    // from overwhelming Claude's context
    const MAX_BODY_CHARS = 30_000;
    if (body.length > MAX_BODY_CHARS) {
      body = body.slice(0, MAX_BODY_CHARS) + "\n\n[... truncated — original was " +
        Math.round(body.length / 1000) + "KB]";
    }

    // Download attachments to disk so Claude can read them with its tools
    let attachments: AttachmentInfo[] = [];
    if (payload?.parts) {
      try {
        attachments = await downloadAttachments(gmail, msg.id, payload.parts);
      } catch (err) {
        console.log(`  Attachment download error: ${err instanceof Error ? err.message : err}`);
      }
    }

    emails.push({
      id: msg.id,
      threadId: full.data.threadId || msg.id,
      subject,
      body: body.trim(),
      from,
      to,
      messageId,
      attachments,
    });
  }

  return emails;
}

/**
 * Mark an email as read (remove UNREAD label).
 */
export async function markAsRead(messageId: string): Promise<void> {
  const gmail = getGmail();
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: {
      removeLabelIds: ["UNREAD"],
    },
  });
}

/**
 * Reply to an email thread. ALWAYS replies only to the specified address.
 *
 * PRIVACY: This function deliberately ignores any CC/BCC from the original
 * email and always sends to the provided reply address only.
 */
export async function replyToThread(
  threadId: string,
  inReplyToMessageId: string,
  subject: string,
  responseBody: string,
  replyToAddress: string
): Promise<void> {
  const gmail = getGmail();

  // Ensure subject has Re: prefix
  const reSubject = subject.startsWith("Re:") ? subject : `Re: ${subject}`;

  // Build RFC 2822 email — reply ONLY to the specified address
  const rawEmail = [
    `To: ${replyToAddress}`,
    `Subject: ${reSubject}`,
    `In-Reply-To: ${inReplyToMessageId}`,
    `References: ${inReplyToMessageId}`,
    `MIME-Version: 1.0`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `Content-Transfer-Encoding: 7bit`,
    ``,
    responseBody,
  ].join("\r\n");

  // Base64url encode
  const encoded = Buffer.from(rawEmail)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  await gmail.users.messages.send({
    userId: "me",
    requestBody: {
      raw: encoded,
      threadId: threadId,
    },
  });
}

/**
 * Normalise a subject line into a session key.
 * Strips Re:/Fwd:/Fw: prefixes, NEW: prefix, keyword prefix, and lowercases.
 * Used to route emails with the same subject to the same Claude session.
 */
export function subjectToKey(subject: string, keyword?: string): string {
  let s = subject;
  // Strip Re:/Fwd:/Fw: prefixes (may be nested)
  for (let i = 0; i < 5; i++) {
    const stripped = s.replace(/^(Re:|Fwd?:)\s*/gi, "").trim();
    if (stripped === s) break;
    s = stripped;
  }
  // Strip NEW: prefix — session control keyword, not part of the subject
  s = s.replace(/^NEW\s*:\s*/i, "").trim();
  // Strip keyword prefix (e.g. "CLAUDE:") if in keyword mode
  if (keyword) {
    const kwPattern = new RegExp(`^${keyword}\\s*:?\\s*`, "i");
    s = s.replace(kwPattern, "").trim();
  }
  return s.toLowerCase();
}

/**
 * Extract the prompt from the email subject and body.
 *
 * Plus-address mode: subject becomes the prompt directly (strips Re:/Fwd: only).
 * Keyword mode: strips the "KEYWORD:" prefix from subject.
 *
 * "NEW:" prefix (in plus-address mode) or "KEYWORD NEW:" (in keyword mode)
 * starts a fresh Claude session.
 */
export function extractPrompt(
  email: EmailMessage,
  config: { triggerAddress?: string; keyword: string }
): { prompt: string; isNewSession: boolean } {
  let subject = email.subject;
  let isNewSession = false;

  // Strip Re: and Fwd: prefixes
  subject = subject.replace(/^(Re:|Fwd?:)\s*/gi, "").trim();
  subject = subject.replace(/^(Re:|Fwd?:)\s*/gi, "").trim();

  if (config.triggerAddress) {
    // Plus-address mode: check for NEW: prefix
    if (/^NEW\s*:/i.test(subject)) {
      isNewSession = true;
      subject = subject.replace(/^NEW\s*:\s*/i, "").trim();
    }
  } else {
    // Keyword mode: strip KEYWORD: or KEYWORD NEW: prefix
    const newPattern = new RegExp(`^${config.keyword}\\s+NEW\\s*:\\s*`, "i");
    const stdPattern = new RegExp(`^${config.keyword}\\s*:\\s*`, "i");

    if (newPattern.test(subject)) {
      isNewSession = true;
      subject = subject.replace(newPattern, "").trim();
    } else {
      subject = subject.replace(stdPattern, "").trim();
    }
  }

  // Combine subject and body
  const parts: string[] = [];
  if (subject) parts.push(subject);
  if (email.body) parts.push(email.body);

  return {
    prompt: parts.join("\n\n"),
    isNewSession,
  };
}

/**
 * Verify the sender matches the allowed address.
 * The From header can be "Name <email>" or just "email".
 */
export function isAllowedSender(from: string, allowedEmail: string): boolean {
  const emailMatch = from.match(/<([^>]+)>/) || [null, from];
  const email = (emailMatch[1] || from).trim().toLowerCase();
  return email === allowedEmail.toLowerCase();
}
