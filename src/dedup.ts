import * as fs from "fs";
import * as path from "path";
import * as os from "os";

const SESSIONS_DIR = process.env.BRIDGE_SESSIONS_DIR
  || path.join(os.homedir(), ".claude-bridge-sessions");

const DEDUP_FILE = path.join(SESSIONS_DIR, "_processed_updates.json");
const MAX_STORED = 200;

interface DedupState {
  processedIds: number[];
}

function loadState(): DedupState {
  try {
    return JSON.parse(fs.readFileSync(DEDUP_FILE, "utf-8"));
  } catch {
    return { processedIds: [] };
  }
}

function saveState(state: DedupState): void {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }
  fs.writeFileSync(DEDUP_FILE, JSON.stringify(state));
}

export function isAlreadyProcessed(updateId: number): boolean {
  const state = loadState();
  return state.processedIds.includes(updateId);
}

export function markProcessed(updateId: number): void {
  const state = loadState();
  state.processedIds.push(updateId);
  // Keep only the most recent entries
  if (state.processedIds.length > MAX_STORED) {
    state.processedIds = state.processedIds.slice(-MAX_STORED);
  }
  saveState(state);
}
