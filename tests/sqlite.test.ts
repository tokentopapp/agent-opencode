import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import type { AgentFetchContext, SessionUsageData } from '@tokentop/plugin-sdk';
import { createTestContext } from '@tokentop/plugin-sdk/testing';
import { sessionAggregateCache, sessionCache } from '../src/cache.ts';
import {
  MESSAGE_PENDING_MAX_AGE_MS,
  detectSchema,
  parseSessionsSqlite,
  pollMessageActivity,
  type MessageActivityState,
} from '../src/sqlite.ts';

type Db = InstanceType<typeof Database>;

const V1_SCHEMA = `
  CREATE TABLE session (
    id text PRIMARY KEY, project_id text NOT NULL, directory text NOT NULL, title text NOT NULL,
    time_created integer NOT NULL, time_updated integer NOT NULL
  );
  CREATE TABLE message (
    id text PRIMARY KEY, session_id text NOT NULL,
    time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
  );
  CREATE TABLE part (
    id text PRIMARY KEY, message_id text NOT NULL, session_id text NOT NULL,
    time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
  );
`;

const V2_SCHEMA = `
  CREATE TABLE session_v2 (
    id text PRIMARY KEY, project_id text NOT NULL, directory text NOT NULL, title text,
    time_created integer NOT NULL, time_updated integer NOT NULL
  );
  CREATE TABLE session_message (
    id text PRIMARY KEY, session_id text NOT NULL, type text NOT NULL, seq integer NOT NULL,
    time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
  );
  CREATE TABLE session_part (
    message_id text NOT NULL, session_id text NOT NULL, ordinal integer NOT NULL, type text NOT NULL,
    time_created integer NOT NULL, time_updated integer NOT NULL, data text NOT NULL
  );
`;

const openDbs: Db[] = [];

function createDb(...schemas: string[]): Db {
  const db = new Database(':memory:');
  for (const schema of schemas) db.exec(schema);
  openDbs.push(db);
  return db;
}

function insertSession(db: Db, table: 'session' | 'session_v2', id: string, updated: number, title: string | null = id): void {
  db.prepare(
    `INSERT INTO ${table} (id, project_id, directory, title, time_created, time_updated) VALUES (?, 'proj', '/work/repo', ?, 1000, ?)`,
  ).run(id, title, updated);
}

function insertV1Message(db: Db, id: string, sessionId: string, data: Record<string, unknown>, created = 1000): void {
  db.prepare('INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)').run(
    id,
    sessionId,
    created,
    created,
    JSON.stringify(data),
  );
}

let v2Seq = 0;

function insertV2Message(
  db: Db,
  id: string,
  sessionId: string,
  type: string,
  data: Record<string, unknown>,
  created = 1000,
  updated = created,
): void {
  db.prepare(
    'INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, sessionId, type, v2Seq++, created, updated, JSON.stringify(data));
}

function v1Assistant(output: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role: 'assistant',
    providerID: 'anthropic',
    modelID: 'claude-v1',
    time: { created: 1000, completed: 2000 },
    tokens: { input: 10, output, reasoning: 0, cache: { read: 5, write: 3 } },
    ...extra,
  };
}

function v2Assistant(output: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    time: { created: 1000, completed: 3000 },
    agent: 'build',
    model: { id: 'claude-v2', providerID: 'anthropic', variant: 'medium' },
    content: [{ type: 'text', text: 'hello' }],
    cost: 0.01,
    tokens: { input: 20, output, reasoning: 4, cache: { read: 7, write: 0 } },
    ...extra,
  };
}

function parse(db: Db, options: { sessionId?: string; since?: number } = {}): SessionUsageData[] {
  const ctx = createTestContext() as unknown as AgentFetchContext;
  return parseSessionsSqlite(options, ctx, db);
}

function outputsFor(rows: SessionUsageData[], sessionId: string): number[] {
  return rows
    .filter((row) => row.sessionId === sessionId)
    .map((row) => row.tokens.output)
    .sort((a, b) => a - b);
}

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  sessionAggregateCache.clear();
  sessionCache.lastCheck = 0;
  sessionCache.lastResult = [];
  sessionCache.lastLimit = 0;
  sessionCache.lastSince = undefined;
});

describe('detectSchema', () => {
  test('detects an OpenCode 1.x database', () => {
    expect(detectSchema(createDb(V1_SCHEMA))).toEqual({ v1: true, v1Parts: true, v2: false });
  });

  test('detects an OpenCode 2.x database', () => {
    expect(detectSchema(createDb(V2_SCHEMA))).toEqual({ v1: false, v1Parts: false, v2: true });
  });

  test('detects an upgraded database holding both layouts', () => {
    expect(detectSchema(createDb(V1_SCHEMA, V2_SCHEMA))).toEqual({ v1: true, v1Parts: true, v2: true });
  });

  test('reports nothing for an unrelated database', () => {
    expect(detectSchema(createDb('CREATE TABLE other (id text)'))).toEqual({ v1: false, v1Parts: false, v2: false });
  });
});

describe('parseSessionsSqlite with OpenCode 1.x tables', () => {
  test('parses assistant messages with token data', () => {
    const db = createDb(V1_SCHEMA);
    insertSession(db, 'session', 'ses_a', 5000, 'First session');
    insertV1Message(db, 'msg_1', 'ses_a', v1Assistant(100));
    insertV1Message(db, 'msg_2', 'ses_a', { role: 'user', time: { created: 900 } });
    insertV1Message(db, 'msg_3', 'ses_a', { role: 'assistant', time: { created: 950 } });

    expect(parse(db)).toEqual([
      {
        sessionId: 'ses_a',
        providerId: 'anthropic',
        modelId: 'claude-v1',
        tokens: { input: 10, output: 100, cacheRead: 5, cacheWrite: 3 },
        timestamp: 2000,
        sessionUpdatedAt: 5000,
        sessionName: 'First session',
        projectPath: '/work/repo',
      },
    ]);
  });

  test('reads provider and model from the nested model object', () => {
    const db = createDb(V1_SCHEMA);
    insertSession(db, 'session', 'ses_a', 5000);
    insertV1Message(
      db,
      'msg_1',
      'ses_a',
      v1Assistant(100, { providerID: undefined, modelID: undefined, model: { providerID: 'openai', modelID: 'gpt-x' } }),
    );

    const [row] = parse(db);
    expect(row?.providerId).toBe('openai');
    expect(row?.modelId).toBe('gpt-x');
  });
});

describe('parseSessionsSqlite with OpenCode 2.x tables', () => {
  test('parses assistant messages identified by the type column', () => {
    const db = createDb(V2_SCHEMA);
    insertSession(db, 'session_v2', 'ses_b', 6000, 'Second session');
    insertV2Message(db, 'msg_1', 'ses_b', 'assistant', v2Assistant(200));
    insertV2Message(db, 'msg_2', 'ses_b', 'user', { time: { created: 900 }, text: 'hi' });
    insertV2Message(db, 'msg_3', 'ses_b', 'system', { time: { created: 900 } });
    insertV2Message(db, 'msg_4', 'ses_b', 'assistant', { time: { created: 950 }, model: { id: 'claude-v2' } });

    expect(parse(db)).toEqual([
      {
        sessionId: 'ses_b',
        providerId: 'anthropic',
        modelId: 'claude-v2',
        tokens: { input: 20, output: 200, cacheRead: 7 },
        timestamp: 3000,
        sessionUpdatedAt: 6000,
        sessionName: 'Second session',
        projectPath: '/work/repo',
      },
    ]);
  });

  test('handles sessions without a title', () => {
    const db = createDb(V2_SCHEMA);
    insertSession(db, 'session_v2', 'ses_b', 6000, null);
    insertV2Message(db, 'msg_1', 'ses_b', 'assistant', v2Assistant(200));

    const [row] = parse(db);
    expect(row?.sessionId).toBe('ses_b');
    expect(row?.sessionName).toBeUndefined();
  });

  test('falls back to the message start time while a message has no completion time', () => {
    const db = createDb(V2_SCHEMA);
    insertSession(db, 'session_v2', 'ses_b', 6000);
    insertV2Message(db, 'msg_1', 'ses_b', 'assistant', v2Assistant(200, { time: { created: 1234 } }));

    expect(parse(db)[0]?.timestamp).toBe(1234);
  });
});

describe('parseSessionsSqlite with both layouts', () => {
  test('returns 1.x-only and 2.x-only sessions together', () => {
    const db = createDb(V1_SCHEMA, V2_SCHEMA);
    insertSession(db, 'session', 'ses_old', 5000);
    insertV1Message(db, 'msg_old', 'ses_old', v1Assistant(100));
    insertSession(db, 'session_v2', 'ses_new', 6000);
    insertV2Message(db, 'msg_new', 'ses_new', 'assistant', v2Assistant(200));

    const rows = parse(db);
    expect(outputsFor(rows, 'ses_old')).toEqual([100]);
    expect(outputsFor(rows, 'ses_new')).toEqual([200]);
    expect(rows.map((row) => row.sessionId)).toEqual(['ses_new', 'ses_old']);
  });

  test('does not double count a migrated session and keeps messages the migration dropped', () => {
    const db = createDb(V1_SCHEMA, V2_SCHEMA);
    insertSession(db, 'session', 'ses_mig', 5000);
    insertSession(db, 'session_v2', 'ses_mig', 5000);
    insertV1Message(db, 'msg_1', 'ses_mig', v1Assistant(100));
    insertV1Message(db, 'msg_dropped', 'ses_mig', v1Assistant(150));
    insertV2Message(db, 'msg_1', 'ses_mig', 'assistant', v2Assistant(100));

    const rows = parse(db);
    expect(outputsFor(rows, 'ses_mig')).toEqual([100, 150]);
    expect(rows.find((row) => row.tokens.output === 100)?.modelId).toBe('claude-v2');
    expect(rows.find((row) => row.tokens.output === 150)?.modelId).toBe('claude-v1');
  });

  test('includes 2.x messages added to a migrated session', () => {
    const db = createDb(V1_SCHEMA, V2_SCHEMA);
    insertSession(db, 'session', 'ses_mig', 5000, 'Old title');
    insertSession(db, 'session_v2', 'ses_mig', 9000, 'New title');
    insertV1Message(db, 'msg_1', 'ses_mig', v1Assistant(100));
    insertV2Message(db, 'msg_1', 'ses_mig', 'assistant', v2Assistant(100));
    insertV2Message(db, 'msg_2', 'ses_mig', 'assistant', v2Assistant(300));

    const rows = parse(db);
    expect(outputsFor(rows, 'ses_mig')).toEqual([100, 300]);
    expect(rows.every((row) => row.sessionName === 'New title' && row.sessionUpdatedAt === 9000)).toBe(true);
  });

  test('uses the 1.x session metadata when 1.x is still the active writer', () => {
    const db = createDb(V1_SCHEMA, V2_SCHEMA);
    insertSession(db, 'session', 'ses_live', 9000, 'Live title');
    insertSession(db, 'session_v2', 'ses_live', 5000, 'Stale title');
    insertV1Message(db, 'msg_1', 'ses_live', v1Assistant(100));
    insertV1Message(db, 'msg_2', 'ses_live', v1Assistant(120));

    const rows = parse(db);
    expect(outputsFor(rows, 'ses_live')).toEqual([100, 120]);
    expect(rows.every((row) => row.sessionName === 'Live title' && row.sessionUpdatedAt === 9000)).toBe(true);
  });

  test('works when the 2.x tables exist but are empty', () => {
    const db = createDb(V1_SCHEMA, V2_SCHEMA);
    insertSession(db, 'session', 'ses_old', 5000);
    insertV1Message(db, 'msg_old', 'ses_old', v1Assistant(100));

    expect(outputsFor(parse(db), 'ses_old')).toEqual([100]);
  });

  test('filters by sessionId across both layouts', () => {
    const db = createDb(V1_SCHEMA, V2_SCHEMA);
    insertSession(db, 'session', 'ses_old', 5000);
    insertV1Message(db, 'msg_old', 'ses_old', v1Assistant(100));
    insertSession(db, 'session_v2', 'ses_new', 6000);
    insertV2Message(db, 'msg_new', 'ses_new', 'assistant', v2Assistant(200));

    expect(parse(db, { sessionId: 'ses_old' }).map((row) => row.sessionId)).toEqual(['ses_old']);
    expect(parse(db, { sessionId: 'ses_new' }).map((row) => row.sessionId)).toEqual(['ses_new']);
  });

  test('filters by since across both layouts', () => {
    const db = createDb(V1_SCHEMA, V2_SCHEMA);
    insertSession(db, 'session', 'ses_old', 5000);
    insertV1Message(db, 'msg_old', 'ses_old', v1Assistant(100));
    insertSession(db, 'session', 'ses_recent', 7000);
    insertV1Message(db, 'msg_recent', 'ses_recent', v1Assistant(110));
    insertSession(db, 'session_v2', 'ses_new', 8000);
    insertV2Message(db, 'msg_new', 'ses_new', 'assistant', v2Assistant(200));

    expect(parse(db, { since: 6000 }).map((row) => row.sessionId)).toEqual(['ses_new', 'ses_recent']);
  });

  test('re-reads a session after it is updated', () => {
    const db = createDb(V2_SCHEMA);
    insertSession(db, 'session_v2', 'ses_b', 6000);
    insertV2Message(db, 'msg_1', 'ses_b', 'assistant', v2Assistant(200));
    expect(outputsFor(parse(db, { sessionId: 'ses_b' }), 'ses_b')).toEqual([200]);

    insertV2Message(db, 'msg_2', 'ses_b', 'assistant', v2Assistant(250));
    expect(outputsFor(parse(db, { sessionId: 'ses_b' }), 'ses_b')).toEqual([200]);

    db.prepare('UPDATE session_v2 SET time_updated = 7000 WHERE id = ?').run('ses_b');
    expect(outputsFor(parse(db, { sessionId: 'ses_b' }), 'ses_b')).toEqual([200, 250]);
  });
});

describe('pollMessageActivity', () => {
  function newState(watermark = 0): MessageActivityState {
    return { watermark, emitted: new Map() };
  }

  test('returns nothing for a database without 2.x tables', () => {
    expect(pollMessageActivity(createDb(V1_SCHEMA), newState(), 10_000)).toEqual([]);
  });

  test('emits a completed assistant message once', () => {
    const db = createDb(V2_SCHEMA);
    const state = newState(500);
    insertV2Message(db, 'msg_1', 'ses_b', 'assistant', v2Assistant(200), 1000, 3000);
    insertV2Message(db, 'msg_2', 'ses_b', 'user', { time: { created: 1000 }, text: 'hi' }, 1000);

    expect(pollMessageActivity(db, state, 4000)).toEqual([
      {
        sessionId: 'ses_b',
        messageId: 'msg_1',
        tokens: { input: 20, output: 200, reasoning: 4, cacheRead: 7, cacheWrite: 0 },
        timestamp: 3000,
      },
    ]);
    expect(state.watermark).toBe(1000);
    expect(pollMessageActivity(db, state, 5000)).toEqual([]);
  });

  test('ignores messages created before the watermark', () => {
    const db = createDb(V2_SCHEMA);
    insertV2Message(db, 'msg_1', 'ses_b', 'assistant', v2Assistant(200), 1000, 3000);

    expect(pollMessageActivity(db, newState(1000), 4000)).toEqual([]);
  });

  test('waits for an in-flight message and emits it when its tokens are written', () => {
    const db = createDb(V2_SCHEMA);
    const state = newState(500);
    insertV2Message(db, 'msg_1', 'ses_b', 'assistant', { time: { created: 1000 }, model: { id: 'claude-v2' } }, 1000);
    insertV2Message(db, 'msg_2', 'ses_b', 'assistant', v2Assistant(90), 1500, 1800);

    expect(pollMessageActivity(db, state, 2000).map((update) => update.messageId)).toEqual(['msg_2']);
    expect(state.watermark).toBe(999);
    expect(pollMessageActivity(db, state, 2500)).toEqual([]);

    db.prepare('UPDATE session_message SET time_updated = 3000, data = ? WHERE id = ?').run(
      JSON.stringify(v2Assistant(200)),
      'msg_1',
    );

    expect(pollMessageActivity(db, state, 3500).map((update) => update.messageId)).toEqual(['msg_1']);
    expect(state.watermark).toBe(1500);
    expect(state.emitted.size).toBe(0);
    expect(pollMessageActivity(db, state, 4000)).toEqual([]);
  });

  test('stops waiting for messages that errored', () => {
    const db = createDb(V2_SCHEMA);
    const state = newState(500);
    insertV2Message(db, 'msg_1', 'ses_b', 'assistant', { time: { created: 1000 }, error: { name: 'Aborted' } }, 1000);

    expect(pollMessageActivity(db, state, 2000)).toEqual([]);
    expect(state.watermark).toBe(1000);
  });

  test('stops waiting for messages that never complete', () => {
    const db = createDb(V2_SCHEMA);
    const state = newState(500);
    insertV2Message(db, 'msg_1', 'ses_b', 'assistant', { time: { created: 1000 } }, 1000);

    pollMessageActivity(db, state, 2000);
    expect(state.watermark).toBe(999);

    pollMessageActivity(db, state, 1000 + MESSAGE_PENDING_MAX_AGE_MS + 1);
    expect(state.watermark).toBe(1000);
  });
});
