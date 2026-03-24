import fs from 'node:fs';
import path from 'node:path';
import { listCodexSessions } from './providers/codex-session-store.js';

function normalizePath(workspacePath) {
  return String(workspacePath || '').trim();
}

function deriveLabel(workspacePath) {
  const normalized = normalizePath(workspacePath);
  if (!normalized) {
    return '(unknown)';
  }

  const baseName = path.basename(normalized);
  return baseName || normalized;
}

function asWorkspaceRecord(workspacePath, record = {}) {
  const normalizedPath = normalizePath(workspacePath);
  return {
    path: normalizedPath,
    label: String(record.label || '').trim() || deriveLabel(normalizedPath),
    lastUsedAt: String(record.lastUsedAt || '').trim() || null,
    provider: String(record.provider || '').trim() || null,
    codexLastSessionId: String(record.codexLastSessionId || '').trim() || null,
    sessionCount: Number.isFinite(record.sessionCount) ? Number(record.sessionCount) : 0,
  };
}

export function collectKnownWorkspaces(config, options = {}) {
  const includeMissing = options.includeMissing === true;
  const limit = Number.isFinite(options.limit) ? Math.max(1, Number(options.limit)) : 8;
  const workspaceMap = new Map();

  for (const [workspacePath, record] of Object.entries(config.workspaces)) {
    const normalizedPath = normalizePath(workspacePath);
    if (!normalizedPath) {
      continue;
    }

    if (!includeMissing && !fs.existsSync(normalizedPath)) {
      continue;
    }

    workspaceMap.set(normalizedPath, asWorkspaceRecord(normalizedPath, record));
  }

  const codexSessions = listCodexSessions({
    includeAll: true,
    limit: Number.MAX_SAFE_INTEGER,
  });

  for (const session of codexSessions) {
    const normalizedPath = normalizePath(session.cwd);
    if (!normalizedPath) {
      continue;
    }

    if (!includeMissing && !fs.existsSync(normalizedPath)) {
      continue;
    }

    const current = workspaceMap.get(normalizedPath) || asWorkspaceRecord(normalizedPath);
    const sessionCount = current.sessionCount + 1;
    const lastUsedAt =
      !current.lastUsedAt || session.timestamp > current.lastUsedAt ? session.timestamp : current.lastUsedAt;

    workspaceMap.set(
      normalizedPath,
      asWorkspaceRecord(normalizedPath, {
        ...current,
        lastUsedAt,
        sessionCount,
      })
    );
  }

  return [...workspaceMap.values()]
    .sort((left, right) => {
      const leftScore = left.lastUsedAt || '';
      const rightScore = right.lastUsedAt || '';
      return rightScore.localeCompare(leftScore);
    })
    .slice(0, limit);
}

export function formatWorkspaceList(workspaces, options = {}) {
  const activeWorkspacePath = normalizePath(options.activeWorkspacePath);

  if (!Array.isArray(workspaces) || workspaces.length === 0) {
    return 'No known projects yet.';
  }

  const lines = ['Projects:'];
  for (let index = 0; index < workspaces.length; index += 1) {
    const workspace = workspaces[index];
    const activeMarker = workspace.path === activeWorkspacePath ? ' [active]' : '';
    lines.push(`${index + 1}. ${workspace.label}${activeMarker}`);
    lines.push(workspace.path);
    lines.push(
      [
        workspace.lastUsedAt ? `last used: ${workspace.lastUsedAt}` : null,
        workspace.provider ? `provider: ${workspace.provider}` : null,
        Number.isFinite(workspace.sessionCount) ? `sessions: ${workspace.sessionCount}` : null,
      ]
        .filter(Boolean)
        .join(' | ')
    );
  }
  lines.push('');
  lines.push('Use /project <number> or /project <path> to switch.');
  return lines.join('\n');
}
