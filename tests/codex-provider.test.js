import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCodexArgs, getCodexCommand, parseCodexProgressEvent } from '../src/providers/codex-provider.js';

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

test('parseCodexProgressEvent extracts commentary progress and session ids', () => {
  const session = parseCodexProgressEvent('{"type":"thread.started","thread_id":"sess-1"}');
  assert.deepEqual(session, { kind: 'session', sessionId: 'sess-1' });

  const progress = parseCodexProgressEvent(
    '{"type":"event_msg","payload":{"type":"agent_message","message":"Inspecting files","phase":"commentary"}}'
  );
  assert.deepEqual(progress, {
    kind: 'progress',
    text: 'Inspecting files',
    phase: 'commentary',
  });

  const tool = parseCodexProgressEvent('{"type":"response_item","payload":{"type":"function_call","name":"shell_command"}}');
  assert.deepEqual(tool, {
    kind: 'tool',
    text: 'Running shell_command',
  });
});
