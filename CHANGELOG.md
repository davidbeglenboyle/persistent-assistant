# Changelog

## 2026-02-13

### Configurable session file path
- `session.ts` now reads `BRIDGE_SESSION_FILE` env var, falling back to `~/.claude-bridge-session`
- Allows multiple bridge instances (Telegram, email) to use separate session files
- Updated `.env.example` with the new variable

### Security documentation
- Added `SECURITY.md` — comprehensive security analysis covering network exposure, credential risks, and the real threat surface
- Updated to reflect current `--allowed-tools` safety model

## 2026-02-09

### Email bridge — control Claude Code via email
- New `src/email-bridge.ts` entrypoint: polls Gmail for emails with a configurable keyword in the subject
- New `src/gmail.ts`: Gmail API client with OAuth token refresh, email parsing, and in-thread replies
- New `src/email-safety-prompt.txt`: advisory safety rules adapted for email context
- New `scripts/setup-gmail-oauth.ts`: one-time OAuth consent flow for Gmail API access
- Privacy-first design: only processes emails from a configured sender, only replies to that sender, never adds CC/BCC
- Configurable via environment variables: `GMAIL_ALLOWED_SENDER`, `GMAIL_KEYWORD`, `GMAIL_POLL_INTERVAL`
- Separate session from Telegram (stored at `~/.claude-email-session`)
- Subject prefix filter: Gmail search is loose, so code-level regex ensures only exact matches are processed
- `KEYWORD NEW:` subject prefix starts a fresh Claude session
- Reuses existing `claude.ts`, `queue.ts`, and `logger.ts` — no duplication
- Added `googleapis` dependency for Gmail API
- Updated `.env.example` with email bridge configuration
- Updated `.gitignore` to exclude OAuth credential files

## 2026-02-08

### Transfer documentation and background running guide
- Added "Setting Up on a Second Machine" section to README with complete transfer procedure
- Expanded "Running in the Background" with launchd (macOS) and systemd (Linux) configurations
- Documented known quirks: macOS TCC restrictions, platform-specific node_modules, session state

### Replace --dangerously-skip-permissions with tool whitelist + Telegram approval
- Remove `--dangerously-skip-permissions` from Claude spawn args
- Add `--allowed-tools` whitelist: all built-in tools except Bash pre-approved
- Parse `permission_denials` from stream-json output to detect denied tools
- When a tool is denied, append permission prompt to Telegram response
- User replies "yes" to allow; bridge re-runs with that tool temporarily permitted

### Fix NDJSON parsing: never send raw JSON to user
- Extract text blocks from `type: "assistant"` messages as fallback response source
- When `type: "result"` has empty `result` field, fall back to accumulated assistant text
- Replace raw stdout fallback with human-readable error/timeout messages
- Track `wasTimedOut` flag for specific timeout messaging

## 2026-02-07

### Tool call audit trail
- Switched `--output-format json` to `stream-json` with `--verbose` flag
- Added NDJSON parser to extract tool calls from `type: "assistant"` messages
- Added `summarizeToolInput` helper with human-readable summaries for common tools
- Conversation logs now include a `*Tools:*` line showing which tools Claude used

## 2026-02-06

### Initial release
- Per-message `claude -p --resume` architecture (no tmux, no webhooks)
- grammy bot with long-polling
- FIFO message queue (one Claude invocation at a time)
- Session UUID persistence across process restarts
- Daily conversation logs (logs/YYYY-MM-DD.md)
- Typing indicator while Claude processes
- Auto-split responses exceeding Telegram's 4,096-character limit
- `/new` and `/status` Telegram commands
- Advisory safety prompt (`src/safety-prompt.txt`)
- Chat ID whitelist for access control
