import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import type {
  ActivityCallback,
  ActivityUpdate,
  AgentFetchContext,
  SessionParseOptions,
  SessionUsageData,
} from '@tokentop/plugin-sdk';
import { CACHE_TTL_MS, evictSessionAggregateCache, sessionAggregateCache, sessionCache, sessionMetadataIndex } from './cache.ts';
import { OPENCODE_MESSAGES_PATH, OPENCODE_PARTS_PATH, OPENCODE_SESSIONS_PATH, OPENCODE_STORAGE_PATH } from './paths.ts';
import type { OpenCodeMessage, OpenCodePart, OpenCodeSession } from './types.ts';
import { readJsonFile } from './utils.ts';
import {
  consumeForceFullReconciliation,
  sessionWatcher,
  startSessionWatcher,
  stopSessionWatcher,
  watchProjectDir,
} from './watcher.ts';

interface ActivityWatcherState {
  watcher: fsSync.FSWatcher | null;
  callback: ActivityCallback | null;
  seenParts: Set<string>;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  pendingDirs: Set<string>;
  messageWatchers: Map<string, fsSync.FSWatcher>;
}

const activityWatcher: ActivityWatcherState = {
  watcher: null,
  callback: null,
  seenParts: new Set(),
  debounceTimer: null,
  pendingDirs: new Set(),
  messageWatchers: new Map(),
};

export async function processPartFile(partPath: string): Promise<void> {
  if (activityWatcher.seenParts.has(partPath)) return;
  activityWatcher.seenParts.add(partPath);

  const part = await readJsonFile<OpenCodePart>(partPath);
  if (!part || !part.tokens) return;

  const callback = activityWatcher.callback;
  if (!callback) return;

  const tokens: ActivityUpdate['tokens'] = {
    input: part.tokens.input ?? 0,
    output: part.tokens.output ?? 0,
  };
  if (part.tokens.reasoning !== undefined) tokens.reasoning = part.tokens.reasoning;
  if (part.tokens.cache?.read !== undefined) tokens.cacheRead = part.tokens.cache.read;
  if (part.tokens.cache?.write !== undefined) tokens.cacheWrite = part.tokens.cache.write;

  const update: ActivityUpdate = {
    sessionId: part.sessionID,
    messageId: part.messageID,
    tokens,
    timestamp: Date.now(),
  };

  callback(update);
}

export async function scanMessageDir(msgDirPath: string): Promise<void> {
  try {
    const files = await fs.readdir(msgDirPath);
    for (const file of files) {
      if (file.endsWith('.json')) {
        const partPath = path.join(msgDirPath, file);
        await processPartFile(partPath);
      }
    }
  } catch {
  }
}

export function watchMessageDir(msgDirPath: string): void {
  if (activityWatcher.messageWatchers.has(msgDirPath)) return;

  try {
    const watcher = fsSync.watch(msgDirPath, async (eventType, filename) => {
      if (eventType === 'rename' && filename?.endsWith('.json')) {
        const partPath = path.join(msgDirPath, filename);
        setTimeout(() => {
          void processPartFile(partPath);
        }, 50);
      }
    });

    activityWatcher.messageWatchers.set(msgDirPath, watcher);
    void scanMessageDir(msgDirPath);
  } catch {
  }
}

export function startActivityWatchJson(callback: ActivityCallback): void {
  if (activityWatcher.watcher) {
    activityWatcher.callback = callback;
    return;
  }

  activityWatcher.callback = callback;
  activityWatcher.seenParts.clear();

  try {
    activityWatcher.watcher = fsSync.watch(OPENCODE_PARTS_PATH, (eventType, filename) => {
      if (eventType === 'rename' && filename?.startsWith('msg_')) {
        const msgDirPath = path.join(OPENCODE_PARTS_PATH, filename);
        watchMessageDir(msgDirPath);
      }
    });
  } catch {
  }
}

export function stopActivityWatchJson(): void {
  if (activityWatcher.debounceTimer) {
    clearTimeout(activityWatcher.debounceTimer);
    activityWatcher.debounceTimer = null;
  }

  for (const watcher of activityWatcher.messageWatchers.values()) {
    watcher.close();
  }
  activityWatcher.messageWatchers.clear();

  if (activityWatcher.watcher) {
    activityWatcher.watcher.close();
    activityWatcher.watcher = null;
  }

  activityWatcher.callback = null;
  activityWatcher.seenParts.clear();
  activityWatcher.pendingDirs.clear();

  stopSessionWatcher();
}

export async function parseSessionsJson(
  options: SessionParseOptions,
  ctx: AgentFetchContext,
): Promise<SessionUsageData[]> {
  const limit = options.limit ?? 100;
  const since = (options as SessionParseOptions & { since?: number }).since;

  try {
    await fs.access(OPENCODE_STORAGE_PATH);
  } catch {
    ctx.logger.debug('No OpenCode storage directory found');
    return [];
  }

  startSessionWatcher();

  const now = Date.now();
  if (
    !options.sessionId &&
    limit === sessionCache.lastLimit &&
    now - sessionCache.lastCheck < CACHE_TTL_MS &&
    sessionCache.lastResult.length > 0 &&
    sessionCache.lastSince === since
  ) {
    ctx.logger.debug('JSON: using cached sessions (within TTL)', { count: sessionCache.lastResult.length });
    return sessionCache.lastResult;
  }

  const dirtyPaths = new Set(sessionWatcher.dirtyPaths);
  sessionWatcher.dirtyPaths.clear();

  const needsFullStat = consumeForceFullReconciliation();
  if (needsFullStat) {
    ctx.logger.debug('JSON: full reconciliation sweep triggered');
  }

  const sessions: SessionUsageData[] = [];
  const sessionFiles: Array<{ path: string; session: OpenCodeSession }> = [];

  let statCount = 0;
  let statSkipCount = 0;
  let parseCount = 0;
  let dirtyHitCount = 0;

  const seenFilePaths = new Set<string>();

  try {
    const projectDirs = await fs.readdir(OPENCODE_SESSIONS_PATH, { withFileTypes: true });

    for (const projectDir of projectDirs) {
      if (!projectDir.isDirectory()) continue;

      const projectPath = path.join(OPENCODE_SESSIONS_PATH, projectDir.name);

      watchProjectDir(projectPath);

      const sessionEntries = await fs.readdir(projectPath, { withFileTypes: true });

      for (const entry of sessionEntries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;

        const sessionFilePath = path.join(projectPath, entry.name);
        seenFilePaths.add(sessionFilePath);

        const isDirty = dirtyPaths.has(sessionFilePath);
        if (isDirty) dirtyHitCount++;

        const cached = sessionMetadataIndex.get(sessionFilePath);

        if (!isDirty && !needsFullStat && cached) {
          statSkipCount++;
          const session = cached.session;
          if (session?.id) {
            if (options.sessionId && session.id !== options.sessionId) continue;
            sessionFiles.push({ path: sessionFilePath, session });
          }
          continue;
        }

        statCount++;
        let mtimeMs: number;
        try {
          const stat = await fs.stat(sessionFilePath);
          mtimeMs = stat.mtimeMs;
        } catch {
          sessionMetadataIndex.delete(sessionFilePath);
          continue;
        }

        if (cached && cached.mtimeMs === mtimeMs) {
          const session = cached.session;
          if (session?.id) {
            if (options.sessionId && session.id !== options.sessionId) continue;
            sessionFiles.push({ path: sessionFilePath, session });
          }
          continue;
        }

        parseCount++;
        const session = await readJsonFile<OpenCodeSession>(sessionFilePath);

        if (session?.id) {
          sessionMetadataIndex.set(sessionFilePath, { mtimeMs, session });
          if (options.sessionId && session.id !== options.sessionId) continue;
          sessionFiles.push({ path: sessionFilePath, session });
        } else {
          sessionMetadataIndex.delete(sessionFilePath);
        }
      }
    }
  } catch (err) {
    ctx.logger.debug('JSON: failed to read session directories', { error: err });
    return sessions;
  }

  for (const cachedPath of sessionMetadataIndex.keys()) {
    if (!seenFilePaths.has(cachedPath)) {
      sessionMetadataIndex.delete(cachedPath);
    }
  }

  if (since) {
    for (let i = sessionFiles.length - 1; i >= 0; i--) {
      if (sessionFiles[i]!.session.time.updated < since) {
        sessionFiles.splice(i, 1);
      }
    }
  }

  sessionFiles.sort((a, b) => b.session.time.updated - a.session.time.updated);

  let aggregateCacheHits = 0;
  let aggregateCacheMisses = 0;

  for (const { session } of sessionFiles) {
    const cached = sessionAggregateCache.get(session.id);
    if (cached && cached.updatedAt === session.time.updated) {
      cached.lastAccessed = now;
      aggregateCacheHits++;
      sessions.push(...cached.usageRows);
      continue;
    }

    aggregateCacheMisses++;

    const messagesDir = path.join(OPENCODE_MESSAGES_PATH, session.id);

    try {
      await fs.access(messagesDir);
    } catch {
      continue;
    }

    const messageFiles = await fs.readdir(messagesDir, { withFileTypes: true });

    const messageData: Array<{ file: string; mtime: number }> = [];
    for (const msgFile of messageFiles) {
      if (!msgFile.isFile() || !msgFile.name.endsWith('.json')) continue;
      const msgPath = path.join(messagesDir, msgFile.name);
      try {
        const stat = await fs.stat(msgPath);
        messageData.push({ file: msgPath, mtime: stat.mtimeMs });
      } catch {
        continue;
      }
    }

    messageData.sort((a, b) => b.mtime - a.mtime);

    const sessionUsageRows: SessionUsageData[] = [];

    for (const { file: msgPath } of messageData) {
      const message = await readJsonFile<OpenCodeMessage>(msgPath);

      if (!message || message.role !== 'assistant' || !message.tokens) continue;

      const providerId = message.providerID ?? message.model?.providerID ?? 'unknown';
      const modelId = message.modelID ?? message.model?.modelID ?? 'unknown';

      const usage: SessionUsageData = {
        sessionId: session.id,
        providerId,
        modelId,
        tokens: {
          input: message.tokens.input ?? 0,
          output: message.tokens.output ?? 0,
        },
        timestamp: message.time.completed ?? message.time.created,
        sessionUpdatedAt: session.time.updated,
      };

      if (session.title) {
        usage.sessionName = session.title;
      }
      if (message.tokens.cache?.read) {
        usage.tokens.cacheRead = message.tokens.cache.read;
      }
      if (message.tokens.cache?.write) {
        usage.tokens.cacheWrite = message.tokens.cache.write;
      }
      if (session.directory) {
        usage.projectPath = session.directory;
      }

      sessionUsageRows.push(usage);
    }

    sessionAggregateCache.set(session.id, {
      updatedAt: session.time.updated,
      usageRows: sessionUsageRows,
      lastAccessed: now,
    });

    sessions.push(...sessionUsageRows);
  }

  evictSessionAggregateCache();

  if (!options.sessionId) {
    sessionCache.lastCheck = Date.now();
    sessionCache.lastResult = sessions;
    sessionCache.lastLimit = limit;
    sessionCache.lastSince = since;
  }

  ctx.logger.debug('JSON: parsed OpenCode sessions', {
    count: sessions.length,
    sessionFiles: sessionFiles.length,
    statChecks: statCount,
    statSkips: statSkipCount,
    jsonParses: parseCount,
    dirtyHits: dirtyHitCount,
    aggregateCacheHits,
    aggregateCacheMisses,
    metadataIndexSize: sessionMetadataIndex.size,
    aggregateCacheSize: sessionAggregateCache.size,
  });
  return sessions;
}
