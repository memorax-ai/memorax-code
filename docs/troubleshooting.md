# Troubleshooting

Start with the user-facing diagnostics:

```sh
memorax-code status
memorax-cli status
memorax-code-codex doctor
memorax-code-claude doctor
dsh plugin --profile <profile> why @memorax-code/dsh-adapter
dsh --profile <profile> --dump-config
memorax-code logs
```

`status` checks the Backend and Codex/Claude Code integrations. `memorax-cli
status` checks credentials, scope, and memory switches without printing
secrets. Each client `doctor` checks its plugin, skill, workspace, and Backend
connection. DSH profile state is currently inspected with DSH's native
commands rather than merged into the central status report.

## Installed, but memory is unavailable

The package and Backend can be healthy while MemoraX remains unconfigured. Run:

```sh
memorax-cli status
```

Configure `endpoint`, `user_id`, and `api_key` under `[memorax]` in
`$MEMORAX_CODE_HOME/config.toml`, or set their environment equivalents. The
current default endpoint is `https://platform.memorax.net`.

After changing persistent configuration:

```sh
memorax-code start
memorax-cli status
```

Automatic retrieval is disabled by default and is independent from explicit
search. Automatic writeback requires `[memory.writeback] enabled = true` and
must not be disabled by
`MEMORAX_CODE_MEMORAX_WRITEBACK_ENABLED=false`.

## Backend does not start

```sh
memorax-code status
memorax-code logs
memorax-code start
```

Check the reported bind address, port, and error code. The default is
`127.0.0.1:8787`; another process may already own that port. A non-loopback
bind is rejected unless external access is explicitly enabled and a Backend
token is configured.

If `status` reports an invalid or unsupported connection authority, MemoraX
Code deliberately does not fall back to port 8787. `memorax-code stop` remains
available. After confirming the intended local address, recover with:

```sh
memorax-code start --host 127.0.0.1 --port <intended-port>
```

The persisted authority changes only after the Backend becomes healthy. A
one-off `--backend-url` or `MEMORAX_CODE_BACKEND_URL` override does not rewrite
it.

To rotate a Backend token:

```sh
memorax-code stop
memorax-code token --rotate
memorax-code start
```

Rotation is rejected while the managed Backend is running.

Lifecycle state and locks fail closed when process ownership is uncertain.
Do not delete PID or lock files while a process or lifecycle command may still
be active. Let concurrent work finish, then rerun `memorax-code status`.

## Codex plugin or Hook is inactive

```sh
memorax-code codex-plugin install
memorax-code codex-plugin activate --yes
memorax-code codex-plugin trust-hooks
memorax-code start --clients codex
memorax-code-codex doctor
```

Codex requires review for new or changed Hook command hashes. A declined or
non-interactive update can leave Hooks untrusted even though the update
succeeded. Do not write trust entries directly. If the skill is missing, rerun
`memorax-code start --clients codex`, then restart or refresh Codex.

## Claude Code plugin or Hook is inactive

```sh
memorax-code start --clients claude
memorax-code-claude doctor
```

This reconciles the Claude Code marketplace plugin and Hooks. If the plugin is
still missing or stale, restart or refresh Claude Code. Do not manually copy
Hooks into Claude settings.

An already-open client may keep its loaded plugin shell while a later prompt
uses the updated Hook runtime. Restart or refresh the client to load a changed
plugin manifest, icon, or bundled skill.

## DSH plugin or profile is inactive

```sh
memorax-code start
dsh plugin --profile <profile> why @memorax-code/dsh-adapter
dsh --profile <profile> --dump-config
```

`memorax-code start` discovers existing valid DSH profiles and reconciles the
managed Cordis bundle. It does not create profiles. If the profile did not
exist during installation, initialize it through DSH first, rerun
`memorax-code start`, and then restart that profile. The native `why` command
should resolve `@memorax-code/dsh-adapter`, and the dumped configuration should
contain its bundle row. Profile plugin reconciliation requires `pnpm` on
`PATH`.

Search, Add, automatic retrieval, and writeback work in every integrated DSH
profile. If only Repo Memory build or maintenance fails, ensure at least one
managed profile includes `@deepseek-ai/dsh-headless`, then rerun
`memorax-code start`.

The central `memorax-code status` report does not yet include per-profile DSH
state. Inspect `--dump-config` locally because a profile can contain private
provider configuration; share only the smallest redacted excerpt needed for a
diagnosis.

## Hooks cannot reach localhost on macOS

If shell requests work but Hook diagnostics fail, a global proxy or client
environment may be intercepting `127.0.0.1` or `localhost`.

```sh
memorax-code start
memorax-code-codex doctor
memorax-code-claude doctor
/usr/sbin/scutil --proxy
/bin/launchctl getenv NO_PROXY
/bin/launchctl getenv no_proxy
```

Correct the proxy or process environment, then fully quit and reopen the
client. MemoraX Code does not edit system proxy settings or login
environments. Redact proxy details before sharing diagnostics.

## MemoraX search, add, or scope fails

```sh
memorax-cli status
memorax-cli search --query 'test'
memorax-code-codex doctor
memorax-code-claude doctor
```

Common causes are:

- missing or invalid MemoraX endpoint, base user ID, or API key;
- the global writeback kill switch or CLI add switch disabling `memory add`;
- no trusted workspace for the current session;
- an unreadable, malformed, or symlinked Git marker;
- one live session attempting to change to a different repository/workspace;
- local DNS, proxy, or network failure.

MemoraX Code reads filesystem Git metadata without executing Git. Linked
worktrees share the remote repository identity; non-Git workspaces use the
normalized folder name. Resolution never falls back to the bare base user ID.

A live Codex, Claude Code, or non-delegated DSH agent session remains pinned to
the repository or local workspace resolved at the start of the session. Starting
the harness from a parent workspace and then entering a nested Git repository
does not rebind the session. The only in-session scope upgrade is from a direct
`.git` directory whose internal metadata was malformed or incomplete to a
verified Git repository at the same canonical workspace root and for the same
Base User ID.

During that degraded state, MemoraX Code reports
`workspaceScopeFallbackReason: git_metadata_invalid` for manual CLI operations
and continues Search and Add with the normalized local folder name. Automatic
writeback also continues under that fallback scope without interrupting the
client task. The reported `effectiveUserId` identifies the fallback namespace
and may differ from the restored Git repository namespace. Repair the
repository or restore valid `.git` metadata, and later Search, Add, and
automatic writeback in the same client session automatically use the verified
Git repository scope. Memories already accepted under the fallback namespace
are not migrated. Any unsent automatic-writeback buffer for the fallback scope
is discarded instead of being flushed into either namespace.

Invalid or unreadable Git marker files, symlinked markers, and session scope
conflicts do not use this fallback. If Search or Add reports
`workspace_scope_mismatch` or `workspace_scope_unavailable`, start a new
session from the target repository or local workspace and verify that its
`.git` metadata is readable and valid. These failures stop Search or Add before
any request is sent to MemoraX.

Codex projectless tasks under its canonical dated-task location intentionally
use the shared `Codex-General` memory name. Open a task in a real workspace
when repository isolation matters.

## Model-provider requests fail while MemoraX Code is healthy

MemoraX Code does not proxy Codex, Claude Code, or DSH model requests. If the
Backend and the relevant native integration are healthy, inspect the provider
URL, credentials, model selection, and network settings owned by that harness.
Do not copy model-provider credentials into `$MEMORAX_CODE_HOME`.

## Safe issue reports

Collect structured, redacted output:

```sh
memorax-code status --json
memorax-cli status --json
memorax-code-codex doctor --json
memorax-code-claude doctor --json
dsh --version
dsh plugin --profile <profile> why @memorax-code/dsh-adapter
```

Include the MemoraX Code version, operating system, affected client,
reproduction steps, failing command, and the smallest relevant log excerpt.
For DSH, state the affected profile explicitly. The central JSON status does
not yet contain DSH profile diagnostics; inspect `dsh --profile <profile>
--dump-config` locally and share only a minimal redacted excerpt when it is
necessary.

Never attach API keys, Backend tokens, environment files, complete client
configuration, private transcripts, raw trace files, or unreviewed local
paths. Redact usernames, workspace paths, remote URLs, and content before
sharing.
