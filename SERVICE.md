# UshAgent Service Guide

## Overview

`ushagent` can run as one global Linux `systemd` user service.

The service:

- starts `ushagent codex` in the background
- survives terminal close
- can start automatically on login
- can optionally keep running after reboot before login if `linger` is enabled
- restores the last active project from `~/.ushagent/config.json`

Project switching is then done from Telegram with `/projects` and `/project`.

## Install

Install the CLI globally:

```bash
npm uninstall -g ushagent
npm install -g /root/ushagent
```

Install the background service:

```bash
ushagent service install
```

During install, UshAgent asks:

- whether to install the service
- whether to enable autostart
- whether to start it immediately
- whether to enable `linger`

Check service status:

```bash
ushagent service status
```

## Service Commands

```bash
ushagent service status
ushagent service start
ushagent service stop
ushagent service restart
ushagent service remove
```

The service name is:

```bash
ushagent-codex.service
```

## Config Migration

If you used the older config directory `~/.heyagent`, migrate it once:

```bash
mkdir -p ~/.ushagent
cp ~/.heyagent/config.json ~/.ushagent/config.json
systemctl --user restart ushagent-codex.service
```

This is important if the bot token and Telegram pairing were stored only in the old config.

## Verify It Works

Check systemd status:

```bash
systemctl --user status ushagent-codex.service --no-pager
```

Check logs:

```bash
journalctl --user -u ushagent-codex.service -n 100 --no-pager
```

Healthy startup usually includes lines like:

```text
Connected to Telegram chat ...
UshAgent is running in codex mode. Send /help in Telegram.
```

## Telegram Usage

After the service is running, use Telegram to control it:

```text
/help
/menu
/status
/projects
/project <number|path|current>
/sessions
/history
/prev
```

The active project can be switched from Telegram without reinstalling the service.

## Troubleshooting

If the bot does not respond, check for duplicate running processes:

```bash
ps aux | rg 'ushagent|bin/hey.js|node .*ushagent'
```

There should normally be only one active `ushagent` service process.

If the config looks empty:

```bash
cat ~/.ushagent/config.json
```

If needed, restore the old config again:

```bash
cp ~/.heyagent/config.json ~/.ushagent/config.json
systemctl --user restart ushagent-codex.service
```

If you want to fully reset the service:

```bash
ushagent service remove --yes
systemctl --user daemon-reload
ushagent service install
```
