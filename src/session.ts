import * as fs from "fs";
import * as crypto from "crypto";
import * as path from "path";
import * as os from "os";

const SESSIONS_DIR = process.env.BRIDGE_SESSIONS_DIR
  || path.join(os.homedir(), ".claude-bridge-sessions");

// Legacy single-file path for migration
const LEGACY_SESSION_FILE = process.env.BRIDGE_SESSION_FILE
  || path.join(os.homedir(), ".claude-bridge-session");

interface SessionState {
  sessionId: string;
  createdAt: string;
  messageCount: number;
  topicName?: string;
}

function ensureDir(): void {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

function sessionFile(topicId: string): string {
  return path.join(SESSIONS_DIR, `${topicId}.json`);
}

function loadState(topicId: string): SessionState | null {
  try {
    const data = fs.readFileSync(sessionFile(topicId), "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function saveState(topicId: string, state: SessionState): void {
  ensureDir();
  fs.writeFileSync(sessionFile(topicId), JSON.stringify(state, null, 2));
}

export function getOrCreateSession(topicId: string = "general"): SessionState {
  const existing = loadState(topicId);
  if (existing) return existing;

  // Migrate from legacy single-file if this is the "general" topic
  if (topicId === "general") {
    try {
      const legacyData = fs.readFileSync(LEGACY_SESSION_FILE, "utf-8");
      const legacy = JSON.parse(legacyData) as SessionState;
      saveState(topicId, legacy);
      return legacy;
    } catch {
      // No legacy file — create fresh
    }
  }

  const state: SessionState = {
    sessionId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    messageCount: 0,
  };
  saveState(topicId, state);
  return state;
}

export function newSession(topicId: string = "general"): SessionState {
  const state: SessionState = {
    sessionId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    messageCount: 0,
  };
  saveState(topicId, state);
  return state;
}

export function incrementMessage(topicId: string = "general"): SessionState {
  const state = getOrCreateSession(topicId);
  state.messageCount++;
  saveState(topicId, state);
  return state;
}

export function getSessionStatus(topicId: string = "general"): SessionState {
  return getOrCreateSession(topicId);
}

export function setTopicName(topicId: string, name: string): void {
  const state = getOrCreateSession(topicId);
  state.topicName = name;
  saveState(topicId, state);
}

export function getAllSessions(): { topicId: string; state: SessionState }[] {
  ensureDir();
  const results: { topicId: string; state: SessionState }[] = [];
  for (const file of fs.readdirSync(SESSIONS_DIR)) {
    if (!file.endsWith(".json")) continue;
    if (file.startsWith("_")) continue; // Skip internal files (e.g. _processed_updates.json)
    const topicId = file.replace(".json", "");
    const state = loadState(topicId);
    if (state && state.sessionId) results.push({ topicId, state });
  }
  return results;
}
