import assert from 'node:assert/strict';
import test from 'node:test';
import { buildServiceUnit, getServiceDefinition } from '../src/service-manager.js';

function normalizeSlashes(value) {
  return String(value || '').replace(/\\/g, '/');
}

test('getServiceDefinition creates a stable service name for a workspace', () => {
  const definition = getServiceDefinition({
    workspacePath: '/root/ushagent',
    commandPath: '/usr/bin/ushagent',
    provider: 'codex',
    providerArgs: ['--model', 'gpt-5-codex'],
  });

  assert.equal(definition.serviceName, 'ushagent-codex.service');
  assert.match(normalizeSlashes(definition.servicePath), /\/\.config\/systemd\/user\/ushagent-codex\.service$/);
});

test('buildServiceUnit renders a usable systemd unit for ushagent', () => {
  const definition = getServiceDefinition({
    workspacePath: '/root/ushagent',
    commandPath: '/usr/bin/ushagent',
    provider: 'codex',
    providerArgs: ['--model', 'gpt-5-codex'],
  });

  const unit = buildServiceUnit(definition);
  const normalizedUnit = normalizeSlashes(unit);

  assert.match(unit, /\[Unit\]/);
  assert.match(unit, /Description=UshAgent codex background bridge/);
  assert.match(normalizedUnit, /WorkingDirectory=.*root\/+ushagent/);
  assert.match(normalizedUnit, /ExecStart=.*usr\/+bin\/+ushagent.* codex --model gpt-5-codex/);
  assert.match(unit, /Restart=always/);
  assert.match(unit, /WantedBy=default.target/);
});
