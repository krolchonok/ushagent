import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getPackedTarballPath } from './pack-utils.js';

function quoteWindowsArgument(value) {
  const normalized = String(value ?? '');
  if (/^[A-Za-z0-9_./\\:=+-]+$/.test(normalized)) {
    return normalized;
  }
  return `"${normalized.replace(/"/g, '\\"')}"`;
}

function runNpm(args, options = {}) {
  const result =
    process.platform === 'win32'
      ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm ${args.map(quoteWindowsArgument).join(' ')}`], {
          stdio: 'inherit',
          ...options,
        })
      : spawnSync('npm', args, {
          stdio: 'inherit',
          ...options,
        });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const rootDir = process.cwd();
const tarballPath = getPackedTarballPath(rootDir);
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ushagent-pack-test-'));

try {
  runNpm(['init', '-y'], { cwd: tempDir });
  runNpm(['install', tarballPath], { cwd: tempDir });
  runNpm(['exec', '--', 'ushagent', '--version'], { cwd: tempDir });
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
