# persistent-assistant — Setup and Operation Guide

This file is read automatically by Claude Code. It contains interactive setup instructions and operational context for running the Telegram-to-Claude-Code bridge.

## Git Workflow

Always use pull requests for changes to this repo — never push directly to `main`. This is a public repo and people follow the commit history. Create a feature branch, push it, and open a PR with `gh pr create`.

## First-Time Setup

When the user asks for help setting up, walk them through each step interactively. Ask for their input at each step — do not skip ahead or assume values.

### Step 1: Create a Telegram Bot

Tell the user:

1. Open Telegram on your phone
2. Search for **@BotFather** and start a conversation
3. Send `/newbot`
4. BotFather will ask for a name (display name) — anything works, e.g. "My Claude Bridge"
5. BotFather will ask for a username (must end in `bot`) — e.g. `my_claude_bridge_bot`
6. BotFather will reply with a token like `123456789:ABCdefGHIjklMNOpqrSTUvwxYZ`

Ask the user to paste the token. Store it for the next step.

### Step 2: Get Your Chat ID

Tell the user:

1. Open Telegram and search for **@userinfobot**
2. Send any message to it
3. It replies with your numeric chat ID (e.g. `123456789`)

Ask the user to paste their chat ID.

### Step 3: Store Credentials

Detect the platform and offer the appropriate method:

**On macOS**, offer two options:
- **Option A: .env file** (simplest)
  ```bash
  cp .env.example .env
  ```
  Then edit `.env` and fill in `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` with the values from steps 1 and 2.

- **Option B: macOS Keychain** (more secure, no file on disk)
  ```bash
  security add-generic-password -s "TELEGRAM_BOT_TOKEN" -a "persistent-assistant" -w "PASTE_TOKEN_HERE"
  security add-generic-password -s "TELEGRAM_CHAT_ID" -a "persistent-assistant" -w "PASTE_CHAT_ID_HERE"
  ```

**On Linux**, use the .env file method:
```bash
cp .env.example .env
```
Edit `.env` with the token and chat ID.

### Step 4: Verify Claude Code CLI

Run `which claude` to check that Claude Code is installed. Expected outputs:
- `/opt/homebrew/bin/claude` — Apple Silicon Mac (Homebrew)
- `/usr/local/bin/claude` — Intel Mac (Homebrew) or Linux
- Other path — set `CLAUDE_PATH` in `.env` to the full path

If `which claude` returns nothing, Claude Code is not installed. Direct the user to install it:
```bash
npm install -g @anthropic-ai/claude-code
```

The bridge auto-detects the Claude binary in common locations. Only set `CLAUDE_PATH` explicitly if the path is non-standard.

### Step 5: Install Dependencies

```bash
npm install
```

If the project is in a Dropbox or iCloud folder, apply the `.nosync` pattern to prevent sync storms:
```bash
mv node_modules node_modules.nosync && ln -s node_modules.nosync node_modules
```

### Step 6: First Run

Start the bot:
```bash
npm start
```

Or use the startup script (which handles credential loading):
```bash
bash scripts/start.sh
```

Expected output:
```
Telegram-Claude Bridge starting...
Session: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
Messages so far: 0
Allowed chat ID: YOUR_CHAT_ID
Bot @your_bot_username is running. Send messages via Telegram.
```

Tell the user to send a test message via Telegram. They should receive a response from Claude within 10-60 seconds depending on the complexity of the message.

## Telegram Commands

- `/new` — Start a fresh Claude session for the current topic. Old session history remains on disk but is no longer resumed.
- `/status` — Show current session ID, creation time, message count, and queue depth for the current topic.
- `/topics` — List all active topics with message counts (useful in forum/group mode).

## Safety Prompt

The file `src/safety-prompt.txt` is injected into every Claude invocation via `--append-system-prompt`. It instructs Claude to ask for confirmation before:

1. Destructive operations (file deletion, force push, database drops)
2. Externally visible actions (git push, sending emails, posting comments)
3. Bulk operations (modifying 3+ files at once)
4. Ambiguous requests (vague messages like "clean up" or "fix it")
5. Multi-step tasks (anything requiring 5+ tool calls)

Users can edit this file freely to add custom rules. No TypeScript changes needed.

The safety prompt is **advisory, not enforced**. Claude treats appended system prompts with high priority in practice, but there is no hard technical boundary preventing Claude from acting without confirmation.

## Session Management

- Sessions stored in `~/.claude-bridge-sessions/` directory (one JSON file per topic)
- To use a different directory, set `BRIDGE_SESSIONS_DIR` in `.env` or your environment
- Legacy single-file sessions (`~/.claude-bridge-session`) are auto-migrated on first run
- In DM mode, all messages use the "general" topic; in group mode, each forum topic gets its own session
- Session conversation history stored by Claude Code at `~/.claude/projects/`
- `/new` creates a fresh UUID for the current topic; old history remains on disk
- Killing and restarting the bot resumes all sessions automatically
- Update deduplication prevents message replay on restart (tracked in `_processed_updates.json`)

## Working Directory

Claude Code runs with `cwd` set to the user's home directory by default. To change this, modify the `cwd` parameter in `src/claude.ts` (line where `spawn` is called, `cwd: os.homedir()`).

## Running in the Background

```bash
nohup bash scripts/start.sh > /tmp/persistent-assistant.log 2>&1 &
```

To stop:
```bash
pkill -f "tsx src/index.ts"
```

## Troubleshooting

### "Could not find 'claude' binary"
The auto-detection checks three common paths. If Claude is installed elsewhere:
```bash
which claude
# Then set in .env:
# CLAUDE_PATH=/your/path/to/claude
```

### Bot not responding to messages
1. Check terminal output for errors
2. Verify bot token: message @BotFather on Telegram, send `/mybots`, check the token matches
3. Verify chat ID: message @userinfobot, check the ID matches your `.env` or Keychain value
4. Only one instance can run per bot token — stop any other running instances

### "Rejected message from chat..."
Your Telegram chat ID doesn't match the `TELEGRAM_CHAT_ID` value. Double-check it with @userinfobot.

### Messages timing out
The hard safety timeout is 60 minutes, with progress updates sent every 5 minutes. Progress messages show elapsed time and tool call count. To adjust, edit `SAFETY_TIMEOUT_MS` or `PROGRESS_INTERVAL_MS` in `src/claude.ts`.

### "TELEGRAM_BOT_TOKEN not set"
Credentials not loaded. Check:
1. `.env` file exists and has values (not just empty lines)
2. Or Keychain entries are stored correctly (macOS)
3. Or environment variables are exported before running

## Tool Call Audit Trail

The bridge uses `--output-format stream-json` (with `--verbose`) to capture tool calls made by Claude during each message. The conversation log at `logs/YYYY-MM-DD.md` now includes a `*Tools:*` line after each response, showing which tools were used:

```markdown
## 04:21

**User:** What files are in the project?

**Claude:** I found 12 files in the src/ directory...

*Tools: Glob (src/**/*), Read (src/index.ts)*

---
```

The `summarizeToolInput` function in `claude.ts` produces human-readable summaries for common tools (Read, Edit, Bash, Glob, Grep, etc.). If no tools were used, the line is omitted.

## Email Bridge

The project also includes an email bridge (`src/email-bridge.ts`) that polls Gmail for keyword-prefixed emails. Setup requires:

1. Google Cloud OAuth credentials saved to `~/.config/gmail-bridge/credentials.json`
2. Gmail API enabled on the project
3. Running `npm run setup-gmail` for one-time consent
4. Setting `GMAIL_ALLOWED_SENDER` to the user's email address
5. Starting with `npm run email`

The email bridge reuses `claude.ts`, `queue.ts`, and `logger.ts` from the Telegram bridge. It has its own safety prompt at `src/email-safety-prompt.txt` and its own per-subject sessions file (default: `~/.claude-email-sessions.json`). Each unique subject line gets its own Claude session — `Re:` and `Fwd:` prefixes are stripped so replies continue the same session.

## Important Notes for Agents

- This project uses `--allowed-tools` to whitelist all built-in tools except Bash. When Claude needs Bash, the bridge asks the user via Telegram/email and retries with temporary permission if approved. The safety prompts in `src/safety-prompt.txt` and `src/email-safety-prompt.txt` provide an additional advisory layer.
- The `uuid` package is not used — session IDs use native `crypto.randomUUID()` (Node.js 18+).
- The `__dirname` reference in `claude.ts` resolves to `src/` at runtime via `tsx`. This works because `tsx` runs TypeScript directly without compiling to a separate `dist/` directory.
- Conversation logs go to `logs/` which is gitignored. These may contain sensitive information from the user's Claude sessions.
- The `googleapis` dependency is only used by the email bridge. The Telegram bridge does not require it.
