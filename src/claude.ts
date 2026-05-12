import { spawn, ChildProcess, execFileSync } from "child_process";
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
  deadSession: boolean; // true when --resume produced zero output (context limit hit)
  timedOut: boolean; // true when killed by no-output or safety timeout
  stalled: boolean; // true when killed by no-progress timeout (tool_use hung mid-stream)
  needsDelayedRetry: boolean; // true when both immediate attempts failed — caller should requeue after delay
  toolCalls: ToolCall[];
  permissionDenials: PermissionDenial[];
}

export type ProgressCallback = (info: {
  elapsedMin: number;
  toolCallCount: number;
  // Most recent tool_use block the CLI emitted, if any. Lets the bot show
  // "Waiting on Agent (Find Amazon purchase history doc)" in progress messages.
  lastTool?: { name: string; summary: string };
  // Minutes since the last meaningful stream-json event (any type except
  // rate_limit_event). >= 3 means the stream has gone quiet and a stall is
  // likely — the bot uses this to escalate the progress message.
  minSinceLastEvent?: number;
}) => void;

const PROGRESS_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const SAFETY_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes — hard safety net
const NO_OUTPUT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes — kill if zero stdout received
const NO_PROGRESS_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes — kill if stream produces no new events (stalled tool call)

// Consecutive failure tracking for diagnostics
let consecutiveFailures = 0;
let lastDiagnosticTime = 0;
const FAILURE_THRESHOLD = 3;
const DIAGNOSTIC_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes between diagnostic runs

// Most recent rate limit snapshot from stream-json. Observational only:
// the CLI explicitly ignores rate_limit_event messages internally (see the
// claude binary's sdkMessageAdapter — every rate_limit_event falls through to
// `{type: "ignored"}`). We log them for visibility but never act on them.
let lastRateLimitInfo: {
  fiveHourPct: number;
  sevenDayPct: number;
  fiveHourResetsAt: number;
  at: number;
} | null = null;

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

/**
 * Kill a child process AND all of its descendants.
 *
 * Requires the child to have been spawned with `detached: true` so it is the
 * leader of its own process group. We then send signals to -pgid (negative PID
 * = entire group) so subagent children, Bash subprocesses, etc. all die.
 *
 * Graceful first (SIGTERM), then SIGKILL after 3s if anything is still alive.
 * Falls back to direct proc.kill if the group kill errors (e.g. already dead).
 */
function killProcessTree(proc: ChildProcess, reason: string): void {
  if (!proc.pid) return;
  console.log(`  Killing process tree (pgid=${proc.pid}): ${reason}`);
  try {
    process.kill(-proc.pid, "SIGTERM");
    setTimeout(() => {
      if (proc.pid) {
        try {
          process.kill(-proc.pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }, 3000);
  } catch {
    // Fallback if group kill fails (permission, already dead, etc.)
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}

/**
 * Find any running processes whose command line contains the session UUID.
 * Used to detect orphan claude processes still holding a session lock.
 */
function findProcessesForSession(sessionId: string): number[] {
  try {
    const out = execFileSync("/usr/bin/pgrep", ["-f", sessionId], {
      timeout: 2000,
      encoding: "utf-8",
    }).trim();
    if (!out) return [];
    return out
      .split("\n")
      .filter(Boolean)
      .map((p: string) => parseInt(p, 10))
      .filter((n: number) => !Number.isNaN(n));
  } catch {
    // pgrep exits 1 when there are no matches — treat as "no orphans"
    return [];
  }
}

/**
 * Poll for up to maxMs waiting for any process holding this session ID to exit.
 * Returns true if released cleanly, false if still held at timeout.
 */
async function waitForSessionRelease(sessionId: string, maxMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const pids = findProcessesForSession(sessionId);
    if (pids.length === 0) return true;
    console.log(
      `  ${pids.length} process(es) still holding session ${sessionId.slice(0, 8)}: ${pids.join(", ")}`
    );
    await new Promise((r) => setTimeout(r, 5000));
  }
  return false;
}

/**
 * SIGKILL any orphan processes still holding a session lock.
 * Used as a last resort after waitForSessionRelease times out.
 */
function killSessionOrphans(sessionId: string): void {
  const pids = findProcessesForSession(sessionId);
  for (const pid of pids) {
    try {
      console.log(`  Killing orphan process ${pid}`);
      process.kill(pid, "SIGKILL");
    } catch (err) {
      console.log(
        `  Failed to kill ${pid}: ${err instanceof Error ? err.message : err}`
      );
    }
  }
}

/**
 * Quick probe: can the Claude CLI start at all? Spawns --version with 10s timeout.
 * If even --version hangs, the full invocation will certainly hang too.
 */
async function quickHealthCheck(): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(CLAUDE_PATH, ["--version"], {
      cwd: os.homedir(),
      env: {
        HOME: os.homedir(),
        PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
        FORCE_COLOR: "0",
        TERM: "dumb",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve(false);
    }, 10000);
    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
    proc.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function runDiagnosticScript(): void {
  console.log("  Running inline diagnostics after repeated failures...");

  // 1. Claude CLI version
  try {
    const version = execFileSync(CLAUDE_PATH, ["--version"], {
      timeout: 10000,
      encoding: "utf-8",
      env: { HOME: os.homedir(), PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin", FORCE_COLOR: "0", TERM: "dumb" },
    }).trim();
    console.log(`  [diag] Claude CLI version: ${version}`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`  [diag] Claude CLI version check failed: ${msg}`);
  }

  // 2. Display state (macOS only) — display-off correlates with CLI network hangs
  if (process.platform === "darwin") {
    try {
      const pmset = execFileSync("/usr/bin/pmset", ["-g", "log"], {
        timeout: 8000,
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      });
      const displayEvents = pmset.split("\n")
        .filter((l: string) => l.includes("Display is"))
        .slice(-3)
        .map((l: string) => {
          const match = l.match(/(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}).*?(Display is [a-z ]+)/);
          return match ? `${match[1]} ${match[2].trim()}` : l.trim().slice(0, 80);
        });
      console.log(`  [diag] Display (last 3): ${displayEvents.join(" | ") || "no events"}`);
    } catch {
      console.log("  [diag] Display check: failed");
    }
  }

  // 3. Bridge-spawned claude processes (session-specific, not unrelated)
  try {
    const pids = execFileSync("/usr/bin/pgrep", [
      "-f", "claude.*--(session-id|resume) [0-9a-f]",
    ], { timeout: 5000, encoding: "utf-8" }).trim().split("\n").filter(Boolean);
    console.log(`  [diag] Bridge claude processes: ${pids.length}${pids.length ? ` (${pids.join(", ")})` : ""}`);
  } catch {
    console.log("  [diag] Bridge claude processes: 0");
  }

  // 4. Disk space
  try {
    const df = execFileSync("/bin/df", ["-h", os.homedir()], { timeout: 5000, encoding: "utf-8" }).trim();
    const lines = df.split("\n");
    if (lines.length >= 2) {
      console.log(`  [diag] Disk space: ${lines[1]}`);
    }
  } catch {
    console.log("  [diag] Could not check disk space");
  }

  // 5. Session directory exists
  const sessionDir = path.join(os.homedir(), ".claude", "projects");
  try {
    const exists = fs.existsSync(sessionDir);
    console.log(`  [diag] Session dir (~/.claude/projects): ${exists ? "exists" : "MISSING"}`);
  } catch {
    console.log("  [diag] Could not check session directory");
  }

  // 6. Most recent rate-limit snapshot (informational only)
  if (lastRateLimitInfo) {
    const ageMin = Math.round((Date.now() - lastRateLimitInfo.at) / 60000);
    const resetIso = lastRateLimitInfo.fiveHourResetsAt
      ? new Date(lastRateLimitInfo.fiveHourResetsAt * 1000).toISOString()
      : "?";
    console.log(
      `  [diag] Last rate-limit (${ageMin}m ago): 5h ${lastRateLimitInfo.fiveHourPct}% (resets ${resetIso}), 7d ${lastRateLimitInfo.sevenDayPct}%`
    );
  } else {
    console.log("  [diag] Last rate-limit: none observed this run");
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
      // Make the child the leader of its own process group so killProcessTree
      // can nuke every descendant (subagents, Bash subprocesses, etc.) at once.
      detached: true,
    });

    console.log(`  Claude PID: ${proc.pid}`);

    let stdout = "";
    let stderr = "";
    let wasTimedOut = false;
    let wasStalled = false;
    let firstStdoutTime: number | null = null;

    // Stalled-progress detection state. We parse stream-json incrementally so
    // we can reset a sliding timer whenever a meaningful event arrives. If no
    // new event for NO_PROGRESS_TIMEOUT_MS, we kill with a useful diagnosis
    // (we know the last tool that was invoked).
    let stdoutBuffer = "";
    let lastToolUse: { name: string; summary: string; at: number } | null = null;
    let lastEventTime = Date.now();
    let progressTimer: NodeJS.Timeout | null = null;
    let progressToolCount = 0;

    const resetProgressTimer = () => {
      lastEventTime = Date.now();
      if (progressTimer) clearTimeout(progressTimer);
      progressTimer = setTimeout(() => {
        wasStalled = true;
        const waitingFor = lastToolUse
          ? `${lastToolUse.name} (${lastToolUse.summary})`
          : "unknown operation";
        console.log(
          `  No-progress timeout (${NO_PROGRESS_TIMEOUT_MS / 60000} min) — last activity: ${waitingFor}, killing`
        );
        killProcessTree(proc, `stalled on ${waitingFor}`);
      }, NO_PROGRESS_TIMEOUT_MS);
    };

    // 5-min no-output timer: kills process if zero stdout received
    const noOutputTimer = setTimeout(() => {
      if (!firstStdoutTime) {
        wasTimedOut = true;
        console.log("  No-output timeout (5 min) — zero stdout received, killing process");
        killProcessTree(proc, "no-output timeout (5 min)");
      }
    }, NO_OUTPUT_TIMEOUT_MS);

    proc.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      if (!firstStdoutTime) {
        firstStdoutTime = Date.now();
        clearTimeout(noOutputTimer);
        console.log(`  First stdout after ${Date.now() - startTime}ms`);
        // Start the stalled-progress clock once output is flowing
        resetProgressTimer();
      }
      stdout += text;
      stdoutBuffer += text;

      // Parse whole JSON lines out of the buffer as they complete. Lets us
      // detect progress (or the lack of it) in real time rather than waiting
      // for the final close-handler parse pass.
      let nl: number;
      while ((nl = stdoutBuffer.indexOf("\n")) !== -1) {
        const line = stdoutBuffer.slice(0, nl);
        stdoutBuffer = stdoutBuffer.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          // Any meaningful event resets the stall timer. rate_limit_event is
          // EXCLUDED because the CLI itself ignores these (they fire whenever
          // rate-limit headers change, which can include stale subagent
          // responses arriving during an otherwise-stuck run).
          if (obj.type && obj.type !== "rate_limit_event") {
            resetProgressTimer();
          }
          // Capture the most recent tool_use so the stall message (and the
          // progress callback) can name it. Also increment the running tool
          // count in real time.
          if (obj.type === "assistant" && obj.message?.content) {
            for (const block of obj.message.content) {
              if (block.type === "tool_use") {
                lastToolUse = {
                  name: block.name,
                  summary: summarizeToolInput(block.name, block.input || {}),
                  at: Date.now(),
                };
                progressToolCount++;
              }
            }
          }
          // Record rate limit info for observability (never act on it).
          if (obj.type === "rate_limit_event" && obj.rate_limit_info) {
            const fh = obj.rate_limit_info.five_hour;
            const sd = obj.rate_limit_info.seven_day;
            if (fh?.used_percentage != null || sd?.used_percentage != null) {
              lastRateLimitInfo = {
                fiveHourPct: Math.round(fh?.used_percentage ?? 0),
                sevenDayPct: Math.round(sd?.used_percentage ?? 0),
                fiveHourResetsAt: fh?.resets_at ?? 0,
                at: Date.now(),
              };
              const resetIso = fh?.resets_at
                ? new Date(fh.resets_at * 1000).toISOString()
                : "?";
              console.log(
                `  [rate-limit] 5h: ${lastRateLimitInfo.fiveHourPct}% (resets ${resetIso}), 7d: ${lastRateLimitInfo.sevenDayPct}%`
              );
            }
          }
        } catch {
          // Partial or unparseable line — skip
        }
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Progress updates every 5 minutes
    const startTime = Date.now();
    const progressInterval = onProgress
      ? setInterval(() => {
          const elapsedMin = Math.round((Date.now() - startTime) / 60000);
          const minSinceLastEvent = firstStdoutTime
            ? Math.round((Date.now() - lastEventTime) / 60000)
            : undefined;
          onProgress({
            elapsedMin,
            toolCallCount: progressToolCount,
            lastTool: lastToolUse
              ? { name: lastToolUse.name, summary: lastToolUse.summary }
              : undefined,
            minSinceLastEvent,
          });
        }, PROGRESS_INTERVAL_MS)
      : null;

    // 60-minute hard safety net — prevents truly stuck processes
    const safetyTimer = setTimeout(() => {
      wasTimedOut = true;
      console.log("  Safety timeout (60 min) reached — killing Claude process");
      killProcessTree(proc, "safety timeout (60 min)");
    }, SAFETY_TIMEOUT_MS);

    proc.on("close", (code, signal) => {
      if (progressInterval) clearInterval(progressInterval);
      if (progressTimer) clearTimeout(progressTimer);
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
          stalled: false,
          needsDelayedRetry: false,
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
          stalled: false,
          needsDelayedRetry: false,
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
                // progressToolCount is tracked in the streaming parser;
                // don't double-count it here.
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
          stalled: false,
          needsDelayedRetry: false,
          toolCalls,
          permissionDenials,
        });
      } else {
        // No result line found — never send raw JSON
        console.log(`  No result line found. Line types: ${JSON.stringify(lineTypeCounts)}, assistant text length: ${assistantText.length}`);

        // Dead session detection: resumed session that produced zero meaningful output
        const isDeadSession = useResume && !wasTimedOut && !wasStalled && !assistantText;

        let fallbackResult: string;

        if (wasStalled) {
          const waitingFor = lastToolUse
            ? `${lastToolUse.name} (${lastToolUse.summary})`
            : "unknown operation";
          const stallDurationMin = Math.round(NO_PROGRESS_TIMEOUT_MS / 60000);
          const parts = [
            `Warning: Task stalled after ${stallDurationMin} min waiting on: ${waitingFor}`,
            `The bridge killed the process. Run /new to start fresh, or rephrase and retry.`,
          ];
          if (assistantText) {
            parts.push(`\nPartial response so far:\n${assistantText.slice(0, 2500)}`);
          }
          fallbackResult = parts.join("\n");
        } else if (wasTimedOut && assistantText) {
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

        if (isDeadSession) {
          console.log("  Dead session detected: resume produced zero output lines");
        }

        resolve({
          result: fallbackResult,
          sessionId,
          durationMs: 0,
          isError: wasTimedOut || wasStalled || !assistantText,
          deadSession: isDeadSession,
          timedOut: wasTimedOut,
          stalled: wasStalled,
          needsDelayedRetry: false,
          toolCalls,
          // Drop permission denials on a stalled run — those are historical
          // artefacts from tools the CLI attempted before it hung.
          permissionDenials: wasStalled ? [] : permissionDenials,
        });
      }
    });

    proc.on("error", (err) => {
      if (progressInterval) clearInterval(progressInterval);
      if (progressTimer) clearTimeout(progressTimer);
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
        stalled: false,
        needsDelayedRetry: false,
        toolCalls: [],
        permissionDenials: [],
      });
    });
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

  // Smarter session-lock recovery: poll up to 30s for the lock to release,
  // then SIGKILL orphan processes still holding it, then retry.
  if (result.isError && result.result.includes("already in use")) {
    console.log("  Session in use — polling for lock release (up to 30s)");
    const released = await waitForSessionRelease(sessionId, 30000);
    if (!released) {
      console.log("  Session still held after 30s — killing orphans");
      killSessionOrphans(sessionId);
      await new Promise((r) => setTimeout(r, 2000));
    }
    const retry = await spawnClaude(sessionId, message, true, extraAllowedTools, onProgress);
    if (!retry.isError) return retry;
    // Still locked — return friendly error instead of looping
    console.log("  Session still in use after cleanup — returning error");
    return {
      result: "Session is busy (a previous request is still processing). Run /new to start a fresh session, or try again in a few minutes.",
      sessionId,
      durationMs: 0,
      isError: true,
      deadSession: false,
      timedOut: false,
      stalled: false,
      needsDelayedRetry: false,
      toolCalls: [],
      permissionDenials: [],
    };
  }

  // If --resume failed because session doesn't exist, retry with --session-id
  if (result.isError && result.result.includes("No session found")) {
    console.log("  Session not found — retrying with --session-id");
    return spawnClaude(sessionId, message, false, extraAllowedTools, onProgress);
  }

  // Dead session detected (context limit) — signal to caller for session rotation
  // IMPORTANT: must check BEFORE "returned no response" — dead sessions also match that string
  if (result.deadSession) {
    console.log("  Dead session — caller should rotate to a new session");
    return result;
  }

  // Zero-output exit on NEW session — retry once with --session-id
  if (result.isError && result.result.includes("returned no response") && isFirstMessage) {
    console.log("  Zero-output exit — retrying with --session-id");
    return spawnClaude(sessionId, message, false, extraAllowedTools, onProgress);
  }

  // No-output timeout — health check, then delayed retry
  if (result.timedOut) {
    console.log("  Timed out — running health check before retry");
    const healthy = await quickHealthCheck();
    if (!healthy) {
      console.log("  Health check failed — CLI cannot start, skipping immediate retry");
      result.needsDelayedRetry = true;
      result.result = "(Claude CLI is unresponsive — will automatically retry in 5 minutes.)";
      return result;
    }
    console.log("  Health check passed — waiting 30s before retry");
    await new Promise((r) => setTimeout(r, 30000));
    const retry = await spawnClaude(sessionId, message, false, extraAllowedTools, onProgress);
    if (retry.timedOut) {
      retry.needsDelayedRetry = true;
      retry.result = "(Both attempts timed out — will automatically retry in 5 minutes.)";
    }
    return retry;
  }

  // Stalled runs (10-min no-progress timeout): surface the stall message and
  // wait for the user. Intentionally no auto-retry — stalls are usually
  // deterministic on the same prompt, so retrying would hang again.
  return result;
}
