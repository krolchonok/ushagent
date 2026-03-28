import assert from 'node:assert/strict';
import test from 'node:test';
import Logger from '../src/logger.js';

test('Logger writes to console when USHAGENT_CONSOLE_LOGS is enabled', () => {
  const previous = process.env.USHAGENT_CONSOLE_LOGS;
  process.env.USHAGENT_CONSOLE_LOGS = '1';

  try {
    const logger = new Logger('test');
    const written = [];
    logger.writeToConsole = entry => {
      written.push(entry);
    };
    logger.writeToFile = async () => {};

    logger.log('info', 'hello');

    assert.equal(written.length, 1);
    assert.match(written[0], /\[INFO\] \[test\] hello/);
  } finally {
    if (previous === undefined) {
      delete process.env.USHAGENT_CONSOLE_LOGS;
    } else {
      process.env.USHAGENT_CONSOLE_LOGS = previous;
    }
  }
});

test('Logger skips console output when USHAGENT_CONSOLE_LOGS is disabled', () => {
  const previous = process.env.USHAGENT_CONSOLE_LOGS;
  process.env.USHAGENT_CONSOLE_LOGS = '0';

  try {
    const logger = new Logger('test');
    let called = false;
    logger.writeToConsole = () => {
      called = true;
    };
    logger.writeToFile = async () => {};

    logger.log('info', 'hello');

    assert.equal(called, false);
  } finally {
    if (previous === undefined) {
      delete process.env.USHAGENT_CONSOLE_LOGS;
    } else {
      process.env.USHAGENT_CONSOLE_LOGS = previous;
    }
  }
});
