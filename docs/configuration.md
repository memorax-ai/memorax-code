# Configuration

MemoraX Code reads persistent configuration from:

```text
$MEMORAX_CODE_HOME/config.toml
```

`MEMORAX_CODE_HOME` defaults to `~/.memorax-code`. There is no separate
configuration-path setting. Treat the whole file as private: it can contain a
MemoraX API key and must not be committed or pasted into public issues.

## Precedence and reload behavior

Where a setting supports every layer, precedence is:

```text
explicit command/context value > environment variable > config.toml > code fallback
```

Use `config.toml` for durable choices and environment variables for temporary
overrides. Both account-free and existing-account setup write the effective API
key to this private file so the connection can be reused. After editing the
file, run:

```sh
memorax-code start
memorax-code status
memorax-cli status
```

This reconciles client integrations and starts the managed Backend if needed.
Memory operations reread `config.toml`, but environment variables belong to the
process that inherited them: `start` keeps an already-running Backend. After
changing its environment, run `memorax-code restart` from the shell with the
intended overrides. Restart or refresh coding clients when their loaded
integration or inherited environment changes.

TOML booleans are `true` or `false`. Memory and trace environment booleans
normally accept `true/false`, `1/0`, `yes/no`, and `on/off`. The global write
switch `MEMORAX_CODE_MEMORAX_WRITEBACK_ENABLED` is an exception: only the exact
lowercase string `false` disables writes; `0`, `no`, and `off` do not. Use the
documented values for other runtime switches. Unknown fields are ignored and
are not a compatibility contract.

## New configuration

The generated template selects the existing client integrations, including the
optional CodeBuddy/WorkBuddy and Trae adapters, disables automatic retrieval,
enables automatic writeback, sets the preferred language to Chinese (`zh`),
uses a five-turn skill reminder and the adaptive repository-update policy, and
enables content-bearing local traces for every supported client. Foreground
setup may narrow `[clients]` to clients detected on the host. The tables below
list all fallbacks, including tuning fields omitted from the generated file.

On POSIX systems MemoraX Code creates `$MEMORAX_CODE_HOME` with mode `0700`
and a new `config.toml` with mode `0600`. Windows relies on the current user's
filesystem ACLs.

State and managed client configuration directories must support same-directory
hard links, as APFS, NTFS, and ext4 do. Shared JSON state locks use them to
publish complete owner records atomically. Filesystems without this capability,
including FAT and exFAT, cannot host these locked records; lock acquisition
fails rather than performing an unlocked update.

## Client selection

If `[clients]` is absent, lifecycle commands select Codex, Claude Code, DSH,
and OpenCode; CodeBuddy/WorkBuddy and Trae are opt-in unless detected during
foreground setup. If the table is present, `codex`, `claude`, `dsh`,
`opencode`, `codebuddy`, `workbuddy`, and `trae` are boolean fields. Direct lifecycle
commands treat omitted `codex`, `claude`, `opencode`, `codebuddy`, `workbuddy`, or `trae`
values as disabled. Setup and update reconciliation retain an omitted field as
an undecided choice for client support added after the configuration was
written. An omitted `dsh` value remains enabled so configurations written
before DSH support can discover an existing local Harness. Set `dsh = false`
explicitly to disable that integration. The command-line override accepts a
comma-separated subset:

```text
--clients codex|claude|dsh|opencode|codebuddy|workbuddy|trae|<comma-separated subset>|all|none
```

Foreground `memorax-code setup` refreshes `[clients]` from the clients
available at that time. OpenCode is available when its explicit, XDG, or
default configuration directory exists, or when `opencode` is on `PATH`.
DSH is available when at least one valid Profile exists under
`$DSH_HOME/profiles`; `DSH_HOME` defaults to `~/.dsh`. An explicit
`[clients].dsh = false` is preserved. Trae is available when its data home or
application is detected. `TRAE_CN_HOME`, then `TRAE_HOME`, overrides its
default `~/.trae-cn` data home.

On later setup runs, explicit `true` and `false` client choices are preserved.
A detected client whose field is absent is offered for activation with a
default of yes; declining records `false`. An absent client that is not
detected remains absent, while a selected client that is temporarily
unavailable remains selected. Direct npm installation does not detect clients
or modify `[clients]`.
Non-interactive existing-account setup and automatic update reconciliation
preserve explicit choices and silently enable a detected client whose field is
absent. This lets configurations written before an adapter was supported
adopt it when its runtime is already
installed, without overriding an explicit `false`.

Client selection controls managed client-integration lifecycle only. It does
not change any coding agent's provider settings.
`--clients none` runs the Backend without managing a client integration.

## Existing-account setup without a terminal

`memorax-code setup --existing-account --non-interactive` is the public
non-interactive account setup entrypoint. It reads one raw API key from stdin
until EOF, with a 16 KiB input limit; surrounding whitespace is trimmed.
The value must be non-empty and contain no embedded line breaks or NUL bytes.
The key comes from stdin, not a command-line argument or environment fallback.
A conflicting `MEMORAX_CODE_MEMORAX_API_KEY` override is rejected. The caller
must close stdin; do not send JSON or the interactive setup answers. The flag
is valid only with `--existing-account`, not guest setup or update reconciliation.

The command replaces the saved connection key and uses the detected
operating-system username and system language defaults (`zh` or `en`). If a
safe username cannot be detected, it fails and directs the user to interactive
setup. To reuse an already complete connection, the caller should retain it
instead of invoking this explicit replacement command. Existing explicit
client choices, including `false`, are preserved; newly detected clients with
no recorded choice are enabled.

The command uses the same private configuration writes, Hook activation,
Backend reconciliation, and setup-completion authority as interactive setup.
Before recording completion, it checks that the saved key matches stdin and
that local configuration and selected integrations are ready. A successful
run prints `API Key match: true` without printing the key. This is a local
persistence check; only a real MemoraX operation verifies remote authentication.

For shell examples, see the package README.
On Windows PowerShell, use `memorax-code.cmd` without changing execution policy.
The caller owns secure input handling: MemoraX Code does not put the stdin key
in its command-line arguments or output, but cannot prevent a shell or coding
agent from retaining the command or conversation that supplied it.

## Setup, automatic update, and package-transition state

npm installation and foreground setup are separate operations.
`npm install -g @memorax/memorax-code` installs or replaces package files
without reading terminal input. `memorax-code setup` owns client detection,
connection setup, configuration writes, client integration activation or
review, and final readiness checks. Trae setup installs the managed Hook
entries but cannot turn on Trae's application-level Global Hooks setting; the
user must enable that setting once in Trae Settings.

Default setup reuses a complete effective connection. Otherwise it detects the
logged-in operating-system username and maps the system language to `zh` or
`en`, asking only when a value cannot be detected safely. It then creates or
restores an account-free credential and writes its API key to `config.toml`.
`memorax-code setup --existing-account` bypasses automatic reuse and accepts
an existing connection's username and API key. `--reconfigure` bypasses reuse
and follows the account-free path again.

The explicit `--existing-account --non-interactive` mode also works without a
terminal; see [its input and configuration rules](#existing-account-setup-without-a-terminal).

Successful setup writes a private versioned record at:

```text
$MEMORAX_CODE_HOME/runtime/setup/setup-completion.json
```

The record controls no-argument CLI routing and eligibility for background
update reconciliation. When it is valid, the command shows status. When it is
absent and an interactive terminal is available,
`memorax-code` validates and reuses a complete effective configuration, then
runs setup and reconciliation once to write the record. If the configuration
is incomplete or no interactive terminal is available, it points to
`memorax-code setup`. Invalid and unsupported records fail closed. A complete
product uninstall removes this marker while retaining `config.toml`; stop and
partial client uninstall preserve it.

After setup completion, the managed Backend schedules detached update checks
while it remains running. It reads the next deadline from the private update
record, so an active Backend continues checking even when the user stays in one
client session. Stable installations follow npm `latest`; prerelease
installations follow `preview`. A successful result is reused for eight hours,
while a failed check, install, or reconciliation retries after 15 minutes. Set
`MEMORAX_CODE_AUTO_UPDATE=false` before starting or restarting the managed
Backend to disable the scheduler. Client startup Hooks only recover an
unavailable Backend and do not schedule updates.

For a manual update using a custom state root, pass its absolute path:

```sh
memorax-code update --home /absolute/path/to/memorax-code-home
```

Manual update resolves `--home` or `MEMORAX_CODE_HOME` relative to the caller's
working directory before npm changes directories, and uses that same absolute
root for package replacement and subsequent setup.

A manual interactive update may offer newly available clients. Without
completed setup, or when a manual update is non-interactive, package
replacement can finish while the command directs you to run
`memorax-code setup` explicitly.

The automatic updater installs an exact published version and runs an internal
non-interactive setup mode. That mode preserves explicit `[clients]` choices,
enables detected clients missing from an older configuration, and preserves
connection data and memory preferences. For Codex, only new or changed Hooks
returned by the incremental check are trusted silently, and the exact Hook
selection is validated again before and after the config write. A changed
marketplace identity or unverifiable Hook set prevents reconciliation from
completing. The standalone `memorax-code codex-plugin trust-hooks` command
still performs explicit review.

The installed version and next check deadline are stored in another private
record:

```text
$MEMORAX_CODE_HOME/runtime/install/automatic-update.json
```

Package replacement for a running managed Backend or retained DSH state uses
a separate private record:

```text
$MEMORAX_CODE_HOME/runtime/install/package-transition.json
```

Preinstall records and retires the running installation. Postinstall restores
and verifies it before consuming the record. Retained DSH state also triggers
this sequence, even without a live Backend PID and even when that state is
disabled; restoration invokes `start` with the retained client selection.
Fresh or stopped installations without retained DSH state remain stopped.
Direct npm installation does not run foreground setup. Do not edit these
runtime records by hand.

After a failed restoration, `memorax-code update --recover [--home DIR]` resumes
the installed package's start and status checks under the same transition lock.
It accepts only a valid retired record and consumes it only after verification.
Automatic restoration has a 15-minute freshness limit; explicit recovery also
accepts older records, but rejects future timestamps. It leaves setup completion
to `memorax-code setup`. See [package-transition recovery](troubleshooting.md#npm-package-transition-fails)
for prerequisites and recovery steps.

## DeepSeek Harness integration paths

DSH Profiles are discovered under:

```text
$DSH_HOME/profiles/<profile-name>/
```

`DSH_HOME` defaults to `~/.dsh`. The managed ownership record lives at
`$MEMORAX_CODE_HOME/adapters/dsh/state.json`. Runtime packages are materialized
under `$MEMORAX_CODE_HOME/adapters/dsh/runtime/generations/` and installed into
Profiles through DSH's native plugin command. The globally installed npm
package remains immutable; do not copy or edit the generated state or runtime
directories by hand. When at least one valid Profile exists but none provides
a loadable `@deepseek-ai/dsh-headless` bundle, MemoraX Code asks the same native
plugin command to initialize the standard `headless` Profile when that name is
available. Stop and uninstall remove the MemoraX Code adapter from this Profile
but preserve the Profile and its native data.

MemoraX Code is tested with DSH `0.1.0-rc.6`. Other valid semantic versions are
accepted but appear as untested in status output; compatibility is not
guaranteed. An unavailable or malformed `dsh --version` result fails Profile
reconciliation when a Profile exists. Run `memorax-code start --clients dsh`
after changing `DSH_HOME`, DSH, or its Profiles.

## OpenCode integration paths

The managed OpenCode plugin loader and shared skill use OpenCode's automatic
discovery directories:

```text
~/.config/opencode/plugins/memorax-code.js
~/.config/opencode/skills/memorax-code/
```

Set `OPENCODE_CONFIG_DIR` to override the complete OpenCode configuration root.
Otherwise, `XDG_CONFIG_HOME` replaces `~/.config` when set. The managed adapter
record lives at `$MEMORAX_CODE_HOME/adapters/opencode/state.json`. Content-free
plugin runtime evidence lives beside it in `workspaces.json` and records only
the observed event, workspace, optional session identifier, and timestamp.

MemoraX Code does not add entries to or otherwise modify `opencode.json` or
`opencode.jsonc`. Restart or refresh OpenCode after installation or after these
managed assets change.

The managed loader records the exact MemoraX Code home, OpenCode configuration
directory, installed Node runtime, and `memorax-code` entrypoint. When the
enabled plugin loads, it performs a best-effort Backend health check and uses
those installed package paths to restore an unavailable loopback Backend. A
prompt waits no more than the plugin instance's single five-second recovery
budget; if that budget expires, automatic memory handling for that turn is
skipped while recovery continues in the background. This preserves the
configured client selection. Remote Backend URLs, invalid connection
authority, and a removed package command are not recovered automatically.

## CodeBuddy and WorkBuddy integration paths

The managed CodeBuddy/WorkBuddy marketplace plugin and shared Skill use the
native plugin layout:

```text
<CODEBUDDY_HOME>/plugins/marketplaces/memorax-code-local/plugins/memorax-code-codebuddy-adapter/
├── hooks/
└── skills/memorax-code/
```

CodeBuddy CLI and WorkBuddy are separate managed clients that share this plugin
implementation. They can be enabled together with `--clients codebuddy,workbuddy`.
Each client retains its own configuration root and executable for later status,
stop, update, uninstall, and Hook recovery:

| Client | Default root | Root overrides | Runtime discovery |
| --- | --- | --- | --- |
| `codebuddy` | `~/.codebuddy` | `--codebuddy-home`, `CODEBUDDY_HOME`, then `CODEBUDDY_CONFIG_DIR` | Standalone `codebuddy` on PATH, or `MEMORAX_CODE_CODEBUDDY_COMMAND` / `CODEBUDDY_CLI_PATH` |
| `workbuddy` | `~/.workbuddy` | `--workbuddy-home`, `WORKBUDDY_HOME`, then `WORKBUDDY_CONFIG_DIR` | WorkBuddy's bundled runtime, or `MEMORAX_CODE_WORKBUDDY_COMMAND` / `WORKBUDDY_CODEBUDDY_PATH` |

WorkBuddy also exports `CODEBUDDY_CONFIG_DIR` as a compatibility alias. When it
points to the same directory as `WORKBUDDY_CONFIG_DIR`, MemoraX Code uses that
directory for WorkBuddy and leaves CodeBuddy CLI at its default root. A distinct
`CODEBUDDY_CONFIG_DIR` or an explicit `CODEBUDDY_HOME` / `--codebuddy-home` still
overrides the CLI root.

On Windows the default roots are under `%USERPROFILE%`. A proven legacy
WorkBuddy installation may retain its existing `.codebuddy` location; that root
cannot simultaneously belong to the standalone CLI. Choose separate roots before
enabling both. Installation, stop, and removal never clean the other client's
root. Retained installation records live under
`$MEMORAX_CODE_HOME/adapters/<client>/installation.json`.

Older versions represented WorkBuddy as `codebuddy`. When `workbuddy` has no
explicit selection, owned legacy installation metadata identifies that old
choice by its bundled command, `.workbuddy` root, or an explicitly configured
WorkBuddy root during setup and lifecycle reconciliation. A `.codebuddy` root
with a PATH command alone does not distinguish the two clients and retains
the CLI identity. An explicit `workbuddy = true` or `false` takes precedence;
explicit client identity in installation metadata also takes precedence over
legacy inference. Historical traces stay in their original client
namespace; newly installed Hooks use the distinct client identities.

The Skill is materialized from the canonical MemoraX Code Skill. CodeBuddy's
standalone IDE uses a different native transcript format and is not covered by
this adapter.

Setup also merges a managed `UserPromptSubmit` Hook into
`<CODEBUDDY_HOME>/settings.json`. It captures the first prompt even when the
native plugin is still loading; `SessionStart` and `Stop` remain in the plugin.
Other user Hooks and model settings are preserved. Stopping or removing the
integration removes its global Hook, and manually disabling the native plugin
also prevents that Hook from starting the Backend or collecting prompts.

On Windows, setup writes destination-specific native Hook paths so PowerShell
does not receive a `/c/Users/...` plugin path. `memorax-code-codebuddy status
--json` reports `codebuddyHooks.status` as `unverified` until a native client
Hook executes, `observed` afterward, and `invalid` when the installed Hook
manifest, managed prompt Hook, or runtime is incomplete. Restart or refresh
the CLI or WorkBuddy after setup.

## Trae integration paths

The managed Trae Global Hooks and shared Skill use Trae's data home:

```text
~/.trae-cn/hooks.json
~/.trae-cn/skills/memorax-code/
```

`TRAE_CN_HOME`, then `TRAE_HOME`, overrides the default root; lifecycle
commands can override it for one invocation with `--trae-home`. The ownership
record and content-addressed Hook runtime live under
`$MEMORAX_CODE_HOME/adapters/trae/`. Setup merges one marked MemoraX Code Hook
into each of `SessionStart`, `UserPromptSubmit`, and `Stop`, preserves other
Trae Hooks and settings, and refuses to replace an unmanaged
`skills/memorax-code` directory. Stop removes only the managed Hook entries and
retains the Skill; uninstall also removes the managed Skill.

Trae does not expose a reliable programmatic switch for application-level
Global Hooks. After the first setup, enable **Global Hooks** once in Trae
Settings and start a new session. `memorax-code-trae status --json` reports the
Hook runtime as `unverified` until Trae executes a managed Hook, then as
`observed`; it also reports when this one-time activation may still be needed.

Trae does not currently expose a stable raw Session or a headless CLI. The
adapter therefore correlates the prompt from `UserPromptSubmit` with the final
assistant message from `Stop` and uses that closed, validated Hook pair as
Trae's automatic-writeback content authority. It does not guess from another
Turn or maintain a pending queue. The Skill can still perform explicit Repo
Memory work, but automatic background Repo Memory jobs are unavailable in
Trae until the client provides a suitable headless worker.

## MemoraX connection

MemoraX is the required remote-memory service:

```toml
[memorax]
endpoint = "https://platform.memorax.net"
user_id = "your-username"
api_key = "your-api-key"
# timeout_ms = 5000
# startup_timeout_ms = 3000
```

| Field | Environment override | Fallback |
| --- | --- | --- |
| `endpoint` | `MEMORAX_CODE_MEMORAX_ENDPOINT` | `https://platform.memorax.net` |
| `user_id` | `MEMORAX_CODE_MEMORAX_USER_ID` | required username |
| `api_key` | `MEMORAX_CODE_MEMORAX_API_KEY` | required; setup writes it |
| `timeout_ms` | `MEMORAX_CODE_MEMORAX_TIMEOUT_MS` | `5000` ms |
| `startup_timeout_ms` | `MEMORAX_CODE_MEMORAX_STARTUP_TIMEOUT_MS` | `3000` ms |

MemoraX requests send the API key and the query or content required by the
selected memory operation to the HTTPS endpoint. Override `endpoint` only with
a compatible MemoraX service you trust.

Quota reminders keep only a one-way connection fingerprint and the last
notified level for memory write and memory search under the private runtime
directory. They do not store a raw API key, Mark ID, or account-registration
state. The returned quota limit is used only to decide whether to include
conditional anonymous-account guidance.

`startup_timeout_ms` controls synchronous automatic retrieval and is capped at
10 seconds.

### Memory scope

`user_id` is the configured base username. MemoraX Code sends
`<base-user-id>@<repository-or-folder-name>` for ordinary Git and non-Git
workspaces. Recognized default chat directories instead share
`<base-user-id>@General`, with `scopeKind: general`:

| Client | Recognized default chat directory |
| --- | --- |
| Codex | Its canonical dated-task location, previously named `Codex-General` in MemoraX. |
| WorkBuddy | A valid `YYYY-MM-DD-HH-mm-ss` direct child of `~/WorkBuddy`, or of WorkBuddy's configured `defaultWorkspacePath`. |
| OpenCode | The exact `Default Project` directory under the system Documents directory, including supported Documents redirection. |

A verified Git repository takes precedence over default-directory detection.
Other selected directories retain the ordinary repository or folder rules;
a directory name alone does not mark it as a default chat. Recognition follows
the directory convention, so a WorkBuddy default directory later kept as a
workspace still uses `General` if its path is unchanged and it remains non-Git.
Claude Code, DSH, and Trae retain their existing scope rules. Claude Cowork is
not included in this integration.

Automatic writeback and Skill Add/Search use the same resolved scope. The CLI
uses the matching current-Turn context when invoked by an integrated client;
standalone CLI commands resolve their working directory. Local client/session
identity and physical workspace identity remain separate even when remote
memory is shared. Resolution never falls back to the bare base user ID.

The change applies to subsequent writes and queries. Existing memories under
`Codex-General`, WorkBuddy date-directory names, or OpenCode's `Default-Project`
name are not migrated, and Search does not also query those previous names.

## Retrieval

Automatic prompt retrieval is disabled by default. The fields below belong in
the `[memory.retrieval]` TOML table.

| Field | Environment override | Fallback |
| --- | --- | --- |
| `enabled` | `MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED` | `false` |
| `top_k` | `MEMORAX_CODE_MEMORAX_TOP_K` | `6` |
| `k_dense` | `MEMORAX_CODE_MEMORAX_K_DENSE` | effective `top_k` |
| `k_sparse` | `MEMORAX_CODE_MEMORAX_K_SPARSE` | effective `top_k`; `0` disables sparse |
| `min_score` | `MEMORAX_CODE_MEMORAX_MIN_SCORE` | unset; range `0..1` |
| `max_context_chars` | `MEMORAX_CODE_MEMORAX_MAX_CONTEXT_CHARS` | `4000` |
| `max_item_chars` | `MEMORAX_CODE_MEMORAX_MAX_ITEM_CHARS` | `1000` |
| `render_by_memory_type` | `MEMORAX_CODE_MEMORAX_RENDER_BY_MEMORY_TYPE` | `true` |
| `memory_type_order` | `MEMORAX_CODE_MEMORAX_MEMORY_TYPE_ORDER` | `core,episodic,semantic,procedural,unclassified` |

The TOML form of `memory_type_order` is an array of strings; the environment
form is comma-separated. `enabled` controls automatic prompt retrieval only.
Explicit `memorax-cli search` remains available when
credentials and a trusted workspace scope resolve.

## Writeback and explicit add

New configurations explicitly set automatic completed-turn writeback to enabled.
An existing configuration without `enabled` remains disabled. The fields below
belong in the `[memory.writeback]` TOML table.

| Field | Environment override | Fallback |
| --- | --- | --- |
| `enabled` | `MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED` | `false` when absent |
| `buffer_enabled` | `MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED` | `true` |
| `buffer_max_turns` | `MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_TURNS` | `8`; `-1` disables automatic writeback |
| `buffer_max_age_ms` | `MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_AGE_MS` | `600000` |
| `buffer_max_chars` | `MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_CHARS` | `128000` |
| `max_message_chars` | `MEMORAX_CODE_MEMORY_WRITEBACK_MAX_MESSAGE_CHARS` | `64000` |
| `chunk_enabled` | `MEMORAX_CODE_MEMORY_WRITEBACK_CHUNK_ENABLED` | `true` |
| `chunk_max_chars` | `MEMORAX_CODE_MEMORY_WRITEBACK_CHUNK_MAX_CHARS` | `8000` |
| `chunk_overlap_ratio` | `MEMORAX_CODE_MEMORY_WRITEBACK_CHUNK_OVERLAP_RATIO` | `0.05`; range `0 <= x < 1` |

Automatic writeback and explicit Add have separate configuration gates.
`[memory.writeback].enabled` does not disable explicit `memorax-cli add`;
`[memory.cli].add_enabled` does not disable automatic writeback. The global
environment switch can disable both, as described below.

| Field | Environment override | Fallback |
| --- | --- | --- |
| `memory.add.content_type` | `MEMORAX_CODE_MEMORAX_ADD_CONTENT_TYPE` | command-dependent |
| `memory.add.mode` | `MEMORAX_CODE_MEMORAX_ADD_MODE` | command-dependent |
| `memory.add.output_language` | `MEMORAX_CODE_MEMORY_OUTPUT_LANGUAGE` | `zh` |
| `memory.cli.add_enabled` | `MEMORAX_CODE_MEMORY_CLI_ADD_ENABLED` | `true` |
| `memory.cli.max_memory_chars` | `MEMORAX_CODE_MEMORY_CLI_MAX_MEMORY_CHARS` | `2000` |

`output_language` accepts only `zh` or `en`. It is a local user preference,
not a model-controlled request option; every automatic and explicit add sends
the resolved value to MemoraX. Invalid values fail closed instead of silently
selecting another language. The setting affects newly generated content;
`raw` input and client-supplied `pre_summarized` text are not translated.
Command arguments override the other add defaults.

### Disabling memory writes

To persistently disable both automatic writeback and explicit Add, update the
existing tables in `config.toml`:

```toml
[memory.writeback]
enabled = false

[memory.cli]
add_enabled = false
```

Remove conflicting environment overrides that enable either feature, then run
`memorax-code restart` and `memorax-cli status` from the intended environment.
Setting only the first table disables automatic writeback while keeping
explicit Add available. Search is independent of both switches.

For a temporary override, export the global switch before restarting the
Backend and launching any clients that run memory commands. In Bash or Zsh:

```sh
export MEMORAX_CODE_MEMORAX_WRITEBACK_ENABLED=false
memorax-code restart
memorax-cli status
```

In PowerShell:

```powershell
$env:MEMORAX_CODE_MEMORAX_WRITEBACK_ENABLED = "false"
memorax-code restart
memorax-cli.cmd status
```

Only the exact string `false` disables this global switch. A shell assignment
does not change an already-running Backend or coding client's environment;
new CLI processes must inherit the override too. The controls apply to new
write decisions. They do not cancel requests already sent or guarantee that
previously buffered turns are discarded: graceful Backend shutdown can flush
those turns. They also do not delete memories already stored in MemoraX.

### Automatic writeback timestamps

Automatic QA messages use epoch-millisecond timestamps from the matching
native content records when available. The selected sources are:

| Client | User time | Assistant time |
| --- | --- | --- |
| Codex | Selected rollout user record | Matching `task_complete` event, otherwise the selected final message record |
| Claude Code | Selected transcript user record | Selected terminal assistant record |
| DeepSeek Harness | First included native user-message event | Completed `turn/end` event, otherwise the last included assistant-message event |
| OpenCode | Original SDK user `time.created` | Final SDK assistant `time.completed` |
| CodeBuddy/WorkBuddy | Selected transcript user record, when supplied | Selected completed assistant record, when supplied |
| Trae | Persisted prompt Hook observation | Stop Hook observation |

A native record timestamp is not necessarily the exact UI submit or last-token
time. Missing or invalid native timestamps use a known Turn-start observation
for the user and a completion-processing observation for the assistant; when
the start observation is unavailable, the user also uses completion processing.
These fallback times are fixed before buffering and provider retries.

Each automatic Add includes `metadata.memorax_code_timestamp_sources`, aligned
with its `messages` array: `native` means a selected native record/event time,
and `observed` means a local observation. Trae always uses `observed`. Explicit
Add callers that do not supply source information leave this metadata absent;
an unlabelled message in a mixed-source request is `unspecified`.

Buffering, chunking, and retries preserve message times and their sources.
Fragments of the same original message retain the same time; equal or
out-of-order supplied timestamps are not rewritten to impose artificial order.
An Add may contain multiple Turns, and one Turn may span multiple Adds. This
does not add Session/Turn fields to Search or reconstruct timestamps missing
from previously uploaded data.

### Automatic writeback redaction

Automatic writeback first bounds each user or assistant message with
`max_message_chars`, discarding an incomplete token at the cutoff, and then
runs a local best-effort detector before hashing, buffering, chunking, or
sending the content. The detector replaces these categories with typed
placeholders:

| Category | Placeholder |
| --- | --- |
| Private keys | `[REDACTED:PRIVATE_KEY]` |
| Authorization tokens and JWTs | `[REDACTED:AUTH_TOKEN]` |
| Cookie values | `[REDACTED:COOKIE]` |
| Common API key formats | `[REDACTED:API_KEY]` |
| Credential assignments, CLI arguments, URL query values, and URL passwords | `[REDACTED:CREDENTIAL]` |
| Email addresses | `[REDACTED:EMAIL]` |
| Long numbers, including common spaces, hyphens, and parentheses | `[REDACTED:LONG_NUMBER]` |
| UUIDs, fixed-length hexadecimal strings, and high-entropy alphanumeric identifiers | `[REDACTED:OPAQUE_ID]` |

If either bounded message has no meaningful content after replacement, the
automatic writeback is skipped before network dispatch. The detector is
always active for automatic writeback, but it is not a complete
data-loss-prevention system and may miss unknown or weak-context sensitive
formats. Explicit `memorax-cli add` content and Search queries are sent as
entered and do not pass through this detector.

## Skill reminder and repository maintenance

`[memory.skill_reminder].interval_turns` defaults to `5`; its environment
override is `MEMORAX_CODE_MEMORY_SKILL_REMINDER_INTERVAL_TURNS`. A positive
value controls the native skill reminder cadence for supported client
sessions, beginning with the first eligible prompt or Turn. The same interval
controls trusted repo-scoped Procedure Memory. User Profile preferences are
applied on first observation and restored with a personal-memory reminder
after successful context compaction. These local contexts remain separate
from automatic writeback content.

The repository-update fields below belong in `[memory.repo_update]`.

| Field | Environment override | Fallback |
| --- | --- | --- |
| `policy` | `MEMORAX_CODE_REPO_MEMORY_UPDATE_POLICY` | `adaptive` |
| `commit_threshold` | `MEMORAX_CODE_REPO_MEMORY_STALE_COMMIT_THRESHOLD` | `5` |
| `cooldown_hours` | `MEMORAX_CODE_REPO_MEMORY_UPDATE_COOLDOWN_HOURS` | `24` |

Supported policies are `every-commit`, `commit-count`, `daily`,
`pull-request`, `pull-request-or-daily`, and `adaptive`. Invalid policy values
fall back to `adaptive`.

In Codex, Claude Code, CodeBuddy/WorkBuddy, DSH, and OpenCode, the first
eligible prompt starts a background build only when the Backend has authorized
a Git worktree and that worktree has no `.repo_memory/PROFILE.md`. If the
Backend or workspace authority is unavailable, the client integration skips
that attempt instead of falling back to its local workspace path. DSH schedules
this work through its native pre-step integration rather than a Hook. Trae
receives the shared Skill, User Profile, and Procedure reminders, but does not
start this background build because Trae has no supported headless worker.

CodeBuddy/WorkBuddy repository jobs run the headless client under a bounded
worker. `MEMORAX_CODE_REPO_MEMORY_JOB_TIMEOUT_MS` sets the client execution
limit (default `600000` ms); `MEMORAX_CODE_REPO_MEMORY_JOB_KILL_GRACE_MS` sets
the grace period before the worker force-terminates a client that ignores
`SIGTERM` (default `5000` ms). A timeout is recorded as
`codebuddy_timeout` (or `<runner>_timeout`) in the job state, so a stalled
headless client cannot leave an active job and repository marker indefinitely.

A relevant repo-read runs supervised maintenance in the five headless-capable
client integrations. The configured policy may select a build, update, or
no-op. DSH maintenance requires an enabled, managed Profile that includes
`@deepseek-ai/dsh-headless`. OpenCode executes the job through its active local
server. Desktop-only installations do not require a standalone `opencode`
executable in `PATH`. Trae users can invoke the Skill explicitly, but Trae is
not an automatic maintenance runner.

## Default Search/Add diagnostics

Failed explicit `memorax-cli search` and `memorax-cli add` commands attempt to
save a content-free diagnostic by default, independently of Debug logging and
client trace settings. Successful commands and `memorax-cli status` do not
create these records. There is no diagnostic enablement setting.

Records are created only on failure under:

```text
$MEMORAX_CODE_HOME/runtime/diagnostics/<diagnostic-id>.json
```

The command returns the diagnostic ID and, when saved, its file path. On POSIX
systems, new diagnostic files use mode `0600` and diagnostic directories are
created or tightened to `0700`; Windows uses the current user's filesystem
ACLs. Each successful write attempts to retain the newest 100 records from
the last seven days. Cleanup is best-effort and runs when a record is written,
not on a background schedule.

Records retain operational metadata and safe error details, excluding queries,
Add text, response bodies, credentials, and raw local paths. See
[Search/Add recovery](troubleshooting.md#memorax-search-add-or-scope-fails) for
interpreting the output or a diagnostic-storage failure.

## Backend lifecycle diagnostics

Failed Backend reports from `memorax-code start`, `stop`, and `restart` use
the same [diagnostic storage and retention](#default-searchadd-diagnostics),
independently of Debug and trace settings. Each CLI command result writes at
most one record; the Backend service itself does not write these diagnostics.
`MEMORAX_CODE_BACKEND_SUPPRESS_GUIDANCE=1` does not suppress the default diagnostic.

This coverage is limited to failed Backend reports from those commands;
adapter-only failures and complete update, Hook, and automatic-writeback
flows are outside it. `status`, `logs`, `token`, and `uninstall` do not create
these records. See [Backend recovery](troubleshooting.md#backend-does-not-start)
for the failure fields and process-state guidance.

Setup also reports configuration, secure credential, local readiness, and
completion-record failures by default. Setup-owned records have
`source: "memorax-code-setup"` and `operation: "setup"`, and share the storage,
permissions, and 100-record/seven-day retention above. A failed Backend command's
existing diagnostic ID is reused instead of producing a duplicate setup record.
Configuration details include the failed write stage and `configState`; neither
configuration content nor credential or device identity values are retained.
See [setup recovery](troubleshooting.md#setup-does-not-complete).

## Local traces

`[trace.codex]`, `[trace.claude]`, `[trace.dsh]`, `[trace.opencode]`,
`[trace.codebuddy]`, `[trace.workbuddy]`, and `[trace.trae]` support the same fields:

| Field | Codex environment | Claude environment | DSH environment | OpenCode environment | CodeBuddy CLI environment | Trae environment | Fallback |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `enabled` | `MEMORAX_CODE_CODEX_TRACE_ENABLED` | `MEMORAX_CODE_CLAUDE_TRACE_ENABLED` | `MEMORAX_CODE_DSH_TRACE_ENABLED` | `MEMORAX_CODE_OPENCODE_TRACE_ENABLED` | `MEMORAX_CODE_CODEBUDDY_TRACE_ENABLED` | `MEMORAX_CODE_TRAE_TRACE_ENABLED` | `true` |
| `capture_content` | `MEMORAX_CODE_CODEX_TRACE_CAPTURE_CONTENT` | `MEMORAX_CODE_CLAUDE_TRACE_CAPTURE_CONTENT` | `MEMORAX_CODE_DSH_TRACE_CAPTURE_CONTENT` | `MEMORAX_CODE_OPENCODE_TRACE_CAPTURE_CONTENT` | `MEMORAX_CODE_CODEBUDDY_TRACE_CAPTURE_CONTENT` | `MEMORAX_CODE_TRAE_TRACE_CAPTURE_CONTENT` | `true` |
| `retention_days` | `MEMORAX_CODE_CODEX_TRACE_RETENTION_DAYS` | `MEMORAX_CODE_CLAUDE_TRACE_RETENTION_DAYS` | `MEMORAX_CODE_DSH_TRACE_RETENTION_DAYS` | `MEMORAX_CODE_OPENCODE_TRACE_RETENTION_DAYS` | `MEMORAX_CODE_CODEBUDDY_TRACE_RETENTION_DAYS` | `MEMORAX_CODE_TRAE_TRACE_RETENTION_DAYS` | `7` |
| `max_event_chars` | `MEMORAX_CODE_CODEX_TRACE_MAX_EVENT_CHARS` | `MEMORAX_CODE_CLAUDE_TRACE_MAX_EVENT_CHARS` | `MEMORAX_CODE_DSH_TRACE_MAX_EVENT_CHARS` | `MEMORAX_CODE_OPENCODE_TRACE_MAX_EVENT_CHARS` | `MEMORAX_CODE_CODEBUDDY_TRACE_MAX_EVENT_CHARS` | `MEMORAX_CODE_TRAE_TRACE_MAX_EVENT_CHARS` | `20000` |
| `max_file_bytes` | `MEMORAX_CODE_CODEX_TRACE_MAX_FILE_BYTES` | `MEMORAX_CODE_CLAUDE_TRACE_MAX_FILE_BYTES` | `MEMORAX_CODE_DSH_TRACE_MAX_FILE_BYTES` | `MEMORAX_CODE_OPENCODE_TRACE_MAX_FILE_BYTES` | `MEMORAX_CODE_CODEBUDDY_TRACE_MAX_FILE_BYTES` | `MEMORAX_CODE_TRAE_TRACE_MAX_FILE_BYTES` | `52428800` |

WorkBuddy uses the corresponding `MEMORAX_CODE_WORKBUDDY_TRACE_*` variables,
falling back to the older `MEMORAX_CODE_CODEBUDDY_TRACE_*` variables when absent.
When `[trace.workbuddy]` is absent, its configuration inherits the older
`[trace.codebuddy]` settings so existing trace preferences survive migration.

Depending on the enabled client capabilities, content capture can include
prompts, responses, recalled memory, writeback content, reminder text, and
local paths. Set `capture_content=false` for
metadata-only local traces, or `enabled=false` to stop a client's event capture.
Trace files stay under `$MEMORAX_CODE_HOME`; MemoraX Code has no trace upload,
export, or public collector.

The current-turn records remain available when event capture is disabled.
They contain client, Session and Turn identity, workspace/native paths, and
Turn status needed for CLI workspace association and exact recovery. They do
not contain prompts, responses, or memory content. Session checks and freshness
rules still apply, and inactive session directories remain subject to retention
cleanup. Disabling event capture does not erase previously retained events.

Changes to trace settings in `config.toml` apply to subsequent events, including
re-enabling capture. Environment overrides still require restarting the process
that inherited them.

DSH trace contains only normalized lifecycle and memory-operation events. Its
native Session Event Log and raw events remain local to DSH; MemoraX Code does
not copy that log into trace.

Trae trace contains only normalized lifecycle and memory-operation events from
the validated Hook pair. Trae does not expose a raw Session authority for
MemoraX Code to copy.

## Backend runtime settings

Backend connection and process authority is not stored in `config.toml`.
Common operator settings are:

| Environment | Purpose |
| --- | --- |
| `MEMORAX_CODE_HOME` | Select the state and configuration root |
| `MEMORAX_CODE_AUTO_UPDATE` | Set to `false` before starting or restarting the managed Backend to disable its automatic-update scheduler; see [update behavior](#setup-automatic-update-and-package-transition-state) |
| `MEMORAX_CODE_BACKEND_URL` | Override the Backend URL for one command or Hook |
| `MEMORAX_CODE_BACKEND_HOST` / `MEMORAX_CODE_BACKEND_PORT` | Select the managed bind; default `127.0.0.1:8787` |
| `MEMORAX_CODE_BACKEND_TOKEN` | Supply a transient Backend token |
| `MEMORAX_CODE_BACKEND_MODE` | Select explicit local or server behavior |
| `MEMORAX_CODE_BACKEND_ALLOW_EXTERNAL` | Allow an explicitly intended non-loopback bind |
| `MEMORAX_CODE_BACKEND_LOOPBACK_AUTH` | Control token use on loopback |
| `MEMORAX_CODE_BACKEND_LOG` | Override the managed Backend log path |

External binds fail unless explicitly allowed and protected by a Backend
token. Persistent connection, token, and PID records live under
`$MEMORAX_CODE_HOME/runtime/backend/`; do not hand-edit them.

## Failure behavior and diagnostics

- Missing `config.toml` is treated as an empty configuration and can be seeded
  on startup.
- Malformed TOML, a non-table root, or invalid `[clients]` types block
  lifecycle mutations before adapters or processes are changed.
- Ordinary memory and trace readers use safe fallbacks when the file cannot be
  read or parsed; memory readers may also warn. Unsupported field types are
  ignored.
- Targeted configuration updates preserve unrelated and unknown TOML content.
- Setup writes completion only after Backend, client, and effective local
  MemoraX configuration checks succeed. These checks do not authenticate a
  remote Search/Add request; a completion-write failure can leave the Backend
  running while setup remains incomplete.
- Invalid or unsupported Backend runtime records fail closed instead of
  silently falling back to `127.0.0.1:8787`.

Use these commands before editing state manually:

```sh
memorax-code status
memorax-code status --json
memorax-cli status
memorax-cli status --json
memorax-code-codex doctor
memorax-code-claude doctor
memorax-code status --clients dsh
memorax-code-opencode doctor
memorax-code-codebuddy status --json
memorax-code-trae status --json
```

The status commands do not print the MemoraX API key or Backend token.
