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
[Claude](scripts/windows-claude-e2e.mjs) runners use real clients for installation.
The older Claude runner supplies synthetic Hook inputs; it does not establish
native conversation or transcript writeback. Inspect each script's prerequisites
and isolation before using it; a macOS/Linux suite or
WSL run does not replace native Windows validation.

Live-provider, MemoraX-backed, and live Jev checks are explicit opt-in tests.
The credential-free Codex, OpenCode, Claude, and CodeBuddy functional checks
below run by default on PRs. Report
native-client and synthetic evidence separately, record platform and scenarios,
redact output, and explain any relevant checks not run. Public fixtures must never contain
real API keys, private transcripts, personal memory, or infrastructure
credentials.

### Codex Functional CI

The [native client functional workflow](.github/workflows/macos-codex-install.yml)
runs on pull requests, pushes to `main`, and manual dispatch. Reuse the basic
`Tests` and `Documentation` jobs above; this workflow adds installed-package
and native-client evidence. It does not copy the source regression suites.
Its Ubuntu job runs `npm-package-check` to build and validate one npm artifact.
The package check still runs the npm regressions. A regression failure is retained
as its exit status while independent artifact checks continue. Only after those
artifact checks finish does it write `dist/npm/check-result.json`; this permits
native jobs to inspect the validated tarball even when a contract test is red.
The package job and final summary remain failed. An artifact-check failure does
not publish this marker or authorize the native matrix. `make test` alone does
not build and install the final tarball.

Native jobs use temporary user and client homes on Ubuntu, macOS, and Windows
with Node.js 24, plus Ubuntu with the minimum Node.js 20 runtime. They install
the same artifact. Codex 0.147.0 remains the reproducible baseline. Each workflow
resolves the npm `latest` tag once and also checks that exact release on all
three systems with Node.js 24. When latest equals the baseline, those jobs cover
both tracks without duplicate execution; Ubuntu/Node.js 20 remains a baseline
check. Requested and actual CLI versions are recorded and must match. A failed
latest-version check fails the workflow instead of falling back to the baseline.
The `Codex functional result` summary requires the package and entire matrix to
succeed; failed, cancelled, or skipped dependencies fail it. Provider-only manual
runs use a different result name and cannot supply this functional result. This
workflow does not configure repository branch protection.
The lifecycle check exercises
specific rejected-input diagnostics, real-terminal cancellation and masked credential input,
failed setup and recovery, repeated setup, native plugin registration, Hook
trust, stop/start, and uninstall/reinstall. A scoped local npm registry serves
the candidate to the real public `update --latest` command: an initial artifact
download failure must preserve the installed 0.1.17 package and running Backend,
then a terminal-driven retry must activate the candidate. The installed candidate
also runs its own forced update through the scoped registry. Successful updates
must retire the old Backend process and establish a new instance with a matching
health response. Terminal credential checks cover both raw output and visible
text after ANSI controls are removed. Unicode and spaces in
isolated paths, existing provider settings, protected configuration and synthetic
personal memory are checked explicitly. Protection applies to the fixture's
MemoraX `user_id`, `api_key`, `endpoint`, explicit client choices and configured
feature switches; managed defaults and runtime paths may change. The account is
distinct from the system username. After initial account entry, repeated setup
and reinstallation supply no account input or endpoint/writeback environment
override. Explicit Search checks the actual receiver, credential and scoped user
identity after recovery, separately from the installation's zero-request check.
An injected npm postinstall failure exercises package replacement after retirement,
then a public retry must restore readiness and the same protected account.

The interruption suite terminates real setup after configuration publication,
before Backend startup, and after a healthy Backend exists but before completion.
Test-only process-entry gates and the Backend's lifecycle lock hold those stages;
configuration bytes, PID records, health identity and completion records establish
which stage was reached. A separate explicit account-reconfiguration case cancels
at the masked replacement-key prompt. Each case checks the protected saved account,
absence of false completion, ordinary retry without account input, native readiness,
and an actual Search using the saved account. These controlled interruptions do
not simulate power loss or establish desktop UI behavior.

Setup fixture tests distinguish absent client choices from explicit disablement,
including clients whose executables are available, partial legacy configuration,
and a previously unavailable client discovered on a later update. They validate
setup selection with controlled client/Backend dependencies; they do not establish
native acceptance for those other clients. An enabled integration's removal and
ordinary reinstall must preserve its configured selection rather than turn it
into a permanent opt-out. Test-oracle controls permit a valid default migration
but reject account replacement, lost disablement and accidental permanent opt-out.

The native conversation check runs real Codex against a local, deterministic
Responses server and a separate MemoraX receiver. Native Codex creates its own
session, Turn, rollout, and Hook events; the test must not synthesize these as
proof of a native workflow. The shared native harness supplies synthetic model
IDs and a fixed `model_catalog_json` in its isolated Codex home, including an
explicit auto-review model. This keeps the controlled fixtures independent of
changes to Codex's bundled model catalog. Baseline and latest CLI checks still
validate catalog compatibility, actual model routing, and native execution;
they do not establish availability of any hosted model. Native error assertions
remain strict.
Assertions compare actual outgoing requests with independently selected native
source records under the current extraction contract. Automatic Add must have
valid message fields, nonempty content, and the complete selected text; additional
content is allowed. The checks retain exact session/Turn identity, request counts,
and synthetic credential redaction. They do not call the production parser to
construct their expected content. Negative controls reject missing or truncated
source text, empty or malformed messages, and mismatched native identity, while
allowing appended context. All outgoing messages are also checked against distinct
foreign-workspace fixture text; permission cases reject other threads' fixture
text. These controls test known source-isolation failures, not arbitrary provenance
in real transcripts. Model or tool text alone cannot prove delivery.
The current Codex parser can select an injected Skill response item as user text.
Reports separately record whether the original user prompt is included; its
absence does not fail this compatibility check. This is coverage of the existing
extraction contract, not proof of full raw-trajectory transmission or preservation
of every user message. Explicit CLI/Skill Search/Add command arguments have
independent request assertions. Search validates the complete fixture fields and
both JSON and default text output. Skill command checks validate and invoke the
platform CLI entrypoint from the installed reference; a simulated model still
directs the calls, so this is not autonomous natural-language Skill validation.
A Repo Memory worker case checks shared global model and provider configuration
and remains required in the native conversation check.
Session-specific model/provider override inheritance is pending implementation,
so the installation wrappers report it as skipped and do not run
`scripts/codex-model-inheritance-check.mjs`. That standalone script is retained
as a future acceptance check: it sets a different foreground model or provider
and requires the worker to use that override in its actual HTTP request and
native record. Running it directly with an installed package root and Codex CLI
path still executes both cases, reports expected and actual values, and returns
nonzero on any failure. Re-enable it in both installation wrappers when the
feature is implemented; do not weaken its assertions to match default-only
behavior. Controlled no-op responses intentionally fail bundle validation, so
these checks do not prove successful Repo Memory generation or permission
inheritance.
The native conversation and permission checks disable writeback buffering and
chunking to validate immediate, exact requests. Default buffer flushing and
chunked payload combinations require separate native coverage.

The permission check drives Codex's native app-server protocol. Full access,
user approval, rejection, cancellation, and waiting are checked using native
requests and filesystem effects. Auto-review cases must observe Codex's own
review events; the driver never answers a user approval and calls it automatic
review. Deterministic reviewer responses test the review mechanism, not the
quality of a real model's risk judgment. Windows cases explicitly select Codex's
`windows.sandbox = "unelevated"` Restricted Token mode; without a Windows
sandbox, the client can downgrade requested workspace-write to read-only.
Requested and effective policies remain strict assertions. Elevated sandbox
setup, dedicated sandbox accounts, and UAC are separate coverage.
Restricted-mode probes explicitly request escalation; they verify approval
routing and file effects, not unprivileged command execution or the sandbox's
filesystem and network isolation.

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

The Windows wrapper removes its temporary npm directory from the user PATH in
`finally`, including on failure and catchable interruption. It preserves other
entries observed during cleanup instead of restoring an old PATH snapshot.
Avoid running other installers that modify the user PATH at the same time:
Windows environment reads and writes are not atomic, so cleanup cannot guarantee
preservation of concurrent changes. Forcefully terminating PowerShell or
shutting down the machine can prevent this cleanup from running.

The wrappers accept a resolved stable Codex version, verify the installed version,
install the test-only `node-pty@1.1.0` terminal dependency, then run
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

### OpenCode Functional CI

The same workflow has an independent OpenCode matrix and an `OpenCode functional
result` check. It consumes the package job's exact tarball, without rebuilding
per client or operating system. OpenCode 1.18.18 is the reproducible baseline;
the workflow resolves npm's latest stable version once and tests that exact
version without fallback. Both tracks run on Ubuntu, macOS, and Windows with
Node.js 24; Ubuntu also checks the baseline with Node.js 20. Failed, cancelled,
or skipped required jobs fail the result. The existing Codex result remains
separate. Provider-only manual dispatch does not run either functional matrix.

OpenCode follows the same acceptance goals as [Codex](#codex-functional-ci),
using its own plugin, native SDK messages, tools, and permission protocol:

| Shared acceptance goal | OpenCode evidence |
| --- | --- |
| Lifecycle and protected configuration | Real npm installation, terminal setup and cancellation, repeated setup, stop/start, uninstall/reinstall; preserve account, client choices, provider settings, and synthetic personal memory |
| Upgrade and recovery | Published 0.1.18 to candidate through the public updater; controlled download and postinstall failures, Backend replacement, recovery and retry |
| Setup interruption | After config publication, before Backend start, after Backend start, and cancellation at the replacement-key prompt; saved-account retry and Search |
| Native memory flow | Real sessions and continuation, complete selected Unicode content, redaction, workspace isolation, installed CLI and scripted Skill Search/Add |
| Permissions and interruption | Native approval requests, actual file effects, denied and interrupted turns, and pending requests; interrupted turns must not trigger automatic Add |
| Background configuration | A real Repo Memory worker uses the configured global model/provider; a no-op model response must fail artifact validation |
| Isolation and cleanup | Temporary client/Backend/user homes, allowlisted environment, synthetic credentials, local model and memory receivers, owned-process and port checks |

The native checks use an explicitly configured synthetic OpenCode model, not a
hosted model identifier. Ordinary conversation must not cause automatic Search.
Positive Skill cases make the real client execute the installed `memorax-cli`
and return its result to the model; the local model directs those tool calls.
This validates integration, not autonomous Skill selection or model quality.
SDK session/message identities are the content authority, not test-authored
transcripts or plugin prompt text. Buffering and chunking are disabled for exact
immediate writeback assertions, as in the Codex checks.

Client-specific assertions cover OpenCode plugin/Skill discovery, preserved
JSONC configuration, native message parent lineage, and shell environment
session binding. The server suite verifies existing-server reuse, authenticated
loopback fallback only on an initial transport failure, and no fallback after
HTTP or native assistant errors. It verifies real tool effects, temporary
session deletion, and owned server cleanup. The wrappers install test-only
`node-pty@1.1.0` and `@vscode/ripgrep@1.18.0`; Skill discovery uses that explicit
ripgrep executable instead of relying on an ambient installation or download.
OpenCode permission decisions use its own completion and abort
semantics. Codex Guardian auto-review, Codex sandbox modes, and plugin trust
registration are not OpenCode acceptance cases. Neither client's default checks
prove complete Repo Memory generation, temporary model/provider override
inheritance, Desktop UI behavior, or live model quality. Report unsupported or
unverified native features explicitly rather than treating them as passed.

Late approval after cancellation is an optional diagnostic, not part of the
default wrappers or required CI matrix. It checks whether an old permission
reply can execute a tool after the native session reports interruption. This
client-level expectation is separate from the required MemoraX contract:
interrupted turns must not trigger automatic Add, and owned resources must be
cleaned up. The default permission suite continues to enforce that contract.

The diagnostic observed a file write after late approval on OpenCode 1.18.18
and 1.18.33 with the installed plugin. It reports
`LATE_PERMISSION_EXECUTED_ABORTED_TOOL` and exits nonzero; the result is not
converted to a pass. This observation alone does not establish an upstream
defect or a MemoraX regression: native cancellation semantics, a plugin-free
control, and UI reachability require separate investigation. To run it with an
installed package, OpenCode executable, and the wrapper's test dependencies:

```bash
node scripts/opencode-permissions-check.mjs PACKAGE_ROOT OPENCODE_EXECUTABLE --late-approval
```

For startup investigation, manual dispatch with
`diagnose_opencode_initialization=true` runs only the package check and a
Windows baseline diagnostic with a no-op plugin. After one separate online
cache warmup, it compares the operating system and runner temporary locations
at equal short and long path lengths, using four order-balanced rounds and
npm offline mode. Every trial uses a fresh home and the same isolated cache;
failed trials are not retried and the session request timeout is unchanged.
Successful samples require completed dependency installation, not just a created
session. Cleanup failure stops the experiment and retains isolated state.
A loopback-only Bun inspector collects allowlisted npm phase timings and
fixed-package HTTP milestones. Cache-stream creation is not proof of a completed
cache read, and response-body completion may be delayed by extraction backpressure.
Raw logs, paths, credentials, and inspector objects are not published. Diagnostic completion is not
functional acceptance, and this mode does not run the required matrix or the
paid provider check.

On macOS or Linux, use `memorax_dev make test-opencode-e2e` to validate the
package and run the baseline. To reuse an already validated package or select
another exact client version:

```bash
bash scripts/opencode-install-check.sh dist/npm/tarballs 1.18.18 0.1.18
```

On native Windows, download the package artifact and use a disposable
PowerShell 7 session with Node.js, npm, and Git for Windows available:

```powershell
./scripts/opencode-install-check.ps1 -TarballDirectory dist/npm/tarballs -OpenCodeVersion 1.18.18 -PreviousVersion 0.1.18
```

The Windows wrapper reuses the same exact-prefix user PATH cleanup guard as
Codex, including its interruption and concurrent-update limitations. Local
`node scripts/opencode-e2e.mjs [TARBALL_DIR] [OPENCODE_VERSION]` delegates to
these platform wrappers; it no longer creates a separate candidate package or
injects a prebuilt Repo Memory bundle.

### Claude Native Smoke CI

The same workflow adds an independent Claude Code matrix and a `Claude native
smoke result` check. It covers the shared installation, upgrade recovery, setup
interruption, native memory, scripted Skill, permission, and Repo Memory global
configuration categories. Client-specific evidence and exclusions below still
differ from the Codex and OpenCode suites. It consumes the package job's exact
validated tarball and installs the official Claude Code CLI. Version 2.1.277 is
the baseline; npm's latest stable version is resolved once per run and tested
as an exact release without fallback. Both tracks run on Ubuntu, macOS, and
Windows with Node.js 24. Ubuntu also checks the baseline with Node.js 22,
matching the official Claude npm package's minimum runtime rather than
MemoraX Code's Node.js 20 minimum. When latest equals baseline, the Node.js 24
jobs cover both tracks without duplicates. Requested and installed Claude
versions must match.

The result requires the package job and every Claude smoke matrix job to
succeed. Failed, cancelled, or skipped dependencies cannot pass it. Codex and
OpenCode keep their separate results. Provider-only and OpenCode initialization
diagnostic dispatches skip the Claude matrix and its result. The default runs
use no model login, live-provider credentials, or paid model calls.

The lifecycle suite checks rejected setup input, real-terminal cancellation and
masked-key entry, occupied-port failure and recovery, repeated setup, stop/start,
and uninstall/reinstall. The native Claude CLI must report the expected enabled
user plugin and local marketplace. Installed Hook declarations, stable runtime
shell identity, and packaged Skill content must match the candidate. Claude's
plugin registration is not Codex Hook trust, and comparing the stable shell does
not claim that every cached runtime file was replaced.

A scoped local npm registry serves the candidate to the public updater. The
suite upgrades published MemoraX Code 0.1.18 to the candidate, first rejecting the
artifact download and then retrying through a real terminal. It also exercises
the candidate's forced reinstall and a controlled npm postinstall failure after
Backend retirement, followed by recovery. Successful replacement requires the
old Backend process to exit and a new instance to match its health response.
Saved account fields, explicit client and feature choices, synthetic personal
memory, and unrelated Claude settings must survive. Only MemoraX's own native
plugin and marketplace registration may change in Claude settings. Repeated
setup and recovery do not receive replacement account input or endpoint
overrides; explicit Search verifies the retained account against a loopback
receiver. Claude's exact `HEAD /api/hello` connectivity probe is counted separately;
other lifecycle model and memory requests are rejected.

The interruption suite terminates real setup after configuration publication,
before Backend startup, and after a healthy Backend exists but before completion.
Test-only process-entry gates and the real Backend lifecycle lock hold those
stages. A fourth case cancels at the masked replacement-key prompt. Each case
requires the saved account and unrelated Claude settings to remain intact, no
false completion record, an ordinary retry without account input, native Claude
readiness, and a Search using the saved account. These controlled process
interruptions do not simulate power loss.

The native suite checks installed plugin discovery and real Claude turns
against a local deterministic Anthropic Messages
server and a separate local Memory receiver:

| Smoke scenario | Evidence |
| --- | --- |
| Initial conversation | Native Claude session, prompt, Hooks, and transcript; complete selected Unicode content in automatic Add |
| Resume and tool execution | Resume the exact session, run a real tool, and check session environment binding |
| Redaction | Synthetic secret content stays out of outgoing Memory requests |
| Workspace separation | A distinct workspace and native session keep content and scope separate |
| Scripted Skill Search/Add | Native Skill and Read tools load installed guidance before a real Bash tool runs the documented CLI; actual requests and returned results retain the bound workspace |

The suite also runs Search and Add directly through the installed `memorax-cli`,
checking actual requests rather than treating model text as delivery. Skill
cases validate the installed router and complete operation reference, execute
the documented platform entrypoint from PATH, and check the result returned to
the model. Claude creates its own transcript and Hook identities;
test-authored transcripts and direct Hook
invocations are not native evidence. A deterministic local model supplies the
responses, so these cases do not establish model quality or autonomous Skill
selection. Content-oracle and harness unit tests run before packaging using
local fixtures; they are separate from native-client evidence.

The native suite also starts a real Repo Memory worker from a foreground turn
in an isolated Git repository. Foreground and worker requests must use the
configured global model and loopback provider with synthetic credentials. The
worker request must contain the complete supervised job prompt, and its no-op
response must produce `artifact_validation_failed` after a successful native
client exit, with no Memory requests. Job ownership and owned-process exit are
checked separately. Claude's worker uses `--no-session-persistence`, so this case
does not require or claim a persisted background transcript. It does not prove
successful Repo Memory generation, temporary foreground model/provider override
inheritance, or permission inheritance.

The permission suite drives Claude's native bidirectional `stream-json`
control protocol. It checks preallowed tools, explicit approval, denial, cancel
at a permission request, interruption while waiting, and interruption of an
already running Bash tool. Assertions correlate native permission requests and
responses with the actual file effects. A normally completed denied-tool turn
can still write back its final answer; denial is not itself an interrupted Turn.
Cancelled cases require native interruption evidence and a subsequent completed
turn in the same session. Only the new turn may produce automatic Add, and no
cancelled prompt or partial answer may enter any outgoing Memory message.
This tests client permission routing, not operating-system sandbox enforcement,
all Claude permission modes, late approvals after cancellation, or a model's
approval judgment.

The control-protocol interruption records observed in the tested Claude versions
do not include `interruptedMessageId`, which the current Backend uses to reconcile
an interrupted trace on the next prompt. The suite therefore does not claim
interrupted trace or metadata reconciliation. It separately proves native
cancellation and the absence of cancelled-turn automatic Add through recovery.

The wrappers use temporary user, Claude, and Backend homes, an isolated npm
prefix, synthetic credentials, and test-only `node-pty@1.1.0` for real terminal
input. Each suite checks owned-process cleanup before the wrappers remove the
runtime. Windows uses the same
exact-prefix user PATH cleanup guard as Codex and OpenCode, including its
interruption and concurrent-update limitations, and CI selects `runner.temp`
through `TEMP` and `TMP`. Native Windows execution requires PowerShell 7 and
Git for Windows; WSL is not Windows coverage. Reports exclude private homes,
raw transcripts, model output, credentials, and Backend tokens.
POSIX cleanup retains owned process groups after their leaders exit. Windows
cleanup targets live CLI process trees and the recorded Backend; arbitrary tool
processes orphaned after their parent exits are not covered by this smoke.

These checks do not cover Desktop/editor UI,
ordinary-user/UAC behavior, real system credential stores, live model quality,
or default buffered/chunked writeback. Do not report those as passed based on
this smoke result.

On macOS or Linux, use `memorax_dev make test-claude-e2e` to validate the package
and run the baseline. To reuse a validated artifact or select another exact
Claude version:

```bash
bash scripts/claude-install-check.sh dist/npm/tarballs 2.1.277 0.1.18
```

On native Windows, download the package artifact and use a disposable
PowerShell 7 session with Node.js 22 or later, npm, and Git for Windows:

```powershell
./scripts/claude-install-check.ps1 -TarballDirectory dist/npm/tarballs -ClaudeVersion 2.1.277 -PreviousVersion 0.1.18
```

Local `node scripts/claude-e2e.mjs [TARBALL_DIR] [CLAUDE_VERSION] [PREVIOUS_VERSION]`
delegates to the platform wrappers. It does not build or validate the package
itself; use the Make target when the artifact has not already passed
`npm-package-check`.

### CodeBuddy Functional CI

The CodeBuddy Code matrix uses the same workflow and validated MemoraX Code
tarball, with a separate `CodeBuddy functional result` check.
It installs the official `@tencent-ai/codebuddy-code` npm package. Version
2.159.0 is the baseline; npm's latest stable version is resolved once per run
and installed as an exact version without fallback. Both tracks run on Ubuntu,
macOS, and Windows with Node.js 24. Ubuntu also runs the baseline with Node.js
20, covering MemoraX Code's minimum and satisfying CodeBuddy's runtime
requirement. When latest equals baseline, the Node.js 24 jobs cover both
tracks without duplicates. Requested and installed CLI versions must match.

The result requires both the package job and every CodeBuddy functional job to
succeed; failed, cancelled, or skipped dependencies cannot pass it. Existing
Codex, OpenCode, and Claude checks keep their independent results. Provider-only
and OpenCode initialization diagnostic dispatches skip this matrix and result.

Fresh npm installation and public command shims are prerequisites. The suites
exercise real installed setup and lifecycle commands, CodeBuddy's managed global
prompt Hook and Skill, a loopback model server, and a separate loopback Memory
receiver:

| Functional scenario | Evidence |
| --- | --- |
| Installation and lifecycle | Empty or multiline stdin rejection, real-PTY cancellation and hidden credentials, fresh and repeated setup, port-conflict recovery, stop/start, uninstall/reinstall, and retained account, model settings, and synthetic memory |
| Upgrade and failure recovery | Published `0.1.18` to candidate upgrade, failed artifact download retaining the old Backend, forced reinstall, injected postinstall exit `23`, and recovery/retry through public commands |
| Setup interruption | Interruption after configuration publication, before and after Backend start, and at the saved-account API-key prompt; retry without re-entering the account, followed by a native turn and saved-account Search |
| Cold first turn | Native session, Hook reminder in model context, and complete three-part Unicode prompt and answer in automatic Add |
| Same-session resume and tool | The real client resumes the exact session, executes Bash, and correlates native tool IDs, arguments, results, session environment, and completed content |
| Redaction | Synthetic API-key content is excluded from outgoing Memory messages |
| Workspace separation | A new native session in a different workspace retains its own content and workspace scope |
| Explicit CLI and Skill | Public Search in JSON and plain forms and Add, then scripted native Skill, Read, and Bash calls to the packaged Skill's documented commands |
| Permission control | Native preallow, approval, denial, cancellation, interruption while waiting, and interruption of an in-flight tool, with actual file effects and same-session recovery |
| Repo Memory global configuration | A real foreground Hook starts the installed native worker in an isolated Git repository; foreground and worker requests use the globally configured synthetic model and local endpoint |

The native Memory suite requires six completed turns, thirteen model requests,
and eleven Memory requests: six automatic Add, two explicit Add, and three
explicit Search. Independent native JSONL selection, trace correlation,
workspace identity, idempotency, and native timestamps when present are checked.
CodeBuddy creates the transcripts and Hook identities; test-authored transcripts
and direct Hook calls are not substitutes for native evidence. Scripted Skill
execution checks the packaged instructions and real tool path, not a model's
ability to decide when to use Memory. Local oracle and harness unit tests run
before packaging and remain separate from native-client evidence.

The permission suite uses CodeBuddy's bidirectional `stream-json` control
protocol and its `allowed`/`reason` permission response. Denial may still finish
normally and write back the completed answer. Cancellation through a permission
response requires the matching native interruption result, no automatic Add
for the cancelled turn, and successful recovery in the same process and session.

The two explicit `interrupt` cases validate MemoraX writeback against the
client's actual persisted outcome, rather than requiring a particular CLI
`result` event or assuming that an acknowledgement proves cancellation. The
in-flight case still requires the owned tool process to exit before recovery,
without its delayed file effect. Recovery must complete and write back in the
same process and session. After the CLI exits normally, the independent native
transcript oracle classifies the original turn: an incomplete turn must have no
Add, while a turn that the client completed despite interruption must have its
own exact Add. Every completed turn is checked separately for content, scope,
native identity, and idempotency; a final audit after Backend shutdown rejects
late, duplicate, missing, and foreign writes. Extra original model requests and
missing result events remain visible as separate compatibility observations,
not proof of MemoraX Add failure or successful native interruption. A recovery
prompt may itself affect the old turn; this does not isolate the effect of
`interrupt` alone. The suite does not claim late-approval handling,
operating-system sandbox enforcement, automatic approval judgment, or
interrupted trace and metadata reconciliation.

The Repo Memory case removes process model/provider overrides and uses isolated
global `settings.json` and `models.json`. It correlates the real foreground
transcript, complete worker prompt, native job ownership, and actual model
requests. The deterministic worker returns text without authoring a bundle, so
the required outcome is native exit `0` followed by `artifact_validation_failed`,
with no Memory requests and no injected artifacts. Cleanup must confirm the
recorded worker and child have exited. The foreground stream-JSON client stays
open until that worker finishes, then its input closes and its exit is checked;
this does not test worker survival after the foreground client exits.
This is bounded global-configuration and dispatch coverage, not valid Repo
Memory generation, per-turn model override inheritance, worker permission
inheritance, or independent background native session identity; the product
worker disables session persistence.

The shared categories align with the other client suites, but their native
protocols and bounded assertions are not identical. WorkBuddy, Desktop/editor
UI, ordinary-user/UAC behavior, real credential stores, live model quality, and
default buffered/chunked writeback are outside this result.

Wrappers isolate user and CodeBuddy homes, Backend state, npm configuration,
cache and installation prefix, with test-only `node-pty@1.1.0` for terminal
interaction. The native harness uses synthetic credentials
and loopback services, without model login or paid model calls, and confirms
owned-process cleanup before temporary state is removed. Windows uses the same
exact-prefix user PATH cleanup guard as the other suites, with its documented
interruption and concurrent-update limits; CI selects `runner.temp` through
`TEMP` and `TMP`. Native Windows requires PowerShell 7 and Git for Windows;
WSL is not Windows coverage. Reports exclude raw transcripts, model output,
credentials, Backend tokens, and private paths.
POSIX cleanup confirms owned process-group exit. Windows cleanup covers live
CLI process trees and the recorded Backend, not arbitrary tool processes
orphaned after their parent exits. Unverified cleanup fails the suite and retains
its isolated state.

On macOS or Linux, `memorax_dev make test-codebuddy-e2e` validates the package
and runs the baseline. To reuse a validated artifact:

```bash
bash scripts/codebuddy-install-check.sh dist/npm/tarballs 2.159.0 0.1.18
```

On native Windows, use a disposable PowerShell 7 session with Node.js 20 or
later, npm, and Git for Windows:

```powershell
./scripts/codebuddy-install-check.ps1 -TarballDirectory dist/npm/tarballs -CodeBuddyVersion 2.159.0 -PreviousVersion 0.1.18
```

`node scripts/codebuddy-e2e.mjs [TARBALL_DIR] [CODEBUDDY_VERSION] [PREVIOUS_VERSION]`
delegates to the platform wrappers. It does not itself build or validate the
package; use the Make target when the artifact has not passed
`npm-package-check`.

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
