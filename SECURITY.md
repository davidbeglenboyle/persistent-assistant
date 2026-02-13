Security analysis of persistent-assistant, covering network exposure, credential risks, and the real threat surface.

## Verdict

No open ports. Zero inbound connections. Minimal network attack surface. The real risks are behavioural (Claude's autonomy) and informational (Telegram can read messages), not network-based.

## I. Network Security

**No ports are opened.** The bot uses grammy's long-polling mode — it makes outbound HTTPS requests to `api.telegram.org` and waits for responses. There is:

* No HTTP server running
* No webhook endpoint exposed
* No port listening for connections
* No need for ngrok, port forwarding, or firewall rules

An attacker scanning your IP would find nothing related to this bot. It is equivalent to having a browser tab open — outbound connections only. This is a significant security advantage over webhook-based approaches (which require an exposed HTTP endpoint).

## II. What This Is NOT Vulnerable To

* **Port scanning / network intrusion** — No ports open
* **Man-in-the-middle on your LAN** — Bot uses HTTPS to Telegram API with TLS
* **IP-based attacks** — Bot's IP is never exposed to the internet
* **Remote code execution via the bot** — Messages go through Claude Code's execution model, not directly to a shell
* **Chat ID spoofing** — Telegram verifies chat IDs server-side; cannot be faked by a client

## III. Credential Security

### A. Bot token

If compromised, an attacker could:
* Set up their own listener and intercept messages meant for your bot (race condition with your instance)
* Send messages as the bot to anyone who has previously messaged it

However, they **cannot** bypass the chat ID whitelist in your running instance. The check in `bot.ts` rejects all messages from unrecognised chat IDs before any Claude invocation occurs.

### B. Chat ID whitelist

Enforced server-side by Telegram. Chat IDs are assigned by Telegram's infrastructure and verified on every API call. A client cannot spoof a different chat ID.

### C. Credential storage

Three options with different security profiles:

| Method | Security | Convenience |
|--------|----------|-------------|
| macOS Keychain | Encrypted at rest, requires login | Moderate |
| .env file | Plaintext on disk (gitignored) | High |
| Environment variables | In process memory only | Low |

Keychain is recommended. The .env file is acceptable for personal use but sits in plaintext.

## IV. The Real Risks

### A. Pre-approved tool access (accepted risk)

The bridge uses `--allowed-tools` to whitelist tools that execute without confirmation: Read, Edit, Write, Glob, Grep, Task, WebFetch, WebSearch, and others. These tools give Claude full filesystem and web access within your user account. Tools not on the whitelist — primarily Bash — are denied by Claude Code and surfaced via Telegram for your approval before retrying.

On top of this, the advisory safety prompt (`src/safety-prompt.txt`) instructs Claude to ask for confirmation before destructive or externally visible actions. This is a second layer — the tool whitelist provides the hard boundary, the safety prompt provides conversational guardrails. Claude treats appended system prompts with high priority in practice but could theoretically ignore them.

### B. Telegram is not end-to-end encrypted for bots (medium risk)

Regular Telegram messages — including all bot messages — are encrypted client-to-server but **not end-to-end**. Only "Secret Chats" offer end-to-end encryption, and bots cannot use them. This means:

* Telegram (the company) can read your messages and Claude's responses
* A Telegram server compromise would expose your message history
* Law enforcement with a valid warrant could access your Telegram bot conversations

If your Claude interactions involve sensitive business information, client data, or credentials, be aware that Telegram's servers see all of it.

### C. Conversation logs stored in plaintext (low risk)

The `logs/YYYY-MM-DD.md` files contain full message history in plaintext on your filesystem. Anyone with access to your machine can read them. These are gitignored and won't be pushed to GitHub, but they are not encrypted at rest.

### D. MCP server access (medium risk)

The bridged Claude session inherits all configured MCP servers (browser automation, API tools, etc.). A cleverly crafted or ambiguous message could prompt Claude to interact with these services. The safety prompt helps by requiring confirmation for externally visible actions, but this is advisory.

### E. No rate limiting (low risk)

There is no rate limiter on Claude invocations. If the chat ID whitelist were somehow bypassed, an attacker could spam Claude processes. In practice, the chat ID check makes this theoretical — Telegram's server-side verification prevents chat ID spoofing.

## V. Possible Hardening (Not Yet Implemented)

These are options for future consideration if the risk profile changes:

1. **Session passphrase** — Require a password in the first message of each `/new` session before Claude processes anything
2. **Encrypted logs** — Encrypt conversation logs at rest using GPG or similar
3. **Token rotation** — Periodically revoke and regenerate the bot token via @BotFather
4. **`--disallowed-tools`** — Block specific high-risk tools (e.g. MCP servers) while keeping the rest available

## VI. Summary

The architecture is sound from a network security perspective — no exposed ports, no inbound connections, HTTPS throughout. The risks worth being conscious of are:

1. Claude's pre-approved tool access (mitigated by `--allowed-tools` whitelist and advisory safety prompt)
2. Telegram reading your messages (inherent to the Telegram bot API)
3. Plaintext conversation logs on disk

None of these are showstoppers for a personal tool. They are documented in the README under "Limitations and Risks."
