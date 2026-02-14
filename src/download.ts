import * as fs from "fs";
import * as path from "path";

const DOWNLOAD_DIR = "/tmp/telegram-bridge-images";

export interface DownloadedFile {
  localPath: string;
  sizeBytes: number;
}

interface TelegramFileResponse {
  ok: boolean;
  result?: { file_path?: string; file_size?: number };
}

export async function downloadTelegramFile(
  token: string,
  fileId: string
): Promise<DownloadedFile> {
  // 1. Resolve file_path via Telegram getFile API
  const apiUrl = `https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`;
  const resp = await fetch(apiUrl);
  if (!resp.ok) {
    throw new Error(`getFile failed: ${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as TelegramFileResponse;
  if (!data.ok || !data.result?.file_path) {
    throw new Error("getFile returned no file_path");
  }

  const remotePath = data.result.file_path;

  // 2. Ensure download directory exists
  if (!fs.existsSync(DOWNLOAD_DIR)) {
    fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  }

  // 3. Safe local filename: ISO timestamp + extension from remote path
  const ext = path.extname(remotePath) || ".jpg";
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const localPath = path.join(DOWNLOAD_DIR, `${timestamp}${ext}`);

  // 4. Download file content
  const fileUrl = `https://api.telegram.org/file/bot${token}/${remotePath}`;
  const fileResp = await fetch(fileUrl);
  if (!fileResp.ok) {
    throw new Error(`File download failed: ${fileResp.status}`);
  }

  const buffer = Buffer.from(await fileResp.arrayBuffer());
  fs.writeFileSync(localPath, buffer);

  return {
    localPath,
    sizeBytes: buffer.length,
  };
}

export function cleanupOldImages(
  maxAgeMs: number = 24 * 60 * 60 * 1000
): number {
  if (!fs.existsSync(DOWNLOAD_DIR)) return 0;

  const now = Date.now();
  let cleaned = 0;

  for (const file of fs.readdirSync(DOWNLOAD_DIR)) {
    const filePath = path.join(DOWNLOAD_DIR, file);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > maxAgeMs) {
        fs.unlinkSync(filePath);
        cleaned++;
      }
    } catch {
      /* skip files we can't stat */
    }
  }

  return cleaned;
}
