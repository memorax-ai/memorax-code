# Contributing to MemoraX Code

Thank you for helping improve MemoraX Code. Keep changes focused, preserve
client-native behavior, and verify the smallest contract affected by the
change.

## Development Setup

Run the commands below from the repository root. Source development requires
Git, Node.js 24 with npm, Python 3 (`python3`), GNU Make, Bash, `curl`, and standard
Unix command-line tools. The Makefile and package gates invoke Bash scripts,
so PowerShell alone is insufficient. Use macOS or Linux for these examples.
If using WSL on Windows, keep the checkout and Node, npm, Git, and Python in
the Linux environment; those results cover Linux behavior, not native Windows.
Native Windows checks use Windows Node.js and PowerShell 7+ where required by
the platform scripts. Shared Skill provider-response fixtures also require Git
for Windows with Bash available alongside Git. Run native Windows tests without
`--test-force-exit`: forced test-runner shutdown can abort Node while Windows
handles are closing. Keep per-test timeouts and let processes exit normally.
See [Validation](#validation) for their scope.

```bash
git status --short --branch
npm ci --prefix packages/ts/memorax-code-backend
npm run build --prefix packages/ts/memorax-code-backend
```

Backend compilation produces the `dist/` entrypoints consumed by its tests and
by some adapter tests. Rebuild after TypeScript changes. Adapters use JavaScript
source; their package test scripts do not build the Backend for you.

### Isolated Development Environment

Use temporary state for lifecycle, install, migration, and destructive tests.
The following Bash session defines a command wrapper for the examples below.
It leaves the shell's own home unchanged and starts child commands with a clean
environment, so inherited credentials, command overrides, and client-home
aliases do not select existing developer state.

```bash
memorax_dev_root="$(mktemp -d)"
mkdir -p "$memorax_dev_root"/{user,state,tmp}
memorax_dev() {
  env -i PATH="$PATH" \
    HOME="$memorax_dev_root/user" \
    MEMORAX_CODE_HOME="$memorax_dev_root/state" \
    npm_config_cache="$memorax_dev_root/npm-cache" \
    TMPDIR="$memorax_dev_root/tmp" \
    "$@"
}
```

The clean environment removes inherited client-home aliases, XDG paths,
credentials, and `MEMORAX_CODE_*_COMMAND` overrides; default client paths then
resolve under the temporary home. Let each test set its own fixture overrides.
Do not prepopulate competing overrides: for example, a global `CODEBUDDY_HOME`
would override a test's own `WORKBUDDY_HOME` fixture.

For direct lifecycle experiments, isolate every affected client's home and
inject synthetic command fixtures. The primary overrides are `CODEX_HOME`,
`CLAUDE_CONFIG_DIR`, `DSH_HOME`, `OPENCODE_CONFIG_DIR`, `CODEBUDDY_HOME`, and
`TRAE_CN_HOME`, and `CURSOR_HOME`; account for the aliases `CLAUDE_HOME`, `WORKBUDDY_HOME`, and
`TRAE_HOME` as well. `PATH` still contains installed programs, so a temporary
home alone does not prevent real-client execution. Inspect the affected path
and command resolvers when adding a client or changing discovery.

Native Windows isolation also needs temporary `USERPROFILE`, `APPDATA`, and
`LOCALAPPDATA`, while retaining system variables required to launch Windows
tools. An isolated home does not isolate the operating system's credential
store; its integration checks remain opt-in. Do not copy credentials,
`.env.local`, client transcripts, real MemoraX content, or retained traces into
fixtures; keep temporary state outside Git.

### Run and Debug Source

Build once, then run a focused test through the isolated wrapper. Backend tests
exercise compiled output; running `node --test` directly does not compile it.
For example:

```bash
memorax_dev node --test --test-timeout=5000 --test-force-exit \
  packages/ts/memorax-code-backend/test/transport/http/memory-hook.test.mjs
```

To select a case, add `--test-name-pattern='text from the test name'` before
the file path. To debug that case, use `node --inspect-brk --test
--test-concurrency=1` with the pattern and path, attach a Node debugger, and omit
`--test-timeout`/`--test-force-exit` while paused.

For foreground HTTP development, choose a free local port and run:

```bash
memorax_dev env MEMORAX_CODE_BACKEND_HOST=127.0.0.1 \
  MEMORAX_CODE_BACKEND_PORT=18787 \
  MEMORAX_CODE_AUTO_UPDATE=false \
  MEMORAX_CODE_MEMORAX_WRITEBACK_ENABLED=false \
  node packages/ts/memorax-code-backend/dist/server.js
```

From another terminal, `curl --fail http://127.0.0.1:18787/health` should return
JSON with `ok: true` and `service: "memorax-code-backend"`. This raw server
exercises the HTTP process without installing client integrations or running
foreground account setup. Stop it with Ctrl-C before cleaning the isolated
state. For lifecycle behavior, extend the existing synthetic lifecycle tests
and run the Install/artifacts profile instead of attaching this server to live
client configuration.

During editing, `npm run dev --prefix packages/ts/memorax-code-backend` watches
TypeScript and rebuilds `dist/`. The foreground command can use `node --watch`
to restart on compiled changes. Keep the same isolated environment for each
process; use `--inspect` when debugging the foreground server.

After stopping development processes and any test-spawned children, remove
only this session's temporary state:

```bash
rm -rf "$memorax_dev_root"
unset -f memorax_dev
unset memorax_dev_root
```

## Repository Ownership

The Backend is a local memory and lifecycle service, not a model-provider
proxy. Clients own models, provider credentials, tool execution, and native
conversation data. The optional Jev provider is a narrow, separately configured
semantic-evaluation boundary, not a client task runner. Use the architecture's
[package ownership map](ARCHITECTURE.md#21-repository-components) to choose the
owning package and its
[capability map](ARCHITECTURE.md#43-capability-ownership) to place Backend
implementation. Shared orchestration stays separate from native client
interpretation and deployment.

## Making a Change

1. Inspect the current branch, worktree, nearby implementation, and tests.
2. Keep behavior changes separate from unrelated formatting, renaming, or
   dependency updates.
3. Add or update the closest test for a changed contract.
4. Update the detailed source identified in
   [Documentation Ownership](#documentation-ownership), then any affected
   entrypoint summaries or links.
5. Run focused checks first, then broaden validation when the change crosses
   package or lifecycle boundaries.

## Documentation Ownership

Each kind of information has one detailed home. Other documents should provide
the summary or link their readers need. README must remain a self-contained
guide to ordinary installation and first use: do not replace essential
onboarding steps with links solely to avoid duplication. Advanced procedures,
detailed recovery, and implementation contracts belong in their owning guides.
Current source and executable tests remain authoritative for behavior.

| Document | Owns | Update when |
| --- | --- | --- |
| [README](README.md) and [Chinese README](README.zh.md) | Product overview, supported-client entry, requirements, ordinary installation, account or guest setup, required client activation, success verification, first-use walkthrough, routine update/uninstall, and navigation | Entry information or ordinary onboarding changes; keep both languages synchronized. Detailed configuration, recovery, or internal requirements alone do not require a README edit. |
| [npm README](packages/npm/memorax-code/README.md) | A standalone npm entrypoint and links to the detailed guides | The published package's quick start or navigation changes |
| [Configuration](docs/configuration.md) | Settings, defaults, paths, selection and update semantics | Configuration meaning or runtime configuration behavior changes |
| [Troubleshooting](docs/troubleshooting.md) | Symptoms, diagnosis, and recovery steps | A diagnosis or recovery procedure changes |
| [Architecture](ARCHITECTURE.md) | Package and capability ownership, runtime flows, authority, dependencies, packaging boundaries, and test placement | A documented boundary changes; use its [maintenance criteria](ARCHITECTURE.md#9-maintaining-this-document) |
| [Agent guide](AGENTS.md) | Mandatory agent constraints, runtime and data invariants, and Git permissions | An agent working rule or invariant changes |
| [Contributor guide](CONTRIBUTING.md) | Shared developer entrypoint: source setup, isolation, running/debugging, verification profiles, harness onboarding, documentation routing, and PR workflow | A development or verification procedure changes |
| [Security policy](SECURITY.md) | Vulnerability reporting, trust policy, and data-protection guarantees | A security or trust boundary changes; implementation maps link to this policy |
| [Changelog](CHANGELOG.md) | Notable user-facing release changes | Recording a release or its pending notes; internal-only refactors and tests normally do not need an entry |
| [Canonical shared Skill](packages/ts/memorax-code-codex-adapter/skills/memorax-code/SKILL.md) and its references | Product instructions consumed by coding clients | Agent-facing product behavior changes; preserve shared materialization and keep maintainer runbooks out of the Skill |

Keep detailed settings in Configuration and recovery procedures in
Troubleshooting; README links to these when they are needed. Preserve existing links
and heading anchors when reorganizing a document. The `docs/` pages included
in the npm artifact are declared by
[shipped-docs.json](packages/npm/memorax-code/shipped-docs.json); update its
registration and the documentation checks if shipped paths change.

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
   [installed-package checks](scripts/npm-package-check.sh). Register the package
   and any versioned plugin/Hook manifests in
   [release-version targets](scripts/sync-release-version.mjs), so the shared
   release version remains consistent. Run the adapter's
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
   client documentation, and run the relevant
   [verification profiles](#verification-profiles).

### Harness Coverage Map

The [native authority map](ARCHITECTURE.md#native-writeback-authority) lists
each harness's content authority and links to its Backend and adapter suites.
Every harness also participates in the shared runtime, lifecycle catalog, npm
source-mapping, test-entry, and local-only trace checks above. This is coverage
of executable contracts, not a record of real-client E2E results.

These checks catch omitted integration wiring. They do not infer native
content authority or replace parser, interruption, lifecycle, installed-package,
or platform verification. Keep new behavior cases in the owning suites.

## Validation

The [CI workflow](.github/workflows/ci.yml) runs on pull requests targeting
`main` and every push to `main`, and can also be started manually. It has two
checks on Linux with Node.js 24:

- **Tests** runs `make test`: locked dependency installation, version
  consistency, Backend type checking and compilation, all Backend, shared
  runtime, shared Skill and adapter tests, npm package tests, and the local-only
  trace gate. Test state uses an isolated home.
- **Documentation** runs `make docs-check`: documentation contracts, local
  links, shipped-document consistency, and mandatory paired README changes.
  If either `README.md` or `README.zh.md` changes, both must change in the PR,
  including language-specific edits. Reviewers verify that the content stays
  synchronized. The checkout includes Git history and an explicit comparison
  range so README checking does not silently skip for lack of a base ref.
  Manual runs compare the selected commit with its first parent.

Both checks run without path filters and keep stable names. Protect `main` by
requiring **Tests** and **Documentation** in GitHub branch protection, including
administrator merges. This setting is managed separately from the workflow.
Full package installation and real-client checks remain separate from these
basic checks. Use the Install/artifacts profile below for packaging or lifecycle
changes. These checks require no model, MemoraX, or Jev credentials.

Choose checks by impact from the profiles below. For architecture changes,
the [change-routing table](ARCHITECTURE.md#8-test-architecture-and-change-routing)
maps boundaries to owning tests and named profiles. Focused tests shorten the
edit loop; complete all profiles required by the final change before handoff.
Documentation edits also require the Documentation profile; CLI, lifecycle,
and artifact changes require Install/artifacts in addition to affected suites.

### Verification Profiles

Run commands from the repository root. For stateful checks, use
`memorax_dev` from [Isolated Development Environment](#isolated-development-environment)
as the command prefix, or an equivalent isolated test environment. Complete
Development Setup first. Shared Skill, Codex, and CodeBuddy/WorkBuddy suites
require a current Backend build when run independently; their standalone test
commands do not produce it. The common and shared Skill suites use the same
Node test runner as the adapters and run through independent Make targets.
The common suite runs from its own source and fixtures without an adapter or
Backend build; its Repo Memory worker tests use a generic runner and validator.
Shared Skill and native launcher tests cover the real canonical Skill validator.

| Profile | Required checks |
| --- | --- |
| Backend | `npm run typecheck --prefix packages/ts/memorax-code-backend` and `npm test --prefix packages/ts/memorax-code-backend` (builds before testing) |
| Shared Skill | `npm run build --prefix packages/ts/memorax-code-backend`, then `make test-shared-skill`; add affected adapter profiles for native integration changes |
| Codex | `npm run build --prefix packages/ts/memorax-code-backend`, then `npm test --prefix packages/ts/memorax-code-codex-adapter` |
| Claude Code | `npm test --prefix packages/ts/memorax-code-claude-adapter` |
| DeepSeek Harness (DSH) | `npm test --prefix packages/ts/memorax-code-dsh-adapter` |
| OpenCode | `npm test --prefix packages/ts/memorax-code-opencode-adapter` |
| CodeBuddy/WorkBuddy | `npm run build --prefix packages/ts/memorax-code-backend`, then `npm test --prefix packages/ts/memorax-code-codebuddy-adapter` |
| Trae | `npm test --prefix packages/ts/memorax-code-trae-adapter` |
| Cursor | `npm test --prefix packages/ts/memorax-code-cursor-adapter` |
| Repo Memory | Backend + Shared Skill + `make test-adapter-common`: collector, validator, and updater cases use compiled Backend helpers through the canonical Skill launcher; common tests own scheduling and policy behavior. Add affected adapter profiles when their scheduling or launchers change |
| Adapter-common/shared Hook | `make test-adapter-common`, affected Backend tests, and all seven adapter suites; add Shared Skill for changes used by Skill readers or launchers and Install/artifacts when staged runtime or package layout changes |
| Lifecycle report interpretation | Backend; add Install/artifacts for CLI or lifecycle behavior changes |
| Trace/local-only boundary | Affected package tests plus `make test-npm-package` |
| Documentation | `make docs-check` |
| Install/artifacts | `make npm-package-check` |
| Broad cross-layer | `make test`; add Install/artifacts when staging or layout changes |

Do not rerun an identical prerequisite build if the Backend profile has already
built the same source. Rebuild whenever TypeScript changes. The Documentation
profile checks local link targets, public paths, and shipped-document consistency;
its mandatory README synchronization script compares committed Git refs, so also
review uncommitted README changes in both languages. These checks do not prove
prose accuracy or command behavior.

Native Windows package smoke coverage lives in
[windows-npm-package-e2e.mjs](scripts/windows-npm-package-e2e.mjs). The separate
[Codex](scripts/windows-codex-e2e.mjs) and
[Claude](scripts/windows-claude-e2e.mjs) runners use real clients. Inspect each
script's prerequisites and isolation before using it; a macOS/Linux suite or
WSL run does not replace native Windows validation.

Live-provider, MemoraX-backed, and live Jev checks are explicit opt-in tests.
The credential-free native Codex workflow below runs by default on PRs. Report
native-client and synthetic evidence separately, record platform and scenarios,
redact output, and explain any relevant checks not run. Public fixtures must never contain
real API keys, private transcripts, personal memory, or infrastructure
credentials.

### Codex Functional CI

The [Codex functional workflow](.github/workflows/macos-codex-install.yml)
runs on pull requests, pushes to `main`, and manual dispatch. Reuse the basic
`Tests` and `Documentation` jobs above; this workflow adds installed-package
and native-client evidence. It does not copy the source regression suites.
Its Ubuntu job runs `npm-package-check` to build and validate one npm artifact.
The package check still includes its existing npm regression prerequisite;
`make test` alone does not build and install the final tarball.

Native jobs use temporary user and client homes on Ubuntu, macOS, and Windows
with Node.js 24, plus Ubuntu with the minimum Node.js 20 runtime. They install
the same artifact and pin Codex to 0.147.0. The lifecycle check exercises
rejected setup input, real-terminal cancellation and masked credential input,
failed setup and recovery, repeated setup, native plugin registration, Hook
trust, stop/start, and uninstall/reinstall. A scoped local npm registry serves
the candidate to the real public `update --latest` command: an initial artifact
download failure must preserve the installed 0.1.17 package and running Backend,
then a terminal-driven retry must activate the candidate. Unicode and spaces in
isolated paths, existing provider settings, configuration values, and synthetic
personal memory are checked explicitly.

The native conversation check runs real Codex against a local, deterministic
Responses server and a separate MemoraX receiver. Native Codex creates its own
session, Turn, rollout, and Hook events; the test must not synthesize these as
proof of a native workflow. Assertions compare the actual outgoing request to
independent expected content and identity. Model or tool text alone cannot
prove that a request was sent. Explicit Skill Search/Add must preserve the user
request even when the native client injects Skill instructions. A separate
Repo Memory worker case checks foreground/background model and provider
inheritance; its controlled no-op response intentionally fails bundle validation,
so it does not prove successful Repo Memory generation or permission inheritance.

The permission check drives Codex's native app-server protocol. Full access,
user approval, rejection, cancellation, and waiting are checked using native
requests and filesystem effects. Auto-review cases must observe Codex's own
review events; the driver never answers a user approval and calls it automatic
review. Deterministic reviewer responses test the review mechanism, not the
quality of a real model's risk judgment.

These default jobs require no model login or GitHub Environment secrets and
make no paid model calls. They report native CLI evidence, not Desktop or
editor UI coverage. Hosted Windows administrators do not represent ordinary
users or UAC. Real system credential stores, guest-account service contracts,
all installation-source combinations, and unsupported native features require
separate evidence; a skipped or blocked case is never a PASS.

To reproduce on macOS or Linux inside an isolated development environment:

```bash
memorax_dev make npm-package-check
scripts/codex-install-check.sh dist/npm/tarballs 0.147.0 0.1.17
```

On Windows, download the workflow's package artifact into `dist/npm/tarballs`,
then use a disposable PowerShell 7 session with Node.js and npm on PATH:

```powershell
./scripts/codex-install-check.ps1 -TarballDirectory dist/npm/tarballs -CodexVersion 0.147.0 -PreviousVersion 0.1.17
```

The wrappers install the test-only `node-pty@1.1.0` terminal dependency, then run
the lifecycle, native-conversation, and permission checks.
Windows uses npm's `.cmd` entrypoints without changing PowerShell execution
policy. Each check isolates its Backend/client state and confirms managed
process cleanup. Reports contain safe case results, versions, effective
policies, request counts, and evidence kinds; private homes, credentials, raw
rollouts, model output, and Backend tokens are not uploaded.

Manual dispatch can enable `check_deepseek` to run only the existing provider
connectivity check, skipping package and functional jobs. It uses the `test`
environment's `LLM_BASE_URL`, `LLM_MODEL`, and `LLM_API_KEY`. PR and push events
never run this paid job. It verifies a native text response and model/session
evidence, not the plugin chain or approval behavior against a live model.

The provider smoke parses DeepSeek's official model catalog as JSON from its
public setup script and checks a pinned digest; it never executes that script.
It uses low reasoning effort, zero provider retries, and a two-minute process
timeout. These are execution limits, not a hard token or cost cap. Usage is
reported when observed; native Turn counts are not reported as HTTP counts.

The default `npm-package-check` uses a synthetic Claude plugin CLI for its
installation smoke test; it does not require a local Claude installation.
This verifies the packaged integration and lifecycle, not real-client behavior.
`make npm-publish-dry-run` and direct invocation of
`scripts/npm-publish-dry-run.sh` both check release-version consistency before
building or invoking npm's dry-run.

## Pull Requests

A pull request should:

- explain the behavior or invariant being changed;
- keep its diff limited to that purpose;
- list tests run and any meaningful checks not run;
- call out client, workspace/session scope, HTTP/state, packaging, and
  compatibility impact where relevant;
- describe security or data-handling changes explicitly; and
- keep entrypoint summaries and translations consistent with the owning
  documents.

Reviewers prioritize correctness, safety, compatibility, and executable
contracts over stylistic preferences. If you discover a vulnerability, follow
[SECURITY.md](SECURITY.md) instead of opening a public issue.
