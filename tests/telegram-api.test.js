import assert from 'node:assert/strict';
import test from 'node:test';
import { TelegramApi, formatTelegramHtml } from '../src/telegram-api.js';

test('formatTelegramHtml converts inline and fenced code to Telegram HTML', () => {
  const formatted = formatTelegramHtml([
    'Use `npm install` first.',
    '',
    '```js',
    'console.log("ok");',
    '```',
  ].join('\n'));

  assert.match(formatted, /Use <code>npm install<\/code> first\./);
  assert.match(formatted, /<pre><code class="language-js">console\.log\("ok"\);\n<\/code><\/pre>/);
});

test('sendMessage uses HTML parse mode for Telegram formatting', async () => {
  const api = new TelegramApi('123456:token_token_token_token');
  let request = null;
  api.bot = {
    sendMessage: async (chatId, text, options) => {
      request = { chatId, text, options };
      return { message_id: 1 };
    },
  };

  await api.sendMessage('chat-1', 'Run `npm test`');

  assert.equal(request.chatId, 'chat-1');
  assert.equal(request.options.parse_mode, 'HTML');
  assert.match(request.text, /Run <code>npm test<\/code>/);
});

test('sendMessage includes message thread id when provided', async () => {
  const api = new TelegramApi('123456:token_token_token_token');
  let request = null;
  api.bot = {
    sendMessage: async (chatId, text, options) => {
      request = { chatId, text, options };
      return { message_id: 1 };
    },
  };

  await api.sendMessage('chat-1', 'Threaded', {
    messageThreadId: 321,
  });

  assert.equal(request.options.message_thread_id, 321);
});

test('setMyCommands passes normalized commands to Telegram', async () => {
  const api = new TelegramApi('123456:token_token_token_token');
  let request = null;
  api.bot = {
    setMyCommands: async commands => {
      request = commands;
      return true;
    },
  };

  await api.setMyCommands([
    { command: 'help', description: 'Show help' },
    { command: ' status ', description: ' Show status ' },
    { command: '', description: 'skip' },
  ]);

  assert.deepEqual(request, [
    { command: 'help', description: 'Show help' },
    { command: 'status', description: 'Show status' },
  ]);
});

test('createForumTopic delegates to Telegram bot API', async () => {
  const api = new TelegramApi('123456:token_token_token_token');
  let request = null;
  api.bot = {
    createForumTopic: async (chatId, name, options) => {
      request = { chatId, name, options };
      return { message_thread_id: 55, name };
    },
  };

  const result = await api.createForumTopic('chat-1', 'HOST: DESKTOP', {
    iconColor: 0x6fb9f0,
  });

  assert.equal(request.chatId, 'chat-1');
  assert.equal(request.name, 'HOST: DESKTOP');
  assert.equal(request.options.icon_color, 0x6fb9f0);
  assert.equal(result.message_thread_id, 55);
});

test('editMessageText does not send message thread id to Telegram', async () => {
  const api = new TelegramApi('123456:token_token_token_token');
  let request = null;
  api.bot = {
    editMessageText: async (text, options) => {
      request = { text, options };
      return { ok: true };
    },
  };

  await api.editMessageText('chat-1', 123, 'Updated text', {
    messageThreadId: 321,
    replyMarkup: { inline_keyboard: [[{ text: 'OK', callback_data: 'ok' }]] },
  });

  assert.equal(request.options.chat_id, 'chat-1');
  assert.equal(request.options.message_id, 123);
  assert.equal(request.options.message_thread_id, undefined);
  assert.deepEqual(request.options.reply_markup, {
    inline_keyboard: [[{ text: 'OK', callback_data: 'ok' }]],
  });
});
