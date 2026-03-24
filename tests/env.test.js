import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { loadUshAgentEnv, parseDotEnv } from '../src/env.js';
import Config from '../src/config.js';

test('parseDotEnv parses plain and quoted values', () => {
  const parsed = parseDotEnv(`
    # comment
    USHAGENT_TELEGRAM_BOT_TOKEN=123:plain
    export TELEGRAM_BOT_TOKEN="456:quoted"
  `);

  assert.equal(parsed.USHAGENT_TELEGRAM_BOT_TOKEN, '123:plain');
  assert.equal(parsed.TELEGRAM_BOT_TOKEN, '456:quoted');
});

test('loadUshAgentEnv loads .env values without overriding existing process env', () => {
  const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ushagent-env-'));
  const envPath = path.join(tmpDir, '.env');
  const previousValue = process.env.USHAGENT_TELEGRAM_BOT_TOKEN;
  process.env.USHAGENT_TELEGRAM_BOT_TOKEN = 'already-set';

  try {
    writeFileSync(envPath, 'USHAGENT_TELEGRAM_BOT_TOKEN=from-file\nTELEGRAM_BOT_TOKEN=secondary\n');
    const result = loadUshAgentEnv({ envPath });

    assert.equal(result.loaded, true);
    assert.equal(process.env.USHAGENT_TELEGRAM_BOT_TOKEN, 'already-set');
    assert.equal(process.env.TELEGRAM_BOT_TOKEN, 'secondary');
  } finally {
    if (previousValue === undefined) {
      delete process.env.USHAGENT_TELEGRAM_BOT_TOKEN;
    } else {
      process.env.USHAGENT_TELEGRAM_BOT_TOKEN = previousValue;
    }
    delete process.env.TELEGRAM_BOT_TOKEN;
  }
});

test('Config prefers env telegram token over stored config token', () => {
  const previousEnv = process.env.USHAGENT_TELEGRAM_BOT_TOKEN;
  process.env.USHAGENT_TELEGRAM_BOT_TOKEN = '123456:env-token';

  try {
    const config = new Config();
    config._data.telegramBotToken = '123456:stored-token';

    const tokenInfo = config.getTelegramBotTokenInfo();
    assert.equal(tokenInfo.token, '123456:env-token');
    assert.equal(tokenInfo.source, 'env:USHAGENT_TELEGRAM_BOT_TOKEN');
    assert.equal(tokenInfo.persisted, false);
  } finally {
    if (previousEnv === undefined) {
      delete process.env.USHAGENT_TELEGRAM_BOT_TOKEN;
    } else {
      process.env.USHAGENT_TELEGRAM_BOT_TOKEN = previousEnv;
    }
  }
});
