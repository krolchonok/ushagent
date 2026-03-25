export function hasFlag(providerArgs, longName, shortName = null) {
  for (let index = 0; index < providerArgs.length; index += 1) {
    const value = String(providerArgs[index] || '');
    if (value === longName || value.startsWith(`${longName}=`)) {
      return true;
    }
    if (shortName && value === shortName) {
      return true;
    }
  }
  return false;
}

function isValidCodexModelValue(value) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return false;
  }

  if (/^[\\/]+$/.test(normalized)) {
    return false;
  }

  return !normalized.startsWith('-');
}

export function sanitizeProviderArgs(provider, providerArgs) {
  const args = Array.isArray(providerArgs) ? [...providerArgs] : [];

  if (provider !== 'codex') {
    return args;
  }

  const sanitized = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index] || '').trim();
    if (!value) {
      continue;
    }

    if (value === '--model') {
      const modelValue = String(args[index + 1] || '').trim();
      if (isValidCodexModelValue(modelValue)) {
        sanitized.push('--model', modelValue);
      }
      index += 1;
      continue;
    }

    if (value.startsWith('--model=')) {
      const modelValue = value.slice('--model='.length).trim();
      if (isValidCodexModelValue(modelValue)) {
        sanitized.push(`--model=${modelValue}`);
      }
      continue;
    }

    sanitized.push(value);
  }

  return sanitized;
}

export function applyDefaultBypassArgs(provider, providerArgs) {
  const args = sanitizeProviderArgs(provider, providerArgs);

  if (provider === 'codex') {
    const hasExplicitPermissionMode =
      hasFlag(args, '--dangerously-bypass-approvals-and-sandbox') ||
      hasFlag(args, '--full-auto') ||
      hasFlag(args, '--sandbox', '-s') ||
      hasFlag(args, '--ask-for-approval', '-a');

    if (!hasExplicitPermissionMode) {
      args.unshift('--dangerously-bypass-approvals-and-sandbox');
      return { providerArgs: args, defaultBypassApplied: true };
    }

    return { providerArgs: args, defaultBypassApplied: false };
  }

  return { providerArgs: args, defaultBypassApplied: false };
}
