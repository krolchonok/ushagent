import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function ensureLinux() {
  if (process.platform !== 'linux') {
    throw new Error('Service management is currently supported on Linux only.');
  }
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: 'pipe',
    ...options,
  });

  return {
    ok: result.status === 0,
    status: result.status,
    stdout: String(result.stdout || '').trim(),
    stderr: String(result.stderr || '').trim(),
    error: result.error || null,
  };
}

function sanitizeSegment(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'project';
}

function quoteSystemdArg(value) {
  const normalized = String(value ?? '');
  if (/^[A-Za-z0-9_./:=+-]+$/.test(normalized)) {
    return normalized;
  }

  return `"${normalized.replace(/(["\\$`])/g, '\\$1')}"`;
}

function systemdEscapeEnvValue(value) {
  return String(value ?? '').replace(/(["\\])/g, '\\$1');
}

function makeServiceName(workspacePath, provider = 'codex') {
  const normalizedProvider = sanitizeSegment(provider);
  if (normalizedProvider === 'codex') {
    return 'ushagent-codex.service';
  }

  const base = sanitizeSegment(path.basename(workspacePath) || workspacePath);
  const hash = crypto.createHash('sha1').update(`${provider}:${workspacePath}`).digest('hex').slice(0, 8);
  return `ushagent-${normalizedProvider}-${base}-${hash}.service`;
}

function getUserServiceDir() {
  return path.join(os.homedir(), '.config', 'systemd', 'user');
}

function getServiceDefinition(options = {}) {
  const workspacePath = path.resolve(String(options.workspacePath || os.homedir()).trim() || os.homedir());
  const provider = String(options.provider || 'codex').trim() || 'codex';
  const providerArgs = Array.isArray(options.providerArgs) ? [...options.providerArgs] : [];
  const commandPath = path.resolve(String(options.commandPath || process.argv[1] || '').trim() || process.argv[1]);
  const serviceName = makeServiceName(workspacePath, provider);
  const serviceDir = getUserServiceDir();
  const servicePath = path.join(serviceDir, serviceName);
  return {
    workspacePath,
    provider,
    providerArgs,
    commandPath,
    serviceName,
    serviceDir,
    servicePath,
  };
}

function buildExecStart(definition) {
  const commandPath = path.resolve(String(definition.commandPath || process.argv[1] || '').trim() || process.argv[1]);
  const args = [process.execPath, commandPath, definition.provider, ...definition.providerArgs];
  return args.map(quoteSystemdArg).join(' ');
}

function buildServiceUnit(definition) {
  const envPath = path.join(definition.workspacePath, '.env');
  const lines = [
    '[Unit]',
    `Description=UshAgent ${definition.provider} background bridge`,
    'Wants=network-online.target',
    'After=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${quoteSystemdArg(definition.workspacePath)}`,
    `ExecStart=${buildExecStart(definition)}`,
    `Environment=PATH="${systemdEscapeEnvValue(process.env.PATH || '')}"`,
    `Environment=HOME="${systemdEscapeEnvValue(os.homedir())}"`,
  ];

  if (fs.existsSync(envPath)) {
    lines.push(`Environment=USHAGENT_ENV_FILE="${systemdEscapeEnvValue(envPath)}"`);
  }

  lines.push(
    'Restart=always',
    'RestartSec=5',
    '',
    '[Install]',
    'WantedBy=default.target',
    ''
  );

  return lines.join('\n');
}

function requireSystemctlUser() {
  const probe = runCommand('systemctl', ['--user', '--version']);
  if (!probe.ok && probe.error) {
    throw new Error(`systemctl is unavailable: ${probe.error.message}`);
  }
  if (!probe.ok) {
    throw new Error(probe.stderr || 'systemctl --user is unavailable in this environment.');
  }
}

function systemctlUser(args) {
  const result = runCommand('systemctl', ['--user', ...args]);
  if (!result.ok) {
    const details = result.stderr || result.stdout || `systemctl exited with code ${result.status ?? 'unknown'}`;
    throw new Error(details);
  }
  return result;
}

function systemctlUserSoft(args) {
  return runCommand('systemctl', ['--user', ...args]);
}

function setLingerEnabled(enabled) {
  const username = os.userInfo().username;
  const result = runCommand('loginctl', [enabled ? 'enable-linger' : 'disable-linger', username]);
  if (!result.ok) {
    const details = result.stderr || result.stdout || `loginctl exited with code ${result.status ?? 'unknown'}`;
    throw new Error(details);
  }
}

function installUserService(options = {}) {
  ensureLinux();
  requireSystemctlUser();

  const definition = getServiceDefinition(options);
  fs.mkdirSync(definition.serviceDir, { recursive: true });
  fs.writeFileSync(definition.servicePath, buildServiceUnit(definition), 'utf8');

  systemctlUser(['daemon-reload']);

  if (options.enableAtStartup !== false) {
    systemctlUser(['enable', definition.serviceName]);
  }

  if (options.startNow === true) {
    systemctlUser(['restart', definition.serviceName]);
  }

  if (options.enableLinger === true) {
    setLingerEnabled(true);
  }

  return definition;
}

function removeUserService(options = {}) {
  ensureLinux();
  requireSystemctlUser();

  const definition = getServiceDefinition(options);
  if (fs.existsSync(definition.servicePath)) {
    systemctlUserSoft(['disable', '--now', definition.serviceName]);
    fs.unlinkSync(definition.servicePath);
    systemctlUser(['daemon-reload']);
    systemctlUserSoft(['reset-failed', definition.serviceName]);
  }

  if (options.disableLinger === true) {
    setLingerEnabled(false);
  }

  return definition;
}

function getUserServiceStatus(options = {}) {
  ensureLinux();
  const definition = getServiceDefinition(options);

  const exists = fs.existsSync(definition.servicePath);
  const active = systemctlUserSoft(['is-active', definition.serviceName]);
  const enabled = systemctlUserSoft(['is-enabled', definition.serviceName]);

  return {
    ...definition,
    exists,
    active: active.ok ? active.stdout || 'active' : active.stdout || active.stderr || 'inactive',
    enabled: enabled.ok ? enabled.stdout || 'enabled' : enabled.stdout || enabled.stderr || 'disabled',
  };
}

export {
  buildServiceUnit,
  getServiceDefinition,
  getUserServiceStatus,
  installUserService,
  removeUserService,
};
