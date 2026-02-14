import * as fs from "fs";
import * as path from "path";
import type { ToolCall } from "./claude";

const LOGS_DIR = path.join(__dirname, "..", "logs");

function ensureLogsDir(): void {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

function todayFile(): string {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  return path.join(LOGS_DIR, `${yyyy}-${mm}-${dd}.md`);
}

function timeStamp(): string {
  const now = new Date();
  return now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

export function logExchange(
  userMessage: string,
  claudeResponse: string,
  toolCalls: ToolCall[] = [],
  topicId: string = "general"
): void {
  ensureLogsDir();
  const file = todayFile();
  const time = timeStamp();
  const topicLabel = topicId === "general" ? "" : ` [Topic ${topicId}]`;

  const parts = [
    `## ${time}${topicLabel}`,
    "",
    `**User:** ${userMessage}`,
    "",
    `**Claude:** ${claudeResponse}`,
    "",
  ];

  if (toolCalls.length > 0) {
    const toolSummary = toolCalls
      .map((tc) => `${tc.name} (${tc.summary})`)
      .join(", ");
    parts.push(`*Tools: ${toolSummary}*`, "");
  }

  parts.push("---", "");

  fs.appendFileSync(file, parts.join("\n"));
}
