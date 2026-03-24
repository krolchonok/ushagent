import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_AUTH_PATH = path.join(os.homedir(), '.codex', 'auth.json');
const DEFAULT_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return null;
  }

  const totalSeconds = Math.round(seconds);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);

  if (days > 0) {
    return `${days}d ${hours}h`;
  }

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  return `${minutes}m`;
}

function formatWindowLabel(seconds) {
  if (!Number.isFinite(seconds)) {
    return 'window';
  }

  if (seconds === 18000) {
    return '5h';
  }

  if (seconds === 604800) {
    return 'week';
  }

  return formatDuration(seconds) || 'window';
}

function normalizeWindow(window) {
  if (!window || typeof window !== 'object') {
    return null;
  }

  const usedPercent = Number.isFinite(window.used_percent) ? Number(window.used_percent) : null;
  const remainingPercent = usedPercent === null ? null : Math.max(0, 100 - usedPercent);
  const resetAfterSeconds = Number.isFinite(window.reset_after_seconds) ? Number(window.reset_after_seconds) : null;
  const resetAt = Number.isFinite(window.reset_at) ? Number(window.reset_at) : null;
  const limitWindowSeconds = Number.isFinite(window.limit_window_seconds) ? Number(window.limit_window_seconds) : null;

  return {
    usedPercent,
    remainingPercent,
    resetAfterSeconds,
    resetAt,
    limitWindowSeconds,
    label: formatWindowLabel(limitWindowSeconds),
    resetInText: formatDuration(resetAfterSeconds),
  };
}

function normalizeLimit(id, rawLimit, limitName = null) {
  if (!rawLimit || typeof rawLimit !== 'object') {
    return null;
  }

  return {
    id,
    name: limitName || id,
    allowed: rawLimit.allowed !== false,
    limitReached: rawLimit.limit_reached === true,
    primaryWindow: normalizeWindow(rawLimit.primary_window),
    secondaryWindow: normalizeWindow(rawLimit.secondary_window),
  };
}

function normalizeAdditionalLimits(rawLimits) {
  if (!Array.isArray(rawLimits)) {
    return [];
  }

  return rawLimits
    .map(item => {
      if (!item || typeof item !== 'object') {
        return null;
      }

      return normalizeLimit(item.metered_feature || 'additional', item.rate_limit, item.limit_name || null);
    })
    .filter(Boolean);
}

function toTextLines(limit) {
  if (!limit) {
    return [];
  }

  const lines = [];
  if (limit.primaryWindow) {
    lines.push(
      `${limit.name} ${limit.primaryWindow.label}: ${limit.primaryWindow.remainingPercent ?? '?'}% left` +
        (limit.primaryWindow.resetInText ? `, resets in ${limit.primaryWindow.resetInText}` : '')
    );
  }

  if (limit.secondaryWindow) {
    lines.push(
      `${limit.name} ${limit.secondaryWindow.label}: ${limit.secondaryWindow.remainingPercent ?? '?'}% left` +
        (limit.secondaryWindow.resetInText ? `, resets in ${limit.secondaryWindow.resetInText}` : '')
    );
  }

  if (!limit.allowed || limit.limitReached) {
    lines.push(`${limit.name}: limit reached`);
  }

  return lines;
}

async function loadAuth(options = {}) {
  const accessToken = String(options.accessToken || process.env.CODEX_ACCESS_TOKEN || '').trim();
  const accountId = String(options.accountId || process.env.CODEX_ACCOUNT_ID || '').trim();

  if (accessToken && accountId) {
    return {
      accessToken,
      accountId,
      source: 'env',
    };
  }

  const authPath = String(options.authPath || process.env.CODEX_AUTH_FILE || DEFAULT_AUTH_PATH).trim();
  const raw = await fs.readFile(authPath, 'utf8');
  const parsed = JSON.parse(raw);
  const tokens = parsed?.tokens && typeof parsed.tokens === 'object' ? parsed.tokens : {};
  const fileAccessToken = String(tokens.access_token || '').trim();
  const fileAccountId = String(tokens.account_id || '').trim();

  if (!fileAccessToken || !fileAccountId) {
    throw new Error('Codex auth.json is missing access_token or account_id.');
  }

  return {
    accessToken: fileAccessToken,
    accountId: fileAccountId,
    source: authPath,
  };
}

export async function fetchCodexUsage(options = {}) {
  try {
    const auth = await loadAuth(options);
    const url = String(options.url || process.env.CODEX_USAGE_URL || DEFAULT_USAGE_URL).trim();
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${auth.accessToken}`,
        'ChatGPT-Account-Id': auth.accountId,
        'User-Agent': 'codex-cli',
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Usage request failed with HTTP ${response.status}: ${body.slice(0, 500)}`);
    }

    const payload = await response.json();
    if (!payload || typeof payload !== 'object') {
      throw new Error('Usage response is not a JSON object.');
    }

    const credits = payload.credits && typeof payload.credits === 'object' ? payload.credits : null;
    const limits = [
      normalizeLimit('codex', payload.rate_limit, 'Codex'),
      normalizeLimit('code_review', payload.code_review_rate_limit, 'Code review'),
      ...normalizeAdditionalLimits(payload.additional_rate_limits),
    ].filter(Boolean);

    const codexLimit = limits.find(limit => limit.id === 'codex') || null;
    const codeReviewLimit = limits.find(limit => limit.id === 'code_review') || null;

    return {
      ok: true,
      source: 'chatgpt-backend-api',
      fetchedAt: Date.now(),
      authSource: auth.source,
      planType: typeof payload.plan_type === 'string' ? payload.plan_type : null,
      credits: credits
        ? {
            hasCredits: credits.has_credits === true,
            unlimited: credits.unlimited === true,
            balance: credits.balance ?? null,
            approxLocalMessages: Array.isArray(credits.approx_local_messages) ? credits.approx_local_messages : null,
            approxCloudMessages: Array.isArray(credits.approx_cloud_messages) ? credits.approx_cloud_messages : null,
          }
        : null,
      promo: payload.promo ?? null,
      limits,
      codexLimit,
      codeReviewLimit,
      raw: payload,
    };
  } catch (error) {
    return {
      ok: false,
      source: 'chatgpt-backend-api',
      fetchedAt: Date.now(),
      error: error instanceof Error ? error.message : String(error),
      limits: [],
      codexLimit: null,
      codeReviewLimit: null,
      credits: null,
      planType: null,
      promo: null,
      raw: null,
    };
  }
}

export function formatCodexUsage(snapshot) {
  if (!snapshot?.ok) {
    return `Usage: unavailable${snapshot?.error ? `\nReason: ${snapshot.error}` : ''}`;
  }

  const lines = [];
  lines.push(`Plan: ${snapshot.planType || 'unknown'}`);

  if (snapshot.codexLimit) {
    lines.push(...toTextLines(snapshot.codexLimit));
  } else {
    lines.push('Codex: usage data unavailable');
  }

  if (snapshot.codeReviewLimit?.primaryWindow) {
    lines.push(...toTextLines(snapshot.codeReviewLimit));
  }

  if (snapshot.credits) {
    if (snapshot.credits.unlimited) {
      lines.push('Credits: unlimited');
    } else if (snapshot.credits.hasCredits) {
      lines.push(`Credits balance: ${snapshot.credits.balance ?? 'unknown'}`);
    }
  }

  return lines.join('\n');
}

export function parseUsageText(rawText) {
  const text = String(rawText || '').replace(/\r/g, '\n');
  const normalized = text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .join('\n');

  const percentMatches = [...normalized.matchAll(/(\d+%)\s+left/gi)];
  const remainingPercent = percentMatches.length > 0 ? percentMatches[percentMatches.length - 1][1] : null;
  const weeklyWarning = /less than 10% of your weekly limit left/i.test(normalized);
  const modelMatch = normalized.match(/(gpt-[^\s]+(?:\s+\w+)?)\s+[·-]\s+\d+%\s+left/i);

  return {
    remainingPercent,
    weeklyWarning,
    model: modelMatch ? modelMatch[1] : null,
    rawText: normalized,
  };
}

