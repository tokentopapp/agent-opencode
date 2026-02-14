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

export interface JoinedMessageRow {
  sid: string;
  title: string;
  directory: string;
  time_updated: number;
  data: string;
}

export interface PartRow {
  id: string;
  message_id: string;
  session_id: string;
  time_created: number;
  data: string;
}

export type Stmt = ReturnType<InstanceType<typeof Database>['prepare']>;

export interface PreparedStatements {
  allSessions: Stmt;
  sessionsSince: Stmt;
  oneSession: Stmt;
  sessionMessages: Stmt;
  uncachedMessages: Stmt;
  uncachedMessagesSince: Stmt;
  recentParts: Stmt;
}

export interface SessionAggregateCacheEntry {
  updatedAt: number;
  usageRows: SessionUsageData[];
  lastAccessed: number;
}
