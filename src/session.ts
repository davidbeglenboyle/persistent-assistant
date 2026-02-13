import * as fs from "fs";
import * as crypto from "crypto";
import * as path from "path";
import * as os from "os";

const SESSION_FILE = process.env.BRIDGE_SESSION_FILE
  || path.join(os.homedir(), ".claude-bridge-session");

interface SessionState {
  sessionId: string;
  createdAt: string;
  messageCount: number;
}

function loadState(): SessionState | null {
  try {
    const data = fs.readFileSync(SESSION_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function saveState(state: SessionState): void {
  fs.writeFileSync(SESSION_FILE, JSON.stringify(state, null, 2));
}

export function getOrCreateSession(): SessionState {
  const existing = loadState();
  if (existing) return existing;

  const state: SessionState = {
    sessionId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    messageCount: 0,
  };
  saveState(state);
  return state;
}

export function newSession(): SessionState {
  const state: SessionState = {
    sessionId: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    messageCount: 0,
  };
  saveState(state);
  return state;
}

export function incrementMessage(): SessionState {
  const state = getOrCreateSession();
  state.messageCount++;
  saveState(state);
  return state;
}

export function getSessionStatus(): SessionState {
  return getOrCreateSession();
}
