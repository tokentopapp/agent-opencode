import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import {
  createAgentPlugin,
  type AgentCredentials,
  type AgentFetchContext,
  type AgentProviderConfig,
  type PluginContext,
  type SessionParseOptions,
  type SessionUsageData,
} from '@tokentop/plugin-sdk';
import { CACHE_TTL_MS, SESSION_AGGREGATE_CACHE_MAX, sessionAggregateCache, sessionCache, sessionMetadataIndex } from './cache.ts';
import { OPENCODE_AUTH_PATH, OPENCODE_CONFIG_PATH, parseAuthEntry } from './credentials.ts';
import { parseSessionsJson, startActivityWatchJson, stopActivityWatchJson } from './json-fallback.ts';
import {
  OPENCODE_DB_PATH,
  closeDb,
  getDb,
  parseSessionsSqlite,
  startActivityWatchSqlite,
  stopActivityWatchSqlite,
} from './sqlite.ts';
import type { OpenCodeAuthEntry, OpenCodeConfig } from './types.ts';
import {
  OPENCODE_MESSAGES_PATH,
  OPENCODE_PARTS_PATH,
  OPENCODE_SESSIONS_PATH,
  OPENCODE_STORAGE_PATH,
} from './paths.ts';
import { RECONCILIATION_INTERVAL_MS } from './watcher.ts';
import { readJsonFile, resolveEnvValue } from './utils.ts';

const openCodeAgentConfig = {
  name: 'OpenCode',
  command: 'opencode',
  configPath: OPENCODE_CONFIG_PATH,
  sessionPath: OPENCODE_STORAGE_PATH,
  authPath: OPENCODE_AUTH_PATH,
};

const opencodeAgentPlugin = createAgentPlugin({
  id: 'opencode',
  type: 'agent',
  name: 'OpenCode',
  version: '1.0.0',

  meta: {
    description: 'OpenCode AI coding agent session tracking',
    homepage: 'https://opencode.ai',
  },

  permissions: {
    filesystem: {
      read: true,
      paths: [
        '~/.local/share/opencode',
        '~/.config/opencode',
      ],
    },
  },

  agent: openCodeAgentConfig,

  capabilities: {
    sessionParsing: true,
    authReading: true,
    realTimeTracking: true,
    multiProvider: true,
  },

  startActivityWatch(_ctx: PluginContext, callback): void {
    if (getDb()) {
      startActivityWatchSqlite(callback);
    } else {
      startActivityWatchJson(callback);
    }
  },

  stopActivityWatch(_ctx: PluginContext): void {
    stopActivityWatchSqlite();
    stopActivityWatchJson();
    closeDb();
  },

  async isInstalled(_ctx: PluginContext): Promise<boolean> {
    if (fsSync.existsSync(OPENCODE_DB_PATH)) return true;
    try {
      await fs.access(OPENCODE_CONFIG_PATH);
      return true;
    } catch {
      try {
        await fs.access(OPENCODE_AUTH_PATH);
        return true;
      } catch {
        return false;
      }
    }
  },

  async readCredentials(ctx: AgentFetchContext): Promise<AgentCredentials> {
    const result: AgentCredentials = { providers: {} };

    const authData = await readJsonFile<Record<string, OpenCodeAuthEntry>>(OPENCODE_AUTH_PATH);
    if (authData) {
      for (const [providerId, entry] of Object.entries(authData)) {
        const creds = parseAuthEntry(entry);
        if (creds) {
          result.providers[providerId] = creds;
        }
      }
    }

    const config = await readJsonFile<OpenCodeConfig>(OPENCODE_CONFIG_PATH);
    if (config?.provider) {
      for (const [providerId, providerConfig] of Object.entries(config.provider)) {
        if (result.providers[providerId]) continue;

        const apiKey = resolveEnvValue(providerConfig.key) ?? resolveEnvValue(providerConfig.options?.apiKey as string);

        if (apiKey) {
          result.providers[providerId] = {
            apiKey,
            source: 'opencode',
          };
        }
      }
    }

    ctx.logger.debug('Read OpenCode credentials', { providers: Object.keys(result.providers) });
    return result;
  },

  async parseSessions(options: SessionParseOptions, ctx: AgentFetchContext): Promise<SessionUsageData[]> {
    const sqliteResult = parseSessionsSqlite(options, ctx);
    if (sqliteResult.length > 0) return sqliteResult;

    return parseSessionsJson(options, ctx);
  },

  async getProviders(ctx: AgentFetchContext): Promise<AgentProviderConfig[]> {
    const providers: AgentProviderConfig[] = [];

    const config = await readJsonFile<OpenCodeConfig>(OPENCODE_CONFIG_PATH);
    const authData = await readJsonFile<Record<string, OpenCodeAuthEntry>>(OPENCODE_AUTH_PATH);

    const knownProviders: Record<string, string> = {
      anthropic: 'Anthropic',
      openai: 'OpenAI',
      'opencode-zen': 'OpenCode Zen',
      'github-copilot': 'GitHub Copilot',
      'google-gemini': 'Google Gemini',
      openrouter: 'OpenRouter',
      antigravity: 'Antigravity',
    };

    for (const [id, name] of Object.entries(knownProviders)) {
      const hasAuth = authData?.[id] !== undefined;
      const configEntry = config?.provider?.[id];
      const hasConfig = configEntry !== undefined;
      const enabled = configEntry?.enabled !== false;

      providers.push({
        id,
        name,
        configured: hasAuth || hasConfig,
        enabled: enabled && (hasAuth || hasConfig),
      });
    }

    ctx.logger.debug('Got OpenCode providers', { count: providers.length });
    return providers;
  },
});

export {
  CACHE_TTL_MS,
  OPENCODE_AUTH_PATH,
  OPENCODE_CONFIG_PATH,
  OPENCODE_DB_PATH,
  OPENCODE_MESSAGES_PATH,
  OPENCODE_PARTS_PATH,
  OPENCODE_SESSIONS_PATH,
  OPENCODE_STORAGE_PATH,
  RECONCILIATION_INTERVAL_MS,
  SESSION_AGGREGATE_CACHE_MAX,
  sessionAggregateCache,
  sessionCache,
  sessionMetadataIndex,
};

export default opencodeAgentPlugin;
