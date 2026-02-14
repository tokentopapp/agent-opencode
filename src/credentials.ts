import type { Credentials } from '@tokentop/plugin-sdk';
import { OPENCODE_AUTH_PATH, OPENCODE_CONFIG_PATH } from './paths.ts';
import type { OpenCodeAuthEntry } from './types.ts';
import { buildOAuthCredentials } from './utils.ts';

export { OPENCODE_AUTH_PATH, OPENCODE_CONFIG_PATH };

export function parseAuthEntry(entry: OpenCodeAuthEntry): Credentials | null {
  if (entry.type === 'api' && entry.key) {
    return { apiKey: entry.key, source: 'opencode' };
  }

  if (entry.type === 'oauth' && entry.access) {
    return {
      oauth: buildOAuthCredentials(entry.access, entry.refresh, entry.expires),
      source: 'opencode',
    };
  }

  if (entry.type === 'codex' && entry.accessToken) {
    return {
      oauth: buildOAuthCredentials(entry.accessToken, entry.refreshToken, entry.expiresAt, entry.accountId),
      source: 'opencode',
    };
  }

  if (entry.type === 'github' && entry.token) {
    return { apiKey: entry.token, source: 'opencode' };
  }

  if (entry.type === 'wellknown') {
    const apiKey = entry.token ?? entry.key;
    if (apiKey) {
      return { apiKey, source: 'opencode' };
    }
  }

  return null;
}
