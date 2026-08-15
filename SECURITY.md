# Security Policy

MemoraX Code is a local-first integration for Codex, Claude Code, and
DeepSeek Harness (DSH) with an optional external bind mode and required
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

- Codex, Claude Code, and DSH own provider credentials, models, native tools,
  and provider traffic. MemoraX Code does not proxy OpenAI Responses, Anthropic
  Messages, or DSH model traffic and does not need client provider credentials.
- The managed Backend binds to loopback by default. External binding requires
  explicit opt-in and a Backend token; deployment operators must provide an
  appropriate authenticated and encrypted network boundary.
- Localhost is not an isolation boundary against hostile software running as
  the same operating-system user.
- Hook, lifecycle, connection, PID, token, session, and workspace authority
  records are security-sensitive local state. Do not hand-edit or publish
  them.
- Initial Repo Memory builds use only the Git worktree returned by an
  authenticated Backend turn-start request. Backend or workspace-scope
  failures skip the build; client Hooks do not fall back to their local `cwd`.
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
Active adds and automatic writeback send the selected content needed to create
memory. Automatic writeback may include selected user instructions and the
matching final assistant response from an exact Codex or Claude Code
transcript turn, or from the inline user/assistant text carried by DSH session
events. It does not send the retained trace file, raw transcript
path, or trace-only provenance as part of that payload.

DSH does not produce a native transcript file that the Backend can read, so
its automatic writeback content authority is the inline session-event payload
(the user and assistant text the DSH adapter forwards over the versioned local
Hook HTTP command), not an on-disk transcript. The DSH adapter therefore owns
the trust decision that maps DSH session events to Backend commands, and the
Backend validates the exact command shape and refuses writeback without a
matching, accepted turn-start. Treat that event-to-Backend chain as a trust
boundary: a process able to emit DSH session events or speak the local Hook
HTTP surface with a valid Backend token can attempt to submit turn content, so
the same localhost-is-not-an-isolation-boundary rule and Backend-token
protections apply.

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

Codex, Claude Code, and DSH local trace capture is enabled by default and may
include prompts, responses, recalled memory, writeback content, reminder text,
and local paths. Trace files stay under `MEMORAX_CODE_HOME`. The shipped
package has no trace uploader, collector, receiver, or export command. This
does not change the separate MemoraX queries and writeback described above.

The local `/memory-viewer` surface is a content-free activity summary. It must
not expose conversation or memory text, session/turn identifiers, paths, or
raw trace details. Its bootstrap URL contains an access token; do not copy
that URL into logs, screenshots, or public issues.

Generated `.repo_memory/` content, personal procedures, and profile preferences
remain local and are Git-ignored by the supported workflow. Review and redact
all diagnostic artifacts before sharing them.

## Uninstall and Retention

Use:

```bash
memorax-code uninstall
```

This stops the managed Backend, removes managed Codex/Claude integrations, and
removes the global npm package when possible. It intentionally retains:

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
  isolation, exact-transcript writeback authority (and DSH inline-event
  writeback authority), bounded parsing, and fail-closed behavior for
  uncertain identity or runtime records.
- Use isolated client and MemoraX Code homes for lifecycle or destructive
  tests.
- Add focused regression coverage for changes to authentication, paths,
  lifecycle ownership, Hook schemas, workspace scope, data retention, or
  outbound payloads.
