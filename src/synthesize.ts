/**
 * Haiku-powered message synthesis for Telegram bridge.
 *
 * Rewrites raw progress updates and permission requests into plain English
 * using Claude Haiku. Falls back to the raw message on any failure.
 * API key loaded from ANTHROPIC_API_KEY environment variable.
 */

let cachedApiKey: string | null = null;

function getApiKey(): string {
  if (cachedApiKey) return cachedApiKey;
  const key = process.env.ANTHROPIC_API_KEY || "";
  if (key) {
    cachedApiKey = key;
  }
  return key;
}

async function callHaiku(prompt: string): Promise<string | null> {
  const key = getApiKey();
  if (!key) return null;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 120,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    if (!response.ok) return null;

    const data = (await response.json()) as {
      content?: Array<{ text?: string }>;
    };
    return data.content?.[0]?.text?.trim() || null;
  } catch {
    return null;
  }
}

// --- Progress synthesis ---

export interface ProgressContext {
  userMessage: string;
  elapsedMin: number;
  toolCallCount: number;
  lastTool?: { name: string; summary: string };
  recentTools?: Array<{ name: string; summary: string }>;
}

export async function synthesizeProgress(ctx: ProgressContext): Promise<string> {
  const recentToolsText =
    ctx.recentTools && ctx.recentTools.length > 0
      ? ctx.recentTools.map((t) => `${t.name}: ${t.summary}`).join("\n")
      : "(no tools yet)";

  const currentTool = ctx.lastTool
    ? `${ctx.lastTool.name}: ${ctx.lastTool.summary}`
    : "unknown";

  const prompt = `You write short mobile-friendly status updates for a coding assistant running tasks on a laptop. The user checks these on their phone.

Rules:
- Write 1-2 short sentences in plain English
- No markdown formatting
- Replace raw file paths with just the folder/file name
- Translate tool names: Bash = running a command, Agent = sub-agent working on a subtask, TaskOutput = waiting for a sub-agent result, Read = reading a file, Grep = searching files, WebFetch = fetching a webpage
- Focus on WHAT is happening, not HOW (no tool names in the output)
- Include the time elapsed naturally

User asked: "${ctx.userMessage.slice(0, 200)}"
Running for: ${ctx.elapsedMin} min, ${ctx.toolCallCount} tool calls made
Currently on: ${currentTool}
Recent activity:
${recentToolsText}

Status update:`;

  const result = await callHaiku(prompt);
  if (result) return result;

  // Fallback: simplified version of the raw message
  const toolNote = ctx.lastTool ? ` — ${ctx.lastTool.name}` : "";
  return `Still working... ${ctx.elapsedMin} min elapsed${toolNote} (${ctx.toolCallCount} tool calls)`;
}

// --- Permission request synthesis ---

export async function synthesizePermission(
  toolName: string,
  summary: string,
  userMessage: string
): Promise<string> {
  const prompt = `Rewrite this coding tool permission request as a plain-English question for someone reading on their phone.

Rules:
- Start with 🔐
- Write 1 sentence explaining what the tool wants to do and why
- Replace raw file paths with just the meaningful folder/file name
- No markdown
- End with: Reply 'yes' to allow, or 'approve all' for all tools in this run.

User's task: "${userMessage.slice(0, 200)}"
Tool: ${toolName}
Technical details: ${summary}

Plain English version:`;

  const result = await callHaiku(prompt);
  if (result) {
    // Ensure it ends with the approval instruction
    const hasInstruction = result.includes("Reply");
    return hasInstruction
      ? result
      : `${result}\nReply 'yes' to allow, or 'approve all' for all tools in this run.`;
  }

  // Fallback: raw message
  return `🔐 Permission needed:\n• ${toolName}: ${summary}\nReply 'yes' to allow, or 'approve all' for all tools in this run.`;
}
