/**
 * One-time OAuth setup for the Email-Claude Bridge.
 *
 * Prerequisites:
 *   1. Go to https://console.cloud.google.com/apis/credentials
 *   2. Create an OAuth 2.0 Client ID (Desktop app type)
 *   3. Download the JSON file
 *   4. Save it as ~/.config/gmail-bridge/credentials.json
 *      (or set GMAIL_CONFIG_DIR to a custom path)
 *   5. Enable the Gmail API at:
 *      https://console.cloud.google.com/apis/library/gmail.googleapis.com
 *
 * Then run: npx tsx scripts/setup-gmail-oauth.ts
 *
 * This opens a browser for consent, then saves the token.
 */

import * as fs from "fs";
import * as path from "path";
import * as http from "http";
import * as url from "url";
import { google } from "googleapis";

const CONFIG_DIR = process.env.GMAIL_CONFIG_DIR ||
  path.join(process.env.HOME || "", ".config", "gmail-bridge");
const CREDENTIALS_PATH = path.join(CONFIG_DIR, "credentials.json");
const TOKEN_PATH = path.join(CONFIG_DIR, "token.json");

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.send",
];

async function main(): Promise<void> {
  // Ensure config dir exists
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }

  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.error(`\nCredentials file not found at: ${CREDENTIALS_PATH}`);
    console.error(`\nTo set up:`);
    console.error(`1. Go to https://console.cloud.google.com/apis/credentials`);
    console.error(`2. Create OAuth 2.0 Client ID (type: Desktop app)`);
    console.error(`3. Download the JSON file`);
    console.error(`4. Save it as: ${CREDENTIALS_PATH}`);
    console.error(`5. Enable Gmail API at https://console.cloud.google.com/apis/library/gmail.googleapis.com`);
    console.error(`6. Run this script again\n`);
    process.exit(1);
  }

  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, "utf-8"));
  const { client_id, client_secret } = credentials.installed || credentials.web || {};

  if (!client_id || !client_secret) {
    console.error("Invalid credentials file — expected 'installed' or 'web' client type");
    process.exit(1);
  }

  const oauth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    "http://localhost:3847/oauth2callback"
  );

  if (fs.existsSync(TOKEN_PATH)) {
    console.log(`Existing token found at ${TOKEN_PATH}`);
    console.log("Delete it first if you want to re-authorize.\n");
    process.exit(0);
  }

  const authUrl = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: SCOPES,
    prompt: "consent",
  });

  console.log("\nOpening browser for Google consent...\n");

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const queryParams = new url.URL(req.url!, `http://localhost:3847`).searchParams;
        const authCode = queryParams.get("code");

        if (!authCode) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end("<h1>Error: No authorization code received</h1>");
          reject(new Error("No authorization code"));
          return;
        }

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h1>Authorization successful!</h1><p>You can close this tab.</p>");

        server.close();
        resolve(authCode);
      } catch (err) {
        reject(err);
      }
    });

    server.listen(3847, () => {
      const { exec } = require("child_process");
      exec(`open "${authUrl}" || xdg-open "${authUrl}"`);
    });

    setTimeout(() => {
      server.close();
      reject(new Error("Authorization timed out after 2 minutes"));
    }, 120000);
  });

  const { tokens } = await oauth2Client.getToken(code);

  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
  console.log(`\nToken saved to: ${TOKEN_PATH}`);
  console.log(`Scopes: ${SCOPES.join(", ")}`);
  console.log("\nSetup complete! You can now start the email bridge.\n");
}

main().catch((err) => {
  console.error("Setup failed:", err.message);
  process.exit(1);
});
