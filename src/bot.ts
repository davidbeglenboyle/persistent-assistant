import { Bot, Context, InputFile } from "grammy";
import { runAgent, ToolApprovalCallback, ProgressCallback, summarizeToolInput } from "./agent";
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
import * as fs from "fs";
import * as path from "path";

// --- Media marker support ---
// Claude can embed SEND_IMAGE:/path, SEND_DOCUMENT:/path etc. in responses
// to send files back to the user via Telegram.

interface MediaItem {
  type: "photo" | "document" | "audio" | "video";
  filePath: string;
  caption?: string;
}

const MEDIA_MARKER_RE = /^SEND_(IMAGE|DOCUMENT|AUDIO|VIDEO):(.+)$/gm;

function parseMediaMarkers(text: string): { cleanText: string; mediaItems: MediaItem[] } {
  const mediaItems: MediaItem[] = [];
  let match: RegExpExecArray | null;

  while ((match = MEDIA_MARKER_RE.exec(text)) !== null) {
    const typeMap: Record<string, MediaItem["type"]> = {
      IMAGE: "photo",
      DOCUMENT: "document",
      AUDIO: "audio",
      VIDEO: "video",
    };
    mediaItems.push({
      type: typeMap[match[1]] || "document",
      filePath: match[2].trim(),
    });
  }

  // Remove marker lines from the text
  const cleanText = text.replace(MEDIA_MARKER_RE, "").replace(/\n{3,}/g, "\n\n").trim();
  return { cleanText, mediaItems };
}

const PHOTO_SIZE_LIMIT = 10 * 1024 * 1024; // 10 MB
const OTHER_SIZE_LIMIT = 50 * 1024 * 1024; // 50 MB

async function sendMediaItem(
  ctx: Context,
  item: MediaItem,
  mode: "dm" | "group"
): Promise<string | null> {
  if (!fs.existsSync(item.filePath)) {
    return `File not found: ${item.filePath}`;
  }

  const stats = fs.statSync(item.filePath);
  const sizeLimit = item.type === "photo" ? PHOTO_SIZE_LIMIT : OTHER_SIZE_LIMIT;
  if (stats.size > sizeLimit) {
    const limitMB = sizeLimit / (1024 * 1024);
    return `File too large (${(stats.size / (1024 * 1024)).toFixed(1)} MB, limit ${limitMB} MB): ${item.filePath}`;
  }

  const threadId = ctx.message?.message_thread_id;
  const threadOpts = mode === "group" && threadId ? { message_thread_id: threadId } : {};
  const inputFile = new InputFile(item.filePath);
  const filename = path.basename(item.filePath);

  try {
    switch (item.type) {
      case "photo":
        await ctx.replyWithPhoto(inputFile, { caption: item.caption, ...threadOpts });
        break;
      case "document":
        await ctx.replyWithDocument(inputFile, { caption: item.caption, ...threadOpts });
        break;
      case "audio":
        await ctx.replyWithAudio(inputFile, { caption: item.caption, ...threadOpts });
        break;
      case "video":
        await ctx.replyWithVideo(inputFile, { caption: item.caption, ...threadOpts });
        break;
    }
    console.log(`  Sent ${item.type}: ${filename}`);
    return null;
  } catch (err) {
    return `Failed to send ${item.type} ${filename}: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// --- End media marker support ---

const APPROVAL_PATTERN = /^(yes|yeah|y|allow|go ahead|approved|do it|ok)$/i;

const TELEGRAM_MAX_LENGTH = 4096;

/**
 * Build a three-tier progress message:
 * 1. Cold start (no tool info yet): "Still working... 5 min elapsed (3 tool calls so far)"
 * 2. Fresh tool activity: "Still working... 5 min elapsed — on Agent (search Gmail)"
 * 3. Stuck warning (>= 3 min idle): "Still working... 10 min elapsed — stuck 4+ min on Bash (find ...) — will time out if stuck"
 */
function buildProgressMessage(info: {
  elapsedMin: number;
  toolCallCount: number;
  lastTool?: { name: string; summary: string };
  minSinceLastEvent?: number;
}): string {
  const { elapsedMin, toolCallCount, lastTool, minSinceLastEvent } = info;

  if (minSinceLastEvent != null && minSinceLastEvent >= 3 && lastTool) {
    return `Still working... ${elapsedMin} min elapsed — stuck ${minSinceLastEvent}+ min on ${lastTool.name} (${lastTool.summary}) — will time out if stuck`;
  }

  if (lastTool) {
    return `Still working... ${elapsedMin} min elapsed — on ${lastTool.name} (${lastTool.summary})`;
  }

  const toolNote = toolCallCount > 0 ? ` (${toolCallCount} tool calls so far)` : "";
  return `Still working... ${elapsedMin} min elapsed${toolNote}`;
}

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

  // Per-topic pending tool approval state (hold-and-release via Agent SDK canUseTool)
  const pendingApprovals = new Map<
    string,
    { resolve: (approved: boolean) => void; toolName: string; summary: string; timeout: ReturnType<typeof setTimeout> }
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

  // Redirect messages sent to the General topic in forum groups
  function redirectIfGeneral(ctx: Context): boolean {
    const topicId = getTopicId(ctx);
    if (topicId !== "general-topic") return false;

    const sessions = getAllSessions();
    const topicLines = sessions
      .filter(({ topicId: tid }) => tid !== "general" && tid !== "general-topic")
      .map(({ topicId: tid, state }) => {
        const name = state.topicName ? ` (${state.topicName})` : "";
        return `• Topic ${tid}${name}`;
      });

    const hint = topicLines.length > 0
      ? `Active topics:\n${topicLines.join("\n")}\n\nPlease resend your message in the appropriate topic.`
      : "No active topics yet. Create a topic in this group and send your message there.";

    reply(ctx, `Messages to the General topic are not processed.\n\n${hint}`).catch(() => {});
    return true;
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

  // Shared processing: enqueue Claude invocation, handle response, logging
  async function processAndRespond(
    ctx: Context,
    claudeMessage: string,
    logLabel: string
  ): Promise<void> {
    const topicId = getTopicId(ctx);
    const topicLabel = getTopicLabel(topicId);

    // Send typing indicator
    await sendTyping(ctx);

    // Keep typing indicator alive during long processing
    const typingInterval = setInterval(() => sendTyping(ctx), 4000);

    try {
      let result = await enqueue(topicId, async () => {
        const session = getOrCreateSession(topicId);
        const isFirst = !activeSessions.has(session.sessionId);

        console.log(
          `  [${topicLabel}] Running agent (${isFirst ? "new" : "resume"} session ${session.sessionId.slice(0, 8)}...)`
        );

        const onProgress: ProgressCallback = (info) => {
          reply(ctx, buildProgressMessage(info)).catch(() => {});
          console.log(`  [${topicLabel}] Progress: ${info.elapsedMin}min, ${info.toolCallCount} tool calls`);
        };

        // Hold-and-release tool approval via Agent SDK canUseTool callback.
        // When Claude wants to use a non-allowed tool (e.g. Bash), this callback:
        // 1. Posts the approval request to Telegram
        // 2. Stores a Promise resolver in pendingApprovals
        // 3. Waits for the user to reply "yes" (resolver called from text handler)
        // 4. Returns the decision — Claude continues or skips seamlessly
        const onToolApproval: ToolApprovalCallback = async (toolName, toolInput, summary) => {
          await reply(ctx, `🔐 Permission needed:\n• ${toolName}: ${summary}\nReply 'yes' to allow.`);
          console.log(`  [${topicLabel}] Awaiting approval for: ${toolName}: ${summary}`);

          return new Promise<boolean>((resolve) => {
            const timeout = setTimeout(() => {
              pendingApprovals.delete(topicId);
              resolve(false);
              reply(ctx, "(Tool approval timed out after 10 minutes.)").catch(() => {});
              console.log(`  [${topicLabel}] Tool approval timed out: ${toolName}`);
            }, 10 * 60 * 1000);

            pendingApprovals.set(topicId, { resolve, toolName, summary, timeout });
          });
        };

        const agentResult = await runAgent(
          session.sessionId,
          claudeMessage,
          isFirst,
          onToolApproval,
          onProgress
        );

        if (!agentResult.isError) {
          activeSessions.add(session.sessionId);
          incrementMessage(topicId);
        }

        return agentResult;
      });

      // Dead session / context limit recovery
      if (result.isError && (
        result.result.includes("context") ||
        result.result.includes("Session not found")
      )) {
        console.log(`  [${topicLabel}] Session error — rotating to fresh session`);
        const freshSession = newSession(topicId);
        activeSessions.delete(result.sessionId);
        console.log(`  [${topicLabel}] New session: ${freshSession.sessionId}`);

        result = await enqueue(topicId, async () => {
          const onProgress: ProgressCallback = (info) => {
            reply(ctx, buildProgressMessage(info)).catch(() => {});
          };

          const retryResult = await runAgent(
            freshSession.sessionId,
            claudeMessage,
            true,
            undefined, // no tool approval on retry
            onProgress
          );

          if (!retryResult.isError) {
            activeSessions.add(freshSession.sessionId);
            incrementMessage(topicId);
          }

          return retryResult;
        });

        if (!result.isError) {
          console.log(`  [${topicLabel}] Recovery succeeded with fresh session`);
        }
      }

      clearInterval(typingInterval);

      // Log the exchange (including tool calls for audit trail)
      logExchange(logLabel, result.result, result.toolCalls, topicId);

      // Parse media markers from Claude's response
      const { cleanText, mediaItems } = parseMediaMarkers(result.result);

      if (mediaItems.length > 0) {
        const errors: string[] = [];
        for (const item of mediaItems) {
          const err = await sendMediaItem(ctx, item, mode);
          if (err) errors.push(err);
        }

        let finalText = cleanText;
        if (errors.length > 0) {
          finalText += `\n\n⚠️ Media errors:\n${errors.map((e) => `• ${e}`).join("\n")}`;
        }
        if (finalText.trim()) {
          await reply(ctx, finalText);
        }
      } else {
        await reply(ctx, result.result);
      }

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
    const pending = pendingApprovals.get(topicId);
    if (pending) {
      clearTimeout(pending.timeout);
      pendingApprovals.delete(topicId);
      pending.resolve(false);
    }
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

  // --- Photo handler ---
  bot.on("message:photo", async (ctx: Context) => {
    if (!isAllowed(ctx)) {
      console.log(`Rejected photo from chat ${ctx.chat?.id}`);
      return;
    }

    const updateId = ctx.update.update_id;
    if (isAlreadyProcessed(updateId)) {
      console.log(`Skipping already-processed photo update ${updateId}`);
      return;
    }

    if (redirectIfGeneral(ctx)) return;

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

      const parts: string[] = [
        `I've sent you a photo. It's saved at ${downloaded.localPath} — use the Read tool to view it.`,
      ];
      if (caption) {
        parts.push(`\nCaption: ${caption}`);
      }
      const claudeMessage = parts.join("");
      const logLabel = caption ? `[Photo] ${caption}` : "[Photo]";

      markProcessed(updateId);
      await processAndRespond(ctx, claudeMessage, logLabel);
    } catch (err) {
      markProcessed(updateId);
      console.error(`  [${topicLabel}] Photo download error:`, err);
      try {
        await reply(ctx, `Failed to process photo: ${err instanceof Error ? err.message : String(err)}`);
      } catch (replyErr) {
        console.error(`  [${topicLabel}] Failed to send error reply:`, replyErr);
      }
    }
  });

  // --- Document handler ---
  bot.on("message:document", async (ctx: Context) => {
    if (!isAllowed(ctx)) {
      console.log(`Rejected document from chat ${ctx.chat?.id}`);
      return;
    }

    const updateId = ctx.update.update_id;
    if (isAlreadyProcessed(updateId)) {
      console.log(`Skipping already-processed document update ${updateId}`);
      return;
    }

    if (redirectIfGeneral(ctx)) return;

    const doc = ctx.message?.document;
    if (!doc) return;

    const topicId = getTopicId(ctx);
    const topicLabel = getTopicLabel(topicId);
    const caption = ctx.message?.caption || "";
    const fileName = doc.file_name || "unknown";
    console.log(`\n[${topicLabel}] Document received: ${fileName}${caption ? ` — ${caption.slice(0, 80)}...` : ""}`);

    try {
      const downloaded = await downloadTelegramFile(token, doc.file_id);
      console.log(`  Downloaded: ${downloaded.localPath} (${(downloaded.sizeBytes / 1024).toFixed(0)} KB)`);

      const parts: string[] = [
        `I've sent you a document. It's saved at ${downloaded.localPath} (filename: ${fileName}).`,
      ];
      if (caption) {
        parts.push(`\nCaption: ${caption}`);
      }
      const claudeMessage = parts.join("");
      const logLabel = caption ? `[Document: ${fileName}] ${caption}` : `[Document: ${fileName}]`;

      markProcessed(updateId);
      await processAndRespond(ctx, claudeMessage, logLabel);
    } catch (err) {
      markProcessed(updateId);
      console.error(`  [${topicLabel}] Document download error:`, err);
      try {
        await reply(ctx, `Failed to process document: ${err instanceof Error ? err.message : String(err)}`);
      } catch (replyErr) {
        console.error(`  [${topicLabel}] Failed to send error reply:`, replyErr);
      }
    }
  });

  // --- Audio handler ---
  bot.on("message:audio", async (ctx: Context) => {
    if (!isAllowed(ctx)) {
      console.log(`Rejected audio from chat ${ctx.chat?.id}`);
      return;
    }

    const updateId = ctx.update.update_id;
    if (isAlreadyProcessed(updateId)) {
      console.log(`Skipping already-processed audio update ${updateId}`);
      return;
    }

    if (redirectIfGeneral(ctx)) return;

    const audio = ctx.message?.audio;
    if (!audio) return;

    const topicId = getTopicId(ctx);
    const topicLabel = getTopicLabel(topicId);
    const caption = ctx.message?.caption || "";
    const fileName = audio.file_name || "audio";
    console.log(`\n[${topicLabel}] Audio received: ${fileName}`);

    try {
      const downloaded = await downloadTelegramFile(token, audio.file_id);
      console.log(`  Downloaded: ${downloaded.localPath} (${(downloaded.sizeBytes / 1024).toFixed(0)} KB)`);

      const parts: string[] = [
        `I've sent you an audio file. It's saved at ${downloaded.localPath} (filename: ${fileName}).`,
      ];
      if (caption) {
        parts.push(`\nCaption: ${caption}`);
      }
      const claudeMessage = parts.join("");
      const logLabel = caption ? `[Audio: ${fileName}] ${caption}` : `[Audio: ${fileName}]`;

      markProcessed(updateId);
      await processAndRespond(ctx, claudeMessage, logLabel);
    } catch (err) {
      markProcessed(updateId);
      console.error(`  [${topicLabel}] Audio download error:`, err);
      try {
        await reply(ctx, `Failed to process audio: ${err instanceof Error ? err.message : String(err)}`);
      } catch (replyErr) {
        console.error(`  [${topicLabel}] Failed to send error reply:`, replyErr);
      }
    }
  });

  // --- Voice message handler ---
  bot.on("message:voice", async (ctx: Context) => {
    if (!isAllowed(ctx)) {
      console.log(`Rejected voice message from chat ${ctx.chat?.id}`);
      return;
    }

    const updateId = ctx.update.update_id;
    if (isAlreadyProcessed(updateId)) {
      console.log(`Skipping already-processed voice update ${updateId}`);
      return;
    }

    if (redirectIfGeneral(ctx)) return;

    const voice = ctx.message?.voice;
    if (!voice) return;

    const topicId = getTopicId(ctx);
    const topicLabel = getTopicLabel(topicId);
    const fileName = `voice-${Date.now()}.ogg`;
    console.log(`\n[${topicLabel}] Voice message received (${voice.duration}s)`);

    try {
      const downloaded = await downloadTelegramFile(token, voice.file_id);
      console.log(`  Downloaded: ${downloaded.localPath} (${(downloaded.sizeBytes / 1024).toFixed(0)} KB)`);

      const claudeMessage = `I've sent you a voice message (${voice.duration}s). It's saved at ${downloaded.localPath} (filename: ${fileName}).`;
      const logLabel = `[Voice: ${voice.duration}s]`;

      markProcessed(updateId);
      await processAndRespond(ctx, claudeMessage, logLabel);
    } catch (err) {
      markProcessed(updateId);
      console.error(`  [${topicLabel}] Voice download error:`, err);
      try {
        await reply(ctx, `Failed to process voice message: ${err instanceof Error ? err.message : String(err)}`);
      } catch (replyErr) {
        console.error(`  [${topicLabel}] Failed to send error reply:`, replyErr);
      }
    }
  });

  // --- Video handler ---
  bot.on("message:video", async (ctx: Context) => {
    if (!isAllowed(ctx)) {
      console.log(`Rejected video from chat ${ctx.chat?.id}`);
      return;
    }

    const updateId = ctx.update.update_id;
    if (isAlreadyProcessed(updateId)) {
      console.log(`Skipping already-processed video update ${updateId}`);
      return;
    }

    if (redirectIfGeneral(ctx)) return;

    const video = ctx.message?.video;
    if (!video) return;

    const topicId = getTopicId(ctx);
    const topicLabel = getTopicLabel(topicId);
    const caption = ctx.message?.caption || "";
    const fileName = video.file_name || "video";
    console.log(`\n[${topicLabel}] Video received: ${fileName}`);

    try {
      const downloaded = await downloadTelegramFile(token, video.file_id);
      console.log(`  Downloaded: ${downloaded.localPath} (${(downloaded.sizeBytes / 1024).toFixed(0)} KB)`);

      const parts: string[] = [
        `I've sent you a video. It's saved at ${downloaded.localPath} (filename: ${fileName}).`,
      ];
      if (caption) {
        parts.push(`\nCaption: ${caption}`);
      }
      const claudeMessage = parts.join("");
      const logLabel = caption ? `[Video: ${fileName}] ${caption}` : `[Video: ${fileName}]`;

      markProcessed(updateId);
      await processAndRespond(ctx, claudeMessage, logLabel);
    } catch (err) {
      markProcessed(updateId);
      console.error(`  [${topicLabel}] Video download error:`, err);
      try {
        await reply(ctx, `Failed to process video: ${err instanceof Error ? err.message : String(err)}`);
      } catch (replyErr) {
        console.error(`  [${topicLabel}] Failed to send error reply:`, replyErr);
      }
    }
  });

  // --- Video note (round video) handler ---
  bot.on("message:video_note", async (ctx: Context) => {
    if (!isAllowed(ctx)) {
      console.log(`Rejected video note from chat ${ctx.chat?.id}`);
      return;
    }

    const updateId = ctx.update.update_id;
    if (isAlreadyProcessed(updateId)) {
      console.log(`Skipping already-processed video_note update ${updateId}`);
      return;
    }

    if (redirectIfGeneral(ctx)) return;

    const videoNote = ctx.message?.video_note;
    if (!videoNote) return;

    const topicId = getTopicId(ctx);
    const topicLabel = getTopicLabel(topicId);
    const fileName = `video-note-${Date.now()}.mp4`;
    console.log(`\n[${topicLabel}] Video note received (${videoNote.duration}s)`);

    try {
      const downloaded = await downloadTelegramFile(token, videoNote.file_id);
      console.log(`  Downloaded: ${downloaded.localPath} (${(downloaded.sizeBytes / 1024).toFixed(0)} KB)`);

      const claudeMessage = `I've sent you a round video message (${videoNote.duration}s). It's saved at ${downloaded.localPath} (filename: ${fileName}).`;
      const logLabel = `[VideoNote: ${videoNote.duration}s]`;

      markProcessed(updateId);
      await processAndRespond(ctx, claudeMessage, logLabel);
    } catch (err) {
      markProcessed(updateId);
      console.error(`  [${topicLabel}] Video note download error:`, err);
      try {
        await reply(ctx, `Failed to process video note: ${err instanceof Error ? err.message : String(err)}`);
      } catch (replyErr) {
        console.error(`  [${topicLabel}] Failed to send error reply:`, replyErr);
      }
    }
  });

  // --- Text message handler ---
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

    if (redirectIfGeneral(ctx)) return;

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

    // Check for pending tool approval (hold-and-release pattern)
    const pendingApproval = pendingApprovals.get(topicId);
    if (pendingApproval && APPROVAL_PATTERN.test(cleanMessage.trim())) {
      clearTimeout(pendingApproval.timeout);
      pendingApprovals.delete(topicId);
      pendingApproval.resolve(true);
      console.log(`  [${topicLabel}] Tool approved: ${pendingApproval.toolName}`);
      markProcessed(updateId);
      return;
    }
    if (pendingApproval) {
      clearTimeout(pendingApproval.timeout);
      pendingApprovals.delete(topicId);
      pendingApproval.resolve(false);
      console.log(`  [${topicLabel}] Tool denied (new message received): ${pendingApproval.toolName}`);
    }

    markProcessed(updateId); // Acknowledge before processing — prevents replay on crash
    await processAndRespond(ctx, cleanMessage, cleanMessage);
  });

  return bot;
}
