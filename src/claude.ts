import { spawn } from "child_process";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";

export interface ToolCall {
  name: string;
  summary: string;
}

export interface ClaudeResult {
  result: string;
  sessionId: string;
  durationMs: number;
  isError: boolean;
  toolCalls: ToolCall[];
}

const TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

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

function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
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
  useResume: boolean
): Promise<ClaudeResult> {
  return new Promise((resolve) => {
    const args = [
      "-p",
      ...(useResume
        ? ["--resume", sessionId]
        : ["--session-id", sessionId]),
      "--dangerously-skip-permissions",
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

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      console.log("  Timeout reached — killing Claude process");
      proc.kill("SIGTERM");
      setTimeout(() => proc.kill("SIGKILL"), 5000);
    }, TIMEOUT_MS);

    proc.on("close", (code) => {
      clearTimeout(timer);

      if (code !== 0 && !stdout.trim()) {
        const errorMsg = stderr.trim() || `Claude exited with code ${code}`;
        console.log(`  Error: ${errorMsg.slice(0, 200)}`);
        resolve({
          result: `Error: ${errorMsg.slice(0, 4000)}`,
          sessionId,
          durationMs: 0,
          isError: true,
          toolCalls: [],
        });
        return;
      }

      // Parse stream-json NDJSON output
      const lines = stdout.trim().split("\n").filter(Boolean);
      const toolCalls: ToolCall[] = [];
      let finalResult = "";
      let sessionIdFromOutput = sessionId;
      let durationMs = 0;
      let isError = false;

      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.type === "assistant" && obj.message?.content) {
            for (const block of obj.message.content) {
              if (block.type === "tool_use") {
                toolCalls.push({
                  name: block.name,
                  summary: summarizeToolInput(block.name, block.input || {}),
                });
              }
            }
          }
          if (obj.type === "result") {
            finalResult = obj.result || "(empty response)";
            sessionIdFromOutput = obj.session_id || sessionId;
            durationMs = obj.duration_ms || 0;
            isError = obj.is_error || false;
          }
        } catch { /* skip unparseable lines */ }
      }

      if (finalResult) {
        console.log(`  Success: ${durationMs}ms, ${toolCalls.length} tool calls`);
        resolve({
          result: finalResult,
          sessionId: sessionIdFromOutput,
          durationMs,
          isError,
          toolCalls,
        });
      } else {
        // No result line found — fall back to raw output
        const text = stdout.trim() || stderr.trim() || "(no output)";
        console.log(`  No result line found. Raw: ${text.slice(0, 200)}`);
        resolve({
          result: text.slice(0, 4000),
          sessionId,
          durationMs: 0,
          isError: true,
          toolCalls: [],
        });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      console.log(`  Spawn error: ${err.message}`);
      resolve({
        result: `Spawn error: ${err.message}`,
        sessionId,
        durationMs: 0,
        isError: true,
        toolCalls: [],
      });
    });

    console.log(`  Claude PID: ${proc.pid}`);
  });
}

export async function runClaude(
  sessionId: string,
  message: string,
  isFirstMessage: boolean
): Promise<ClaudeResult> {
  const result = await spawnClaude(sessionId, message, !isFirstMessage);

  // If --session-id failed because session exists, retry with --resume
  if (result.isError && result.result.includes("already in use")) {
    console.log("  Session exists — retrying with --resume");
    return spawnClaude(sessionId, message, true);
  }

  // If --resume failed because session doesn't exist, retry with --session-id
  if (result.isError && result.result.includes("No session found")) {
    console.log("  Session not found — retrying with --session-id");
    return spawnClaude(sessionId, message, false);
  }

  return result;
}
