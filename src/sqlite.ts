import { Database } from 'bun:sqlite';
import * as fsSync from 'fs';
import type {
  ActivityCallback,
  ActivityUpdate,
  AgentFetchContext,
  SessionParseOptions,
  SessionUsageData,
} from '@tokentop/plugin-sdk';
import {
  CACHE_TTL_MS,
  evictSessionAggregateCache,
  invalidateSessionCaches,
  sessionAggregateCache,
  sessionCache,
} from './cache.ts';
import { OPENCODE_DB_PATH } from './paths.ts';
import type {
  MessageActivityRow,
  MessageUsageRow,
  OpenCodePart,
  PartRow,
  PreparedStatements,
  SessionRow,
  SourceStatements,
  SqliteSchema,
} from './types.ts';

export { OPENCODE_DB_PATH };

type Db = InstanceType<typeof Database>;

let sqliteDb: Db | null = null;
let sqliteChecked = false;
let sqliteOpenedAt = 0;

export const WAL_RELEASE_INTERVAL_MS = 5 * 60 * 1000;

export function getDb(): Db | null {
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
let stmtsDb: Db | null = null;

/**
 * OpenCode 1.x stores sessions in `session` / `message` / `part`. OpenCode 2.x
 * stores them in `session_v2` / `session_message`. Late 1.x releases already
 * created the 2.x tables, and the 2.x upgrade leaves the 1.x tables in place,
 * so the presence of one layout says nothing about the other.
 */
export function detectSchema(db: Db): SqliteSchema {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session', 'message', 'part', 'session_v2', 'session_message')",
    )
    .all() as Array<{ name: string }>;
  const names = new Set(rows.map((row) => row.name));

  return {
    v1: names.has('session') && names.has('message'),
    v1Parts: names.has('part'),
    v2: names.has('session_v2') && names.has('session_message'),
  };
}

const SESSION_COLUMNS = 'id, project_id, title, directory, time_created, time_updated';

interface SourceDefinition {
  sessionTable: string;
  messageTable: string;
  assistantFilter: string;
  providerId: string;
  modelId: string;
}

const V1_SOURCE: SourceDefinition = {
  sessionTable: 'session',
  messageTable: 'message',
  assistantFilter: "json_extract(m.data, '$.role') = 'assistant'",
  providerId: "coalesce(json_extract(m.data, '$.providerID'), json_extract(m.data, '$.model.providerID'))",
  modelId: "coalesce(json_extract(m.data, '$.modelID'), json_extract(m.data, '$.model.modelID'))",
};

const V2_SOURCE: SourceDefinition = {
  sessionTable: 'session_v2',
  messageTable: 'session_message',
  assistantFilter: "m.type = 'assistant'",
  providerId: "json_extract(m.data, '$.model.providerID')",
  modelId: "json_extract(m.data, '$.model.id')",
};

function prepareSource(db: Db, source: SourceDefinition): SourceStatements {
  // Usage fields are projected in SQL: 2.x message rows embed the full message
  // content, which is far too large to pull into memory for every message.
  const messageSelect = `
    SELECT m.id, m.session_id,
      ${source.providerId} AS provider_id,
      ${source.modelId} AS model_id,
      json_extract(m.data, '$.tokens.input') AS tokens_input,
      json_extract(m.data, '$.tokens.output') AS tokens_output,
      json_extract(m.data, '$.tokens.cache.read') AS cache_read,
      json_extract(m.data, '$.tokens.cache.write') AS cache_write,
      coalesce(json_extract(m.data, '$.time.completed'), json_extract(m.data, '$.time.created'), m.time_created) AS timestamp
    FROM ${source.messageTable} m
    WHERE ${source.assistantFilter}
      AND json_extract(m.data, '$.tokens.input') IS NOT NULL`;

  return {
    allSessions: db.prepare(`SELECT ${SESSION_COLUMNS} FROM ${source.sessionTable}`),
    sessionsSince: db.prepare(`SELECT ${SESSION_COLUMNS} FROM ${source.sessionTable} WHERE time_updated > ?`),
    oneSession: db.prepare(`SELECT ${SESSION_COLUMNS} FROM ${source.sessionTable} WHERE id = ?`),
    sessionMessages: db.prepare(`${messageSelect} AND m.session_id IN (SELECT value FROM json_each(?))`),
    allMessages: db.prepare(messageSelect),
  };
}

export function getStmts(db: Db): PreparedStatements {
  if (stmts && stmtsDb === db) return stmts;

  const schema = detectSchema(db);

  stmts = {
    schema,
    v1: schema.v1 ? prepareSource(db, V1_SOURCE) : null,
    v2: schema.v2 ? prepareSource(db, V2_SOURCE) : null,
    recentParts: schema.v1Parts
      ? db.prepare(
          'SELECT id, message_id, session_id, time_created, data FROM part WHERE time_created > ? ORDER BY time_created ASC',
        )
      : null,
    recentMessages: schema.v2
      ? db.prepare(`
          SELECT id, session_id, time_created, time_updated,
            json_extract(data, '$.tokens.input') AS tokens_input,
            json_extract(data, '$.tokens.output') AS tokens_output,
            json_extract(data, '$.tokens.reasoning') AS tokens_reasoning,
            json_extract(data, '$.tokens.cache.read') AS cache_read,
            json_extract(data, '$.tokens.cache.write') AS cache_write,
            json_extract(data, '$.time.completed') AS time_completed,
            json_extract(data, '$.error') IS NOT NULL AS errored
          FROM session_message
          WHERE time_created > ? AND type = 'assistant'
          ORDER BY time_created ASC
        `)
      : null,
  };
  stmtsDb = db;

  return stmts;
}

function loadSessionRows(s: PreparedStatements, sessionId: string | undefined, since: number | undefined): SessionRow[] {
  const merged = new Map<string, SessionRow>();

  // A session can exist in both layouts; the most recently updated copy
  // describes it, with 2.x winning ties.
  for (const source of [s.v2, s.v1]) {
    if (!source) continue;

    let rows: SessionRow[];
    if (sessionId) {
      rows = source.oneSession.all(sessionId) as SessionRow[];
    } else if (since) {
      rows = source.sessionsSince.all(since) as SessionRow[];
    } else {
      rows = source.allSessions.all() as SessionRow[];
    }

    for (const row of rows) {
      const existing = merged.get(row.id);
      if (!existing || row.time_updated > existing.time_updated) {
        merged.set(row.id, row);
      }
    }
  }

  return Array.from(merged.values()).sort((a, b) => b.time_updated - a.time_updated);
}

function loadMessageRows(s: PreparedStatements, sessionIds: string[] | null): MessageUsageRow[] {
  const seen = new Set<string>();
  const merged: MessageUsageRow[] = [];
  const idsParam = sessionIds ? JSON.stringify(sessionIds) : null;

  // Message ids survive the 1.x -> 2.x migration, but not every 1.x message is
  // carried over. Take the 2.x copy when both exist and keep 1.x-only messages.
  for (const source of [s.v2, s.v1]) {
    if (!source) continue;

    const rows = (idsParam ? source.sessionMessages.all(idsParam) : source.allMessages.all()) as MessageUsageRow[];
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      merged.push(row);
    }
  }

  return merged;
}

export function parseSessionsSqlite(
  options: SessionParseOptions,
  ctx: AgentFetchContext,
  db: Db | null = getDb(),
): SessionUsageData[] {
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

    const sessionRows = loadSessionRows(s, options.sessionId, since);

    let aggregateCacheHits = 0;
    let aggregateCacheMisses = 0;

    const uncachedSessions = new Map<string, SessionRow>();
    for (const row of sessionRows) {
      const cached = sessionAggregateCache.get(row.id);
      if (cached && cached.updatedAt === row.time_updated) {
        cached.lastAccessed = now;
        aggregateCacheHits++;
        sessions.push(...cached.usageRows);
      } else {
        aggregateCacheMisses++;
        uncachedSessions.set(row.id, row);
      }
    }

    if (uncachedSessions.size > 0) {
      const scanAll = uncachedSessions.size === sessionRows.length && !options.sessionId && !since;
      const messageRows = loadMessageRows(s, scanAll ? null : Array.from(uncachedSessions.keys()));

      const sessionUsageMap = new Map<string, SessionUsageData[]>();

      for (const msgRow of messageRows) {
        const sessionRow = uncachedSessions.get(msgRow.session_id);
        if (!sessionRow) continue;

        const usage: SessionUsageData = {
          sessionId: sessionRow.id,
          providerId: msgRow.provider_id ?? 'unknown',
          modelId: msgRow.model_id ?? 'unknown',
          tokens: {
            input: msgRow.tokens_input ?? 0,
            output: msgRow.tokens_output ?? 0,
          },
          timestamp: msgRow.timestamp,
          sessionUpdatedAt: sessionRow.time_updated,
        };

        if (sessionRow.title) usage.sessionName = sessionRow.title;
        if (msgRow.cache_read) usage.tokens.cacheRead = msgRow.cache_read;
        if (msgRow.cache_write) usage.tokens.cacheWrite = msgRow.cache_write;
        if (sessionRow.directory) usage.projectPath = sessionRow.directory;

        let arr = sessionUsageMap.get(sessionRow.id);
        if (!arr) {
          arr = [];
          sessionUsageMap.set(sessionRow.id, arr);
        }
        arr.push(usage);
      }

      for (const [sid, row] of uncachedSessions) {
        const usageRows = sessionUsageMap.get(sid) ?? [];
        usageRows.sort((a, b) => b.timestamp - a.timestamp);
        sessionAggregateCache.set(sid, {
          updatedAt: row.time_updated,
          usageRows,
          lastAccessed: now,
        });
        sessions.push(...usageRows);
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
      schema: s.schema,
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

export interface MessageActivityState {
  watermark: number;
  emitted: Map<string, number>;
}

interface SqliteActivityState {
  timer: ReturnType<typeof setInterval> | null;
  callback: ActivityCallback | null;
  lastPartTime: number;
  messages: MessageActivityState;
}

const sqliteActivity: SqliteActivityState = {
  timer: null,
  callback: null,
  lastPartTime: 0,
  messages: { watermark: 0, emitted: new Map() },
};

export const SQLITE_POLL_INTERVAL_MS = 1000;

/** How long an assistant message that never completes keeps being re-read. */
export const MESSAGE_PENDING_MAX_AGE_MS = 30 * 60 * 1000;

function pollPartActivity(s: PreparedStatements, callback: ActivityCallback): void {
  if (!s.recentParts) return;

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

    invalidateSessionCaches(row.session_id);

    callback({
      sessionId: row.session_id,
      messageId: row.message_id,
      tokens,
      timestamp: row.time_created,
    });
  }
}

/**
 * OpenCode 2.x has no token-bearing part rows: token counts are written onto
 * the assistant message row, which is created when the step starts and updated
 * when it finishes. Only `time_created` is indexed, so the watermark trails the
 * oldest message that is still in flight and those rows are re-read until they
 * settle.
 */
export function pollMessageActivity(
  db: Db,
  state: MessageActivityState,
  now: number = Date.now(),
): ActivityUpdate[] {
  const s = getStmts(db);
  if (!s.recentMessages) return [];

  const rows = s.recentMessages.all(state.watermark) as MessageActivityRow[];
  const updates: ActivityUpdate[] = [];
  const createdAt = new Map<string, number>();

  let newest = state.watermark;
  let oldestPending = Number.POSITIVE_INFINITY;

  for (const row of rows) {
    createdAt.set(row.id, row.time_created);
    if (row.time_created > newest) newest = row.time_created;

    const settled =
      row.time_completed !== null || row.errored === 1 || now - row.time_created > MESSAGE_PENDING_MAX_AGE_MS;
    if (!settled && row.time_created < oldestPending) oldestPending = row.time_created;

    if (row.tokens_input === null) continue;
    if (state.emitted.get(row.id) === row.time_updated) continue;
    state.emitted.set(row.id, row.time_updated);

    const tokens: ActivityUpdate['tokens'] = {
      input: row.tokens_input,
      output: row.tokens_output ?? 0,
    };
    if (row.tokens_reasoning !== null) tokens.reasoning = row.tokens_reasoning;
    if (row.cache_read !== null) tokens.cacheRead = row.cache_read;
    if (row.cache_write !== null) tokens.cacheWrite = row.cache_write;

    updates.push({
      sessionId: row.session_id,
      messageId: row.id,
      tokens,
      timestamp: row.time_completed ?? row.time_updated,
    });
  }

  state.watermark = Number.isFinite(oldestPending) ? oldestPending - 1 : newest;

  for (const id of state.emitted.keys()) {
    const created = createdAt.get(id);
    if (created === undefined || created <= state.watermark) state.emitted.delete(id);
  }

  return updates;
}

export function startActivityWatchSqlite(callback: ActivityCallback): void {
  sqliteActivity.callback = callback;

  if (sqliteActivity.timer) return;

  sqliteActivity.lastPartTime = Date.now();
  sqliteActivity.messages = { watermark: Date.now(), emitted: new Map() };

  sqliteActivity.timer = setInterval(() => {
    const db = getDb();
    if (!db || !sqliteActivity.callback) return;

    try {
      pollPartActivity(getStmts(db), sqliteActivity.callback);
    } catch {
    }

    try {
      for (const update of pollMessageActivity(db, sqliteActivity.messages)) {
        invalidateSessionCaches(update.sessionId);
        sqliteActivity.callback(update);
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
  sqliteActivity.messages = { watermark: 0, emitted: new Map() };
}
