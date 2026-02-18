# @tokentop/agent-opencode

[![npm](https://img.shields.io/npm/v/@tokentop/agent-opencode?style=flat-square&color=CB3837&logo=npm)](https://www.npmjs.com/package/@tokentop/agent-opencode)
[![CI](https://img.shields.io/github/actions/workflow/status/tokentopapp/agent-opencode/ci.yml?style=flat-square&label=CI)](https://github.com/tokentopapp/agent-opencode/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

[tokentop](https://github.com/tokentopapp/tokentop) agent plugin for **OpenCode**. Parses session data from both SQLite and JSON storage, reads multi-provider credentials, and provides real-time activity monitoring.

## Capabilities

| Capability | Status |
|-----------|--------|
| Session parsing | Yes (SQLite + JSON fallback) |
| Credential reading | Yes (multi-provider) |
| Real-time tracking | Yes |
| Multi-provider | Yes |

## How It Works

This plugin reads OpenCode's local data to extract:

- **Sessions** — parsed from SQLite database (`~/.local/share/opencode/opencode.db`) with automatic JSON fallback for older installs
- **Credentials** — reads OAuth tokens and API keys from `~/.local/share/opencode/auth.json` and provider config from `~/.config/opencode/config.json`
- **Provider discovery** — detects configured providers (Anthropic, OpenAI, Google Gemini, GitHub Copilot, OpenRouter, Antigravity, OpenCode Zen)
- **Real-time monitoring** — watches for session file changes to update the dashboard live

## Install

This plugin is **bundled with tokentop** — no separate install needed. If you need it standalone:

```bash
bun add @tokentop/agent-opencode
```

## Requirements

- [OpenCode](https://opencode.ai) installed
- [Bun](https://bun.sh/) >= 1.0.0
- `@tokentop/plugin-sdk` ^1.0.0 (peer dependency)

## Permissions

| Type | Access | Paths |
|------|--------|-------|
| Filesystem | Read | `~/.local/share/opencode`, `~/.config/opencode` |

## Development

```bash
bun install
bun run build
bun test
bun run typecheck
```

## Contributing

See the [Contributing Guide](https://github.com/tokentopapp/.github/blob/main/CONTRIBUTING.md). Issues for this plugin should be [filed on the main tokentop repo](https://github.com/tokentopapp/tokentop/issues/new?template=bug_report.yml&labels=bug,agent-opencode).

## License

MIT
