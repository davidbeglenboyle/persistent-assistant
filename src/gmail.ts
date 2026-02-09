/**
 * Gmail API client — poll for keyword-matching emails, read body, reply in-thread.
 *
 * Privacy model:
 * - Only reads emails FROM the configured allowed sender
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

export interface EmailMessage {
  id: string;
  threadId: string;
  subject: string;
  body: string;
  from: string;
  to: string;
  messageId: string; // RFC 2822 Message-ID for threading
}

/**
 * Poll for unread emails matching the configured keyword in the subject.
 *
 * Gmail search is loose (matches the keyword anywhere in subject), so we
 * filter in code for the exact "KEYWORD:" or "KEYWORD NEW:" prefix pattern
 * (after stripping any Re: prefixes).
 */
export async function pollForEmails(keyword: string): Promise<EmailMessage[]> {
  const gmail = getGmail();

  const res = await gmail.users.messages.list({
    userId: "me",
    q: `from:me subject:${keyword} is:unread`,
    maxResults: 10,
  });

  const messageIds = res.data.messages || [];
  if (messageIds.length === 0) return [];

  const emails: EmailMessage[] = [];
  const keywordPattern = new RegExp(`^${keyword}\\s*(NEW\\s*)?:`, "i");

  for (const msg of messageIds) {
    if (!msg.id) continue;

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

    // Code-level filter: subject must start with KEYWORD: or KEYWORD NEW:
    // (after stripping Re: prefixes). Gmail search is too loose.
    const stripped = subject.replace(/^(Re:\s*)+/i, "").trim();
    if (!keywordPattern.test(stripped)) {
      continue;
    }

    // Extract body text (prefer plain text, fall back to HTML)
    let body = "";
    const payload = full.data.payload;

    if (payload?.mimeType === "text/plain" && payload.body?.data) {
      body = Buffer.from(payload.body.data, "base64url").toString("utf-8");
    } else if (payload?.parts) {
      const textPart = payload.parts.find((p) => p.mimeType === "text/plain");
      const htmlPart = payload.parts.find((p) => p.mimeType === "text/html");
      const part = textPart || htmlPart;
      if (part?.body?.data) {
        body = Buffer.from(part.body.data, "base64url").toString("utf-8");
        if (!textPart && htmlPart) {
          body = body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        }
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
 * Reply to an email thread. ALWAYS replies only to the allowed sender.
 *
 * PRIVACY: This function deliberately ignores any CC/BCC from the original
 * email and always sends to the allowed sender address only.
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

  // Build RFC 2822 email — reply ONLY to the allowed sender
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
 * Extract the prompt from the email subject and body.
 * Strips the keyword prefix and combines subject + body.
 */
export function extractPrompt(
  email: EmailMessage,
  keyword: string
): { prompt: string; isNewSession: boolean } {
  let subject = email.subject;
  let isNewSession = false;

  // Strip Re: prefixes (for ongoing threads)
  subject = subject.replace(/^(Re:\s*)+/i, "").trim();

  // Check for NEW keyword
  const newPattern = new RegExp(`^${keyword}\\s+NEW\\s*:\\s*`, "i");
  const stdPattern = new RegExp(`^${keyword}\\s*:\\s*`, "i");

  if (newPattern.test(subject)) {
    isNewSession = true;
    subject = subject.replace(newPattern, "").trim();
  } else {
    subject = subject.replace(stdPattern, "").trim();
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
