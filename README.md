# persistent-assistant

Control Claude Code from your phone via Telegram or Email.

Claude Code is the most capable way to use Claude — it can edit files, run terminal commands, manage git repos, search your codebase, and use MCP servers. But it requires you to be sitting at your laptop. Step away for a meeting, a commute, or a coffee and you lose access to all of that.

This project bridges that gap. It connects Telegram or Email to a Claude Code session running on your machine, giving you full Claude Code capabilities from anywhere. Ask it to check a file, run a script, push to GitHub, search your codebase — anything Claude Code can do, you can now do from your phone.

**Two channels, one architecture:**
* **Telegram** — instant, conversational, best for quick tasks and back-and-forth
* **Email** — asynchronous, works from any device with an email client, good for longer requests

## The Problem

**Claude.ai** (the web chat) is convenient and works from any device, but it operates in a sandbox. It cannot access your files, run commands, use git, connect to MCP servers, or interact with your machine in any way. It is a conversation partner, not a working partner.

**Claude Code** (the CLI) is the opposite — it has full access to your filesystem, terminal, and tools. It can write code, run tests, manage infrastructure, and use any MCP server you have configured. But it requires an interactive terminal session on your computer. The moment you walk away from the keyboard, you are disconnected from it.

**persistent-assistant** eliminates this trade-off. It runs a lightweight bot on your machine that forwards Telegram messages to Claude Code and sends the responses back. Your Claude Code session persists between messages — it remembers your conversation, your project context, and your working directory. You get the full power of Claude Code from wherever you happen to be.

## How It Works

```
Your phone (Telegram)
       ↓ sends message
Your bot (long-polling, no webhooks needed)
       ↓
Node.js process (grammy)
       ↓ FIFO queue (one message at a time)
       ↓ spawns:
claude -p --resume $SESSION_ID \
  --allowed-tools "Read,Edit,Write,..." \
  --permission-mode default \
  --output-format stream-json \
  --append-system-prompt "safety rules..." \
  "your message"
       ↓ waits for completion
       ↓ parses NDJSON response
Node.js process
       ↓ extracts response text
       ↓ splits if >4096 chars
Bot → sends reply to you on Telegram
```

Each Telegram message spawns a fresh Claude Code CLI process. There is no persistent background session to manage or keep alive. Session context is preserved because `--resume` loads the full conversation history from disk each time. If one invocation crashes, the next one works fine.

Long-polling means the bot works behind NAT, firewalls, and home routers without needing ngrok, a public URL, or a webhook server.

## Features

* **Full Claude Code capabilities** — File editing, bash commands, git operations, MCP servers, web search, everything Claude Code can do
* **Session persistence** — Conversation context preserved across messages via `--resume`
* **Forum/topic support** — Run in a Telegram forum group with separate Claude sessions per topic
* **Photo support** — Send images via Telegram for Claude to analyse using its multimodal Read tool
* **Update deduplication** — Prevents message replay on bot restarts
* **Progress updates** — Long-running tasks send "Still working..." updates every 5 minutes
* **Enforced tool permissions** — `--allowed-tools` whitelist pre-approves safe tools; denied tools are surfaced via Telegram for approval
* **Safety prompt** — An advisory system prompt that requires Claude to ask for confirmation before destructive actions (file deletion, force push, sending emails, etc.)
* **Chat ID whitelist** — Only your Telegram account can talk to the bot
* **Auto-split long responses** — Messages longer than Telegram's 4,096-character limit are split automatically
* **Daily conversation logs** — Every exchange logged to `logs/YYYY-MM-DD.md` with topic labels
* **Typing indicator** — Shows "typing..." in Telegram while Claude processes
* **Per-topic FIFO queues** — Messages within a topic are sequential; different topics process in parallel
* **Telegram commands** — `/new` to start a fresh session, `/status` to check session info, `/topics` to list all active topics

## Quick Start

The fastest way to set up:

1. Clone this repo
2. Open Claude Code in the repo directory:
   ```
   cd persistent-assistant
   claude
   ```
3. Say: **"help me set this up"**

Claude Code will read the `CLAUDE.md` file and walk you through creating a Telegram bot, getting your chat ID, storing credentials, and running the bridge. Setup takes about five minutes.

For manual setup, read [CLAUDE.md](CLAUDE.md) directly.

## Requirements

* **Node.js 18+** — `node --version` to check
* **Claude Code CLI** — installed and authenticated (`claude --version` to check)
* **Claude Max or API access** — Claude Code must be able to make API calls
* **Telegram account** — for the bot and your chat
* **macOS or Linux** — Windows should work via WSL but is untested

## Limitations and Risks

Read this section carefully before using.

1. **Tool permissions are enforced, not advisory.** The bridge uses `--allowed-tools` to whitelist safe tools (file reading, editing, search, web access). When Claude tries to use a tool that is not whitelisted — typically Bash — the bridge surfaces the exact command on Telegram and waits for your approval. This is a hard boundary enforced by Claude Code, not a prompt-level suggestion. However, pre-approved tools (Read, Write, Edit, Glob, Grep, etc.) execute without asking.

2. **The safety prompt is advisory.** On top of the enforced tool whitelist, an appended system prompt instructs Claude to ask for confirmation before destructive actions. Claude treats this with high priority in practice, but it is not a hard technical boundary.

3. **You cannot see intermediate actions.** You only see Claude's final text response. Between your message and that response, Claude may have edited files, searched your codebase, or taken other pre-approved actions you did not expect. The conversation log captures tool calls for post-hoc review.

4. **Single-user only.** One bot token supports one active connection. Running the bot on two machines simultaneously causes polling conflicts.

5. **Authentication is minimal.** The only access control is a Telegram chat ID whitelist. If someone obtains your bot token, they could potentially interact with the bot (though the chat ID check would reject their messages).

6. **This is a personal tool, not a production service.** It was built for individual use on a personal machine. It has no rate limiting, no audit logging beyond conversation logs, and no access control beyond the chat ID check.

## Architecture

```
persistent-assistant/
├── src/
│   ├── index.ts              # Telegram bridge entry point
│   ├── email-bridge.ts       # Email bridge entry point
│   ├── bot.ts                # Telegram bot (grammy, long-polling, text + photo handlers)
│   ├── gmail.ts              # Gmail API client (poll, read, download attachments, reply)
│   ├── claude.ts             # Spawns Claude Code CLI, parses JSON response (shared)
│   ├── queue.ts              # Per-topic FIFO queues (shared)
│   ├── session.ts            # Per-topic session persistence (shared)
│   ├── logger.ts             # Daily conversation logs with topic labels (shared)
│   ├── download.ts           # Download Telegram photos to /tmp/ + auto-cleanup
│   ├── dedup.ts              # Update deduplication (prevents restart replay)
│   ├── safety-prompt.txt     # Telegram safety rules (editable)
│   └── email-safety-prompt.txt  # Email safety rules (editable)
├── scripts/
│   ├── start.sh              # Telegram startup wrapper
│   └── setup-gmail-oauth.ts  # One-time Gmail OAuth setup
├── CLAUDE.md                 # Agent-facing setup guide
├── .env.example              # Credential template (both bridges)
└── package.json
```

The Telegram and Email bridges share `claude.ts` (CLI spawner), `queue.ts` (per-topic FIFO), `session.ts` (per-topic sessions), and `logger.ts` (daily logs). Each has its own entry point and safety prompt.

### Two-layer safety model

Safety is enforced at two levels:

**Layer 1: Tool whitelist (enforced by Claude Code)**

The bridge passes `--allowed-tools` with a whitelist of safe tools: Read, Edit, Write, Glob, Grep, Task, WebFetch, WebSearch, and others. Tools not on the list — primarily Bash — are denied by Claude Code at the engine level. When a denial occurs, the bridge shows the exact tool and input on Telegram and waits for approval. If you reply "yes", the bridge retries with that tool temporarily allowed.

**Layer 2: Safety prompt (advisory)**

The file `src/safety-prompt.txt` is injected into every invocation via `--append-system-prompt`. It adds five confirmation rules:

1. **Destructive operations** — describe and wait for "yes" before deleting, force-pushing, etc.
2. **Externally visible actions** — show exact content before pushing code, sending emails, etc.
3. **Bulk operations** — list affected files before modifying more than three
4. **Ambiguous requests** — ask for clarification when messages are vague
5. **Multi-step tasks** — outline the plan before executing 5+ tool calls

Both layers use the same confirmation flow: Claude asks "should I proceed?", you reply "yes" on Telegram, and the next `--resume` invocation picks up the context and executes.

You can edit `src/safety-prompt.txt` to add your own rules without touching any TypeScript.

## Forum/Topic Mode

By default, the bridge runs in DM mode — one session for direct messages. To run in a Telegram forum group with separate topics, set `BRIDGE_MODE=group`.

### Setting up a forum group

1. Create a Telegram group and enable "Topics" in group settings
2. Create topics for different contexts (e.g. "Work", "Personal", "Admin")
3. Add your bot to the group and make it an admin
4. Get the group's chat ID (it will be a negative number like `-100123456789`)
5. Set your environment variables:
   ```bash
   export TELEGRAM_CHAT_ID="-100123456789"
   export BRIDGE_MODE=group
   ```

### How topics work

Each topic in the forum group gets its own isolated Claude session. Messages in one topic have no visibility into conversations in other topics. This is useful for maintaining separate contexts — a "Work" topic keeps your work conversations separate from a "Personal" topic.

Topics are processed in parallel — a long-running task in one topic does not block other topics. Within each topic, messages are queued and processed sequentially (safe for `--resume`).

The General topic in Telegram forum groups has a quirk: the Bot API sometimes omits `message_thread_id` for it. The bridge handles this by routing those messages to a dedicated `"general-topic"` session rather than the DM catch-all.

### Topic commands

* `/new` — Starts a fresh session for the current topic only (other topics unaffected)
* `/status` — Shows session info for the current topic
* `/topics` — Lists all active topics with message counts

### Multiple chat IDs

You can allow multiple chats (e.g. both a DM and a group) by comma-separating the IDs:

```bash
export TELEGRAM_CHAT_ID="123456789,-100987654321"
```

## Photo Support

Send photos via Telegram and Claude will analyse them using its multimodal Read tool. Photos are downloaded to `/tmp/telegram-bridge-images/` and cleaned up automatically after 24 hours.

* Include a caption with the photo to provide context
* The highest resolution version is always selected
* Photos work in both DM and forum/topic modes

## Email Bridge

The email bridge polls Gmail for matching emails, spawns Claude Code, and replies in the same email thread. It supports two trigger modes:

1. **Plus-address mode** (recommended): forward any email to a plus-addressed email (e.g. `you+claude@gmail.com`). The email subject and body become the prompt. No special formatting required.
2. **Keyword mode**: email yourself with a keyword prefix in the subject (e.g. `CLAUDE: your question`). This was the original approach but is less convenient on mobile.

Both modes download email attachments to disk and include their file paths in the prompt, so Claude can read and process them using its tools.

### How it works

```
You (any email client)
       ↓ forward email to you+claude@gmail.com (plus-address mode)
       ↓  — or email yourself with "CLAUDE: question" subject (keyword mode)
Gmail inbox
       ↓ polled every 60 seconds
Node.js process
       ↓ verifies sender matches GMAIL_ALLOWED_SENDER
       ↓ downloads attachments to /tmp/email-bridge-attachments/
       ↓ extracts prompt from subject + body + attachment paths
       ↓ FIFO queue → spawns claude -p --resume
       ↓ parses response
Gmail API
       ↓ sends reply in same thread
You receive the reply
```

### Privacy safeguards

* **Sender whitelist** — only processes emails from `GMAIL_ALLOWED_SENDER`
* **Reply-to-sender only** — always replies to the allowed sender address (not the plus-address), never adds CC/BCC
* **No recipient inference** — even if you mention someone in the body, Claude never adds people to the thread
* **Loop prevention** — Claude's own replies are skipped (SENT label without INBOX). The reply also goes to the base address (no plus-suffix), so it doesn't match the trigger search
* **Body cap** — email body truncated at 30KB to prevent oversized forwarded threads from overwhelming context
* **Processed-ID tracking** — local file (`~/.email-bridge-processed.json`) prevents re-processing after restarts

### Attachment handling

When an email contains attachments, the bridge:

1. Downloads each attachment to `/tmp/email-bridge-attachments/{messageId}/`
2. Appends a list of file paths, sizes, and MIME types to the prompt
3. Claude decides how to handle each attachment based on size and relevance:
   * **Small files (<50KB)**: read directly into context
   * **Medium files (50–200KB)**: read directly or delegate to a sub-agent
   * **Large files (>200KB)**: use a sub-agent to summarise
   * **Images and PDFs**: Claude reads these natively (multimodal)

Attachments are stored in `/tmp`, so they are automatically cleaned on reboot.

### Email bridge setup

1. **Create Google OAuth credentials:**
   * Go to https://console.cloud.google.com/apis/credentials
   * Create an OAuth 2.0 Client ID (Desktop app type)
   * Download JSON, save as `~/.config/gmail-bridge/credentials.json`
   * Enable Gmail API at https://console.cloud.google.com/apis/library/gmail.googleapis.com

2. **Run the OAuth consent flow:**
   ```bash
   npm run setup-gmail
   ```
   This opens your browser. Click "Allow", and the token is saved automatically.

3. **Configure and start:**

   **Plus-address mode** (recommended):
   ```bash
   export GMAIL_ALLOWED_SENDER=you@example.com
   export GMAIL_TRIGGER_ADDRESS=you+claude@example.com
   npm run email
   ```
   Then forward any email to `you+claude@example.com` — Claude reads it and replies in the same thread.

   **Keyword mode:**
   ```bash
   export GMAIL_ALLOWED_SENDER=you@example.com
   npm run email
   ```
   Then send yourself an email with subject `CLAUDE: your question`.

4. **Test it:** Forward an email (plus-address mode) or send `CLAUDE: what time is it?` (keyword mode) — you should receive a reply within about 90 seconds.

### Email commands

**Plus-address mode:**
* Forward any email to `you+claude@example.com` — subject and body become the prompt
* `NEW: your question` in the subject — starts a fresh session
* Reply to a Claude response — continues the conversation

**Keyword mode:**
* `CLAUDE: your question` — sends the question to Claude
* `CLAUDE NEW: your question` — starts a fresh session
* Reply to a Claude response — continues the conversation

### Email configuration

| Setting | Env var | Default |
|---------|---------|---------|
| Allowed sender | `GMAIL_ALLOWED_SENDER` | *(required)* |
| Trigger address | `GMAIL_TRIGGER_ADDRESS` | *(unset = keyword mode)* |
| Subject keyword | `GMAIL_KEYWORD` | `CLAUDE` |
| Poll interval | `GMAIL_POLL_INTERVAL` | `60` seconds |
| OAuth config dir | `GMAIL_CONFIG_DIR` | `~/.config/gmail-bridge` |
| Session file | `GMAIL_SESSION_FILE` | `~/.claude-email-session` |
| Attachment dir | `GMAIL_ATTACHMENT_DIR` | `/tmp/email-bridge-attachments` |
| Processed IDs | `GMAIL_PROCESSED_FILE` | `~/.email-bridge-processed.json` |

### Running both bridges

The Telegram and Email bridges run as separate processes with separate sessions. You can run both simultaneously:

```bash
# Terminal 1 (or launchd service 1)
npm start          # Telegram bridge

# Terminal 2 (or launchd service 2)
npm run email      # Email bridge
```

Each bridge maintains its own session UUID, so conversations are independent. Use Telegram for quick back-and-forth; use email for longer, asynchronous requests or forwarding documents for processing.

## Configuration

### Telegram settings

| Setting | Location | Default |
|---------|----------|---------|
| Claude binary path | `CLAUDE_PATH` env var | Auto-detected |
| Bridge mode | `BRIDGE_MODE` env var | `dm` |
| Tool whitelist | `ALLOWED_TOOLS` in `src/claude.ts` | All built-in tools except Bash |
| Safety timeout | `src/claude.ts` | 60 minutes (progress every 5 min) |
| Telegram message limit | `src/bot.ts` | 4,096 characters |
| Safety prompt | `src/safety-prompt.txt` | Editable text file |
| Sessions directory | `BRIDGE_SESSIONS_DIR` env var | `~/.claude-bridge-sessions` |
| Legacy session file | `BRIDGE_SESSION_FILE` env var | `~/.claude-bridge-session` (auto-migrated) |
| Working directory | `src/claude.ts` | Home directory |

## Running in the Background

### Quick: nohup

```bash
nohup bash scripts/start.sh > /tmp/persistent-assistant.log 2>&1 &
```

To stop: `pkill -f "tsx src/index.ts"`

### Robust: launchd (macOS)

For auto-start on login and auto-restart on crash, use a LaunchAgent. First, create a runtime copy outside any cloud-synced folder (launchd processes cannot access iCloud Drive or Dropbox paths due to macOS TCC restrictions):

```bash
mkdir -p ~/.persistent-assistant
rsync -av --exclude='node_modules' --exclude='logs' --exclude='.git' \
  ~/persistent-assistant/ ~/.persistent-assistant/
cd ~/.persistent-assistant && npm install
```

Create `~/Library/LaunchAgents/com.persistent-assistant.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.persistent-assistant</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/Users/YOU/.persistent-assistant/scripts/start.sh</string>
  </array>
  <key>WorkingDirectory</key>
  <string>/Users/YOU/.persistent-assistant</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>/Users/YOU/Library/Logs/persistent-assistant.log</string>
  <key>StandardErrorPath</key>
  <string>/Users/YOU/Library/Logs/persistent-assistant.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>/Users/YOU</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
```

Replace `/Users/YOU` with your actual home directory path (`echo $HOME`).

```bash
# Start
launchctl load ~/Library/LaunchAgents/com.persistent-assistant.plist

# Stop
launchctl unload ~/Library/LaunchAgents/com.persistent-assistant.plist

# Check status (PID in first column = running)
launchctl list | grep persistent-assistant

# View logs
tail -f ~/Library/Logs/persistent-assistant.log
```

Key details:
* `KeepAlive: true` — launchd restarts the process if it crashes
* `ThrottleInterval: 10` — minimum 10 seconds between restarts (prevents crash loops)
* `EnvironmentVariables` — launchd provides an extremely minimal environment; without explicit PATH, Node.js and the Claude CLI will not be found
* `RunAtLoad: true` — starts automatically when you log in

### Linux: systemd

The equivalent for Linux. Create `~/.config/systemd/user/persistent-assistant.service`:

```ini
[Unit]
Description=Telegram-Claude Bridge

[Service]
ExecStart=/usr/bin/bash /home/YOU/.persistent-assistant/scripts/start.sh
WorkingDirectory=/home/YOU/.persistent-assistant
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable persistent-assistant
systemctl --user start persistent-assistant
journalctl --user -u persistent-assistant -f
```

## Setting Up on a Second Machine

If you want to run the bot from a different computer, the code is portable but several things are machine-specific.

### Prerequisites

* Node.js 18+ installed
* Claude Code CLI installed and authenticated
* Credentials from the original machine (bot token and chat ID)

### 1. Clone or copy the project

```bash
git clone https://github.com/YOUR_USER/persistent-assistant.git
cd persistent-assistant
npm install
```

If the project is in a cloud-synced folder (Dropbox, iCloud), apply the `.nosync` pattern to prevent sync storms from `node_modules`:
```bash
mv node_modules node_modules.nosync && ln -s node_modules.nosync node_modules
```

### 2. Transfer credentials

Credentials are per-machine and do not sync automatically.

**If using `.env`:** Copy `.env` from the original machine, or create a new one from `.env.example` with the same token and chat ID.

**If using macOS Keychain:** Re-store the secrets on the new machine:
```bash
security add-generic-password -s "TELEGRAM_BOT_TOKEN" -a "persistent-assistant" -w "YOUR_TOKEN"
security add-generic-password -s "TELEGRAM_CHAT_ID" -a "persistent-assistant" -w "YOUR_CHAT_ID"
```

### 3. Check the Claude CLI path

The bridge auto-detects the Claude binary in common locations. Verify it is found:
```bash
which claude
```

If the path is non-standard, set `CLAUDE_PATH` in your `.env` file.

### 4. Create a runtime copy (if using launchd)

If running via launchd, create a local runtime copy outside cloud-synced folders:
```bash
mkdir -p ~/.persistent-assistant
rsync -av --exclude='node_modules' --exclude='logs' --exclude='.git' \
  ~/persistent-assistant/ ~/.persistent-assistant/
cd ~/.persistent-assistant && npm install
```

Always run `npm install` fresh in the runtime copy — `node_modules` contains platform-specific binaries (esbuild) that may differ between machines.

### 5. Stop on the old machine, start on the new one

Telegram long-polling allows only one active connection per bot token. Running the bot on two machines causes polling conflicts — messages may be received by only one instance unpredictably.

```bash
# On the OLD machine:
launchctl unload ~/Library/LaunchAgents/com.persistent-assistant.plist
# Or: pkill -f "tsx src/index.ts"

# On the NEW machine:
launchctl load ~/Library/LaunchAgents/com.persistent-assistant.plist
# Or: bash scripts/start.sh
```

### 6. Session state

The session file (`~/.claude-bridge-session`, or the path set in `BRIDGE_SESSION_FILE`) and Claude Code's conversation history (`~/.claude/projects/`) are both per-machine and do not sync. The new machine starts a fresh session. This is intentional — resuming a session created on a different machine would reference file paths and tool outputs that may not exist locally.

### Known quirks

* **macOS TCC warning on startup:** If the startup script includes an rsync to a cloud-synced folder, launchd processes will emit "Operation not permitted". This is cosmetic — launchd agents cannot access `~/Library/CloudStorage/` by design.
* **Node.js v25 punycode deprecation:** A warning about the `punycode` module appears on startup. Harmless, no impact on functionality.

## License

MIT
