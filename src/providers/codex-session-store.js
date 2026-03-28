import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');
const SESSION_HEADER_BYTES = 16 * 1024;

function readFirstLine(filePath) {
  const fd = fs.openSync(filePath, 'r');

  try {
    const buffer = Buffer.alloc(SESSION_HEADER_BYTES);
    const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const header = buffer.toString('utf8', 0, bytesRead);
    const newlineIndex = header.indexOf('\n');
    return newlineIndex >= 0 ? header.slice(0, newlineIndex) : header;
  } finally {
    fs.closeSync(fd);
  }
}

function collectJsonlFiles(baseDir) {
  if (!fs.existsSync(baseDir)) {
    return [];
  }

  const files = [];
  const pending = [baseDir];

  while (pending.length > 0) {
    const currentDir = pending.pop();
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        pending.push(fullPath);
        continue;
      }

      if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function parseSessionMeta(filePath) {
  try {
    const firstLine = readFirstLine(filePath).trim();
    if (!firstLine) {
      return null;
    }

    const parsed = JSON.parse(firstLine);
    const payload = parsed?.payload;
    const sessionId = String(payload?.id || '').trim();
    const timestamp = String(payload?.timestamp || parsed?.timestamp || '').trim();
    const cwd = String(payload?.cwd || '').trim();
    const model = String(payload?.model || '').trim();

    if (!sessionId || !timestamp) {
      return null;
    }

    return {
      id: sessionId,
      timestamp,
      cwd,
      model: model || null,
      filePath,
    };
  } catch {
    return null;
  }
}

function formatSessionLine(session, index) {
  const cwdText = session.cwd ? session.cwd : '(unknown cwd)';
  const modelText = session.model ? ` | ${session.model}` : '';
  const previewText = String(session.preview || '').trim();
  const previewLine = previewText ? `\n${previewText}` : '';
  return `${index + 1}. ${session.id}\n${session.timestamp} | ${cwdText}${modelText}${previewLine}`;
}

function readJsonLines(filePath) {
  try {
    return fs
      .readFileSync(filePath, 'utf8')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function extractMessageText(content) {
  if (typeof content === 'string') {
    return content.trim();
  }

  if (Array.isArray(content)) {
    return content
      .map(item => {
        if (typeof item === 'string') {
          return item.trim();
        }
        if (!item || typeof item !== 'object') {
          return '';
        }
        return String(item.text || item.output_text || item.input_text || '').trim();
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  if (content && typeof content === 'object') {
    return String(content.text || content.output_text || content.input_text || '').trim();
  }

  return '';
}

function parseTranscriptEntry(event) {
  const payload = event?.payload;
  if (event?.type !== 'response_item' || payload?.type !== 'message') {
    return null;
  }

  const role = String(payload.role || '').trim();
  if (role !== 'user' && role !== 'assistant') {
    return null;
  }

  const text = extractMessageText(payload.content);
  if (!text) {
    return null;
  }

  return {
    timestamp: String(event.timestamp || '').trim() || null,
    role,
    phase: String(payload.phase || '').trim() || null,
    text,
  };
}

function toPreviewText(text, maxLength = 120) {
  const normalized = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) {
    return '';
  }

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength - 1)}…`;
}

function findLatestPreview(filePath) {
  const entries = readJsonLines(filePath);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const transcriptEntry = parseTranscriptEntry(entries[index]);
    if (!transcriptEntry?.text) {
      continue;
    }

    const who = transcriptEntry.role === 'assistant' ? 'Codex' : 'User';
    const preview = toPreviewText(transcriptEntry.text);
    if (preview) {
      return `${who}: ${preview}`;
    }
  }

  return '';
}

function findSessionById(sessionId) {
  const normalized = String(sessionId || '').trim();
  if (!normalized) {
    return null;
  }

  return collectJsonlFiles(CODEX_SESSIONS_DIR)
    .map(parseSessionMeta)
    .filter(Boolean)
    .find(session => session.id === normalized);
}

export function listCodexSessions(options = {}) {
  const cwd = String(options.cwd || process.cwd()).trim();
  const includeAll = options.includeAll === true;
  const limit = Number.isFinite(options.limit) ? Math.max(1, Number(options.limit)) : 8;

  const sessions = collectJsonlFiles(CODEX_SESSIONS_DIR)
    .map(parseSessionMeta)
    .filter(Boolean)
    .filter(session => includeAll || session.cwd === cwd)
    .map(session => ({
      ...session,
      preview: findLatestPreview(session.filePath),
    }))
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp));

  return sessions.slice(0, limit);
}

export function formatCodexSessionList(sessions, options = {}) {
  const includeAll = options.includeAll === true;
  const cwd = String(options.cwd || process.cwd()).trim();

  if (!Array.isArray(sessions) || sessions.length === 0) {
    return includeAll ? 'No Codex sessions found.' : `No Codex sessions found for ${cwd}.`;
  }

  const header = includeAll ? 'Recent Codex sessions:' : `Recent Codex sessions for ${cwd}:`;
  return [header, ...sessions.map(formatSessionLine), '', 'Use /resume <session-id> to switch.'].join('\n');
}

export function getCodexSessionTranscript(options = {}) {
  const limit = Number.isFinite(options.limit) ? Math.max(1, Number(options.limit)) : 10;
  const session = findSessionById(options.sessionId);
  if (!session?.filePath) {
    return {
      session: null,
      entries: [],
    };
  }

  const entries = readJsonLines(session.filePath).map(parseTranscriptEntry).filter(Boolean).slice(-limit);

  return {
    session,
    entries,
  };
}
