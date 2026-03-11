# Changelog

## 2026-03-11

### Production reliability — timeout hierarchy, dead session recovery, media support

Months of production operation surfaced failure modes that are now handled systematically. These changes reflect real-world fixes from running the bridge 24/7 as a macOS LaunchAgent.

#### Three-layer timeout hierarchy (claude.ts)
- **5-minute no-output timeout**: Kills processes that produce zero stdout. Successful calls produce first output within 30 seconds; hanging calls produce nothing ever. This bimodal distribution means 5 minutes is 10x the slowest success, cutting worst-case wait from 60 to 10 minutes.
- **60-minute safety timeout**: Hard cap for all processes, regardless of output. Catches legitimate-but-stuck operations.
- **65-minute queue timeout** (queue.ts): Defense-in-depth. Catches the theoretical edge case where a spawn promise never resolves.

#### Dead session detection and recovery
- Claude CLI exits instantly with zero output when a session hits its context limit. The bridge now detects this (`deadSession` flag) and signals the caller to rotate to a fresh session.
- Both Telegram and email bridges auto-rotate: create a new session UUID and retry once.

#### Retry logic (claude.ts)
Five conditions checked in order after each spawn, each fires at most once:
1. "already in use" — wait 10s, retry with `--resume`
2. "No session found" — retry with `--session-id`
3. Zero-output exit — retry with `--session-id`
4. No-output timeout (5-min timer) — retry with `--session-id`
5. Dead session — signal to caller (no retry in claude.ts)

#### Auto-diagnostics
After 3+ consecutive failures, inline diagnostics check Claude CLI version, competing processes, disk space, and session directory. Results logged to console. 30-minute cooldown between runs.

#### 409 conflict recovery (index.ts)
When the bridge restarts, Telegram's long-poll timeout is 30 seconds. If the new instance starts polling before the old connection expires, Telegram rejects with 409 Conflict. Fix: 35-second initial delay, `deleteWebhook` call, and retry loop (5 attempts).

#### Heartbeat logging
Both bridges now log periodic heartbeats (Telegram: every 30 minutes with uptime and queue depth; email: every 10 polls). A running bridge no longer looks identical to a dead one.

#### Health check on startup
Telegram bridge runs `claude --version` before polling to catch CLI issues early.

#### Media support (bot.ts)
- **Outbound file sending**: Claude can include `SEND_IMAGE:`, `SEND_DOCUMENT:`, `SEND_AUDIO:`, `SEND_VIDEO:` markers in responses. The bridge strips markers, sends files via Telegram API, then sends remaining text. Size limits enforced (10MB photos, 50MB others).
- **Inbound media handlers**: Document, audio, voice, video, and video note handlers — not just photos. Files are downloaded and paths passed to Claude.

#### General topic redirect (bot.ts)
Messages accidentally sent to the General topic in forum groups are caught and redirected with a list of active topics.

#### Email bridge reliability (email-bridge.ts)
- **Rate limiting**: Max 3 invocations per subject per 5-minute window. Prevents processing loops.
- **Deferred retry queue**: Capacity errors (too many concurrent processes) suppress the error reply and defer for 5-minute cooldown, max 3 attempts.
- **Exponential backoff**: Network errors (DNS failures, API timeouts) trigger doubling backoff up to 5 minutes, with recovery logging.
- **Race condition fix**: `markAsProcessed` called before queueing, not inside `processEmail`. Prevents the next poll from re-discovering emails during slow queue processing.

#### Gmail improvements (gmail.ts)
- **HTML replies**: Responses sent as HTML to prevent Gmail's 76-char line wrapping in plain text.
- **RFC 2047 subject encoding**: Non-ASCII subjects properly encoded.
- **30KB body cap**: Extremely long forwarded threads truncated to prevent context overflow.
- **Nested MIME part flattening**: Finds text/plain in deeply nested multipart structures.

#### Safety prompt updates
- Telegram: Added file sending marker documentation.
- Email: Added attachment handling guidance, response rules, and privacy rule.

#### Clean environment for Claude spawning
Strips inherited `CLAUDE*` environment variables before spawning to prevent nested-session detection or other interference.

## 2026-02-15

### Per-subject email sessions — each subject gets its own Claude session
- Email bridge now routes each unique subject line to its own Claude session
- Subject normalisation strips `Re:`, `Fwd:`, `Fw:`, keyword prefixes, and `NEW:` before matching, then lowercases — so `Re: Fwd: Check the data` maps to the same session as `check the data`
- New `subjectToKey()` helper in `gmail.ts` for consistent subject normalisation
- Session state moved from single-file (`~/.claude-email-session`) to a JSON map (`~/.claude-email-sessions.json`) keyed by normalised subject
- `NEW:` prefix now forces a fresh session for that specific subject (previously reset the single global session)
- Env var renamed: `GMAIL_SESSION_FILE` → `GMAIL_SESSIONS_FILE`
- Startup log now shows active session count instead of a single session ID

## 2026-02-14

### Forum/topic support — use Claude in Telegram forum groups
- New `BRIDGE_MODE` env var: set to `"group"` to run in a forum group with topics
- Each topic gets its own isolated Claude session — no cross-contamination between topics
- Per-topic FIFO queues: messages in different topics process in parallel
- `getTopicId()` correctly routes Telegram General topic messages (which omit `message_thread_id`) to a dedicated `"general-topic"` session
- New `/topics` command: lists all active topics with message counts
- `/status` and `/new` commands are now topic-aware
- Replies and typing indicators are sent to the correct topic thread
- Session files moved from single file (`~/.claude-bridge-session`) to per-topic directory (`~/.claude-bridge-sessions/`)
- Automatic migration from legacy single-file session on first run
- Multiple chat IDs supported (comma-separated `TELEGRAM_CHAT_ID`)

### Photo support — send images to Claude via Telegram
- New `src/download.ts`: downloads photos from Telegram to `/tmp/telegram-bridge-images/`
- Photos are passed to Claude's multimodal Read tool for visual analysis
- Captions included in the prompt when provided
- Auto-cleanup of images older than 24 hours (on startup + every 6 hours)
- Highest resolution photo selected automatically

### Update deduplication — prevents message replay on restart
- New `src/dedup.ts`: tracks processed Telegram `update_id`s on disk
- Prevents the same message from being processed twice after bot restarts
- Stores last 200 update IDs in `_processed_updates.json` (underscore prefix so session scanner skips it)
- `markProcessed()` called after successful processing — if Claude crashes mid-invocation, the message re-delivers on next restart

### Timeout and progress improvements
- Old: hard kill after 10 minutes, single partial response
- New: progress updates every 5 minutes ("Still working... X min elapsed"), hard safety kill only at 60 minutes
- Progress messages include tool call count for visibility

### Plain text Telegram replies
- Removed Markdown formatting from `/new` and `/status` responses
- Safety prompt now explicitly instructs Claude to avoid Markdown formatting
- All replies use plain text — Telegram does not render Markdown consistently in all contexts

### Permission denial improvements
- Permission prompts now only appear when Claude was actually blocked (isError is true)
- When Claude handles a denial gracefully (finds alternatives), the denial is logged but not surfaced to the user
- Permission tracking is per-topic in forum mode

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
