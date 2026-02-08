# persistent-assistant

Control Claude Code from your phone via Telegram.

Claude Code is the most capable way to use Claude — it can edit files, run terminal commands, manage git repos, search your codebase, and use MCP servers. But it requires you to be sitting at your laptop. Step away for a meeting, a commute, or a coffee and you lose access to all of that.

This project bridges that gap. It connects a Telegram chat to a Claude Code session running on your machine, giving you full Claude Code capabilities from your phone. Ask it to check a file, run a script, push to GitHub, search your codebase — anything Claude Code can do, you can now do from Telegram.

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
* **Enforced tool permissions** — `--allowed-tools` whitelist pre-approves safe tools; denied tools are surfaced via Telegram for approval
* **Safety prompt** — An advisory system prompt that requires Claude to ask for confirmation before destructive actions (file deletion, force push, sending emails, etc.)
* **Chat ID whitelist** — Only your Telegram account can talk to the bot
* **Auto-split long responses** — Messages longer than Telegram's 4,096-character limit are split automatically
* **Daily conversation logs** — Every exchange logged to `logs/YYYY-MM-DD.md`
* **Typing indicator** — Shows "typing..." in Telegram while Claude processes
* **FIFO message queue** — Messages processed one at a time; send multiple and they queue up
* **Telegram commands** — `/new` to start a fresh session, `/status` to check session info

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
│   ├── index.ts              # Entry point — loads env vars, starts bot
│   ├── bot.ts                # Telegram bot (grammy, long-polling)
│   ├── claude.ts             # Spawns Claude Code CLI, parses JSON response
│   ├── queue.ts              # Promise-based FIFO queue
│   ├── session.ts            # Session UUID persistence (~/.claude-bridge-session)
│   ├── logger.ts             # Daily conversation logs (logs/YYYY-MM-DD.md)
│   └── safety-prompt.txt     # Advisory safety rules (editable)
├── scripts/
│   └── start.sh              # Startup wrapper (loads credentials)
├── CLAUDE.md                 # Agent-facing setup guide
├── .env.example              # Credential template
└── package.json
```

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

## Configuration

| Setting | Location | Default |
|---------|----------|---------|
| Claude binary path | `CLAUDE_PATH` env var | Auto-detected |
| Tool whitelist | `ALLOWED_TOOLS` in `src/claude.ts` | All built-in tools except Bash |
| Timeout per message | `src/claude.ts` | 10 minutes |
| Telegram message limit | `src/bot.ts` | 4,096 characters |
| Safety prompt | `src/safety-prompt.txt` | Editable text file |
| Session file | `~/.claude-bridge-session` | Per-machine |
| Working directory | `src/claude.ts` | Home directory |

## Running in the Background

```bash
nohup bash scripts/start.sh > /tmp/persistent-assistant.log 2>&1 &
```

To stop: `pkill -f "tsx src/index.ts"`

## License

MIT
