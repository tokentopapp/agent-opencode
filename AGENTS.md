# AGENTS.md — @tokentop/agent-opencode

## What is TokenTop?

[TokenTop](https://github.com/tokentopapp/tokentop) is a terminal-based dashboard for monitoring
AI token usage and costs across providers and coding agents. It uses a plugin architecture
(`@tokentop/plugin-sdk`) with four plugin types: **provider** (API cost fetching), **agent**
(session parsing), **theme** (TUI colors), and **notification** (alerts).

This package is an **agent plugin**. Agent plugins parse local session files written by coding
agents (Claude Code, Cursor, etc.) to extract per-turn token usage, then feed normalized
`SessionUsageData` rows back to the TokenTop core for display. This plugin specifically tracks
OpenCode session usage and credentials.

## Build & Run

```bash
bun install                  # Install dependencies
bun run build                # Full build (types + JS bundle)
bun run build:types          # tsc --emitDeclarationOnly
bun run build:js             # bun build → dist/
bun run typecheck            # tsc --noEmit (strict)
bun test                     # Run all tests (bun test runner)
bun test src/parser.test.ts  # Run a single test file
bun test --watch             # Watch mode
```

CI runs `bun run build` then `bun run typecheck`. Both must pass.

## Project Structure

```
src/
├── index.ts          # Plugin entry — createAgentPlugin(), exports, isInstalled, readCredentials, getProviders
├── types.ts          # OpenCode session/message/part format types, SQLite row types, prepared statement types
├── cache.ts          # sessionCache (TTL-based), sessionAggregateCache (per-session LRU), sessionMetadataIndex
├── credentials.ts    # Credential parsing — API keys, OAuth, Codex, GitHub, well-known token types
├── json-fallback.ts  # JSON file-based session parsing + FSWatcher activity tracking (fallback when no SQLite)
├── paths.ts          # Path constants — ~/.local/share/opencode/*, ~/.config/opencode/*
├── sqlite.ts         # SQLite-based session/message queries with prepared statements + polling activity watch
├── utils.ts          # readJsonFile(), resolveEnvValue() ({env:VAR} expansion), buildOAuthCredentials()
└── watcher.ts        # FSWatcher for dirty-tracking session file changes + periodic reconciliation
tests/                # Test directory (bun test runner, currently empty)
```

## Architecture Notes

### Storage Locations

| Path | Purpose |
|------|---------|
| `~/.local/share/opencode/opencode.db` | SQLite database (primary data source) |
| `~/.local/share/opencode/storage/session/<project>/<session>.json` | Per-session metadata (JSON fallback) |
| `~/.local/share/opencode/storage/message/<sessionId>/<msg>.json` | Per-message data with token counts (JSON fallback) |
| `~/.local/share/opencode/storage/part/<msgId>/<part>.json` | Per-part data for real-time activity (JSON fallback) |
| `~/.local/share/opencode/auth.json` | Credentials — API keys, OAuth, Codex, GitHub tokens |
| `~/.config/opencode/opencode.json` | Config — provider settings, API keys (supports `{env:VAR}` expansion) |

### Dual Storage Backend

- **Primary**: SQLite (`opencode.db`) — opened read-only with prepared statements. Session and message tables are joined and queried with `json_extract()` for filtering assistant messages with token data.
- **Fallback**: JSON files in the `storage/` directory hierarchy. Used when SQLite DB is absent or queries fail. Walks `session/` → `message/` directories to reconstruct usage data.
- **Selection**: `parseSessions` tries SQLite first; if it returns empty results, falls back to JSON. `startActivityWatch` checks for an open DB handle to choose the watch strategy.

### Caching Strategy (Three Layers)

1. **`sessionCache`** — TTL-based (2s) full-result cache. If the same `parseSessions` call repeats within 2s with identical `limit`/`since` params, returns cached results without touching disk.
2. **`sessionAggregateCache`** — Per-session parsed usage rows keyed by `sessionId`. Invalidated when `session.time_updated` changes. LRU eviction at 10,000 entries (evicts by `lastAccessed` timestamp).
3. **`sessionMetadataIndex`** — (JSON path only) Maps file paths to `{ mtimeMs, session }`. Avoids re-reading and re-parsing unchanged session files. Stale entries cleaned on each parse cycle.

### Dirty Tracking & Reconciliation

- **FSWatcher** watches session project directories and marks changed `.json` files as dirty in `sessionWatcher.dirtyPaths`.
- On each `parseSessions` call, only dirty/new files get re-stat'd and re-parsed; clean files use cached metadata.
- **Full reconciliation** sweep forced every 10 minutes via interval timer (`RECONCILIATION_INTERVAL_MS`), stat-checking all files regardless of dirty state.

### Real-Time Activity Watching

- **SQLite mode**: Polls the `part` table every 1s (`SQLITE_POLL_INTERVAL_MS`) for rows with `time_created` after the last seen timestamp. Emits `ActivityUpdate` for parts containing token data.
- **JSON mode**: FSWatcher on `storage/part/` for new `msg_*` directories. Each message directory gets its own watcher for new `.json` part files. Deduplicates via `seenParts` Set. 50ms debounce on part file processing.

### Credential Reading

- Reads `auth.json` keyed by provider ID. Supports five auth types: `api` (raw key), `oauth` (access/refresh tokens), `codex` (Codex access tokens), `github` (GitHub token), `wellknown` (token or key).
- Falls back to `opencode.json` config for provider API keys. Supports `{env:VAR}` syntax for environment variable resolution.
- Auth file credentials take priority; config file credentials only used if no auth entry exists for that provider.

### Multi-Provider Support

Known providers: Anthropic, OpenAI, OpenCode Zen, GitHub Copilot, Google Gemini, OpenRouter, Antigravity. Provider/model IDs are extracted from each message's `providerID`/`modelID` fields (or nested `model.providerID`/`model.modelID`).

### SQLite WAL Release

The SQLite connection auto-closes after 5 minutes (`WAL_RELEASE_INTERVAL_MS`) to release the WAL lock. Reopens on next query. Prepared statements are invalidated on close.

### Installation Detection

Checks in order: SQLite DB exists → config file accessible → auth file accessible. Returns `true` if any are found.

## TypeScript Configuration

- **Strict mode**: `strict: true` — all strict checks enabled
- **No unused code**: `noUnusedLocals`, `noUnusedParameters` both `true`
- **No fallthrough**: `noFallthroughCasesInSwitch: true`
- **Target**: ESNext, Module: ESNext, ModuleResolution: bundler
- **Types**: `bun-types` (not `@types/node`)
- **Declaration**: Emits `.d.ts` + declaration maps + source maps

## Code Style

### Imports

- **Use `.ts` extensions** in all relative imports: `import { foo } from './bar.ts'`
- **Type-only imports** use the `type` keyword:
  ```typescript
  import type { SessionUsageData } from '@tokentop/plugin-sdk';
  import { createAgentPlugin, type AgentFetchContext } from '@tokentop/plugin-sdk';
  ```
- **Node.js modules** via namespace imports: `import * as fs from 'fs'`, `import * as path from 'path'`
- **Order**: External packages → relative imports (no blank line separator used)

### Module Format

- ESM only (`"type": "module"` in package.json)
- Named exports for everything except the main plugin (default export)
- Re-export public API items explicitly from `index.ts`

### Naming Conventions

- **Constants**: `UPPER_SNAKE_CASE` — `CACHE_TTL_MS`, `RECONCILIATION_INTERVAL_MS`
- **Functions**: `camelCase` — `parseSessionsFromProjects`, `readJsonlFile`
- **Interfaces**: `PascalCase` — `OpenCodeSessionEntry`, `SessionWatcherState`
- **Type predicates**: `is` prefix — `isTokenBearingEntry(entry): entry is ...`
- **Unused required params**: Underscore prefix — `_ctx: PluginContext`
- **File names**: `kebab-case.ts`

### Types

- **Interfaces** for object shapes, not type aliases
- **Explicit return types** on all exported functions
- **Type predicates** for runtime validation guards (narrowing `unknown` → typed)
- **`Partial<T>`** for candidate validation instead of `as any`
- Never use `as any`, `@ts-ignore`, or `@ts-expect-error`
- Validate unknown data at boundaries with type guard functions

### Functions

- **Functional style** — no classes. State held in module-level objects/Maps
- **Pure functions** where possible; side effects isolated to watcher/cache modules
- **Early returns** for guard clauses
- **Async/await** throughout, no raw Promise chains

### Error Handling

- **Empty catch blocks are intentional** for graceful degradation (filesystem ops that may fail)
- Pattern: `try { await fs.access(path); } catch { return []; }`
- Never throw from filesystem operations — return empty/default values
- Use `Number.isFinite()` for numeric validation, not `isNaN()`
- Validate at data boundaries, trust within module

### Formatting

- No explicit formatter config (Prettier/ESLint not configured)
- 2-space indentation (observed convention)
- Single quotes for strings
- Trailing commas in multiline structures
- Semicolons always
- Opening brace on same line

## Plugin SDK Contract

The plugin SDK (`@tokentop/plugin-sdk`) defines the interface contract between plugins and
the TokenTop core (`~/development/tokentop/ttop`). The SDK repo lives at
`~/development/tokentop/plugin-sdk`. This plugin is a peer dependency consumer — it declares
`@tokentop/plugin-sdk` as a `peerDependency`, not a bundled dep.

This plugin implements the `AgentPlugin` interface via the `createAgentPlugin()` factory:

```typescript
const plugin = createAgentPlugin({
  id: 'opencode',
  type: 'agent',
  agent: { name: 'OpenCode', command: 'opencode', configPath, sessionPath },
  capabilities: { sessionParsing: true, realTimeTracking: true, ... },
  isInstalled(ctx) { ... },
  parseSessions(options, ctx) { ... },
  startActivityWatch(ctx, callback) { ... },
  stopActivityWatch(ctx) { ... },
});
export default plugin;
```

### AgentPlugin interface (required methods)

| Method | Signature | Purpose |
|--------|-----------|---------|
| `isInstalled` | `(ctx: PluginContext) → Promise<boolean>` | Check if this agent exists on the user's machine |
| `parseSessions` | `(options: SessionParseOptions, ctx: AgentFetchContext) → Promise<SessionUsageData[]>` | Parse session files into normalized usage rows |
| `readCredentials` | `(ctx: AgentFetchContext) → Promise<AgentCredentials>` | Read auth.json + config for provider API keys/OAuth tokens |
| `getProviders` | `(ctx: AgentFetchContext) → Promise<AgentProviderConfig[]>` | List known providers with configured/enabled status |
| `startActivityWatch` | `(ctx: PluginContext, callback: ActivityCallback) → void` | Begin real-time file watching, emit deltas |
| `stopActivityWatch` | `(ctx: PluginContext) → void` | Tear down watchers |

### Key SDK types

| Type | Shape | Used for |
|------|-------|----------|
| `SessionUsageData` | `{ sessionId, providerId, modelId, tokens: { input, output, cacheRead?, cacheWrite? }, timestamp, sessionUpdatedAt?, projectPath?, sessionName? }` | Normalized per-turn usage row returned from `parseSessions` |
| `ActivityUpdate` | `{ sessionId, messageId, tokens: { input, output, cacheRead?, cacheWrite? }, timestamp }` | Real-time delta emitted via `ActivityCallback` |
| `SessionParseOptions` | `{ sessionId?, limit?, since?, timePeriod? }` | Filters passed by core to `parseSessions` |
| `AgentFetchContext` | `{ http, logger, config, signal }` | Context bag — `ctx.logger` for debug logging |
| `PluginContext` | `{ logger, storage, config, signal }` | Context for lifecycle methods |

### SDK subpath imports

| Import path | Use |
|-------------|-----|
| `@tokentop/plugin-sdk` | Everything (types + helpers) |
| `@tokentop/plugin-sdk/types` | Type definitions only |
| `@tokentop/plugin-sdk/testing` | `createTestContext()` for tests |

## Commit Conventions

Conventional Commits enforced by CI on both PR titles and commit messages:

```
feat(parser): add support for cache_creation breakdown
fix(watcher): handle race condition in delta reads
chore(deps): update dependencies
refactor: simplify session metadata indexing
```

Valid prefixes: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`
Optional scope in parentheses. Breaking changes use `!` suffix before colon.

## Release Process

- semantic-release via GitHub Actions (currently manual `workflow_dispatch`)
- Publishes to npm as `@tokentop/agent-opencode` with public access + provenance
- Runs `bun run clean && bun run build` before publish (`prepublishOnly`)
- Branches: `main` only

## Testing

- Test runner: `bun test` (Bun's built-in test runner)
- Test files: `*.test.ts` (excluded from tsconfig compilation, picked up by bun test)
- Place test files in `tests/` directory or adjacent to source: `src/parser.test.ts`
- Use `createTestContext()` from `@tokentop/plugin-sdk/testing` for mock contexts
- No tests exist yet — this is a gap to be filled
