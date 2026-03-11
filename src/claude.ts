import { spawn, execSync } from "child_process";
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
  deadSession: boolean;
  timedOut: boolean;
  toolCalls: ToolCall[];
  permissionDenials: PermissionDenial[];
}

export type ProgressCallback = (info: { elapsedMin: number; toolCallCount: number }) => void;

const PROGRESS_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const SAFETY_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes — hard safety net
const NO_OUTPUT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes — kill if zero stdout received

// Consecutive failure tracking for diagnostics
let consecutiveFailures = 0;
let lastDiagnosticTime = 0;
const FAILURE_THRESHOLD = 3;
const DIAGNOSTIC_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes between diagnostic runs

// Tools pre-approved without Telegram confirmation. Bash requires explicit approval.
const ALLOWED_TOOLS = [
  "Read", "Edit", "Write", "Glob", "Grep",
  "Task", "TaskOutput", "WebFetch", "WebSearch",
  "NotebookEdit", "Skill", "EnterPlanMode", "ExitPlanMode",
  "AskUserQuestion", "TaskCreate", "TaskGet", "TaskUpdate",
  "TaskList", "TaskStop", "Agent",
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
  // Ensure single-line — strip any surviving newlines
  return summary.replace(/[\r\n]+/g, " ").trim();
}

const CLAUDE_PATH = detectClaudePath();

const SAFETY_PROMPT = fs.readFileSync(
  path.join(__dirname, "safety-prompt.txt"),
  "utf-8"
);

function runDiagnosticScript(): void {
  console.log("  Running inline diagnostics after repeated failures...");

  // Check Claude CLI version
  try {
    const version = execSync(`${detectClaudePath()} --version 2>&1`, { timeout: 10000 }).toString().trim();
    console.log(`  [diag] Claude CLI version: ${version}`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  [diag] Claude CLI version check failed: ${msg}`);
  }

  // Check for competing Claude processes
  try {
    const procs = execSync('pgrep -f "claude.*-p" 2>/dev/null || true', { timeout: 5000 }).toString().trim();
    const count = procs ? procs.split("\n").length : 0;
    console.log(`  [diag] Competing Claude processes: ${count}`);
    if (procs) console.log(`  [diag] PIDs: ${procs.replace(/\n/g, ", ")}`);
  } catch {
    console.log("  [diag] Could not check competing processes");
  }

  // Check disk space
  try {
    const df = execSync(`df -h ${os.homedir()} 2>&1`, { timeout: 5000 }).toString().trim();
    const lines = df.split("\n");
    if (lines.length >= 2) {
      console.log(`  [diag] Disk space: ${lines[1]}`);
    }
  } catch {
    console.log("  [diag] Could not check disk space");
  }

  // Check session directory exists
  const sessionDir = path.join(os.homedir(), ".claude", "projects");
  try {
    const exists = fs.existsSync(sessionDir);
    console.log(`  [diag] Session dir (~/.claude/projects): ${exists ? "exists" : "MISSING"}`);
  } catch {
    console.log("  [diag] Could not check session directory");
  }
}

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

    // Clean environment: strip CLAUDE* and FORCE_COLOR vars to avoid interference
    const cleanEnv: Record<string, string> = {};
    for (const [key, val] of Object.entries(process.env)) {
      if (key.startsWith("CLAUDE") || key === "FORCE_COLOR") continue;
      if (val !== undefined) cleanEnv[key] = val;
    }
    cleanEnv.FORCE_COLOR = "0";
    cleanEnv.TERM = "dumb";

    const proc = spawn(CLAUDE_PATH, args, {
      cwd: os.homedir(),
      env: cleanEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let wasTimedOut = false;
    let firstStdoutTime: number | null = null;

    // 5-min no-output timer: kills process if zero stdout received
    const noOutputTimer = setTimeout(() => {
      if (!firstStdoutTime) {
        wasTimedOut = true;
        console.log("  No-output timeout (5 min) — zero stdout received, killing process");
        proc.kill("SIGKILL");
      }
    }, NO_OUTPUT_TIMEOUT_MS);

    proc.stdout.on("data", (chunk: Buffer) => {
      if (!firstStdoutTime) {
        firstStdoutTime = Date.now();
        clearTimeout(noOutputTimer);
        console.log(`  First stdout after ${Date.now() - startTime}ms`);
      }
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

    proc.on("close", (code, signal) => {
      if (progressInterval) clearInterval(progressInterval);
      clearTimeout(safetyTimer);
      clearTimeout(noOutputTimer);

      const elapsed = Date.now() - startTime;
      console.log(`  Close: code=${code}, signal=${signal}, elapsed=${elapsed}ms, stdout=${stdout.length}B, stderr=${stderr.length}B`);

      // Check timeout-with-zero-output FIRST (SIGKILL sets code=null)
      if (wasTimedOut && !stdout.trim()) {
        const stderrExcerpt = stderr.trim().slice(0, 500);
        console.log(`  Timed out with zero output. stderr: ${stderrExcerpt || "(empty)"}`);

        consecutiveFailures++;
        if (consecutiveFailures >= FAILURE_THRESHOLD && Date.now() - lastDiagnosticTime > DIAGNOSTIC_COOLDOWN_MS) {
          lastDiagnosticTime = Date.now();
          runDiagnosticScript();
        }

        resolve({
          result: `Claude process returned no response (timed out after ${Math.round(elapsed / 1000)}s with zero output). Exit code: ${code}, signal: ${signal}. ${stderrExcerpt ? `stderr: ${stderrExcerpt.slice(0, 200)}` : ""}`.trim(),
          sessionId,
          durationMs: 0,
          isError: true,
          deadSession: false,
          timedOut: true,
          toolCalls: [],
          permissionDenials: [],
        });
        return;
      }

      if (code !== 0 && !stdout.trim()) {
        const stderrExcerpt = stderr.trim().slice(0, 500);
        const errorMsg = stderrExcerpt || `Claude exited with code ${code}`;
        console.log(`  Error: ${errorMsg.slice(0, 200)}`);

        consecutiveFailures++;
        if (consecutiveFailures >= FAILURE_THRESHOLD && Date.now() - lastDiagnosticTime > DIAGNOSTIC_COOLDOWN_MS) {
          lastDiagnosticTime = Date.now();
          runDiagnosticScript();
        }

        resolve({
          result: `Error: ${errorMsg.slice(0, 4000)}`,
          sessionId,
          durationMs: 0,
          isError: true,
          deadSession: false,
          timedOut: false,
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

        consecutiveFailures = 0;

        resolve({
          result: finalResult,
          sessionId: sessionIdFromOutput,
          durationMs,
          isError,
          deadSession: false,
          timedOut: false,
          toolCalls,
          permissionDenials,
        });
      } else {
        // No result line found — never send raw JSON
        console.log(`  No result line found. Line types: ${JSON.stringify(lineTypeCounts)}, assistant text length: ${assistantText.length}`);

        // Dead session detection: resumed session that produced zero meaningful output
        const isDeadSession = useResume && !wasTimedOut && !assistantText && Object.keys(lineTypeCounts).length === 0;
        if (isDeadSession) {
          console.log("  Dead session detected: resume produced zero output lines");
        }

        let fallbackResult: string;

        if (wasTimedOut && assistantText) {
          fallbackResult = `(Timed out after ${SAFETY_TIMEOUT_MS / 60000} minutes — partial response below)\n\n${assistantText.slice(0, 3800)}`;
        } else if (wasTimedOut) {
          fallbackResult = `(Timed out after ${SAFETY_TIMEOUT_MS / 60000} minutes with no response text. Claude was likely busy with tool calls. You can ask "what did you do?" to get a summary.)`;
        } else if (assistantText) {
          fallbackResult = assistantText.slice(0, 4000);
        } else {
          fallbackResult = `Claude process returned no response (exit code: ${code}, signal: ${signal}, elapsed: ${Math.round(elapsed / 1000)}s). ${stderr.trim() ? `stderr excerpt: ${stderr.trim().slice(0, 200)}` : "Check logs for details."}`.trim();
        }

        if (!assistantText && !wasTimedOut) {
          consecutiveFailures++;
          if (consecutiveFailures >= FAILURE_THRESHOLD && Date.now() - lastDiagnosticTime > DIAGNOSTIC_COOLDOWN_MS) {
            lastDiagnosticTime = Date.now();
            runDiagnosticScript();
          }
        } else {
          consecutiveFailures = 0;
        }

        resolve({
          result: fallbackResult,
          sessionId,
          durationMs: 0,
          isError: wasTimedOut || !assistantText,
          deadSession: isDeadSession,
          timedOut: wasTimedOut,
          toolCalls,
          permissionDenials,
        });
      }
    });

    proc.on("error", (err) => {
      if (progressInterval) clearInterval(progressInterval);
      clearTimeout(safetyTimer);
      clearTimeout(noOutputTimer);
      console.log(`  Spawn error: ${err.message}`);
      resolve({
        result: `Spawn error: ${err.message}`,
        sessionId,
        durationMs: 0,
        isError: true,
        deadSession: false,
        timedOut: false,
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

  // If session is locked by a previous Claude process, wait and retry once
  if (result.isError && result.result.includes("already in use")) {
    console.log("  Session in use — waiting 10s for previous process to finish");
    await new Promise(r => setTimeout(r, 10000));
    const retry = await spawnClaude(sessionId, message, true, extraAllowedTools, onProgress);
    if (!retry.isError) return retry;
    // Still locked — return friendly error instead of looping
    console.log("  Session still in use after wait — returning error");
    return {
      result: "Session is busy (a previous request is still processing). Please try again in a few minutes.",
      sessionId,
      durationMs: 0,
      isError: true,
      deadSession: false,
      timedOut: false,
      toolCalls: [],
      permissionDenials: [],
    };
  }

  // If --resume failed because session doesn't exist, retry with --session-id
  if (result.isError && result.result.includes("No session found")) {
    console.log("  Session not found — retrying with --session-id");
    return spawnClaude(sessionId, message, false, extraAllowedTools, onProgress);
  }

  // Zero-output exit — retry once with --session-id (fresh attach)
  if (result.isError && result.result.includes("returned no response") && !result.deadSession) {
    console.log("  Zero-output exit — retrying with --session-id");
    return spawnClaude(sessionId, message, false, extraAllowedTools, onProgress);
  }

  // Timed out — retry once with --session-id
  if (result.timedOut && !result.deadSession) {
    console.log("  Timed out — retrying with --session-id");
    return spawnClaude(sessionId, message, false, extraAllowedTools, onProgress);
  }

  // Dead session — don't retry, caller should rotate session
  if (result.deadSession) {
    console.log("  Dead session detected — not retrying (caller should rotate session)");
    return result;
  }

  return result;
}
