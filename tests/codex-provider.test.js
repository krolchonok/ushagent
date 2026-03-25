import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCodexArgs, getCodexCommand } from '../src/providers/codex-provider.js';

test('getCodexCommand selects the platform-appropriate Codex executable', () => {
  const expected = process.platform === 'win32' ? 'codex.cmd' : 'codex';
  assert.equal(getCodexCommand(), expected);
});

test('buildCodexArgs uses positional prompt for resume mode', () => {
  const args = buildCodexArgs('fix layout please', {
    resume: true,
    sessionId: 'session-123',
    extraArgs: ['--dangerously-bypass-approvals-and-sandbox'],
  });

  assert.deepEqual(args, [
    'exec',
    '--dangerously-bypass-approvals-and-sandbox',
    'resume',
    '--json',
    'session-123',
    '-',
  ]);
});

test('buildCodexArgs uses stdin token for new exec mode', () => {
  const args = buildCodexArgs('fix layout please', {
    resume: false,
    outputFile: 'C:\\temp\\last.txt',
  });

  assert.deepEqual(args, ['exec', '--json', '--output-last-message', 'C:\\temp\\last.txt', '-']);
});
