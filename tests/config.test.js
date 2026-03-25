import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import test from 'node:test';
import Config from '../src/config.js';

test('Config stores telegram forum topic registry entries', () => {
  const tempHome = mkdtempSync(path.join(os.tmpdir(), 'ushagent-config-'));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;

  try {
    const config = new Config();

    config.setTelegramForum({
      enabled: true,
      chatId: 'chat-1',
      mainThreadId: 100,
    });
    config.setTelegramTopic('host:desktop', {
      threadId: 200,
      title: 'HOST: DESKTOP',
    });

    assert.equal(config.telegramForum.enabled, true);
    assert.equal(config.telegramForum.chatId, 'chat-1');
    assert.equal(config.telegramForum.mainThreadId, 100);
    assert.deepEqual(config.telegramForum.topics['host:desktop'], {
      threadId: 200,
      title: 'HOST: DESKTOP',
    });
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
    rmSync(tempHome, { recursive: true, force: true });
  }
});

test('Config resetAll removes persisted config file and restores defaults', () => {
  const tempHome = mkdtempSync(path.join(os.tmpdir(), 'ushagent-config-'));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;

  try {
    const config = new Config();

    config.setMany({
      provider: 'codex',
      telegramChatId: 'chat-1',
      telegramBotUsername: 'bot',
    });

    assert.equal(existsSync(config.configPath), true);

    config.resetAll();

    assert.equal(existsSync(config.configPath), false);
    assert.equal(config.provider, null);
    assert.equal(config.telegramChatId, null);
    assert.equal(config.telegramBotUsername, null);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
    rmSync(tempHome, { recursive: true, force: true });
  }
});
