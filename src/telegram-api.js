import TelegramBot from 'node-telegram-bot-api';

const MAX_MESSAGE_CHUNK_SIZE = 3800;

function normalizeText(value) {
  const text = String(value ?? '')
    .replace(/\r\n/g, '\n')
    .trim();
  return text || 'No response.';
}

function splitMessage(text) {
  const normalized = normalizeText(text);
  if (normalized.length <= MAX_MESSAGE_CHUNK_SIZE) {
    return [normalized];
  }

  const chunks = [];
  let remaining = normalized;

  while (remaining.length > MAX_MESSAGE_CHUNK_SIZE) {
    let splitAt = remaining.lastIndexOf('\n', MAX_MESSAGE_CHUNK_SIZE);
    if (splitAt < 0 || splitAt < Math.floor(MAX_MESSAGE_CHUNK_SIZE / 2)) {
      splitAt = MAX_MESSAGE_CHUNK_SIZE;
    }

    const part = remaining.slice(0, splitAt).trim();
    if (part) {
      chunks.push(part);
    }
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatInlineCode(text) {
  return escapeHtml(text).replace(/`([^`\n]+)`/g, '<code>$1</code>');
}

function formatTelegramHtml(text) {
  const normalized = normalizeText(text);
  const parts = [];
  const codeBlockPattern = /```([a-zA-Z0-9_+-]*)\n?([\s\S]*?)```/g;
  let lastIndex = 0;

  for (const match of normalized.matchAll(codeBlockPattern)) {
    const matchIndex = Number.isInteger(match.index) ? match.index : -1;
    if (matchIndex < 0) {
      continue;
    }

    const plainText = normalized.slice(lastIndex, matchIndex);
    if (plainText) {
      parts.push(formatInlineCode(plainText));
    }

    const language = String(match[1] || '').trim();
    const code = escapeHtml(match[2] || '');
    if (language) {
      parts.push(`<pre><code class="language-${language}">${code}</code></pre>`);
    } else {
      parts.push(`<pre>${code}</pre>`);
    }

    lastIndex = matchIndex + match[0].length;
  }

  const tail = normalized.slice(lastIndex);
  if (tail) {
    parts.push(formatInlineCode(tail));
  }

  return parts.join('') || 'No response.';
}

function extractStatusCode(error) {
  if (typeof error?.response?.statusCode === 'number') {
    return error.response.statusCode;
  }

  const message = String(error?.message || '');
  const match = message.match(/\b(\d{3})\b/);
  return match ? Number(match[1]) : undefined;
}

class TelegramApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'TelegramApiError';
    this.status = status;
  }
}

function toTelegramError(error, fallbackMessage) {
  if (error instanceof TelegramApiError) {
    return error;
  }

  const status = extractStatusCode(error);
  const message = String(error?.message || fallbackMessage || 'Telegram request failed');
  return new TelegramApiError(message, status);
}

function parseFileSizeBytes(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

function parseDurationSec(value) {
  return Number.isFinite(value) ? Number(value) : null;
}

function extractAttachment(message) {
  const voice = message?.voice;
  if (typeof voice?.file_id === 'string' && voice.file_id.trim()) {
    return {
      kind: 'voice',
      fileId: voice.file_id.trim(),
      fileName: null,
      mimeType: typeof voice.mime_type === 'string' ? voice.mime_type : null,
      fileSizeBytes: parseFileSizeBytes(voice.file_size),
      durationSec: parseDurationSec(voice.duration),
    };
  }

  const audio = message?.audio;
  if (typeof audio?.file_id === 'string' && audio.file_id.trim()) {
    return {
      kind: 'audio',
      fileId: audio.file_id.trim(),
      fileName: typeof audio.file_name === 'string' ? audio.file_name : null,
      mimeType: typeof audio.mime_type === 'string' ? audio.mime_type : null,
      fileSizeBytes: parseFileSizeBytes(audio.file_size),
      durationSec: parseDurationSec(audio.duration),
    };
  }

  const document = message?.document;
  if (typeof document?.file_id === 'string' && document.file_id.trim()) {
    return {
      kind: 'document',
      fileId: document.file_id.trim(),
      fileName: typeof document.file_name === 'string' ? document.file_name : null,
      mimeType: typeof document.mime_type === 'string' ? document.mime_type : null,
      fileSizeBytes: parseFileSizeBytes(document.file_size),
      durationSec: null,
    };
  }

  const video = message?.video;
  if (typeof video?.file_id === 'string' && video.file_id.trim()) {
    return {
      kind: 'video',
      fileId: video.file_id.trim(),
      fileName: typeof video.file_name === 'string' ? video.file_name : null,
      mimeType: typeof video.mime_type === 'string' ? video.mime_type : null,
      fileSizeBytes: parseFileSizeBytes(video.file_size),
      durationSec: parseDurationSec(video.duration),
    };
  }

  const photos = Array.isArray(message?.photo) ? message.photo : [];
  for (let index = photos.length - 1; index >= 0; index -= 1) {
    const photo = photos[index];
    if (typeof photo?.file_id === 'string' && photo.file_id.trim()) {
      return {
        kind: 'photo',
        fileId: photo.file_id.trim(),
        fileName: null,
        mimeType: 'image/jpeg',
        fileSizeBytes: parseFileSizeBytes(photo.file_size),
        durationSec: null,
      };
    }
  }

  return null;
}

function normalizeMessage(update) {
  const message = update?.message;
  if (!message) {
    return null;
  }

  const text = typeof message.text === 'string' ? message.text.trim() : '';
  const caption = typeof message.caption === 'string' ? message.caption.trim() : '';
  const attachment = extractAttachment(message);

  if (!text && !caption && !attachment) {
    return null;
  }

  return {
    updateId: Number.isInteger(update.update_id) ? update.update_id : null,
    messageId: Number.isInteger(message.message_id) ? message.message_id : null,
    chatId: message.chat?.id === undefined || message.chat?.id === null ? null : String(message.chat.id),
    chatType: typeof message.chat?.type === 'string' ? message.chat.type : null,
    userId: message.from?.id === undefined || message.from?.id === null ? null : String(message.from.id),
    type: attachment ? attachment.kind : 'text',
    text,
    caption,
    fileId: attachment?.fileId || null,
    fileName: attachment?.fileName || null,
    mimeType: attachment?.mimeType || null,
    fileSizeBytes: attachment?.fileSizeBytes ?? null,
    durationSec: attachment?.durationSec ?? null,
  };
}

function normalizeCallbackQuery(update) {
  const callbackQuery = update?.callback_query;
  if (!callbackQuery) {
    return null;
  }

  const message = callbackQuery.message;
  return {
    updateId: Number.isInteger(update.update_id) ? update.update_id : null,
    callbackQueryId: typeof callbackQuery.id === 'string' ? callbackQuery.id : null,
    messageId: Number.isInteger(message?.message_id) ? message.message_id : null,
    chatId: message?.chat?.id === undefined || message?.chat?.id === null ? null : String(message.chat.id),
    chatType: typeof message?.chat?.type === 'string' ? message.chat.type : null,
    userId: callbackQuery.from?.id === undefined || callbackQuery.from?.id === null ? null : String(callbackQuery.from.id),
    type: 'callback',
    text: typeof callbackQuery.data === 'string' ? callbackQuery.data.trim() : '',
    data: typeof callbackQuery.data === 'string' ? callbackQuery.data.trim() : '',
    fileId: null,
    fileName: null,
    mimeType: null,
    fileSizeBytes: null,
    durationSec: null,
  };
}

class TelegramApi {
  constructor(token) {
    this.token = token;
    this.bot = new TelegramBot(token, { polling: false });
  }

  static isLikelyToken(token) {
    const normalized = String(token || '').trim();
    return /^\d{6,}:[A-Za-z0-9_-]{20,}$/.test(normalized);
  }

  async getMe() {
    try {
      return await this.bot.getMe();
    } catch (error) {
      throw toTelegramError(error, 'Failed to validate Telegram bot token');
    }
  }

  async ensurePollingMode() {
    try {
      await this.bot.deleteWebHook({
        drop_pending_updates: false,
      });
    } catch (error) {
      throw toTelegramError(error, 'Failed to switch Telegram bot to polling mode');
    }
  }

  async setMyCommands(commands = []) {
    const normalizedCommands = Array.isArray(commands)
      ? commands
          .map(command => ({
            command: String(command?.command || '').trim(),
            description: String(command?.description || '').trim(),
          }))
          .filter(command => command.command && command.description)
      : [];

    try {
      await this.bot.setMyCommands(normalizedCommands);
    } catch (error) {
      throw toTelegramError(error, 'Failed to register Telegram bot commands');
    }
  }

  async getUpdates(cursor, timeout = 20) {
    const opts = {
      timeout: Number.isFinite(timeout) ? Math.max(1, Math.min(50, timeout)) : 20,
      allowed_updates: ['message', 'callback_query'],
    };

    if (Number.isFinite(cursor) && cursor >= 0) {
      opts.offset = cursor + 1;
    }

    try {
      const updates = await this.bot.getUpdates(opts);
      let nextCursor = Number.isFinite(cursor) ? cursor : 0;
      const messages = [];

      for (const update of updates) {
        if (Number.isInteger(update.update_id) && update.update_id > nextCursor) {
          nextCursor = update.update_id;
        }

        const normalized = normalizeMessage(update);
        if (normalized) {
          messages.push(normalized);
          continue;
        }

        const normalizedCallback = normalizeCallbackQuery(update);
        if (normalizedCallback) {
          messages.push(normalizedCallback);
        }
      }

      return { messages, nextCursor };
    } catch (error) {
      throw toTelegramError(error, 'Failed to poll Telegram updates');
    }
  }

  async sendMessage(chatId, text, options = {}) {
    const targetChatId = String(chatId || '').trim();
    if (!targetChatId) {
      throw new TelegramApiError('Missing Telegram chat ID');
    }

    const chunks = splitMessage(text);
    try {
      let lastMessage = null;
      for (let index = 0; index < chunks.length; index += 1) {
        const chunk = chunks[index];
        const requestOptions = {
          parse_mode: 'HTML',
        };
        if (index === chunks.length - 1 && options.replyMarkup) {
          requestOptions.reply_markup = options.replyMarkup;
        }
        lastMessage = await this.bot.sendMessage(targetChatId, formatTelegramHtml(chunk), requestOptions);
      }
      return lastMessage;
    } catch (error) {
      throw toTelegramError(error, 'Failed to send Telegram message');
    }
  }

  async answerCallbackQuery(callbackQueryId, text = '') {
    const normalizedId = String(callbackQueryId || '').trim();
    if (!normalizedId) {
      throw new TelegramApiError('Missing Telegram callback query ID');
    }

    try {
      await this.bot.answerCallbackQuery(normalizedId, text ? { text } : {});
    } catch (error) {
      throw toTelegramError(error, 'Failed to answer Telegram callback query');
    }
  }

  async editMessageText(chatId, messageId, text, options = {}) {
    const targetChatId = String(chatId || '').trim();
    if (!targetChatId) {
      throw new TelegramApiError('Missing Telegram chat ID');
    }

    if (!Number.isInteger(messageId)) {
      throw new TelegramApiError('Missing Telegram message ID');
    }

    try {
      return await this.bot.editMessageText(formatTelegramHtml(text), {
        chat_id: targetChatId,
        message_id: messageId,
        parse_mode: 'HTML',
        reply_markup: options.replyMarkup || undefined,
      });
    } catch (error) {
      const message = String(error?.message || '');
      if (/message is not modified/i.test(message)) {
        return null;
      }
      throw toTelegramError(error, 'Failed to edit Telegram message');
    }
  }

  async downloadFile(fileId, downloadDir) {
    const normalizedFileId = String(fileId || '').trim();
    if (!normalizedFileId) {
      throw new TelegramApiError('Missing Telegram file ID');
    }

    const targetDir = String(downloadDir || '').trim();
    if (!targetDir) {
      throw new TelegramApiError('Missing download directory');
    }

    try {
      return await this.bot.downloadFile(normalizedFileId, targetDir);
    } catch (error) {
      throw toTelegramError(error, 'Failed to download Telegram file');
    }
  }
}

export { TelegramApi, TelegramApiError, formatTelegramHtml };
