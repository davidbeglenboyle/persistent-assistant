# Changelog

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
