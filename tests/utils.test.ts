import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { readJsonFile, resolveEnvValue, buildOAuthCredentials } from '../src/utils.ts';

describe('resolveEnvValue', () => {
  const originalEnv = { ...process.env };

  test('returns undefined for undefined input', () => {
    expect(resolveEnvValue(undefined)).toBeUndefined();
  });

  test('returns undefined for empty string', () => {
    expect(resolveEnvValue('')).toBeUndefined();
  });

  test('returns plain string as-is', () => {
    expect(resolveEnvValue('sk-plain-key-123')).toBe('sk-plain-key-123');
  });

  test('resolves {env:VAR} to environment variable value', () => {
    process.env.TEST_OPENCODE_KEY = 'resolved-value';
    expect(resolveEnvValue('{env:TEST_OPENCODE_KEY}')).toBe('resolved-value');
    delete process.env.TEST_OPENCODE_KEY;
  });

  test('returns undefined when env var does not exist', () => {
    delete process.env.NONEXISTENT_VAR_12345;
    expect(resolveEnvValue('{env:NONEXISTENT_VAR_12345}')).toBeUndefined();
  });

  test('does not resolve partial env syntax', () => {
    expect(resolveEnvValue('{env:FOO}bar')).toBe('{env:FOO}bar');
  });

  test('does not resolve env syntax without braces', () => {
    expect(resolveEnvValue('env:FOO')).toBe('env:FOO');
  });

  test('does not resolve nested braces', () => {
    expect(resolveEnvValue('{{env:FOO}}')).toBe('{{env:FOO}}');
  });
});

describe('buildOAuthCredentials', () => {
  test('returns minimal credentials with only accessToken', () => {
    const result = buildOAuthCredentials('access-123');
    expect(result).toEqual({ accessToken: 'access-123' });
  });

  test('includes refreshToken when provided', () => {
    const result = buildOAuthCredentials('access-123', 'refresh-456');
    expect(result).toEqual({
      accessToken: 'access-123',
      refreshToken: 'refresh-456',
    });
  });

  test('includes all optional fields when provided', () => {
    const result = buildOAuthCredentials('access-123', 'refresh-456', 1700000000, 'acct-789');
    expect(result).toEqual({
      accessToken: 'access-123',
      refreshToken: 'refresh-456',
      expiresAt: 1700000000,
      accountId: 'acct-789',
    });
  });

  test('includes expiresAt even when 0', () => {
    const result = buildOAuthCredentials('access-123', undefined, 0);
    expect(result).toEqual({
      accessToken: 'access-123',
      expiresAt: 0,
    });
  });

  test('omits undefined optional fields', () => {
    const result = buildOAuthCredentials('access-123', undefined, undefined, undefined);
    expect(result).toEqual({ accessToken: 'access-123' });
    expect(Object.keys(result)).toEqual(['accessToken']);
  });
});

describe('readJsonFile', () => {
  let tmpDir: string;

  beforeAll(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'opencode-test-'));
  });

  afterAll(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  test('reads and parses valid JSON file', async () => {
    const filePath = path.join(tmpDir, 'valid.json');
    await fs.writeFile(filePath, JSON.stringify({ key: 'value', num: 42 }));
    const result = await readJsonFile<{ key: string; num: number }>(filePath);
    expect(result).toEqual({ key: 'value', num: 42 });
  });

  test('returns null for non-existent file', async () => {
    const result = await readJsonFile(path.join(tmpDir, 'does-not-exist.json'));
    expect(result).toBeNull();
  });

  test('returns null for invalid JSON content', async () => {
    const filePath = path.join(tmpDir, 'invalid.json');
    await fs.writeFile(filePath, '{not valid json');
    const result = await readJsonFile(filePath);
    expect(result).toBeNull();
  });

  test('reads empty object', async () => {
    const filePath = path.join(tmpDir, 'empty-obj.json');
    await fs.writeFile(filePath, '{}');
    const result = await readJsonFile<Record<string, unknown>>(filePath);
    expect(result).toEqual({});
  });

  test('reads array JSON', async () => {
    const filePath = path.join(tmpDir, 'array.json');
    await fs.writeFile(filePath, '[1, 2, 3]');
    const result = await readJsonFile<number[]>(filePath);
    expect(result).toEqual([1, 2, 3]);
  });

  test('returns null for empty file', async () => {
    const filePath = path.join(tmpDir, 'empty.json');
    await fs.writeFile(filePath, '');
    const result = await readJsonFile(filePath);
    expect(result).toBeNull();
  });
});
