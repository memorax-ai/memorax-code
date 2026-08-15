# Troubleshooting

Start with the user-facing diagnostics:

```sh
memorax-code status
memorax-cli status
memorax-code-codex doctor
memorax-code-claude doctor
memorax-code logs
```

`status` checks the Backend and client integrations. `memory status` checks
credentials, scope, and memory switches without printing secrets. Each client
`doctor` checks its plugin, skill, workspace, and Backend connection.

## Package installed, but setup did not run

This is expected after:

```sh
npm install -g @memorax/memorax-code
```

npm installation is deliberately non-interactive. It installs package files
and, only when replacing a running managed Backend, performs a bounded
stop/start package transition. It does not detect clients, ask for MemoraX
credentials, or authorize Hooks.

Start first-use setup from an interactive terminal:

```sh
memorax-code
```

If setup was previously completed, the no-argument command shows status
instead. To run or repair setup explicitly, use:

```sh
memorax-code setup
```

After a product uninstall and reinstall, automatic setup reuses a locally valid
retained MemoraX connection. It is therefore normal for setup to restore the
client integrations without asking for the Base User ID, preferred language,
or API key. Run explicit `memorax-code setup` when you intend to replace those
values.

Setup requires both terminal input and terminal-visible stderr. A pipe,
background process, or redirected stdin/stderr cannot answer setup prompts;
the command exits without writing setup completion. Reopen a normal terminal
and rerun `memorax-code setup`.

## Setup does not complete

Setup writes
`$MEMORAX_CODE_HOME/runtime/setup/setup-completion.json` only after client and
Hook reconciliation, Backend start, and final status readiness all succeed.
Until then, a no-argument `memorax-code` attempts setup again.

If the configuration is safely parseable but its effective MemoraX fields are
incomplete or invalid, automatic setup asks for replacement values. A malformed
TOML file cannot be safely updated and remains byte-preserved; fix or restore
that file before rerunning setup rather than expecting the prompt flow to
overwrite it.

For an ordinary Backend start failure, setup makes one bounded stop/start
recovery attempt. It deliberately skips that stop when the error identifies a
Hook-runtime activation failure, lifecycle-lock contention, or invalid or
unsupported Backend authority. Use the reported error and these commands
before changing any state:

```sh
memorax-code status
memorax-code logs
memorax-code-codex doctor
memorax-code-claude doctor
```

If the setup-completion record is invalid, wait until all setup commands have
stopped, preserve a diagnostic copy, move the invalid record aside, and then
rerun `memorax-code setup`. If it uses a newer unsupported version, install a
compatible MemoraX Code release instead of replacing the record with an older
shape.

## npm package transition fails

Package replacement may create:

```text
$MEMORAX_CODE_HOME/runtime/install/package-transition.json
```

`retiring` means preinstall proved that the old managed Backend was live and
recorded the need to restore it, but safe Backend retirement did not finish.
`retired` means the old Backend stopped, but the new package has not yet
completed start, status verification, setup-completion handling, and one-time
transition consumption. Invalid, unsupported, stale, or unfinished records
fail closed and remain available for diagnosis.

First inspect lifecycle authority:

```sh
memorax-code status
memorax-code logs
```

Do not delete PID, lock, setup-completion, or transition records while a
process or lifecycle command may own them. If a `retiring` record remains,
finish a Backend-only stop first. Once status and operating-system inspection
confirm that its PID authority is gone, preserve the incomplete record for
diagnosis and move it aside before reinstalling; `retiring` is never consumed
as if retirement had succeeded.

If postinstall left a `retired` record and the Backend is still running after
a failed status check, stop only the Backend before retrying the same install:

```sh
memorax-code stop --clients none
npm install -g @memorax/memorax-code
```

The retry consumes a still-valid `retired` transition only after start and
status both report success. If the record is stale or invalid, preserve a copy
for diagnosis and confirm that no managed Backend PID remains before moving it
aside and rerunning installation, followed by `memorax-code setup` when the
Backend was intentionally left stopped. An unsupported version requires a
compatible package version rather than manual record conversion.

## Installed, but memory is unavailable

The package and Backend can be healthy while MemoraX remains unconfigured. Run:

```sh
memorax-cli status
```

Use explicit setup to enter or replace the connection values:

```sh
memorax-code setup
memorax-cli status
```

Configured status validates the effective local values only. It does not
contact MemoraX or prove that the API key is accepted; the first real memory
request performs that check.

For manual configuration, set `endpoint`, `user_id`, and `api_key` under
`[memorax]` in `$MEMORAX_CODE_HOME/config.toml`, or set their environment
equivalents. The current default endpoint is `https://platform.memorax.net`.

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

First-use setup, and setup restoring a selected Codex integration whose plugin
was removed, perform the initial activation and trust automatically. If that
step fails, `memorax-code codex-plugin activate --yes` is the explicit recovery
command. Once an installation is active, every later new or changed Hook
command hash remains untrusted until foreground setup displays and approves
the exact changed selection. A declined or non-interactive update can
therefore leave changed Hooks untrusted even though package replacement
succeeded. npm postinstall never authorizes Hooks. An interactive
`memorax-code update` reviews them in foreground setup; after a direct npm or
non-interactive update, run `memorax-code setup`. Do not write trust entries
directly. If the skill is missing, rerun `memorax-code start --clients codex`,
then restart or refresh Codex.

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

A live Codex or Claude Code session remains pinned to the repository or local
workspace resolved at the start of the session. Starting the client from a
parent workspace and then entering a nested Git repository does not rebind the
session. The only in-session scope upgrade is from a direct `.git` directory
whose internal metadata was malformed or incomplete to a verified Git
repository at the same canonical workspace root and for the same Base User ID.

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

MemoraX Code does not proxy Codex or Claude Code model requests. If
`memorax-code status` and the relevant client doctor are healthy, inspect the
provider URL, credentials, model selection, and network settings owned by that
client. Do not copy model-provider credentials into
`$MEMORAX_CODE_HOME`.

## Safe issue reports

Collect structured, redacted output:

```sh
memorax-code status --json
memorax-cli status --json
memorax-code-codex doctor --json
memorax-code-claude doctor --json
```

Include the MemoraX Code version, operating system, affected client,
reproduction steps, failing command, and the smallest relevant log excerpt.

Never attach API keys, Backend tokens, environment files, complete client
configuration, private transcripts, raw trace files, or unreviewed local
paths. Redact usernames, workspace paths, remote URLs, and content before
sharing.
