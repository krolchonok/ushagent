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
