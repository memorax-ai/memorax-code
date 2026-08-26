# Contributing to MemoraX Code

Thank you for helping improve MemoraX Code. Keep changes focused, preserve
client-native behavior, and verify the smallest contract affected by the
change.

## Development Setup

Source development requires:

- Git
- Node.js 24 and npm
- Python 3
- `make` on macOS/Linux or PowerShell 7+ on Windows for platform scripts

Start from a clean checkout and install the Backend dependencies:

```bash
git status --short --branch
npm ci --prefix packages/ts/memorax-code-backend
```

Do not commit credentials, `.env.local`, local client transcripts, MemoraX
content, generated trace data, package staging, or machine-specific paths.
Use isolated `MEMORAX_CODE_HOME`, `CODEX_HOME`, and `CLAUDE_CONFIG_DIR`
locations for lifecycle, install, or destructive tests.

## Repository Ownership

| Area | Owns | Does not own |
| --- | --- | --- |
| `memorax-code-backend` | Backend lifecycle, typed Hook HTTP, memory service, MemoraX adapter, and local trace | Client provider execution or credentials |
| `memorax-code-adapter-common` | Durable runtime records, cross-process configuration primitives, shared Hook and Repo Memory helpers | Client transcript formats or plugin policy |
| `memorax-code-codex-adapter` | Codex plugin, Hooks, native session/workspace observation, diagnostics, bundled skill | Codex provider configuration or login |
| `memorax-code-claude-adapter` | Claude Code plugin, Hooks, native observation, diagnostics | Anthropic provider configuration or login |
| `packages/npm/memorax-code` | Public CLI, installation, update, uninstall, postinstall, and package layout | Product runtime authority |
| `scripts` and `.github` | Repeatable repository checks, packaging, and CI | Runtime behavior |

The Backend is a local memory and lifecycle service, not a model-provider
proxy. Codex and Claude Code continue to own models, provider credentials,
tool execution, and native transcripts.

## Making a Change

1. Inspect the current branch, worktree, nearby implementation, and tests.
2. Keep behavior changes separate from unrelated formatting, renaming, or
   dependency updates.
3. Add or update the closest test for a changed contract.
4. Update both root README files when public commands, requirements, supported
   clients, or data handling change.
5. Update [Configuration](docs/configuration.md) for configuration changes and
   [Troubleshooting](docs/troubleshooting.md) for user-facing diagnosis.
6. Run focused checks first, then broaden validation when the change crosses
   package or lifecycle boundaries.

## Validation

Choose checks by impact:

| Change | Minimum relevant check |
| --- | --- |
| Backend TypeScript | `npm run typecheck --prefix packages/ts/memorax-code-backend` and `npm test --prefix packages/ts/memorax-code-backend` |
| Codex integration or bundled skill | `npm test --prefix packages/ts/memorax-code-codex-adapter` |
| Claude Code integration or shared skill | `npm test --prefix packages/ts/memorax-code-claude-adapter` |
| Shared adapter or Hook runtime | Both adapter suites and the affected Backend tests |
| Public documentation | `make docs-check` |
| Install, update, uninstall, CLI, or artifact layout | `make npm-package-check` |
| Broad cross-layer change | `make test` |

Real-client or MemoraX-backed checks must be explicit opt-in tests with
redacted output. Public fixtures must never contain real API keys, private
transcripts, personal memory, or internal infrastructure credentials.

## Pull Requests

A pull request should:

- explain the behavior or invariant being changed;
- keep its diff limited to that purpose;
- list tests run and any meaningful checks not run;
- call out client, workspace/session scope, HTTP/state, packaging, and
  compatibility impact where relevant;
- describe security or data-handling changes explicitly; and
- keep `README.md` and `README.zh.md` synchronized.

Reviewers prioritize correctness, safety, compatibility, and executable
contracts over stylistic preferences. If you discover a vulnerability, follow
[SECURITY.md](SECURITY.md) instead of opening a public issue.
