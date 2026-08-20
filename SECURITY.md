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
- Running interactive setup is the consent boundary for initial Codex
  integration. When no active MemoraX Code Codex plugin exists, setup activates
  the bundled plugin and trusts its current Hook command hashes without a
  second Hook-specific prompt. npm lifecycle never grants this trust. Later
  new or changed Hook hashes remain untrusted until foreground setup displays
  and approves the exact changed selection.
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
  that degraded scope may upgrade to a verified Git scope with the same base
  username and canonical workspace root. Pending fallback writeback is
  discarded during the upgrade rather than migrated or flushed. Git pointer
  files, symlinked markers, unreadable metadata, and other conflicting session
  scope remain fail closed.

### MemoraX memory traffic

MemoraX-backed search, retrieval, and writeback require a username, an
effective API key, and network access. The API key comes from an explicit
environment or private TOML value. Interactive setup
discloses automatic writeback before selecting a connection path. Default setup
reuses a locally ready effective connection without collecting or printing its
credentials again. When no ready connection exists, or when `--reconfigure`
bypasses reuse, setup derives the username from the logged-in operating-system
account name and maps the user's system language to `zh` or `en`; it displays
those selected values and asks for one only when it cannot be detected safely.
The explicit `--existing-account` path asks for the username with the detected
account name as its default, accepts an API key through masked terminal input,
and stores both in the private TOML configuration. The trial path creates or
restores the operating-system-protected credential and mirrors its API key to
that private configuration for portability. A ready connection activates
search/add and the generated configuration's automatic writeback; automatic
retrieval remains disabled until explicitly enabled. The config-only check
does not contact MemoraX or prove that the API key is accepted remotely.

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

Treat the MemoraX API key, trial Mark ID, username, repository identity,
queries, selected writeback content, and saved memories as sensitive. Disable
writes immediately with:

```bash
MEMORAX_CODE_MEMORAX_WRITEBACK_ENABLED=false
```

For a persistent disable, set:

```toml
[memory.writeback]
enabled = false
```

### MemoraX credential storage

The versioned trial credential record is separate from `config.toml`. Its
provisioned `account_id` is account identity and never replaces the username
stored as `[memorax].user_id`. Account identity, project identity, and the
device mark remain only in that secure record. Quota-reminder deduplication is
stored separately in a private local runtime record containing a one-way
connection fingerprint and reminder levels, never a raw API key or Mark ID.

Routine quota reminders, status, and diagnostics do not expose the complete
trial Mark ID. When registration requires it, the user can explicitly run
`memorax-code account --show-mark-id` directly in a local terminal. That
command prints the Mark ID but not the API key. Do not ask an Agent to run it,
paste its output into a conversation, or include it in screenshots or logs.

Trial setup stores the endpoint, username, language preference, and a portable
copy of the API key in `config.toml`. Existing-account setup stores the entered
API key there as well. New POSIX configuration files use mode `0600`, while
Windows relies on the current user's filesystem ACLs. Runtime API-key
resolution prefers an explicit environment value, then a TOML value. The
plugin does not infer current account registration status from the key's
original provisioning path. Trial account and project identifiers never
participate in the workspace-scoped username.

The secure credential layer uses macOS Keychain, Linux Secret Service through
libsecret, and Windows CurrentUser DPAPI with an atomically replaced encrypted
file under the current user's local application-data directory. Each
`MEMORAX_CODE_HOME` resolves to a distinct hashed storage namespace. If the
required operating-system backend is missing, locked, denied, or corrupt, the
trial provisioning operation fails explicitly; it does not replace the secure
record with only a plaintext copy.

These backends protect credentials at rest and when the relevant operating-
system session or key store is locked. They are not a process-isolation
boundary within the same logged-in user. Malicious software running as that OS
user can generally request access in the user's security context; protect the
login session and do not run untrusted software.

The complete trial API key is stored in both the operating-system-protected
record and private `config.toml`. The TOML copy is plaintext protected by the
current user's file permissions, not encryption; it exists so an activated
connection can be copied to another computer. It must not appear in command
arguments, logs, diagnostics, telemetry, or error messages. Never commit,
publish, or paste the configuration. Ordinary package removal retains both the
configuration and an existing secure credential record.

Credential creation is atomic and create-if-absent. Versioned state transitions
preserve the provisioned mark and commit the Backend-issued API Key and
account/project identity together. Rebinding to a different trial identity
requires an explicit credential clear.

Foreground setup creates and securely retains the local identity required for
trial provisioning. An existing credential record remains authoritative and
is not regenerated during ordinary package updates or setup retries.

Trial provisioning is a foreground setup operation, never an npm lifecycle
operation. It sends the bounded provisioning request only to fixed paths on one
validated HTTPS service origin, rejects redirects, and refuses to run when Node
TLS certificate verification is explicitly disabled. Request and response
bodies are bounded, and response parsing never propagates server messages, raw
bodies, request objects, or complete credentials into errors.

Retries reuse the same persisted device identity. If a successful response is
lost or its API Key cannot be committed, the next attempt requests a new Key
for that identity; the client does not recover an uncommitted Key. A dedicated
cross-process provision operation lock covers credential loading, remote
retries, and the final `ready` transition; explicit credential clearing uses
the same lock. Lock waiting is bounded by the provisioning deadline and honors
caller cancellation. The final transition also rechecks the exact credential
snapshot under the short credential mutation lock, so a stale network response
cannot overwrite newer local state.

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
- an operating-system-protected trial credential record, when present;
- Claude plugin data;
- client provider configuration; and
- memories already stored in MemoraX.

A complete product uninstall removes the setup-completion routing marker but
retains the MemoraX configuration, including any API key stored there, and the
secure trial credential. After a reinstall, `memorax-code setup` automatically
reuses a locally ready connection and resumes the configured memory behavior
without asking for the values again. `memorax-code setup --reconfigure`
replaces the username and language but may restore the same retained trial
identity. If that credential must not be reused, remove it separately through
the operating-system secure credential backend after reviewing the retained
configuration and data.

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
