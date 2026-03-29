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
      telegramControlPanelMessageIds: {},
      telegramForum: {
        enabled: false,
        chatId: null,
        mainThreadId: null,
        topics: {},
      },
      telegramReplyKeyboard: {
        enabled: false,
        variant: 'standard',
      },
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

  setTelegramForum(data = {}) {
    this._data.telegramForum = {
      ...this._data.telegramForum,
      ...data,
      topics: data.topics && typeof data.topics === 'object' && !Array.isArray(data.topics) ? { ...data.topics } : this._data.telegramForum.topics,
    };
    return this._data;
  }

  setTelegramTopic(topicKey, topicRecord = {}) {
    this._data.telegramForum = {
      ...this._data.telegramForum,
      topics: {
        ...this._data.telegramForum.topics,
        [topicKey]: {
          ...(this._data.telegramForum.topics[topicKey] || {}),
          ...topicRecord,
        },
      },
    };
    return this._data;
  }

  setTelegramReplyKeyboard(data = {}) {
    this._data.telegramReplyKeyboard = {
      ...this._data.telegramReplyKeyboard,
      ...data,
    };
    return this._data;
  }

  getTelegramControlPanelMessageId(slotKey = 'default') {
    const key = String(slotKey || 'default').trim() || 'default';
    const mapped = this._data.telegramControlPanelMessageIds[key];
    if (Number.isInteger(mapped)) {
      return mapped;
    }

    return key === 'default' ? this._data.telegramControlPanelMessageId : null;
  }

  setTelegramControlPanelMessageId(slotKey = 'default', messageId = null) {
    const key = String(slotKey || 'default').trim() || 'default';
    if (Number.isInteger(messageId)) {
      this._data.telegramControlPanelMessageIds[key] = messageId;
    } else {
      delete this._data.telegramControlPanelMessageIds[key];
    }

    if (key === 'default') {
      this._data.telegramControlPanelMessageId = Number.isInteger(messageId) ? messageId : null;
    }

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

  resetAll() {
    this._data = {
      provider: null,
      codexArgs: [],
      codexLastSessionId: null,
      activeWorkspacePath: null,
      workspaces: {},
      telegramChatId: null,
      telegramChatUserId: null,
      telegramUpdateCursor: 0,
      telegramBotUsername: null,
      telegramBotToken: null,
      telegramBotId: null,
      telegramControlPanelMessageId: null,
      telegramControlPanelMessageIds: {},
      telegramForum: {
        enabled: false,
        chatId: null,
        mainThreadId: null,
        topics: {},
      },
    };
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

  get telegramControlPanelMessageIds() {
    return this._data.telegramControlPanelMessageIds;
  }

  get telegramForum() {
    return this._data.telegramForum;
  }

  get telegramReplyKeyboard() {
    return this._data.telegramReplyKeyboard;
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
    bridge.getExecutionState(bridge.getCurrentExecutionKey()).activeAbortController = {
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

test('publishTelegramView persists forum control panel ids per thread', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ushagent-test-'));
  const previousCwd = process.cwd();
  process.chdir(tmpDir);

  try {
    const { bridge, config } = createBridge(tmpDir);
    bridge.telegramForumState = {
      enabled: true,
      chatId: 'chat-1',
      mainThreadId: 10,
      hostThreadId: 20,
      projectThreadId: 30,
      topics: {},
    };
    bridge.telegramThreadId = 30;
    bridge.safeSendMessage = async () => ({ message_id: 99 });

    await bridge.publishTelegramView('main panel', {
      persistMenu: true,
      messageThreadId: 10,
      replyMarkup: bridge.buildMainKeyboard(),
    });

    await bridge.publishTelegramView('project panel', {
      persistMenu: true,
      messageThreadId: 30,
      replyMarkup: bridge.buildControlKeyboard(),
    });

    assert.equal(config.getTelegramControlPanelMessageId('thread:10'), 99);
    assert.equal(config.getTelegramControlPanelMessageId('thread:30'), 99);
    assert.equal(config.telegramControlPanelMessageId, null);
  } finally {
    process.chdir(previousCwd);
  }
});

test('pollOnce routes forum callback queries before topic command handlers', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ushagent-test-'));
  const previousCwd = process.cwd();
  process.chdir(tmpDir);

  try {
    const { bridge, config } = createBridge(tmpDir);
    bridge.telegramForumState = {
      enabled: true,
      chatId: 'chat-1',
      mainThreadId: 10,
      hostThreadId: 20,
      projectThreadId: 30,
      topics: {},
    };
    bridge.telegram = {
      getUpdates: async () => ({
        nextCursor: 1,
        messages: [
          {
            type: 'callback',
            chatId: 'chat-1',
            userId: 'user-1',
            messageId: 44,
            messageThreadId: 10,
            callbackQueryId: 'cb-1',
            data: 'hosts',
            text: 'hosts',
          },
        ],
      }),
    };

    let callbackData = null;
    bridge.handleCallbackAction = async data => {
      callbackData = data;
    };
    bridge.handleMainTopicMessage = async () => {
      throw new Error('main topic handler should not receive callback queries');
    };

    await bridge.pollOnce();

    assert.equal(callbackData, 'hosts');
    assert.equal(config.telegramUpdateCursor, 1);
  } finally {
    process.chdir(previousCwd);
  }
});

test('ensureTelegramForumContext starts in host control mode without creating main or project topics', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ushagent-test-'));
  const previousCwd = process.cwd();
  process.chdir(tmpDir);

  try {
    const { bridge, config } = createBridge(tmpDir);
    const createdTopics = [];
    bridge.telegram = {
      getChat: async () => ({ is_forum: true }),
      createForumTopic: async (_chatId, title) => {
        createdTopics.push(title);
        return { message_thread_id: createdTopics.length + 9 };
      },
    };

    await bridge.ensureTelegramForumContext('chat-1');

    assert.deepEqual(createdTopics, [`HOST: ${os.hostname()}`]);
    assert.equal(bridge.telegramForumState.projectThreadId, null);
    assert.equal(bridge.telegramForumState.mainThreadId, null);
    assert.equal(bridge.telegramThreadId, bridge.telegramForumState.hostThreadId);
    assert.equal(config.telegramForum.topics.main, undefined);
    assert.equal(config.telegramForum.topics[`host:${os.hostname().trim().toLowerCase()}`].kind, 'host');
  } finally {
    process.chdir(previousCwd);
  }
});

test('forum switch_project callback opens workspace browser', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ushagent-test-'));
  const otherProject = path.join(tmpDir, 'project-b');
  mkdirSync(otherProject);
  const previousCwd = process.cwd();
  process.chdir(tmpDir);

  try {
    const { bridge, config } = createBridge(tmpDir);
    config.setWorkspace(otherProject, {
      label: 'project-b',
      provider: 'codex',
      codexArgs: config.codexArgs,
      codexLastSessionId: null,
      sessionMode: 'latest',
      pinnedSessionId: null,
    });
    bridge.telegramForumState = {
      enabled: true,
      chatId: 'chat-1',
      mainThreadId: 10,
      hostThreadId: 20,
      projectThreadId: 30,
      topics: {},
    };

    let published = null;
    bridge.publishTelegramView = async (text, options) => {
      published = { text, options };
    };
    bridge.telegram = {
      answerCallbackQuery: async () => null,
    };

    await bridge.handleCallbackAction('forum:switch_project', 'cb-1', 44, 30);

    assert.match(published.text, /Known workspaces/);
    assert.match(published.text, /topic missing/);
    assert.ok(Array.isArray(published.options.replyMarkup.inline_keyboard));
  } finally {
    process.chdir(previousCwd);
  }
});

test('handleProjectSwitchCommand ensures forum topic for switched workspace', async () => {
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
      codexLastSessionId: null,
      sessionMode: 'latest',
      pinnedSessionId: null,
    });
    bridge.telegramForumState = {
      enabled: true,
      chatId: 'chat-1',
      mainThreadId: 10,
      hostThreadId: 20,
      projectThreadId: 30,
      topics: {},
    };
    bridge.telegramThreadId = 30;

    let ensuredWorkspace = null;
    bridge.ensureTelegramProjectTopic = async (_chatId, workspacePath) => {
      ensuredWorkspace = workspacePath;
      bridge.telegramThreadId = 77;
      bridge.telegramForumState.projectThreadId = 77;
      return { threadId: 77, title: 'HOST | project-b' };
    };

    let published = null;
    bridge.publishTelegramView = async (text, options) => {
      published = { text, options };
    };

    await bridge.handleProjectSwitchCommand(projectB, 'telegram', {
      messageId: 44,
      messageThreadId: 30,
      persistMenu: true,
    });

    assert.equal(ensuredWorkspace, projectB);
    assert.equal(bridge.telegramThreadId, 77);
    assert.match(published.text, /Topic thread: 77/);
    assert.equal(published.options.messageThreadId, 77);
  } finally {
    process.chdir(previousCwd);
  }
});

test('pollOnce switches workspace when message arrives in another project topic', async () => {
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
      codexLastSessionId: null,
      sessionMode: 'latest',
      pinnedSessionId: null,
    });
    bridge.telegramForumState = {
      enabled: true,
      chatId: 'chat-1',
      mainThreadId: 10,
      hostThreadId: 20,
      projectThreadId: 30,
      topics: {
        'project:host:a': {
          kind: 'project',
          threadId: 30,
          title: 'HOST | project-a',
          hostname: os.hostname(),
          workspacePath: projectA,
        },
        'project:host:b': {
          kind: 'project',
          threadId: 77,
          title: 'HOST | project-b',
          hostname: os.hostname(),
          workspacePath: projectB,
        },
      },
    };
    bridge.telegramThreadId = 30;
    bridge.telegram = {
      getUpdates: async () => ({
        nextCursor: 1,
        messages: [
          {
            type: 'text',
            chatId: 'chat-1',
            userId: 'user-1',
            messageId: 55,
            messageThreadId: 77,
            text: 'hello from project b',
          },
        ],
      }),
    };

    let handledText = null;
    bridge.handleMessage = async message => {
      handledText = message?.text || null;
    };

    await bridge.pollOnce();

    assert.equal(handledText, 'hello from project b');
    assert.equal(process.cwd(), projectB);
    assert.equal(bridge.telegramThreadId, 77);
    assert.equal(config.activeWorkspacePath, projectB);
  } finally {
    process.chdir(previousCwd);
  }
});

test('pollOnce ignores project topics owned by another host', async () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'ushagent-test-'));
  const projectA = path.join(rootDir, 'project-a');
  const foreignProject = path.join(rootDir, 'project-foreign');
  mkdirSync(projectA);
  mkdirSync(foreignProject);

  const previousCwd = process.cwd();
  process.chdir(projectA);

  try {
    const { bridge, config } = createBridge(projectA);
    config.setWorkspace(foreignProject, {
      label: 'project-foreign',
      provider: 'codex',
      codexArgs: config.codexArgs,
      codexLastSessionId: null,
      sessionMode: 'latest',
      pinnedSessionId: null,
    });
    bridge.telegramForumState = {
      enabled: true,
      chatId: 'chat-1',
      mainThreadId: 10,
      hostThreadId: 20,
      projectThreadId: 30,
      topics: {
        'project:local:a': {
          kind: 'project',
          threadId: 30,
          title: 'LOCAL | project-a',
          hostname: os.hostname(),
          workspacePath: projectA,
        },
        'project:foreign:b': {
          kind: 'project',
          threadId: 77,
          title: 'FOREIGN | project-foreign',
          hostname: 'foreign-host',
          workspacePath: foreignProject,
        },
      },
    };
    bridge.telegramThreadId = 30;
    bridge.telegram = {
      getUpdates: async () => ({
        nextCursor: 1,
        messages: [
          {
            type: 'text',
            chatId: 'chat-1',
            userId: 'user-1',
            messageId: 55,
            messageThreadId: 77,
            text: 'foreign topic message',
          },
        ],
      }),
    };

    let handled = false;
    bridge.handleMessage = async () => {
      handled = true;
    };

    await bridge.pollOnce();

    assert.equal(handled, false);
    assert.equal(process.cwd(), projectA);
    assert.equal(bridge.telegramThreadId, 30);
  } finally {
    process.chdir(previousCwd);
  }
});

test('syncForumWorkspaceForThread restores session binding from the target project topic', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'ushagent-test-'));
  const projectA = path.join(rootDir, 'project-a');
  const projectB = path.join(rootDir, 'project-b');
  mkdirSync(projectA);
  mkdirSync(projectB);

  const previousCwd = process.cwd();
  process.chdir(projectA);

  try {
    const { bridge, config } = createBridge(projectA, {
      sessionMode: 'latest',
      lastSessionId: 'session-a',
    });
    config.setWorkspace(projectB, {
      label: 'project-b',
      provider: 'codex',
      codexArgs: config.codexArgs,
      codexLastSessionId: 'workspace-session-b',
      sessionMode: 'latest',
      pinnedSessionId: null,
    });
    bridge.telegramForumState = {
      enabled: true,
      chatId: 'chat-1',
      mainThreadId: 10,
      hostThreadId: 20,
      projectThreadId: 30,
      topics: {
        'project:host:a': {
          kind: 'project',
          threadId: 30,
          title: 'HOST | project-a',
          hostname: os.hostname(),
          workspacePath: projectA,
          codexLastSessionId: 'topic-session-a',
          sessionMode: 'latest',
          pinnedSessionId: null,
        },
        'project:host:b': {
          kind: 'project',
          threadId: 77,
          title: 'HOST | project-b',
          hostname: os.hostname(),
          workspacePath: projectB,
          codexLastSessionId: 'topic-session-b',
          sessionMode: 'pinned',
          pinnedSessionId: 'topic-session-b',
        },
      },
    };
    bridge.telegramThreadId = 30;

    bridge.syncForumWorkspaceForThread(77);

    assert.equal(process.cwd(), projectB);
    assert.equal(bridge.sessionMode, 'pinned');
    assert.equal(bridge.getLastSessionId(), 'topic-session-b');
    assert.equal(bridge.getBoundSessionId(), 'topic-session-b');
  } finally {
    process.chdir(previousCwd);
  }
});

test('syncForumWorkspaceForThread ignores foreign-host project topics', () => {
  const rootDir = mkdtempSync(path.join(os.tmpdir(), 'ushagent-test-'));
  const projectA = path.join(rootDir, 'project-a');
  const foreignProject = path.join(rootDir, 'project-foreign');
  mkdirSync(projectA);
  mkdirSync(foreignProject);

  const previousCwd = process.cwd();
  process.chdir(projectA);

  try {
    const { bridge } = createBridge(projectA, {
      sessionMode: 'latest',
      lastSessionId: 'session-a',
    });
    bridge.telegramForumState = {
      enabled: true,
      chatId: 'chat-1',
      mainThreadId: 10,
      hostThreadId: 20,
      projectThreadId: 30,
      topics: {
        'project:local:a': {
          kind: 'project',
          threadId: 30,
          title: 'LOCAL | project-a',
          hostname: os.hostname(),
          workspacePath: projectA,
          codexLastSessionId: 'topic-session-a',
          sessionMode: 'latest',
          pinnedSessionId: null,
        },
        'project:foreign:b': {
          kind: 'project',
          threadId: 77,
          title: 'FOREIGN | project-foreign',
          hostname: 'foreign-host',
          workspacePath: foreignProject,
          codexLastSessionId: 'topic-session-b',
          sessionMode: 'pinned',
          pinnedSessionId: 'topic-session-b',
        },
      },
    };
    bridge.telegramThreadId = 30;

    const result = bridge.syncForumWorkspaceForThread(77);

    assert.equal(result, null);
    assert.equal(process.cwd(), projectA);
    assert.equal(bridge.telegramThreadId, 30);
    assert.equal(bridge.sessionMode, 'latest');
    assert.equal(bridge.getLastSessionId(), 'topic-session-a');
  } finally {
    process.chdir(previousCwd);
  }
});

test('startTelegramDispatch groups only pending Telegram messages from the same topic', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ushagent-test-'));
  const previousCwd = process.cwd();
  process.chdir(tmpDir);

  try {
    const { bridge } = createBridge(tmpDir);
    const dispatched = [];
    bridge.queuePrompt = async (prompt, source, options) => {
      dispatched.push({ prompt, source, options });
      return new Promise(() => {});
    };
    bridge.telegramPendingMessages = [
      { text: 'first', messageThreadId: 30 },
      { text: 'second', messageThreadId: 30 },
      { text: 'third', messageThreadId: 77 },
    ];

    bridge.startTelegramDispatch(true);

    assert.equal(dispatched.length, 2);
    assert.equal(dispatched[0].prompt, 'first\nsecond');
    assert.equal(dispatched[0].source, 'telegram');
    assert.equal(dispatched[0].options.groupedCount, 2);
    assert.equal(dispatched[0].options.messageThreadId, 30);
    assert.equal(dispatched[1].prompt, 'third');
    assert.equal(dispatched[1].options.messageThreadId, 77);
    assert.deepEqual(bridge.telegramPendingMessages, []);
  } finally {
    process.chdir(previousCwd);
  }
});

test('queuePrompt keeps progress and final response in the original Telegram topic', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ushagent-test-'));
  const previousCwd = process.cwd();
  process.chdir(tmpDir);

  try {
    const { bridge } = createBridge(tmpDir);
    const sent = [];
    const edits = [];
    bridge.telegramThreadId = 30;
    bridge.telegram = {
      editMessageText: async (chatId, messageId, text, options = {}) => {
        edits.push({ chatId, messageId, text, options });
        return null;
      },
    };
    bridge.safeSendMessage = async (text, options = {}) => {
      sent.push({ text, options });
      return { message_id: sent.length };
    };
    bridge.runProviderWithContext = async (_prompt, _context, hooks = {}) => {
      bridge.telegramThreadId = 77;
      hooks.onProgress?.('Inspecting files');
      return 'done';
    };

    await bridge.queuePrompt('hello', 'telegram', { messageThreadId: 30 });

    assert.equal(sent[0].options.messageThreadId, 30);
    assert.equal(sent[1].options.messageThreadId, 30);
    assert.equal(edits.length, 1);
    assert.equal(edits[0].options.messageThreadId, 30);
    assert.equal(bridge.telegramThreadId, 77);
  } finally {
    process.chdir(previousCwd);
  }
});

test('queuePrompt keeps Telegram replies in the original topic while active topic changes', async () => {
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
      codexLastSessionId: null,
      sessionMode: 'latest',
      pinnedSessionId: null,
    });
    bridge.telegramForumState = {
      enabled: true,
      chatId: 'chat-1',
      mainThreadId: 10,
      hostThreadId: 20,
      projectThreadId: 30,
      topics: {
        'project:host:a': {
          kind: 'project',
          threadId: 30,
          title: 'HOST | project-a',
          hostname: os.hostname(),
          workspacePath: projectA,
        },
        'project:host:b': {
          kind: 'project',
          threadId: 77,
          title: 'HOST | project-b',
          hostname: os.hostname(),
          workspacePath: projectB,
        },
      },
    };
    bridge.telegramThreadId = 30;

    const sent = [];
    bridge.safeSendMessage = async (text, options = {}) => {
      sent.push({ text, options });
      if (text.includes('is working')) {
        bridge.telegramThreadId = 77;
      }
      return { message_id: 101 };
    };

    const edits = [];
    bridge.telegram = {
      editMessageText: async (_chatId, messageId, text, options = {}) => {
        edits.push({ messageId, text, options });
        bridge.telegramThreadId = 77;
        return null;
      },
    };

    bridge.runProviderWithContext = async (_prompt, _context, hooks = {}) => {
      hooks.onProgress?.('Inspecting files');
      return 'Done.';
    };

    await bridge.queuePrompt('check topic binding', 'telegram', {
      messageThreadId: 30,
      workspacePath: projectA,
    });

    assert.equal(sent[0].options.messageThreadId, 30);
    assert.equal(sent[0].options.silent, true);
    assert.equal(edits[0].options.messageThreadId, 30);
    assert.equal(sent.at(-1).options.messageThreadId, 30);
  } finally {
    process.chdir(previousCwd);
  }
});

test('queuePrompt accumulates intermediate progress lines into one Telegram edit', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ushagent-test-'));
  const previousCwd = process.cwd();
  process.chdir(tmpDir);

  try {
    const { bridge } = createBridge(tmpDir);
    const sent = [];
    const edits = [];
    bridge.safeSendMessage = async (text, options = {}) => {
      sent.push({ text, options });
      return { message_id: 101 };
    };
    bridge.telegram = {
      editMessageText: async (_chatId, messageId, text, options = {}) => {
        edits.push({ messageId, text, options });
        return null;
      },
    };

    bridge.runProviderWithContext = async (_prompt, _context, hooks = {}) => {
      hooks.onProgress?.('Inspecting files', { phase: 'commentary' });
      hooks.onProgress?.('Reading config', { phase: 'commentary' });
      return 'done';
    };

    await bridge.queuePrompt('hello', 'telegram', { messageThreadId: 30 });

    assert.equal(sent[0].options.messageThreadId, 30);
    assert.equal(edits.length, 1);
    assert.match(edits[0].text, /Inspecting files/);
    assert.match(edits[0].text, /Reading config/);
    assert.match(edits[0].text, /\[commentary\] Inspecting files/);
    assert.match(edits[0].text, /\[commentary\] Reading config/);
  } finally {
    process.chdir(previousCwd);
  }
});

test('queuePrompt drops trailing progress entry when it duplicates the final response', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ushagent-test-'));
  const previousCwd = process.cwd();
  process.chdir(tmpDir);

  try {
    const { bridge } = createBridge(tmpDir);
    const edits = [];
    bridge.safeSendMessage = async () => ({ message_id: 101 });
    bridge.telegram = {
      editMessageText: async (_chatId, messageId, text, options = {}) => {
        edits.push({ messageId, text, options });
        return null;
      },
    };

    bridge.runProviderWithContext = async (_prompt, _context, hooks = {}) => {
      hooks.onProgress?.('Inspecting files', { phase: 'commentary' });
      hooks.onProgress?.('Done.', { phase: 'commentary' });
      return 'Done.';
    };

    await bridge.queuePrompt('hello', 'telegram', { messageThreadId: 30 });

    assert.equal(edits.length, 1);
    assert.match(edits[0].text, /Inspecting files/);
    assert.doesNotMatch(edits[0].text, /\[commentary\] Done\./);
  } finally {
    process.chdir(previousCwd);
  }
});

test('queuePrompt restores queued workspace before provider execution', async () => {
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
      codexLastSessionId: null,
      sessionMode: 'latest',
      pinnedSessionId: null,
    });

    let providerCwd = null;
    bridge.safeSendMessage = async () => ({ message_id: 1 });
    bridge.runProviderWithContext = async (_prompt, context) => {
      providerCwd = context.workspacePath;
      return 'Done.';
    };

    await bridge.queuePrompt('run in project b', 'telegram', {
      messageThreadId: 77,
      workspacePath: projectB,
    });

    assert.equal(providerCwd, projectB);
    assert.equal(process.cwd(), projectA);
  } finally {
    process.chdir(previousCwd);
  }
});

test('startTelegramDispatch does not merge pending messages from different topics', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ushagent-test-'));
  const previousCwd = process.cwd();
  process.chdir(tmpDir);

  try {
    const { bridge } = createBridge(tmpDir);
    const queued = [];
    bridge.queuePrompt = async (prompt, source, options = {}) => {
      queued.push({ prompt, source, options });
    };

    bridge.telegramPendingMessages = [
      { text: 'first topic message', messageThreadId: 30, workspacePath: 'a' },
      { text: 'second topic message', messageThreadId: 77, workspacePath: 'b' },
    ];

    bridge.startTelegramDispatch(true);
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(queued.length, 2);
    assert.equal(queued[0].prompt, 'first topic message');
    assert.equal(queued[0].options.messageThreadId, 30);
    assert.equal(queued[1].prompt, 'second topic message');
    assert.equal(queued[1].options.messageThreadId, 77);
  } finally {
    process.chdir(previousCwd);
  }
});

test('startTelegramDispatch reruns automatically when a new topic message arrives during dispatch', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ushagent-test-'));
  const previousCwd = process.cwd();
  process.chdir(tmpDir);

  try {
    const { bridge } = createBridge(tmpDir);
    const queued = [];
    let injected = false;
    bridge.queuePrompt = async (prompt, source, options = {}) => {
      queued.push({ prompt, source, options });
      if (!injected) {
        injected = true;
        bridge.telegramPendingMessages.push({
          text: 'late topic message',
          messageThreadId: 77,
          workspacePath: tmpDir,
          executionKey: 'telegram:77',
        });
      }
    };

    bridge.telegramPendingMessages = [
      {
        text: 'first topic message',
        messageThreadId: 30,
        workspacePath: tmpDir,
        executionKey: 'telegram:30',
      },
    ];

    bridge.startTelegramDispatch(true);
    await new Promise(resolve => setTimeout(resolve, 0));

    assert.equal(queued.length, 2);
    assert.equal(queued[0].options.messageThreadId, 30);
    assert.equal(queued[1].options.messageThreadId, 77);
  } finally {
    process.chdir(previousCwd);
  }
});

test('queuePrompt runs project topics concurrently on separate execution keys', async () => {
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
      codexLastSessionId: null,
      sessionMode: 'latest',
      pinnedSessionId: null,
    });

    bridge.safeSendMessage = async () => ({ message_id: 1 });

    const started = [];
    const resolvers = [];
    bridge.runProviderWithContext = (_prompt, context) =>
      new Promise(resolve => {
        started.push(context.workspacePath);
        resolvers.push(() => resolve(`done:${path.basename(context.workspacePath)}`));
      });

    const first = bridge.queuePrompt('first', 'telegram', {
      messageThreadId: 30,
      workspacePath: projectA,
    });
    const second = bridge.queuePrompt('second', 'telegram', {
      messageThreadId: 77,
      workspacePath: projectB,
    });

    await new Promise(resolve => setTimeout(resolve, 0));

    assert.deepEqual(started.sort(), [projectA, projectB].sort());

    resolvers[0]();
    resolvers[1]();
    await Promise.all([first, second]);
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

test('safeSendMessage does not attach reply keyboard by default', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ushagent-test-'));
  const previousCwd = process.cwd();
  process.chdir(tmpDir);

  try {
    const { bridge } = createBridge(tmpDir);
    let requestOptions = null;
    bridge.telegram = {
      sendMessage: async (_chatId, _text, options = {}) => {
        requestOptions = options;
        return { message_id: 77 };
      },
    };
    bridge.safeSendMessage = Bridge.prototype.safeSendMessage.bind(bridge);

    await bridge.safeSendMessage('hello');

    assert.equal(requestOptions.replyMarkup, null);
  } finally {
    process.chdir(previousCwd);
  }
});

test('keyboard settings callback toggles reply keyboard config', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ushagent-test-'));
  const previousCwd = process.cwd();
  process.chdir(tmpDir);

  try {
    const { bridge, config } = createBridge(tmpDir);
    let published = null;
    bridge.telegram = {
      answerCallbackQuery: async () => null,
    };
    bridge.publishTelegramView = async (text, options = {}) => {
      published = { text, options };
    };
    const sent = [];
    bridge.safeSendMessage = async (text, options = {}) => {
      sent.push({ text, options });
      return { message_id: 1 };
    };

    await bridge.handleCallbackAction('keyboard:toggle', 'cb-1', 44, null);

    assert.equal(config.telegramReplyKeyboard.enabled, true);
    assert.match(published.text, /Reply keyboard settings/);
    assert.ok(Array.isArray(sent[0].options.replyMarkup.keyboard));
  } finally {
    process.chdir(previousCwd);
  }
});

test('stop_execution callback stops only the targeted telegram execution lane', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ushagent-test-'));
  const previousCwd = process.cwd();
  process.chdir(tmpDir);

  try {
    const { bridge } = createBridge(tmpDir);
    const stopped = [];
    const cleared = [];
    const sent = [];
    bridge.telegram = {
      answerCallbackQuery: async () => null,
    };
    bridge.requestStopCurrentPrompt = (_reason, options = {}) => {
      stopped.push(options.executionKey);
      return true;
    };
    bridge.clearQueuedTelegramMessages = (options = {}) => {
      cleared.push(options.executionKey);
      return 0;
    };
    bridge.safeSendMessage = async (text, options = {}) => {
      sent.push({ text, options });
      return { message_id: 1 };
    };

    await bridge.handleCallbackAction('stop_execution:77', 'cb-1', 44, 30);

    assert.deepEqual(stopped, ['telegram:77']);
    assert.deepEqual(cleared, ['telegram:77']);
    assert.equal(sent[0].options.messageThreadId, 77);
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

    await bridge.handleCommand('/menu@bot');

    assert.equal(opened, true);
  } finally {
    process.chdir(previousCwd);
  }
});

test('handleCommand ignores Telegram commands addressed to another bot', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ushagent-test-'));
  const previousCwd = process.cwd();
  process.chdir(tmpDir);

  try {
    const { bridge } = createBridge(tmpDir);
    let opened = false;
    bridge.openControlPanel = async () => {
      opened = true;
    };

    await bridge.handleCommand('/menu@otherbot');

    assert.equal(opened, false);
  } finally {
    process.chdir(previousCwd);
  }
});

test('handleCommand /fast enables fast Codex mode and persists provider args', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ushagent-test-'));
  const previousCwd = process.cwd();
  process.chdir(tmpDir);

  try {
    const { bridge, config } = createBridge(tmpDir);
    let sentText = null;
    bridge.safeSendMessage = async text => {
      sentText = text;
      return { message_id: 1 };
    };

    await bridge.handleCommand('/fast');

    assert.equal(bridge.isFastModeEnabled(), true);
    assert.match(sentText, /Fast mode enabled/);
    assert.deepEqual(config.codexArgs, ['--dangerously-bypass-approvals-and-sandbox', '-c', 'reasoning_effort="low"']);
    assert.deepEqual(config.getWorkspace(tmpDir).codexArgs, ['--dangerously-bypass-approvals-and-sandbox', '-c', 'reasoning_effort="low"']);
  } finally {
    process.chdir(previousCwd);
  }
});

test('handleCommand /fast off disables fast Codex mode and removes reasoning override', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ushagent-test-'));
  const previousCwd = process.cwd();
  process.chdir(tmpDir);

  try {
    const { bridge, config } = createBridge(tmpDir);
    bridge.providerArgs = ['--dangerously-bypass-approvals-and-sandbox', '-c', 'reasoning_effort="low"'];
    config.setMany({ codexArgs: [...bridge.providerArgs] });
    config.setWorkspace(tmpDir, { codexArgs: [...bridge.providerArgs] });

    let sentText = null;
    bridge.safeSendMessage = async text => {
      sentText = text;
      return { message_id: 1 };
    };

    await bridge.handleCommand('/fast off');

    assert.equal(bridge.isFastModeEnabled(), false);
    assert.match(sentText, /Fast mode disabled/);
    assert.deepEqual(config.codexArgs, ['--dangerously-bypass-approvals-and-sandbox']);
    assert.deepEqual(config.getWorkspace(tmpDir).codexArgs, ['--dangerously-bypass-approvals-and-sandbox']);
  } finally {
    process.chdir(previousCwd);
  }
});

test('local /reset clears config and stops the bridge', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ushagent-test-'));
  const previousCwd = process.cwd();
  process.chdir(tmpDir);

  try {
    const { bridge, config } = createBridge(tmpDir);
    const sent = [];
    bridge.safeSendMessage = async text => {
      sent.push(text);
      return { message_id: 1 };
    };
    bridge.stopLocalInputLoop = () => {
      bridge.localInputInterface = null;
    };

    await bridge.handleLocalInputLine('/reset');

    assert.equal(bridge.running, false);
    assert.equal(config.provider, null);
    assert.equal(config.telegramChatId, null);
    assert.match(sent[0], /Restart setup on next launch/);
  } finally {
    process.chdir(previousCwd);
  }
});

test('local /addclient prints join-client bootstrap command', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ushagent-test-'));
  const previousCwd = process.cwd();
  process.chdir(tmpDir);

  try {
    const { bridge, config } = createBridge(tmpDir);
    config.setMany({
      provider: 'codex',
      telegramChatId: '-1001',
      telegramBotToken: '123456:token_token_token_token',
      telegramBotUsername: 'forumbot',
    });
    config.setTelegramForum({
      enabled: true,
      chatId: '-1001',
      mainThreadId: 10,
      topics: {},
    });

    const lines = [];
    bridge.writeCliLine = line => {
      lines.push(line);
    };

    await bridge.handleLocalInputLine('/addclient');

    assert.equal(lines[0], 'Run this on the other computer:');
    assert.match(lines[1], /ushagent join-client --bundle ".+" --yes/);
  } finally {
    process.chdir(previousCwd);
  }
});

test('runPairingFlow supports forum pairing from a supergroup topic chat', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ushagent-test-'));
  const previousCwd = process.cwd();
  process.chdir(tmpDir);

  try {
    const { bridge, config } = createBridge(tmpDir);
    bridge.running = true;
    config.setMany({
      telegramUpdateCursor: 0,
      telegramBotUsername: 'forumbot',
      telegramChatId: null,
      telegramChatUserId: null,
    });

    let sent = null;
    bridge.telegram = {
      getUpdates: async () => ({
        nextCursor: 2,
        messages: [
          {
            chatId: '-1001',
            chatType: 'supergroup',
            userId: 'user-1',
            text: '/help@forumbot',
          },
        ],
      }),
      getChat: async chatId => ({
        id: chatId,
        is_forum: true,
      }),
      sendMessage: async (chatId, text) => {
        sent = { chatId, text };
      },
    };

    const pairing = await bridge.runPairingFlow({
      mode: 'manual',
      chatMode: 'forum',
    });

    assert.equal(pairing.chatId, '-1001');
    assert.equal(config.telegramChatId, '-1001');
    assert.equal(config.telegramChatUserId, null);
    assert.equal(config.telegramUpdateCursor, 2);
    assert.equal(sent.chatId, '-1001');
    assert.match(sent.text, /forum mode/i);
  } finally {
    process.chdir(previousCwd);
  }
});

test('runPairingFlow ignores forum commands addressed to another bot', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ushagent-test-'));
  const previousCwd = process.cwd();
  process.chdir(tmpDir);

  try {
    const { bridge, config } = createBridge(tmpDir);
    bridge.running = true;
    config.setMany({
      telegramUpdateCursor: 0,
      telegramBotUsername: 'forumbot',
      telegramChatId: null,
      telegramChatUserId: null,
    });

    let updateCall = 0;
    bridge.telegram = {
      getUpdates: async () => {
        updateCall += 1;
        if (updateCall === 1) {
          return {
            nextCursor: 1,
            messages: [
              {
                chatId: '-1001',
                chatType: 'supergroup',
                userId: 'user-1',
                text: '/help@otherbot',
              },
            ],
          };
        }

        return {
          nextCursor: 2,
          messages: [
            {
              chatId: '-1001',
              chatType: 'supergroup',
              userId: 'user-1',
              text: '/help@forumbot',
            },
          ],
        };
      },
      getChat: async chatId => ({
        id: chatId,
        is_forum: true,
      }),
      sendMessage: async () => null,
    };

    const pairing = await bridge.runPairingFlow({
      mode: 'manual',
      chatMode: 'forum',
    });

    assert.equal(pairing.chatId, '-1001');
    assert.equal(updateCall, 2);
    assert.equal(config.telegramChatId, '-1001');
  } finally {
    process.chdir(previousCwd);
  }
});

test('handleHostTopicMessage ignores Telegram commands addressed to another bot', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ushagent-test-'));
  const previousCwd = process.cwd();
  process.chdir(tmpDir);

  try {
    const { bridge } = createBridge(tmpDir);
    bridge.telegramForumState = {
      enabled: true,
      hostThreadId: 77,
      mainThreadId: 10,
      topicsByThreadId: new Map(),
    };

    let published = false;
    bridge.publishTelegramView = async () => {
      published = true;
    };

    await bridge.handleHostTopicMessage({
      text: '/help@otherbot',
      messageThreadId: 77,
    });

    assert.equal(published, false);
  } finally {
    process.chdir(previousCwd);
  }
});

test('pollOnce handles explicit bot commands in unknown forum topics and replies in the same thread', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ushagent-test-'));
  const previousCwd = process.cwd();
  process.chdir(tmpDir);

  try {
    const { bridge, config } = createBridge(tmpDir);
    bridge.running = true;
    config.setMany({
      telegramChatId: '-1001',
      telegramChatUserId: null,
      telegramUpdateCursor: 0,
      telegramBotUsername: 'forumbot',
    });
    bridge.telegramForumState = {
      enabled: true,
      chatId: '-1001',
      mainThreadId: null,
      hostThreadId: 1218,
      topics: {
        'host:test-host': {
          threadId: 1218,
          title: 'HOST: test-host',
          kind: 'host',
          hostname: 'test-host',
        },
      },
    };
    bridge.safeSendMessage = Bridge.prototype.safeSendMessage.bind(bridge);

    const sent = [];
    bridge.telegram = {
      getUpdates: async () => ({
        nextCursor: 10,
        messages: [
          {
            chatId: '-1001',
            chatType: 'supergroup',
            userId: 'user-1',
            messageThreadId: 9999,
            text: '/help@forumbot',
          },
        ],
      }),
      sendMessage: async (chatId, text, options = {}) => {
        sent.push({ chatId, text, options });
        return { message_id: 1 };
      },
      editMessageText: async () => null,
    };

    await bridge.pollOnce();

    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /UshAgent commands:/);
    assert.equal(sent[0].chatId, '-1001');
    assert.equal(sent[0].options.messageThreadId, 9999);
    assert.equal(bridge.telegramThreadId, 9999);
    assert.equal(config.telegramUpdateCursor, 10);
  } finally {
    process.chdir(previousCwd);
  }
});

test('handleCallbackAction surfaces create topic failures in the same forum thread', async () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ushagent-test-'));
  const previousCwd = process.cwd();
  process.chdir(tmpDir);

  try {
    const { bridge, config } = createBridge(tmpDir);
    config.setMany({
      telegramChatId: '-1001',
    });
    bridge.telegramForumState = {
      enabled: true,
      chatId: '-1001',
      mainThreadId: null,
      hostThreadId: 1218,
      topics: {},
    };
    bridge.projectListCache = [{ path: tmpDir, label: path.basename(tmpDir) }];

    const sent = [];
    bridge.safeSendMessage = async (text, options = {}) => {
      sent.push({ text, options });
      return { message_id: 1 };
    };
    bridge.telegram = {
      answerCallbackQuery: async () => null,
    };
    bridge.ensureTelegramProjectTopic = async () => {
      throw new Error('Bad Request: TOPIC_ALREADY_EXISTS');
    };

    await bridge.handleCallbackAction('forum:create_topic:1', 'cb-1', 55, 1218);

    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /Failed to create topic/);
    assert.match(sent[0].text, /missing from local topic registry/);
    assert.equal(sent[0].options.messageThreadId, 1218);
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
      [
        'help',
        'fast',
        'keyboard',
        'menu',
        'status',
        'new',
        'session',
        'sessions',
        'resume',
        'project',
        'projects',
        'usage',
        'history',
        'prev',
        'last',
        'stop',
      ]
    );
    assert.equal(config.telegramBotUsername, 'freshbot');
  } finally {
    TelegramApi.prototype.ensurePollingMode = originalEnsurePollingMode;
    TelegramApi.prototype.getMe = originalGetMe;
    TelegramApi.prototype.setMyCommands = originalSetMyCommands;
    process.chdir(previousCwd);
  }
});
