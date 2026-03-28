import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let logDirEnsured = false;
const CONSOLE_LOG_ENV_NAMES = ['USHAGENT_CONSOLE_LOGS', 'HEYAGENT_CONSOLE_LOGS'];

function readConsoleLogPreference() {
  for (const envName of CONSOLE_LOG_ENV_NAMES) {
    const value = String(process.env[envName] || '')
      .trim()
      .toLowerCase();
    if (!value) {
      continue;
    }

    if (['1', 'true', 'yes', 'on'].includes(value)) {
      return true;
    }

    if (['0', 'false', 'no', 'off'].includes(value)) {
      return false;
    }
  }

  return false;
}

class Logger {
  constructor(service = 'ushagent') {
    this.service = service;
    this.logDir = path.join(os.homedir(), '.ushagent', 'logs');
  }

  getLogFile() {
    const date = new Date().toLocaleDateString('en-CA');
    return path.join(this.logDir, `ushagent-${date}.log`);
  }

  async ensureLogDir() {
    if (logDirEnsured) return;

    try {
      await fs.access(this.logDir);
    } catch {
      await fs.mkdir(this.logDir, { recursive: true });
    }
    logDirEnsured = true;
  }

  async writeToFile(logEntry) {
    await this.ensureLogDir();
    await fs.appendFile(this.getLogFile(), logEntry, 'utf8');
  }

  shouldLogToConsole() {
    return readConsoleLogPreference();
  }

  writeToConsole(logEntry) {
    process.stderr.write(logEntry);
  }

  log(level, msg) {
    const timestamp = new Date().toISOString();
    const logEntry = `[${timestamp}] [${level.toUpperCase()}] [${this.service}] ${msg}\n`;

    if (this.shouldLogToConsole()) {
      this.writeToConsole(logEntry);
    }

    // Fire-and-forget async write
    this.writeToFile(logEntry).catch(err => {
      process.stderr.write(`Logging failed: ${err.message}\n`);
    });
  }

  error(msg) {
    this.log('error', msg);
  }

  warn(msg) {
    this.log('warn', msg);
  }

  info(msg) {
    this.log('info', msg);
  }
}

export default Logger;
