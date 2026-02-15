import { Bot, Context } from "grammy";
import { runClaude, PermissionDenial, ProgressCallback, summarizeToolInput } from "./claude";
import { enqueue, queueLength } from "./queue";
import {
  getOrCreateSession,
  newSession,
  incrementMessage,
  getSessionStatus,
  getAllSessions,
} from "./session";
import { logExchange } from "./logger";
import { downloadTelegramFile, cleanupOldImages } from "./download";
import { isAlreadyProcessed, markProcessed } from "./dedup";

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

// Resolve topic ID from a message context.
// In forum groups: message_thread_id identifies the topic.
// In DMs or non-forum groups: returns "general" for backward compatibility.
// Fix: Telegram's Bot API sometimes omits message_thread_id for the
// General topic in forum groups. Route these to "general-topic" so they
// get their own isolated session instead of a DM-style catch-all.
function getTopicId(ctx: Context): string {
  const threadId = ctx.message?.message_thread_id;
  if (threadId) return String(threadId);

  const chat = ctx.chat as Record<string, unknown> | undefined;
  if (chat?.is_forum) {
    return "general-topic";
  }

  return "general";
}

// Get a human-friendly label for the topic (for logging)
function getTopicLabel(topicId: string): string {
  if (topicId === "general" || topicId === "general-topic") return "General";
  return `Topic ${topicId}`;
}

export function createBot(
  token: string,
  allowedChatIds: number[],
  mode: "dm" | "group"
): Bot {
  const bot = new Bot(token);

  // Per-topic: track which sessions have had at least one message
  // Pre-populate from session files so restarts use --resume, not --session-id
  const activeSessions = new Set<string>();
  for (const { state } of getAllSessions()) {
    if (state.messageCount > 0) {
      activeSessions.add(state.sessionId);
    }
  }

  // Per-topic pending permission state
  const pendingPermissions = new Map<
    string,
    { denials: PermissionDenial[]; deniedToolNames: string[] }
  >();

  // Clean up old downloaded images on startup
  const cleaned = cleanupOldImages();
  if (cleaned > 0) {
    console.log(`Cleaned up ${cleaned} old image file(s)`);
  }

  // Periodic cleanup every 6 hours
  setInterval(() => {
    try {
      const n = cleanupOldImages();
      if (n > 0) console.log(`Periodic cleanup: removed ${n} old image file(s)`);
    } catch { /* ignore cleanup errors */ }
  }, 6 * 60 * 60 * 1000);

  function isAllowed(ctx: Context): boolean {
    const chatId = ctx.chat?.id;
    return chatId !== undefined && allowedChatIds.includes(chatId);
  }

  // Reply helper: sends to the correct topic thread
  async function reply(ctx: Context, text: string): Promise<void> {
    const threadId = ctx.message?.message_thread_id;
    const chunks = splitMessage(text);
    for (const chunk of chunks) {
      if (mode === "group" && threadId) {
        await ctx.reply(chunk, { message_thread_id: threadId });
      } else {
        await ctx.reply(chunk);
      }
    }
  }

  // Typing indicator, topic-aware
  async function sendTyping(ctx: Context): Promise<void> {
    try {
      const threadId = ctx.message?.message_thread_id;
      if (mode === "group" && threadId) {
        await ctx.api.sendChatAction(ctx.chat!.id, "typing", {
          message_thread_id: threadId,
        });
      } else {
        await ctx.replyWithChatAction("typing");
      }
    } catch {
      // ignore — chat action can fail silently
    }
  }

  // Shared processing: enqueue Claude invocation, handle response, permissions, logging
  async function processAndRespond(
    ctx: Context,
    claudeMessage: string,
    logLabel: string
  ): Promise<void> {
    const topicId = getTopicId(ctx);
    const topicLabel = getTopicLabel(topicId);
    const pending = pendingPermissions.get(topicId);

    // Check if this is a permission approval for a pending denial
    const isApproval = pending && APPROVAL_PATTERN.test(claudeMessage.trim());
    const extraTools = isApproval ? pending!.deniedToolNames : [];
    const finalMessage = isApproval
      ? "Permission granted for the previously denied tool(s). Please proceed with the previous request."
      : claudeMessage;

    if (isApproval) {
      console.log(`  [${topicLabel}] Permission approved for: ${extraTools.join(", ")}`);
    }

    // Clear pending permission (consumed or superseded by new message)
    pendingPermissions.delete(topicId);

    // Send typing indicator
    await sendTyping(ctx);

    // Keep typing indicator alive during long processing
    const typingInterval = setInterval(() => sendTyping(ctx), 4000);

    try {
      const result = await enqueue(topicId, async () => {
        const session = getOrCreateSession(topicId);
        const isFirst = !activeSessions.has(session.sessionId);

        console.log(
          `  [${topicLabel}] Running claude (${isFirst ? "new" : "resume"} session ${session.sessionId.slice(0, 8)}...)`
        );

        const onProgress: ProgressCallback = ({ elapsedMin, toolCallCount }) => {
          const toolNote = toolCallCount > 0 ? ` (${toolCallCount} tool calls so far)` : "";
          reply(ctx, `Still working... ${elapsedMin} min elapsed${toolNote}`).catch(() => {});
          console.log(`  [${topicLabel}] Progress: ${elapsedMin}min, ${toolCallCount} tool calls`);
        };

        const claudeResult = await runClaude(
          session.sessionId,
          finalMessage,
          isFirst,
          extraTools,
          onProgress
        );

        if (!claudeResult.isError) {
          activeSessions.add(session.sessionId);
          incrementMessage(topicId);
        }

        return claudeResult;
      });

      clearInterval(typingInterval);

      // Log the exchange (including tool calls for audit trail)
      logExchange(logLabel, result.result, result.toolCalls, topicId);

      // Build response text
      let responseText = result.result;

      // Only prompt for permission if Claude couldn't complete the task.
      // When isError is false, Claude handled the denial gracefully (skipped or found alternatives)
      // and the permission_denials are informational, not blocking.
      if (result.permissionDenials.length > 0 && result.isError) {
        const denialSummaries = result.permissionDenials.map((d) => {
          const summary = summarizeToolInput(d.tool_name, d.tool_input || {});
          return `• ${d.tool_name}: \`${summary}\``;
        });
        responseText += `\n\n🔐 Permission needed:\n${denialSummaries.join("\n")}\nReply 'yes' to allow.`;

        // Track for next message in this topic
        const deniedToolNames = [...new Set(result.permissionDenials.map((d) => d.tool_name))];
        pendingPermissions.set(topicId, {
          denials: result.permissionDenials,
          deniedToolNames,
        });
        console.log(`  [${topicLabel}] Permission denials: ${deniedToolNames.join(", ")}`);
      }

      // Send response to the correct topic
      await reply(ctx, responseText);

      console.log(`  [${topicLabel}] Done in ${(result.durationMs / 1000).toFixed(1)}s`);
    } catch (err) {
      clearInterval(typingInterval);
      console.error(`  [${topicLabel}] Error:`, err);
      try {
        await reply(ctx, `Error: ${err instanceof Error ? err.message : String(err)}`);
      } catch (replyErr) {
        console.error(`  [${topicLabel}] Failed to send error reply:`, replyErr);
      }
    }
  }

  bot.command("new", async (ctx: Context) => {
    if (!isAllowed(ctx)) return;
    const topicId = getTopicId(ctx);
    const topicLabel = getTopicLabel(topicId);
    pendingPermissions.delete(topicId);
    const session = newSession(topicId);
    activeSessions.delete(session.sessionId);
    await reply(ctx, `Fresh session started.\nID: ${session.sessionId}`);
    console.log(`  [${topicLabel}] New session: ${session.sessionId}`);
  });

  bot.command("status", async (ctx: Context) => {
    if (!isAllowed(ctx)) return;
    const topicId = getTopicId(ctx);
    const topicLabel = getTopicLabel(topicId);
    const s = getSessionStatus(topicId);
    const queued = queueLength(topicId);
    await reply(
      ctx,
      [
        topicLabel,
        `Session: ${s.sessionId}`,
        `Created: ${s.createdAt}`,
        `Messages: ${s.messageCount}`,
        queued > 0 ? `Queued: ${queued}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  });

  bot.command("topics", async (ctx: Context) => {
    if (!isAllowed(ctx)) return;
    const sessions = getAllSessions();
    if (sessions.length === 0) {
      await reply(ctx, "No active topics.");
      return;
    }
    const lines = sessions.map(({ topicId, state }) => {
      const label = (topicId === "general" || topicId === "general-topic") ? "General" : `Topic ${topicId}`;
      const name = state.topicName ? ` (${state.topicName})` : "";
      return `${label}${name}: ${state.messageCount} msgs`;
    });
    await reply(ctx, lines.join("\n"));
  });

  bot.on("message:photo", async (ctx: Context) => {
    if (!isAllowed(ctx)) {
      console.log(`Rejected photo from chat ${ctx.chat?.id}`);
      return;
    }

    // Skip already-processed updates (prevents restart replay loops)
    const updateId = ctx.update.update_id;
    if (isAlreadyProcessed(updateId)) {
      console.log(`Skipping already-processed photo update ${updateId}`);
      return;
    }

    const photos = ctx.message?.photo;
    if (!photos || photos.length === 0) return;

    const topicId = getTopicId(ctx);
    const topicLabel = getTopicLabel(topicId);
    const caption = ctx.message?.caption || "";
    console.log(`\n[${topicLabel}] Photo received${caption ? `: ${caption.slice(0, 80)}...` : " (no caption)"}`);

    // Pick highest resolution (last element in PhotoSize array)
    const bestPhoto = photos[photos.length - 1];

    try {
      const downloaded = await downloadTelegramFile(token, bestPhoto.file_id);
      console.log(`  Downloaded: ${downloaded.localPath} (${(downloaded.sizeBytes / 1024).toFixed(0)} KB)`);

      // Build the message for Claude
      const parts: string[] = [
        `I've sent you a photo. It's saved at ${downloaded.localPath} — use the Read tool to view it.`,
      ];
      if (caption) {
        parts.push(`\nCaption: ${caption}`);
      }
      const claudeMessage = parts.join("");
      const logLabel = caption ? `[Photo] ${caption}` : "[Photo]";

      markProcessed(updateId); // Acknowledge before processing — prevents replay on crash
      await processAndRespond(ctx, claudeMessage, logLabel);
    } catch (err) {
      markProcessed(updateId); // Also mark on download error — don't retry broken downloads
      console.error(`  [${topicLabel}] Photo download error:`, err);
      try {
        await reply(ctx, `Failed to process photo: ${err instanceof Error ? err.message : String(err)}`);
      } catch (replyErr) {
        console.error(`  [${topicLabel}] Failed to send error reply:`, replyErr);
      }
    }
  });

  bot.on("message:text", async (ctx: Context) => {
    if (!isAllowed(ctx)) {
      console.log(`Rejected message from chat ${ctx.chat?.id}`);
      return;
    }

    // Skip already-processed updates (prevents restart replay loops)
    const updateId = ctx.update.update_id;
    if (isAlreadyProcessed(updateId)) {
      console.log(`Skipping already-processed text update ${updateId}`);
      return;
    }

    const userMessage = ctx.message?.text;
    if (!userMessage) return;

    // In group mode, respond to all messages (private group — no @mention required)
    // In DM mode, respond to all messages (direct conversation)

    const topicId = getTopicId(ctx);
    const topicLabel = getTopicLabel(topicId);

    // Strip the bot mention from the message (if present in group mode)
    const botUsername = bot.botInfo?.username;
    const cleanMessage = botUsername
      ? userMessage.replace(new RegExp(`@${botUsername}\\b`, "g"), "").trim()
      : userMessage;

    console.log(`\n[${topicLabel}] Message received: ${cleanMessage.slice(0, 100)}...`);

    markProcessed(updateId); // Acknowledge before processing — prevents replay on crash
    await processAndRespond(ctx, cleanMessage, cleanMessage);
  });

  return bot;
}
