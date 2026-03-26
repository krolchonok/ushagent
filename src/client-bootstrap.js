import os from 'node:os';

const CLIENT_BUNDLE_VERSION = 1;
const CLIENT_BUNDLE_MODE_FORUM = 'forum';

function encodeBase64Url(value) {
  return Buffer.from(String(value || ''), 'utf8').toString('base64url');
}

function decodeBase64Url(value) {
  return Buffer.from(String(value || '').trim(), 'base64url').toString('utf8');
}

function normalizeProviderArgs(providerArgs) {
  return Array.isArray(providerArgs) ? providerArgs.map(value => String(value || '').trim()).filter(Boolean) : [];
}

export function createClientBootstrapBundle(config) {
  const chatId = String(config?.telegramChatId || '').trim();
  const forum = config?.telegramForum;

  if (!chatId) {
    throw new Error('Telegram chat is not paired yet.');
  }

  if (forum?.enabled !== true || String(forum?.chatId || '').trim() !== chatId) {
    throw new Error('addclient currently supports only forum-mode chats.');
  }

  const issuedAt = new Date().toISOString();
  const payload = {
    version: CLIENT_BUNDLE_VERSION,
    mode: CLIENT_BUNDLE_MODE_FORUM,
    chatId,
    provider: String(config?.provider || 'codex').trim() || 'codex',
    providerArgs: normalizeProviderArgs(config?.codexArgs),
    issuedAt,
    issuerHost: os.hostname(),
  };

  return encodeBase64Url(JSON.stringify(payload));
}

export function parseClientBootstrapBundle(bundle) {
  const normalized = String(bundle || '').trim();
  if (!normalized) {
    throw new Error('Bootstrap bundle is required.');
  }

  let payload = null;
  try {
    payload = JSON.parse(decodeBase64Url(normalized));
  } catch {
    throw new Error('Bootstrap bundle is invalid.');
  }

  if (payload?.version !== CLIENT_BUNDLE_VERSION) {
    throw new Error(`Unsupported bootstrap bundle version: ${payload?.version ?? 'unknown'}`);
  }

  if (String(payload?.mode || '').trim() !== CLIENT_BUNDLE_MODE_FORUM) {
    throw new Error('Only forum-mode bootstrap bundles are supported.');
  }

  const chatId = String(payload?.chatId || '').trim();
  if (!chatId) {
    throw new Error('Bootstrap bundle is missing required fields.');
  }

  return {
    version: CLIENT_BUNDLE_VERSION,
    mode: CLIENT_BUNDLE_MODE_FORUM,
    chatId,
    provider: String(payload?.provider || 'codex').trim() || 'codex',
    providerArgs: normalizeProviderArgs(payload?.providerArgs),
    issuedAt: String(payload?.issuedAt || '').trim() || null,
    issuerHost: String(payload?.issuerHost || '').trim() || null,
  };
}

export function applyClientBootstrapBundle(config, bundle, options = {}) {
  const parsed = parseClientBootstrapBundle(bundle);
  const botToken = String(options.botToken || '').trim();

  if (!botToken) {
    throw new Error('Telegram bot token is required.');
  }

  config.clearPairing({ keepBotToken: false });
  config.setMany({
    provider: parsed.provider,
    codexArgs: parsed.provider === 'codex' ? parsed.providerArgs : config.codexArgs,
    telegramBotToken: botToken,
    telegramBotUsername: null,
    telegramBotId: null,
    telegramChatId: parsed.chatId,
    telegramChatUserId: null,
    telegramUpdateCursor: 0,
    telegramForum: {
      enabled: false,
      chatId: null,
      mainThreadId: null,
      topics: {},
    },
    telegramControlPanelMessageId: null,
    telegramControlPanelMessageIds: {},
  });

  return parsed;
}
