import { describe, expect, test } from 'bun:test';
import { parseAuthEntry } from '../src/credentials.ts';
import type { OpenCodeAuthEntry } from '../src/types.ts';

describe('parseAuthEntry', () => {
  describe('api type', () => {
    test('returns apiKey credential when key is present', () => {
      const entry: OpenCodeAuthEntry = { type: 'api', key: 'sk-test-123' };
      const result = parseAuthEntry(entry);
      expect(result).toEqual({ apiKey: 'sk-test-123', source: 'opencode' });
    });

    test('returns null when key is missing', () => {
      const entry: OpenCodeAuthEntry = { type: 'api' };
      expect(parseAuthEntry(entry)).toBeNull();
    });

    test('returns null when key is empty string', () => {
      const entry: OpenCodeAuthEntry = { type: 'api', key: '' };
      expect(parseAuthEntry(entry)).toBeNull();
    });
  });

  describe('oauth type', () => {
    test('returns oauth credential with access token only', () => {
      const entry: OpenCodeAuthEntry = { type: 'oauth', access: 'access-tok-123' };
      const result = parseAuthEntry(entry);
      expect(result).toEqual({
        oauth: { accessToken: 'access-tok-123' },
        source: 'opencode',
      });
    });

    test('returns oauth credential with refresh token and expiry', () => {
      const entry: OpenCodeAuthEntry = {
        type: 'oauth',
        access: 'access-tok-123',
        refresh: 'refresh-tok-456',
        expires: 1700000000,
      };
      const result = parseAuthEntry(entry);
      expect(result).toEqual({
        oauth: {
          accessToken: 'access-tok-123',
          refreshToken: 'refresh-tok-456',
          expiresAt: 1700000000,
        },
        source: 'opencode',
      });
    });

    test('returns null when access token is missing', () => {
      const entry: OpenCodeAuthEntry = { type: 'oauth', refresh: 'refresh-tok' };
      expect(parseAuthEntry(entry)).toBeNull();
    });
  });

  describe('codex type', () => {
    test('returns oauth credential from codex fields', () => {
      const entry: OpenCodeAuthEntry = {
        type: 'codex',
        accessToken: 'codex-access-123',
        refreshToken: 'codex-refresh-456',
        expiresAt: 1700000000,
        accountId: 'acct-789',
      };
      const result = parseAuthEntry(entry);
      expect(result).toEqual({
        oauth: {
          accessToken: 'codex-access-123',
          refreshToken: 'codex-refresh-456',
          expiresAt: 1700000000,
          accountId: 'acct-789',
        },
        source: 'opencode',
      });
    });

    test('returns oauth credential with minimal codex fields', () => {
      const entry: OpenCodeAuthEntry = { type: 'codex', accessToken: 'codex-access-123' };
      const result = parseAuthEntry(entry);
      expect(result).toEqual({
        oauth: { accessToken: 'codex-access-123' },
        source: 'opencode',
      });
    });

    test('returns null when accessToken is missing', () => {
      const entry: OpenCodeAuthEntry = { type: 'codex', accountId: 'acct-789' };
      expect(parseAuthEntry(entry)).toBeNull();
    });
  });

  describe('github type', () => {
    test('returns apiKey credential from github token', () => {
      const entry: OpenCodeAuthEntry = { type: 'github', token: 'ghp_abc123' };
      const result = parseAuthEntry(entry);
      expect(result).toEqual({ apiKey: 'ghp_abc123', source: 'opencode' });
    });

    test('returns null when token is missing', () => {
      const entry: OpenCodeAuthEntry = { type: 'github' };
      expect(parseAuthEntry(entry)).toBeNull();
    });
  });

  describe('wellknown type', () => {
    test('returns apiKey from token field', () => {
      const entry: OpenCodeAuthEntry = { type: 'wellknown', token: 'wk-token-123' };
      const result = parseAuthEntry(entry);
      expect(result).toEqual({ apiKey: 'wk-token-123', source: 'opencode' });
    });

    test('returns apiKey from key field when token is absent', () => {
      const entry: OpenCodeAuthEntry = { type: 'wellknown', key: 'wk-key-456' };
      const result = parseAuthEntry(entry);
      expect(result).toEqual({ apiKey: 'wk-key-456', source: 'opencode' });
    });

    test('prefers token over key when both present', () => {
      const entry: OpenCodeAuthEntry = { type: 'wellknown', token: 'tok', key: 'key' };
      const result = parseAuthEntry(entry);
      expect(result).toEqual({ apiKey: 'tok', source: 'opencode' });
    });

    test('returns null when neither token nor key is present', () => {
      const entry: OpenCodeAuthEntry = { type: 'wellknown' };
      expect(parseAuthEntry(entry)).toBeNull();
    });
  });

  describe('unknown/invalid entries', () => {
    test('returns null for api type with unrelated fields', () => {
      const entry: OpenCodeAuthEntry = { type: 'api', token: 'wrong-field' };
      expect(parseAuthEntry(entry)).toBeNull();
    });

    test('returns null for github type with key instead of token', () => {
      const entry: OpenCodeAuthEntry = { type: 'github', key: 'not-a-token' };
      expect(parseAuthEntry(entry)).toBeNull();
    });
  });
});
