# Troubleshooting

Start with the user-facing diagnostics:

```sh
memorax-code status
memorax-cli status
memorax-code-codex doctor
memorax-code-claude doctor
memorax-code status --clients dsh
memorax-code-opencode doctor
memorax-code-codebuddy status --json
memorax-code-trae status --json
memorax-code logs
```

In Windows PowerShell, use `memorax-cli.cmd` everywhere this guide shows
`memorax-cli`. If an unqualified command fails with `UnauthorizedAccess` or
`PSSecurityException` because PowerShell selected `memorax-cli.ps1`, rerun the
same command once with `memorax-cli.cmd`, preserving its arguments and working
directory. Do not run `Set-ExecutionPolicy` for MemoraX commands.

`memorax-code status` checks the Backend and selected client integrations,
including DSH, OpenCode, CodeBuddy/WorkBuddy, and Trae. `memorax-cli status`
checks credentials, scope, and memory switches without printing secrets.
Codex, Claude Code, and OpenCode provide client-specific `doctor` commands;
CodeBuddy/WorkBuddy and Trae provide adapter status commands, and DSH uses the
shared lifecycle status.

Lifecycle summaries include every selected client. A configured integration
does not prove that its Hook has run: `hook-runtime=unverified` and
`hook-runtime=observed` distinguish those states. Trae may report a configured
integration while still requiring its one-time Global Hooks activation; follow
the activation guidance printed by `start`, `restart`, or `status`.

## Package installed, but setup did not start

This is expected after:

```sh
npm install -g @memorax/memorax-code
```

npm installation is deliberately non-interactive. Start setup from a normal
terminal:

```sh
memorax-code setup
```

If a complete configuration was retained from an earlier installation,
default setup reuses it automatically. Use `memorax-code setup --reconfigure`
to replace it, or `memorax-code setup --existing-account` to enter an
existing MemoraX connection.

Interactive setup requires terminal input and terminal-visible stderr. If a
coding agent reports `an interactive terminal is required`, use the explicit
non-interactive existing-account mode instead of emulating a terminal with winpty or
Python. For example, in Windows PowerShell, with a key already supplied in
`MEMORAX_SETUP_API_KEY`:

```powershell
$env:MEMORAX_SETUP_API_KEY | memorax-code.cmd setup --existing-account --non-interactive
```

Close stdin after one raw key; do not pipe a sequence of interactive answers.
This mode uses the detected username and language and replaces the saved key.
If username detection fails, complete setup in a normal interactive terminal.
See [non-interactive setup rules](configuration.md#existing-account-setup-without-a-terminal).
Guest setup still requires an interactive terminal. Do not change PowerShell
execution policy to run the `.ps1` shim; use `.cmd`.

## Windows: `memorax-code` or `memorax-cli` is not found

A global npm installation places command shims in npm's global prefix
(commonly `%APPDATA%\npm`). If that directory is missing from `PATH`, or a
coding agent was started before installation, commands may be unavailable even
though the package is installed. The same package installs both `memorax-code`
and `memorax-cli`; do not install a separate CLI package.

Setup verifies npm's global command directory and adds it to the
current setup process and the Windows user `PATH` when needed. If the current
shell cannot find `memorax-code`, use npm's actual global prefix to bootstrap
setup and verify the CLI in PowerShell:

```powershell
$NpmGlobalBin = (npm prefix -g).Trim()
$env:Path = "$NpmGlobalBin;$env:Path"
& (Join-Path $NpmGlobalBin "memorax-code.cmd") setup
& (Join-Path $NpmGlobalBin "memorax-cli.cmd") status
```

Use `memorax-cli.cmd` for all memory commands, including `status`, `search`, and
`add`. Do not invoke `memorax-cli.ps1` or change PowerShell execution policy.

The first two lines repair `PATH` only for the current PowerShell process. If
setup reports that it could not update the persistent Windows user `PATH`, add
the global prefix once:

```powershell
$NpmGlobalBin = (npm prefix -g).Trim()
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
$UserEntries = @($UserPath -split ";" | Where-Object { $_ })
$NormalizedNpmGlobalBin = $NpmGlobalBin.TrimEnd("\")

if (-not ($UserEntries | Where-Object {
    $_.Trim().TrimEnd("\") -ieq $NormalizedNpmGlobalBin
})) {
    [Environment]::SetEnvironmentVariable(
        "Path",
        (($UserEntries + $NpmGlobalBin) -join ";"),
        "User"
    )
}
```

Open a new terminal after setup or the fallback changes the persistent `PATH`.
Fully exit and restart a coding agent if it was already running during
installation or still cannot find `memorax-cli`. Reinstalling the package is
not required.

## Setup does not complete

Setup writes
`$MEMORAX_CODE_HOME/runtime/setup/setup-completion.json` only after
configuration, client and Hook reconciliation, Backend start, and final
readiness checks succeed. A default `config.toml` alone is not proof of
completion. Existing-account stdin mode also requires the saved API key to
match its input. If setup has not completed, rerun the appropriate setup mode
and resolve the reported failure; do not print the configuration to check a
key. `API Key match: true` is a local check, not remote authentication. For
older installations with a complete configuration, the
no-argument command can perform a one-time migration; see
[setup-completion behavior](configuration.md#setup-automatic-update-and-package-transition-state).

Codex plugin registration and activation failures include the underlying command
error even without verbose output. Address that error before retrying setup.

If lock release is blocked by filesystem permissions or a client's deletion
protection, the command reports `failed to release JSON state lock` with the
lock path and underlying error. Any preceding operation error is also retained;
successful configuration alone does not mean lock cleanup succeeded. Resolve
the reported permission or client protection prompt before retrying. Do not
delete a lock while its owning process may still be running.

On Windows, shared Hook runtime publication and Trae/OpenCode directory
installation briefly retry transient filesystem errors. If shared runtime
publication still fails, setup stops before changing the active runtime or
client integrations. If an adapter operation still fails, setup identifies the client,
installation step, and error. When the Backend has already recovered, setup
leaves it running instead of adding another stop/start cycle; client setup
remains incomplete. Check access to the reported directory, close applications
that may be using it, then rerun `memorax-code setup`. A running Backend alone
does not confirm that every selected client integration is ready.

If secure credential setup fails, confirm that the operating-system credential
backend is available to the same logged-in user and that the MemoraX service is
reachable. On Linux, confirm that `/usr/bin/secret-tool` is installed and the
session can reach an unlocked Secret Service. Minimal containers and detached
SSH sessions often do not provide one.

Malformed `config.toml` is preserved rather than overwritten. Repair or
restore the file, then rerun setup. Invalid setup-completion records also fail
closed; preserve a diagnostic copy and confirm no setup command is active
before moving an invalid record aside. An unsupported record version requires
a compatible MemoraX Code release.

## npm package transition fails

Replacing a running managed installation uses
`$MEMORAX_CODE_HOME/runtime/install/package-transition.json`. If preinstall
cannot retire the old Backend, installation stops before package replacement.
If postinstall cannot start or verify the new Backend, the retired transition
is retained for recovery.

After the original npm command has exited and the reported startup or status
problem is corrected, resume restoration of the installed package:

```sh
memorax-code update --recover
memorax-code setup
```

Pass the same `--home DIR` to both commands when using a custom state root.
Recovery starts and verifies the installed Backend under the transition lock,
then removes the record only after both operations succeed. It does not run
npm or replace package files. The subsequent setup reconciles clients and
verifies Hook changes. Repeating npm installation while a transition is pending
can be rejected again, including when DSH state remains after a stop.

Automatic postinstall recovery accepts a retired record for 15 minutes.
Explicit `--recover` also accepts an older valid retired record, so time spent
diagnosing the failure does not prevent recovery. A still-retiring, malformed,
unsupported, or future-dated record is preserved and rejected. Inspect process
ownership and the reported state before repairing such a record; an unsupported
version requires a compatible MemoraX Code release. Do not delete a record while
an installation or lifecycle command may still own it.

Fresh and already-stopped installations without retained DSH state do not
create a transition and remain stopped. Retained DSH state also triggers
retirement and restoration, even without a live Backend PID.

On Windows, a Backend started by MemoraX Code 0.1.6 or earlier from an npm
lifecycle may keep the old global package directory as its working directory.
Windows then prevents npm from renaming that directory, and update fails with
an `EBUSY` rename error before the newer package's preinstall can stop the old
Backend. Upgrade an affected installation with:

```sh
memorax-code stop
memorax-code update --latest
memorax-code
```

The final command reuses existing configuration and credentials, reconciles
the client integrations, starts the Backend, and completes the one-time setup
migration. `memorax-code start` alone does not commit that migration. Once a
fixed release has started the Backend from its private runtime directory,
later updates do not require this workaround.

## Automatic update does not run or repeatedly retries

Background checks start only after setup has written a valid
`$MEMORAX_CODE_HOME/runtime/setup/setup-completion.json` record and the managed
Backend is running. Confirm that `MEMORAX_CODE_AUTO_UPDATE` was not set to
`false` when that Backend started. Client SessionStart events are not update
triggers. See
[automatic update settings](configuration.md#setup-automatic-update-and-package-transition-state)
for the check and retry intervals.

The installed version and next check deadline are recorded at:

```text
$MEMORAX_CODE_HOME/runtime/install/automatic-update.json
```

Do not edit that record while an update may be running. For an immediate
foreground retry, run `memorax-code update` from an interactive terminal, then
check `memorax-code status`.

During Codex reconciliation, verified new or changed MemoraX Code Hooks are
trusted silently. A changed marketplace identity, malformed Hook response, or
Hook that changes again during the config write is not trusted; automatic
reconciliation remains incomplete and retries later. After confirming the
installed plugin source, use `memorax-code codex-plugin trust-hooks` for an
explicit diagnostic review, then rerun `memorax-code setup` if needed. Direct
npm installation replaces package files but does not perform this product
reconciliation.

## Installed, but memory is unavailable

The package and Backend can be healthy while MemoraX remains unconfigured. Run:

```sh
memorax-code setup
memorax-cli status
```

Default setup creates or restores an account-free connection. For an existing
account, run `memorax-code setup --existing-account`. A manually managed
connection may instead configure `endpoint`, `user_id`, and `api_key`
under `[memorax]`, or set their environment equivalents. The current default
endpoint is `https://platform.memorax.net`.

After changing persistent configuration:

```sh
memorax-code start
memorax-cli status
```

Automatic retrieval is disabled by default and is independent from explicit
search. Automatic writeback requires `[memory.writeback] enabled = true` and
must not be disabled by
`MEMORAX_CODE_MEMORAX_WRITEBACK_ENABLED=false`.

## Hook ran, but automatic writeback is missing

`hook-runtime=observed` confirms that a managed Hook loaded. It does not prove
that a completed turn reached MemoraX. Check each stage in order:

1. Run `memorax-cli status` from the same project and check automatic writeback,
   credentials, and workspace scope. Compare the Backend and client's actual
   environment with [writeback settings](configuration.md#writeback-and-explicit-add).
   A status command in a different shell cannot inspect their inherited
   overrides. Automatic Search being disabled does not disable writeback.
2. Confirm that the session has a completed turn with matching native content.
   Codex and Claude diagnostics such as `turn_id_missing`, `prompt_id_missing`,
   `transcript_unavailable`, `transcript_session_mismatch`, or `turn_not_found`
   identify correlation or native-history failures. Restore the client's
   access to its own history and retry in a new session; do not substitute a
   Hook's message text or another client's transcript. For Trae, completion
   instead requires its validated `UserPromptSubmit`/`Stop` pair.
3. Check whether the turn was rejected before buffering. In
   `memory.automatic_writeback`, `skipReason=disabled` means the effective
   settings rejected it; `workspace_scope_*` reasons require the scope checks
   below. `user_prompt_empty` and `assistant_text_empty` can also mean that
   redaction left no meaningful content. `duplicate_pending` and
   `buffer_duplicate_turn` indicate duplicate handling, not a new send failure.
4. Distinguish buffering from sending. `buffered=true` with `scheduled=false`
   is expected: defaults flush at eight turns, ten minutes idle since the most
   recent buffered turn, or the 128,000-character buffer boundary. A flush logs
   `scheduled=true` and `flushReason` such as `turn_limit`, `idle_limit`, or
   `char_limit`. A Hook's `scheduled=true` can mean the shared runtime accepted
   the turn into this buffer; it is not a remote receipt.
5. Inspect the subsequent `memory.automatic_writeback` dispatch result.
   `accepted=false`, `httpStatus`, `errorKind`, and `retrying` distinguish
   rejected requests and transport retries. `accepted=true` means MemoraX
   accepted the request; it does not establish when extracted memory becomes
   available to Search. Use the [connection and scope checks](#memorax-search-add-or-scope-fails)
   for credential, network, and repository failures.

If normal status is insufficient, temporarily enable Backend diagnostic logs
and reproduce one completed turn. In Bash or Zsh:

```sh
MEMORAX_CODE_BACKEND_DEBUG_REQUESTS=true memorax-code restart
memorax-code logs
```

In PowerShell, set `$env:MEMORAX_CODE_BACKEND_DEBUG_REQUESTS = "true"` before
running `memorax-code restart` and `memorax-code logs`. The default log is
`$MEMORAX_CODE_HOME/runtime/backend/backend.log`; `MEMORAX_CODE_BACKEND_LOG`
can override it. Diagnostic event names differ by client before the shared
writeback stage. Review logs locally because they can contain session IDs,
paths, and error details. After collecting the needed evidence, set the debug
variable to `false` and restart the Backend again. Share only a redacted excerpt,
not raw logs or native history.

## Quota reminder and Mark ID

Memory write and memory search reminders are tracked independently. A reminder
is emitted when the corresponding remaining quota reaches 10% or less and
again at 0%; raw quota counts are not shown.

Automatic quota reminders are currently supported in Codex, Claude Code,
CodeBuddy/WorkBuddy, OpenCode, and Trae. DeepSeek Harness does not currently
surface these reminders.

A guest reminder displays the complete Mark ID when the ready local trial
identity matches the active API key. Registered-account reminders do not
include it. If a guest reminder cannot verify a matching local identity, it
instead directs you to run this command yourself in a local terminal:

```sh
memorax-code account --show-mark-id
```

The command reads a ready local trial identity and prints only its Mark ID. A
reminder or command output containing the Mark ID is sensitive; do not share it
in a conversation, screenshot, or log. If no ready local trial identity exists,
use `memorax-code setup`; a connection copied from another computer does not
include that computer's device-local Mark ID.

## Backend does not start

When `memorax-code start`, `stop`, or `restart` returns a failed Backend report,
the command exits with status `1` and adds a default diagnostic on stderr while
preserving its existing stdout summary. This diagnostic remains visible with
`MEMORAX_CODE_BACKEND_SUPPRESS_GUIDANCE=1`. With `--json`, stdout preserves
`action` and `backend` and adds `failure` and `diagnostic`.

`failure` contains `errorCode`, `stage`, a safe `error` summary, `processState`,
`impact`, and `userAction`, plus known `systemCode`, `cleanupErrorCode`, and
`cleanupSystemCode` values when available. Optional `failureReason` and
`httpStatus` preserve the last observed failure category and HTTP status;
unknown state or deadline expiry alone does not establish a more specific cause.
Optional `recordReason` preserves a known runtime-record validation reason,
such as `malformed_json` or `unreadable`, without including the record's contents.
Open the reported diagnostic path for the content-free record. If
`diagnostic.recorded` is `false`, retain the
output and inspect `diagnostic.recordingError`; storage failure does not replace
the original Backend failure. These records share the
[Search/Add diagnostic storage](configuration.md#default-searchadd-diagnostics).

`processState` reports `not-started`, `stopped`, `running`, or `unknown`; it
does not prove current process ownership. For unknown state or a separate
cleanup failure, check status before retrying and preserve the process record
while the process may still be running. `BACKEND_LIFECYCLE_LOCK_TIMEOUT` calls
for waiting for the other lifecycle command to finish. A lock-acquisition
filesystem failure instead calls for checking the state directory and its
permissions, using the reported system code when available.

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

MemoraX Code update reconciliation silently trusts only the exact new or changed
Hook hashes returned by Codex after the marketplace identity is verified.
Direct npm installation does not run that reconciliation and can leave changed
Hooks untrusted. Use the commands above instead of writing trust entries
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

## CodeBuddy or WorkBuddy Hook is inactive

For CodeBuddy CLI:

```bash
memorax-code start --clients codebuddy
memorax-code-codebuddy status --json
```

For WorkBuddy:

```bash
memorax-code start --clients workbuddy
memorax-code status --clients workbuddy --json
```

To manage both, use `memorax-code start --clients codebuddy,workbuddy`. Explicit
`start --clients` selects the full managed set; include any other integrations
you want to retain. Each client has its own
[configuration root and runtime](configuration.md#codebuddy-and-workbuddy-integration-paths).
A leftover `.workbuddy` directory alone does not identify an installed app.
On Windows, setup resolves the npm-installed `codebuddy.cmd` to CodeBuddy's
Node entrypoint without invoking a command shell. If a discovered CodeBuddy
CLI or WorkBuddy runtime cannot run, setup reports the preflight error and
stops before changing client selection or starting integrations. Correct the
runtime installation or configured command, then rerun setup. An integration
explicitly disabled in `[clients]` does not block setup for other clients.
After upgrading an older installation, rerun setup and refresh the affected
client to load its new Hooks.

`codebuddyHooks.status` is the shared adapter's status field inside the
`codebuddyAdapter` or `workbuddyAdapter` report. `unverified` means its files
are configured but that installation has not yet produced a real Hook event.
Start a new CLI session or restart WorkBuddy, submit one prompt, and check
status again. `observed` means its Hook entrypoint and shared runtime loaded;
`invalid` means setup should be rerun.

If WorkBuddy still reports a Hook command containing `/c/Users/...`, it is
loading a stale plugin manifest. Rerun the start command above and fully
restart WorkBuddy. Do not manually edit the installed Hook command.

If a Hook reports `legacy CodeBuddy Hook directory lock remains`, an older
Hook uses a directory at
`$MEMORAX_CODE_HOME/adapters/codebuddy/pending.json.lock`. New Hooks wait for
that directory to be released and do not delete it based on its age. Restart
CodeBuddy or WorkBuddy after upgrading to retire older Hook implementations.
If the directory remains after all older Hook processes have exited, remove
only that leftover directory and retry. Keep `pending.json` and any regular
file lock; a regular file is the current lock format.

## Trae Global Hooks or Skill is inactive

```sh
memorax-code start --clients trae
memorax-code-trae status --json
```

Trae uses `TRAE_CN_HOME`, then `TRAE_HOME`, and otherwise defaults to
`~/.trae-cn`. Setup merges the managed `SessionStart`, `UserPromptSubmit`, and
`Stop` entries into `hooks.json` and installs the shared Skill without
replacing unrelated Hooks. If status reports `globalHooksActivationRequired`
or a Hook status of `unverified`, open Trae Settings, enable **Global Hooks**
once, fully restart or refresh Trae, start a new session, and submit one
prompt. A subsequent status should report `observed`.

If status reports `hooks_invalid`, repair the existing Trae `hooks.json`
syntax before rerunning the start command. If it reports `skill_conflict`, an
unmanaged `skills/memorax-code` directory already exists; preserve or move that
directory deliberately before asking MemoraX Code to manage the Skill. Do not
copy generated runtime files or edit entries containing
`--memorax-code-trae-hook-v1` by hand.

Trae currently provides no stable raw Session or headless CLI. Automatic
writeback therefore requires a matching `UserPromptSubmit` and `Stop` Hook
pair, and automatic background Repo Memory jobs are not available. Explicit
Search/Add and Skill-driven Repo Memory remain available.

## DeepSeek Harness Profile integration is inactive

```sh
dsh --version
pnpm --version
memorax-code start --clients dsh
memorax-code status --clients dsh
```

Automatic DSH discovery is optional: an unavailable DSH integration is
reported as degraded without blocking the Backend or another detected client.
The explicit commands above are strict and return a failure until DSH is ready.

MemoraX Code discovers existing Profiles under `$DSH_HOME/profiles`;
`DSH_HOME` defaults to `~/.dsh`. A `no_existing_profiles` result means DSH has
not created a valid Profile in that home. A `dsh_version_unavailable` result
means neither the selected DSH command nor an existing Profile-linked DSH
runtime supplied a valid semantic version. A `dsh_profile_runtime_stale` result
means that Profile-linked package is invalid or its original package cache is
no longer available. Repair or relaunch DSH itself, then rerun the MemoraX Code
start command. MemoraX Code never invokes `npx` or installs or updates DSH. The
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
memorax-code-trae status --json
/usr/sbin/scutil --proxy
/bin/launchctl getenv NO_PROXY
/bin/launchctl getenv no_proxy
```

Correct the proxy or process environment, then fully quit and reopen the
client. MemoraX Code does not edit system proxy settings or login
environments. Redact proxy details before sharing diagnostics.

## MemoraX search, add, or scope fails

Failed explicit `memorax-cli search` and `memorax-cli add` commands exit with
status `1`. Normal output goes to stderr and includes an error code, failure
stage, impact, next step, diagnostic ID, and saved file path. With `--json`,
stdout preserves the structured result, including `errorCode`, `stage`,
`impact`, `userAction`, and `diagnostic`; known `systemCode`, `httpStatus`, and
`retryAfterMs` fields are included when available.

Open the path reported by the command to inspect its content-free diagnostic;
no Debug or trace setting needs to be enabled first. If storage fails,
`diagnostic.recorded` is `false` and `diagnostic.recordingError` gives the
storage reason. The original operation failure and diagnostic ID are still
returned; retain the error output and check directory permissions or available
disk space. [Storage and retention](configuration.md#default-searchadd-diagnostics)
describe where these records live.

| Error code | Recovery |
| --- | --- |
| `MEMORY_INPUT_INVALID`, `MEMORY_INPUT_UNREADABLE` | Check required flags and values, or the input file's existence and readability. |
| `MEMORY_CONFIG_MISSING`, `MEMORY_ADD_DISABLED` | Check `memorax-cli status`, connection setup, and the explicit Add settings. |
| `MEMORY_SCOPE_UNAVAILABLE`, `MEMORY_SCOPE_MISMATCH` | Verify repository metadata and start a new session in the intended workspace; see the scope rules below. |
| `MEMORAX_HTTP_ERROR` | Check `httpStatus`: `401`/`403` point to credentials or permissions; `429` calls for checking limits and any retry delay. Other statuses require checking service availability. |
| `MEMORAX_TIMEOUT`, `MEMORAX_TRANSPORT_ERROR` | Use the known system code, if present, to check DNS, endpoint reachability, proxy, or TLS configuration. |
| `MEMORAX_INVALID_JSON`, `MEMORAX_INVALID_RESPONSE`, `MEMORAX_RESPONSE_REJECTED` | Check endpoint and service compatibility; share a reviewed diagnostic if the failure persists. |
| `MEMORY_CLI_INTERNAL` | Share the reviewed diagnostic and the operation that failed. |

An Add timeout, transport failure, or unusable response can leave service
acceptance unknown. Verify whether the content was accepted before repeating
the Add. An input, configuration, or scope failure reports that the request
was not sent.

```sh
memorax-cli status
memorax-cli search --query 'test'
memorax-code-codex doctor
memorax-code-claude doctor
memorax-code status --clients dsh
memorax-code-opencode doctor
memorax-code-trae status --json
```

Common causes are:

- missing or invalid MemoraX endpoint, base user ID, or API key;
- the global writeback kill switch or CLI add switch disabling `memory add`;
- no trusted workspace for the current session;
- an unreadable, malformed, or symlinked Git marker;
- one live session attempting to change to a different repository/workspace;
- local DNS, proxy, or network failure.

MemoraX Code reads filesystem Git metadata without executing Git. Linked
worktrees share the remote repository identity; ordinary non-Git workspaces use
the normalized folder name. Recognized default chat directories share
`General`. Resolution never falls back to the bare base user ID.

A live Codex, Claude Code, DSH, or OpenCode session remains pinned to the
repository or local workspace resolved at the start of the session. Starting
the client from a parent workspace and then entering a nested Git repository
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

Recognized default chat directories in Codex, WorkBuddy, and OpenCode
intentionally share `General` under the same Base User ID. Check the
[directory rules](configuration.md#memory-scope) if the scope is unexpected;
ordinary selected directories and verified Git repositories keep their normal
scope. Existing memories under `Codex-General` or the previous default-folder
names are not migrated or searched together with `General`.

## Model-provider requests fail while MemoraX Code is healthy

MemoraX Code does not proxy client model requests. If `memorax-code status` and
the available client-specific diagnostics are healthy, inspect the provider
URL, credentials, model selection, and network settings owned by that client.
Do not copy model-provider credentials into `$MEMORAX_CODE_HOME`.

## Safe issue reports

Collect structured, redacted output:

```sh
memorax-code status --json
memorax-cli status --json
```

For a client-specific failure, also collect the affected client's diagnostic
from the start of this guide with `--json`.
For an explicit Search/Add or Backend start/stop/restart failure, include its
diagnostic ID and the reviewed diagnostic file, if saved. Structured command
output may contain query, workspace, process, or raw Backend error fields that
are excluded from the diagnostic record; review it separately before sharing.
Include the MemoraX Code version, operating system, affected client,
reproduction steps, failing command, and the smallest relevant log excerpt.

Never attach API keys, Backend tokens, environment files, complete client
configuration, private transcripts, raw trace files, or unreviewed local
paths. Redact usernames, workspace paths, remote URLs, and content before
sharing.
