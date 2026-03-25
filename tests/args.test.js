import assert from 'node:assert/strict';
import test from 'node:test';
import { applyDefaultBypassArgs, sanitizeProviderArgs } from '../src/args.js';

test('sanitizeProviderArgs drops invalid codex model placeholder values', () => {
  assert.deepEqual(sanitizeProviderArgs('codex', ['--model', '\\']), []);
  assert.deepEqual(sanitizeProviderArgs('codex', ['--model=/']), []);
  assert.deepEqual(sanitizeProviderArgs('codex', ['--model', 'gpt-5']), ['--model', 'gpt-5']);
});

test('applyDefaultBypassArgs adds bypass after sanitizing invalid model values', () => {
  const result = applyDefaultBypassArgs('codex', ['--model', '\\']);
  assert.deepEqual(result.providerArgs, ['--dangerously-bypass-approvals-and-sandbox']);
  assert.equal(result.defaultBypassApplied, true);
});
