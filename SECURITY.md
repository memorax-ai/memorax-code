# Security Policy

MemoraX Code is a local-first integration for Codex and Claude Code with an
optional external bind mode and required communication with MemoraX for
cloud-backed memory. Security reports should distinguish the local Backend,
client-owned provider traffic, and MemoraX memory traffic.

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

- Codex and Claude Code own provider credentials, models, native tools, and
  provider traffic. MemoraX Code does not proxy OpenAI Responses or Anthropic
  Messages traffic and does not need client provider credentials.
- The managed Backend binds to loopback by default. External binding requires
  explicit opt-in and a Backend token; deployment operators must provide an
  appropriate authenticated and encrypted network boundary.
- Localhost is not an isolation boundary against hostile software running as
  the same operating-system user.
- Hook, lifecycle, connection, PID, token, session, and workspace authority
  records are security-sensitive local state. Do not hand-edit or publish
  them.

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
transcript turn. It does not send the retained trace file, raw transcript
path, or trace-only provenance as part of that payload.

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

Codex and Claude Code local trace capture is enabled by default and may include
prompts, responses, recalled memory, writeback content, reminder text, and
local paths. Trace files stay under `MEMORAX_CODE_HOME`. The shipped package
has no trace uploader, collector, receiver, or export command. This does not
change the separate MemoraX queries and writeback described above.

The local `/memory-viewer` surface is a content-free activity summary. It must
not expose conversation or memory text, session/turn identifiers, paths, or
raw trace details. Its bootstrap URL contains an access token; do not copy
that URL into logs, screenshots, or public issues.

Generated `.repo_memory/` content, personal procedures, and profile preferences
remain local and are Git-ignored by the supported workflow. Review and redact
all diagnostic artifacts before sharing them.

On an eligible prompt in a Git worktree, a missing `.repo_memory/PROFILE.md`
starts a background Repo Memory build through the active Codex or Claude Code
client. That worker uses the client's existing model and provider boundary to
inspect the repository and may use authenticated `gh` or `glab` commands for
PR, MR, and issue evidence. The generated bundle remains local; provider CLI
traffic and model-provider traffic are separate from MemoraX memory traffic.

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
  isolation, exact-transcript writeback authority, bounded parsing, and
  fail-closed behavior for uncertain identity or runtime records.
- Use isolated client and MemoraX Code homes for lifecycle or destructive
  tests.
- Add focused regression coverage for changes to authentication, paths,
  lifecycle ownership, Hook schemas, workspace scope, data retention, or
  outbound payloads.
