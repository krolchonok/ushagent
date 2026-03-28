import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { formatCodexSessionList, getCodexSessionTranscript, listCodexSessions } from '../src/providers/codex-session-store.js';

function writeSessionFixture(sessionId, cwd, entries) {
  const sessionDir = path.join(os.homedir(), '.codex', 'sessions', '2099', '11', '30');
  mkdirSync(sessionDir, { recursive: true });
  const filePath = path.join(sessionDir, `rollout-2099-11-30T12-00-00-${sessionId}.jsonl`);
  const lines = [
    JSON.stringify({
      timestamp: '2099-11-30T12:00:00.000Z',
      type: 'session_meta',
      payload: {
        id: sessionId,
        timestamp: '2099-11-30T12:00:00.000Z',
        cwd,
        model: 'gpt-5-codex',
      },
    }),
    ...entries.map(entry => JSON.stringify(entry)),
  ];
  writeFileSync(filePath, `${lines.join('\n')}\n`);
  return filePath;
}

test('listCodexSessions includes a preview of the latest transcript message', () => {
  const cwd = '/tmp/codex-session-preview';
  const filePath = writeSessionFixture('session-preview', cwd, [
    {
      timestamp: '2099-11-30T12:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'status' }],
      },
    },
  ]);

  try {
    const sessions = listCodexSessions({
      cwd,
      limit: 10,
    });

    const session = sessions.find(item => item.id === 'session-preview');
    assert.ok(session);
    assert.equal(session.preview, 'User: status');
  } finally {
    rmSync(filePath, { force: true });
  }
});

test('formatCodexSessionList renders session preview on its own line', () => {
  const text = formatCodexSessionList(
    [
      {
        id: 'session-preview',
        timestamp: '2099-11-30T12:00:00.000Z',
        cwd: '/tmp/codex-session-preview',
        model: null,
        preview: 'User: status',
      },
    ],
    {
      cwd: '/tmp/codex-session-preview',
    }
  );

  assert.match(text, /1\. session-preview/);
  assert.match(text, /User: status/);
});

test('getCodexSessionTranscript reads user and assistant messages from session file', () => {
  const cwd = '/tmp/codex-session-transcript';
  const filePath = writeSessionFixture('session-transcript', cwd, [
    {
      timestamp: '2099-11-30T12:00:01.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'status' }],
      },
    },
    {
      timestamp: '2099-11-30T12:00:02.000Z',
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        phase: 'final_answer',
        content: [{ type: 'output_text', text: 'main | status' }],
      },
    },
  ]);

  try {
    const transcript = getCodexSessionTranscript({
      sessionId: 'session-transcript',
      limit: 10,
    });

    assert.equal(transcript.entries.length, 2);
    assert.equal(transcript.entries[0].role, 'user');
    assert.equal(transcript.entries[0].text, 'status');
    assert.equal(transcript.entries[1].role, 'assistant');
    assert.equal(transcript.entries[1].text, 'main | status');
  } finally {
    rmSync(filePath, { force: true });
  }
});
