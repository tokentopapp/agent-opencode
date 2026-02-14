import * as fsSync from 'fs';
import * as path from 'path';
import { OPENCODE_SESSIONS_PATH } from './paths.ts';

export interface SessionWatcherState {
  projectWatchers: Map<string, fsSync.FSWatcher>;
  rootWatcher: fsSync.FSWatcher | null;
  dirtyPaths: Set<string>;
  reconciliationTimer: ReturnType<typeof setInterval> | null;
  started: boolean;
}

export const RECONCILIATION_INTERVAL_MS = 10 * 60 * 1000;

export const sessionWatcher: SessionWatcherState = {
  projectWatchers: new Map(),
  rootWatcher: null,
  dirtyPaths: new Set(),
  reconciliationTimer: null,
  started: false,
};

export let forceFullReconciliation = false;

export function watchProjectDir(projectDirPath: string): void {
  if (sessionWatcher.projectWatchers.has(projectDirPath)) return;

  try {
    const watcher = fsSync.watch(projectDirPath, (_eventType, filename) => {
      if (filename?.endsWith('.json')) {
        const filePath = path.join(projectDirPath, filename);
        sessionWatcher.dirtyPaths.add(filePath);
      }
    });
    sessionWatcher.projectWatchers.set(projectDirPath, watcher);
  } catch {
  }
}

export function startSessionWatcher(): void {
  if (sessionWatcher.started) return;
  sessionWatcher.started = true;

  try {
    sessionWatcher.rootWatcher = fsSync.watch(OPENCODE_SESSIONS_PATH, (eventType, filename) => {
      if (eventType === 'rename' && filename) {
        const projectDirPath = path.join(OPENCODE_SESSIONS_PATH, filename);
        watchProjectDir(projectDirPath);
      }
    });
  } catch {
  }

  try {
    const entries = fsSync.readdirSync(OPENCODE_SESSIONS_PATH, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        watchProjectDir(path.join(OPENCODE_SESSIONS_PATH, entry.name));
      }
    }
  } catch {
  }

  sessionWatcher.reconciliationTimer = setInterval(() => {
    forceFullReconciliation = true;
  }, RECONCILIATION_INTERVAL_MS);
}

export function stopSessionWatcher(): void {
  if (sessionWatcher.reconciliationTimer) {
    clearInterval(sessionWatcher.reconciliationTimer);
    sessionWatcher.reconciliationTimer = null;
  }

  for (const watcher of sessionWatcher.projectWatchers.values()) {
    watcher.close();
  }
  sessionWatcher.projectWatchers.clear();

  if (sessionWatcher.rootWatcher) {
    sessionWatcher.rootWatcher.close();
    sessionWatcher.rootWatcher = null;
  }

  sessionWatcher.dirtyPaths.clear();
  sessionWatcher.started = false;
}

export function consumeForceFullReconciliation(): boolean {
  const value = forceFullReconciliation;
  if (forceFullReconciliation) {
    forceFullReconciliation = false;
  }
  return value;
}
