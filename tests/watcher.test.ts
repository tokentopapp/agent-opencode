import { describe, expect, test } from 'bun:test';
import {
  RECONCILIATION_INTERVAL_MS,
  consumeForceFullReconciliation,
  forceFullReconciliation,
  sessionWatcher,
} from '../src/watcher.ts';

describe('constants', () => {
  test('RECONCILIATION_INTERVAL_MS is 10 minutes', () => {
    expect(RECONCILIATION_INTERVAL_MS).toBe(10 * 60 * 1000);
  });
});

describe('sessionWatcher initial state', () => {
  test('starts with empty projectWatchers', () => {
    expect(sessionWatcher.projectWatchers.size).toBe(0);
  });

  test('starts with no rootWatcher', () => {
    expect(sessionWatcher.rootWatcher).toBeNull();
  });

  test('starts with empty dirtyPaths', () => {
    expect(sessionWatcher.dirtyPaths.size).toBe(0);
  });

  test('starts not started', () => {
    expect(sessionWatcher.started).toBe(false);
  });
});

describe('consumeForceFullReconciliation', () => {
  test('returns false when flag is not set', () => {
    expect(consumeForceFullReconciliation()).toBe(false);
  });

  test('returns false on subsequent calls when never set', () => {
    expect(consumeForceFullReconciliation()).toBe(false);
    expect(consumeForceFullReconciliation()).toBe(false);
  });
});
