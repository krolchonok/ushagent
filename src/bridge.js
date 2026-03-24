import crypto from 'node:crypto';
import fs from 'node:fs';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import readlinePromises from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { select } from '@inquirer/prompts';
import qrcode from 'qrcode-terminal';
import Logger from './logger.js';
import { TelegramApi, TelegramApiError } from './telegram-api.js';
import { createOnboardingSession } from './token-web-intake.js';
import { applyDefaultBypassArgs } from './args.js';
import { formatSleepInhibitorStatus, startSleepInhibitor } from './sleep-inhibitor.js';
import { createAttachmentHandler } from './attachment-handler.js';
import { collectKnownWorkspaces, formatWorkspaceList } from './workspace-manager.js';
import { fetchCodexUsage, formatCodexUsage } from './providers/codex-usage.js';
import {
  createProviderRuntime,
  formatProviderName,
  getProviderSessionId,
  setProviderSessionId,
} from './providers/provider-registry.js';

const BOTFATHER_URL = 'https://t.me/BotFather';
const SETUP_MODE_PHONE = 'phone_onboarding';
const SETUP_MODE_MANUAL = 'manual_fallback';
const ATTACHMENT_DOWNLOAD_DIR = path.join(os.tmpdir(), 'ushagent-files');
const DICTATION_HINT_TEXT = 'Hint: for voice input, use your phone keyboard dictation.';
const MAX_CONVERSATION_HISTORY = 40;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function promptLine(question) {
  const rl = readlinePromises.createInterface({ input, output });
  try {
    const answer = await rl.question(question);
    return String(answer || '').trim();
  } finally {
    rl.close();
  }
}

function makePairCode() {
  while (true) {
    const code = crypto
      .randomBytes(8)
      .toString('base64url')
      .replace(/[^a-zA-Z0-9]/g, '');
    if (code.length >= 10) {
      return code.slice(0, 10).toLowerCase();
    }
  }
}

function buildStatusText(config, provider, providerArgs = [], sleepInhibitorState = null, attachmentStatus = null) {
  const bot = config.telegramBotUsername ? `@${config.telegramBotUsername}` : 'not set';
  const sessionId = getProviderSessionId(config, provider);
  const argsText = Array.isArray(providerArgs) && providerArgs.length > 0 ? providerArgs.join(' ') : '(none)';
  const sleepStatus = formatSleepInhibitorStatus(sleepInhibitorState);
  return [
    `Provider: ${provider}`,
    `Args: ${argsText}`,
    `Sleep prevention: ${sleepStatus}`,
    attachmentStatus ? `Voice transcription: ${attachmentStatus}` : null,
    `Directory: ${process.cwd()}`,
    `Bot: ${bot}`,
    `Chat: ${config.telegramChatId || 'not paired'}`,
    `Session: ${sessionId || '-'}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function isPairStartMessage(text, code) {
  const match = String(text || '')
    .trim()
    .match(/^\/start(?:@\w+)?(?:\s+(.+))?$/i);

  if (!match) {
    return false;
  }

  const payload = String(match[1] || '').trim();
  return payload === `ha2_${code}`;
}

function printManualTokenSetupHelp() {
  console.log('\nManual setup (fallback, no tunnel):');
  console.log('Open BotFather with this QR/link:\n');
  qrcode.generate(BOTFATHER_URL, { small: true });
  console.log(`Link: ${BOTFATHER_URL}\n`);
  console.log('Steps:');
  console.log('1. Run /newbot (or /token for an existing bot)');
  console.log('2. Copy the HTTP API token');
  console.log('3. Paste token here in terminal\n');
}

function toLogPreview(text) {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return '(empty)';
  }

  const singleLine = normalized.replace(/\s+/g, ' ');
  if (singleLine.length <= 240) {
    return singleLine;
  }

  return `${singleLine.slice(0, 239)}…`;
}

function normalizeTelegramCommand(rawCommand) {
  const value = String(rawCommand || '').trim().toLowerCase();
  if (!value.startsWith('/')) {
    return value;
  }

  const mentionIndex = value.indexOf('@');
  return mentionIndex > 0 ? value.slice(0, mentionIndex) : value;
}

function formatHistoryTimestamp(value) {
  return new Date(value).toLocaleTimeString();
}

class Bridge {
  constructor(config, provider, providerArgs = [], options = {}) {
    this.config = config;
    this.provider = provider;
    this.providerArgs = providerArgs;
    this.initialSessionId = String(options.initialSessionId || '').trim() || null;
    this.startMode = options.startMode === 'new' ? 'new' : options.startMode === 'resume' ? 'resume' : 'auto';
    this.sessionMode = this.startMode === 'new' ? 'new' : 'latest';
    this.forceNewNextPrompt = this.sessionMode === 'new';
    this.logger = new Logger('bridge');
    this.telegram = null;
    this.attachmentHandler = null;
    this.sleepInhibitorState = null;
    this.running = true;
    this.manualHelpShown = false;
    this.localInputInterface = null;
    this.localInputQueue = Promise.resolve();
    this.promptQueue = Promise.resolve();
    this.activePromptAbortController = null;
    this.activePromptSource = null;
    this.activePromptAbortReason = null;
    this.telegramPendingMessages = [];
    this.telegramDispatchScheduled = false;
    this.resumeListCache = {
      provider: null,
      sessionIds: [],
    };
    this.projectListCache = [];
    this.cachedUsageSnapshot = null;
    this.lastExchange = null;
    this.conversationHistory = [];

    this.onSignal = () => {
      this.requestStopCurrentPrompt('shutdown');
      this.clearQueuedTelegramMessages();
      this.running = false;
      this.stopLocalInputLoop();
      console.log('\nStopping UshAgent...');
    };
  }

  async start() {
    process.on('SIGINT', this.onSignal);
    process.on('SIGTERM', this.onSignal);

    try {
      this.sleepInhibitorState = startSleepInhibitor({ logger: this.logger });

      if (this.sleepInhibitorState.active) {
        console.log(`Sleep prevention active (${this.sleepInhibitorState.backend}).`);
      } else {
        console.log(`Sleep prevention unavailable: ${this.sleepInhibitorState.reason || 'unknown error'}.`);
      }

      await mkdir(ATTACHMENT_DOWNLOAD_DIR, { recursive: true });

      const pairing = await this.ensureBridgeReady();
      this.attachmentHandler = await createAttachmentHandler({
        telegram: this.telegram,
        downloadDir: ATTACHMENT_DOWNLOAD_DIR,
      });
      this.config.setMany({
        provider: this.provider,
        telegramChatId: pairing.chatId,
      });
      const preferredWorkspacePath = String(this.config.activeWorkspacePath || '').trim();
      if (preferredWorkspacePath && preferredWorkspacePath !== this.getCurrentWorkspacePath() && fs.existsSync(preferredWorkspacePath)) {
        this.restoreWorkspaceState(preferredWorkspacePath);
      }
      this.prepareStartupSession();
      this.persistWorkspaceState();

      console.log(`Connected to Telegram chat ${pairing.chatId}.`);
      console.log(`UshAgent is running in ${this.provider} mode. Send /help in Telegram.\n`);

      const providerLabel = formatProviderName(this.provider);
      const startupHeadline =
        this.startMode === 'new'
          ? `UshAgent connected. Next message starts a new ${providerLabel} session.`
          : this.initialSessionId
            ? `UshAgent connected to ${providerLabel} session ${this.initialSessionId}.`
            : `UshAgent connected. Next message resumes ${this.describeResumeTarget(this.getBoundSessionId())}.`;

      const startupMessage = await this.safeSendMessage([startupHeadline, 'Send /help for available commands.', DICTATION_HINT_TEXT].join('\n\n'), {
        replyMarkup: this.buildControlKeyboard(),
      });
      if (Number.isInteger(startupMessage?.message_id)) {
        this.config.set('telegramControlPanelMessageId', startupMessage.message_id);
      }

      this.startLocalInputLoop();

      while (this.running) {
        await this.pollOnce();
      }
    } finally {
      this.stopLocalInputLoop();
      if (this.sleepInhibitorState && typeof this.sleepInhibitorState.stop === 'function') {
        await this.sleepInhibitorState.stop();
      }
      process.off('SIGINT', this.onSignal);
      process.off('SIGTERM', this.onSignal);
    }
  }

  writeCliLine(line) {
    const message = String(line || '');
    if (this.localInputInterface) {
      output.write(`\n${message}\n`);
      if (this.running) {
        this.localInputInterface.prompt();
      }
      return;
    }

    console.log(message);
  }

  logCliEvent(label, text = '') {
    const timestamp = new Date().toLocaleTimeString();
    const suffix = text ? `: ${toLogPreview(text)}` : '';
    this.writeCliLine(`[${timestamp}] ${label}${suffix}`);
  }

  getLastSessionId() {
    return getProviderSessionId(this.config, this.provider);
  }

  getPinnedSessionId() {
    const workspace = this.config.getWorkspace(this.getCurrentWorkspacePath());
    return String(workspace?.pinnedSessionId || '').trim() || null;
  }

  getBoundSessionId() {
    return this.sessionMode === 'pinned' ? this.getPinnedSessionId() : null;
  }

  setSessionMode(mode, pinnedSessionId = null) {
    if (mode === 'pinned') {
      const normalized = String(pinnedSessionId || '').trim();
      if (!normalized) {
        throw new Error('Pinned session id is required.');
      }
      this.sessionMode = 'pinned';
      this.forceNewNextPrompt = false;
      setProviderSessionId(this.config, this.provider, normalized);
      this.persistWorkspaceState();
      return;
    }

    if (mode === 'new') {
      this.sessionMode = 'new';
      this.forceNewNextPrompt = true;
      this.persistWorkspaceState();
      return;
    }

    this.sessionMode = 'latest';
    this.forceNewNextPrompt = false;
    this.persistWorkspaceState();
  }

  getCurrentWorkspacePath() {
    return process.cwd();
  }

  persistWorkspaceState(workspacePath = this.getCurrentWorkspacePath()) {
    const normalizedPath = String(workspacePath || '').trim();
    if (!normalizedPath) {
      return;
    }

    this.config.setWorkspace(normalizedPath, {
      label: path.basename(normalizedPath) || normalizedPath,
      lastUsedAt: new Date().toISOString(),
      provider: this.provider,
      codexArgs: this.config.codexArgs,
      codexLastSessionId: this.config.codexLastSessionId,
      sessionMode: this.sessionMode,
      pinnedSessionId: this.sessionMode === 'pinned' ? this.getLastSessionId() : null,
    });
    this.config.setActiveWorkspace(normalizedPath);
  }

  restoreWorkspaceState(workspacePath) {
    const normalizedPath = String(workspacePath || '').trim();
    if (!normalizedPath) {
      throw new Error('Workspace path is required.');
    }

    const stats = fs.statSync(normalizedPath);
    if (!stats.isDirectory()) {
      throw new Error(`Not a directory: ${normalizedPath}`);
    }

    const record = this.config.getWorkspace(normalizedPath);
    const provider = 'codex';
    const codexArgs = Array.isArray(record?.codexArgs) ? record.codexArgs : this.config.codexArgs;
    const effective = applyDefaultBypassArgs(provider, codexArgs);

    process.chdir(normalizedPath);
    this.provider = provider;
    this.providerArgs = effective.providerArgs;
    this.sessionMode = record?.sessionMode === 'pinned' && record?.pinnedSessionId ? 'pinned' : record?.sessionMode === 'new' ? 'new' : 'latest';
    this.forceNewNextPrompt = this.sessionMode === 'new';
    this.config.setMany({
      activeWorkspacePath: normalizedPath,
      provider,
      codexArgs: effective.providerArgs,
      codexLastSessionId: record?.codexLastSessionId || null,
    });
    if (this.sessionMode === 'pinned' && record?.pinnedSessionId) {
      setProviderSessionId(this.config, this.provider, record.pinnedSessionId);
    }
    this.persistWorkspaceState(normalizedPath);
  }

  buildCurrentProjectText() {
    const workspacePath = this.getCurrentWorkspacePath();
    const record = this.config.getWorkspace(workspacePath);
    const lastSessionId = this.getLastSessionId();

    return [
      `Project: ${record?.label || path.basename(workspacePath) || workspacePath}`,
      `Path: ${workspacePath}`,
      `Provider: ${this.provider}`,
      `Session mode: ${this.sessionMode}`,
      `Bound session: ${this.getBoundSessionId() || '(latest in current folder)'}`,
      `Last session: ${lastSessionId || '-'}`,
      `Next prompt: ${this.forceNewNextPrompt ? 'new session' : `resume ${this.describeResumeTarget(this.getBoundSessionId())}`}`,
    ].join('\n');
  }

  buildControlKeyboard() {
    return {
      inline_keyboard: [
        [
          { text: 'Projects', callback_data: 'projects' },
          { text: 'Sessions', callback_data: 'sessions' },
        ],
        [
          { text: 'Project', callback_data: 'project_current' },
          { text: 'Session', callback_data: 'session_status' },
        ],
        [
          { text: 'Usage', callback_data: 'usage' },
          { text: 'Status', callback_data: 'status' },
        ],
        [
          { text: 'Menu', callback_data: 'menu' },
          { text: 'Latest', callback_data: 'mode:latest' },
          { text: 'New', callback_data: 'mode:new' },
        ],
      ],
    };
  }

  mergeReplyMarkup(...markups) {
    const inline_keyboard = [];
    for (const markup of markups) {
      const rows = Array.isArray(markup?.inline_keyboard) ? markup.inline_keyboard : [];
      inline_keyboard.push(...rows);
    }
    return inline_keyboard.length > 0 ? { inline_keyboard } : null;
  }

  buildControlPanelText() {
    const workspacePath = this.getCurrentWorkspacePath();
    const lastSessionId = this.getLastSessionId();
    return [
      `Project: ${path.basename(workspacePath) || workspacePath}`,
      `Path: ${workspacePath}`,
      `Mode: ${this.sessionMode}`,
      `Session: ${this.getBoundSessionId() || '(latest in current folder)'}`,
      `Last: ${lastSessionId || '-'}`,
    ].join('\n');
  }

  buildLastExchangeText() {
    if (!this.lastExchange) {
      return 'No completed request/response pair yet.';
    }

    const sourceLabel = this.lastExchange.source === 'cli' ? 'CLI' : 'Telegram';
    return [
      `Source: ${sourceLabel}`,
      `Request:`,
      this.lastExchange.prompt,
      '',
      `Response:`,
      this.lastExchange.response,
    ].join('\n');
  }

  recordConversationEntry(entry = {}) {
    const text = String(entry.text || '').trim();
    if (!text) {
      return;
    }

    this.conversationHistory.push({
      timestamp: entry.timestamp || new Date().toISOString(),
      source: entry.source || 'system',
      direction: entry.direction || 'out',
      text,
    });

    if (this.conversationHistory.length > MAX_CONVERSATION_HISTORY) {
      this.conversationHistory.splice(0, this.conversationHistory.length - MAX_CONVERSATION_HISTORY);
    }
  }

  buildHistoryText(limit = 10) {
    const runtime = createProviderRuntime(this.config, this.provider, this.providerArgs);
    const sessionId = this.getBoundSessionId() || this.getLastSessionId();
    if (!sessionId) {
      return 'No active Codex session yet. Send a prompt first or select one with /resume.';
    }

    const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.min(20, Number(limit))) : 10;
    const transcript = runtime.getSessionTranscript({
      sessionId,
      limit: normalizedLimit,
    });
    if (!Array.isArray(transcript.entries) || transcript.entries.length === 0) {
      return `No transcript messages found for Codex session ${sessionId}.`;
    }

    return [
      `Recent Codex session messages for ${sessionId}:`,
      ...transcript.entries.map(entry => {
        const who = entry.role === 'user' ? 'User' : 'Codex';
        const phase = entry.role === 'assistant' && entry.phase ? ` (${entry.phase})` : '';
        return `[${formatHistoryTimestamp(entry.timestamp)}] ${who}${phase}: ${toLogPreview(entry.text)}`;
      }),
    ].join('\n');
  }

  buildPreviousMessageText() {
    const runtime = createProviderRuntime(this.config, this.provider, this.providerArgs);
    const sessionId = this.getBoundSessionId() || this.getLastSessionId();
    if (!sessionId) {
      return 'No active Codex session yet. Send a prompt first or select one with /resume.';
    }

    const transcript = runtime.getSessionTranscript({
      sessionId,
      limit: 1,
    });
    const previous = Array.isArray(transcript.entries) ? transcript.entries[transcript.entries.length - 1] : null;
    if (!previous) {
      return `No transcript messages found for Codex session ${sessionId}.`;
    }

    const who = previous.role === 'user' ? 'User' : 'Codex';
    return [
      `Latest message in Codex session ${sessionId}:`,
      `[${formatHistoryTimestamp(previous.timestamp)}] ${who}`,
      previous.text,
    ].join('\n');
  }

  async getUsageSnapshot(options = {}) {
    const force = options.force === true;
    const now = Date.now();
    if (!force && this.cachedUsageSnapshot && now - this.cachedUsageSnapshot.fetchedAt < 60 * 1000) {
      return this.cachedUsageSnapshot;
    }

    const snapshot = await fetchCodexUsage({
      cwd: this.getCurrentWorkspacePath(),
    });
    const enriched = {
      ...snapshot,
      fetchedAt: now,
    };
    this.cachedUsageSnapshot = enriched;
    return enriched;
  }

  async buildUsageText(options = {}) {
    const snapshot = await this.getUsageSnapshot(options);
    return formatCodexUsage(snapshot);
  }

  async publishTelegramView(text, options = {}) {
    const persistMenu = options.persistMenu === true;
    const messageId = Number.isInteger(options.messageId)
      ? options.messageId
      : persistMenu
        ? this.config.telegramControlPanelMessageId
        : null;
    const replyMarkup = options.replyMarkup || this.buildControlKeyboard();

    if (messageId) {
      try {
        await this.telegram.editMessageText(this.config.telegramChatId, messageId, text, {
          replyMarkup,
        });
        if (persistMenu) {
          this.config.set('telegramControlPanelMessageId', messageId);
        }
        return;
      } catch {
        // Fall through and send a fresh panel message if edit fails.
      }
    }

    const sentMessage = await this.safeSendMessage(text, {
      replyMarkup,
    });

    if (persistMenu && Number.isInteger(sentMessage?.message_id)) {
      this.config.set('telegramControlPanelMessageId', sentMessage.message_id);
    }
  }

  async openControlPanel(options = {}) {
    await this.publishTelegramView(this.buildControlPanelText(), {
      messageId: options.messageId,
      replyMarkup: this.buildControlKeyboard(),
      persistMenu: true,
    });
  }

  async sendProjectList(source = 'telegram', options = {}) {
    this.projectListCache = collectKnownWorkspaces(this.config, {
      limit: 12,
    });
    this.logCliEvent(source === 'cli' ? 'CLI projects' : 'Telegram projects', `${this.projectListCache.length} known`);
    const message = formatWorkspaceList(this.projectListCache, {
      activeWorkspacePath: this.getCurrentWorkspacePath(),
    });

    if (source === 'cli') {
      this.writeCliLine(message);
      return;
    }

    await this.publishTelegramView(message, {
      messageId: options.messageId,
      replyMarkup: this.buildProjectKeyboard(),
      persistMenu: options.persistMenu === true,
    });
  }

  buildProjectKeyboard() {
    if (!Array.isArray(this.projectListCache) || this.projectListCache.length === 0) {
      return null;
    }

    const inline_keyboard = [];
    for (let index = 0; index < this.projectListCache.length; index += 2) {
      const row = [];
      for (let offset = 0; offset < 2; offset += 1) {
        const project = this.projectListCache[index + offset];
        if (!project) {
          continue;
        }
        row.push({
          text: `${index + offset + 1}. ${project.label}`,
          callback_data: `project:${index + offset + 1}`,
        });
      }
      if (row.length > 0) {
        inline_keyboard.push(row);
      }
    }

    return this.mergeReplyMarkup({ inline_keyboard }, this.buildControlKeyboard());
  }

  buildSessionKeyboard() {
    if (!Array.isArray(this.resumeListCache.sessionIds) || this.resumeListCache.sessionIds.length === 0) {
      return null;
    }

    const inline_keyboard = [];
    for (let index = 0; index < this.resumeListCache.sessionIds.length; index += 3) {
      const row = [];
      for (let offset = 0; offset < 3; offset += 1) {
        const sessionId = this.resumeListCache.sessionIds[index + offset];
        if (!sessionId) {
          continue;
        }
        row.push({
          text: String(index + offset + 1),
          callback_data: `resume:${index + offset + 1}`,
        });
      }
      if (row.length > 0) {
        inline_keyboard.push(row);
      }
    }

    inline_keyboard.push([{ text: 'Latest', callback_data: 'resume:last' }]);
    return this.mergeReplyMarkup({ inline_keyboard }, this.buildControlKeyboard());
  }

  async handleCallbackAction(data, callbackQueryId, messageId = null) {
    const action = String(data || '').trim();
    if (!action) {
      return;
    }

    try {
      if (action === 'projects') {
        await this.telegram.answerCallbackQuery(callbackQueryId);
        await this.sendProjectList('telegram', { messageId, persistMenu: true });
        return;
      }

      if (action === 'sessions') {
        await this.telegram.answerCallbackQuery(callbackQueryId);
        await this.handleResumeCommand('list', 'telegram', { messageId, persistMenu: true });
        return;
      }

      if (action === 'menu') {
        await this.telegram.answerCallbackQuery(callbackQueryId);
        await this.openControlPanel({ messageId });
        return;
      }

      if (action === 'project_current') {
        await this.telegram.answerCallbackQuery(callbackQueryId);
        await this.publishTelegramView(this.buildCurrentProjectText(), {
          messageId,
          replyMarkup: this.buildControlKeyboard(),
          persistMenu: true,
        });
        return;
      }

      if (action === 'session_status') {
        await this.telegram.answerCallbackQuery(callbackQueryId);
        await this.publishTelegramView(this.buildSessionStatusText(), {
          messageId,
          replyMarkup: this.buildControlKeyboard(),
          persistMenu: true,
        });
        return;
      }

      if (action === 'status') {
        await this.telegram.answerCallbackQuery(callbackQueryId);
        await this.publishTelegramView(
          buildStatusText(
            this.config,
            this.provider,
            this.providerArgs,
            this.sleepInhibitorState,
            this.attachmentHandler?.getStatusText?.() || null
          ),
          {
            messageId,
            replyMarkup: this.buildControlKeyboard(),
            persistMenu: true,
          }
        );
        return;
      }

      if (action === 'usage') {
        await this.telegram.answerCallbackQuery(callbackQueryId);
        const usageText = await this.buildUsageText({
          force: true,
        });
        await this.publishTelegramView(usageText, {
          messageId,
          replyMarkup: this.buildControlKeyboard(),
          persistMenu: true,
        });
        return;
      }

      if (action === 'mode:latest') {
        await this.telegram.answerCallbackQuery(callbackQueryId, 'Latest mode selected');
        this.setSessionMode('latest');
        await this.publishTelegramView(this.buildSessionStatusText(), {
          messageId,
          replyMarkup: this.buildControlKeyboard(),
          persistMenu: true,
        });
        return;
      }

      if (action === 'mode:new') {
        await this.telegram.answerCallbackQuery(callbackQueryId, 'New mode selected');
        this.setSessionMode('new');
        await this.publishTelegramView(this.buildSessionStatusText(), {
          messageId,
          replyMarkup: this.buildControlKeyboard(),
          persistMenu: true,
        });
        return;
      }

      if (action.startsWith('project:')) {
        const value = action.slice('project:'.length).trim();
        await this.telegram.answerCallbackQuery(callbackQueryId, 'Switching project...');
        await this.handleProjectSwitchCommand(value, 'telegram', { messageId, persistMenu: true });
        return;
      }

      if (action.startsWith('resume:')) {
        const value = action.slice('resume:'.length).trim();
        await this.telegram.answerCallbackQuery(callbackQueryId, 'Switching session...');
        await this.handleResumeCommand(value, 'telegram', { messageId, persistMenu: true });
        return;
      }

      await this.telegram.answerCallbackQuery(callbackQueryId, 'Unknown action.');
    } catch (error) {
      this.logger.error(`Callback handling failed: ${error.message}`);
      try {
        await this.telegram.answerCallbackQuery(callbackQueryId, 'Action failed.');
      } catch {
        // Ignore callback answer failures.
      }
    }
  }

  async handleProjectSwitchCommand(rawArgument = '', source = 'telegram', options = {}) {
    const raw = String(rawArgument || '').trim();
    const force = raw.endsWith(' force');
    const argument = force ? raw.slice(0, -' force'.length).trim() : raw;
    const sourceLabel = source === 'cli' ? 'CLI' : 'Telegram';

    if (!argument || argument === 'current') {
      const message = this.buildCurrentProjectText();
      if (source === 'cli') {
        this.writeCliLine(message);
      } else {
        await this.publishTelegramView(message, {
          messageId: options.messageId,
          replyMarkup: this.buildControlKeyboard(),
          persistMenu: options.persistMenu === true,
        });
      }
      return;
    }

    if (this.activePromptAbortController) {
      if (!force) {
        await this.safeSendMessage('A request is currently running. Use /stop first or /project <target> force.', {
          replyMarkup: this.buildControlKeyboard(),
        });
        return;
      }

      this.requestStopCurrentPrompt('project_switch');
      this.clearQueuedTelegramMessages();
    }

    let targetPath = '';
    if (/^\d+$/.test(argument)) {
      const selected = this.projectListCache[Number(argument) - 1];
      if (!selected) {
        await this.safeSendMessage('Project list entry not found. Run /projects first.');
        return;
      }
      targetPath = selected.path;
    } else {
      targetPath = path.resolve(this.getCurrentWorkspacePath(), argument);
    }

    if (!fs.existsSync(targetPath)) {
      await this.safeSendMessage(`Project path does not exist: ${targetPath}`);
      return;
    }

    this.persistWorkspaceState();
    this.restoreWorkspaceState(targetPath);
    this.resumeListCache = {
      provider: this.provider,
      sessionIds: [],
    };

    const message = [
      `Switched project to ${targetPath}.`,
      `Provider: ${this.provider}`,
      `Session mode: ${this.sessionMode}`,
      `Session: ${this.getBoundSessionId() || '(latest in current folder)'}`,
    ].join('\n');

    this.logCliEvent(`${sourceLabel} project switch`, targetPath);

    if (source === 'cli') {
      this.writeCliLine(message);
      await this.safeSendMessage(message, { from: 'CLI' });
      return;
    }

    await this.publishTelegramView(message, {
      messageId: options.messageId,
      replyMarkup: this.buildControlKeyboard(),
      persistMenu: options.persistMenu === true,
    });
  }

  prepareStartupSession() {
    if (this.initialSessionId) {
      this.setSessionMode('pinned', this.initialSessionId);
      return;
    }

    if (this.startMode === 'new') {
      this.setSessionMode('new');
      return;
    }

    const workspace = this.config.getWorkspace(this.getCurrentWorkspacePath());
    if (workspace?.sessionMode === 'pinned' && workspace?.pinnedSessionId) {
      this.setSessionMode('pinned', workspace.pinnedSessionId);
      return;
    }

    if (workspace?.sessionMode === 'new') {
      this.setSessionMode('new');
      return;
    }

    this.setSessionMode('latest');
  }

  describeResumeTarget(sessionId) {
    const normalized = String(sessionId || '').trim();
    if (normalized) {
      return `session ${normalized}`;
    }

    return `your last ${formatProviderName(this.provider)} session in this folder`;
  }

  async handleResumeCommand(rawArgument = '', source = 'telegram', options = {}) {
    const argument = String(rawArgument || '').trim();
    const sourceLabel = source === 'cli' ? 'CLI' : 'Telegram';
    const runtime = createProviderRuntime(this.config, this.provider, this.providerArgs);
    const cachedSessionIds =
      this.resumeListCache.provider === this.provider && Array.isArray(this.resumeListCache.sessionIds) ? this.resumeListCache.sessionIds : [];

    if (argument === 'list' || argument === 'list all') {
      const includeAll = argument.endsWith(' all');
      const result = runtime.listSessions({
        cwd: process.cwd(),
        includeAll,
      });
      this.resumeListCache = {
        provider: this.provider,
        sessionIds: Array.isArray(result.sessions) ? result.sessions.map(session => session.id) : [],
      };
      this.logCliEvent(`${sourceLabel} resume`, argument);
      if (source === 'cli') {
        this.writeCliLine(result.text);
      } else {
        await this.publishTelegramView(result.text, {
          messageId: options.messageId,
          replyMarkup: this.buildSessionKeyboard(),
          persistMenu: options.persistMenu === true,
        });
      }
      return;
    }

    if (/^\d+$/.test(argument)) {
      const selectedIndex = Number(argument) - 1;
      const selectedSessionId = cachedSessionIds[selectedIndex];
      if (!selectedSessionId) {
        await this.safeSendMessage('Resume list entry not found. Run /resume list first.');
        return;
      }

      this.setSessionMode('pinned', selectedSessionId);
      this.logCliEvent(`${sourceLabel} resume`, `${argument} -> ${selectedSessionId}`);
      await this.safeSendMessage(`Next message will resume ${this.describeResumeTarget(selectedSessionId)}.`, {
        replyMarkup: this.buildControlKeyboard(),
      });
      return;
    }

    if (!argument) {
      const currentTarget = this.getBoundSessionId();
      this.logCliEvent(`${sourceLabel} resume`, currentTarget || this.sessionMode);
      await this.safeSendMessage(`Next message will resume ${this.describeResumeTarget(currentTarget)}.`, {
        replyMarkup: this.buildControlKeyboard(),
      });
      return;
    }

    if (argument === 'last') {
      this.setSessionMode('latest');
      this.logCliEvent(`${sourceLabel} resume`, 'last');
      await this.safeSendMessage(`Next message will resume ${this.describeResumeTarget(null)}.`, {
        replyMarkup: this.buildControlKeyboard(),
      });
      return;
    }

    this.setSessionMode('pinned', argument);
    this.logCliEvent(`${sourceLabel} resume`, argument);
    await this.safeSendMessage(`Next message will resume ${this.describeResumeTarget(argument)}.`, {
      replyMarkup: this.buildControlKeyboard(),
    });
  }

  startLocalInputLoop() {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      return;
    }

    if (this.localInputInterface) {
      return;
    }

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
      historySize: 1000,
    });

    this.localInputInterface = rl;
    this.writeCliLine('Local CLI input enabled. Type /help for local commands, or type a prompt directly.');
    rl.setPrompt('ushagent> ');
    rl.prompt();

    rl.on('line', line => {
      const value = String(line || '').trim();
      this.localInputQueue = this.localInputQueue
        .then(() => this.handleLocalInputLine(value))
        .catch(error => {
          this.logCliEvent('Local input error', error.message || String(error));
        })
        .finally(() => {
          if (this.running && this.localInputInterface) {
            this.localInputInterface.prompt();
          }
        });
    });

    rl.on('close', () => {
      this.localInputInterface = null;
    });
  }

  stopLocalInputLoop() {
    if (!this.localInputInterface) {
      return;
    }

    try {
      this.localInputInterface.close();
    } catch {
      // Ignore close failures.
    }

    this.localInputInterface = null;
  }

  async handleLocalInputLine(inputLine) {
    if (!this.running) {
      return;
    }

    const line = String(inputLine || '').trim();
    if (!line) {
      return;
    }

    if (line === '/help') {
      this.writeCliLine(
        [
          'Local CLI commands:',
          '/help - show this list',
          '/menu - open or refresh control panel in Telegram',
          '/history [N] - show recent messages from current Codex session',
          '/prev - show the latest message from current Codex session',
          '/projects - list known projects',
          '/project <number|path|current> - switch or inspect active project',
          '/sessions - list sessions for current project',
          '/usage - show remaining Codex usage',
          '/last - show the last completed request and response',
          '/status - show current status',
          '/session - show current session binding and next prompt mode',
          '/new - reset session (next prompt starts fresh)',
          '/resume [session-id|last|list|N] - resume saved, explicit, latest, listed session, or show sessions',
          '/r [session-id|last|list|N] - alias for /resume',
          '/stop - stop current execution and clear queued Telegram messages',
          '/say <text> - send a raw message to Telegram',
          '/ask <prompt> - run prompt through provider and send response to Telegram',
          '/exit - stop UshAgent',
          '',
          'Any plain text line is treated as /ask <line>.',
        ].join('\n')
      );
      return;
    }

    if (line === '/status') {
      this.writeCliLine(
        buildStatusText(
          this.config,
          this.provider,
          this.providerArgs,
          this.sleepInhibitorState,
          this.attachmentHandler?.getStatusText?.() || null
        )
      );
      return;
    }

    if (line === '/projects') {
      await this.sendProjectList('cli');
      return;
    }

    if (line === '/usage') {
      this.writeCliLine(await this.buildUsageText({ force: true }));
      return;
    }

    if (line === '/prev') {
      this.writeCliLine(this.buildPreviousMessageText());
      return;
    }

    if (line === '/last') {
      this.writeCliLine(this.buildLastExchangeText());
      return;
    }

    if (line === '/history' || line.startsWith('/history ')) {
      const argument = line.slice('/history'.length).trim();
      const limit = argument ? Number(argument) : 10;
      this.writeCliLine(this.buildHistoryText(limit));
      return;
    }

    if (line === '/menu') {
      await this.openControlPanel();
      return;
    }

    if (line === '/project' || line.startsWith('/project ') || line === '/p' || line.startsWith('/p ')) {
      const commandLength = line.startsWith('/p') && !line.startsWith('/project') ? '/p'.length : '/project'.length;
      const argument = line.slice(commandLength).trim();
      await this.handleProjectSwitchCommand(argument, 'cli');
      return;
    }

    if (line === '/sessions') {
      await this.handleResumeCommand('list', 'cli');
      return;
    }

    if (line === '/session') {
      this.writeCliLine(this.buildSessionStatusText());
      return;
    }

    if (line === '/new') {
      this.resetSessionMode();
      await this.safeSendMessage('Session reset from CLI. Your next message starts fresh.');
      return;
    }

    if (line === '/resume' || line.startsWith('/resume ') || line === '/r' || line.startsWith('/r ')) {
      const commandLength = line.startsWith('/r') && !line.startsWith('/resume') ? '/r'.length : '/resume'.length;
      const argument = line.slice(commandLength).trim();
      await this.handleResumeCommand(argument, 'cli');
      return;
    }

    if (line === '/stop') {
      const stopped = this.requestStopCurrentPrompt('manual_stop');
      const clearedCount = this.clearQueuedTelegramMessages();

      if (stopped) {
        await this.safeSendMessage(`Stopping current ${formatProviderName(this.provider)} request and clearing queued messages...`, { from: 'CLI' });
      } else if (clearedCount > 0) {
        await this.safeSendMessage(`Cleared ${clearedCount} queued Telegram message${clearedCount === 1 ? '' : 's'}.`, { from: 'CLI' });
      } else {
        this.writeCliLine('No active request to stop.');
      }
      return;
    }

    if (line === '/exit') {
      this.running = false;
      this.writeCliLine('Stopping UshAgent...');
      this.stopLocalInputLoop();
      return;
    }

    if (line.startsWith('/say ')) {
      const message = line.slice(5).trim();
      if (!message) {
        this.writeCliLine('Usage: /say <text>');
        return;
      }
      await this.safeSendMessage(message, { from: 'CLI' });
      return;
    }

    if (line.startsWith('/ask ')) {
      const prompt = line.slice(5).trim();
      if (!prompt) {
        this.writeCliLine('Usage: /ask <prompt>');
        return;
      }
      this.recordConversationEntry({
        source: 'cli',
        direction: 'in',
        text: prompt,
      });
      await this.queuePrompt(prompt, 'cli');
      return;
    }

    if (line.startsWith('/')) {
      this.writeCliLine('Unknown local command. Use /help.');
      return;
    }

    this.recordConversationEntry({
      source: 'cli',
      direction: 'in',
      text: line,
    });
    await this.queuePrompt(line, 'cli');
  }

  async ensureBridgeReady() {
    const tokenInfo =
      typeof this.config.getTelegramBotTokenInfo === 'function'
        ? this.config.getTelegramBotTokenInfo()
        : {
            token: String(this.config.telegramBotToken || '').trim(),
            source: this.config.telegramBotToken ? 'config' : null,
            persisted: Boolean(this.config.telegramBotToken),
          };
    const storedToken = String(tokenInfo.token || '').trim();
    let tokenConnected = false;

    if (storedToken) {
      tokenConnected = await this.connectToken(storedToken, {
        persistToken: tokenInfo.persisted !== false,
      });
      if (!tokenConnected && tokenInfo.source && tokenInfo.source.startsWith('env:')) {
        throw new Error(`Telegram bot token from ${tokenInfo.source} is invalid. Fix .env/environment and restart.`);
      }
    }

    if (!tokenConnected) {
      this.config.clearPairing({ keepBotToken: false });
    }

    const needToken = !tokenConnected;
    const needPairing = !this.config.telegramChatId;

    if (!needToken && !needPairing) {
      return {
        chatId: this.config.telegramChatId,
      };
    }

    const setupMode = await this.selectSetupMode();
    if (setupMode === SETUP_MODE_PHONE) {
      return this.runPhoneOnboardingSetup({ needToken, needPairing });
    }

    return this.runManualSetup({ needToken, needPairing });
  }

  async selectSetupMode() {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      return select({
        message: 'Telegram setup mode',
        default: SETUP_MODE_PHONE,
        choices: [
          {
            name: 'Phone setup (recommended) — scan one QR code and complete guided steps on your phone',
            value: SETUP_MODE_PHONE,
          },
          {
            name: 'Manual fallback — no tunnel required; paste the bot token directly into the terminal',
            value: SETUP_MODE_MANUAL,
          },
        ],
      });
    }

    console.log('Interactive setup selection is unavailable in this terminal.');
    console.log('Using manual fallback setup (no tunnel).');
    return SETUP_MODE_MANUAL;
  }

  async runPhoneOnboardingSetup(options = {}) {
    const needToken = Boolean(options.needToken);
    const needPairing = Boolean(options.needPairing);
    let onboarding = null;

    try {
      onboarding = await createOnboardingSession({
        timeoutMs: 20 * 60 * 1000,
        onReady: url => {
          console.log('\nPhone setup (recommended).');
          console.log('Scan this QR code and complete the guided steps on your phone:\n');
          qrcode.generate(url, { small: true });
          console.log(`Link: ${url}\n`);
          console.log('Waiting for onboarding completion...');
        },
      });

      if (needToken) {
        while (this.running) {
          const token = await onboarding.waitForToken();
          const connected = await this.connectToken(token);
          if (connected) {
            onboarding.setTokenValidated({
              botUsername: this.config.telegramBotUsername,
            });
            break;
          }

          onboarding.setTokenInvalid('Telegram rejected this token. Check token and submit again.');
        }
      } else {
        onboarding.setTokenValidated({
          botUsername: this.config.telegramBotUsername,
          preconfigured: true,
        });
      }

      if (!this.running) {
        throw new Error('Setup cancelled');
      }

      let pairing = {
        chatId: this.config.telegramChatId,
      };

      if (needPairing) {
        pairing = await this.runPairingFlow({
          mode: 'onboarding',
          onPairLink: deepLink => onboarding.setPairLink(deepLink),
          onStatus: text => onboarding.setPairingStatus(text),
        });
      } else {
        onboarding.setPairingStatus('Chat already paired on this device.');
      }

      onboarding.markPaired({ chatId: pairing.chatId });
      await sleep(1500);
      return pairing;
    } catch (error) {
      if (onboarding) {
        onboarding.setError(error.message);
      }
      throw error;
    } finally {
      if (onboarding) {
        await onboarding.close();
      }
    }
  }

  async runManualSetup(options = {}) {
    const needToken = Boolean(options.needToken);
    const needPairing = Boolean(options.needPairing);

    if (needToken) {
      while (this.running) {
        if (!this.manualHelpShown) {
          printManualTokenSetupHelp();
          this.manualHelpShown = true;
        }

        const token = await promptLine('Telegram bot token: ');
        if (!token) {
          console.log('Token is required.');
          continue;
        }

        const connected = await this.connectToken(token.trim());
        if (connected) {
          break;
        }
      }
    }

    if (!this.running) {
      throw new Error('Setup cancelled');
    }

    if (needPairing) {
      return this.runPairingFlow({ mode: 'manual' });
    }

    return {
      chatId: this.config.telegramChatId,
    };
  }

  async connectToken(token, options = {}) {
    const normalizedToken = String(token || '').trim();
    const persistToken = options.persistToken !== false;
    if (!TelegramApi.isLikelyToken(normalizedToken)) {
      console.error('This does not look like a valid Telegram bot token.');
      return false;
    }

    const previousStoredToken =
      typeof this.config.getStoredTelegramBotToken === 'function' ? this.config.getStoredTelegramBotToken() : this.config.telegramBotToken;
    const previousBotId = this.config.telegramBotId;
    const previousBotUsername = this.config.telegramBotUsername;
    const telegram = new TelegramApi(normalizedToken);

    try {
      await telegram.ensurePollingMode();
      const me = await telegram.getMe();

      const nextBotId = me.id === undefined || me.id === null ? null : String(me.id);
      const nextBotUsername = me.username || null;
      const botChanged =
        (previousBotId && nextBotId && previousBotId !== nextBotId) ||
        (previousBotUsername && nextBotUsername && previousBotUsername !== nextBotUsername);
      const tokenChanged = persistToken && previousStoredToken && previousStoredToken !== normalizedToken;
      if (botChanged || tokenChanged) {
        this.config.clearPairing({ keepBotToken: persistToken });
      }

      this.telegram = telegram;
      this.config.setMany(
        persistToken
          ? {
              telegramBotToken: normalizedToken,
              telegramBotUsername: nextBotUsername,
              telegramBotId: nextBotId,
            }
          : {
              telegramBotUsername: nextBotUsername,
              telegramBotId: nextBotId,
            }
      );

      return true;
    } catch (error) {
      if (error instanceof TelegramApiError && error.status === 401) {
        console.error('Telegram rejected the token (401 Unauthorized).');
      } else {
        console.error(`Token validation failed: ${error.message}`);
      }
      return false;
    }
  }

  resetSessionMode() {
    this.setSessionMode('new');
  }

  buildSessionStatusText() {
    const boundSessionId = this.getBoundSessionId();
    const lastSessionId = this.getLastSessionId();
    const nextAction = this.forceNewNextPrompt ? `new ${formatProviderName(this.provider)} session` : `resume ${this.describeResumeTarget(boundSessionId)}`;

    return [
      `Workspace: ${this.getCurrentWorkspacePath()}`,
      `Provider: ${this.provider}`,
      `Session mode: ${this.sessionMode}`,
      `Bound session: ${boundSessionId || '(latest in current folder)'}`,
      `Last session: ${lastSessionId || '-'}`,
      `Next prompt: ${nextAction}`,
    ].join('\n');
  }

  clearQueuedTelegramMessages() {
    const count = this.telegramPendingMessages.length;
    this.telegramPendingMessages = [];
    return count;
  }

  requestStopCurrentPrompt(reason = 'manual_stop') {
    const controller = this.activePromptAbortController;
    if (!controller || controller.signal.aborted) {
      return false;
    }

    this.activePromptAbortReason = reason;
    controller.abort();
    return true;
  }

  isPromptAbortError(error) {
    const message = error?.message ? String(error.message) : String(error || '');
    return /aborted/i.test(message);
  }

  startTelegramDispatch(groupAll = false) {
    if (!this.running) {
      return;
    }

    if (this.telegramDispatchScheduled) {
      return;
    }

    if (this.activePromptAbortController) {
      return;
    }

    if (this.telegramPendingMessages.length === 0) {
      return;
    }

    const pending = groupAll ? this.telegramPendingMessages.splice(0) : [this.telegramPendingMessages.shift()];
    const combinedPrompt = pending.join('\n').trim();
    if (!combinedPrompt) {
      return;
    }

    this.telegramDispatchScheduled = true;
    this.queuePrompt(combinedPrompt, 'telegram', {
      groupedCount: pending.length,
    })
      .catch(error => {
        this.logger.error(`Failed to process grouped Telegram messages: ${error.message}`);
      })
      .finally(() => {
        this.telegramDispatchScheduled = false;
        if (this.telegramPendingMessages.length > 0) {
          this.startTelegramDispatch(true);
        }
      });
  }

  async enqueueTelegramPrompt(text) {
    const cleanText = String(text || '').trim();
    if (!cleanText) {
      return;
    }

    this.telegramPendingMessages.push(cleanText);

    if (this.activePromptAbortController || this.telegramDispatchScheduled) {
      return;
    }

    this.startTelegramDispatch(false);
  }

  async queuePrompt(prompt, source, options = {}) {
    const cleanPrompt = String(prompt || '').trim();
    if (!cleanPrompt) {
      return;
    }

    const run = async () => {
      const sourceLabel = source === 'cli' ? 'CLI' : 'Telegram';
      const providerLabel = formatProviderName(this.provider);
      const resume = !this.forceNewNextPrompt;
      const abortController = new globalThis.AbortController();
      const groupedCount = Number.isFinite(options.groupedCount) ? Math.max(1, Number(options.groupedCount)) : 1;
      this.logCliEvent(`${sourceLabel} -> ${providerLabel}`, cleanPrompt);
      this.activePromptAbortController = abortController;
      this.activePromptSource = source;
      this.activePromptAbortReason = null;

      try {
        if (source === 'telegram') {
          if (groupedCount > 1) {
            await this.safeSendMessage(`${providerLabel} is working on ${groupedCount} messages...`);
          } else {
            await this.safeSendMessage(`${providerLabel} is working...`);
          }
        }

        const response = await this.runProvider(cleanPrompt, resume, {
          abortSignal: abortController.signal,
        });

        if (this.sessionMode === 'new') {
          this.sessionMode = 'latest';
          this.forceNewNextPrompt = false;
        }
        this.persistWorkspaceState();
        this.lastExchange = {
          source,
          prompt: cleanPrompt,
          response: String(response || '').trim() || 'No response.',
        };
        await this.safeSendMessage(response, { from: providerLabel });
      } catch (error) {
        if (abortController.signal.aborted || this.isPromptAbortError(error)) {
          return;
        }

        await this.safeSendMessage(`Error: ${error.message}`);
        this.logger.error(`Provider execution failed: ${error.message}`);
      } finally {
        if (this.activePromptAbortController === abortController) {
          this.activePromptAbortController = null;
          this.activePromptSource = null;
          this.activePromptAbortReason = null;
        }

        if (this.telegramPendingMessages.length > 0 && !this.telegramDispatchScheduled) {
          this.startTelegramDispatch(true);
        }
      }
    };

    this.promptQueue = this.promptQueue.then(run, run);
    await this.promptQueue;
  }

  async runPairingFlow(options = {}) {
    const mode = options.mode || 'manual';
    const onPairLink = typeof options.onPairLink === 'function' ? options.onPairLink : null;
    const onStatus = typeof options.onStatus === 'function' ? options.onStatus : null;

    const botUsername = this.config.telegramBotUsername;
    if (!botUsername) {
      throw new Error('Telegram bot username is unavailable. Create a bot with @BotFather first.');
    }

    const code = makePairCode();
    const deepLink = `https://t.me/${botUsername}?start=ha2_${code}`;

    if (mode === 'manual') {
      console.log('\nTelegram pairing is required (manual fallback).');
      console.log('1. Scan this QR code or open the link');
      console.log('2. Press START in Telegram');
      console.log('3. Keep this terminal open until pairing completes\n');
      qrcode.generate(deepLink, { small: true });
      console.log(`Link: ${deepLink}`);
      console.log('If needed, open your bot manually and press START.\n');
      console.log('Waiting for Telegram pairing...');
    } else {
      if (onPairLink) {
        onPairLink(deepLink);
      }
      if (onStatus) {
        onStatus('Open bot chat and press START. Waiting for Telegram pairing...');
      }
      console.log('\nWaiting for Telegram pairing from phone onboarding...');
    }

    let cursor = this.config.telegramUpdateCursor || 0;

    while (this.running) {
      try {
        const result = await this.telegram.getUpdates(cursor, 20);
        const nextCursor = Number.isFinite(result.nextCursor) ? result.nextCursor : cursor;
        if (nextCursor > cursor) {
          cursor = nextCursor;
          this.config.set('telegramUpdateCursor', cursor);
        }

        for (const message of result.messages) {
          if (message.chatType !== 'private') {
            continue;
          }

          if (!isPairStartMessage(message.text, code)) {
            continue;
          }

          if (!message.chatId) {
            continue;
          }

          this.config.setMany({
            telegramChatId: message.chatId,
            telegramChatUserId: message.userId || null,
          });

          if (onStatus) {
            onStatus(`Paired successfully (chat ${message.chatId}).`);
          }

          await this.telegram.sendMessage(message.chatId, `UshAgent paired for ${this.provider}.\nSend /help for commands.`);

          return {
            chatId: message.chatId,
          };
        }
      } catch (error) {
        if (error instanceof TelegramApiError && error.status === 401) {
          this.config.clearPairing({ keepBotToken: false });
          if (onStatus) {
            onStatus('Telegram token became invalid. Restart setup.');
          }
          throw new Error('Telegram bot token is invalid. Restart and enter a new token.');
        }

        this.logger.warn(`Pair poll failed: ${error.message}`);
        await sleep(2000);
      }
    }

    throw new Error('Pairing cancelled');
  }

  async pollOnce() {
    const chatId = this.config.telegramChatId;
    const chatUserId = this.config.telegramChatUserId;
    const cursor = this.config.telegramUpdateCursor || 0;

    if (!chatId) {
      throw new Error('No Telegram chat is paired. Run `ushagent reset` then start again.');
    }

    try {
      const result = await this.telegram.getUpdates(cursor, 20);
      const nextCursor = Number.isFinite(result.nextCursor) ? result.nextCursor : cursor;
      if (nextCursor > cursor) {
        this.config.set('telegramUpdateCursor', nextCursor);
      }

      for (const message of result.messages) {
        if (!this.running) {
          break;
        }

        if (message.chatId !== chatId) {
          continue;
        }

        if (chatUserId && message.userId && message.userId !== chatUserId) {
          continue;
        }

        if (message.text && message.text.trim().startsWith('/')) {
          this.logCliEvent('Telegram command', message.text);
        }

        if (message.type === 'callback') {
          await this.handleCallbackAction(message.data || message.text || '', message.callbackQueryId, message.messageId || null);
          continue;
        }

        if (message.fileId) {
          await this.handleAttachmentMessage(message);
          continue;
        }

        await this.handleMessage(message.text || '');
      }
    } catch (error) {
      if (error instanceof TelegramApiError && error.status === 401) {
        this.config.clearPairing({ keepBotToken: false });
        this.running = false;
        throw new Error('Telegram bot token is invalid. Restart and enter a new token.');
      }

      this.logger.error(`Inbox poll failed: ${error.message}`);
      await sleep(2000);
    }
  }

  async handleMessage(rawText) {
    const text = String(rawText || '').trim();
    if (!text) {
      return;
    }

    this.recordConversationEntry({
      source: 'telegram',
      direction: 'in',
      text,
    });

    if (text.startsWith('/')) {
      await this.handleCommand(text);
      return;
    }

    await this.enqueueTelegramPrompt(text);
  }

  async handleAttachmentMessage(message) {
    const fileId = String(message.fileId || '').trim();
    if (!fileId) {
      return;
    }

    const durationText = Number.isFinite(message.durationSec) ? ` (${message.durationSec}s)` : '';
    this.logCliEvent(`Telegram -> ${message.type || 'Attachment'}`, `received${durationText}`);
    this.recordConversationEntry({
      source: 'telegram',
      direction: 'in',
      text: `[attachment:${message.type || 'file'}]${durationText}`,
    });
    await this.safeSendMessage('Attachment received.');

    if (this.attachmentHandler?.isAudioAttachment(message.type)) {
      await this.safeSendMessage(DICTATION_HINT_TEXT);
    }

    try {
      const prepared = await this.attachmentHandler.createPrompt(message);
      await this.enqueueTelegramPrompt(prepared.prompt);
    } catch (error) {
      const messageText = error?.message ? String(error.message) : String(error);
      this.logger.error(`Attachment handling failed: ${messageText}`);
      await this.safeSendMessage(`Failed to handle attachment: ${messageText}`);
    }
  }

  async handleCommand(text) {
    const parts = String(text || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const command = normalizeTelegramCommand(parts[0] || '');
    const argument = parts.slice(1).join(' ').trim();

    if (command === '/help') {
      await this.safeSendMessage(
        [
          'UshAgent commands:',
          '/help - show command list',
          '/menu - open or refresh control panel',
          '/history [N] - show recent messages from current Codex session',
          '/prev - show the latest message from current Codex session',
          '/projects - list known projects',
          '/project <number|path|current> - switch or inspect active project',
          '/sessions - list sessions for current project',
          '/usage - show remaining Codex usage',
          '/last - show the last completed request and response',
          '/new - start a fresh session',
          '/resume [session-id|last|list|N] - resume saved, explicit, latest, listed session, or show sessions',
          '/r [session-id|last|list|N] - alias for /resume',
          '/stop - stop current execution and clear queued messages',
          '/session - show current session binding and next prompt mode',
          '/status - show current status',
          '',
          `Send any normal message to talk to ${this.provider}.`,
          DICTATION_HINT_TEXT,
        ].join('\n'),
        {
          replyMarkup: this.buildControlKeyboard(),
        }
      );
      return;
    }

    if (command === '/new') {
      this.resetSessionMode();
      await this.safeSendMessage('Session reset. Your next message starts fresh.');
      return;
    }

    if (command === '/projects') {
      await this.sendProjectList('telegram', { persistMenu: true });
      return;
    }

    if (command === '/usage') {
      await this.publishTelegramView(await this.buildUsageText({ force: true }), {
        replyMarkup: this.buildControlKeyboard(),
        persistMenu: true,
      });
      return;
    }

    if (command === '/last') {
      await this.safeSendMessage(this.buildLastExchangeText(), {
        replyMarkup: this.buildControlKeyboard(),
      });
      return;
    }

    if (command === '/history') {
      const limit = argument ? Number(argument) : 10;
      await this.safeSendMessage(this.buildHistoryText(limit), {
        replyMarkup: this.buildControlKeyboard(),
      });
      return;
    }

    if (command === '/prev') {
      await this.safeSendMessage(this.buildPreviousMessageText(), {
        replyMarkup: this.buildControlKeyboard(),
      });
      return;
    }

    if (command === '/menu') {
      await this.openControlPanel();
      return;
    }

    if (command === '/project' || command === '/p') {
      await this.handleProjectSwitchCommand(argument, 'telegram', { persistMenu: true });
      return;
    }

    if (command === '/sessions') {
      await this.handleResumeCommand('list', 'telegram', { persistMenu: true });
      return;
    }

    if (command === '/resume' || command === '/r') {
      await this.handleResumeCommand(argument, 'telegram');
      return;
    }

    if (command === '/session') {
      await this.publishTelegramView(this.buildSessionStatusText(), {
        replyMarkup: this.buildControlKeyboard(),
        persistMenu: true,
      });
      return;
    }

    if (command === '/status') {
      await this.publishTelegramView(
        buildStatusText(
          this.config,
          this.provider,
          this.providerArgs,
          this.sleepInhibitorState,
          this.attachmentHandler?.getStatusText?.() || null
        ),
        {
          replyMarkup: this.buildControlKeyboard(),
          persistMenu: true,
        }
      );
      return;
    }

    if (command === '/stop') {
      const stopped = this.requestStopCurrentPrompt('manual_stop');
      const clearedCount = this.clearQueuedTelegramMessages();

      if (stopped) {
        await this.safeSendMessage(`Stopping current ${formatProviderName(this.provider)} request and clearing queued messages...`);
      } else if (clearedCount > 0) {
        await this.safeSendMessage(`Cleared ${clearedCount} queued message${clearedCount === 1 ? '' : 's'}.`);
      } else {
        await this.safeSendMessage('No active request to stop.');
      }
      return;
    }

    await this.safeSendMessage('Unknown command. Use /help.');
  }

  async runProvider(prompt, resume, options = {}) {
    const abortSignal = options.abortSignal || null;
    const runtime = createProviderRuntime(this.config, this.provider, this.providerArgs);
    return runtime.run(prompt, {
      resume: this.sessionMode !== 'new',
      cwd: process.cwd(),
      abortSignal,
      sessionId: this.sessionMode === 'pinned' ? this.getPinnedSessionId() : '',
    });
  }

  async safeSendMessage(text, options = {}) {
    const chatId = this.config.telegramChatId;
    const from = String(options.from || 'UshAgent').trim() || 'UshAgent';
    const replyMarkup = options.replyMarkup || null;

    if (!chatId) {
      return;
    }

    this.logCliEvent(`${from} -> Telegram`, text);
    this.recordConversationEntry({
      source: from === 'CLI' ? 'cli' : from === formatProviderName(this.provider) ? 'provider' : 'system',
      direction: 'out',
      text,
    });

    try {
      return await this.telegram.sendMessage(chatId, text, {
        replyMarkup,
      });
    } catch (error) {
      this.logger.error(`Outbox send failed: ${error.message}`);

      if (error instanceof TelegramApiError && error.status === 401) {
        this.config.clearPairing({ keepBotToken: false });
        this.running = false;
        console.error('Telegram bot token is invalid. Restart and enter a new token.');
      }

      return null;
    }
  }
}

export default Bridge;
