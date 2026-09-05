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
Use isolated `MEMORAX_CODE_HOME` and client homes (`CODEX_HOME`,
`CLAUDE_CONFIG_DIR`, `DSH_HOME`, `OPENCODE_CONFIG_DIR`, `CODEBUDDY_HOME`, and
`TRAE_CN_HOME`) for lifecycle, install, or destructive tests.

## Repository Ownership

| Area | Owns | Does not own |
| --- | --- | --- |
| `memorax-code-backend` | Backend lifecycle, typed Hook HTTP, memory service, MemoraX adapter, and local trace | Client provider execution or credentials |
| `memorax-code-adapter-common` | Durable runtime records, cross-process configuration primitives, shared Hook and Repo Memory helpers | Client transcript formats or plugin policy |
| `memorax-code-codex-adapter` | Codex plugin, Hooks, native session/workspace observation, diagnostics, bundled skill | Codex provider configuration or login |
| `memorax-code-claude-adapter` | Claude Code plugin, Hooks, native observation, diagnostics | Anthropic provider configuration or login |
| `memorax-code-dsh-adapter` | Cordis Turn bridge, Profile lifecycle, runtime bundles, and shared-skill integration | DSH provider or Session ownership |
| `memorax-code-opencode-adapter` | Plugin, managed loader, shared-skill installation, and diagnostics | OpenCode provider configuration or native message interpretation |
| `memorax-code-codebuddy-adapter` | CodeBuddy/WorkBuddy plugin, Hooks, transcript bridge, and shared-skill installation | CodeBuddy provider configuration or native transcript interpretation |
| `memorax-code-trae-adapter` | Global Hook merging, runtime generations, shared-skill installation, and diagnostics | Trae provider settings or application-level Hook activation |
| `packages/npm/memorax-code` | Public CLI, installation, update, uninstall, postinstall, and package layout | Product runtime authority |
| `scripts` and `.github` | Repeatable repository checks, packaging, and CI | Runtime behavior |

The Backend is a local memory and lifecycle service, not a model-provider
proxy. All six clients continue to own models, provider credentials, tool
execution, and native conversation data. See [Architecture](ARCHITECTURE.md)
for the authoritative package boundaries and runtime flows.

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

## Adding a Harness

Use the existing contracts below as the integration checklist. Extend the
closest suite with synthetic native fixtures; keep client-specific authority
and recovery cases in that client's tests.

1. **Establish native authority.** Identify start/completion events, exact
   Session and Turn correlation, workspace evidence, content storage or SDK
   records, interruption, and restart recovery. Implement native interpretation
   under `src/clients/<client>` and use
   [HarnessMemoryRuntime](packages/ts/memorax-code-backend/src/memory/harness-runtime.ts)
   for common memory orchestration. Preserve client-qualified identity and
   fail closed when the required authority is unavailable.
2. **Connect the command boundary.** Extend the versioned client command
   schema and [HTTP contract cases](packages/ts/memorax-code-backend/test/transport/http/memory-hook.test.mjs).
   Verify exact content, missing or conflicting identity, repeated completion,
   interruption, and scope pinning in `test/clients/<client>`. Shared
   [Turn coordinator](packages/ts/memorax-code-backend/test/memory/memory-turn-coordinator.test.mjs)
   and [harness runtime](packages/ts/memorax-code-backend/test/memory/harness-runtime.test.mjs)
   tests already cover their common invariants; retain native fixtures for
   each client's parser and bridge.
3. **Implement lifecycle and reports.** Add an
   [AdapterLifecycleParticipant](packages/ts/memorax-code-backend/src/lifecycle/participant.ts),
   register report identity in
   [client-reports](packages/ts/memorax-code-backend/src/lifecycle/client-reports.ts),
   and verify readiness and summaries in the
   [report contract tests](packages/ts/memorax-code-backend/test/lifecycle/client-reports.test.mjs)
   alongside the existing lifecycle tests.
   Explicitly handle client discovery, persisted selection, activation,
   disablement, and removal in their owning layers; catalog registration alone
   does not enable a client. Preserve user-owned configuration, native locks,
   and public report compatibility.
4. **Ship the actual runtime.** Declare adapter sources and canonical Skill
   materialization in [npm source mapping](scripts/npm-source-files.mjs).
   Check artifact requirements in [package building](scripts/build-npm-packages.mjs),
   [packed-file validation](scripts/validate-npm-pack-json.mjs), and
   [installed-package checks](scripts/npm-package-check.sh). Run the adapter's
   tests against its deployed layout as appropriate; do not maintain a new
   independent Skill copy. The
   [harness coverage check](packages/npm/memorax-code/test/harness-coverage.test.mjs)
   discovers adapter packages and checks Backend client-directory alignment,
   runtime source mappings, canonical Skill materialization, and adapter test
   reachability from `make test`.
5. **Complete the existing gates.** Update
   [source boundaries](packages/ts/memorax-code-backend/test/architecture/source-boundaries.test.mjs)
   for new native readers and intentional dependencies. Runtime discovery
   requires each native client directory to use the shared harness runtime.
   Register new network-capable modules with the
   [local-only trace gate](scripts/check-local-trace-only.mjs). Its source and
   staged scans recognize every adapter's `src`, `hooks`, `runtime-hooks`,
   `scripts`, and shared Skill scripts; a new runtime directory convention
   requires updating the scan and source-mapping checks. Add the adapter
   suite to the repository and platform checks, update architecture and public
   client documentation, and run the relevant validation profiles below.

### Harness Coverage Map

The table locates existing native contracts; it is not a record of real-client
E2E results. Each row also participates in the shared runtime, lifecycle
catalog, npm source-mapping, test-entry, and local-only trace checks above.

| Harness | Automatic writeback authority | Native Backend tests | Adapter tests |
| --- | --- | --- | --- |
| Codex | Exact Turn in rollout JSONL | [Codex](packages/ts/memorax-code-backend/test/clients/codex) | [Codex adapter](packages/ts/memorax-code-codex-adapter/test) |
| Claude Code | Correlated prompt in transcript JSONL | [Claude](packages/ts/memorax-code-backend/test/clients/claude) | [Claude adapter](packages/ts/memorax-code-claude-adapter/test) |
| DSH | Exact persisted Session Event Log interval | [DSH](packages/ts/memorax-code-backend/test/clients/dsh) | [DSH adapter](packages/ts/memorax-code-dsh-adapter/test) |
| OpenCode | Matching SDK session-message records | [OpenCode](packages/ts/memorax-code-backend/test/clients/opencode) | [OpenCode adapter](packages/ts/memorax-code-opencode-adapter/test) |
| CodeBuddy/WorkBuddy | Correlated native transcript JSONL | [CodeBuddy](packages/ts/memorax-code-backend/test/clients/codebuddy) | [CodeBuddy adapter](packages/ts/memorax-code-codebuddy-adapter/test) |
| Trae | Validated Turn-ID and Hook pair | [Trae](packages/ts/memorax-code-backend/test/clients/trae) | [Trae adapter](packages/ts/memorax-code-trae-adapter/test) |

These checks catch omitted integration wiring. They do not infer native
content authority or replace parser, interruption, lifecycle, installed-package,
or platform verification. Keep new behavior cases in the owning suites.

## Validation

Choose checks by impact:

| Change | Minimum relevant check |
| --- | --- |
| Backend TypeScript | `npm run typecheck --prefix packages/ts/memorax-code-backend` and `npm test --prefix packages/ts/memorax-code-backend` |
| Codex integration or bundled skill | `npm test --prefix packages/ts/memorax-code-codex-adapter` |
| Claude Code integration or shared skill | `npm test --prefix packages/ts/memorax-code-claude-adapter` |
| DeepSeek Harness integration | `npm test --prefix packages/ts/memorax-code-dsh-adapter` |
| OpenCode integration | `npm test --prefix packages/ts/memorax-code-opencode-adapter` |
| CodeBuddy/WorkBuddy integration | `npm test --prefix packages/ts/memorax-code-codebuddy-adapter` |
| Trae integration | `npm test --prefix packages/ts/memorax-code-trae-adapter` |
| Shared adapter or Hook runtime | All six adapter suites and the affected Backend tests; add `make npm-package-check` for staged runtime or package layout changes |
| Lifecycle report interpretation | Backend tests and `make npm-package-check` for CLI or lifecycle changes |
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
