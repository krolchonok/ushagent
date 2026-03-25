import crypto from 'node:crypto';
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
  const tokenInfo =
    typeof config?.getTelegramBotTokenInfo === 'function'
      ? config.getTelegramBotTokenInfo()
      : {
          token: String(config?.telegramBotToken || '').trim(),
        };
  const botToken = String(tokenInfo?.token || '').trim();
  const chatId = String(config?.telegramChatId || '').trim();
  const forum = config?.telegramForum;

  if (!botToken) {
    throw new Error('Telegram bot token is not configured.');
  }

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
    botToken,
    chatId,
    provider: String(config?.provider || 'codex').trim() || 'codex',
    providerArgs: normalizeProviderArgs(config?.codexArgs),
    botUsername: String(config?.telegramBotUsername || '').trim() || null,
    botId: config?.telegramBotId === undefined || config?.telegramBotId === null ? null : String(config.telegramBotId),
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

  const botToken = String(payload?.botToken || '').trim();
  const chatId = String(payload?.chatId || '').trim();
  if (!botToken || !chatId) {
    throw new Error('Bootstrap bundle is missing required fields.');
  }

  return {
    version: CLIENT_BUNDLE_VERSION,
    mode: CLIENT_BUNDLE_MODE_FORUM,
    botToken,
    chatId,
    provider: String(payload?.provider || 'codex').trim() || 'codex',
    providerArgs: normalizeProviderArgs(payload?.providerArgs),
    botUsername: String(payload?.botUsername || '').trim() || null,
    botId: payload?.botId === undefined || payload?.botId === null ? null : String(payload.botId),
    issuedAt: String(payload?.issuedAt || '').trim() || null,
    issuerHost: String(payload?.issuerHost || '').trim() || null,
  };
}

export function applyClientBootstrapBundle(config, bundle) {
  const parsed = parseClientBootstrapBundle(bundle);

  config.clearPairing({ keepBotToken: false });
  config.setMany({
    provider: parsed.provider,
    codexArgs: parsed.provider === 'codex' ? parsed.providerArgs : config.codexArgs,
    telegramBotToken: parsed.botToken,
    telegramBotUsername: parsed.botUsername,
    telegramBotId: parsed.botId,
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
