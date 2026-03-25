import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

function quoteWindowsArgument(value) {
  const normalized = String(value ?? '');
  if (/^[A-Za-z0-9_./\\:=+-]+$/.test(normalized)) {
    return normalized;
  }
  return `"${normalized.replace(/"/g, '""')}"`;
}

export function resolveProcessSpawn(command, args = []) {
  const normalizedCommand = String(command || '').trim();
  const normalizedArgs = Array.isArray(args) ? [...args] : [];

  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(normalizedCommand)) {
    const shellCommand = [normalizedCommand, ...normalizedArgs].map(quoteWindowsArgument).join(' ');
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', shellCommand],
    };
  }

  return {
    command: normalizedCommand,
    args: normalizedArgs,
  };
}

export function runProcess(command, args, options = {}) {
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const cwd = options.cwd || process.cwd();
  const signal = options.signal || null;
  const input = options.input === undefined || options.input === null ? null : String(options.input);
  const onStdoutChunk = typeof options.onStdoutChunk === 'function' ? options.onStdoutChunk : null;
  const onStderrChunk = typeof options.onStderrChunk === 'function' ? options.onStderrChunk : null;
  const spawnTarget = resolveProcessSpawn(command, args);

  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let completed = false;

    const child = spawn(spawnTarget.command, spawnTarget.args, {
      cwd,
      env: process.env,
      stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let timeout = null;

    const onAbort = () => {
      if (completed) {
        return;
      }

      completed = true;
      clearTimeout(timeout);
      child.kill('SIGTERM');
      reject(new Error(`${command} aborted`));
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    timeout = setTimeout(() => {
      if (completed) {
        return;
      }
      completed = true;
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      child.kill('SIGTERM');
      reject(new Error(`${command} timed out after ${Math.floor(timeoutMs / 1000)} seconds`));
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      const text = chunk.toString();
      stdout += text;
      if (onStdoutChunk) {
        onStdoutChunk(text);
      }
    });

    child.stderr.on('data', chunk => {
      const text = chunk.toString();
      stderr += text;
      if (onStderrChunk) {
        onStderrChunk(text);
      }
    });

    if (input !== null && child.stdin) {
      child.stdin.on('error', () => {
        // Ignore EPIPE and early-close cases from child exit.
      });
      child.stdin.end(input);
    }

    child.on('error', error => {
      if (completed) {
        return;
      }
      completed = true;
      clearTimeout(timeout);
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      reject(error);
    });

    child.on('close', code => {
      if (completed) {
        return;
      }
      completed = true;
      clearTimeout(timeout);
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}
