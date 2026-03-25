import { runCodexPrompt } from './codex-provider.js';
import { formatCodexSessionList, getCodexSessionTranscript, listCodexSessions } from './codex-session-store.js';

const PROVIDER_DEFINITIONS = {
  codex: {
    id: 'codex',
    displayName: 'Codex',
    sessionKey: 'codexLastSessionId',
    runPrompt: runCodexPrompt,
    listSessions(options = {}) {
      const sessions = listCodexSessions(options);
      return {
        supported: true,
        sessions,
        text: formatCodexSessionList(sessions, options),
      };
    },
    getSessionTranscript(options = {}) {
      return getCodexSessionTranscript(options);
    },
  },
};

function normalizeProviderId(provider) {
  return String(provider || '')
    .trim()
    .toLowerCase();
}

export function isSupportedProvider(provider) {
  return Boolean(PROVIDER_DEFINITIONS[normalizeProviderId(provider)]);
}

export function listSupportedProviders() {
  return Object.keys(PROVIDER_DEFINITIONS);
}

export function getProviderDefinition(provider) {
  const normalized = normalizeProviderId(provider);
  const definition = PROVIDER_DEFINITIONS[normalized];
  if (!definition) {
    throw new Error(`Unsupported provider: ${provider}`);
  }
  return definition;
}

export function formatProviderName(provider) {
  return getProviderDefinition(provider).displayName;
}

export function getProviderSessionId(config, provider) {
  const definition = getProviderDefinition(provider);
  return config[definition.sessionKey] || null;
}

export function setProviderSessionId(config, provider, sessionId) {
  const definition = getProviderDefinition(provider);
  const normalized = String(sessionId || '').trim() || null;
  config.set(definition.sessionKey, normalized);
}

export function createProviderRuntime(config, provider, providerArgs = [], options = {}) {
  const definition = getProviderDefinition(provider);
  const extraArgs = Array.isArray(providerArgs) ? [...providerArgs] : [];
  const customGetSessionId = typeof options.getSessionId === 'function' ? options.getSessionId : null;
  const customSetSessionId = typeof options.setSessionId === 'function' ? options.setSessionId : null;

  return {
    id: definition.id,
    displayName: definition.displayName,
    extraArgs,
    getSessionId() {
      return customGetSessionId ? customGetSessionId() : getProviderSessionId(config, definition.id);
    },
    setSessionId(sessionId) {
      if (customSetSessionId) {
        customSetSessionId(sessionId);
        return;
      }
      setProviderSessionId(config, definition.id, sessionId);
    },
    async run(prompt, options = {}) {
      const resume = Boolean(options.resume);
      const cwd = options.cwd || process.cwd();
      const abortSignal = options.abortSignal || null;
      const sessionId = typeof options.sessionId === 'string' ? options.sessionId.trim() : this.getSessionId();

      return definition.runPrompt(prompt, {
        resume,
        extraArgs,
        cwd,
        abortSignal,
        sessionId,
        onSessionId: sessionId => {
          this.setSessionId(sessionId);
        },
        onProgress: options.onProgress,
        onRawEvent: options.onRawEvent,
      });
    },
    listSessions(options = {}) {
      return definition.listSessions({
        cwd: options.cwd || process.cwd(),
        includeAll: options.includeAll === true,
        limit: options.limit,
      });
    },
    getSessionTranscript(options = {}) {
      if (typeof definition.getSessionTranscript !== 'function') {
        return {
          session: null,
          entries: [],
        };
      }

      return definition.getSessionTranscript({
        sessionId: options.sessionId || this.getSessionId(),
        limit: options.limit,
      });
    },
  };
}
