#!/usr/bin/env node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirm } from '@inquirer/prompts';
import Config from '../src/config.js';
import Logger from '../src/logger.js';
import { applyDefaultBypassArgs } from '../src/args.js';
import { loadUshAgentEnv } from '../src/env.js';
import {
  getServiceDefinition,
  getUserServiceStatus,
  installUserService,
  removeUserService,
} from '../src/service-manager.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadUshAgentEnv({ cwd: process.cwd() });
const args = process.argv.slice(2);
const command = args[0];
const logger = new Logger('ushagent');

function showHelp() {
  console.log(`
UshAgent: Telegram bridge for Codex.

Usage:
  ushagent codex [provider-args...] [--new] [--session <session-id>]
  ushagent status
  ushagent service <install|status|start|stop|restart|remove>
  ushagent reset              Reset Telegram setup (bot token + chat pairing)
  ushagent --version          Show version number

Examples:
  ushagent codex                       (resumes latest session)
  ushagent codex --new                 (creates new session)
  ushagent codex --model gpt-5-codex
  ushagent service install             (install background service for this project)
  hely codex                           (alias)

Token sources:
  .env -> process.env -> ~/.ushagent/config.json
  Supported env vars: USHAGENT_TELEGRAM_BOT_TOKEN, HEYAGENT_TELEGRAM_BOT_TOKEN, TELEGRAM_BOT_TOKEN

See more: https://ushagent.dev
`);
}

function parseModelShorthand(provider, providerArgs) {
  const args = Array.isArray(providerArgs) ? [...providerArgs] : [];
  if (args.length !== 1) {
    return args;
  }

  const token = String(args[0] || '').trim();
  if (!token || token.startsWith('-')) {
    return args;
  }

  if (provider === 'codex') {
    return ['--model', token];
  }

  return args;
}

function extractRuntimeOptions(providerArgs) {
  const args = Array.isArray(providerArgs) ? [...providerArgs] : [];
  const cleaned = [];
  let sessionId = '';
  let startMode = 'auto';

  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index] || '').trim();
    if (!value) {
      continue;
    }

    if (value === '--new') {
      if (startMode !== 'auto' && startMode !== 'new') {
        throw new Error('Use only one startup mode: --new OR --resume/--continue');
      }
      startMode = 'new';
      continue;
    }

    if (value === '--resume' || value === '--continue') {
      if (startMode !== 'auto' && startMode !== 'resume') {
        throw new Error('Use only one startup mode: --new OR --resume/--continue');
      }
      startMode = 'resume';
      continue;
    }

    if (value === '--session') {
      const next = String(args[index + 1] || '').trim();
      if (!next) {
        throw new Error(`Missing value for ${value}`);
      }
      sessionId = next;
      index += 1;
      continue;
    }

    if (value.startsWith('--session=')) {
      const parsed = value.slice('--session='.length).trim();
      if (!parsed) {
        throw new Error('Missing value for --session');
      }
      sessionId = parsed;
      continue;
    }

    if (value === '--keep-awake' || value === '--no-keep-awake') {
      throw new Error(`${value} is not a valid UshAgent option. Sleep prevention is always on while UshAgent is running.`);
    }

    cleaned.push(value);
  }

  return {
    providerArgs: cleaned,
    sessionId: sessionId || null,
    startMode,
  };
}

function maskToken(token) {
  const value = String(token || '').trim();
  if (!value) {
    return 'not set';
  }

  const colonIndex = value.indexOf(':');
  if (colonIndex <= 0) {
    if (value.length <= 10) {
      return `${value.slice(0, 2)}...`;
    }
    return `${value.slice(0, 4)}...${value.slice(-2)}`;
  }

  const prefix = value.slice(0, colonIndex);
  const suffix = value.slice(colonIndex + 1);
  const suffixMasked = suffix.length <= 6 ? `${suffix.slice(0, 2)}...` : `${suffix.slice(0, 3)}...${suffix.slice(-3)}`;
  return `${prefix}:${suffixMasked}`;
}

function showStatus(config) {
  const paired = config.isPaired();
  const provider = config.provider || 'codex';
  const providerArgs = config.codexArgs;
  const currentSession = config.codexLastSessionId;
  const tokenInfo = config.getTelegramBotTokenInfo();

  console.log(`Provider: ${provider || 'not set'}`);
  console.log(`Telegram bot: ${config.telegramBotUsername ? `@${config.telegramBotUsername}` : 'not set'}`);
  console.log(`Telegram token: ${maskToken(tokenInfo.token)}${tokenInfo.source ? ` (${tokenInfo.source})` : ''}`);
  console.log(`Paired chat: ${paired ? config.telegramChatId : 'not paired'}`);
  console.log(`Paired user: ${paired ? config.telegramChatUserId || 'unknown' : 'not paired'}`);
  console.log(`Args: ${providerArgs.length > 0 ? providerArgs.join(' ') : '(none)'}`);
  console.log('Sleep prevention: always on while UshAgent is running (availability checked at bridge startup)');
  console.log(`Session: ${currentSession || '-'}`);
}

function parseServiceCommand(serviceArgs) {
  const args = Array.isArray(serviceArgs) ? [...serviceArgs] : [];
  const action = String(args[0] || 'status').trim().toLowerCase() || 'status';
  const flags = new Set();

  for (let index = 1; index < args.length; index += 1) {
    const value = String(args[index] || '').trim();
    if (!value) {
      continue;
    }
    flags.add(value);
  }

  return {
    action,
    yes: flags.has('--yes') || flags.has('-y'),
    startNow: flags.has('--start-now'),
    noStart: flags.has('--no-start'),
    noEnable: flags.has('--no-enable'),
    enableLinger: flags.has('--enable-linger'),
    disableLinger: flags.has('--disable-linger'),
  };
}

function printServiceStatus(status) {
  console.log(`Service: ${status.serviceName}`);
  console.log(`Path: ${status.servicePath}`);
  console.log(`Workspace: ${status.workspacePath}`);
  console.log(`Exists: ${status.exists ? 'yes' : 'no'}`);
  console.log(`Enabled: ${status.enabled}`);
  console.log(`Active: ${status.active}`);
}

async function handleServiceCommand(serviceArgs = []) {
  const parsed = parseServiceCommand(serviceArgs);
  const config = new Config();
  const serviceWorkingDirectory = config.serviceWorkspacePath || os.homedir();
  const resolveDefinition = workspacePath =>
    getServiceDefinition({
      workspacePath,
      commandPath: process.argv[1],
      provider: 'codex',
      providerArgs: config.codexArgs,
    });
  const definition = resolveDefinition(serviceWorkingDirectory);

  const persistServiceConfig = nextDefinition => {
    config.setMany({
      serviceWorkspacePath: nextDefinition.workspacePath,
      serviceName: nextDefinition.serviceName,
    });
  };

  const loadStatus = workspacePath =>
    getUserServiceStatus({
      workspacePath,
      commandPath: process.argv[1],
      provider: 'codex',
    });

  if (parsed.action === 'status') {
    printServiceStatus(loadStatus(serviceWorkingDirectory));
    return;
  }

  if (parsed.action === 'install') {
    let installAccepted = parsed.yes;
    let enableAtStartup = !parsed.noEnable;
    let startNow = parsed.startNow;
    let enableLinger = parsed.enableLinger;

    if (!installAccepted) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.log('Service install needs confirmation. Re-run with --yes in non-interactive mode.');
        return;
      }

      installAccepted = await confirm({
        message: 'Install one global background systemd user service for UshAgent?',
        default: true,
      });
      if (!installAccepted) {
        console.log('Service installation cancelled.');
        return;
      }

      enableAtStartup = await confirm({
        message: 'Enable the service on login/startup?',
        default: true,
      });
      startNow = await confirm({
        message: 'Start the service immediately after installation?',
        default: true,
      });
      enableLinger = await confirm({
        message: 'Enable linger so the user service starts after reboot even before login?',
        default: false,
      });
    }

    const installed = installUserService({
      workspacePath: os.homedir(),
      commandPath: process.argv[1],
      provider: 'codex',
      providerArgs: config.codexArgs,
      enableAtStartup,
      startNow: parsed.noStart ? false : startNow,
      enableLinger,
    });
    persistServiceConfig(installed);

    console.log(`Installed ${installed.serviceName}`);
    printServiceStatus(loadStatus(installed.workspacePath));
    return;
  }

  if (parsed.action === 'remove' || parsed.action === 'uninstall') {
    let accepted = parsed.yes;
    if (!accepted) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        console.log('Service removal needs confirmation. Re-run with --yes in non-interactive mode.');
        return;
      }

      accepted = await confirm({
        message: `Remove the background service ${definition.serviceName}?`,
        default: false,
      });
    }

    if (!accepted) {
      console.log('Service removal cancelled.');
      return;
    }

    const removed = removeUserService({
      workspacePath: serviceWorkingDirectory,
      commandPath: process.argv[1],
      provider: 'codex',
      disableLinger: parsed.disableLinger,
    });
    config.setMany({
      serviceWorkspacePath: null,
      serviceName: null,
    });
    console.log(`Removed ${removed.serviceName}`);
    return;
  }

  if (parsed.action === 'start' || parsed.action === 'stop' || parsed.action === 'restart') {
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync('systemctl', ['--user', parsed.action, definition.serviceName], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
    if (result.status !== 0) {
      throw new Error(String(result.stderr || result.stdout || `systemctl ${parsed.action} failed`).trim());
    }
    printServiceStatus(loadStatus(serviceWorkingDirectory));
    return;
  }

  throw new Error(`Unknown service action: ${parsed.action}`);
}

async function main() {
  if (!command) {
    showHelp();
    return;
  }

  if (command === '--version' || command === '-v') {
    const packageJsonPath = path.join(__dirname, '../package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    console.log(packageJson.version);
    return;
  }

  if (command === '--help' || command === '-h' || command === 'help') {
    showHelp();
    return;
  }

  if (command === 'status') {
    const config = new Config();
    showStatus(config);
    return;
  }

  if (command === 'service') {
    await handleServiceCommand(args.slice(1));
    return;
  }

  if (command === 'reset' || command === 'unpair') {
    const config = new Config();
    const force = args.includes('--yes') || args.includes('-y');

    const details = [
      `bot: ${config.telegramBotUsername ? `@${config.telegramBotUsername}` : 'not set'}`,
      `token: ${maskToken(config.telegramBotToken)}${config.telegramBotTokenSource ? ` (${config.telegramBotTokenSource})` : ''}`,
      `chat: ${config.telegramChatId || 'not paired'}`,
    ].join(', ');

    let accepted = force;
    if (!accepted) {
      if (process.stdin.isTTY && process.stdout.isTTY) {
        accepted = await confirm({
          message: `Reset Telegram setup (${details})?`,
          default: false,
        });
      } else {
        console.log('Reset needs confirmation. Re-run with --yes in non-interactive mode.');
        return;
      }
    }

    if (!accepted) {
      console.log('Reset cancelled.');
      return;
    }

    config.clearPairing({ keepBotToken: false });
    config.set('provider', null);
    console.log('Telegram setup reset. Bot token and chat pairing removed.');
    return;
  }

  if (command === 'codex') {
    const config = new Config();
    const cliProviderArgs = args.slice(1);
    const extracted = extractRuntimeOptions(cliProviderArgs);
    if (extracted.startMode === 'new' && extracted.sessionId) {
      throw new Error('Cannot combine --new with --session');
    }
    const savedProviderArgs = config.codexArgs;
    const providerArgs = extracted.providerArgs.length > 0 ? extracted.providerArgs : savedProviderArgs;
    const normalizedProviderArgs = parseModelShorthand(command, providerArgs);
    const effectiveArgs = applyDefaultBypassArgs(command, normalizedProviderArgs);
    config.setMany({
      provider: 'codex',
      codexArgs: effectiveArgs.providerArgs,
    });

    if (effectiveArgs.defaultBypassApplied) {
      console.log(`[warning] ${command}: default bypass mode enabled for non-interactive execution.`);
    }

    const { default: Bridge } = await import('../src/bridge.js');
    const bridge = new Bridge(config, command, effectiveArgs.providerArgs, {
      initialSessionId: extracted.sessionId,
      startMode: extracted.startMode,
    });
    await bridge.start();
    return;
  }

  console.log(`Unknown command: ${command}`);
  showHelp();
}

main().catch(error => {
  logger.error(error.message || String(error));
  console.error(`Error: ${error.message || error}`);
  process.exit(1);
});
