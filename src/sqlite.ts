import { Database } from 'bun:sqlite';
import * as fsSync from 'fs';
import type {
  ActivityCallback,
  ActivityUpdate,
  AgentFetchContext,
  SessionParseOptions,
  SessionUsageData,
} from '@tokentop/plugin-sdk';
import { CACHE_TTL_MS, evictSessionAggregateCache, sessionAggregateCache, sessionCache } from './cache.ts';
import { OPENCODE_DB_PATH } from './paths.ts';
import type {
  JoinedMessageRow,
  OpenCodeMessage,
  OpenCodePart,
  PartRow,
  PreparedStatements,
  SessionRow,
} from './types.ts';

export { OPENCODE_DB_PATH };

let sqliteDb: InstanceType<typeof Database> | null = null;
let sqliteChecked = false;
let sqliteOpenedAt = 0;

export const WAL_RELEASE_INTERVAL_MS = 5 * 60 * 1000;

export function getDb(): InstanceType<typeof Database> | null {
  if (sqliteDb) {
    if (Date.now() - sqliteOpenedAt > WAL_RELEASE_INTERVAL_MS) {
      closeDb();
    } else {
      return sqliteDb;
    }
  }
  if (sqliteChecked && !sqliteDb) return null;

  try {
    if (!fsSync.existsSync(OPENCODE_DB_PATH)) {
      sqliteChecked = true;
      return null;
    }
    sqliteDb = new Database(OPENCODE_DB_PATH, { readonly: true, create: false });
    sqliteOpenedAt = Date.now();
    stmts = null;
    return sqliteDb;
  } catch {
    sqliteChecked = true;
    return null;
  }
}

export function closeDb(): void {
  if (sqliteDb) {
    try {
      sqliteDb.close();
    } catch {
    }
    sqliteDb = null;
    stmts = null;
  }
}

let stmts: PreparedStatements | null = null;

export function getStmts(db: InstanceType<typeof Database>): PreparedStatements {
  if (stmts) return stmts;

  const assistantFilter = `
    json_extract(m.data, '$.role') = 'assistant'
    AND json_extract(m.data, '$.tokens.input') IS NOT NULL`;

  stmts = {
    allSessions: db.prepare(
      'SELECT id, project_id, title, directory, time_created, time_updated FROM session ORDER BY time_updated DESC',
    ),
    sessionsSince: db.prepare(
      'SELECT id, project_id, title, directory, time_created, time_updated FROM session WHERE time_updated > ? ORDER BY time_updated DESC',
    ),
    oneSession: db.prepare(
      'SELECT id, project_id, title, directory, time_created, time_updated FROM session WHERE id = ?',
    ),
    sessionMessages: db.prepare(`
      SELECT s.id as sid, s.title, s.directory, s.time_updated, m.data
      FROM session s
      JOIN message m ON m.session_id = s.id
      WHERE s.id IN (SELECT value FROM json_each(?))
        AND ${assistantFilter}
      ORDER BY s.time_updated DESC, m.time_created DESC
    `),
    uncachedMessages: db.prepare(`
      SELECT s.id as sid, s.title, s.directory, s.time_updated, m.data
      FROM session s
      JOIN message m ON m.session_id = s.id
      WHERE ${assistantFilter}
      ORDER BY s.time_updated DESC, m.time_created DESC
    `),
    uncachedMessagesSince: db.prepare(`
      SELECT s.id as sid, s.title, s.directory, s.time_updated, m.data
      FROM session s
      JOIN message m ON m.session_id = s.id
      WHERE s.time_updated > ?
        AND ${assistantFilter}
      ORDER BY s.time_updated DESC, m.time_created DESC
    `),
    recentParts: db.prepare(
      'SELECT id, message_id, session_id, time_created, data FROM part WHERE time_created > ? ORDER BY time_created ASC',
    ),
  };

  return stmts;
}

export function parseSessionsSqlite(options: SessionParseOptions, ctx: AgentFetchContext): SessionUsageData[] {
  const db = getDb();
  if (!db) return [];

  const since = (options as SessionParseOptions & { since?: number }).since;
  const now = Date.now();

  if (
    !options.sessionId &&
    now - sessionCache.lastCheck < CACHE_TTL_MS &&
    sessionCache.lastResult.length > 0 &&
    sessionCache.lastSince === since
  ) {
    ctx.logger.debug('SQLite: using cached sessions (within TTL)', { count: sessionCache.lastResult.length });
    return sessionCache.lastResult;
  }

  try {
    const s = getStmts(db);
    const sessions: SessionUsageData[] = [];

    let sessionRows: SessionRow[];
    if (options.sessionId) {
      sessionRows = s.oneSession.all(options.sessionId) as SessionRow[];
    } else if (since) {
      sessionRows = s.sessionsSince.all(since) as SessionRow[];
    } else {
      sessionRows = s.allSessions.all() as SessionRow[];
    }

    let aggregateCacheHits = 0;
    let aggregateCacheMisses = 0;

    const uncachedSessionIds: string[] = [];
    for (const row of sessionRows) {
      const cached = sessionAggregateCache.get(row.id);
      if (cached && cached.updatedAt === row.time_updated) {
        cached.lastAccessed = now;
        aggregateCacheHits++;
        sessions.push(...cached.usageRows);
      } else {
        aggregateCacheMisses++;
        uncachedSessionIds.push(row.id);
      }
    }

    if (uncachedSessionIds.length > 0) {
      const sessionLookup = new Map<string, SessionRow>();
      for (const row of sessionRows) {
        if (uncachedSessionIds.includes(row.id)) {
          sessionLookup.set(row.id, row);
        }
      }

      let messageRows: JoinedMessageRow[];
      if (uncachedSessionIds.length === sessionRows.length && !options.sessionId) {
        messageRows = since
          ? (s.uncachedMessagesSince.all(since) as JoinedMessageRow[])
          : (s.uncachedMessages.all() as JoinedMessageRow[]);
      } else {
        messageRows = s.sessionMessages.all(JSON.stringify(uncachedSessionIds)) as JoinedMessageRow[];
      }

      const sessionUsageMap = new Map<string, SessionUsageData[]>();

      for (const msgRow of messageRows) {
        let msgData: OpenCodeMessage;
        try {
          msgData = JSON.parse(msgRow.data) as OpenCodeMessage;
        } catch {
          continue;
        }

        if (!msgData.tokens) continue;

        const providerId = msgData.providerID ?? msgData.model?.providerID ?? 'unknown';
        const modelId = msgData.modelID ?? msgData.model?.modelID ?? 'unknown';

        const usage: SessionUsageData = {
          sessionId: msgRow.sid,
          providerId,
          modelId,
          tokens: {
            input: msgData.tokens.input ?? 0,
            output: msgData.tokens.output ?? 0,
          },
          timestamp: msgData.time.completed ?? msgData.time.created,
          sessionUpdatedAt: msgRow.time_updated,
        };

        if (msgRow.title) usage.sessionName = msgRow.title;
        if (msgData.tokens.cache?.read) usage.tokens.cacheRead = msgData.tokens.cache.read;
        if (msgData.tokens.cache?.write) usage.tokens.cacheWrite = msgData.tokens.cache.write;
        if (msgRow.directory) usage.projectPath = msgRow.directory;

        let arr = sessionUsageMap.get(msgRow.sid);
        if (!arr) {
          arr = [];
          sessionUsageMap.set(msgRow.sid, arr);
        }
        arr.push(usage);
      }

      for (const [sid, usageRows] of sessionUsageMap) {
        const row = sessionLookup.get(sid);
        sessionAggregateCache.set(sid, {
          updatedAt: row?.time_updated ?? 0,
          usageRows,
          lastAccessed: now,
        });
        sessions.push(...usageRows);
      }

      for (const sid of uncachedSessionIds) {
        if (!sessionUsageMap.has(sid)) {
          const row = sessionLookup.get(sid);
          sessionAggregateCache.set(sid, {
            updatedAt: row?.time_updated ?? 0,
            usageRows: [],
            lastAccessed: now,
          });
        }
      }
    }

    evictSessionAggregateCache();

    if (!options.sessionId) {
      sessionCache.lastCheck = Date.now();
      sessionCache.lastResult = sessions;
      sessionCache.lastLimit = options.limit ?? 100;
      sessionCache.lastSince = since;
    }

    ctx.logger.debug('SQLite: parsed sessions', {
      count: sessions.length,
      sessionRows: sessionRows.length,
      aggregateCacheHits,
      aggregateCacheMisses,
      aggregateCacheSize: sessionAggregateCache.size,
    });

    return sessions;
  } catch (err) {
    ctx.logger.debug('SQLite: query failed, falling back to JSON', { error: err });
    closeDb();
    sqliteChecked = false;
    return [];
  }
}

interface SqliteActivityState {
  timer: ReturnType<typeof setInterval> | null;
  callback: ActivityCallback | null;
  lastPartTime: number;
}

const sqliteActivity: SqliteActivityState = {
  timer: null,
  callback: null,
  lastPartTime: 0,
};

export const SQLITE_POLL_INTERVAL_MS = 1000;

export function startActivityWatchSqlite(callback: ActivityCallback): void {
  sqliteActivity.callback = callback;

  if (sqliteActivity.timer) return;

  sqliteActivity.lastPartTime = Date.now();

  sqliteActivity.timer = setInterval(() => {
    const db = getDb();
    if (!db || !sqliteActivity.callback) return;

    try {
      const s = getStmts(db);
      const rows = s.recentParts.all(sqliteActivity.lastPartTime) as PartRow[];

      for (const row of rows) {
        if (row.time_created > sqliteActivity.lastPartTime) {
          sqliteActivity.lastPartTime = row.time_created;
        }

        let partData: OpenCodePart;
        try {
          partData = JSON.parse(row.data) as OpenCodePart;
        } catch {
          continue;
        }

        if (!partData.tokens) continue;

        const tokens: ActivityUpdate['tokens'] = {
          input: partData.tokens.input ?? 0,
          output: partData.tokens.output ?? 0,
        };
        if (partData.tokens.reasoning !== undefined) tokens.reasoning = partData.tokens.reasoning;
        if (partData.tokens.cache?.read !== undefined) tokens.cacheRead = partData.tokens.cache.read;
        if (partData.tokens.cache?.write !== undefined) tokens.cacheWrite = partData.tokens.cache.write;

        sqliteActivity.callback({
          sessionId: row.session_id,
          messageId: row.message_id,
          tokens,
          timestamp: row.time_created,
        });
      }
    } catch {
    }
  }, SQLITE_POLL_INTERVAL_MS);
}

export function stopActivityWatchSqlite(): void {
  if (sqliteActivity.timer) {
    clearInterval(sqliteActivity.timer);
    sqliteActivity.timer = null;
  }
  sqliteActivity.callback = null;
  sqliteActivity.lastPartTime = 0;
}
