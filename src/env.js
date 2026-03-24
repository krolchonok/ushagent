import fs from 'node:fs';
import path from 'node:path';

function parseDotEnv(content) {
  const result = {};
  const lines = String(content || '').split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const normalized = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const separatorIndex = normalized.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = normalized.slice(0, separatorIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      continue;
    }

    let value = normalized.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

export function loadUshAgentEnv(options = {}) {
  const cwd = String(options.cwd || process.cwd()).trim() || process.cwd();
  const envPath = String(process.env.USHAGENT_ENV_FILE || process.env.HEYAGENT_ENV_FILE || options.envPath || path.join(cwd, '.env')).trim();

  if (!envPath || !fs.existsSync(envPath)) {
    return {
      loaded: false,
      envPath,
      keys: [],
    };
  }

  const parsed = parseDotEnv(fs.readFileSync(envPath, 'utf8'));
  const loadedKeys = [];

  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] !== undefined) {
      continue;
    }
    process.env[key] = value;
    loadedKeys.push(key);
  }

  return {
    loaded: true,
    envPath,
    keys: loadedKeys,
  };
}

const loadHeyAgentEnv = loadUshAgentEnv;

export { loadHeyAgentEnv, parseDotEnv };
