import { spawn } from "child_process";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";

export interface ToolCall {
  name: string;
  summary: string;
}

export interface PermissionDenial {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface ClaudeResult {
  result: string;
  sessionId: string;
  durationMs: number;
  isError: boolean;
  toolCalls: ToolCall[];
  permissionDenials: PermissionDenial[];
}

export type ProgressCallback = (info: { elapsedMin: number; toolCallCount: number }) => void;

const PROGRESS_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const SAFETY_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes — hard safety net

// Tools pre-approved without Telegram confirmation. Bash requires explicit approval.
const ALLOWED_TOOLS = [
  "Read", "Edit", "Write", "Glob", "Grep",
  "Task", "TaskOutput", "WebFetch", "WebSearch",
  "NotebookEdit", "Skill", "EnterPlanMode", "ExitPlanMode",
  "AskUserQuestion", "TaskCreate", "TaskGet", "TaskUpdate",
  "TaskList", "TaskStop",
];

function detectClaudePath(): string {
  // Explicit env var takes priority
  if (process.env.CLAUDE_PATH) return process.env.CLAUDE_PATH;

  // Auto-detect common install locations
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

  console.error("Could not find 'claude' binary.");
  console.error("Run 'which claude' to find the path, then set CLAUDE_PATH:");
  console.error("  export CLAUDE_PATH=/path/to/claude");
  process.exit(1);
}

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
    case "Task":
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
  // Ensure single-line — strip any surviving newlines
  return summary.replace(/[\r\n]+/g, " ").trim();
}

const CLAUDE_PATH = detectClaudePath();

const SAFETY_PROMPT = fs.readFileSync(
  path.join(__dirname, "safety-prompt.txt"),
  "utf-8"
);

function spawnClaude(
  sessionId: string,
  message: string,
  useResume: boolean,
  extraAllowedTools: string[] = [],
  onProgress?: ProgressCallback
): Promise<ClaudeResult> {
  return new Promise((resolve) => {
    const tools = [...ALLOWED_TOOLS, ...extraAllowedTools];
    const args = [
      "-p",
      ...(useResume
        ? ["--resume", sessionId]
        : ["--session-id", sessionId]),
      "--allowed-tools", tools.join(","),
      "--permission-mode", "default",
      "--verbose",
      "--output-format",
      "stream-json",
      "--append-system-prompt",
      SAFETY_PROMPT,
      message,
    ];

    console.log(`  Spawning: claude ${args.slice(0, 3).join(" ")} ...`);

    const proc = spawn(CLAUDE_PATH, args, {
      cwd: os.homedir(),
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let wasTimedOut = false;

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Progress updates every 5 minutes
    const startTime = Date.now();
    let progressToolCount = 0;
    const progressInterval = onProgress
      ? setInterval(() => {
          const elapsedMin = Math.round((Date.now() - startTime) / 60000);
          onProgress({ elapsedMin, toolCallCount: progressToolCount });
        }, PROGRESS_INTERVAL_MS)
      : null;

    // 60-minute hard safety net — prevents truly stuck processes
    const safetyTimer = setTimeout(() => {
      wasTimedOut = true;
      console.log("  Safety timeout (60 min) reached — killing Claude process");
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 5000);
    }, SAFETY_TIMEOUT_MS);

    proc.on("close", (code) => {
      if (progressInterval) clearInterval(progressInterval);
      clearTimeout(safetyTimer);

      if (code !== 0 && !stdout.trim()) {
        const errorMsg = stderr.trim() || `Claude exited with code ${code}`;
        console.log(`  Error: ${errorMsg.slice(0, 200)}`);
        resolve({
          result: `Error: ${errorMsg.slice(0, 4000)}`,
          sessionId,
          durationMs: 0,
          isError: true,
          toolCalls: [],
          permissionDenials: [],
        });
        return;
      }

      // Parse stream-json NDJSON output
      const lines = stdout.trim().split("\n").filter(Boolean);
      const toolCalls: ToolCall[] = [];
      let assistantText = "";
      const lineTypeCounts: Record<string, number> = {};
      let finalResult = "";
      let sessionIdFromOutput = sessionId;
      let durationMs = 0;
      let isError = false;
      let permissionDenials: PermissionDenial[] = [];

      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.type) {
            lineTypeCounts[obj.type] = (lineTypeCounts[obj.type] || 0) + 1;
          }
          if (obj.type === "assistant" && obj.message?.content) {
            for (const block of obj.message.content) {
              if (block.type === "tool_use") {
                toolCalls.push({
                  name: block.name,
                  summary: summarizeToolInput(block.name, block.input || {}),
                });
                progressToolCount = toolCalls.length;
              }
              if (block.type === "text" && block.text) {
                assistantText += block.text;
              }
            }
          }
          if (obj.type === "result") {
            finalResult = obj.result || assistantText || "(empty response)";
            sessionIdFromOutput = obj.session_id || sessionId;
            durationMs = obj.duration_ms || 0;
            isError = obj.is_error || false;
            permissionDenials = obj.permission_denials || [];
          }
        } catch { /* skip unparseable lines */ }
      }

      if (finalResult) {
        if (permissionDenials.length > 0) {
          console.log(`  Success: ${durationMs}ms, ${toolCalls.length} tool calls, ${permissionDenials.length} permission denials`);
        } else {
          console.log(`  Success: ${durationMs}ms, ${toolCalls.length} tool calls`);
        }
        resolve({
          result: finalResult,
          sessionId: sessionIdFromOutput,
          durationMs,
          isError,
          toolCalls,
          permissionDenials,
        });
      } else {
        // No result line found — never send raw JSON
        console.log(`  No result line found. Line types: ${JSON.stringify(lineTypeCounts)}, assistant text length: ${assistantText.length}`);

        let fallbackResult: string;

        if (wasTimedOut && assistantText) {
          fallbackResult = `(Timed out after ${SAFETY_TIMEOUT_MS / 60000} minutes — partial response below)\n\n${assistantText.slice(0, 3800)}`;
        } else if (wasTimedOut) {
          fallbackResult = `(Timed out after ${SAFETY_TIMEOUT_MS / 60000} minutes with no response text. Claude was likely busy with tool calls. You can ask "what did you do?" to get a summary.)`;
        } else if (assistantText) {
          fallbackResult = assistantText.slice(0, 4000);
        } else {
          fallbackResult = "(No response received from Claude. Check logs for details.)";
        }

        resolve({
          result: fallbackResult,
          sessionId,
          durationMs: 0,
          isError: wasTimedOut || !assistantText,
          toolCalls,
          permissionDenials,
        });
      }
    });

    proc.on("error", (err) => {
      if (progressInterval) clearInterval(progressInterval);
      clearTimeout(safetyTimer);
      console.log(`  Spawn error: ${err.message}`);
      resolve({
        result: `Spawn error: ${err.message}`,
        sessionId,
        durationMs: 0,
        isError: true,
        toolCalls: [],
        permissionDenials: [],
      });
    });

    console.log(`  Claude PID: ${proc.pid}`);
  });
}

export async function runClaude(
  sessionId: string,
  message: string,
  isFirstMessage: boolean,
  extraAllowedTools: string[] = [],
  onProgress?: ProgressCallback
): Promise<ClaudeResult> {
  const result = await spawnClaude(sessionId, message, !isFirstMessage, extraAllowedTools, onProgress);

  // If --session-id failed because session exists, retry with --resume
  if (result.isError && result.result.includes("already in use")) {
    console.log("  Session exists — retrying with --resume");
    return spawnClaude(sessionId, message, true, extraAllowedTools, onProgress);
  }

  // If --resume failed because session doesn't exist, retry with --session-id
  if (result.isError && result.result.includes("No session found")) {
    console.log("  Session not found — retrying with --session-id");
    return spawnClaude(sessionId, message, false, extraAllowedTools, onProgress);
  }

  return result;
}
