# UshAgent CLI

UshAgent CLI is a bidirectional Telegram bridge for Codex.
Send and receive Telegram messages with Codex from Telegram and the local terminal.

Fully free, fully open source, and fully local — no server or external storage required.

### v2 Update

Note: before v2, this project focused on notification integration for CLI coding agents.

## Installation

```bash
npm install -g ushagent
```

## Usage

```bash
# Optional: store Telegram bot token in project .env
cp .env.example .env
$EDITOR .env

# Resume latest session (default)
ushagent codex

# Create new session
ushagent codex --new

# Run with explicit session id
ushagent codex --session [SESSION-ID]    # resumes given session

# Show local pairing/session status
ushagent status

# Reset Telegram setup (clears bot token + chat pairing)
ushagent reset

# Non-interactive reset
ushagent reset --yes

# Install background service for this project
ushagent service install

# Short alias
hely codex
```

## Environment Variables

UshAgent loads `.env` from the current working directory on startup.

Token precedence:

1. `.env` / process environment
2. `~/.ushagent/config.json`

Supported variable names:

```bash
USHAGENT_TELEGRAM_BOT_TOKEN=123456789:AA...
# also supported:
HEYAGENT_TELEGRAM_BOT_TOKEN=123456789:AA...
TELEGRAM_BOT_TOKEN=123456789:AA...
```

Security behavior:

- if token comes from `.env` or environment, UshAgent uses it but does not persist it back into `~/.ushagent/config.json`
- if env token is invalid, startup fails fast instead of silently falling back to another token source

## Setup and Pairing Flow

Start with `ushagent codex`.

On first run, UshAgent will:

1. Ask for setup mode:
   - **Phone setup** (recommended) — scan one QR code and complete guided steps on your phone
   - **Manual fallback** — no tunnel required; paste the bot token directly into the terminal
2. In phone setup mode, CLI starts a temporary local server exposed via a Cloudflare Quick Tunnel and shows a single QR code. (This same tool is handy for reaching your local dev environment from your phone.)
3. Complete guided steps on phone:
   - Open BotFather
   - Create your own bot
   - Submit bot token
   - Open bot chat and press START
4. CLI validates token, waits for pairing, and stores bot + chat locally.

Manual fallback avoids tunneling completely:

1. Create your own bot
2. Paste bot token into the terminal.
3. CLI shows bot opening link/QR for pairing.

If recommended phone onboarding fails in your environment, install system `cloudflared`
(for example `brew install cloudflared`) or choose manual fallback.

## Security Notes

- The safest setup is `.env` or manual terminal entry, because the bot token never needs to pass through the temporary phone onboarding page.
- Phone onboarding is still local-first, but it uses a temporary Cloudflare Quick Tunnel. The tunnel page is now protected by:
  - a random per-session path
  - a second per-session secret in the URL fragment, required for token submission and state polling
- The QR/onboarding flow validates the token directly against Telegram before continuing.
- Pairing only succeeds from a private Telegram chat by pressing `START` on the bot deep link generated for the current session.

## Telegram Commands

Inside Telegram:

- `/help` list commands
- `/new` force next prompt to run as a new session
- `/status` show provider, directory, bot, session, and pairing
- `/stop` stop current execution and clear queued messages

Any other text message is forwarded to the active agent.
For voice input, keyboard dictation on your phone is recommended.

## Local CLI Input

When running in an interactive terminal, UshAgent also accepts live local input.

- Plain text: run prompt through provider and send response to Telegram
- `/ask <prompt>` same as plain text
- `/say <text>` send raw message directly to Telegram
- `/new` force next prompt to start a fresh session
- `/stop` stop current execution and clear queued Telegram messages
- `/projects` list known projects
- `/project <number|path|current>` switch or inspect active project
- `/sessions` show sessions for the current project
- `/session` show current session binding and next prompt mode
- `/status` print local bridge status
- `/help` show local commands
- `/exit` stop the running bridge

CLI logs are shown for inbound Telegram commands, local prompts, and outgoing messages.

## Provider Execution

Default runtime:

- `codex exec --dangerously-bypass-approvals-and-sandbox --json "<prompt>"`

You can override default bypass behavior by passing explicit provider permission flags, for example:

- `ushagent codex --full-auto`

Session startup strategy:

- `--new` force first prompt to start fresh session
- `--session <session-id>` : resumes the session given by its id
- default (no startup flag): same as `--resume` / `--continue`, resume latest in current provider/project

## Background Service

On Linux, UshAgent can run as one global `systemd` user service.

Install interactively:

```bash
ushagent service install
```

Useful commands:

```bash
ushagent service status
ushagent service start
ushagent service stop
ushagent service restart
ushagent service remove
```

During `install`, UshAgent asks whether to:

- enable autostart
- start immediately
- enable `linger` so the service starts after reboot even before login

The service restores the last active project from `~/.ushagent/config.json`, and you can switch projects later from Telegram with `/project`.

## Notes

- Fully local-served
- Sleep prevention is always enabled while bridge is running.
- Lid-close sleep is not reliably controllable by app-level code:
  - macOS: use clamshell mode setup (external power/display/input) for closed-lid operation.
  - Windows/Linux: requires OS power settings or admin-level policy changes.
- Polling-only runtime (no webhooks).
- One chat per running CLI process.
- If you send new messages while a request is in progress, UshAgent queues and groups those messages into the next run.
- Telegram attachments are forwarded to the active provider (documents, images, audio, voice notes, and videos).
- Config is stored at `~/.ushagent/config.json`

## License

MIT License - see LICENSE file for details.
