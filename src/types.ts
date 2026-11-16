import type { Database } from 'bun:sqlite';
import type { SessionUsageData } from '@tokentop/plugin-sdk';

export interface OpenCodeAuthEntry {
  type: 'api' | 'oauth' | 'codex' | 'github' | 'wellknown';
  key?: string;
  access?: string;
  refresh?: string;
  expires?: number;
  token?: string;
  accessToken?: string;
  refreshToken?: string;
  accountId?: string;
  expiresAt?: number;
}

export interface OpenCodeConfig {
  provider?: Record<string, {
    name?: string;
    key?: string;
    enabled?: boolean;
    options?: {
      apiKey?: string;
      [key: string]: unknown;
    };
  }>;
}

export interface OpenCodeMessageTokens {
  input: number;
  output: number;
  reasoning?: number;
  cache?: {
    read: number;
    write: number;
  };
}

export interface OpenCodeMessage {
  id: string;
  sessionID: string;
  role: 'user' | 'assistant' | 'system';
  time: {
    created: number;
    completed?: number;
  };
  providerID?: string;
  modelID?: string;
  cost?: number;
  tokens?: OpenCodeMessageTokens;
  agent?: string;
  model?: {
    providerID?: string;
    modelID?: string;
  };
}

export interface OpenCodeSession {
  id: string;
  projectID?: string;
  directory?: string;
  title?: string;
  time: {
    created: number;
    updated: number;
  };
}

export interface OpenCodePart {
  id: string;
  sessionID: string;
  messageID: string;
  type: 'step-start' | 'step-finish' | 'reasoning' | 'tool' | 'text';
  tokens?: OpenCodeMessageTokens;
  cost?: number;
  time?: {
    start?: number;
    end?: number;
  };
}

export interface SessionRow {
  id: string;
  project_id: string;
  title: string;
  directory: string;
  time_created: number;
  time_updated: number;
}

export interface MessageUsageRow {
  id: string;
  session_id: string;
  provider_id: string | null;
  model_id: string | null;
  tokens_input: number | null;
  tokens_output: number | null;
  cache_read: number | null;
  cache_write: number | null;
  timestamp: number;
}

export interface MessageActivityRow {
  id: string;
  session_id: string;
  time_created: number;
  time_updated: number;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_reasoning: number | null;
  cache_read: number | null;
  cache_write: number | null;
  time_completed: number | null;
  errored: number;
}

export interface PartRow {
  id: string;
  message_id: string;
  session_id: string;
  time_created: number;
  data: string;
}

export type Stmt = ReturnType<InstanceType<typeof Database>['prepare']>;

export interface SqliteSchema {
  v1: boolean;
  v1Parts: boolean;
  v2: boolean;
}

export interface SourceStatements {
  allSessions: Stmt;
  sessionsSince: Stmt;
  oneSession: Stmt;
  sessionMessages: Stmt;
  allMessages: Stmt;
}

export interface PreparedStatements {
  schema: SqliteSchema;
  v1: SourceStatements | null;
  v2: SourceStatements | null;
  recentParts: Stmt | null;
  recentMessages: Stmt | null;
}

export interface SessionAggregateCacheEntry {
  updatedAt: number;
  usageRows: SessionUsageData[];
  lastAccessed: number;
}
