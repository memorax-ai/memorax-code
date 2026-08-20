# Troubleshooting

Start with the user-facing diagnostics:

```sh
memorax-code status
memorax-cli status
memorax-code-codex doctor
memorax-code-claude doctor
memorax-code status --clients dsh
memorax-code-opencode doctor
memorax-code logs
```

`memorax-code status` checks the Backend and selected client integrations,
including DSH and OpenCode. `memorax-cli status` checks credentials, scope, and
memory switches without printing secrets. Codex, Claude Code, and OpenCode
also provide client-specific `doctor` commands; DSH uses the shared lifecycle
status.

## Package installed, but setup did not run

This is expected after:

```sh
npm install -g @memorax/memorax-code
```

npm installation is deliberately non-interactive. It installs package files
and, only when replacing a running managed Backend or managed DSH state,
performs a bounded package transition. It does not detect clients, ask for
MemoraX credentials, or authorize Hooks.

Start first-use setup from an interactive terminal:

```sh
memorax-code setup
```

If setup was previously completed, the no-argument `memorax-code` command
shows status. Otherwise it points back to the setup command without starting
an interactive flow implicitly.

After a product uninstall and reinstall, setup detects a locally ready retained
MemoraX connection and reuses it automatically without asking again for the
username or preferred language. Run `memorax-code setup --reconfigure` to
replace the saved connection preferences, or `memorax-code setup
--existing-account` to enter the username used by an existing MemoraX Code
setup and that account's API key.

Setup requires both terminal input and terminal-visible stderr. A pipe,
background process, or redirected stdin/stderr cannot answer setup prompts;
the command exits without writing setup completion. Reopen a normal terminal
and rerun `memorax-code setup`.

## Setup does not complete

Setup writes
`$MEMORAX_CODE_HOME/runtime/setup/setup-completion.json` only after client and
Hook reconciliation, Backend start, status, and final config-only MemoraX
readiness all succeed. Until then, a no-argument `memorax-code` reports that
setup has not been completed and points to `memorax-code setup`.

If the configuration is safely parseable but its effective MemoraX connection
is not ready, setup detects the username and preferred language from the local
user environment and then creates or restores a trial credential. A Unix setup
running as the root account, or another environment where a value cannot be
read safely, asks for the missing value instead. A malformed TOML file cannot
be safely updated and remains byte-preserved; fix or restore that file before
rerunning setup rather than expecting the setup flow to overwrite it.

If setup reports that secure credential setup failed, confirm that the current
operating-system credential store is available to the same logged-in user and
that the MemoraX HTTPS service is reachable, then rerun `memorax-code setup`.
Setup does not skip secure trial persistence or write the TOML API-key copy and
completion marker after that failure. On Linux, also confirm that
`/usr/bin/secret-tool` is installed and that the current session can reach an
unlocked Secret Service. Minimal containers and detached SSH sessions do not
necessarily provide either one.

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

`retiring` means preinstall found a live managed Backend or managed DSH state
and recorded the need to restore the installation, but safe retirement did not
finish. `retired` means the old installation was quiesced, but the new package
has not yet completed start, status verification, setup-completion handling,
and one-time transition consumption. Invalid, unsupported, stale, or unfinished
records fail closed and remain available for diagnosis.

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

The package and Backend can be healthy while the MemoraX connection remains
unavailable. Run:

```sh
memorax-cli status
```

Use setup to detect the local username and preferred language and then create or
restore the trial connection:

```sh
memorax-code setup
memorax-cli status
```

If you need to enter an existing account instead, run `memorax-code setup
--existing-account`.

Configured status validates the effective local values and loads the effective
credential without printing it. It does not contact the memory API or prove
that the API key is accepted; the first real memory request performs that
check.

For a manually managed connection, set `endpoint`, `user_id`, and `api_key`
under `[memorax]` in `$MEMORAX_CODE_HOME/config.toml`, or set their environment
equivalents. An environment API key takes precedence over a TOML API key, and
either takes precedence over a ready secure trial credential. The current
default endpoint is `https://platform.memorax.net`.

Trial setup writes the same API key to private TOML and the operating-system
secure credential record. Copying the TOML connection fields to another
computer therefore reuses the key as an
explicit connection when the original secure record is absent, without copying
the device-local trial identity or local quota-reminder history. Product update
and automatic connection reuse backfill this TOML copy for legacy trial
installations that still have only the secure record.

After changing persistent configuration:

```sh
memorax-code start
memorax-cli status
```

Automatic retrieval is disabled by default and is independent from explicit
search. Automatic writeback requires `[memory.writeback] enabled = true` and
must not be disabled by
`MEMORAX_CODE_MEMORAX_WRITEBACK_ENABLED=false`.

## Quota reminder and Mark ID

Quota reminders apply to anonymous and registered connections. They use
percentage thresholds rather than exposing raw quota counts and intentionally
do not include a complete Mark ID. If this device uses an unregistered
anonymous identity and the MemoraX account page requires its Mark ID, run this
command yourself in a local terminal:

```sh
memorax-code account --show-mark-id
```

The command reads a ready local trial identity and prints only its Mark ID. Do
not ask an Agent to run it or paste the output into a conversation, screenshot,
or log. If no ready local trial identity exists, use `memorax-code setup`; a
TOML connection copied from another computer does not include that computer's
device-local Mark ID.

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

## DeepSeek Harness Profile integration is inactive

```sh
dsh --version
pnpm --version
memorax-code start --clients dsh
memorax-code status --clients dsh
```

MemoraX Code discovers existing Profiles under `$DSH_HOME/profiles`;
`DSH_HOME` defaults to `~/.dsh`. A `no_existing_profiles` result means DSH has
not created a valid Profile in that home. A `dsh_version_unavailable` result
means the selected `dsh` command did not return a valid semantic version. The
tested baseline is `0.1.0-rc.6`; another valid version is allowed but marked
untested. A `pnpm_not_found` result means DSH's native Profile plugin manager
could not find `pnpm` on `PATH`; install `pnpm`, then rerun the start command.

After repairing the command, Profile manifest, or home selection, rerun the
start command and restart or refresh DSH. `profile_drift`,
`profile_manifest_unreadable`, and `runtime_authority_invalid` are managed-state
failures rather than reasons to edit the Profile or
`$MEMORAX_CODE_HOME/adapters/dsh/state.json` manually. The lifecycle command
uses DSH's plugin manager to reconcile the integration. Stop and uninstall
remove the managed MemoraX Code plugin, not the DSH Profile or its session
data.

## OpenCode plugin or skill is inactive

```sh
memorax-code start --clients opencode
memorax-code status --clients opencode
memorax-code-opencode doctor
```

Rerun the start command to reconcile the managed plugin and skill, then restart
or refresh OpenCode. The configuration root follows `OPENCODE_CONFIG_DIR`, then
`XDG_CONFIG_HOME`, and otherwise defaults to `~/.config/opencode`. MemoraX Code
does not add plugin entries to `opencode.json` or `opencode.jsonc`.

An enabled managed plugin normally attempts to restore an unavailable local
loopback Backend when OpenCode loads it. A prompt stops waiting after the
plugin instance's single five-second recovery budget and skips automatic
memory handling for that turn, but the Backend start continues in the
background. If that recovery is skipped or fails, use `memorax-code status` and
`memorax-code logs`, then run the start command above. If doctor reports no
plugin runtime evidence, restart or refresh OpenCode and rerun it. Automatic
recovery intentionally skips remote URLs, invalid connection authority, and
stale loaders whose recorded package command no longer exists.

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
memorax-code status --clients dsh
memorax-code-opencode doctor
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
memorax-code status --clients dsh
memorax-code-opencode doctor
```

Common causes are:

- missing or invalid MemoraX endpoint, username, or effective API key;
- the global writeback kill switch or CLI add switch disabling `memory add`;
- no trusted workspace for the current session;
- an unreadable, malformed, or symlinked Git marker;
- one live session attempting to change to a different repository/workspace;
- local DNS, proxy, or network failure.

MemoraX Code reads filesystem Git metadata without executing Git. Linked
worktrees share the remote repository identity; non-Git workspaces use the
normalized folder name. Resolution never falls back to the bare username.

A live Codex, Claude Code, DSH, or OpenCode session remains pinned to the
repository or local workspace resolved at the start of the session. Starting
the client from a parent workspace and then entering a nested Git repository
does not rebind the session. The only in-session scope upgrade is from a direct
`.git` directory whose internal metadata was malformed or incomplete to a
verified Git repository at the same canonical workspace root and for the same
username.

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

MemoraX Code does not proxy Codex, Claude Code, DSH, or OpenCode model
requests. If `memorax-code status` and the available client-specific doctor
are healthy, inspect the provider URL, credentials, model selection, and
network settings owned by that client. Do not copy model-provider credentials into
`$MEMORAX_CODE_HOME`.

## Safe issue reports

Collect structured, redacted output:

```sh
memorax-code status --json
memorax-cli status --json
memorax-code-codex doctor --json
memorax-code-claude doctor --json
memorax-code status --clients dsh --json
memorax-code-opencode doctor --json
```

Include the MemoraX Code version, operating system, affected client,
reproduction steps, failing command, and the smallest relevant log excerpt.

Never attach API keys, Backend tokens, environment files, complete client
configuration, private transcripts, raw trace files, or unreviewed local
paths. Redact usernames, workspace paths, remote URLs, and content before
sharing.
