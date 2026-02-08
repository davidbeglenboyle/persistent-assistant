import { Bot, Context } from "grammy";
import { runClaude, PermissionDenial, summarizeToolInput } from "./claude";
import { enqueue, queueLength } from "./queue";
import {
  getOrCreateSession,
  newSession,
  incrementMessage,
  getSessionStatus,
} from "./session";

import { logExchange } from "./logger";

const APPROVAL_PATTERN = /^(yes|yeah|y|allow|go ahead|approved|do it|ok)$/i;

const TELEGRAM_MAX_LENGTH = 4096;

function splitMessage(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_LENGTH) return [text];

  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    // Try to split at a newline within the limit
    let splitAt = TELEGRAM_MAX_LENGTH;
    const lastNewline = remaining.lastIndexOf("\n", TELEGRAM_MAX_LENGTH);
    if (lastNewline > TELEGRAM_MAX_LENGTH * 0.5) {
      splitAt = lastNewline;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt);
  }
  return chunks;
}

export function createBot(token: string, allowedChatId: number): Bot {
  const bot = new Bot(token);

  // Track which sessions have had at least one message
  // Pre-populate from session file so restarts use --resume, not --session-id
  const activeSessions = new Set<string>();
  const currentSession = getOrCreateSession();
  if (currentSession.messageCount > 0) {
    activeSessions.add(currentSession.sessionId);
  }

  // Track pending permission approval state
  let pendingPermission: {
    denials: PermissionDenial[];
    deniedToolNames: string[];
  } | null = null;

  bot.command("new", async (ctx: Context) => {
    if (ctx.chat?.id !== allowedChatId) return;
    pendingPermission = null;
    const session = newSession();
    activeSessions.delete(session.sessionId);
    await ctx.reply(
      `Fresh session started.\nID: \`${session.sessionId}\``,
      { parse_mode: "Markdown" }
    );
  });

  bot.command("status", async (ctx: Context) => {
    if (ctx.chat?.id !== allowedChatId) return;
    const s = getSessionStatus();
    const queued = queueLength();
    await ctx.reply(
      [
        `Session: \`${s.sessionId}\``,
        `Created: ${s.createdAt}`,
        `Messages: ${s.messageCount}`,
        queued > 0 ? `Queued: ${queued}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      { parse_mode: "Markdown" }
    );
  });

  bot.on("message:text", async (ctx: Context) => {
    if (ctx.chat?.id !== allowedChatId) {
      console.log(`Rejected message from chat ${ctx.chat?.id}`);
      return;
    }

    const userMessage = ctx.message?.text;
    if (!userMessage) return;

    console.log(`\nMessage received: ${userMessage.slice(0, 100)}...`);

    // Check if this is a permission approval for a pending denial
    const isApproval = pendingPermission && APPROVAL_PATTERN.test(userMessage.trim());
    const extraTools = isApproval ? pendingPermission!.deniedToolNames : [];
    const claudeMessage = isApproval
      ? "Permission granted for the previously denied tool(s). Please proceed with the previous request."
      : userMessage;

    if (isApproval) {
      console.log(`  Permission approved for: ${extraTools.join(", ")}`);
    }

    // Clear pending permission (consumed or superseded by new message)
    pendingPermission = null;

    // Send typing indicator
    await ctx.replyWithChatAction("typing");

    // Keep typing indicator alive during long processing
    const typingInterval = setInterval(async () => {
      try {
        await ctx.replyWithChatAction("typing");
      } catch {
        // ignore — chat action can fail silently
      }
    }, 4000);

    try {
      const result = await enqueue(async () => {
        const session = getOrCreateSession();
        const isFirst = !activeSessions.has(session.sessionId);

        console.log(
          `  Running claude (${isFirst ? "new" : "resume"} session ${session.sessionId.slice(0, 8)}...)`
        );

        const claudeResult = await runClaude(
          session.sessionId,
          claudeMessage,
          isFirst,
          extraTools
        );

        if (!claudeResult.isError) {
          activeSessions.add(session.sessionId);
          incrementMessage();
        }

        return claudeResult;
      });

      clearInterval(typingInterval);

      // Log the exchange (including tool calls for audit trail)
      logExchange(userMessage, result.result, result.toolCalls);

      // Build response text
      let responseText = result.result;

      // If tools were denied, append a permission prompt
      if (result.permissionDenials.length > 0) {
        const denialSummaries = result.permissionDenials.map((d) => {
          const summary = summarizeToolInput(d.tool_name, d.tool_input || {});
          return `• ${d.tool_name}: \`${summary}\``;
        });
        responseText += `\n\n🔐 Permission needed:\n${denialSummaries.join("\n")}\nReply 'yes' to allow.`;

        // Track for next message
        const deniedToolNames = [...new Set(result.permissionDenials.map((d) => d.tool_name))];
        pendingPermission = {
          denials: result.permissionDenials,
          deniedToolNames,
        };
        console.log(`  Permission denials: ${deniedToolNames.join(", ")}`);
      }

      // Send response, splitting if needed
      const chunks = splitMessage(responseText);
      for (const chunk of chunks) {
        await ctx.reply(chunk);
      }

      console.log(`  Done in ${(result.durationMs / 1000).toFixed(1)}s`);
    } catch (err) {
      clearInterval(typingInterval);
      console.error("  Error:", err);
      try {
        await ctx.reply(`Error: ${err instanceof Error ? err.message : String(err)}`);
      } catch (replyErr) {
        console.error("  Failed to send error reply:", replyErr);
      }
    }
  });

  return bot;
}
