import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TELEGRAM_BOT_TOKEN_ENV_NAMES = ['USHAGENT_TELEGRAM_BOT_TOKEN', 'HEYAGENT_TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN'];

function readTelegramBotTokenOverride() {
  for (const envName of TELEGRAM_BOT_TOKEN_ENV_NAMES) {
    const token = String(process.env[envName] || '').trim();
    if (token) {
      return {
        token,
        source: `env:${envName}`,
        persisted: false,
      };
    }
  }

  return null;
}

class Config {
  constructor() {
    this.configDir = path.join(os.homedir(), '.ushagent');
    this.configPath = path.join(this.configDir, 'config.json');
    this.defaults = {
      provider: null,
      codexArgs: [],
      activeWorkspacePath: null,
      serviceWorkspacePath: null,
      serviceName: null,
      workspaces: {},
      telegramBotToken: null,
      telegramBotUsername: null,
      telegramBotId: null,
      telegramChatId: null,
      telegramChatUserId: null,
      telegramControlPanelMessageId: null,
      telegramControlPanelMessageIds: {},
      telegramUpdateCursor: 0,
      codexLastSessionId: null,
      telegramForum: {
        enabled: false,
        chatId: null,
        mainThreadId: null,
        topics: {},
      },
    };
    this._data = { ...this.defaults };
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.configPath)) {
        const fileData = JSON.parse(fs.readFileSync(this.configPath, 'utf8'));
        this._data = { ...this.defaults, ...fileData };
      }
    } catch (error) {
      console.error(`Failed to load config: ${error.message}`);
      this._data = { ...this.defaults };
    }

    return this._data;
  }

  save(newData = null) {
    if (newData) {
      this._data = { ...this._data, ...newData };
    }

    if (!fs.existsSync(this.configDir)) {
      fs.mkdirSync(this.configDir, { recursive: true });
    }

    const tempPath = `${this.configPath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tempPath, JSON.stringify(this._data, null, 2));
    fs.renameSync(tempPath, this.configPath);
    return this._data;
  }

  setMany(data) {
    return this.save(data);
  }

  set(key, value) {
    this._data[key] = value;
    return this.save();
  }

  get provider() {
    return this._data.provider ?? this.defaults.provider;
  }

  get codexArgs() {
    const value = this._data.codexArgs ?? this.defaults.codexArgs;
    return Array.isArray(value) ? value : [];
  }

  get telegramBotToken() {
    return this.getTelegramBotTokenInfo().token;
  }

  getTelegramBotTokenInfo() {
    const envOverride = readTelegramBotTokenOverride();
    if (envOverride) {
      return envOverride;
    }

    const token = this._data.telegramBotToken ?? this.defaults.telegramBotToken;
    return {
      token,
      source: token ? 'config' : null,
      persisted: Boolean(token),
    };
  }

  getStoredTelegramBotToken() {
    return this._data.telegramBotToken ?? this.defaults.telegramBotToken;
  }

  get telegramBotTokenSource() {
    return this.getTelegramBotTokenInfo().source;
  }

  get activeWorkspacePath() {
    return this._data.activeWorkspacePath ?? this.defaults.activeWorkspacePath;
  }

  get serviceWorkspacePath() {
    return this._data.serviceWorkspacePath ?? this.defaults.serviceWorkspacePath;
  }

  get serviceName() {
    return this._data.serviceName ?? this.defaults.serviceName;
  }

  get workspaces() {
    const value = this._data.workspaces ?? this.defaults.workspaces;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  get telegramBotUsername() {
    return this._data.telegramBotUsername ?? this.defaults.telegramBotUsername;
  }

  get telegramBotId() {
    return this._data.telegramBotId ?? this.defaults.telegramBotId;
  }

  get telegramChatId() {
    return this._data.telegramChatId ?? this.defaults.telegramChatId;
  }

  get telegramChatUserId() {
    return this._data.telegramChatUserId ?? this.defaults.telegramChatUserId;
  }

  get telegramUpdateCursor() {
    return this._data.telegramUpdateCursor ?? this.defaults.telegramUpdateCursor;
  }

  get telegramControlPanelMessageId() {
    const value = this._data.telegramControlPanelMessageId ?? this.defaults.telegramControlPanelMessageId;
    return Number.isInteger(value) ? value : null;
  }

  get telegramControlPanelMessageIds() {
    const value = this._data.telegramControlPanelMessageIds ?? this.defaults.telegramControlPanelMessageIds;
    return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
  }

  get codexLastSessionId() {
    return this._data.codexLastSessionId ?? this.defaults.codexLastSessionId;
  }

  get telegramForum() {
    const value = this._data.telegramForum ?? this.defaults.telegramForum;
    const topics =
      value?.topics && typeof value.topics === 'object' && !Array.isArray(value.topics) ? { ...value.topics } : {};
    return {
      enabled: value?.enabled === true,
      chatId: value?.chatId ?? null,
      mainThreadId: Number.isInteger(value?.mainThreadId) ? value.mainThreadId : null,
      topics,
    };
  }

  isPaired() {
    return Boolean(this.telegramBotToken && this.telegramChatId);
  }

  getWorkspace(workspacePath) {
    const key = String(workspacePath || '').trim();
    if (!key) {
      return null;
    }

    const record = this.workspaces[key];
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      return null;
    }

    return { ...record };
  }

  setWorkspace(workspacePath, patch = {}) {
    const key = String(workspacePath || '').trim();
    if (!key) {
      throw new Error('Workspace path is required.');
    }

    const current = this.getWorkspace(key) || {};
    const next = {
      ...current,
      ...patch,
    };

    return this.save({
      workspaces: {
        ...this.workspaces,
        [key]: next,
      },
    });
  }

  setActiveWorkspace(workspacePath) {
    const key = String(workspacePath || '').trim() || null;
    return this.save({
      activeWorkspacePath: key,
    });
  }

  clearPairing(options = {}) {
    const keepBotToken = options.keepBotToken !== false;

    this.save({
      telegramBotToken: keepBotToken ? this.getStoredTelegramBotToken() : null,
      telegramBotUsername: keepBotToken ? this._data.telegramBotUsername ?? this.defaults.telegramBotUsername : null,
      telegramBotId: keepBotToken ? this._data.telegramBotId ?? this.defaults.telegramBotId : null,
      telegramChatId: null,
      telegramChatUserId: null,
      telegramControlPanelMessageId: null,
      telegramControlPanelMessageIds: {},
      telegramUpdateCursor: 0,
      codexLastSessionId: null,
      telegramForum: this.defaults.telegramForum,
    });
  }

  resetAll() {
    this._data = { ...this.defaults };

    if (fs.existsSync(this.configPath)) {
      fs.unlinkSync(this.configPath);
    }

    return this._data;
  }

  getTelegramControlPanelMessageId(slotKey = 'default') {
    const key = String(slotKey || 'default').trim() || 'default';
    const mapped = this.telegramControlPanelMessageIds[key];
    if (Number.isInteger(mapped)) {
      return mapped;
    }

    return key === 'default' ? this.telegramControlPanelMessageId : null;
  }

  setTelegramControlPanelMessageId(slotKey = 'default', messageId = null) {
    const key = String(slotKey || 'default').trim() || 'default';
    const next = { ...this.telegramControlPanelMessageIds };

    if (Number.isInteger(messageId)) {
      next[key] = messageId;
    } else {
      delete next[key];
    }

    return this.save({
      telegramControlPanelMessageId: key === 'default' ? (Number.isInteger(messageId) ? messageId : null) : this.telegramControlPanelMessageId,
      telegramControlPanelMessageIds: next,
    });
  }

  setTelegramForum(data = {}) {
    const current = this.telegramForum;
    const next = {
      ...current,
      ...data,
      topics:
        data.topics && typeof data.topics === 'object' && !Array.isArray(data.topics)
          ? { ...data.topics }
          : current.topics,
    };

    return this.save({
      telegramForum: next,
    });
  }

  setTelegramTopic(topicKey, topicRecord = {}) {
    const key = String(topicKey || '').trim();
    if (!key) {
      throw new Error('Telegram topic key is required.');
    }

    const current = this.telegramForum;
    return this.setTelegramForum({
      ...current,
      topics: {
        ...current.topics,
        [key]: {
          ...(current.topics[key] || {}),
          ...topicRecord,
        },
      },
    });
  }
}

export default Config;
