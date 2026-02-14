import type { SessionUsageData } from '@tokentop/plugin-sdk';
import type { OpenCodeSession, SessionAggregateCacheEntry } from './types.ts';

export const sessionCache: {
  lastCheck: number;
  lastResult: SessionUsageData[];
  lastLimit: number;
  lastSince: number | undefined;
} = {
  lastCheck: 0,
  lastResult: [],
  lastLimit: 0,
  lastSince: undefined,
};

export const CACHE_TTL_MS = 2000;

export const SESSION_AGGREGATE_CACHE_MAX = 10_000;

export const sessionAggregateCache = new Map<string, SessionAggregateCacheEntry>();

export function evictSessionAggregateCache(): void {
  if (sessionAggregateCache.size <= SESSION_AGGREGATE_CACHE_MAX) return;

  const entries = Array.from(sessionAggregateCache.entries());
  entries.sort((a, b) => a[1].lastAccessed - b[1].lastAccessed);

  const toEvict = entries.length - SESSION_AGGREGATE_CACHE_MAX;
  for (let i = 0; i < toEvict; i++) {
    sessionAggregateCache.delete(entries[i]![0]);
  }
}

export const sessionMetadataIndex = new Map<string, {
  mtimeMs: number;
  session: OpenCodeSession;
}>();
