import { spawn } from "child_process";
import * as os from "os";
import * as fs from "fs";
import * as path from "path";

export interface ClaudeResult {
  result: string;
  sessionId: string;
  durationMs: number;
  isError: boolean;
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
      "--output-format",
      "json",
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
        });
        return;
      }

      try {
        const json = JSON.parse(stdout);
        console.log(`  Success: ${json.duration_ms}ms`);
        resolve({
          result: json.result || "(empty response)",
          sessionId: json.session_id || sessionId,
          durationMs: json.duration_ms || 0,
          isError: json.is_error || false,
        });
      } catch {
        // JSON parse failed — return raw stdout
        const text = stdout.trim() || stderr.trim() || "(no output)";
        console.log(`  Parse error. Raw: ${text.slice(0, 200)}`);
        resolve({
          result: text.slice(0, 4000),
          sessionId,
          durationMs: 0,
          isError: true,
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
