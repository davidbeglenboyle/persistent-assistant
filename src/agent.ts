/**
 * Agent SDK wrapper — replaces claude.ts subprocess management with
 * structured SDK calls via @anthropic-ai/claude-agent-sdk.
 *
 * The SDK manages CLI subprocess lifecycle, session persistence, and streaming
 * internally. Tool approval uses a hold-and-release pattern: the canUseTool
 * callback pauses execution until the caller (e.g., Telegram handler) resolves.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface ToolCall {
  name: string;
  summary: string;
}

export interface AgentResult {
  result: string;
  sessionId: string;
  durationMs: number;
  isError: boolean;
  toolCalls: ToolCall[];
}

/**
 * Called when Claude wants to use a tool that isn't pre-approved.
 * Return true to allow, false to deny. The agent pauses until this resolves.
 */
export type ToolApprovalCallback = (
  toolName: string,
  toolInput: Record<string, unknown>,
  summary: string
) => Promise<boolean>;

export type ProgressCallback = (info: {
  elapsedMin: number;
  toolCallCount: number;
  lastTool?: { name: string; summary: string };
  recentTools: Array<{ name: string; summary: string }>;
}) => void;

// Tools pre-approved without user confirmation.
// Bash is included — the advisory safety prompt in safety-prompt.txt provides
// guardrails for destructive operations. Removing Bash from this list caused
// repeated approval friction that made multi-step tasks unusable via Telegram.
const ALLOWED_TOOLS = [
  "Read", "Edit", "Write", "Glob", "Grep",
  "Bash",
  "WebFetch", "WebSearch", "NotebookEdit", "Skill",
  "TaskCreate", "TaskGet", "TaskUpdate", "TaskList",
  "TaskOutput", "TaskStop", "Agent",
];

/**
 * Find the Claude CLI binary. Checks CLAUDE_PATH env var first,
 * then probes common install locations.
 */
function detectClaudePath(): string {
  if (process.env.CLAUDE_PATH) return process.env.CLAUDE_PATH;

  const candidates = [
    "/opt/homebrew/bin/claude",                    // macOS Apple Silicon (Homebrew)
    "/usr/local/bin/claude",                       // macOS Intel (Homebrew) / Linux
    "/home/linuxbrew/.linuxbrew/bin/claude",       // Linux (Homebrew)
  ];

  for (const p of candidates) {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      continue;
    }
  }

  // Fall back to SDK's bundled binary (may trigger TCC prompts on macOS)
  console.warn("Could not find system 'claude' binary — using SDK bundled binary.");
  console.warn("Set CLAUDE_PATH to avoid macOS permission prompts on updates.");
  return "";
}

const CLAUDE_PATH = detectClaudePath();

const SAFETY_PROMPT = fs.readFileSync(
  path.join(__dirname, "safety-prompt.txt"),
  "utf-8"
);

const PROGRESS_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  let summary: string;
  switch (toolName) {
    case "Read":
      summary = String(input.file_path || "").split("/").slice(-2).join("/");
      break;
    case "Edit":
    case "Write":
      summary = String(input.file_path || "").split("/").slice(-2).join("/");
      break;
    case "Bash":
      summary = String(input.command || "").replace(/\n[\s\S]*/g, " ...").slice(0, 80);
      break;
    case "Glob":
      summary = String(input.pattern || "");
      break;
    case "Grep":
      summary = String(input.pattern || "");
      break;
    case "Agent":
      summary = String(input.description || "").slice(0, 60);
      break;
    case "Skill":
      summary = String(input.skill || "") + (input.args ? `: ${String(input.args).slice(0, 40)}` : "");
      break;
    case "WebFetch":
      summary = String(input.url || "").slice(0, 60);
      break;
    default:
      summary = JSON.stringify(input).slice(0, 60);
      break;
  }
  return summary.replace(/[\r\n]+/g, " ").trim();
}

export async function runAgent(
  sessionId: string,
  message: string,
  isFirstMessage: boolean,
  onToolApproval?: ToolApprovalCallback,
  onProgress?: ProgressCallback
): Promise<AgentResult> {
  const startTime = Date.now();
  const toolCalls: ToolCall[] = [];
  let resultText = "";
  let resultSessionId = sessionId;
  let isError = false;

  // Progress timer
  let progressTimer: ReturnType<typeof setInterval> | undefined;
  let lastTool: { name: string; summary: string } | undefined;

  if (onProgress) {
    progressTimer = setInterval(() => {
      const elapsedMin = Math.floor((Date.now() - startTime) / 60000);
      onProgress({ elapsedMin, toolCallCount: toolCalls.length, lastTool, recentTools: toolCalls.slice(-8) });
    }, PROGRESS_INTERVAL_MS);
  }

  try {
    const options: Record<string, unknown> = {
      allowedTools: ALLOWED_TOOLS,
      permissionMode: "bypassPermissions",
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: SAFETY_PROMPT,
      },
      cwd: os.homedir(),
    };

    // Use system Claude binary to reuse existing macOS TCC grants.
    // Without this, the SDK's bundled binary triggers new permission
    // prompts on every npm update.
    if (CLAUDE_PATH) {
      options.pathToClaudeCodeExecutable = CLAUDE_PATH;
    }

    // Session management: new session uses sessionId, subsequent messages use resume
    if (isFirstMessage) {
      options.sessionId = sessionId;
    } else {
      options.resume = sessionId;
    }

    // Tool approval: hold-and-release via canUseTool callback
    if (onToolApproval) {
      options.canUseTool = async (
        toolName: string,
        input: Record<string, unknown>,
        _opts: unknown
      ): Promise<PermissionResult> => {
        const summary = summarizeToolInput(toolName, input || {});
        const approved = await onToolApproval(toolName, input || {}, summary);
        if (approved) {
          return { behavior: "allow" as const, updatedInput: input };
        }
        return { behavior: "deny" as const, message: "User denied this action" };
      };
    }

    for await (const msg of query({ prompt: message, options: options as any })) {
      // Capture session ID from init message
      if (msg.type === "system" && "subtype" in msg && msg.subtype === "init") {
        resultSessionId = (msg as any).session_id || resultSessionId;
      }

      // Extract tool calls from assistant messages
      if (msg.type === "assistant" && "message" in msg) {
        const assistantMsg = msg as any;
        const content = assistantMsg.message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "tool_use") {
              const summary = summarizeToolInput(block.name, block.input || {});
              toolCalls.push({ name: block.name, summary });
              lastTool = { name: block.name, summary };
            }
          }
        }
      }

      // Capture final result
      if (msg.type === "result") {
        const resultMsg = msg as any;
        resultSessionId = resultMsg.session_id || resultSessionId;
        if (resultMsg.subtype === "success") {
          resultText = resultMsg.result || "";
        } else {
          resultText = resultMsg.result || resultMsg.errors?.join("; ") || "(error during execution)";
          isError = true;
        }
      }
    }
  } catch (err) {
    isError = true;
    const errMsg = err instanceof Error ? err.message : String(err);

    if (errMsg.includes("already in use")) {
      resultText = "Session is busy. Run /new to start a fresh session.";
    } else if (errMsg.includes("No session found")) {
      resultText = "Session not found. Run /new to start a fresh session.";
    } else {
      resultText = `Error: ${errMsg}`;
    }
  } finally {
    if (progressTimer) clearInterval(progressTimer);
  }

  return {
    result: resultText || "(empty response)",
    sessionId: resultSessionId,
    durationMs: Date.now() - startTime,
    isError,
    toolCalls,
  };
}
