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
`CLAUDE_CONFIG_DIR`, `DSH_HOME`, `OPENCODE_CONFIG_DIR`, `CODEBUDDY_HOME`,
`TRAE_CN_HOME`, `CURSOR_HOME`, and `QODER_CONFIG_DIR`; account for the aliases
`CLAUDE_HOME`, `WORKBUDDY_HOME`, `TRAE_HOME`, `QODER_CLI_HOME`, and
`QODER_CONFIG_DIR_NAME` as well. `PATH` still contains installed programs, so a temporary
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
| [Native CI failure register](docs/native-ci-failure-register.md) | Native CI failure signatures with their first and later sightings, rechecks, and status | A native CI cell fails, a registered signature recurs or is rechecked, or an entry's status changes; follow the [register rules](#native-ci-failure-register) |
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
  Manual runs compare the selected commit with its first parent; release
  acceptance passes its own comparison base (see [Release Acceptance](#release-acceptance)).

Both checks run without path filters and keep stable names. Full package
installation and real-client checks remain separate from these basic checks.
Use the Install/artifacts profile below for packaging or lifecycle changes.
These checks require no model, MemoraX, or Jev credentials. Branch protection
for `main` is described in [Merge Checks](#merge-checks).

Choose checks by impact from the profiles below. For architecture changes,
the [change-routing table](ARCHITECTURE.md#8-test-architecture-and-change-routing)
maps boundaries to owning tests and named profiles. Focused tests shorten the
edit loop; complete all profiles required by the final change before handoff.
Documentation edits also require the Documentation profile; CLI, lifecycle,
and artifact changes require Install/artifacts in addition to affected suites.

### Merge Checks

The CI workflow and the
[native client functional workflow](.github/workflows/macos-codex-install.yml)
run on every pull request targeting `main`, including drafts, and on every push
to `main`, without path filters. Pull request runs report these three checks,
which together form the merge gate for `main`:

| Check | Workflow | Covers |
| --- | --- | --- |
| `Tests` | CI | Basic regression suite |
| `Documentation` | CI | Documentation contracts and README synchronization |
| `PR acceptance` | Native client functional checks | Native client scope, package job, contract tests and the result of every client the scope selects |

Every pull request runs the `Native client scope` job, the package job with its
CI script contract tests and `make npm-package-check`, and the WorkBuddy
releases job's contract tests. The scope job compares the pull request merge
commit with its base and selects the clients whose native matrices the changed
files can affect, using the rules in
[native-scope.mjs](scripts/ci/shared/native-scope.mjs). It narrows the native
matrices for documentation, standalone tests and client CI files; a product
adapter change still runs every client's matrix, as described below.

- Documentation (`docs/`, root Markdown files, `LICENSE`, issue and pull request
  templates, and lint configuration) selects no client.
- A shared or unclassified file selects every client. Shared files are the
  canonical Skill and the client Hook runtime, in the `skills/`, `src/` and
  `runtime-hooks/` directories of the Codex and Claude adapters, and the
  adapter-common, Backend and npm packages. Unclassified files include root
  files such as the `Makefile`, the workflows, `scripts/ci/shared/`, and any
  other file outside a client's directories.
- A client's CI file selects that client: `scripts/ci/<client>/`, and
  `scripts/fixtures/cursor-app/` for Cursor App. A test, under a `test/`
  directory or named `*.test.*`, selects no client by itself.
- Either one also selects every client whose native job names it, directly or
  by glob, or names or owns a file that names it. These references are followed
  by file name across directories, so a Codex helper that every client's checks
  import selects every client, and a file named by a shared or unclassified file
  selects every client. Mentions in documentation, workflows and the `Makefile`
  do not count.
- DSH and Qoder CI files select no client; this workflow has no native matrix
  for them.

Product adapter changes are the conservative boundary of this version: they
still run every client's complete native matrix, and the scope does not route
adapter changes precisely. It assigns each adapter
(`packages/ts/memorax-code-<client>-adapter/`) to its clients (the CodeBuddy
adapter to CodeBuddy and WorkBuddy, and the DSH, Qoder and Trae adapters to
none), but shared code names every adapter file other than tests, so the
references above select every client. Some of these references are real:
`memorax-code-setup.mjs` imports adapter path and configuration modules, and the
Backend loads client plugin installers and configuration to clean up removed
plugins. Others only match a file of the same name. An adapter's tests run in
`Tests` and select no client. Narrow an adapter path only when it is shown to be
independent and keeps blocking unrelated pull requests.

The rules follow file names, not paths a script builds at run time; such a file
is covered only through its client's directory. A repository file that cannot
be read, other than a link to a directory, fails the scope job instead of being
skipped.
Contract tests that only the package or WorkBuddy releases job runs, such as
`codebuddy-native-content-check.test.mjs`, select no client, because every pull
request runs them. The scope job's summary lists each changed file with its
clients and reason.

A selected client keeps its complete matrix: the same platforms and suites as
release acceptance, with the baseline and accepted versions pinned in the
[client acceptance manifest](#client-acceptance-versions) instead of a latest
lookup. The package job reads client and desktop release versions only for
selected clients, and the WorkBuddy releases job reads WorkBuddy releases only
when WorkBuddy is selected. An unselected client looks up and downloads no
version, runs no matrix, and skips its result job.
Each selected client still reports `Codex functional result`,
`OpenCode functional result`, `Claude native smoke result`,
`CodeBuddy functional result`, `Cursor App canary result`, or
`WorkBuddy functional result`; the WorkBuddy result also requires the release
resolution.

`PR acceptance` requires the scope, package, and WorkBuddy releases jobs to
succeed, every selected client's result to succeed, and every unselected
client's result to be skipped. Anything else fails it: a selected client that
was skipped or cancelled, an unselected client whose result ran, a missing or
malformed selection, or a failed scope, which selects no client. Its summary
reports each unselected client as `not selected: this pull request does not
validate it`; not running a client's matrix is never reported as passing it.

`PR acceptance` and each selected client's result job also run after a
dependency fails; failed, cancelled, or skipped dependencies fail them. Push,
scheduled, manual, and release acceptance runs reuse only the `Tests` and
`Documentation` names, whose jobs always execute. Their other result names add
the purpose, such as `(main push)`, `(compatibility monitor)`, or
`(release-acceptance)`, and provider-only runs report
`Codex provider-only result`. These results stay visible without being mistaken
for pull request acceptance. In each workflow, a newer run cancels an older one
only for the same pull request, for pushes to `main`, for compatibility
monitors, or for the same manual mode on the same ref; release acceptance runs
are never cancelled.

A push to `main` runs a health check, not this acceptance: pull requests run it
before merging, and release acceptance runs it for a candidate. Besides `Tests`
and `Documentation`, the native client functional workflow then runs only its
package job: the CI script contract tests, `make npm-package-check` with its
isolated installation smoke tests, and the package checksum, upload, and input
record, which marks native client checks `NOT_APPLICABLE`. It resolves no client
or desktop release versions and skips the scope, every client matrix, WorkBuddy,
PR acceptance, and result job. These skipped placeholders never carry a merge
check name and claim no functional acceptance.

The native client functional workflow also runs on `main` every day at 03:17
UTC as a compatibility monitor. Like release acceptance, it resolves every
client's baseline and official latest versions, not the pinned versions pull
requests use, and runs every client's complete matrix, including WorkBuddy, but
it records no release candidate. It neither gates merges nor accepts a release:
a failure shows that a client release, platform, or service changed, or that
`main` regressed for a client that no recent pull request selected. A client
whose matrix passes here becomes a candidate for the next
[acceptance update](#updating-accepted-versions). GitHub sends a scheduled run's
failure notification only to the user who last changed its `cron` line, so
maintainers should review the monitor's runs.

Once the package job, and for WorkBuddy the release resolution, has succeeded,
each client's result job looks up every cell of its matrix, by the job name the
workflow gives it, in this attempt's job listing from the GitHub API, and
classifies the cell by its channel, version, and conclusion. A failed cell whose
channel includes `baseline` or `accepted` is a `baseline-regression`. A failed
`latest` or WorkBuddy `fallback` cell is `client-release-deferred` when the
client's `deferred` list in the
[client acceptance manifest](scripts/ci/shared/client-acceptance.json) holds its
version back for that cell, and `client-release-new` otherwise: register its
signature in the
[native CI failure register](docs/native-ci-failure-register.md) first, then
defer the version or fix it. A `deferred` entry that lists `platforms` applies
only to WorkBuddy cells on those release platforms; one without `platforms`
applies to every cell of its version. On the compatibility monitor, in place of
the entire-matrix requirement that each client section describes, a client's
result passes only when every cell succeeded or was deferred, and each deferred
cell leaves a notice. A regression, a new client release failure, a cell that
did not complete (cancelled, timed out, or skipped), a cell missing from the
listing or listed twice, an unreadable listing, a missing matrix, or a matrix
result that the cells do not explain fails it. A deferred cell still failed, so
a passing result does not make its version a candidate for an acceptance
update. Every other run, except a provider-only one, reports the same classes
but still requires the entire matrix to succeed. The job summary lists each
cell's channel, version, conclusion, and class, and the record is uploaded as
`client-result-<client>-attempt<N>`.

Protect `main` in GitHub branch protection by requiring `Tests`,
`Documentation`, and `PR acceptance` from GitHub Actions, requiring branches to
be up to date before merging, requiring a pull request before merging, and
including administrators. Do not require the client result checks: `PR
acceptance` already requires the result of every selected client, and an
unselected client's result job is skipped, so a required client result would
either never report under its formal name or report a skip that validates
nothing. When `main` moves, update
an open pull request to rerun both workflows on the new merge result. This
setting is managed separately from the workflows. The `Tests` check runs
`scripts/ci/shared/workflow-scenarios.test.mjs`,
`scripts/ci/shared/native-scope.test.mjs`,
`scripts/ci/shared/client-acceptance.test.mjs`, and
`scripts/ci/shared/client-result.test.mjs`. The first evaluates the
expressions these workflows use for triggers, job conditions, the package job's
pinned and latest version lookups, check names, and concurrency groups in each
event, manual selection, and client selection, and runs each result script,
including `PR acceptance`, against failed, cancelled, and skipped dependencies
and partial selections. The second checks the selection rules, the command on a
merge commit, and this repository's own files. The third validates the client
acceptance manifest and, without network access, its fail-closed reader. The
fourth classifies the job listings of recorded monitor and pull request runs
with their matrices and checks each client's cell names against the workflow.
All four are source contracts, not a complete model of GitHub Actions
execution.

### Client Acceptance Versions

Pull requests install fixed client versions from the version-controlled
[client acceptance manifest](scripts/ci/shared/client-acceptance.json) instead
of querying the latest release; the compatibility monitor and release acceptance
keep resolving official latest releases. Each client has two channels:

- `baseline` is the reproducible floor named in each client section below. It
  changes only together with the code that pins it, never in a routine update,
  and the tests require both to agree.
- `accepted` is the most recent version that passed this repository's native
  matrix. Pull request matrices, summaries, reports, and artifact names label it
  `accepted`, or `baseline+accepted` when it equals the baseline, never `latest`.

Every entry records its version and acceptance: the runs that passed it, with
failed cells, rechecks, and warnings kept on record. npm clients record the
package, registry, `dist.integrity`, and `dist.shasum`. Cursor App records the
release commit and, per platform, the download URL, SHA-256 with its source,
and size. WorkBuddy records each platform's desktop package (version, URL, and
SHA-256) separately from its bundled runtime version. A client's `deferred` list
names versions held back after a failed acceptance. `runs` gives each cited
run's event, pull request, head commit, date, and rerun scope, and `gaps` lists
what the records do not establish.

The manifest's `node` section pins the exact Node.js release of each major the
native matrices run (`24`, `22`, and `20`), and every run builds its matrices
from it, not only pull requests. A matrix cell keeps the major in `node`, which
job names, artifact names, and report matching use, and `actions/setup-node`
installs the cell's `nodeVersion`. Jobs outside the matrices, including both CI
workflow jobs, read the root `.node-version`, which must equal the pinned `24`
release; a contract test checks it and every setup-node step. No job enables
`check-latest` or a setup-node cache. The Codex, OpenCode, Claude Code, and
CodeBuddy Code input records keep the pinned release next to `process.version`
with a `versionMatches` flag, and their job summaries mark a mismatch.

A pull request reads only the entries of the clients it selects; an unselected
client is neither looked up nor downloaded.
[client-acceptance.mjs](scripts/ci/shared/client-acceptance.mjs) compares both
pinned npm versions with the registry's `dist.integrity` and `dist.shasum`
before the matrix runs. Cursor App freezes the recorded releases, and each
download must match its recorded SHA-256 and, where one is recorded, its size.
WorkBuddy runners
require the recorded bundled runtime version and the recorded SHA-256 on macOS
and Windows and for an accepted Linux release with its own job; the Linux
baseline hash stays advisory. A missing client or channel, an unreadable or
invalid manifest, a failed registry lookup, or an integrity mismatch fails the
run; nothing falls back to a latest lookup or another version.

The manifest and its reader live in `scripts/ci/shared/`, so changing either
selects every client and runs every client's complete native matrix: an
acceptance update is never treated as a change that needs no client tests.

#### Updating Accepted Versions

Accepted versions change only through a reviewed pull request. Collect a week's
updates in one pull request:

1. For each client, choose the newest version that passed its complete matrix
   in a recent compatibility monitor or release acceptance run. The run's input
   record and summaries name the exact versions. Cursor App's frozen inventory
   and cell evidence record the download hashes and sizes, and the WorkBuddy
   frozen releases and reports record the reference and downloaded SHA-256.
2. Record each chosen version under `accepted` with its download source and
   integrity, add the runs to `runs` and to its `acceptance`, and keep earlier
   failures and warnings on record.
3. Check the edit with `node --test scripts/ci/shared/client-acceptance.test.mjs`
   and, for each updated npm client,
   `node scripts/ci/shared/client-acceptance.mjs npm-matrix <client>`, which
   compares the recorded integrity with the registry.
4. Merge only after `PR acceptance` passes: the manifest change runs every
   client's complete matrix with the new inputs. When a client fails, restore
   its previous `accepted` entry, add the failed version to its `deferred` list
   with the runs and reason, and keep the other updates. Retry the deferred
   version in a later update.

The same weekly update refreshes the `node` section. `24` and `22` follow the
releases preinstalled in the runner images, which setup-node reports as
`Found in cache`; write the new `24` release to `.node-version` as well. Images
roll out at different times: a runner whose image lacks the pinned release
downloads that release from `actions/node-versions` instead, so the pin still
holds. Node 20 has reached end of life, so `20` stays at its final release.

Nothing commits, opens, or merges these updates automatically. A pull request
that needs a newer client waits for the next update or carries its own manifest
change, which runs every client's matrix.

### Release Acceptance

Manual dispatch of the
[native client functional workflow](.github/workflows/macos-codex-install.yml)
defaults to `mode=release-acceptance`. It runs the complete acceptance for the
dispatched commit: the CI workflow's `Tests` and `Documentation` jobs, called
with an explicit purpose, candidate commit, and comparison base; the package
job's single candidate tarball; and every client matrix, including WorkBuddy.
It never applies the pull request scope or its pinned versions: it resolves
every client's official latest versions, runs every matrix, and skips the scope
and `PR acceptance` jobs. The other
modes, `provider-only`, `opencode-initialization-diagnostic`, and
`workbuddy-download-diagnostic`, are isolated diagnostics and never accept a
release.

The `Release candidate` job records the dispatched commit as both the candidate
and the test-script commit; an optional `expected_sha` must equal it. It records
release eligibility separately from acceptance: the ref must be `main`, versions
must be consistent, `CHANGELOG.md` needs a dated entry for the version, no
`v<version>` tag may exist, the version must be newer than the previous release
tag, and npm must show that the version was never published. Only stable
`MAJOR.MINOR.PATCH` versions are releasable; a prerelease or build version is
`NOT_RELEASABLE` (`PRERELEASE_NOT_SUPPORTED`) and is never compared, and
prerelease tags and npm prereleases are not part of the release history. npm's
stable releases must agree with that history, so publishing the candidate as
`latest` cannot move `latest` backwards or skip a release: no newer stable
version may be published, the newest stable version besides the candidate must
be the previous release tag (none when no tag is reachable), and `latest` must
point to the newest stable version. A failed or unreadable npm query leaves
eligibility unconfirmed rather than unpublished. The
job also records the previous release tag, the commits and merged pull requests
since it, and the README comparison base: the previous release commit, or the
first parent when no release tag is reachable. Eligibility never decides which
jobs run, so a dispatch from another branch still runs the complete acceptance
and only reports `NOT_RELEASABLE`.

`Release acceptance result` downloads the candidate by its artifact ID, confirms
through the API that the artifact belongs to the run, has not expired, and has
the recorded digest, recomputes the tarball's SHA-256, and reads the package name
and version from the tarball. It reads the job listing of every attempt of the
run, including the current one, which it reads while it still runs. A failed query, a missing, empty or unreadable
listing, missing pages, or jobs of another run or attempt leave acceptance
`INCOMPLETE` with the attempt and its status, never an attempt without failures;
the job results are still recorded. Each WorkBuddy cell's report must come from
the attempt in which the cell last ran, identified through those listings by the
cell job's start time and runner: a cell that did not run again keeps its earlier
report, and one that ran again without a new report, or whose execution a listing
does not identify, is `INCOMPLETE` rather than using an older one. The report's schema,
run, attempt, platform, Node.js version, channel, versions, download host and
reference hash must match the run and the frozen release; only Linux may record a
hash warning. It records acceptance (`PASS`, `FAIL`, or
`INCOMPLETE`) and eligibility (`RELEASABLE`, `NOT_RELEASABLE`, or `UNCONFIRMED`)
separately; the verdict is `PASS`, and the job succeeds, only when both pass. The
`release-acceptance-record-attempt<N>` artifact keeps the verdict, both commits,
the package file, artifact ID, artifact digest, and tarball SHA-256, the frozen
client versions, each WorkBuddy cell's verified versions, hashes and attempt and
the coverage report, each attempt's status and unsuccessful jobs, and the
previous release range.
Each release acceptance has its own concurrency group and is never cancelled by
another run. Upgrade suites install fixed earlier versions; upgrading from the
previous release to the candidate is not exercised.

Publishing stays manual and must use the accepted file:

1. Download the recorded package artifact from the accepted run. Do not rebuild;
   `make npm-publish-dry-run` builds a new package, not the accepted file.
2. Confirm the file's SHA-256 against the record.
3. Run `npm publish <file> --access public --tag latest`.
4. Compare `npm view @memorax/memorax-code@<version> dist.integrity dist.shasum`
   with the file's SHA-512 and SHA-1.
5. Tag `v<version>` at the candidate commit and attach the same file and its
   `SHA256SUMS` to the GitHub Release.

These steps are a procedure, not a technical lock on other publishing paths.

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
| Qoder | `npm test --prefix packages/ts/memorax-code-qoder-adapter` |
| Repo Memory | Backend + Shared Skill + `make test-adapter-common`: collector, validator, and updater cases use compiled Backend helpers through the canonical Skill launcher; common tests own scheduling and policy behavior. Add affected adapter profiles when their scheduling or launchers change |
| Adapter-common/shared Hook | `make test-adapter-common`, affected Backend tests, and all eight adapter suites; add Shared Skill for changes used by Skill readers or launchers and Install/artifacts when staged runtime or package layout changes |
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
[Codex](scripts/ci/codex/windows-codex-e2e.mjs) and
[Claude](scripts/ci/claude/windows-claude-e2e.mjs) runners use real clients for installation.
The older Claude runner supplies synthetic Hook inputs; it does not establish
native conversation or transcript writeback. Inspect each script's prerequisites
and isolation before using it; a macOS/Linux suite or
WSL run does not replace native Windows validation.

Live-provider, MemoraX-backed, and live Jev checks are explicit opt-in tests.
The credential-free Codex, OpenCode, Claude, CodeBuddy, and WorkBuddy functional checks
below run on each pull request whose changes can affect that client (see
[Merge Checks](#merge-checks)), in the daily compatibility monitor, and in
release acceptance. Report
native-client and synthetic evidence separately, record platform and scenarios,
redact output, and explain any relevant checks not run. Public fixtures must never contain
real API keys, private transcripts, personal memory, or infrastructure
credentials.

### DSH Native Compatibility Checks

The DSH adapter and Backend suites cover legacy Session formats and v4,
producer-owned context sources, resume reconciliation, compaction, and CLI versus
Desktop Profile management. Native lifecycle fixtures simulate launcher discovery
and version drift; they do not establish Desktop GUI behavior.

`MEMORAX_CODE_DSH_E2E=1 make test-dsh-e2e` runs the installed npm artifact against
the pinned DSH release using isolated client and Backend homes, synthetic
credentials, and local model and MemoraX services. Set
`MEMORAX_CODE_DSH_E2E_VERSION` to an exact release when checking another version,
and `MEMORAX_CODE_DSH_E2E_MEMORAX_TARBALL` to reuse a validated artifact.
`MEMORAX_CODE_DSH_E2E_RUNTIME_PREFIX` may point to a separately prepared test npm
prefix containing that exact DSH and mock-server version plus the pinned pnpm;
only these runtime packages are reused, while all client and Backend state stays
isolated. The runner
checks native Turn writeback, excluded context and reasoning, interruption and
resume, Backend recovery, Profile reconciliation, and stop/uninstall preservation.
Failed runs retain their isolated directory and redacted process logs for diagnosis;
successful runs remove it. Review retained artifacts before sharing them.
Optional Office packages are omitted; this check does not qualify those features
or the Desktop window. A failed newer-release check must not be reported as a pass
based only on the older-version tests or adapter status.

On macOS, check an official Desktop installation or read-only mounted distribution:

```bash
node scripts/ci/dsh/dsh-desktop-native-check.mjs \
  --desktop-command "/path/to/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" \
  --tarball "/path/to/memorax-code.tgz"
```

The runner creates isolated homes, initializes the reserved
`desktop` Profile through the bundled runtime, installs and removes the plugin
with the native launcher, and completes a v4 Turn using Electron and local mock
services. It verifies clean QA writeback and stops the Backend during cleanup.
Model execution is restricted to loopback connections. Use `--artifacts-dir` for
an output directory outside the repository; review and redact local diagnostics
before sharing. This check exercises the Desktop host runtime, not GUI interaction
or native Windows behavior.

### Native CI Script Layout

Native-client runners, helpers, and their adjacent tests are grouped under
`scripts/ci/`:

- `codex/`, `claude/`, `dsh/`, `opencode/`, `cursor/`, and `qoder/` own each client's checks.
- `codebuddy-workbuddy/` owns both clients' entrypoints and shared checks.
- `shared/` owns cross-client cleanup tests, Windows user PATH utilities, the
  first-failure evidence recorder, the workflow scenario contract, the pull
  request native client scope, the client acceptance manifest and the release
  acceptance record.

The pull request scope relies on this layout: a file in a client's CI directory
selects that client, and a file elsewhere selects every client. Product adapter
changes also select every client in this version (see
[Merge Checks](#merge-checks)). Add a new client's CI directory and adapter to
`OWNERS` in [native-scope.mjs](scripts/ci/shared/native-scope.mjs) when its
native job is added, and add shared code that lives in an adapter, like the
canonical Skill, to its shared rule.

Keep existing Make targets as the developer entrypoints. Repository-wide build,
package, documentation, and release scripts remain directly in `scripts/`;
Cursor App image assets remain in `scripts/fixtures/cursor-app/`.

### Native CI First-Failure Evidence

The Codex, OpenCode, Claude and CodeBuddy functional jobs record first-failure
evidence by default; the other clients keep their existing reports, and the
WorkBuddy job runs the shared CodeBuddy wrappers without an evidence directory,
so its runners keep their previous environment. The wrappers read
`MEMORAX_CI_EVIDENCE_DIR` before clearing the environment, require an empty real
directory outside the test runtime, and pass it only to the test runners; an
unusable directory disables evidence without changing the result. They keep a
ledger of the wrapper phase (`setup`, `suites`, `cleanup`) and of each planned
suite (`PASS`, `FAIL`, `NOT_RUN`, `INCOMPLETE`, `SKIPPED_BY_DESIGN`); suite
order, fail-fast behavior and assertions are unchanged. A GitHub `pwsh` step
exits with `$LASTEXITCODE`, so the PowerShell evidence helpers restore it after
every call. After their native suites and evidence export, the Codex and
OpenCode Windows jobs run a CI tool self-test: all four wrappers under real
PowerShell with stub suites,
failing ledger calls and an unusable evidence directory. It fails the job when
any expected test fails or is skipped, and reports on its own summary line
instead of in `testOutcome`.

The Codex installation and setup-interruption suites, Claude installation
smoke, and OpenCode background Repo Memory case append a journal when their
progress or key observations change, so records
written before a runner is killed stay readable; an interrupted last record is
reported as a truncated tail. Before cleanup removes the runtime, a failure
collects the product's `logs --diagnostics` records, Repo Memory job state,
owned process state and trace event types, each under its own time budget.
A failed Codex installation run also records, from disk rather than through the
installed CLI, the entry point status, installed package version, package
transition state, Backend PID record, the liveness of that record's process and
the update registry's request counts, each with its own status and time budget.
A skipped `logs --diagnostics` collection records why, and cleanup records
whether it issued `stop` or why it did not and, under a time budget, whether a
remaining PID record's process is still alive.
Codex setup retries preserve the observed terminal exit and fixed product
stages before terminal disposal. Claude replacement checks record separate
artifact-pack, expected update rejection, recovery and readiness phases.
Primary functional failures and later cleanup failures remain separate;
missing observations stay unknown. Awaited collection keeps its deadline active
until the collector settles or times out. Collection and export failures do not
change the functional result. The shared setup terminal helper reports disposal
failures separately from the original setup failure; it does not signal an
exited Unix PID again.

Evidence holds typed allowlisted fields only: stages, error, system and exit
codes, signals, counts, booleans, relative times, versions, checksums and
aliases for paths inside the test root. Raw logs, command lines, configuration,
prompts, transcripts, trace payloads, credentials, PIDs and absolute paths are
excluded. Three results stay separate: `testOutcome` reports the native suites
and fails the job, while `evidenceStatus` and `exportStatus` only add warnings.
`evidenceStatus` is `UNAVAILABLE` when the test step ran without leaving a
ledger, and `PARTIAL` when an expected record is missing, damaged or cut at the
read limit. A skipped step owes nothing, and only an instrumented suite that ran
owes a journal and a result, so unreached, skipped and uninstrumented suites do
not make evidence partial. The CodeBuddy suites write no journal or result and
are listed as `not_instrumented`: their evidence is the inputs record and the
wrapper ledger, which shows the failed, unreached or unfinished suite and the
wrapper phase. `COMPLETE` there covers only those records, and an uploaded
artifact is not complete suite evidence. The job summary marks every
uninstrumented suite `not_instrumented` and states this limit.
`exportStatus` is `UPLOADED` only when the upload step succeeded and returned an
artifact ID; otherwise it is `EMPTY`, `UPLOAD_FAILED` or `NOT_ATTEMPTED`. The
job summary prints a `client|os|suite|stage|code` signature and a category:
`functional`, `cleanup` or `functional+cleanup` from the failing suite's result,
`interrupted` for a suite that never ended and left no result (for an
uninstrumented suite, which never leaves one, only in a cancelled step),
`setup` or `wrapper_cleanup` for a wrapper failure before the suites or after
all of them passed, and `unclassified` otherwise. A suite whose end the wrapper
never recorded stays `INCOMPLETE` next to the outcome its runner reported: a
failure the runner reported keeps its category, and any other reported result
is `EXIT_UNCONFIRMED`. Such an uninstrumented suite outside a cancelled step is
`EXIT_UNCONFIRMED` as well, and `LEDGER_END_UNCONFIRMED_<SUITE>` makes the
evidence partial. Equal signatures do not prove the same root cause.

Artifact names carry the run attempt, so a re-run keeps every earlier attempt's
evidence and inputs: `native-evidence-<client>-<os>-<channel>-node-<n>-attempt<N>`,
the candidate `memorax-code-package-attempt<N>`, `cursor-app-releases-attempt<N>`,
and `native-client-inputs-attempt<N>`, which records the package SHA-256,
artifact ID and digest, and each frozen npm client version with its registry
integrity. A push to `main` uploads only the package and this record, which
then lists no client versions and marks `clientChecks` as `NOT_APPLICABLE`.
They are retained for 30 days. A passing re-run does not mark an
earlier failure as fixed. To keep evidence from a local run, set
`MEMORAX_CI_EVIDENCE_DIR` to a new directory before starting a wrapper.

### Native CI Failure Register

The [native CI failure register](docs/native-ci-failure-register.md) lists the
failure signatures of the native client functional workflow with their first
sighting, later sightings, rechecks, and status. It names runs, attempts, jobs,
and artifacts only. Maintain it in rounds:

- Work on one issue per round. A new signature that appears during a round is
  registered, not fixed, in that round.
- Save the evidence before classifying a failure. The same signature does not
  mean the same root cause: record "same signature recurred" or "not reproduced
  this run", not a cause.
- A cell gets at most one explicitly authorized job-level recheck per run. Do
  not use `gh run rerun --failed`, a whole-run rerun, or a dispatch to get
  green. A passing recheck is recorded as "first failure, single recheck
  passed, root cause undetermined", and the first failure stays on record.
- Do not relax assertions, add sleeps, or extend timeouts to make a failure
  pass.
- A skipped, todo, or cancelled result is not a pass.
- Do not merge while `PR acceptance` fails: return the pull request to Draft
  and keep its evidence.
- A failing cell on a client's latest release is recorded as `client-release`.
  Hold that version back through the manifest's `deferred` list, as described
  in [Updating Accepted Versions](#updating-accepted-versions).

### Codex Functional CI

The [native client functional workflow](.github/workflows/macos-codex-install.yml)
runs on pull requests targeting `main`, pushes to `main`, a daily compatibility
monitor, and manual dispatch. A pull request runs a client's matrix only when its
scope selects that client, and a push to `main` runs only its package job (see
[Merge Checks](#merge-checks)).
Reuse the basic `Tests` and `Documentation` jobs above; this workflow adds
installed-package and native-client evidence. It does not copy the source
regression suites.
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
the same artifact. Codex 0.147.0 remains the reproducible baseline. A pull
request also checks the [accepted version](#client-acceptance-versions); the
compatibility monitor and release acceptance instead resolve the npm `latest`
tag once. That exact release runs on all three systems with Node.js 24. When it
equals the baseline, those jobs cover both tracks without duplicate execution;
Ubuntu/Node.js 20 remains a baseline check. Requested and actual CLI versions
are recorded and must match. A failed accepted- or latest-version check fails
the workflow instead of falling back to the baseline.
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
`scripts/ci/codex/codex-model-inheritance-check.mjs`. That standalone script is retained
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
scripts/ci/codex/codex-install-check.sh dist/npm/tarballs 0.147.0 0.1.17
```

On Windows, download the workflow's `memorax-code-package-attempt<N>` artifact into `dist/npm/tarballs`,
then use a disposable PowerShell 7 session with Node.js and npm on PATH:

```powershell
./scripts/ci/codex/codex-install-check.ps1 -TarballDirectory dist/npm/tarballs -CodexVersion 0.147.0 -PreviousVersion 0.1.17
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

Manual dispatch with `mode=provider-only` runs only the existing provider
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
per client or operating system. OpenCode 1.18.18 is the reproducible baseline.
Pull requests also test the [accepted version](#client-acceptance-versions); the
compatibility monitor and release acceptance resolve npm's latest stable version
once instead. Either is tested as that exact version without fallback. Both
tracks run on Ubuntu, macOS, and Windows with
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
node scripts/ci/opencode/opencode-permissions-check.mjs PACKAGE_ROOT OPENCODE_EXECUTABLE --late-approval
```

For startup investigation, manual dispatch with
`mode=opencode-initialization-diagnostic` runs only the package check and a
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
bash scripts/ci/opencode/opencode-install-check.sh dist/npm/tarballs 1.18.18 0.1.18
```

On native Windows, download the `memorax-code-package-attempt<N>` artifact and use a disposable
PowerShell 7 session with Node.js, npm, and Git for Windows available:

```powershell
./scripts/ci/opencode/opencode-install-check.ps1 -TarballDirectory dist/npm/tarballs -OpenCodeVersion 1.18.18 -PreviousVersion 0.1.18
```

The Windows wrapper reuses the same exact-prefix user PATH cleanup guard as
Codex, including its interruption and concurrent-update limitations. Local
`node scripts/ci/opencode/opencode-e2e.mjs [TARBALL_DIR] [OPENCODE_VERSION]` delegates to
these platform wrappers; it no longer creates a separate candidate package or
injects a prebuilt Repo Memory bundle.

### Claude Native Smoke CI

The same workflow adds an independent Claude Code matrix and a `Claude native
smoke result` check. It covers the shared installation, upgrade recovery, setup
interruption, native memory, scripted Skill, permission, and Repo Memory global
configuration categories. Client-specific evidence and exclusions below still
differ from the Codex and OpenCode suites. It consumes the package job's exact
validated tarball and installs the official Claude Code CLI. Version 2.1.277 is
the baseline. Pull requests also test the
[accepted version](#client-acceptance-versions); the compatibility monitor and
release acceptance resolve npm's latest stable version once per run instead.
Either is tested as an exact release without fallback. Both tracks run on
Ubuntu, macOS, and Windows with Node.js 24. Ubuntu also checks the baseline with
Node.js 22, matching the official Claude npm package's minimum runtime rather
than MemoraX Code's Node.js 20 minimum. When the accepted or latest version
equals the baseline, the Node.js 24 jobs cover both tracks without duplicates.
Requested and installed Claude versions must match.

The result requires the package job and every Claude smoke matrix job to
succeed. Failed, cancelled, or skipped dependencies cannot pass it. Codex and
OpenCode keep their separate results. The manual diagnostic modes skip the
Claude matrix and its result. The default runs
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
bash scripts/ci/claude/claude-install-check.sh dist/npm/tarballs 2.1.277 0.1.18
```

On native Windows, download the `memorax-code-package-attempt<N>` artifact and use a disposable
PowerShell 7 session with Node.js 22 or later, npm, and Git for Windows:

```powershell
./scripts/ci/claude/claude-install-check.ps1 -TarballDirectory dist/npm/tarballs -ClaudeVersion 2.1.277 -PreviousVersion 0.1.18
```

Local `node scripts/ci/claude/claude-e2e.mjs [TARBALL_DIR] [CLAUDE_VERSION] [PREVIOUS_VERSION]`
delegates to the platform wrappers. It does not build or validate the package
itself; use the Make target when the artifact has not already passed
`npm-package-check`.

### CodeBuddy Functional CI

The CodeBuddy Code matrix uses the same workflow and validated MemoraX Code
tarball, with a separate `CodeBuddy functional result` check.
It installs the official `@tencent-ai/codebuddy-code` npm package. Version
2.159.0 is the baseline. Pull requests also install the
[accepted version](#client-acceptance-versions); the compatibility monitor and
release acceptance resolve npm's latest stable version once per run instead.
Either is installed as an exact version without fallback. Both tracks run on
Ubuntu, macOS, and Windows with Node.js 24. Ubuntu also runs the baseline with
Node.js 20, covering MemoraX Code's minimum and satisfying CodeBuddy's runtime
requirement. When the accepted or latest version equals the baseline, the
Node.js 24 jobs cover both tracks without duplicates. Requested and installed
CLI versions must match.

The result requires both the package job and every CodeBuddy functional job to
succeed; failed, cancelled, or skipped dependencies cannot pass it. Existing
Codex, OpenCode, and Claude checks keep their independent results. The manual
diagnostic modes skip this matrix and result.

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
client's actual persisted outcome, without assuming that an acknowledgement
proves cancellation. The waiting-permission case waits for the original turn's
matching terminal before sending recovery; the interrupt acknowledgement alone
does not mean permission rejection has finished. It accepts either the exact
completed fixture answer or the validated native interruption result, without
sending a late approval reply.
The in-flight case still requires the owned tool process to exit before recovery,
without its delayed file effect. Recovery must complete and write back in the
same process and session. Only these two cases may report a natural-exit timeout
as a separate compatibility observation after recovery writeback is verified.
The harness then stops only its owned CLI process tree and requires confirmed
shutdown; protocol errors, nonzero natural exits, and cleanup failures still
fail. Other permission cases continue to require a normal zero exit. After
client shutdown, the independent native transcript oracle classifies the
original turn: an incomplete turn must have no
Add, while a turn that the client completed despite interruption must have its
own exact Add. Every completed turn is checked separately for content, scope,
native identity, and idempotency; a final audit after Backend shutdown rejects
late, duplicate, missing, and foreign writes. Extra original model requests and
missing result events remain visible as separate compatibility observations,
not proof of MemoraX Add failure or successful native interruption. Natural exit
and forced cleanup are reported separately. An incomplete turn observed after
forced cleanup does not prove that the native interrupt ended that turn. A recovery
prompt may itself affect the old turn; this does not isolate the effect of
`interrupt` alone. The suite does not claim late-approval handling,
operating-system sandbox enforcement, automatic approval judgment, or
interrupted trace and metadata reconciliation.

Only the explicit-interrupt recovery oracle recognizes late incomplete tool
results appended after the recovery prompt, before or after its completed answer.
The original prompt, tool call, arguments, and distinct original/recovery request
identities must prove that those results belong to the original turn. Only one
or two incomplete, skipped results in a single ordered parent chain with the
recovery answer may be excluded from its content selection; native records are
not mutated. Their total count is reported as compatibility evidence, not recovery
activity. Missing or conflicting identity, recovery-owned tool results, extra
branches, and additional recovery answers still fail; the generic completed-turn
oracle remains unchanged.

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

CodeBuddy and WorkBuddy share the selected fixture Git on the worker's PATH,
without displacing the isolated Node or native-client commands. If no job is
created, failure reports include matching Hook failure codes, pending workspace
checks, and read-only Git ref/HEAD probes marked `after_failure`. These probes
describe the later environment, not the original scheduler's decision; they
do not retry scheduling or replace the original failure.

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
bash scripts/ci/codebuddy-workbuddy/codebuddy-install-check.sh dist/npm/tarballs 2.159.0 0.1.18
```

On native Windows, use a disposable PowerShell 7 session with Node.js 20 or
later, npm, and Git for Windows:

```powershell
./scripts/ci/codebuddy-workbuddy/codebuddy-install-check.ps1 -TarballDirectory dist/npm/tarballs -CodeBuddyVersion 2.159.0 -PreviousVersion 0.1.18
```

`node scripts/ci/codebuddy-workbuddy/codebuddy-e2e.mjs [TARBALL_DIR] [CODEBUDDY_VERSION] [PREVIOUS_VERSION]`
delegates to the platform wrappers. It does not itself build or validate the
package; use the Make target when the artifact has not passed
`npm-package-check`.

### WorkBuddy Bundled-Runtime Probe

The WorkBuddy checks use the CLI shipped inside a WorkBuddy desktop installation.
They do not validate the desktop UI or login flow. The desktop application and
bundled runtime have distinct versions. Do not substitute the independently
installed CodeBuddy CLI for that runtime.

The native client functional workflow runs WorkBuddy native checks automatically
for pull requests targeting `main` that select WorkBuddy, the compatibility monitor
and release acceptance, on `ubuntu-24.04` (x64), `macos-15`
(arm64), and `windows-2025` (x64), using Node.js 24. Each platform runs its
fixed baseline and a second desktop release: in a pull request, the accepted
release pinned in the [client acceptance manifest](#client-acceptance-versions);
in the compatibility monitor and release acceptance, the latest official release
resolved once for that run, subject to the narrow Windows fallback below.
Identical full versions, URLs, and checksums share one `baseline+accepted` or
`baseline+latest` job (a latest Linux release is compared without its advisory
checksum); a different desktop build still gets a separate job even if its
bundled CLI version is unchanged. One additional Ubuntu job uses the minimum
supported Node.js 20 with the fixed Linux baseline. All four to seven jobs run
the complete default suites. A separate job runs the WorkBuddy contract tests on
every pull request and, when the run includes WorkBuddy, reads the pinned
release matrix (pull requests) or resolves it (other runs), without building a
package; every platform consumes the package job's validated candidate, the
same artifact as the other clients.
Manual `mode=workbuddy-download-diagnostic` runs only the package and WorkBuddy
jobs. Matrix failures do not cancel the other platforms.
The `WorkBuddy functional result` check requires both the package and the entire
native matrix to succeed. Failed, cancelled, or unexpectedly skipped dependencies
fail that check. Release acceptance, the WorkBuddy diagnostic and the
compatibility monitor report it with their purpose, such as
`WorkBuddy functional result (release-acceptance)`; the other manual modes skip
it, as does a pull request that does not select WorkBuddy. Each cell also
uploads a `workbuddy-report-*` artifact with
its run and attempt, verified desktop and bundled CLI versions, channel, download
host, and the reference and actual SHA-256 with their match or warning status, for
the release record; an accepted release reports `mismatch` instead of a warning
and fails the cell. The aggregate also requires the release resolution and its
coverage report. A successful matrix
can have degraded Windows coverage: its summary names the untested official
latest and the selected older release instead of claiming latest coverage.
Each runner consumes the frozen release description. macOS and Windows require
its selected SHA-256 before mounting or extracting; Linux records the actual
SHA-256 and warns on differences while requiring package and runtime identity,
except that an accepted Linux release must match the SHA-256 recorded at its
acceptance and otherwise fails before the suites run. The
WorkBuddy-specific resolver in `scripts/ci/codebuddy-workbuddy/workbuddy-release-matrix.mjs` owns the
baseline records, feed validation, and matrix; the three acquisition helpers
also accept a validated release JSON file while retaining their standalone
baseline defaults. Desktop and bundled CLI versions are checked separately,
because the official platform releases are not synchronized. Baselines and
accepted releases require the exact recorded CLI version; latest and fallback
jobs read a stable CLI version from the validated package metadata and compare
it with the real command's `--version` before the native suites. The current
fixed baselines are:

| Runner | Official desktop package | Bundled CLI |
| --- | --- | --- |
| Ubuntu x64 | `5.5.6.38337834` DEB | `2.137.1` |
| macOS arm64 | `5.6.2.39298511` DMG | `2.147.0` |
| Windows x64 | `5.6.2.39298511` EXE | `2.147.0` |

Linux functional CI permits same-version rebuilds of the baseline and latest
releases: the same official DEB URL was observed returning packages built on
2026-09-10 and 2026-09-21 with different hashes but the same product and bundled
CLI versions. Its baseline hash is a maintainer-recorded reference; other latest
releases retain the official feed hash as a reference. A difference emits an
explicit warning and diagnostic, not an acquisition failure. The success report
records the actual download hash; neither downloads nor feeds replace the
baseline reference. Linux deduplicates the same full version and URL regardless
of reference hash differences. An accepted Linux release is pinned to the hash
its acceptance recorded, so a rebuild fails pull requests until an acceptance
update records the new package.

The official HTTPS source, successful complete HTTP 200 response, valid DEB
format, package name/version/architecture, and bundled CLI identity/version
remain required. Partial responses and declared length mismatches fail before
extraction. A matching version is not a publisher signature or proof of
identical contents; these checks run only on isolated CI runners without
business credentials. macOS and Windows checksum and signature gates are unchanged.

`workbuddy-download-diagnostic` runs retain each Linux download and a content-free
response report as a one-day artifact, including checksum warnings, for offline
comparison. Other runs do not retain these packages. Retained
downloads are diagnostic evidence, not authenticated release artifacts. A Linux
hash warning permits only the isolated functional checks after all remaining
validation passes. Response reports omit raw headers and signed URL queries.

Latest discovery uses each platform's official update feed. macOS preserves the
feed URL and its matching checksum: latest ZIP archives are extracted into the
private runner directory, while pinned DMG images remain mounted read-only.
Both paths require the application's Tencent signature, Apple notarization
assessment, product version, and bundled runtime validation before execution.
When the Windows feed has an empty checksum, the resolver freezes one commit
of Microsoft's `winget-pkgs` repository and reads the matching WorkBuddy
installer manifest from that immutable revision. It requires a unique x64/user
entry with the exact official URL and product version. Only when that exact
manifest returns HTTP 404 does it list WorkBuddy version directories at the same
frozen commit and select the highest stable three-part version below the
requested official product version. That single fallback must pass the same
manifest validation, including its exact official installer URL, full desktop
build and SHA-256; the Windows runner still requires the valid Tencent signature.
The manifest URL and digest select the full build; the installer's PE product
version only confirms its three-part product version. A fallback identical to
the baseline runs once as `baseline`, never `baseline+latest`; other selected
older releases are labeled `fallback`. Coverage explicitly remains degraded,
with the requested official latest recorded as untested.

The YAML parser
(`yaml@2.9.1`) is installed without lifecycle scripts in an isolated runner
temporary directory, not added to product dependencies; package-job helper
tests exercise the real parser. Native jobs and offline release selection need
only Node built-ins. All other feed, network, metadata, signature, or checksum
errors fail the check, except the Linux hash differences described above.
A missing older candidate, invalid selected manifest, conflicting non-Linux
known pin, or failed acquisition also fails; the resolver does not
continue trying progressively older versions.

The macOS runner also requires Apple's notarization assessment and Tencent's
Developer ID signature before using the mounted or extracted application. Linux
uses `dpkg-deb -x`, without installing the desktop package or running its
maintainer scripts. Windows verifies the installer's Authenticode signature and
publisher before extracting its payload with 7-Zip, without executing the
installer. Extracted packages stay inside fresh runner-owned temporary
directories; Windows `TEMP` and `TMP` use `runner.temp`. No desktop application
or credential store is installed or changed, and native transcripts are not
uploaded as artifacts.

Every platform runs all five default suites below without replacing the public
command shims. The permission suite runs four cases; the two explicit runtime
`interrupt` cases are separate strict manual diagnostics, not part of the matrix.
A failing default suite still fails its job. An overall result requires
every platform and Node combination to pass; one platform's result is not evidence for the
others. The minimum-Node-version job uses the pinned Linux pair; latest jobs
use Node.js 24. This remains bundled-runtime acceptance, not desktop UI or
login-flow coverage.

After `make npm-package-check` validates the candidate artifact, run the isolated
installation, setup-interruption, Memory/Skill, permission, and Repo
Memory worker suites with its tarball directory, the actual bundled
`cli/bin/codebuddy` entrypoint, and its exact runtime version:

```bash
memorax_dev node scripts/ci/codebuddy-workbuddy/workbuddy-e2e.mjs dist/npm/tarballs \
  "$WORKBUDDY_BUNDLED_COMMAND" "$WORKBUDDY_RUNTIME_VERSION" 0.1.18
```

The runner reuses the CodeBuddy installation wrappers with an explicit
`workbuddy` client. macOS and Linux use Bash; native Windows requires PowerShell 7 and Git
for Windows. The supplied bundle is read-only; only MemoraX Code and test-only
`node-pty@1.1.0` are installed into disposable prefixes. No standalone CodeBuddy
package is installed for WorkBuddy. The wrapper validates the bundled path
before installation, and the suites verify the exact runtime version and
WorkBuddy plugin metadata. CodeBuddy's existing invocation and full suite remain
unchanged. When the verified WorkBuddy bundle contains `dist/codebuddy-lite-wb.mjs`,
the isolated test environment sets `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1`, matching
the official desktop host. Recent bundles omit the generic headless/TUI entrypoints;
the public `bin/codebuddy` launcher must select the shipped lite runtime. Older
bundles without that file keep their existing invocation. This selection is
derived from the chosen WorkBuddy package, never inherited from the developer
environment, and remains available to native worker children. CodeBuddy is unchanged.
WorkBuddy must independently pass each suite using its own client identity and
bundled runtime; CodeBuddy results are not substitutes.

The shared lifecycle cases cover rejected stdin, real-terminal cancellation and
hidden credentials, fresh/repeated setup, port-conflict recovery, stop/start,
uninstall/reinstall, configuration retention, previous-version upgrade, rejected
artifact download, forced reinstall, postinstall failure, and recovery/retry.
Four setup-interruption cases cover configuration publication, before/after
Backend start, and saved-account key cancellation. Recovery verifies the saved
account, WorkBuddy installation, a native turn and explicit Search.

To run only native Memory/Skill checks against an already installed candidate:

```bash
memorax_dev node scripts/ci/codebuddy-workbuddy/workbuddy-native-check.mjs \
  "$memorax_dev_root/npm/lib/node_modules/@memorax/memorax-code" \
  "$WORKBUDDY_BUNDLED_COMMAND" "$WORKBUDDY_RUNTIME_VERSION"
```

On Windows, use the npm prefix's `node_modules/@memorax/memorax-code` package
directory. The native scenarios share CodeBuddy's six-turn contract: complete
Unicode/multiline automatic Add, same-session resume and real tools, sensitive
input redaction, separate workspace/session content, direct CLI Search in JSON
and text forms and Add, and native Skill/Read/Bash Search/Add. Scripted local
responses direct the tools; autonomous Skill choice is not evaluated. Independent
native JSONL, Hook correlation, client/session identity, exact Memory requests
and counts, and cleanup remain required. The foreground receives no
`--plugin-dir`; it must discover the installed global Hook and plugin normally.
WorkBuddy state must not become standalone CodeBuddy configuration; the bundled
runtime's empty `.codebuddy/diagnostics` directory alone is allowed.

The default WorkBuddy permission suite runs native preallow, approval, denial,
and cancellation through a permission response. It checks actual file effects,
pending requests without side effects or Add, exact native cancellation evidence,
no Add for the cancelled turn, same-session recovery, and automatic Add against
independently selected native completed content. The final Memory audit runs
after cleanup and rejects late or cross-case Add requests. Its report lists the two excluded
runtime `interrupt` cases; they are not counted as passed. CodeBuddy continues to
run all six cases by default.

Interruption while awaiting approval and interruption of a running tool are
WorkBuddy-only optional diagnostics, each selected independently with
`--interrupt-case` below. They retain the
[CodeBuddy permission coverage boundaries](#codebuddy-functional-ci):
acknowledgement alone is not proof of cancellation, and a client-completed
original turn must have its own exact Add. Forced cleanup, late incomplete tool
results, and original-turn outcomes remain separate compatibility observations.
WorkBuddy may replace the supplied denial reason with its fixed native rejection
message; that form also requires an exact tool name, ID, and input match in the
terminal `permission_denials` record, not merely missing file effects.
For older bundled histories without request-owner fields on user prompts and
late cancellation results, only the WorkBuddy recovery oracle accepts that
specific absence: the sole original tool call and recovery answer must have
distinct valid request owners, and every late result must match the unique
original call in a complete, ordered, single-child parent chain. Malformed or
conflicting owners, reused call IDs, and extra branches still fail. Native records
are not rewritten, and this projection does not establish successful native
cancellation; writeback is checked against the final persisted outcome.
This does not validate desktop approval UI, late approval after cancellation,
OS sandboxing, or interrupted trace reconciliation.

Bundled runtimes `2.137.1` and `2.147.0` acknowledge an interrupt while awaiting
SDK tool approval without producing a terminal result within the check's
45-second window. The `2.147.0` behavior also reproduces without installing
MemoraX Hooks or starting its Backend. The independent diagnostic still fails
on this behavior: an acknowledgement, an artificial permission reply, or closing
stdin is not evidence that the native interrupt ended the pending turn. This
observation alone does not establish an automatic Add failure for completed
native content.
In `2.147.0`, running-tool interruption can also append an incomplete cancellation
result with the original tool call ID but the recovery turn's
`conversationRequestId`. That conflicting ownership fails the recovery oracle;
the missing-owner compatibility above must not be applied to it.
Both diagnostics retain their original native ownership, exact Add/no-Add and
cleanup assertions and exit nonzero on failure. Excluding them from the default
suite leaves the two explicit runtime interrupt paths unverified end to end;
passing permission-response cancellation does not establish those paths.

The Repo Memory case starts the worker through a real foreground Hook in an
isolated Git repository. Both foreground and worker must use WorkBuddy's global
synthetic model and local provider configuration; job ownership, bundled command,
plugin path, native foreground transcript, and cleanup are verified. The worker
returns no bundle, so native exit `0` followed by `artifact_validation_failed` is
required, with no Memory requests or injected artifacts. As with CodeBuddy, this
does not prove valid Repo Memory generation, per-turn model or permission
inheritance, background native session persistence, or worker survival after
foreground exit.

These two suites can also run independently against the installed candidate:

```bash
memorax_dev node scripts/ci/codebuddy-workbuddy/codebuddy-permissions-check.mjs \
  "$memorax_dev_root/npm/lib/node_modules/@memorax/memorax-code" \
  "$WORKBUDDY_BUNDLED_COMMAND" "$WORKBUDDY_RUNTIME_VERSION" workbuddy
memorax_dev node scripts/ci/codebuddy-workbuddy/codebuddy-background-check.mjs \
  "$memorax_dev_root/npm/lib/node_modules/@memorax/memorax-code" \
  "$WORKBUDDY_BUNDLED_COMMAND" "$WORKBUDDY_RUNTIME_VERSION" workbuddy
```

Run either strict interrupt diagnostic separately, so a failure in one does not
prevent investigating the other:

```bash
memorax_dev node scripts/ci/codebuddy-workbuddy/codebuddy-permissions-check.mjs \
  "$memorax_dev_root/npm/lib/node_modules/@memorax/memorax-code" \
  "$WORKBUDDY_BUNDLED_COMMAND" "$WORKBUDDY_RUNTIME_VERSION" workbuddy \
  --interrupt-case user-inflight-interrupt
memorax_dev node scripts/ci/codebuddy-workbuddy/codebuddy-permissions-check.mjs \
  "$memorax_dev_root/npm/lib/node_modules/@memorax/memorax-code" \
  "$WORKBUDDY_BUNDLED_COMMAND" "$WORKBUDDY_RUNTIME_VERSION" workbuddy \
  --interrupt-case user-wait-interrupt
```

All suites use fresh client and Backend state, synthetic credentials, and
loopback model/Memory services. Nonzero native commands report their exit status,
output sizes, recognized error categories, and selected event counts; raw output
and unknown text remain omitted. Setup-interruption failures also retain bounded
receiver counts and route classifications. Reports contain bounded diagnostics,
not raw transcripts, credentials or private paths. Cleanup must succeed before a suite
can pass, and unverified cleanup retains its isolated state.

Desktop-managed task directories, desktop startup environments, and login remain
outside this matrix. Linux supplies the verified bundled command explicitly:
these checks exercise the headless CLI on the Ubuntu runner, not automatic Linux
desktop discovery or official Ubuntu desktop support. Implemented platform
wrappers, acquisition tests, and a local runtime pass are not substitutes for
successful native jobs on each target platform.

### Cursor App Native Canary

The native-client workflow tests the official **Cursor Desktop App**, not Cursor
CLI, on Ubuntu 24.04 x64, macOS 15 arm64 and Windows 2025 x64. Each platform runs
baseline **3.21.18** and a second release on Node 24: the
[accepted release](#client-acceptance-versions) in a pull request, or the latest
stable release in the compatibility monitor and release acceptance. Identical
release identities share a cell; Linux also runs baseline on Node 22.13 or newer
for its native SQLite reader. The native-check process must use the selected
Node version, including inside the Linux container.

Release resolution runs once in the package job of each run that includes Cursor
App; a pull request freezes the recorded releases instead, without a release
lookup. Every cell consumes the frozen
inventory and the same validated candidate npm artifact, with no latest-version
fallback. Package, lifecycle, native acceptance and cleanup failures fail the
aggregate; a local or single-platform pass is not three-platform evidence.

#### Functional Coverage

Every cell first runs `scripts/ci/cursor/cursor-lifecycle-check.mjs TARBALL REPORT_DIR` in
an isolated npm prefix and client/Backend home. It covers fresh/repeated setup,
uninstall/reinstall, saved account/configuration retention, real upgrade from
published MemoraX Code **0.1.18**, rejected download, replacement failure and retry.
That baseline predates Cursor support: its Backend must be ready before upgrade,
and the candidate must install the complete Cursor integration. Four real-PTY
setup interruptions cover `after-config-write`, `before-backend-start`,
`after-backend-start` and `saved-account-key-cancel`. A test-only child gate and
the existing Backend lock control these boundaries; recovery requires no account
input, complete installation and a saved-account Search. This does not simulate
power loss or start the App. macOS and Windows also run the installed-package
smoke; its synthetic Hook/database fixtures are not native App evidence.

The App uses Cursor's built-in smoke driver for synthetic login and real composer
UI input, with `--smoke-test-use-real-agent-http` pointing to the local Agent
mock. The fixture uses the real Connect/protobuf transport, validates history KV
bytes returned by the App, waits for native write acknowledgements, and completes
the checkpoint. It never seeds the database, invokes Hooks directly or substitutes
a simulated response stream. A separate read-only SQLite oracle verifies native
composer/generation identity, checkpoint and every reachable content-addressed
blob byte.

The eleven native runs cover:

- Repeated prompts and follow-up in conversation A, conversation B in a genuinely
  different non-Git workspace, and App restart/resume back in A. Each turn retains
  its own workspace scope.
- Native `/memorax-code` Skill selection, exact installed attachment, Read of the
  router and operation reference, then approved Shell Search/Add through the
  public CLI. Scripted tool requests do not test autonomous Skill selection.
- Shell denial through the matching UI: no file effect, normal completed turn,
  and exact automatic Add.
- Stop while awaiting Shell approval: correlated native cancellation and
  interrupted Hook metadata, no file effect or Add, then a new successful turn in
  the same session without restarting App or Backend. Cancelled content must not
  enter completed history or the recovery Add.
- Repo Memory in an isolated Git repository: a real foreground Hook delegates a
  native Task to the managed child using the foreground model. The child claims
  the supervised job and finishes without authoring a bundle, requiring
  `failed/artifact_validation_failed`, no publication and an exited lease guard.
  Parent/child native identities and completion notification must match. Only
  the parent writes back; this is not successful bundle-generation coverage.

The final audit requires nine exact automatic Adds plus the two explicit Skill
requests, with complete Unicode/multiline content, authentication, client/session
identity, local or Git scope and idempotency keys. Exact ordered transport and
native-content counts are enforced by the executable report gate. Missing,
duplicate, cross-session or late requests fail, including after cleanup.

#### Acquisition and Isolation

Linux baseline hashes are recorded reproducibility pins, not publisher-signed
attestations. Latest Linux releases require the official download API and apt
metadata to agree; the pinned apt key authenticates `InRelease`, package indexes
and SHA-256. An accepted Linux release keeps the apt SHA-256 and size recorded at
its acceptance; a pull request does not repeat the apt lookup. macOS verifies
the mounted App's deep Apple-anchored signature,
publisher, bundle ID, Gatekeeper result, architecture, sealed version and
`realCommit`, then repeats validation on the private copy and detaches before
launch. Windows verifies the official installer and installed executable's
Authenticode, publisher, architecture, version and release commit, waiting for
the installer process tree. Observed desktop hashes do not replace signatures;
a pull request also requires each pinned macOS and Windows download to match
the SHA-256 and size recorded in the manifest.

Linux runs non-root under Xvfb in a network-disabled Docker container with
Chromium sandboxing, dropped capabilities, no-new-privileges and the pinned
seccomp profile. macOS and Windows require fresh GitHub-hosted runners, retain
Chromium's default sandbox and isolate client homes, App data, shell environment
and Backend state. All use synthetic credentials, in-memory App secret storage
and local Agent/Memory fixtures. These macOS/Windows settings verify configured
routes, not OS-enforced isolation of all traffic or credential stores.

Native Shell commands require their matching Run approval. On macOS the Skill
commands request network access to the local fixture, and the worker finish
command requests full command permissions; these are not loopback-only sandbox
policies. Cleanup targets only owned live processes. Windows first requests
native quit, then falls back only for the held live App child. Windows process
audits share a 60-second budget, with at most 30 seconds per query and one retry
for a query timeout. Every successful snapshot still checks all returned
processes; only a complete snapshot without owned processes passes. Other query
errors and exhausted budgets fail. Unconfirmed cleanup fails and retains
isolated state for runner teardown. App restart checks distinguish the closed
former child from the new live child without requiring different PIDs. macOS
descendant audits correlate observed PIDs with process start times and retire
observations after a clear audit; indistinguishable start times remain fail-closed.

#### Reproduction and Reports

After validating an installable candidate, use Node 24 and a local Linux-container
Docker daemon:

```bash
node --test scripts/ci/cursor/cursor-app-*.test.mjs scripts/ci/cursor/cursor-lifecycle*.test.mjs
memorax_candidate_tarball="$(node -p "require('./dist/npm/main-pack.json')[0].filename")"
node scripts/ci/cursor/cursor-app-container-check.mjs \
  "dist/npm/tarballs/$memorax_candidate_tarball" \
  "$memorax_dev_root/cursor-app-report"
```

The two-argument command selects baseline and Node 24. For another matrix cell,
freeze releases with `node scripts/ci/cursor/cursor-app-release.mjs resolve-linux MANIFEST`
(requires `gpg` and `gpgv`), then append `MANIFEST latest 24` or
`MANIFEST baseline 22` to the container command. To reproduce a pull request
cell, freeze the recorded releases with
`node scripts/ci/cursor/cursor-app-release.mjs accepted MANIFEST`, which makes no
network request, and append `MANIFEST accepted 24` or `MANIFEST baseline 22`.
The metadata-only `resolve`
command does not verify Linux apt metadata and is not CI acceptance evidence.

Only lifecycle and native `report.json` files are uploaded. Diagnostic helpers
allow only fixed error/status enums, bounded counts and marker booleans; raw
App/installer logs, command output, transcripts, database files, Hook traces,
credentials, PIDs and private paths are excluded. Diagnostics never replace the
original failure or relax acceptance.

The native runner saves atomic, redacted progress snapshots during execution.
Wrappers recover the last snapshot when the final report is missing or invalid,
preserve the first native failure, and report timeout, abort and process-exit
outcomes separately. Linux exports available reports before container cleanup.
Progress snapshots cannot establish acceptance: a successful native exit and a
complete final report with every existing assertion are still required.

The `appDriver` startup observation records CDP connection, page and workbench
counts, first and last driver probes, fixed evaluation outcomes, slow probes, and
relative times. Driver readiness keeps one evaluation in flight. An evaluation
that takes 5 seconds or more is recorded as slow when this is first observed, and
a pending one is still awaited. A wait that stays pending fails at a strict
window that starts after CDP connection, 90 seconds on Windows and 30 seconds
elsewhere; App exit and other existing errors still fail it earlier. A result
observed at or after that deadline never counts and leaves the report unchanged.
A probe still pending at the deadline shows only that its evaluation did not
complete within the window. Page selection stays unchanged; URLs, page titles
and evaluation error text are excluded.

Windows process-query diagnostics retain the first failed query and the last
query, live bounded output counts, observed process lifecycle events, termination
requests, and fixed PowerShell/CIM/JSON phase markers with relative times.
Unavailable counts and times remain null instead of appearing as observed zeroes.
No raw process rows or command output are included. Query deadlines, retry limits
and complete-snapshot ownership checks remain unchanged.

Windows installer reports retain the observed artifact hash and size, fixed
PowerShell invocation and process-tree-wait markers, bounded output counts,
and classified observations from the private installer log. The installer still
uses the same 300-second deadline and waits for its process tree. A missing
wait-completion marker leaves root and descendant exit unconfirmed; it does
not establish which process stalled. Raw installer logs stay on the runner.

Skill Hook checks read initial, fresh, dynamic, user-message and completed Exec
contexts from the current native run and its referenced, completed same-session
history. Failure reports project only presence and session-marker match booleans
for each source and retain the first failed Skill Hook snapshot across transport
retries. Native Hook diagnostics count complete marker-owned execution
blocks and their first filtering reason: JSON parsing, event, session or generation
mismatch. A zero block count does not prove that a Hook never executed; incomplete
or unrecognized log frames are outside this projection.

Repo Memory delegation reads the same five context sources from the current
request only; it never reuses a ticket from history. Duplicate delegations must
agree. Failures retain the first rejected parent request for Hook and Backend
diagnostics, plus a fixed rejection reason and bounded per-source presence and
marker counts. Delegation prompts, invocations and capabilities stay private.

Every platform waits for native user Hook configuration to load for the current
App launch before opening a new session, then requires a successful marker-owned
`sessionStart` for that session before its first submission. These bounded
checks diagnose missing startup prerequisites; they do not make Cursor
configuration reload and prompt submission atomic, and a check that waits does
not exercise a session created before configuration finishes loading. Linux and
macOS reports retain bounded relative Hook timing, including the first Repo
Memory submission attempt, and Windows reports retain process-audit summaries,
on success and failure, so passing cells can serve as controls. Windows polls
the Hooks logs only during the two waits, not during turns. Native requests and
Backend registration remain independently observed; the fixture never supplies
a missing Turn start.

On failure, `hookReadinessFailure` distinguishes a single log-read timeout from
the overall Hook readiness window and preserves the last completed observation.
Before cleanup, a bounded read records SessionStart requests, owned executions,
filter counts and fixed response fields for the explicit session, including
failures before any model request. Session IDs and raw Hook content are excluded;
failed or late diagnostic reads do not replace the first native failure.

Every platform also records `hookTimeline` on success and failure, so a failing
cell can be compared with its baseline. Before state cleanup, one bounded read of
the Hooks logs keeps, relative to each launch, configuration states,
`sessionStart` and `beforeSubmitPrompt` requests, session creation and submission
times, and whether configuration was loaded when each session was created. That
answer is `unknown` unless every log was read and the launch's only log is
readable through the session's observation. Recording it adds no wait.
SessionStart keeps the existing request, owned-block and filter counts; each
execution adds fixed response fields, the times of the nearest log lines around
its block, the submission requests logged before it, and whether its output
names the session's own trace, another session's, a form the strict matcher does
not recognize, or none. Those line times and counts give log order only, not
when the Hook ran or finished. Request contexts are classified per source the
same way. Sessions appear only as check roles (`S1`–`S6`, their subagents or
`other`). The read has a 2-second budget and the report a 60 KiB ceiling; a
late, failed or oversized timeline keeps only its collection status and never
changes the result.

Real login, hosted models, OS credential-store isolation, native Continue/Retry/
Edit, Backend restart, preauthorized tools, running-tool interruption,
late-approval races, linked worktrees, cross-workspace Search, successful Repo
Memory generation and native App upgrade/uninstall remain outside this matrix.

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
