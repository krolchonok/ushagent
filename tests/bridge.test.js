import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import Bridge from '../src/bridge.js';
import { TelegramApi } from '../src/telegram-api.js';

class FakeConfig {
  constructor() {
    this._data = {
      provider: 'codex',
      codexArgs: ['--dangerously-bypass-approvals-and-sandbox'],
      codexLastSessionId: 'session-123',
      activeWorkspacePath: null,
      workspaces: {},
      telegramChatId: 'chat-1',
      telegramChatUserId: 'user-1',
      telegramUpdateCursor: 0,
      telegramBotUsername: 'bot',
      telegramBotToken: '123456:token',
      telegramBotId: '1',
      telegramControlPanelMessageId: null,
    };
  }

  setMany(data) {
    this._data = { ...this._data, ...data };
    return this._data;
  }

  set(key, value) {
    this._data[key] = value;
    return this._data;
  }

  getWorkspace(workspacePath) {
    const record = this._data.workspaces[workspacePath];
    return record ? { ...record } : null;
  }

  setWorkspace(workspacePath, patch = {}) {
    this._data.workspaces = {
      ...this._data.workspaces,
      [workspacePath]: {
        ...(this._data.workspaces[workspacePath] || {}),
        ...patch,
      },
    };
    return this._data;
  }

  setActiveWorkspace(workspacePath) {
    this._data.activeWorkspacePath = workspacePath;
    return this._data;
  }

  clearPairing(options = {}) {
    this._data.telegramChatId = null;
    this._data.telegramChatUserId = null;
    this._data.telegramControlPanelMessageId = null;
    if (options.keepBotToken !== true) {
      this._data.telegramBotToken = null;
    }
    return this._data;
  }

  getStoredTelegramBotToken() {
    return this._data.telegramBotToken;
  }

  get provider() {
    return this._data.provider;
  }

  get codexArgs() {
    return this._data.codexArgs;
  }

  get codexLastSessionId() {
    return this._data.codexLastSessionId;
  }

  get activeWorkspacePath() {
    return this._data.activeWorkspacePath;
  }

  get workspaces() {
    return this._data.workspaces;
  }

  get telegramChatId() {
    return this._data.telegramChatId;
  }

  get telegramChatUserId() {
    return this._data.telegramChatUserId;
  }

  get telegramUpdateCursor() {
    return this._data.telegramUpdateCursor;
  }

  get telegramBotUsername() {
    return this._data.telegramBotUsername;
  }

  get telegramBotToken() {
    return this._data.telegramBotToken;
  }

  get telegramBotId() {
    return this._data.telegramBotId;
  }

  get telegramControlPanelMessageId() {
    return this._data.telegramControlPanelMessageId;
  }
}

function createBridge(workspacePath, options = {}) {
  const config = options.config || new FakeConfig();
  config.setWorkspace(workspacePath, {
    label: path.basename(workspacePath),
    provider: 'codex',
    codexArgs: config.codexArgs,
    codexLastSessionId: options.lastSessionId || null,
    sessionMode: options.sessionMode || 'latest',
    pinnedSessionId: options.pinnedSessionId || null,
  });
  const bridge = new Bridge(config, 'codex', config.codexArgs, {});
  bridge.telegram = {
    editMessageText: async () => null,
  };
  bridge.safeSendMessage = async () => ({ message_id: 1 });
  bridge.writeCliLine = () => {};
  bridge.logCliEvent = () => {};
  return { bridge, config };
}

function writeCodexSessionFixture(sessionId, cwd, entries) {
  const sessionDir = path.join(os.homedir(), '.codex', 'sessions', '2099', '12', '31');
  mkdirSync(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, `rollout-2099-12-31T23-59-59-${sessionId}.jsonl`);
  const lines = [
    JSON.stringify({
      timestamp: '2099-12-31T23:59:59.000Z',
      type: 'session_meta',
      payload: {
        id: sessionId,
        timestamp: '2099-12-31T23:59:59.000Z',
        cwd,
        model: 'gpt-5-codex',
      },
    }),
    ...entries.map(entry => JSON.stringify(entry)),
  ];
  writeFileSync(filePath, `${lines.join('\n')}\n`);
  return filePath;
}

test('setSessionMode pinned stores pinned session in workspace state', () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ushagent-test-'));
  const previousCwd = process.cwd();
  process.chdir(tmpDir);

  try {
    const { bridge, config } = createBridge(tmpDir);
    bridge.setSessionMode('pinned', 'session-123');

    assert.equal(bridge.sessionMode, 'pinned');
    assert.equal(bridge.getBoundSessionId(), 'session-123');
    assert.equal(config.codexLastSessionId, 'session-123');
    assert.equal(config.getWorkspace(tmpDir).pinnedSessionId, 'session-123');
  } finally {
    process.chdir(previousCwd);
  }
});

test('setSessionMode latest preserves last known session while unbinding current target', () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ushagent-test-'));
  const previousCwd = process.cwd();
  process.chdir(tmpDir);

  try {
    const { bridge, config } = createBridge(tmpDir);
    bridge.setSessionMode('pinned', 'session-123');
    bridge.setSessionMode('latest');

    assert.equal(bridge.sessionMode, 'latest');
    assert.equal(bridge.getBoundSessionId(), null);
    assert.equal(bridge.getLastSessionId(), 'session-123');
    assert.equal(config.getWorkspace(tmpDir).sessionMode, 'latest');
    assert.equal(config.getWorkspace(tmpDir).pinnedSessionId, null);
  } finally {
    process.chdir(previousCwd);
  }
});

test('prepareStartupSession restores pinned workspace mode', () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ushagent-test-'));
  const previousCwd = process.cwd();
  process.chdir(tmpDir);

  try {
    const { bridge } = createBridge(tmpDir, {
      sessionMode: 'pinned',
      pinnedSessionId: 'session-abc',
      lastSessionId: 'session-abc',
    });

    bridge.prepareStartupSession();

    assert.equal(bridge.sessionMode, 'pinned');
    assert.equal(bridge.getBoundSessionId(), 'session-abc');
  } finally {
    process.chdir(previousCwd);
  }
});

test('handleProjectSwitchCommand force aborts active prompt and switches workspace', async () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'ushagent-test-'));
  const projectA = path.join(rootDir, 'project-a');
  const projectB = path.join(rootDir, 'project-b');
  mkdirSync(projectA);
  mkdirSync(projectB);

  const previousCwd = process.cwd();
  process.chdir(projectA);

  try {
    const { bridge, config } = createBridge(projectA);
    config.setWorkspace(projectB, {
      label: 'project-b',
      provider: 'codex',
      codexArgs: config.codexArgs,
      codexLastSessionId: 'session-b',
      sessionMode: 'latest',
      pinnedSessionId: null,
    });

    let aborted = false;
    bridge.activePromptAbortController = {
      signal: { aborted: false },
    };
    bridge.requestStopCurrentPrompt = () => {
      aborted = true;
      return true;
    };
    bridge.clearQueuedTelegramMessages = () => 0;

    await bridge.handleProjectSwitchCommand(`${projectB} force`, 'cli');

    assert.equal(aborted, true);
    assert.equal(process.cwd(), projectB);
    assert.equal(bridge.getCurrentWorkspacePath(), projectB);
    assert.equal(config.activeWorkspacePath, projectB);
  } finally {
    process.chdir(previousCwd);
  }
});

test('publishTelegramView persists control panel message id from sent message', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ushagent-test-'));
  const previousCwd = process.cwd();
  process.chdir(tmpDir);

  try {
    const { bridge, config } = createBridge(tmpDir);
    bridge.safeSendMessage = async () => ({ message_id: 42 });

    await bridge.publishTelegramView('panel', {
      persistMenu: true,
      replyMarkup: bridge.buildControlKeyboard(),
    });

    assert.equal(config.telegramControlPanelMessageId, 42);
  } finally {
    process.chdir(previousCwd);
  }
});

test('safeSendMessage returns sent Telegram message so menu state can persist', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ushagent-test-'));
  const previousCwd = process.cwd();
  process.chdir(tmpDir);

  try {
    const { bridge } = createBridge(tmpDir);
    bridge.telegram = {
      sendMessage: async () => ({ message_id: 77 }),
    };
    bridge.safeSendMessage = Bridge.prototype.safeSendMessage.bind(bridge);

    const sentMessage = await bridge.safeSendMessage('panel', {
      replyMarkup: bridge.buildControlKeyboard(),
    });

    assert.deepEqual(sentMessage, { message_id: 77 });
  } finally {
    process.chdir(previousCwd);
  }
});

test('handleCommand /last returns the last completed request and response', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ushagent-test-'));
  const previousCwd = process.cwd();
  process.chdir(tmpDir);

  try {
    const { bridge } = createBridge(tmpDir);
    bridge.lastExchange = {
      source: 'telegram',
      prompt: 'What changed?',
      response: 'The menu command was fixed.',
    };

    let sentText = null;
    bridge.safeSendMessage = async text => {
      sentText = text;
      return { message_id: 1 };
    };

    await bridge.handleCommand('/last');

    assert.match(sentText, /Source: Telegram/);
    assert.match(sentText, /Request:\nWhat changed\?/);
    assert.match(sentText, /Response:\nThe menu command was fixed\./);
  } finally {
    process.chdir(previousCwd);
  }
});

test('handleCommand accepts Telegram commands with bot mention suffix', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ushagent-test-'));
  const previousCwd = process.cwd();
  process.chdir(tmpDir);

  try {
    const { bridge } = createBridge(tmpDir);
    let opened = false;
    bridge.openControlPanel = async () => {
      opened = true;
    };

    await bridge.handleCommand('/menu@botname');

    assert.equal(opened, true);
  } finally {
    process.chdir(previousCwd);
  }
});

test('handleCommand /history returns recent chat history', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ushagent-test-'));
  const previousCwd = process.cwd();
  process.chdir(tmpDir);

  try {
    const { bridge } = createBridge(tmpDir);
    const sessionId = 'session-123';
    const fixturePath = writeCodexSessionFixture(sessionId, tmpDir, [
      {
        timestamp: '2099-12-31T23:59:59.100Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'First question' }],
        },
      },
      {
        timestamp: '2099-12-31T23:59:59.200Z',
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'assistant',
          phase: 'final_answer',
          content: [{ type: 'output_text', text: 'First answer' }],
        },
      },
    ]);

    let sentText = null;
    bridge.safeSendMessage = async text => {
      sentText = text;
      return { message_id: 1 };
    };
    bridge.getLastSessionId = () => sessionId;
    bridge.getBoundSessionId = () => null;

    await bridge.handleCommand('/history 5');

    assert.match(sentText, /Recent Codex session messages for session-123/);
    assert.match(sentText, /User: First question/);
    assert.match(sentText, /Codex \(final_answer\): First answer/);

    rmSync(fixturePath, { force: true });
  } finally {
    process.chdir(previousCwd);
  }
});

test('connectToken registers Telegram bot commands during initialization', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ushagent-test-'));
  const previousCwd = process.cwd();
  process.chdir(tmpDir);

  const originalEnsurePollingMode = TelegramApi.prototype.ensurePollingMode;
  const originalGetMe = TelegramApi.prototype.getMe;
  const originalSetMyCommands = TelegramApi.prototype.setMyCommands;

  try {
    const { bridge, config } = createBridge(tmpDir);
    let registeredCommands = null;

    TelegramApi.prototype.ensurePollingMode = async () => {};
    TelegramApi.prototype.getMe = async () => ({ id: 999, username: 'freshbot' });
    TelegramApi.prototype.setMyCommands = async commands => {
      registeredCommands = commands;
    };

    const connected = await bridge.connectToken('123456:token_token_token_token');

    assert.equal(connected, true);
    assert.ok(Array.isArray(registeredCommands));
    assert.deepEqual(
      registeredCommands.map(command => command.command),
      ['help', 'menu', 'status', 'new', 'session', 'sessions', 'resume', 'project', 'projects', 'usage', 'history', 'prev', 'last', 'stop']
    );
    assert.equal(config.telegramBotUsername, 'freshbot');
  } finally {
    TelegramApi.prototype.ensurePollingMode = originalEnsurePollingMode;
    TelegramApi.prototype.getMe = originalGetMe;
    TelegramApi.prototype.setMyCommands = originalSetMyCommands;
    process.chdir(previousCwd);
  }
});
