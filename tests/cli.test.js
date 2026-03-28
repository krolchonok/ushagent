import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

test('join-client validates invalid bundle before prompting for token', () => {
  const tempHome = mkdtempSync(path.join(os.tmpdir(), 'ushagent-cli-home-'));
  const result = spawnSync(process.execPath, ['./bin/hey.js', 'join-client', '--bundle', 'invalid'], {
    cwd: '/home/krol/ushagent',
    env: {
      ...process.env,
      HOME: tempHome,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Bootstrap bundle is invalid\./);
  assert.doesNotMatch(result.stderr, /Missing required --token value/);
});
