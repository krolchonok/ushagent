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
import { createClientBootstrapBundle } from './client-bootstrap.js';
import { formatSleepInhibitorStatus, startSleepInhibitor } from './sleep-inhibitor.js';
import { createAttachmentHandler } from './attachment-handler.js';
import { collectKnownWorkspaces, formatWorkspaceList } from './workspace-manager.js';
import { fetchCodexUsage, formatCodexUsage } from './providers/codex-usage.js';
import {
  createProviderRuntime,
  formatProviderName,
  getProviderDefinition,
  getProviderSessionId,
  setProviderSessionId,
} from './providers/provider-registry.js';

const BOTFATHER_URL = 'https://t.me/BotFather';
const SETUP_MODE_PHONE = 'phone_onboarding';
const SETUP_MODE_MANUAL = 'manual_fallback';
const TELEGRAM_CHAT_MODE_PRIVATE = 'private';
const TELEGRAM_CHAT_MODE_FORUM = 'forum';
const ATTACHMENT_DOWNLOAD_DIR = path.join(os.tmpdir(), 'ushagent-files');
const DICTATION_HINT_TEXT = 'Hint: for voice input, use your phone keyboard dictation.';
const MAX_CONVERSATION_HISTORY = 40;
const TELEGRAM_POLL_TIMEOUT_SEC = 5;
const CODEX_LONG_RUNNING_NOTICE_MS = 20 * 60 * 1000;
const TELEGRAM_BOT_COMMANDS = Object.freeze([
  { command: 'help', description: 'Show available commands' },
  { command: 'keyboard', description: 'Configure reply keyboard buttons' },
  { command: 'menu', description: 'Open the control panel' },
  { command: 'status', description: 'Show current bridge status' },
  { command: 'new', description: 'Start a fresh session on next prompt' },
  { command: 'session', description: 'Show current session binding' },
  { command: 'sessions', description: 'List sessions for current project' },
  { command: 'resume', description: 'Resume a saved or listed session' },
  { command: 'project', description: 'Switch or inspect the active project' },
  { command: 'projects', description: 'List known projects' },
  { command: 'usage', description: 'Show Codex usage status' },
  { command: 'history', description: 'Show recent session messages' },
  { command: 'prev', description: 'Show the latest session message' },
  { command: 'last', description: 'Show the last completed exchange' },
  { command: 'stop', description: 'Stop current execution and clear queue' },
]);
const MAIN_TOPIC_KEY = 'main';
const DEBUG_CODEX_STREAM = /^(1|true|yes|on)$/i.test(String(process.env.USHAGENT_CODEX_DEBUG_STREAM || '').trim());

function sanitizeTopicSegment(value, fallback = 'unknown') {
  const normalized = String(value || '')
    .trim()
    .replace(/\s+/g, ' ');
  return normalized || fallback;
}

function getHostTopicKey(hostname = os.hostname()) {
  return `host:${String(hostname || '').trim().toLowerCase()}`;
}

function getProjectTopicKey(workspacePath, hostname = os.hostname()) {
  return `project:${String(hostname || '').trim().toLowerCase()}:${String(workspacePath || '').trim().toLowerCase()}`;
}

function buildHostTopicTitle(hostname = os.hostname()) {
  return `HOST: ${sanitizeTopicSegment(hostname, 'HOST')}`;
}

function buildProjectTopicTitle(workspacePath, hostname = os.hostname()) {
  return `${sanitizeTopicSegment(hostname, 'HOST')} | ${sanitizeTopicSegment(path.basename(workspacePath) || workspacePath, 'project')}`;
}

function formatWorkspaceLabel(workspacePath) {
  return path.basename(workspacePath) || workspacePath;
}

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

function summarizeCodexEventLine(line) {
  const normalized = String(line || '').trim();
  if (!normalized.startsWith('{')) {
    return toLogPreview(normalized);
  }

  try {
    const event = JSON.parse(normalized);
    const eventType = typeof event?.type === 'string' ? event.type : 'unknown';
    return `${eventType}: ${toLogPreview(normalized)}`;
  } catch {
    return toLogPreview(normalized);
  }
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

function getTelegramBotCommands() {
  return TELEGRAM_BOT_COMMANDS.map(command => ({ ...command }));
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
    this.executionStates = new Map();
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
    this.isStopping = false;
    this.telegramForumState = null;
    this.telegramThreadId = null;

    this.onSignal = () => {
      if (this.isStopping) {
        return;
      }
      this.isStopping = true;
      this.requestStopCurrentPrompt('shutdown', { all: true });
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
      await this.ensureTelegramForumContext(pairing.chatId);
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
      const startupHeadline = this.telegramForumState?.enabled
        ? `UshAgent connected in host control mode for ${os.hostname()}. Use this topic to manage projects.`
        : this.startMode === 'new'
          ? `UshAgent connected. Next message starts a new ${providerLabel} session.`
          : this.initialSessionId
            ? `UshAgent connected to ${providerLabel} session ${this.initialSessionId}.`
            : `UshAgent connected. Next message resumes ${this.describeResumeTarget(this.getBoundSessionId())}.`;

      const startupMessage = await this.safeSendMessage([startupHeadline, 'Send /help for available commands.', DICTATION_HINT_TEXT].join('\n\n'), {
        replyMarkup: this.buildPersistentReplyKeyboard(),
        silent: true,
      });
      if (Number.isInteger(startupMessage?.message_id)) {
        this.config.setTelegramControlPanelMessageId(
          this.getControlPanelSlotKey(this.getActiveTelegramThreadId()),
          startupMessage.message_id
        );
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

  isForumModeEnabled() {
    return this.telegramForumState?.enabled === true && Number.isInteger(this.telegramThreadId);
  }

  getActiveTelegramThreadId() {
    return this.isForumModeEnabled() ? this.telegramThreadId : null;
  }

  getForumTopics() {
    return this.telegramForumState?.topics || this.config.telegramForum?.topics || {};
  }

  findForumTopicByThreadId(threadId) {
    if (!Number.isInteger(threadId)) {
      return null;
    }

    for (const [topicKey, topic] of Object.entries(this.getForumTopics())) {
      if (topic?.threadId === threadId) {
        return {
          key: topicKey,
          ...topic,
        };
      }
    }

    return null;
  }

  listForumTopicsByKind(kind, options = {}) {
    const topics = Object.entries(this.getForumTopics())
      .filter(([, topic]) => topic?.kind === kind)
      .map(([key, topic]) => ({
        key,
        ...topic,
      }));

    const hostname = String(options.hostname || '').trim().toLowerCase();
    if (!hostname) {
      return topics;
    }

    return topics.filter(topic => String(topic.hostname || '').trim().toLowerCase() === hostname);
  }

  async ensureTelegramForumContext(chatId) {
    if (!this.telegram || !chatId) {
      this.telegramForumState = null;
      this.telegramThreadId = null;
      return null;
    }

    const chat = await this.telegram.getChat(chatId);
    if (chat?.is_forum !== true) {
      this.telegramForumState = {
        enabled: false,
        chatId,
        mainThreadId: null,
        topics: {},
      };
      this.telegramThreadId = null;
      this.config.setTelegramForum(this.telegramForumState);
      return this.telegramForumState;
    }

    const hostname = os.hostname();
    const currentForum = this.config.telegramForum;
    const topics = { ...currentForum.topics };

    const ensureTopic = async (topicKey, title, extra = {}) => {
      const existing = topics[topicKey];
      if (Number.isInteger(existing?.threadId)) {
        return existing;
      }

      const created = await this.telegram.createForumTopic(chatId, title);
      const threadId = Number.isInteger(created?.message_thread_id)
        ? created.message_thread_id
        : Number.isInteger(created?.messageThreadId)
          ? created.messageThreadId
          : null;
      if (!Number.isInteger(threadId)) {
        throw new Error(`Telegram did not return a thread id for topic ${title}`);
      }

      const record = {
        threadId,
        title,
        updatedAt: new Date().toISOString(),
        ...extra,
      };
      topics[topicKey] = record;
      return record;
    };

    const mainTopic = await ensureTopic(MAIN_TOPIC_KEY, 'MAIN', {
      kind: 'main',
    });
    const hostTopicKey = getHostTopicKey(hostname);
    const hostTopic = await ensureTopic(hostTopicKey, buildHostTopicTitle(hostname), {
      kind: 'host',
      hostname,
    });

    this.telegramForumState = {
      enabled: true,
      chatId,
      mainThreadId: mainTopic.threadId,
      topics,
      hostTopicKey,
      hostThreadId: hostTopic.threadId,
      projectTopicKey: null,
      projectThreadId: null,
    };
    this.telegramThreadId = hostTopic.threadId;
    this.config.setTelegramForum({
      enabled: true,
      chatId,
      mainThreadId: mainTopic.threadId,
      topics,
    });

    return this.telegramForumState;
  }

  async ensureTelegramProjectTopic(chatId, workspacePath, hostname = os.hostname()) {
    if (!this.telegram || !chatId) {
      return null;
    }

    const currentForum = this.config.telegramForum;
    const topics = { ...currentForum.topics };
    const hostTopicKey = getHostTopicKey(hostname);
    const projectTopicKey = getProjectTopicKey(workspacePath, hostname);

    const ensureTopic = async (topicKey, title, extra = {}) => {
      const existing = topics[topicKey];
      if (Number.isInteger(existing?.threadId)) {
        return existing;
      }

      const created = await this.telegram.createForumTopic(chatId, title);
      const threadId = Number.isInteger(created?.message_thread_id)
        ? created.message_thread_id
        : Number.isInteger(created?.messageThreadId)
          ? created.messageThreadId
          : null;
      if (!Number.isInteger(threadId)) {
        throw new Error(`Telegram did not return a thread id for topic ${title}`);
      }

      const record = {
        threadId,
        title,
        updatedAt: new Date().toISOString(),
        ...extra,
      };
      topics[topicKey] = record;
      return record;
    };

    const hostTopic = await ensureTopic(hostTopicKey, buildHostTopicTitle(hostname), {
      kind: 'host',
      hostname,
    });
    const projectTopic = await ensureTopic(projectTopicKey, buildProjectTopicTitle(workspacePath, hostname), {
      kind: 'project',
      hostname,
      workspacePath,
      hostKey: hostTopicKey,
    });

    this.telegramForumState = {
      ...(this.telegramForumState || currentForum),
      enabled: true,
      chatId,
      mainThreadId: Number.isInteger(currentForum.mainThreadId) ? currentForum.mainThreadId : this.telegramForumState?.mainThreadId ?? null,
      topics,
      hostTopicKey,
      projectTopicKey,
      hostThreadId: hostTopic.threadId,
      projectThreadId: projectTopic.threadId,
    };
    this.telegramThreadId = projectTopic.threadId;
    this.config.setTelegramForum({
      enabled: true,
      chatId,
      mainThreadId: this.telegramForumState.mainThreadId,
      topics,
    });

    return projectTopic;
  }

  logCliEvent(label, text = '') {
    const timestamp = new Date().toLocaleTimeString();
    const suffix = text ? `: ${toLogPreview(text)}` : '';
    this.writeCliLine(`[${timestamp}] ${label}${suffix}`);
  }

  getLastSessionId() {
    const topicSessionId = this.getForumTopicProviderSessionId(this.getActiveTelegramThreadId(), this.provider);
    return topicSessionId || getProviderSessionId(this.config, this.provider);
  }

  getPinnedSessionId() {
    const topic = this.getActiveForumProjectTopic();
    const topicPinnedSessionId = String(topic?.pinnedSessionId || '').trim() || null;
    if (topicPinnedSessionId) {
      return topicPinnedSessionId;
    }

    const workspace = this.config.getWorkspace(this.getCurrentWorkspacePath());
    return String(workspace?.pinnedSessionId || '').trim() || null;
  }

  getBoundSessionId() {
    return this.sessionMode === 'pinned' ? this.getPinnedSessionId() : null;
  }

  setSessionMode(mode, pinnedSessionId = null) {
    const activeTopic = this.getActiveForumProjectTopic();

    if (mode === 'pinned') {
      const normalized = String(pinnedSessionId || '').trim();
      if (!normalized) {
        throw new Error('Pinned session id is required.');
      }
      this.sessionMode = 'pinned';
      this.forceNewNextPrompt = false;
      setProviderSessionId(this.config, this.provider, normalized);
      if (activeTopic) {
        this.setForumTopicSessionState(activeTopic.threadId, this.provider, {
          sessionMode: 'pinned',
          pinnedSessionId: normalized,
          lastSessionId: normalized,
        });
      }
      this.persistWorkspaceState();
      return;
    }

    if (mode === 'new') {
      this.sessionMode = 'new';
      this.forceNewNextPrompt = true;
      if (activeTopic) {
        this.setForumTopicSessionState(activeTopic.threadId, this.provider, {
          sessionMode: 'new',
          pinnedSessionId: null,
        });
      }
      this.persistWorkspaceState();
      return;
    }

    this.sessionMode = 'latest';
    this.forceNewNextPrompt = false;
    if (activeTopic) {
      this.setForumTopicSessionState(activeTopic.threadId, this.provider, {
        sessionMode: 'latest',
        pinnedSessionId: null,
      });
    }
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

    this.persistWorkspaceRecord(normalizedPath, {
      provider: this.provider,
      providerArgs: this.config.codexArgs,
      lastSessionId: this.config.codexLastSessionId,
      sessionMode: this.sessionMode,
      pinnedSessionId: this.sessionMode === 'pinned' ? this.getLastSessionId() : null,
    });
    this.config.setActiveWorkspace(normalizedPath);
  }

  persistWorkspaceRecord(workspacePath, context = {}) {
    const normalizedPath = String(workspacePath || '').trim();
    if (!normalizedPath) {
      return;
    }

    this.config.setWorkspace(normalizedPath, {
      label: path.basename(normalizedPath) || normalizedPath,
      lastUsedAt: new Date().toISOString(),
      provider: String(context.provider || this.provider).trim() || this.provider,
      codexArgs: Array.isArray(context.providerArgs) ? context.providerArgs : this.config.codexArgs,
      codexLastSessionId:
        context.lastSessionId === undefined
          ? this.getWorkspaceProviderSessionId(normalizedPath, context.provider || this.provider)
          : context.lastSessionId,
      sessionMode: String(context.sessionMode || this.sessionMode).trim() || 'latest',
      pinnedSessionId:
        (String(context.sessionMode || this.sessionMode).trim() || 'latest') === 'pinned'
          ? String(context.pinnedSessionId || '').trim() || null
          : null,
    });
  }

  getWorkspaceProviderSessionId(workspacePath, provider = this.provider) {
    const normalizedPath = String(workspacePath || '').trim();
    if (!normalizedPath) {
      return null;
    }

    const record = this.config.getWorkspace(normalizedPath);
    const definition = getProviderDefinition(provider);
    return String(record?.[definition.sessionKey] || '').trim() || null;
  }

  setWorkspaceProviderSessionId(workspacePath, provider, sessionId) {
    const normalizedPath = String(workspacePath || '').trim();
    if (!normalizedPath) {
      return;
    }

    const definition = getProviderDefinition(provider);
    this.config.setWorkspace(normalizedPath, {
      [definition.sessionKey]: String(sessionId || '').trim() || null,
    });
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

  buildMainTopicText() {
    const hostCount = this.listForumTopicsByKind('host').length;
    const projectCount = this.listForumTopicsByKind('project').length;
    const workspacePath = this.getCurrentWorkspacePath();
    const currentHost = this.listForumTopicsByKind('host', {
      hostname: os.hostname(),
    })[0];
    const currentProject = this.findForumTopicByThreadId(this.telegramForumState?.projectThreadId ?? this.telegramThreadId);
    const recentProjects = this.listForumTopicsByKind('project').slice(0, 5);

    return [
      'UshAgent forum overview',
      `Host: ${os.hostname()}`,
      `Current project: ${path.basename(workspacePath) || workspacePath}`,
      `Projects tracked: ${projectCount}`,
      `Hosts tracked: ${hostCount}`,
      currentHost ? `Host topic: ${currentHost.title}` : null,
      currentProject ? `Project topic: ${currentProject.title}` : null,
      '',
      recentProjects.length > 0 ? 'Recent project topics:' : null,
      ...recentProjects.map((project, index) => `${index + 1}. ${project.title}`),
      '',
      'Use /usage for limits, /hosts for machines, and /projects for project topics.',
    ]
      .filter(Boolean)
      .join('\n');
  }

  buildHostTopicText(hostTopic = null) {
    const hostname = hostTopic?.hostname || os.hostname();
    const projects = this.listForumTopicsByKind('project', {
      hostname,
    });

    return [
      `Host: ${hostname}`,
      `Projects: ${projects.length}`,
      '',
      ...projects.map((project, index) => `${index + 1}. ${project.title}`),
      projects.length === 0 ? 'No project topics yet.' : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  buildForumProjectListText(options = {}) {
    const hostname = String(options.hostname || '').trim();
    const projects = this.listForumTopicsByKind('project', {
      hostname,
    });

    if (projects.length === 0) {
      return hostname ? `No project topics yet for ${hostname}.` : 'No project topics yet.';
    }

    return [
      hostname ? `Projects for ${hostname}:` : 'All project topics:',
      ...projects.map((project, index) => `${index + 1}. ${project.title}`),
    ].join('\n');
  }

  buildHostListText() {
    const hosts = this.listForumTopicsByKind('host');
    if (hosts.length === 0) {
      return 'No host topics yet.';
    }

    return ['Hosts:', ...hosts.map((host, index) => `${index + 1}. ${host.title}`)].join('\n');
  }

  buildCurrentHostTopicText() {
    const hostTopic = this.listForumTopicsByKind('host', {
      hostname: os.hostname(),
    })[0];

    if (!hostTopic) {
      return `No host topic is registered yet for ${os.hostname()}.`;
    }

    return this.buildHostTopicText(hostTopic);
  }

  buildCurrentProjectTopicText() {
    const workspacePath = this.getCurrentWorkspacePath();
    const projectTopic = this.findForumTopicByThreadId(this.telegramForumState?.projectThreadId ?? this.telegramThreadId);

    return [
      `Current host: ${os.hostname()}`,
      `Workspace: ${workspacePath}`,
      `Topic: ${projectTopic?.title || '(not assigned yet)'}`,
      `Thread: ${projectTopic?.threadId || '-'}`,
      '',
      this.buildCurrentProjectText(),
    ].join('\n');
  }

  buildNewProjectHelpText() {
    return [
      'To add a project in forum mode:',
      '1. Open `MAIN` or `HOST`.',
      '2. Press `Add Project`.',
      '3. Pick a known workspace from the list.',
      '4. UshAgent will create the topic if needed.',
      '',
      'To actually work inside that project, switch this running process there or start UshAgent in that folder.',
    ].join('\n');
  }

  buildControlKeyboard() {
    return {
      inline_keyboard: [
        [
          { text: 'Switch Project', callback_data: 'forum:switch_project' },
          { text: 'Sessions', callback_data: 'sessions' },
        ],
        [
          { text: 'Topic Info', callback_data: 'forum:topic_info' },
          { text: 'Session', callback_data: 'session_status' },
        ],
        [
          { text: 'Usage', callback_data: 'usage' },
          { text: 'Status', callback_data: 'status' },
        ],
        [{ text: 'Keyboard', callback_data: 'keyboard:settings' }],
        [
          { text: 'Host', callback_data: 'forum:open_host' },
          { text: 'Main', callback_data: 'forum:open_main' },
        ],
        [
          { text: 'Latest', callback_data: 'mode:latest' },
          { text: 'New', callback_data: 'mode:new' },
        ],
      ],
    };
  }

  buildMainKeyboard() {
    return {
      inline_keyboard: [
        [
          { text: 'Hosts', callback_data: 'hosts' },
          { text: 'Projects', callback_data: 'projects' },
        ],
        [
          { text: 'Current Host', callback_data: 'main:current_host' },
          { text: 'Add Project', callback_data: 'forum:add_project' },
        ],
        [
          { text: 'Usage', callback_data: 'usage' },
          { text: 'Status', callback_data: 'status' },
        ],
        [{ text: 'Keyboard', callback_data: 'keyboard:settings' }],
        [{ text: 'Current Project', callback_data: 'main:current_project' }],
      ],
    };
  }

  buildHostKeyboard() {
    return {
      inline_keyboard: [
        [
          { text: 'Projects', callback_data: 'projects' },
          { text: 'Add Project', callback_data: 'forum:add_project' },
        ],
        [
          { text: 'Usage', callback_data: 'usage' },
          { text: 'Status', callback_data: 'status' },
        ],
        [{ text: 'Keyboard', callback_data: 'keyboard:settings' }],
        [{ text: 'Main', callback_data: 'forum:open_main' }],
      ],
    };
  }

  buildPersistentReplyKeyboard() {
    const keyboardConfig = this.config.telegramReplyKeyboard;
    if (keyboardConfig.enabled !== true) {
      return null;
    }

    const rows =
      keyboardConfig.variant === 'compact'
        ? [
            ['/menu', '/status', '/usage'],
            ['/projects', '/sessions', '/stop'],
          ]
        : [
            ['/menu', '/status'],
            ['/projects', '/sessions'],
            ['/usage', '/new', '/stop'],
          ];

    return {
      keyboard: rows.map(row => row.map(text => ({ text }))),
      resize_keyboard: true,
      is_persistent: true,
      one_time_keyboard: false,
      input_field_placeholder: 'Use buttons or type a prompt',
    };
  }

  buildReplyKeyboardRemoval() {
    return {
      remove_keyboard: true,
    };
  }

  buildKeyboardSettingsText() {
    const keyboardConfig = this.config.telegramReplyKeyboard;
    return [
      'Reply keyboard settings',
      `Enabled: ${keyboardConfig.enabled ? 'yes' : 'no'}`,
      `Layout: ${keyboardConfig.variant}`,
      '',
      'This controls the buttons shown under the Telegram input field.',
      'Inline menus stay available separately via /menu.',
    ].join('\n');
  }

  buildKeyboardSettingsMarkup(messageThreadId = null) {
    const keyboardConfig = this.config.telegramReplyKeyboard;
    const inline_keyboard = [
      [
        {
          text: keyboardConfig.enabled ? 'Disable' : 'Enable',
          callback_data: 'keyboard:toggle',
        },
      ],
      [
        {
          text: keyboardConfig.variant === 'standard' ? 'Standard ✓' : 'Standard',
          callback_data: 'keyboard:variant:standard',
        },
        {
          text: keyboardConfig.variant === 'compact' ? 'Compact ✓' : 'Compact',
          callback_data: 'keyboard:variant:compact',
        },
      ],
      [{ text: 'Refresh Keyboard', callback_data: 'keyboard:sync' }],
    ];

    return this.mergeReplyMarkup({ inline_keyboard }, this.getReplyMarkupForThread(messageThreadId));
  }

  async syncReplyKeyboard(messageThreadId = null, options = {}) {
    const text = String(options.text || '').trim() || 'Reply keyboard updated.';
    const replyMarkup = options.remove === true ? this.buildReplyKeyboardRemoval() : this.buildPersistentReplyKeyboard();
    return this.safeSendMessage(text, {
      messageThreadId,
      replyMarkup,
      silent: options.silent === true,
    });
  }

  getReplyMarkupForThread(messageThreadId = null) {
    if (!this.telegramForumState?.enabled || !Number.isInteger(messageThreadId)) {
      return this.buildControlKeyboard();
    }

    if (messageThreadId === this.telegramForumState.mainThreadId) {
      return this.buildMainKeyboard();
    }

    if (messageThreadId === this.telegramForumState.hostThreadId) {
      return this.buildHostKeyboard();
    }

    return this.buildControlKeyboard();
  }

  getControlPanelSlotKey(messageThreadId = null) {
    return Number.isInteger(messageThreadId) ? `thread:${messageThreadId}` : 'default';
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
    const targetThreadId = Number.isInteger(options.messageThreadId) ? options.messageThreadId : this.getActiveTelegramThreadId();
    const panelSlotKey = this.getControlPanelSlotKey(targetThreadId);
    const messageId = Number.isInteger(options.messageId)
      ? options.messageId
      : persistMenu
        ? this.config.getTelegramControlPanelMessageId(panelSlotKey)
        : null;
    const replyMarkup = options.replyMarkup || this.getReplyMarkupForThread(targetThreadId);

    if (messageId) {
      try {
        await this.telegram.editMessageText(this.config.telegramChatId, messageId, text, {
          messageThreadId: targetThreadId,
          replyMarkup,
        });
        if (persistMenu) {
          this.config.setTelegramControlPanelMessageId(panelSlotKey, messageId);
        }
        return;
      } catch {
        // Fall through and send a fresh panel message if edit fails.
      }
    }

    const sentMessage = await this.safeSendMessage(text, {
      messageThreadId: targetThreadId,
      replyMarkup,
    });

    if (persistMenu && Number.isInteger(sentMessage?.message_id)) {
      this.config.setTelegramControlPanelMessageId(panelSlotKey, sentMessage.message_id);
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

  buildForumWorkspaceBrowserText(options = {}) {
    const hostname = String(options.hostname || os.hostname()).trim();
    const workspaces = collectKnownWorkspaces(this.config, {
      limit: 12,
    });

    this.projectListCache = workspaces;

    if (workspaces.length === 0) {
      return [
        hostname ? `No known workspaces for ${hostname}.` : 'No known workspaces yet.',
        'Open a project locally and run UshAgent there once to register it.',
      ].join('\n');
    }

    return [
      hostname ? `Known workspaces for ${hostname}:` : 'Known workspaces:',
      ...workspaces.map((workspace, index) => {
        const topic = this.getForumProjectTopicRecord(workspace.path, hostname);
        const marker = workspace.path === this.getCurrentWorkspacePath() ? ' [current]' : '';
        return `${index + 1}. ${workspace.label}${marker} - ${topic ? `topic #${topic.threadId}` : 'topic missing'}`;
      }),
    ].join('\n');
  }

  buildForumWorkspaceKeyboard(options = {}) {
    const hostname = String(options.hostname || os.hostname()).trim();
    const workspaces = Array.isArray(this.projectListCache) ? this.projectListCache : [];
    if (workspaces.length === 0) {
      return this.getReplyMarkupForThread(options.messageThreadId ?? null);
    }

    const inline_keyboard = [];
    for (let index = 0; index < workspaces.length; index += 1) {
      const workspace = workspaces[index];
      const topic = this.getForumProjectTopicRecord(workspace.path, hostname);
      const row = [
        {
          text: `${index + 1}. ${workspace.label}`,
          callback_data: `forum:switch_project:${index + 1}`,
        },
      ];
      if (!topic) {
        row.push({
          text: 'Create Topic',
          callback_data: `forum:create_topic:${index + 1}`,
        });
      }
      inline_keyboard.push(row);
    }

    const baseMarkup = this.getReplyMarkupForThread(options.messageThreadId ?? null);
    return this.mergeReplyMarkup({ inline_keyboard }, baseMarkup);
  }

  getForumProjectTopicRecord(workspacePath, hostname = os.hostname()) {
    const topicKey = getProjectTopicKey(workspacePath, hostname);
    const topic = this.getForumTopics()[topicKey];
    return topic && typeof topic === 'object' ? { key: topicKey, ...topic } : null;
  }

  getActiveForumProjectTopic() {
    return this.findForumTopicByThreadId(this.getActiveTelegramThreadId());
  }

  getForumTopicProviderSessionId(messageThreadId, provider = this.provider) {
    if (!Number.isInteger(messageThreadId)) {
      return null;
    }

    const topic = this.findForumTopicByThreadId(messageThreadId);
    if (!topic || topic.kind !== 'project') {
      return null;
    }

    const definition = getProviderDefinition(provider);
    return String(topic?.[definition.sessionKey] || '').trim() || null;
  }

  getForumTopicSessionState(messageThreadId, provider = this.provider) {
    if (!Number.isInteger(messageThreadId)) {
      return null;
    }

    const topic = this.findForumTopicByThreadId(messageThreadId);
    if (!topic || topic.kind !== 'project') {
      return null;
    }

    return {
      topic,
      lastSessionId: this.getForumTopicProviderSessionId(messageThreadId, provider),
      sessionMode: topic.sessionMode === 'pinned' && topic.pinnedSessionId ? 'pinned' : topic.sessionMode === 'new' ? 'new' : 'latest',
      pinnedSessionId: String(topic.pinnedSessionId || '').trim() || null,
    };
  }

  setForumTopicSessionState(messageThreadId, provider = this.provider, patch = {}) {
    if (!Number.isInteger(messageThreadId)) {
      return null;
    }

    const topic = this.findForumTopicByThreadId(messageThreadId);
    if (!topic || topic.kind !== 'project') {
      return null;
    }

    const definition = getProviderDefinition(provider);
    const nextPatch = {
      updatedAt: new Date().toISOString(),
    };

    if (patch.lastSessionId !== undefined) {
      nextPatch[definition.sessionKey] = String(patch.lastSessionId || '').trim() || null;
    }

    if (patch.sessionMode !== undefined) {
      const normalizedMode = String(patch.sessionMode || '').trim();
      nextPatch.sessionMode = normalizedMode === 'pinned' && patch.pinnedSessionId ? 'pinned' : normalizedMode === 'new' ? 'new' : 'latest';
    }

    if (patch.pinnedSessionId !== undefined) {
      nextPatch.pinnedSessionId = String(patch.pinnedSessionId || '').trim() || null;
    }

    this.config.setTelegramTopic(topic.key, nextPatch);
    if (this.telegramForumState?.topics) {
      this.telegramForumState = {
        ...this.telegramForumState,
        topics: {
          ...this.telegramForumState.topics,
          [topic.key]: {
            ...(this.telegramForumState.topics[topic.key] || {}),
            ...nextPatch,
          },
        },
      };
    }

    return this.findForumTopicByThreadId(messageThreadId);
  }

  syncForumSessionForThread(messageThreadId = null, provider = this.provider) {
    const topicState = this.getForumTopicSessionState(messageThreadId, provider);
    if (!topicState) {
      return null;
    }

    this.sessionMode = topicState.sessionMode;
    this.forceNewNextPrompt = topicState.sessionMode === 'new';
    this.config.setMany({
      provider,
      codexLastSessionId: topicState.lastSessionId || null,
    });
    if (topicState.sessionMode === 'pinned' && topicState.pinnedSessionId) {
      setProviderSessionId(this.config, provider, topicState.pinnedSessionId);
    } else {
      setProviderSessionId(this.config, provider, topicState.lastSessionId || null);
    }

    return topicState;
  }

  syncForumWorkspaceForThread(messageThreadId = null) {
    if (!this.telegramForumState?.enabled || !Number.isInteger(messageThreadId)) {
      return null;
    }

    const topic = this.findForumTopicByThreadId(messageThreadId);
    if (!topic || topic.kind !== 'project' || !topic.workspacePath) {
      return topic;
    }

    this.telegramThreadId = topic.threadId;
    this.telegramForumState = {
      ...this.telegramForumState,
      projectTopicKey: topic.key,
      projectThreadId: topic.threadId,
    };

    if (topic.workspacePath !== this.getCurrentWorkspacePath() && fs.existsSync(topic.workspacePath)) {
      this.persistWorkspaceState();
      this.restoreWorkspaceState(topic.workspacePath);
      this.resumeListCache = {
        provider: this.provider,
        sessionIds: [],
      };
    }

    this.syncForumSessionForThread(topic.threadId);

    return topic;
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

  async handleCallbackAction(data, callbackQueryId, messageId = null, messageThreadId = null) {
    const action = String(data || '').trim();
    if (!action) {
      return;
    }

    const replyMarkup = this.getReplyMarkupForThread(messageThreadId);

    try {
      if (action === 'hosts') {
        await this.telegram.answerCallbackQuery(callbackQueryId);
        await this.publishTelegramView(this.buildHostListText(), {
          messageId,
          messageThreadId,
          replyMarkup,
          persistMenu: true,
        });
        return;
      }

      if (action === 'main:newproject') {
        await this.telegram.answerCallbackQuery(callbackQueryId);
        await this.publishTelegramView(this.buildNewProjectHelpText(), {
          messageId,
          messageThreadId,
          replyMarkup,
          persistMenu: true,
        });
        return;
      }

      if (action === 'forum:add_project' || action === 'forum:switch_project') {
        await this.telegram.answerCallbackQuery(callbackQueryId);
        const hostTopic = this.findForumTopicByThreadId(messageThreadId);
        const hostname =
          this.telegramForumState?.enabled && messageThreadId === this.telegramForumState.hostThreadId ? hostTopic?.hostname || os.hostname() : os.hostname();
        await this.publishTelegramView(this.buildForumWorkspaceBrowserText({ hostname }), {
          messageId,
          messageThreadId,
          replyMarkup: this.buildForumWorkspaceKeyboard({ hostname, messageThreadId }),
          persistMenu: true,
        });
        return;
      }

      if (action === 'forum:topic_info') {
        await this.telegram.answerCallbackQuery(callbackQueryId);
        await this.publishTelegramView(this.buildCurrentProjectTopicText(), {
          messageId,
          messageThreadId,
          replyMarkup,
          persistMenu: true,
        });
        return;
      }

      if (action === 'forum:open_host') {
        await this.telegram.answerCallbackQuery(callbackQueryId);
        await this.publishTelegramView(this.buildCurrentHostTopicText(), {
          messageId,
          messageThreadId,
          replyMarkup,
          persistMenu: true,
        });
        return;
      }

      if (action === 'forum:open_main') {
        await this.telegram.answerCallbackQuery(callbackQueryId);
        await this.publishTelegramView(this.buildMainTopicText(), {
          messageId,
          messageThreadId,
          replyMarkup: this.buildMainKeyboard(),
          persistMenu: true,
        });
        return;
      }

      if (action === 'keyboard:settings') {
        await this.telegram.answerCallbackQuery(callbackQueryId);
        await this.publishTelegramView(this.buildKeyboardSettingsText(), {
          messageId,
          messageThreadId,
          replyMarkup: this.buildKeyboardSettingsMarkup(messageThreadId),
          persistMenu: true,
        });
        return;
      }

      if (action === 'keyboard:toggle') {
        const nextEnabled = this.config.telegramReplyKeyboard.enabled !== true;
        this.config.setTelegramReplyKeyboard({
          enabled: nextEnabled,
        });
        await this.telegram.answerCallbackQuery(callbackQueryId, nextEnabled ? 'Reply keyboard enabled' : 'Reply keyboard disabled');
        await this.publishTelegramView(this.buildKeyboardSettingsText(), {
          messageId,
          messageThreadId,
          replyMarkup: this.buildKeyboardSettingsMarkup(messageThreadId),
          persistMenu: true,
        });
        await this.syncReplyKeyboard(messageThreadId, {
          text: nextEnabled ? 'Reply keyboard enabled.' : 'Reply keyboard removed.',
          remove: nextEnabled !== true,
          silent: true,
        });
        return;
      }

      if (action === 'keyboard:sync') {
        await this.telegram.answerCallbackQuery(callbackQueryId, 'Reply keyboard refreshed');
        await this.syncReplyKeyboard(messageThreadId, {
          text: this.config.telegramReplyKeyboard.enabled ? 'Reply keyboard refreshed.' : 'Reply keyboard is disabled.',
          remove: this.config.telegramReplyKeyboard.enabled !== true,
          silent: true,
        });
        await this.publishTelegramView(this.buildKeyboardSettingsText(), {
          messageId,
          messageThreadId,
          replyMarkup: this.buildKeyboardSettingsMarkup(messageThreadId),
          persistMenu: true,
        });
        return;
      }

      if (action.startsWith('keyboard:variant:')) {
        const variant = action.slice('keyboard:variant:'.length).trim();
        this.config.setTelegramReplyKeyboard({
          variant,
        });
        await this.telegram.answerCallbackQuery(callbackQueryId, `Layout: ${variant === 'compact' ? 'compact' : 'standard'}`);
        await this.publishTelegramView(this.buildKeyboardSettingsText(), {
          messageId,
          messageThreadId,
          replyMarkup: this.buildKeyboardSettingsMarkup(messageThreadId),
          persistMenu: true,
        });
        await this.syncReplyKeyboard(messageThreadId, {
          text: 'Reply keyboard updated.',
          silent: true,
        });
        return;
      }

      if (action === 'main:current_host') {
        await this.telegram.answerCallbackQuery(callbackQueryId);
        await this.publishTelegramView(this.buildCurrentHostTopicText(), {
          messageId,
          messageThreadId,
          replyMarkup,
          persistMenu: true,
        });
        return;
      }

      if (action === 'main:current_project') {
        await this.telegram.answerCallbackQuery(callbackQueryId);
        await this.publishTelegramView(this.buildCurrentProjectTopicText(), {
          messageId,
          messageThreadId,
          replyMarkup,
          persistMenu: true,
        });
        return;
      }

      if (action === 'projects') {
        await this.telegram.answerCallbackQuery(callbackQueryId);
        if (this.telegramForumState?.enabled && messageThreadId === this.telegramForumState.mainThreadId) {
          await this.publishTelegramView(this.buildForumProjectListText(), {
            messageId,
            messageThreadId,
            replyMarkup,
            persistMenu: true,
          });
          return;
        }

        if (this.telegramForumState?.enabled && messageThreadId === this.telegramForumState.hostThreadId) {
          const hostTopic = this.findForumTopicByThreadId(messageThreadId);
          await this.publishTelegramView(
            this.buildForumProjectListText({
              hostname: hostTopic?.hostname || os.hostname(),
            }),
            {
              messageId,
              messageThreadId,
              replyMarkup,
              persistMenu: true,
            }
          );
          return;
        }

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
        if (this.telegramForumState?.enabled && messageThreadId === this.telegramForumState.mainThreadId) {
          await this.publishTelegramView(this.buildMainTopicText(), {
            messageId,
            messageThreadId,
            replyMarkup,
            persistMenu: true,
          });
          return;
        }

        if (this.telegramForumState?.enabled && messageThreadId === this.telegramForumState.hostThreadId) {
          await this.publishTelegramView(this.buildHostTopicText(this.findForumTopicByThreadId(messageThreadId)), {
            messageId,
            messageThreadId,
            replyMarkup,
            persistMenu: true,
          });
          return;
        }

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
        if (this.telegramForumState?.enabled && messageThreadId === this.telegramForumState.mainThreadId) {
          await this.publishTelegramView(this.buildMainTopicText(), {
            messageId,
            messageThreadId,
            replyMarkup,
            persistMenu: true,
          });
          return;
        }

        if (this.telegramForumState?.enabled && messageThreadId === this.telegramForumState.hostThreadId) {
          await this.publishTelegramView(this.buildHostTopicText(this.findForumTopicByThreadId(messageThreadId)), {
            messageId,
            messageThreadId,
            replyMarkup,
            persistMenu: true,
          });
          return;
        }

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
            messageThreadId,
            replyMarkup,
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
          messageThreadId,
          replyMarkup,
          persistMenu: true,
        });
        return;
      }

      if (action.startsWith('stop_execution:')) {
        const explicitThreadId = Number(action.slice('stop_execution:'.length).trim());
        const targetThreadId = Number.isInteger(explicitThreadId) ? explicitThreadId : messageThreadId;
        const executionKey = this.getExecutionKeyForPrompt('telegram', {
          messageThreadId: targetThreadId,
        });
        const stopped = this.requestStopCurrentPrompt('manual_stop', { executionKey });
        const clearedCount = this.clearQueuedTelegramMessages({ executionKey });

        await this.telegram.answerCallbackQuery(
          callbackQueryId,
          stopped ? 'Stopping current task...' : clearedCount > 0 ? 'Cleared queued messages.' : 'No active task to stop.'
        );

        if (stopped) {
          await this.safeSendMessage(`Stopping current ${formatProviderName(this.provider)} task...`, {
            messageThreadId: targetThreadId,
          });
        } else if (clearedCount > 0) {
          await this.safeSendMessage(`Cleared ${clearedCount} queued message${clearedCount === 1 ? '' : 's'}.`, {
            messageThreadId: targetThreadId,
          });
        }
        return;
      }

      if (action === 'mode:latest') {
        await this.telegram.answerCallbackQuery(callbackQueryId, 'Latest mode selected');
        this.setSessionMode('latest');
        await this.publishTelegramView(this.buildSessionStatusText(), {
          messageId,
          messageThreadId,
          replyMarkup,
          persistMenu: true,
        });
        return;
      }

      if (action === 'mode:new') {
        await this.telegram.answerCallbackQuery(callbackQueryId, 'New mode selected');
        this.setSessionMode('new');
        await this.publishTelegramView(this.buildSessionStatusText(), {
          messageId,
          messageThreadId,
          replyMarkup,
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

      if (action.startsWith('forum:switch_project:')) {
        const value = action.slice('forum:switch_project:'.length).trim();
        await this.telegram.answerCallbackQuery(callbackQueryId, 'Switching project...');
        await this.handleProjectSwitchCommand(value, 'telegram', { messageId, messageThreadId, persistMenu: true });
        return;
      }

      if (action.startsWith('forum:create_topic:')) {
        const value = action.slice('forum:create_topic:'.length).trim();
        await this.telegram.answerCallbackQuery(callbackQueryId, 'Creating topic...');
        await this.handleForumCreateTopic(value, 'telegram', { messageId, messageThreadId, persistMenu: true });
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

    const currentExecutionKey = this.getCurrentExecutionKey();
    if (this.isExecutionBusy(currentExecutionKey)) {
      if (!force) {
        await this.safeSendMessage('A request is currently running. Use /stop first or /project <target> force.', {
          replyMarkup: this.buildControlKeyboard(),
        });
        return;
      }

      this.requestStopCurrentPrompt('project_switch', { executionKey: currentExecutionKey });
      this.clearQueuedTelegramMessages({ executionKey: currentExecutionKey });
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
    if (this.telegramForumState?.enabled && this.config.telegramChatId) {
      await this.ensureTelegramProjectTopic(this.config.telegramChatId, targetPath, os.hostname());
    }
    this.resumeListCache = {
      provider: this.provider,
      sessionIds: [],
    };

    const message = [
      `Switched project to ${targetPath}.`,
      this.telegramForumState?.enabled && Number.isInteger(this.telegramThreadId) ? `Topic thread: ${this.telegramThreadId}` : null,
      `Provider: ${this.provider}`,
      `Session mode: ${this.sessionMode}`,
      `Session: ${this.getBoundSessionId() || '(latest in current folder)'}`,
    ]
      .filter(Boolean)
      .join('\n');

    this.logCliEvent(`${sourceLabel} project switch`, targetPath);

    if (source === 'cli') {
      this.writeCliLine(message);
      await this.safeSendMessage(message, { from: 'CLI' });
      return;
    }

    await this.publishTelegramView(message, {
      messageId: options.messageId,
      messageThreadId: this.getActiveTelegramThreadId(),
      replyMarkup: this.getReplyMarkupForThread(this.getActiveTelegramThreadId()),
      persistMenu: options.persistMenu === true,
    });
  }

  async handleForumCreateTopic(rawArgument = '', source = 'telegram', options = {}) {
    const argument = String(rawArgument || '').trim();
    if (!argument) {
      await this.safeSendMessage('Project list entry not found. Open Add Project first.');
      return;
    }

    let targetPath = '';
    if (/^\d+$/.test(argument)) {
      const selected = this.projectListCache[Number(argument) - 1];
      if (!selected) {
        await this.safeSendMessage('Project list entry not found. Open Add Project first.');
        return;
      }
      targetPath = selected.path;
    } else {
      targetPath = path.resolve(this.getCurrentWorkspacePath(), argument);
    }

    if (!this.telegramForumState?.enabled || !this.config.telegramChatId) {
      await this.safeSendMessage('Forum mode is not active in this chat.');
      return;
    }

    const existing = this.getForumProjectTopicRecord(targetPath, os.hostname());
    const topic = existing || (await this.ensureTelegramProjectTopic(this.config.telegramChatId, targetPath, os.hostname()));
    const message = [
      `Project topic ready: ${topic?.title || formatWorkspaceLabel(targetPath)}`,
      `Workspace: ${targetPath}`,
      `Thread: ${topic?.threadId || '-'}`,
      existing ? 'Topic already existed.' : 'Topic was created.',
    ].join('\n');

    if (source === 'cli') {
      this.writeCliLine(message);
      return;
    }

    await this.publishTelegramView(message, {
      messageId: options.messageId,
      messageThreadId: options.messageThreadId,
      replyMarkup: this.buildForumWorkspaceKeyboard({
        hostname: os.hostname(),
        messageThreadId: options.messageThreadId,
      }),
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
    this.writeCliLine('Local CLI input enabled. Type /help for local commands.');
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
          '/reset - remove local UshAgent config and stop the bridge',
          '/addclient - generate a join-client command for another forum-mode computer',
          '/add - alias for /addclient',
          '/resume [session-id|last|list|N] - resume saved, explicit, latest, listed session, or show sessions',
          '/r [session-id|last|list|N] - alias for /resume',
          '/stop - stop current execution and clear queued Telegram messages',
          '/say <text> - send a raw message to Telegram',
          '/exit - stop UshAgent',
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

    if (line === '/reset') {
      await this.safeSendMessage('Local UshAgent config reset from CLI. Restart setup on next launch.', { from: 'CLI' });
      if (typeof this.config.resetAll === 'function') {
        this.config.resetAll();
      } else {
        this.config.clearPairing({ keepBotToken: false });
        this.config.set('provider', null);
      }
      this.running = false;
      this.stopLocalInputLoop();
      this.writeCliLine('Local config reset. Stopping UshAgent...');
      return;
    }

    if (line === '/addclient' || line === '/add') {
      const bundle = createClientBootstrapBundle(this.config);
      this.writeCliLine('Run this on the other computer:');
      this.writeCliLine(`ushagent join-client --bundle "${bundle}" --yes`);
      return;
    }

    if (line === '/resume' || line.startsWith('/resume ') || line === '/r' || line.startsWith('/r ')) {
      const commandLength = line.startsWith('/r') && !line.startsWith('/resume') ? '/r'.length : '/resume'.length;
      const argument = line.slice(commandLength).trim();
      await this.handleResumeCommand(argument, 'cli');
      return;
    }

    if (line === '/stop') {
      const stopped = this.requestStopCurrentPrompt('manual_stop', { all: true });
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
      if (this.isStopping) {
        return;
      }
      this.isStopping = true;
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

    if (line.startsWith('/')) {
      this.writeCliLine('Unknown local command. Use /help.');
      return;
    }

    this.writeCliLine('Local CLI accepts commands only. Use Telegram to send prompts to Codex.');
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
    const chatMode = needPairing ? await this.selectTelegramChatMode() : TELEGRAM_CHAT_MODE_PRIVATE;

    if (!needToken && !needPairing) {
      return {
        chatId: this.config.telegramChatId,
      };
    }

    const setupMode = await this.selectSetupMode();
    if (setupMode === SETUP_MODE_PHONE) {
      return this.runPhoneOnboardingSetup({ needToken, needPairing, chatMode });
    }

    return this.runManualSetup({ needToken, needPairing, chatMode });
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

  async selectTelegramChatMode() {
    if (process.stdin.isTTY && process.stdout.isTTY) {
      return select({
        message: 'Telegram chat mode',
        default: TELEGRAM_CHAT_MODE_PRIVATE,
        choices: [
          {
            name: 'Private chat — one bot, one direct message thread',
            value: TELEGRAM_CHAT_MODE_PRIVATE,
          },
          {
            name: 'Forum topics — use a Telegram supergroup with Topics enabled',
            value: TELEGRAM_CHAT_MODE_FORUM,
          },
        ],
      });
    }

    console.log('Interactive chat mode selection is unavailable in this terminal.');
    console.log('Using private chat mode by default.');
    return TELEGRAM_CHAT_MODE_PRIVATE;
  }

  async runPhoneOnboardingSetup(options = {}) {
    const needToken = Boolean(options.needToken);
    const needPairing = Boolean(options.needPairing);
    const chatMode = options.chatMode || TELEGRAM_CHAT_MODE_PRIVATE;
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
          chatMode,
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
    const chatMode = options.chatMode || TELEGRAM_CHAT_MODE_PRIVATE;

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
      return this.runPairingFlow({ mode: 'manual', chatMode });
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
      await telegram.setMyCommands(getTelegramBotCommands());

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

  getExecutionKeyForPrompt(source, options = {}) {
    if (source === 'telegram' && Number.isInteger(options.messageThreadId)) {
      return `telegram:${options.messageThreadId}`;
    }

    const workspacePath = String(options.workspacePath || '').trim();
    if (workspacePath) {
      return `${source}:${workspacePath.toLowerCase()}`;
    }

    return source === 'telegram' ? 'telegram:default' : 'default';
  }

  getCurrentExecutionKey(source = 'telegram') {
    return this.getExecutionKeyForPrompt(source, {
      messageThreadId: this.getActiveTelegramThreadId(),
      workspacePath: this.getCurrentWorkspacePath(),
    });
  }

  getExecutionState(executionKey = 'default') {
    const normalizedKey = String(executionKey || 'default').trim() || 'default';
    if (!this.executionStates.has(normalizedKey)) {
      this.executionStates.set(normalizedKey, {
        promptQueue: Promise.resolve(),
        activeAbortController: null,
        activeSource: null,
        activeAbortReason: null,
        launchScheduled: false,
        longRunningNoticeTimer: null,
        longRunningNoticeSent: false,
      });
    }

    return this.executionStates.get(normalizedKey);
  }

  isExecutionBusy(executionKey = 'default') {
    const state = this.getExecutionState(executionKey);
    return state.launchScheduled || Boolean(state.activeAbortController);
  }

  getPendingExecutionKey(entry = {}) {
    const explicit = String(entry?.executionKey || '').trim();
    if (explicit) {
      return explicit;
    }

    return this.getExecutionKeyForPrompt('telegram', {
      messageThreadId: Number.isInteger(entry?.messageThreadId) ? entry.messageThreadId : null,
      workspacePath: String(entry?.workspacePath || '').trim() || null,
    });
  }

  clearQueuedTelegramMessages(options = {}) {
    const targetExecutionKey = String(options.executionKey || '').trim() || null;
    if (!targetExecutionKey) {
      const count = this.telegramPendingMessages.length;
      this.telegramPendingMessages = [];
      return count;
    }

    const before = this.telegramPendingMessages.length;
    this.telegramPendingMessages = this.telegramPendingMessages.filter(
      entry => this.getPendingExecutionKey(entry) !== targetExecutionKey
    );
    const removed = before - this.telegramPendingMessages.length;
    if (this.telegramPendingMessages.length > 0) {
      this.startTelegramDispatch(true);
    }
    return removed;
  }

  requestStopCurrentPrompt(reason = 'manual_stop', options = {}) {
    if (options.all === true) {
      let stopped = false;
      for (const state of this.executionStates.values()) {
        if (state.activeAbortController && !state.activeAbortController.signal.aborted) {
          state.activeAbortReason = reason;
          state.activeAbortController.abort();
          stopped = true;
        }
      }
      return stopped;
    }

    const targetExecutionKey = String(options.executionKey || this.getCurrentExecutionKey()).trim() || 'default';
    const state = this.getExecutionState(targetExecutionKey);
    const controller = state.activeAbortController;
    if (!controller || controller.signal.aborted) {
      return false;
    }

    state.activeAbortReason = reason;
    controller.abort();
    return true;
  }

  clearLongRunningNotice(state) {
    if (!state) {
      return;
    }

    if (state.longRunningNoticeTimer) {
      clearTimeout(state.longRunningNoticeTimer);
      state.longRunningNoticeTimer = null;
    }

    state.longRunningNoticeSent = false;
  }

  scheduleLongRunningNotice(state, context, providerLabel) {
    this.clearLongRunningNotice(state);

    if (!Number.isInteger(context?.sourceThreadId) || !this.config.telegramChatId) {
      return;
    }

    state.longRunningNoticeTimer = setTimeout(() => {
      state.longRunningNoticeTimer = null;

      if (!state.activeAbortController || state.activeAbortController.signal.aborted) {
        return;
      }

      state.longRunningNoticeSent = true;
      this.safeSendMessage(`${providerLabel} is still working after 20 minutes.`, {
        messageThreadId: context.sourceThreadId,
        replyMarkup: {
          inline_keyboard: [[{ text: 'Stop Current Task', callback_data: `stop_execution:${context.sourceThreadId}` }]],
        },
      }).catch(error => {
        this.logger.warn(`Failed to send long-running notice: ${error.message}`);
      });
    }, CODEX_LONG_RUNNING_NOTICE_MS);
  }

  buildPromptExecutionContext(source, options = {}) {
    const workspacePath = String(options.workspacePath || this.getCurrentWorkspacePath()).trim() || this.getCurrentWorkspacePath();
    const record = this.config.getWorkspace(workspacePath);
    const provider = String(record?.provider || this.provider).trim() || this.provider;
    const providerArgs = Array.isArray(record?.codexArgs) ? [...record.codexArgs] : [...this.providerArgs];
    const sourceThreadId =
      source === 'telegram'
        ? Number.isInteger(options.messageThreadId)
          ? options.messageThreadId
          : this.getActiveTelegramThreadId()
        : null;
    const topicSessionState = this.getForumTopicSessionState(sourceThreadId, provider);
    const sessionMode =
      topicSessionState?.sessionMode ||
      (record?.sessionMode === 'pinned' && record?.pinnedSessionId ? 'pinned' : record?.sessionMode === 'new' ? 'new' : 'latest');
    const pinnedSessionId = topicSessionState?.pinnedSessionId || String(record?.pinnedSessionId || '').trim() || null;
    const lastSessionId = topicSessionState?.lastSessionId || this.getWorkspaceProviderSessionId(workspacePath, provider);
    const executionKey = this.getExecutionKeyForPrompt(source, {
      messageThreadId: sourceThreadId,
      workspacePath,
    });

    return {
      executionKey,
      workspacePath,
      provider,
      providerArgs,
      sessionMode,
      pinnedSessionId,
      lastSessionId,
      sourceThreadId,
    };
  }

  runProviderWithContext(prompt, context, options = {}) {
    const abortSignal = options.abortSignal || null;
    const runtime = createProviderRuntime(this.config, context.provider, context.providerArgs, {
      getSessionId: () => context.lastSessionId,
      setSessionId: sessionId => {
        const normalized = String(sessionId || '').trim() || null;
        context.lastSessionId = normalized;
        this.setWorkspaceProviderSessionId(context.workspacePath, context.provider, normalized);
        if (this.getCurrentWorkspacePath() === context.workspacePath) {
          setProviderSessionId(this.config, context.provider, normalized);
        }
      },
    });

    return runtime.run(prompt, {
      resume: context.sessionMode !== 'new',
      cwd: context.workspacePath,
      abortSignal,
      sessionId: context.sessionMode === 'pinned' ? context.pinnedSessionId || '' : '',
      onProgress: options.onProgress,
      onRawEvent: options.onRawEvent,
    });
  }

  finalizeExecutionContext(context) {
    const nextSessionMode = context.sessionMode === 'new' ? 'latest' : context.sessionMode;
    const nextPinnedSessionId = nextSessionMode === 'pinned' ? context.pinnedSessionId : null;

    if (Number.isInteger(context.sourceThreadId)) {
      this.setForumTopicSessionState(context.sourceThreadId, context.provider, {
        lastSessionId: context.lastSessionId,
        sessionMode: nextSessionMode,
        pinnedSessionId: nextPinnedSessionId,
      });
    }

    this.persistWorkspaceRecord(context.workspacePath, {
      provider: context.provider,
      providerArgs: context.providerArgs,
      lastSessionId: context.lastSessionId,
      sessionMode: nextSessionMode,
      pinnedSessionId: nextPinnedSessionId,
    });

    if (this.getCurrentWorkspacePath() === context.workspacePath) {
      this.provider = context.provider;
      this.providerArgs = [...context.providerArgs];
      this.sessionMode = nextSessionMode;
      this.forceNewNextPrompt = nextSessionMode === 'new';
      this.config.setMany({
        provider: context.provider,
        codexArgs: [...context.providerArgs],
        codexLastSessionId: context.lastSessionId || null,
      });
      if (nextSessionMode === 'pinned' && nextPinnedSessionId) {
        setProviderSessionId(this.config, context.provider, nextPinnedSessionId);
      }
    }
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

    if (this.telegramPendingMessages.length === 0) {
      return;
    }

    this.telegramDispatchScheduled = true;
    try {
      let launched = false;

      for (let index = 0; index < this.telegramPendingMessages.length; index += 1) {
        const firstPending = this.telegramPendingMessages[index];
        if (!firstPending) {
          continue;
        }

        const executionKey = this.getPendingExecutionKey(firstPending);
        if (this.isExecutionBusy(executionKey)) {
          continue;
        }

        this.telegramPendingMessages.splice(index, 1);
        const pending = [firstPending];

        if (groupAll) {
          for (let pendingIndex = index; pendingIndex < this.telegramPendingMessages.length; ) {
            const nextPending = this.telegramPendingMessages[pendingIndex];
            if (this.getPendingExecutionKey(nextPending) !== executionKey) {
              pendingIndex += 1;
              continue;
            }

            pending.push(nextPending);
            this.telegramPendingMessages.splice(pendingIndex, 1);
          }
        }

        const combinedPrompt = pending
          .map(entry => String(entry?.text || '').trim())
          .filter(Boolean)
          .join('\n')
          .trim();
        if (!combinedPrompt) {
          index -= 1;
          continue;
        }

        launched = true;
        this.queuePrompt(combinedPrompt, 'telegram', {
          groupedCount: pending.length,
          messageThreadId: Number.isInteger(firstPending?.messageThreadId) ? firstPending.messageThreadId : null,
          workspacePath: String(firstPending?.workspacePath || '').trim() || null,
          executionKey,
        }).catch(error => {
          this.logger.error(`Failed to process grouped Telegram messages: ${error.message}`);
        });

        index -= 1;
      }

      if (!launched && this.telegramPendingMessages.length > 0) {
        return;
      }
    } finally {
      this.telegramDispatchScheduled = false;
    }
  }

  async enqueueTelegramPrompt(text, options = {}) {
    const cleanText = String(text || '').trim();
    if (!cleanText) {
      return;
    }

    const executionKey = this.getExecutionKeyForPrompt('telegram', {
      messageThreadId: Number.isInteger(options.messageThreadId) ? options.messageThreadId : null,
      workspacePath: String(options.workspacePath || '').trim() || null,
    });

    this.telegramPendingMessages.push({
      text: cleanText,
      messageThreadId: Number.isInteger(options.messageThreadId) ? options.messageThreadId : null,
      workspacePath: String(options.workspacePath || '').trim() || null,
      executionKey,
    });

    if (this.telegramDispatchScheduled) {
      return;
    }

    this.startTelegramDispatch(true);
  }

  async queuePrompt(prompt, source, options = {}) {
    const cleanPrompt = String(prompt || '').trim();
    if (!cleanPrompt) {
      return;
    }

    const context = this.buildPromptExecutionContext(source, options);
    const state = this.getExecutionState(String(options.executionKey || context.executionKey).trim() || context.executionKey);
    state.launchScheduled = true;

    const run = async () => {
      const sourceLabel = source === 'cli' ? 'CLI' : 'Telegram';
      const providerLabel = formatProviderName(context.provider);
      const abortController = new globalThis.AbortController();
      const groupedCount = Number.isFinite(options.groupedCount) ? Math.max(1, Number(options.groupedCount)) : 1;
      const sourceThreadId = context.sourceThreadId;
      let lastProgressText = '';
      let progressChain = Promise.resolve();
      let progressMessageId = null;
      this.logCliEvent(`${sourceLabel} -> ${providerLabel}`, cleanPrompt);
      state.activeAbortController = abortController;
      state.activeSource = source;
      state.activeAbortReason = null;
      state.launchScheduled = false;
      state.longRunningNoticeSent = false;

      try {
        if (source === 'telegram' && Number.isInteger(sourceThreadId) && this.telegramForumState?.enabled) {
          this.telegramThreadId = sourceThreadId;
        }

        if (source === 'telegram') {
          let progressMessageText = '';
          if (groupedCount > 1) {
            progressMessageText = `${providerLabel} is working on ${groupedCount} messages...`;
          } else {
            progressMessageText = `${providerLabel} is working...`;
          }

          const progressMessage = await this.safeSendMessage(progressMessageText, {
            messageThreadId: sourceThreadId,
          });
          if (Number.isInteger(progressMessage?.message_id)) {
            progressMessageId = progressMessage.message_id;
          }

          this.scheduleLongRunningNotice(state, context, providerLabel);
        }

        const response = await this.runProviderWithContext(cleanPrompt, context, {
          abortSignal: abortController.signal,
          onProgress: progressMessage => {
            const normalized = String(progressMessage || '').trim();
            if (!normalized || normalized === lastProgressText) {
              return;
            }

            lastProgressText = normalized;
            this.logCliEvent(`${providerLabel} progress`, normalized);

            if (source !== 'telegram') {
              return;
            }

            const nextProgressText = `${providerLabel} is working...\n\n${normalized}`;
            progressChain = progressChain
              .then(async () => {
                if (!Number.isInteger(progressMessageId)) {
                  return;
                }

                await this.telegram.editMessageText(this.config.telegramChatId, progressMessageId, nextProgressText, {
                  messageThreadId: sourceThreadId,
                });
              })
              .catch(() => null);
          },
          onRawEvent: DEBUG_CODEX_STREAM
            ? line => {
                this.logCliEvent(`${providerLabel} stream`, summarizeCodexEventLine(line));
              }
            : null,
        });

        await progressChain.catch(() => null);
        this.finalizeExecutionContext(context);
        this.lastExchange = {
          source,
          prompt: cleanPrompt,
          response: String(response || '').trim() || 'No response.',
        };
        await this.safeSendMessage(response, {
          from: providerLabel,
          messageThreadId: sourceThreadId,
        });
      } catch (error) {
        if (abortController.signal.aborted || this.isPromptAbortError(error)) {
          return;
        }

        await this.safeSendMessage(`Error: ${error.message}`, {
          messageThreadId: sourceThreadId,
        });
        this.logger.error(`Provider execution failed: ${error.message}`);
      } finally {
        this.clearLongRunningNotice(state);
        if (state.activeAbortController === abortController) {
          state.activeAbortController = null;
          state.activeSource = null;
          state.activeAbortReason = null;
        }
        state.launchScheduled = false;

        if (this.telegramPendingMessages.length > 0) {
          this.startTelegramDispatch(true);
        }
      }
    };

    state.promptQueue = state.promptQueue.then(run, run);
    await state.promptQueue;
  }

  async runPairingFlow(options = {}) {
    const mode = options.mode || 'manual';
    const chatMode = options.chatMode || TELEGRAM_CHAT_MODE_PRIVATE;
    const onPairLink = typeof options.onPairLink === 'function' ? options.onPairLink : null;
    const onStatus = typeof options.onStatus === 'function' ? options.onStatus : null;

    const botUsername = this.config.telegramBotUsername;
    if (!botUsername) {
      throw new Error('Telegram bot username is unavailable. Create a bot with @BotFather first.');
    }

    const code = makePairCode();
    const deepLink = `https://t.me/${botUsername}?start=ha2_${code}`;

    if (chatMode === TELEGRAM_CHAT_MODE_FORUM) {
      const forumInstructions = [
        'Telegram forum pairing is required.',
        '1. Create or open a Telegram supergroup.',
        '2. Enable Topics in that chat.',
        '3. Add your bot to the supergroup.',
        `4. In the group, send /start@${botUsername} or /help@${botUsername}.`,
        '5. Keep this terminal open until pairing completes.',
      ];

      if (mode === 'manual') {
        console.log('');
        for (const line of forumInstructions) {
          console.log(line);
        }
        console.log('');
        console.log('Waiting for Telegram forum pairing...');
      } else {
        if (onPairLink) {
          onPairLink(`https://t.me/${botUsername}`);
        }
        if (onStatus) {
          onStatus(`Open your forum chat, add @${botUsername}, then send /start@${botUsername} or /help@${botUsername}.`);
        }
        console.log('\nWaiting for Telegram forum pairing from phone onboarding...');
      }
    } else {
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
    }

    let cursor = this.config.telegramUpdateCursor || 0;

    while (this.running) {
      try {
        const result = await this.telegram.getUpdates(cursor, TELEGRAM_POLL_TIMEOUT_SEC);
        const nextCursor = Number.isFinite(result.nextCursor) ? result.nextCursor : cursor;
        if (nextCursor > cursor) {
          cursor = nextCursor;
          this.config.set('telegramUpdateCursor', cursor);
        }

        for (const message of result.messages) {
          if (!message.chatId) {
            continue;
          }

          if (chatMode === TELEGRAM_CHAT_MODE_PRIVATE) {
            if (message.chatType !== 'private') {
              continue;
            }

            if (!isPairStartMessage(message.text, code)) {
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

          if (message.chatType !== 'supergroup') {
            continue;
          }

          const normalizedText = String(message.text || '').trim();
          if (!normalizedText.startsWith('/')) {
            continue;
          }

          const forumChat = await this.telegram.getChat(message.chatId);
          if (forumChat?.is_forum !== true) {
            continue;
          }

          this.config.setMany({
            telegramChatId: message.chatId,
            telegramChatUserId: null,
          });

          if (onStatus) {
            onStatus(`Forum paired successfully (chat ${message.chatId}).`);
          }

          await this.telegram.sendMessage(
            message.chatId,
            `UshAgent paired for ${this.provider} in forum mode.\nUse HOST and PROJECT topics to manage work.`
          );

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
    const mainThreadId = this.telegramForumState?.mainThreadId ?? null;
    const hostThreadId = this.telegramForumState?.hostThreadId ?? null;

    if (!chatId) {
      throw new Error('No Telegram chat is paired. Run `ushagent reset` then start again.');
    }

    try {
      const result = await this.telegram.getUpdates(cursor, TELEGRAM_POLL_TIMEOUT_SEC);
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

        const threadTopic =
          this.telegramForumState?.enabled && Number.isInteger(message.messageThreadId)
            ? this.findForumTopicByThreadId(message.messageThreadId)
            : null;

        if (message.type === 'callback') {
          if (threadTopic?.kind === 'project') {
            this.syncForumWorkspaceForThread(message.messageThreadId);
          }
          await this.handleCallbackAction(
            message.data || message.text || '',
            message.callbackQueryId,
            message.messageId || null,
            message.messageThreadId || null
          );
          continue;
        }

        if (this.telegramForumState?.enabled) {
          if (!threadTopic && message.messageThreadId !== mainThreadId && message.messageThreadId !== hostThreadId) {
            continue;
          }

          if (message.messageThreadId === mainThreadId) {
            await this.handleMainTopicMessage(message);
            continue;
          }

          if (message.messageThreadId === hostThreadId) {
            await this.handleHostTopicMessage(message);
            continue;
          }

          if (threadTopic?.kind === 'project') {
            this.syncForumWorkspaceForThread(message.messageThreadId);
          }
        }

        if (message.text && message.text.trim().startsWith('/')) {
          this.logCliEvent('Telegram command', message.text);
        }

        if (message.fileId) {
          await this.handleAttachmentMessage(message);
          continue;
        }

        await this.handleMessage(message);
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

  async handleMessage(messageOrText) {
    const message =
      messageOrText && typeof messageOrText === 'object'
        ? messageOrText
        : { text: messageOrText };
    const text = String(message?.text || '').trim();
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

    await this.enqueueTelegramPrompt(text, {
      messageThreadId: Number.isInteger(message?.messageThreadId) ? message.messageThreadId : null,
      workspacePath:
        this.findForumTopicByThreadId(message?.messageThreadId)?.workspacePath || this.getCurrentWorkspacePath(),
    });
  }

  async handleMainTopicMessage(message) {
    const text = String(message?.text || '').trim();
    if (!text) {
      return;
    }

    const command = normalizeTelegramCommand(text.split(/\s+/)[0] || '');
    if (command === '/usage') {
      await this.publishTelegramView(await this.buildUsageText({ force: true }), {
        messageThreadId: this.telegramForumState?.mainThreadId ?? null,
        replyMarkup: this.buildControlKeyboard(),
      });
      return;
    }

    if (command === '/projects') {
      await this.publishTelegramView(this.buildForumProjectListText(), {
        messageThreadId: this.telegramForumState?.mainThreadId ?? null,
        replyMarkup: this.buildControlKeyboard(),
      });
      return;
    }

    if (command === '/hosts') {
      await this.publishTelegramView(this.buildHostListText(), {
        messageThreadId: this.telegramForumState?.mainThreadId ?? null,
        replyMarkup: this.buildControlKeyboard(),
      });
      return;
    }

    if (command === '/status' || command === '/menu' || command === '/help') {
      await this.publishTelegramView(this.buildMainTopicText(), {
        messageThreadId: this.telegramForumState?.mainThreadId ?? null,
        replyMarkup: this.buildControlKeyboard(),
      });
    }
  }

  async handleHostTopicMessage(message) {
    const text = String(message?.text || '').trim();
    if (!text) {
      return;
    }

    const command = normalizeTelegramCommand(text.split(/\s+/)[0] || '');
    const hostTopic = this.findForumTopicByThreadId(message.messageThreadId);

    if (command === '/usage') {
      await this.publishTelegramView(await this.buildUsageText({ force: true }), {
        messageThreadId: message.messageThreadId,
        replyMarkup: this.buildControlKeyboard(),
      });
      return;
    }

    if (command === '/projects') {
      await this.publishTelegramView(
        this.buildForumProjectListText({
          hostname: hostTopic?.hostname || os.hostname(),
        }),
        {
          messageThreadId: message.messageThreadId,
          replyMarkup: this.buildControlKeyboard(),
        }
      );
      return;
    }

    if (command === '/status' || command === '/menu' || command === '/help') {
      await this.publishTelegramView(this.buildHostTopicText(hostTopic), {
        messageThreadId: message.messageThreadId,
        replyMarkup: this.buildControlKeyboard(),
      });
    }
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
      await this.enqueueTelegramPrompt(prepared.prompt, {
        messageThreadId: Number.isInteger(message?.messageThreadId) ? message.messageThreadId : null,
        workspacePath:
          this.findForumTopicByThreadId(message?.messageThreadId)?.workspacePath || this.getCurrentWorkspacePath(),
      });
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
          '/keyboard - configure reply keyboard buttons',
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

    if (command === '/keyboard') {
      await this.publishTelegramView(this.buildKeyboardSettingsText(), {
        replyMarkup: this.buildKeyboardSettingsMarkup(this.getActiveTelegramThreadId()),
        persistMenu: true,
      });
      await this.syncReplyKeyboard(this.getActiveTelegramThreadId(), {
        text: this.config.telegramReplyKeyboard.enabled ? 'Reply keyboard refreshed.' : 'Reply keyboard is disabled.',
        remove: this.config.telegramReplyKeyboard.enabled !== true,
        silent: true,
      });
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
      const currentExecutionKey = this.getCurrentExecutionKey();
      const stopped = this.requestStopCurrentPrompt('manual_stop', { executionKey: currentExecutionKey });
      const clearedCount = this.clearQueuedTelegramMessages({ executionKey: currentExecutionKey });

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
    const replyMarkup =
      options.replyMarkup !== undefined
        ? options.replyMarkup
        : this.buildPersistentReplyKeyboard();

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
        messageThreadId: Number.isInteger(options.messageThreadId) ? options.messageThreadId : this.getActiveTelegramThreadId(),
        replyMarkup,
        silent: options.silent === true,
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
