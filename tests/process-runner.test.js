import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveProcessSpawn, runProcess } from '../src/process-runner.js';

test('resolveProcessSpawn uses cmd.exe for Windows cmd wrappers', () => {
  const originalPlatform = process.platform;
  const originalComSpec = process.env.ComSpec;

  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: 'win32',
  });
  process.env.ComSpec = 'C:\\Windows\\System32\\cmd.exe';

  try {
    const resolved = resolveProcessSpawn('codex.cmd', ['exec', '--json', '--', 'hello world']);
    assert.equal(resolved.command, 'C:\\Windows\\System32\\cmd.exe');
    assert.deepEqual(resolved.args, ['/d', '/s', '/c', 'codex.cmd exec --json -- "hello world"']);
  } finally {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform,
    });

    if (originalComSpec === undefined) {
      delete process.env.ComSpec;
    } else {
      process.env.ComSpec = originalComSpec;
    }
  }
});

test('resolveProcessSpawn preserves embedded quotes for cmd.exe arguments', () => {
  const originalPlatform = process.platform;

  Object.defineProperty(process, 'platform', {
    configurable: true,
    value: 'win32',
  });

  try {
    const resolved = resolveProcessSpawn('codex.cmd', ['exec', 'say', 'a "quoted" value']);
    assert.equal(resolved.args[3], 'codex.cmd exec say "a ""quoted"" value"');
  } finally {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      value: originalPlatform,
    });
  }
});

test('runProcess allows disabling timeout with timeoutMs zero', async () => {
  const result = await runProcess(process.execPath, ['-e', 'setTimeout(() => process.stdout.write("ok"), 25)'], {
    timeoutMs: 0,
  });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'ok');
});
