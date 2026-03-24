import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { getPackedTarballPath } from './pack-utils.js';

function quoteWindowsArgument(value) {
  const normalized = String(value ?? '');
  if (/^[A-Za-z0-9_./\\:=+-]+$/.test(normalized)) {
    return normalized;
  }
  return `"${normalized.replace(/"/g, '\\"')}"`;
}

function runNpm(args, options = {}) {
  if (process.platform === 'win32') {
    return spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm ${args.map(quoteWindowsArgument).join(' ')}`], {
      stdio: 'inherit',
      ...options,
    });
  }

  return spawnSync('npm', args, {
    stdio: 'inherit',
    ...options,
  });
}

const rootDir = process.cwd();
const tarballPath = getPackedTarballPath(rootDir);
const relativeTarballPath = path.relative(rootDir, tarballPath) || path.basename(tarballPath);

const result = runNpm(['install', '-g', relativeTarballPath], {
  cwd: rootDir,
});

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
