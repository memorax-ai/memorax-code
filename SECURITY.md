# Security Policy

MemoraX Code is a local-first integration for Codex, Claude Code, DeepSeek
Harness (DSH), and OpenCode with an optional external bind mode and required
communication with MemoraX for cloud-backed memory. Security reports should
distinguish the local Backend, client-owned provider traffic, and MemoraX
memory traffic.

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

- Codex, Claude Code, DeepSeek Harness, and OpenCode own provider credentials,
  models, native tools, and provider traffic. MemoraX Code does not proxy
  model-provider traffic and does not need client provider credentials.
- The managed Backend binds to loopback by default. External binding requires
  explicit opt-in and a Backend token; deployment operators must provide an
  appropriate authenticated and encrypted network boundary.
- Localhost is not an isolation boundary against hostile software running as
  the same operating-system user.
- Hook, lifecycle, connection, PID, token, session, and workspace authority
  records are security-sensitive local state. Do not hand-edit or publish
  them.
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
- Initial Repo Memory builds use only the Git worktree returned by an
  authenticated Backend turn-start request. Backend or workspace-scope
  failures skip the build; client integrations do not fall back to
  adapter-local workspace input.
- Codex and OpenCode read repository-local User Profile and Procedure Memory
  only from the worktree authorized by the current Backend turn-start result.
  Without that authority they keep only the generic Skill reminder and do not
  fall back to the client `cwd` for repository-local content.
- MemoraX-backed Search, Add, and automatic writeback may downgrade malformed
  or incomplete internal metadata in a direct `.git` directory to the
  canonical workspace folder identity. The CLI exposes the fallback reason,
  effective identity, and a user notice. Within the same live session, only
  that degraded scope may upgrade to a verified Git scope with the same Base
  User ID and canonical workspace root. Pending fallback writeback is
  discarded during the upgrade rather than migrated or flushed. Git pointer
  files, symlinked markers, unreadable metadata, and other conflicting session
  scope remain fail closed.

### MemoraX memory traffic

MemoraX-backed search, retrieval, and writeback require a Base User ID, API
key, and network access. The installer discloses automatic writeback before
accepting credentials. Entering valid credentials activates search/add and
the generated configuration's automatic writeback; automatic retrieval remains
disabled until explicitly enabled.

Memory searches send the query and repository-scoped identity to MemoraX.
When DSH or OpenCode automatic retrieval is enabled, each eligible direct user
prompt is used as the search query.
Active adds and automatic writeback send the selected content needed to create
memory. Automatic writeback may include selected user instructions and the
matching final assistant response from an exact Codex rollout, Claude Code
transcript, DSH persisted Session Event Log interval, or OpenCode SDK
session-message turn. It does not send the retained trace file, raw transcript
path, raw DSH interval, SDK message records, or trace-only provenance as part
of that payload.

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

Treat the MemoraX API key, Base User ID, repository identity, queries, selected
writeback content, and saved memories as sensitive. Disable writes immediately
with:

```bash
MEMORAX_CODE_MEMORAX_WRITEBACK_ENABLED=false
```

For a persistent disable, set:

```toml
[memory.writeback]
enabled = false
```

## Local Data and Diagnostics

`MEMORAX_CODE_HOME` defaults to `~/.memorax-code` and contains configuration,
runtime authority, adapter state, and retained diagnostics. On POSIX systems
the product creates or tightens the home to mode `0700` and newly seeded
configuration to mode `0600`; Windows relies on the current user's filesystem
ACLs.

Codex, Claude Code, DSH, and OpenCode local trace capture is enabled by default.
Depending on the enabled client capabilities, traces may include prompts,
responses, recalled memory, writeback content, reminder text, and local paths.
Trace files stay under `MEMORAX_CODE_HOME`. The shipped package has no trace
uploader, collector, receiver, or export command. This does not change the
separate MemoraX queries and writeback described above.

The DSH Session Event Log remains client-owned native history and is read only
for the exact Turn interval. MemoraX Code records normalized DSH trace events
but does not copy the raw log or its path into retained trace. Memory Viewer
uses only normalized, client-qualified DSH operational events and retained
trace; it never reads the native Event Log.

The local `/memory-viewer` surface is a content-free activity summary. It must
not expose conversation or memory text, session/turn identifiers, paths, or
raw trace details. Its bootstrap URL contains an access token; do not copy
that URL into logs, screenshots, or public issues. The projection covers
Codex, Claude Code, DSH, and OpenCode while keeping their identities isolated.
Live DSH memory events without a client-qualified TraceContext fail closed at
the Viewer boundary.

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
remain owned by DSH. It intentionally retains:

- `MEMORAX_CODE_HOME`, including configuration and local traces;
- Claude plugin data;
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
  isolation, exact-transcript writeback authority, bounded parsing, and
  fail-closed behavior for uncertain identity or runtime records.
- Use isolated client and MemoraX Code homes for lifecycle or destructive
  tests.
- Add focused regression coverage for changes to authentication, paths,
  lifecycle ownership, Hook schemas, workspace scope, data retention, or
  outbound payloads.
