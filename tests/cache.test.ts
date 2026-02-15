import { afterEach, describe, expect, test } from 'bun:test';
import {
  CACHE_TTL_MS,
  SESSION_AGGREGATE_CACHE_MAX,
  evictSessionAggregateCache,
  sessionAggregateCache,
  sessionCache,
  sessionMetadataIndex,
} from '../src/cache.ts';
import type { SessionAggregateCacheEntry } from '../src/types.ts';

afterEach(() => {
  sessionAggregateCache.clear();
  sessionMetadataIndex.clear();
  sessionCache.lastCheck = 0;
  sessionCache.lastResult = [];
  sessionCache.lastLimit = 0;
  sessionCache.lastSince = undefined;
});

describe('constants', () => {
  test('CACHE_TTL_MS is 2 seconds', () => {
    expect(CACHE_TTL_MS).toBe(2000);
  });

  test('SESSION_AGGREGATE_CACHE_MAX is 10,000', () => {
    expect(SESSION_AGGREGATE_CACHE_MAX).toBe(10_000);
  });
});

describe('sessionCache', () => {
  test('has correct initial state', () => {
    expect(sessionCache.lastCheck).toBe(0);
    expect(sessionCache.lastResult).toEqual([]);
    expect(sessionCache.lastLimit).toBe(0);
    expect(sessionCache.lastSince).toBeUndefined();
  });
});

describe('evictSessionAggregateCache', () => {
  test('does nothing when cache is under limit', () => {
    sessionAggregateCache.set('session-1', {
      updatedAt: 100,
      usageRows: [],
      lastAccessed: 1000,
    });
    sessionAggregateCache.set('session-2', {
      updatedAt: 200,
      usageRows: [],
      lastAccessed: 2000,
    });

    evictSessionAggregateCache();
    expect(sessionAggregateCache.size).toBe(2);
  });

  test('does nothing when cache is exactly at limit', () => {
    for (let i = 0; i < SESSION_AGGREGATE_CACHE_MAX; i++) {
      sessionAggregateCache.set(`session-${i}`, {
        updatedAt: i,
        usageRows: [],
        lastAccessed: i,
      });
    }

    evictSessionAggregateCache();
    expect(sessionAggregateCache.size).toBe(SESSION_AGGREGATE_CACHE_MAX);
  });

  test('evicts oldest entries when cache exceeds limit', () => {
    // Fill to limit
    for (let i = 0; i < SESSION_AGGREGATE_CACHE_MAX; i++) {
      sessionAggregateCache.set(`session-${i}`, {
        updatedAt: i,
        usageRows: [],
        lastAccessed: i,
      });
    }

    // Add 5 more to exceed limit
    for (let i = 0; i < 5; i++) {
      sessionAggregateCache.set(`session-extra-${i}`, {
        updatedAt: SESSION_AGGREGATE_CACHE_MAX + i,
        usageRows: [],
        lastAccessed: SESSION_AGGREGATE_CACHE_MAX + i,
      });
    }

    expect(sessionAggregateCache.size).toBe(SESSION_AGGREGATE_CACHE_MAX + 5);

    evictSessionAggregateCache();

    expect(sessionAggregateCache.size).toBe(SESSION_AGGREGATE_CACHE_MAX);
  });

  test('evicts by lastAccessed order, keeping most recently accessed', () => {
    // Create a small overflowing cache to verify ordering
    // Temporarily test with a controlled scenario
    sessionAggregateCache.clear();

    // We'll create MAX + 3 entries
    for (let i = 0; i < SESSION_AGGREGATE_CACHE_MAX + 3; i++) {
      sessionAggregateCache.set(`s-${i}`, {
        updatedAt: 0,
        usageRows: [],
        lastAccessed: i, // sequential access times
      });
    }

    evictSessionAggregateCache();

    // The 3 oldest (lastAccessed 0, 1, 2) should be evicted
    expect(sessionAggregateCache.has('s-0')).toBe(false);
    expect(sessionAggregateCache.has('s-1')).toBe(false);
    expect(sessionAggregateCache.has('s-2')).toBe(false);

    // The most recent should survive
    expect(sessionAggregateCache.has('s-3')).toBe(true);
    expect(sessionAggregateCache.has(`s-${SESSION_AGGREGATE_CACHE_MAX + 2}`)).toBe(true);
  });

  test('preserves recently accessed entries even if updatedAt is old', () => {
    sessionAggregateCache.clear();

    for (let i = 0; i < SESSION_AGGREGATE_CACHE_MAX + 1; i++) {
      sessionAggregateCache.set(`s-${i}`, {
        updatedAt: 0, // all same updatedAt
        usageRows: [],
        lastAccessed: i,
      });
    }

    // Bump the first entry to have the most recent access
    const first = sessionAggregateCache.get('s-0')!;
    first.lastAccessed = SESSION_AGGREGATE_CACHE_MAX + 999;

    evictSessionAggregateCache();

    // s-0 should survive despite being added first (most recently accessed)
    expect(sessionAggregateCache.has('s-0')).toBe(true);
    // s-1 should be evicted (oldest lastAccessed after the bump)
    expect(sessionAggregateCache.has('s-1')).toBe(false);
  });
});

describe('sessionMetadataIndex', () => {
  test('is initially empty', () => {
    expect(sessionMetadataIndex.size).toBe(0);
  });

  test('can store and retrieve session metadata', () => {
    sessionMetadataIndex.set('/path/to/session.json', {
      mtimeMs: 1700000000,
      session: {
        id: 'sess-123',
        time: { created: 1700000000, updated: 1700001000 },
      },
    });

    const entry = sessionMetadataIndex.get('/path/to/session.json');
    expect(entry?.session.id).toBe('sess-123');
    expect(entry?.mtimeMs).toBe(1700000000);
  });
});
