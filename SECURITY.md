# Security Policy

MemoraX Code is a local-first integration for Codex, Claude Code,
CodeBuddy/WorkBuddy, DeepSeek Harness (DSH), OpenCode, Trae, and Cursor with an optional
external bind mode and required communication with MemoraX for cloud-backed memory. Security reports should
distinguish the local Backend, client-owned provider traffic, MemoraX
memory traffic, and the optional Jev evaluation provider.

## Supported Versions

MemoraX Code is pre-1.0. Security fixes target the current `main` branch and
the latest published release unless another supported release is explicitly
announced.

## Reporting a Vulnerability

Do not open a public issue for a suspected vulnerability.

1. Open a private GitHub security advisory for this repository, if available.
2. If private advisories are unavailable, contact the maintainers through the
   repository owner profile before sharing reproduction details publicly.
3. Include the affected version or commit, impact, minimal reproduction, and
   redacted logs. Never include live API keys, Backend tokens, private memory,
   or raw transcripts.

Please allow time for triage and remediation before public disclosure.

## Product Trust Boundaries

### Client and local Backend

- Codex, Claude Code, CodeBuddy/WorkBuddy, DeepSeek Harness, OpenCode, Trae, and Cursor own provider credentials,
  models, native tools, and provider traffic. MemoraX Code does not proxy
  model-provider traffic and does not need client provider credentials. The
  optional Jev evaluation adapter uses its own explicit configuration and key;
  it does not execute client tasks or inherit their provider credentials.
- The managed Backend binds to loopback by default. External binding requires
  explicit opt-in and a Backend token; deployment operators must provide an
  appropriate authenticated and encrypted network boundary.
- Localhost is not an isolation boundary against hostile software running as
  the same operating-system user.
- Hook, lifecycle, connection, PID, token, session, and workspace authority
  records are security-sensitive local state. Do not hand-edit or publish
  them.
- npm lifecycle scripts do not prompt for credentials, authorize Hooks, or
  perform first-time setup. They only retire and restore an already-running
  managed Backend during package replacement. The automatic updater is a
  separate detached product process and runs only after setup completion.
- Backend-scheduled automatic updates trust releases published under the
  installed npm package name and its `latest` or `preview` tag. Set
  `MEMORAX_CODE_AUTO_UPDATE=false` when deployment policy requires manual
  package review. A changed target is installed by exact version and
  reconciliation preserves explicit client choices. Selection of newly
  detected clients is described in [Configuration](docs/configuration.md#client-selection).
- Codex update reconciliation may trust new or changed Hooks without a prompt
  only after the current marketplace identity and exact Hook selection are
  validated. The selection is checked again before and after the config write;
  identity drift, malformed responses, or concurrent Hook changes fail closed.
  First-time setup activation and the standalone Hook-trust command remain
  explicit product operations.
- Setup-completion, package-transition, and automatic-update records are
  versioned private authority. Invalid or unsupported setup and transition
  records fail closed instead of silently treating a partial setup or
  interrupted package replacement as complete. The automatic-update record
  controls only cadence across Backend process replacement.
- Package recovery permission is private, versioned authority protected by the
  Backend lifecycle lock. Ordinary stop, restart and uninstall replace it with
  a new stopped revision. Automatic restoration must match the exact transition
  and cannot revive permission revoked by a later stop. Explicit recovery is
  a new user request and can restore supported legacy transition records.
- The managed OpenCode plugin may recover an unavailable Backend only through
  its package-recorded Node runtime and absolute `memorax-code` command, and
  the currently resolved loopback HTTP authority. It preserves the existing
  lifecycle lock and client selection; remote or invalid authority and removed
  commands fail open without starting a process.
- The managed DSH plugin may recover an unavailable loopback Backend only when
  its package metadata and per-user lifecycle state agree on an enabled
  authority and exact revision. Lifecycle commands publish disabled authority
  before mutating Profiles. Missing, disabled, or invalid authority leaves the
  MemoraX Code plugin inert without blocking DSH startup.
- The globally installed DSH adapter source is read-only. Managed Profile
  packages are content-addressed copies under `MEMORAX_CODE_HOME`; Profile
  mutation goes through DSH's native plugin command. The DSH state record,
  generated runtime, and Profile manifests are security-sensitive local
  authority and must not be copied between users or edited by hand.
- The managed CodeBuddy/WorkBuddy plugin reads native JSONL transcripts from the
  client-owned project history and sends only normalized turn data required for
  correlation, trace, or writeback.
- The Cursor adapter manages only its marked native user Hooks and shared Skill
  under `CURSOR_HOME` (default `~/.cursor`), independently of Claude Code. It
  preserves unrelated configuration and Cursor's third-party integration switch.
  Automatic writeback reads native SQLite conversation state and referenced blobs
  in a read-only transaction. Exact native request/user identity, prompt digest,
  completed Hook, and final-response digest authorize the selected text. Continue
  additionally validates the original user and unchanged native branch/step prefix.
  Database paths and pending correlation records remain local. No database copy,
  UI bubble, JSONL fallback, tool text, or thinking content is sent to MemoraX.
  Ambiguous or unsupported content and interrupted runs do not write back. Hook
  response text is used only for digest comparison, never as fallback content.
- The managed Trae adapter merges only marker-owned `SessionStart`,
  `UserPromptSubmit`, and `Stop` entries into Trae's `hooks.json`, refuses to
  replace an unmanaged `memorax-code` Skill, and removes only managed assets.
  Trae owns the application-level Global Hooks switch; MemoraX Code cannot
  enable it reliably and requires the user to do so once in Trae Settings.
- Trae exposes no stable raw Session authority. For Trae only, the validated
  prompt supplied by `UserPromptSubmit` and final assistant message supplied by
  the matching `Stop` Hook are the automatic-writeback content authority. They
  are bound to one active Turn with a prompt-derived Turn ID; a new
  prompt interrupts the old Turn, and late or mismatched completion events do
  not write back. Hook fields are not a fallback for any other client.
- Initial Repo Memory builds use only the Git worktree returned by an
  authenticated Backend turn-start request. Backend or workspace-scope
  failures skip the build; client integrations do not fall back to
  adapter-local workspace input.
- Personal Memory is global user-owned state under
  `$MEMORAX_CODE_HOME/personal-memory/` (default `~/.memorax-code/personal-memory/`). User
  Profile is `user-profile/preferences.md`; Procedure Memory consists of direct
  `procedure-memory/*.md` topic files. Personal-memory reads and writes do not
  require Git, a repository root, or a worktree. Applicability may mention a
  repository, tool, or workflow without making the storage repository-scoped.
- User Profile storage rejects symbolic links in the global personal-memory
  directories and `preferences.md`. Invalid preference files are rejected
  without rewriting their contents; listing does not create storage. The file
  uses schema `user_profile_memory.v0.1`, scope `user`, and owner
  `user-profile-memory`.
- Existing personal-memory files under `.repo_memory/` are ignored and are not
  migrated. Repository-local `.repo_memory` remains Repo Memory only.
- MemoraX-backed Search, Add, and automatic writeback may downgrade malformed
  or incomplete internal metadata in a direct `.git` directory to the
  canonical workspace folder identity. The CLI exposes the fallback reason,
  effective identity, and a user notice. Within the same live session, only
  that degraded scope may upgrade to a verified Git scope with the same Base
  User ID and canonical workspace root. Pending fallback writeback is
  discarded during the upgrade rather than migrated or flushed. Git pointer
  files, symlinked markers, unreadable metadata, and other conflicting session
  scope remain fail closed.

### Background Repo Memory execution

Backend workspace authorization establishes which repository a job belongs to;
it does not sandbox the coding agent that executes the job. These background
Repo Memory runners use the following native execution permissions:

| Runner | Execution permissions |
| --- | --- |
| Codex | `codex exec --sandbox danger-full-access` |
| Claude Code | `--dangerously-skip-permissions` |
| CodeBuddy/WorkBuddy | `--dangerously-skip-permissions` |
| OpenCode | A dedicated session allows `edit`, `bash`, `webfetch`, `doom_loop`, and `external_directory` for `*` |
| DSH | Uses the selected managed headless Profile via `--profile`; the adapter supplies no additional permission flag |
| Trae | No automatic background runner |
| Cursor | Native `Task` dispatches the managed `memorax-repo-memory` background subagent, inherits the parent model, and uses Cursor's normal tool permissions |

Run these jobs only against trusted source in an appropriately trusted local
environment. Worker timeouts and repository validation bound lifecycle and
identity; they do not restrict filesystem or tool access to that repository.

Cursor requires a delegation ticket claim before work, limits the claim by a
lease, and validates job ownership, the repository snapshot, and the generated
bundle before accepting completion. These checks do not create a filesystem
sandbox, limit the subagent's tool permissions, or forcibly stop it when the
lease expires. Cursor does not use a standalone Agent CLI for these jobs.

### MemoraX memory traffic

The trial-provisioning client sends a versioned device mark and the device
attributes required by the provision contract to the configured MemoraX
service. MemoraX returns the API key and account/project assignment; the API
key is not generated locally. The complete provisioning record is stored by
the current user's platform credential backend. Foreground setup also writes
the returned API key to the private `config.toml` so the effective connection
can be reused and managed with the normal configuration surface. Both copies
are credentials and must not be logged or published. Account and project
metadata remain only in secure credential storage. Device-mark metadata is not
written to the user configuration file; it is read only for explicit account
inspection and matching anonymous quota reminders.

Explicit existing-account setup can accept a raw API key through stdin with
`--non-interactive`, without an interactive terminal. It writes the key to private
configuration and verifies the saved value without placing it in its command
arguments or output. The invoking shell or coding agent remains responsible
for how it obtains and retains that input; stdin does not prevent upstream
command-history or conversation logging. A local key match and setup completion
do not establish remote authentication.

Quota-reminder deduplication is stored separately in a private local runtime
record containing a one-way connection fingerprint and reminder levels, never
a raw API key or Mark ID. An anonymous quota reminder reads the ready secure
trial credential only when its API key matches the active connection, then
displays the complete Mark ID in the local coding-agent notice or CLI output.
Registered-account reminders, status, and diagnostics do not expose it. The
user can also explicitly run `memorax-code account --show-mark-id` directly in
a local terminal. Neither path prints the API key. Treat conversations,
screenshots, and logs containing a displayed Mark ID as sensitive.

MemoraX-backed Search, Add, and automatic writeback require a Base User ID, API
key, and network access. Foreground setup discloses automatic writeback before
creating or accepting credentials. Completing setup activates Search/Add and
the generated configuration's automatic writeback.

Memory searches send the query and repository-scoped identity to MemoraX when
the agent or user invokes `memorax-cli search`. Hooks do not send prompts to
MemoraX for Search.
Active adds and automatic writeback send the selected content needed to create
memory. Automatic writeback may include selected user instructions and the
matching final assistant response from an exact Codex rollout, Claude Code or
CodeBuddy/WorkBuddy transcript, DSH persisted Session Event Log interval,
OpenCode SDK session-message Turn, Cursor's correlated native SQLite turn and steps, or
Trae's validated Hook pair. It does not
send the retained trace file, raw transcript path, raw DSH interval, SDK
message records, or trace-only provenance as part of that payload.

Automatic QA writeback also sends the selected native message/event timestamps
or explicitly labelled local observation times. An aligned source-label array
in Add metadata distinguishes them; it contains no transcript paths or trace
identifiers. See [timestamp semantics](docs/configuration.md#automatic-writeback-timestamps).

Automatic writeback bounds each selected message to its configured Add limit,
then applies a local best-effort detector before hashing, buffering, chunking,
observability, or network dispatch. Recognized private keys, authorization
tokens, cookies, API keys, structured credentials, email addresses, long
numbers, UUIDs, fixed-length hexadecimal strings, and high-entropy opaque
identifiers are replaced with typed placeholders such as
`[REDACTED:PRIVATE_KEY]`, `[REDACTED:AUTH_TOKEN]`,
`[REDACTED:COOKIE]`, `[REDACTED:API_KEY]`,
`[REDACTED:CREDENTIAL]`, `[REDACTED:EMAIL]`,
`[REDACTED:LONG_NUMBER]`, and `[REDACTED:OPAQUE_ID]`. If either side of the
turn contains no meaningful content after replacement, that automatic
writeback is skipped locally and no Add request is sent.

This detector is not a complete data-loss-prevention system. Unknown formats
and weak-context personal information may remain. Explicit `memorax-cli add`
content and Search queries are sent as entered and do not use this automatic
writeback detector; do not intentionally submit credentials or private data
through those operations.

The packaged default uses `https://platform.memorax.net`. An endpoint override
is a separate trust decision; configure only a compatible MemoraX service you
trust.

Treat the MemoraX API key, trial Mark ID, Base User ID, repository identity,
queries, selected writeback content, and saved memories as sensitive.
Automatic writeback and explicit Add are independent: persistent disabling of
both requires `[memory.writeback].enabled = false` and
`[memory.cli].add_enabled = false`, without enabling environment overrides.
The global environment switch disables both only when its value is exactly
`false`. Follow [Disabling memory writes](docs/configuration.md#disabling-memory-writes)
for commands and process-inheritance requirements. These controls do not
cancel in-flight requests or guarantee removal of previously buffered turns;
graceful Backend shutdown can flush pending writeback.

### Jev semantic judgment traffic

Jev is a separate hosted service, disabled by default. Its adapter requires
an explicit enable setting and a Jev API key in private configuration or an
environment override. The configured key is used only to construct the
Authorization bearer header for the fixed TypeSafe HTTPS endpoint; provider
results and configuration status do not expose the configured credential.
When enabled and configured, each eligible distinct user request can invoke
Jev before the agent receives retrieval guidance, independently of the Skill
reminder cadence. Repeated native Turn events are deduplicated. Disabled Jev
keeps the existing reminder cadence without sending conversation content to
TypeSafe.

When invoked, the adapter sends fixed Coding Memory retrieval criteria and
bounded original text: the current user request and, when supplied, the
previous user request and final assistant reply. Text is trimmed and length
limited but is not redacted, including any literal credentials or examples
already present in that text. The adapter does not read native transcripts,
retained trace, diagnostic records, or repository files, or add Session, Turn,
repository-identity, or local-provenance metadata fields. The external service's
own terms and data-handling policy govern the text it receives.

The Backend keeps bounded context in memory for this decision, qualified by
client, session, and scope. Prior context comes only from the immediately
preceding observed, validated native completion, independently of automatic
Add enablement; it is not read from
retained trace and is not written to a new conversation-history file. Restart,
eviction, or missing eligible prior content leaves current-request-only input.
A missing registered current request prevents evaluation.
Submitted native references must match the registered values and field
presence. Explicit interruption or rollback invalidates the matching guidance
context and any in-flight decision; a late start or completion for that
invalidated Turn cannot reactivate its retained context.

A valid Jev response produces a binary Search or skip recommendation from its
probability. It cannot authorize session correlation, scope changes, completion,
permissions, or memory writes. Invalid configuration prevents a request;
non-execution, invalid input or responses, and transport failures return a
separate unsuccessful result with a fixed reason, without exposing raw response
bodies or exception details. Failed evaluation falls back to the existing
reminder cadence and does not add a generic reminder on other turns. Jev does
not execute Search or suppress independent personal-memory delivery.

## Local Data and Diagnostics

`MEMORAX_CODE_HOME` defaults to `~/.memorax-code` and contains configuration,
runtime authority, adapter state, and retained diagnostics. On POSIX systems
the product creates or tightens the home to mode `0700` and newly seeded
configuration to mode `0600`; Windows relies on the current user's filesystem
ACLs.

Shared state locks exclusively create a private lock file and write its
process-qualified owner record before entering a critical section. A failed
owner-record write does not permit the protected operation. Incomplete records
are eligible for recovery only after the stale threshold; an interrupted
acquisition can leave such a record. Stale-lock recovery still requires
same-directory hard links and actual unlink semantics for claim cleanup.

Failed explicit Search/Add commands, Backend and client deployment failures from
start, stop, and restart, setup- or update-owned failures, and known Hook or
automatic-writeback failures create local diagnostic records independently of
Debug and trace settings. These contain a diagnostic ID,
timestamp, schema and package
versions, platform and runtime version, operation, failure stage, stable error
code, fixed error summary, impact, and recovery guidance. Depending on the
operation, known system codes, HTTP status, retry delay, client identity,
hashed Session/Turn identifiers, process state, a fixed category for the last
observed failure, an allowlisted runtime-record validation reason, configuration
recovery state, native command exit status or signal, and cleanup or recovery
error/system codes may be included. Setup and update reuse validated child
diagnostics and IDs when they already exist. Validation reasons contain no record
contents. Setup records also exclude device, guest, and account identity values.
Records exclude queries, Add text, response bodies, raw
exception messages or causes, credentials, Authorization headers, raw Session/Turn
identifiers, PIDs, tokens, command arguments or output, and local paths. The CLI
prints the saved file's path separately; the path is not stored in the record. These files remain local
and are not runtime or memory authority. Background diagnostics do not enter
conversation context or change Hook exit behavior; recording failure is best
effort and cannot replace the original operation outcome. See [diagnostic storage and retention](docs/configuration.md#default-searchadd-diagnostics).

`memorax-code logs --diagnostics` and `logs --id` expose only validated, known
diagnostic fields and normalize control characters for display. The reader uses
bounded reads, rejects unsupported or malformed records and symbolic-link files
or diagnostic directories, and never reads native history, uploads data, or
modifies diagnostic storage. These files are not signed: review their text before
sharing, especially if edited by another local process. Current status and raw
Backend logs can include additional local information and require separate review.

Codex, Claude Code, CodeBuddy/WorkBuddy, DSH, OpenCode, Trae, and Cursor local trace capture is enabled by default.
Depending on the enabled client capabilities, traces may include prompts,
responses, recalled memory, writeback content, reminder text, and local paths.
Trace files stay under `MEMORAX_CODE_HOME`. The shipped package has no trace
uploader, collector, receiver, or export command. This does not change the
separate MemoraX queries, writeback, or opt-in Jev evaluation described above.

Disabling trace event capture preserves current-turn operational records for
client/session identity, workspace association, and exact recovery. These local
records may include workspace and native transcript paths, but no prompts,
responses, or memory content. Session validation and retention cleanup remain
active; the trace switch does not erase previously retained data.

The DSH Session Event Log remains client-owned native history and is read only
for the exact Turn interval. MemoraX Code records normalized DSH trace events
but does not copy the raw log or its path into retained trace.

Generated `.repo_memory/` content, personal procedures, and profile preferences
remain local and are Git-ignored by the supported workflow. Review and redact
all diagnostic artifacts before sharing them.

## Uninstall and Retention

Use:

```bash
memorax-code uninstall
```

This stops the managed Backend, removes managed client integrations, and
removes the global npm package when possible. For DSH it removes only the
managed MemoraX Code plugin from Profiles; the Profiles and their session data
remain owned by DSH. A complete product uninstall clears the setup-completion
record so a later installation requires foreground setup again. It
intentionally retains:

- `MEMORAX_CODE_HOME`, including private configuration and its API-key copy,
  local traces, and retained runtime records;
- account-free provisioning credentials and account/project metadata in the
  current user's operating-system credential store, separately from
  `MEMORAX_CODE_HOME`;
- Claude plugin data;
- DSH Profiles and native session data;
- client provider configuration; and
- memories already stored in MemoraX.

Delete retained local data and cloud memories separately after reviewing what
you need. Running `npm uninstall -g @memorax/memorax-code` first is not
equivalent because npm may remove the product command before integration
cleanup runs.

## Contributor Security Checklist

- Never commit or publish credentials, Authorization headers, raw transcripts,
  retained trace files, private memories, `.env.local`, or machine-specific
  diagnostic state.
- Preserve workspace traversal and symlink protections, client/session
  isolation, each client's documented writeback authority, bounded parsing, and
  fail-closed behavior for uncertain identity or runtime records.
- Use isolated client and MemoraX Code homes for lifecycle or destructive
  tests.
- Add focused regression coverage for changes to authentication, paths,
  lifecycle ownership, Hook schemas, workspace scope, data retention, or
  outbound payloads.
