import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import test from 'node:test';
import Config from '../src/config.js';
import { applyClientBootstrapBundle, createClientBootstrapBundle, parseClientBootstrapBundle } from '../src/client-bootstrap.js';

test('client bootstrap bundle round-trips forum config', () => {
  const tempHome = mkdtempSync(path.join(os.tmpdir(), 'ushagent-config-'));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;

  try {
    const config = new Config();
    config.setMany({
      provider: 'codex',
      codexArgs: ['--dangerously-bypass-approvals-and-sandbox'],
      telegramBotToken: '123456:token_token_token_token',
      telegramBotUsername: 'forumbot',
      telegramBotId: '123456',
      telegramChatId: '-1001',
    });
    config.setTelegramForum({
      enabled: true,
      chatId: '-1001',
      mainThreadId: 10,
      topics: {
        main: {
          threadId: 10,
          title: 'MAIN',
          kind: 'main',
        },
      },
    });

    const bundle = createClientBootstrapBundle(config);
    const parsed = parseClientBootstrapBundle(bundle);

    assert.equal(parsed.mode, 'forum');
    assert.equal(parsed.chatId, '-1001');
    assert.deepEqual(parsed.providerArgs, ['--dangerously-bypass-approvals-and-sandbox']);
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

test('applyClientBootstrapBundle stores forum bootstrap in config', () => {
  const tempHome = mkdtempSync(path.join(os.tmpdir(), 'ushagent-config-'));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;

  try {
    const sourceConfig = new Config();
    sourceConfig.setMany({
      provider: 'codex',
      codexArgs: ['--dangerously-bypass-approvals-and-sandbox'],
      telegramBotToken: '123456:token_token_token_token',
      telegramBotUsername: 'forumbot',
      telegramBotId: '123456',
      telegramChatId: '-1001',
    });
    sourceConfig.setTelegramForum({
      enabled: true,
      chatId: '-1001',
      mainThreadId: 10,
      topics: {},
    });

    const bundle = createClientBootstrapBundle(sourceConfig);
    const targetConfig = new Config();
    const parsed = applyClientBootstrapBundle(targetConfig, bundle, {
      botToken: '654321:new_token_token_token',
    });

    assert.equal(parsed.chatId, '-1001');
    assert.equal(targetConfig.telegramChatId, '-1001');
    assert.equal(targetConfig.getStoredTelegramBotToken(), '654321:new_token_token_token');
    assert.equal(targetConfig.telegramBotUsername, null);
    assert.equal(targetConfig.telegramForum.enabled, false);
    assert.deepEqual(targetConfig.codexArgs, ['--dangerously-bypass-approvals-and-sandbox']);
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
