import * as fs from 'fs/promises';
import type { OAuthCredentials } from '@tokentop/plugin-sdk';

export async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

export function resolveEnvValue(value: string | undefined): string | undefined {
  if (!value) return undefined;

  const envMatch = value.match(/^\{env:(\w+)\}$/);
  if (envMatch && envMatch[1]) {
    return process.env[envMatch[1]];
  }
  return value;
}

export function buildOAuthCredentials(
  accessToken: string,
  refreshToken?: string,
  expiresAt?: number,
  accountId?: string,
): OAuthCredentials {
  const oauth: OAuthCredentials = { accessToken };
  if (refreshToken !== undefined) oauth.refreshToken = refreshToken;
  if (expiresAt !== undefined) oauth.expiresAt = expiresAt;
  if (accountId !== undefined) oauth.accountId = accountId;
  return oauth;
}
