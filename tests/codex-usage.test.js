import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchCodexUsage, formatCodexUsage, parseUsageText } from '../src/providers/codex-usage.js';

test('parseUsageText extracts remaining percent and weekly warning', () => {
  const parsed = parseUsageText(`
    gpt-5.4 medium · 100% left · ~/ushagent
    Heads up, you have less than 10% of your weekly limit left. Run /status for a breakdown.
  `);

  assert.equal(parsed.remainingPercent, '100%');
  assert.equal(parsed.weeklyWarning, true);
  assert.equal(parsed.model, 'gpt-5.4 medium');
});

test('formatCodexUsage renders a readable usage summary', () => {
  const text = formatCodexUsage({
    ok: true,
    planType: 'plus',
    codexLimit: {
      id: 'codex',
      name: 'Codex',
      primaryWindow: {
        label: '5h',
        remainingPercent: 81,
        resetInText: '3h 52m',
      },
      secondaryWindow: {
        label: 'week',
        remainingPercent: 9,
        resetInText: '5d 4h',
      },
    },
    codeReviewLimit: null,
    credits: null,
  });

  assert.match(text, /Plan: plus/);
  assert.match(text, /Codex 5h: 81% left/);
  assert.match(text, /Codex week: 9% left/);
});

test('fetchCodexUsage returns unavailable snapshot on auth failure', async () => {
  const snapshot = await fetchCodexUsage({
    authPath: '/definitely/missing/auth.json',
  });

  assert.equal(snapshot.ok, false);
  assert.match(snapshot.error, /ENOENT|no such file/i);
});
