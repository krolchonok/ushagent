# UshAgent Usage

## What Changed

The main CLI command is now:

```bash
ushagent
```

Short alias:

```bash
hely
```

Examples:

```bash
ushagent codex
hely codex
```

## Install

Global install from the project package:

```bash
npm install -g ushagent
```

After that, use:

```bash
ushagent --version
```

## Quick Start

Optional: put the Telegram bot token into the current project `.env`:

```bash
cp .env.example .env
$EDITOR .env
```

Supported variables:

```bash
USHAGENT_TELEGRAM_BOT_TOKEN=123456789:AA...
HEYAGENT_TELEGRAM_BOT_TOKEN=123456789:AA...
TELEGRAM_BOT_TOKEN=123456789:AA...
```

Start the bridge:

```bash
ushagent codex
```

On first run the CLI will guide you through pairing with Telegram.

## Main Commands

Resume the latest session:

```bash
ushagent codex
```

Start a new session:

```bash
ushagent codex --new
```

Resume a specific session:

```bash
ushagent codex --session SESSION_ID
```

Show current status:

```bash
ushagent status
```

Reset Telegram bot token and pairing:

```bash
ushagent reset
```

Non-interactive reset:

```bash
ushagent reset --yes
```

Install a background Linux service for this project:

```bash
ushagent service install
```

## How To Work

1. Run `ushagent codex` in the project directory.
2. Pair the Telegram bot if this is the first launch.
3. Keep the process running in the terminal.
4. Send messages from Telegram or type directly into the local terminal.
5. The bridge forwards prompts to Codex and sends responses back to Telegram.

## Local Terminal Commands

While `ushagent codex` is running, you can type:

```text
/help
/status
/new
/stop
/ask <prompt>
/say <text>
/projects
/project <number|path|current>
/sessions
/session
/exit
```

Plain text without a slash is treated as a prompt for the active agent.

## Telegram Commands

Available inside Telegram:

```text
/help
/new
/status
/stop
```

Any regular text message is forwarded to the active agent.

## Notes

- The config file is stored in `~/.ushagent/config.json`.
- Sleep prevention is enabled while the bridge is running.
- If no startup flag is passed, `ushagent codex` resumes the latest session by default.
- Attachments from Telegram are forwarded to the active provider.
- On Linux, `ushagent service install` sets up one global `systemd` user service and asks whether to enable startup, whether to start now, and whether to enable reboot persistence via `linger`.
- The service restores the last active project from `~/.ushagent/config.json`, and you can switch projects later with `/project`.
