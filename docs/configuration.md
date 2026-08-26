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

This reconciles the managed Backend and client integrations. Some Hook and CLI
processes reread configuration sooner, but `memorax-code start` is the
supported consistency boundary.

TOML booleans are `true` or `false`. Environment booleans accept
`true/false`, `1/0`, `yes/no`, and `on/off`. Unknown fields are ignored and
are not a compatibility contract.

## New configuration

The generated template selects all four client integrations, disables automatic
retrieval, enables automatic writeback, sets the preferred language to Chinese
(`zh`), uses a five-turn skill reminder and the adaptive repository-update
policy, and enables content-bearing local traces for Codex, Claude Code, and
OpenCode. Foreground setup may narrow `[clients]` to clients detected on the
host. The tables below list all fallbacks, including tuning fields omitted from
the generated file.

On POSIX systems MemoraX Code creates `$MEMORAX_CODE_HOME` with mode `0700`
and a new `config.toml` with mode `0600`. Windows relies on the current user's
filesystem ACLs.

## Client selection

If `[clients]` is absent, lifecycle commands select Codex, Claude Code, DSH,
and OpenCode. If it is present, `codex`, `claude`, `dsh`, and `opencode` are
boolean fields. Omitted `codex`, `claude`, or `opencode` values are disabled;
an omitted `dsh` value remains enabled so configurations written before DSH
support can discover an existing local Harness. Set `dsh = false` explicitly
to disable that integration. The command-line override accepts a
comma-separated subset:

```text
--clients codex|claude|dsh|opencode|<comma-separated subset>|all|none
```

Foreground `memorax-code setup` refreshes `[clients]` from the clients
available at that time. OpenCode is available when its explicit, XDG, or
default configuration directory exists, or when `opencode` is on `PATH`.
DSH is available when at least one valid Profile exists under
`$DSH_HOME/profiles`; `DSH_HOME` defaults to `~/.dsh`. An explicit
`[clients].dsh = false` is preserved.

On later setup runs, enabled client intent is preserved. Each newly available
disabled client is offered for activation with a default of yes; declining
keeps it disabled. A selected client that is temporarily unavailable remains
selected instead of being permanently disabled. Direct npm installation does
not detect clients or modify `[clients]`.

Client selection controls managed client-integration lifecycle only. It does
not change Codex, Claude Code, DSH, or OpenCode provider settings.
`--clients none` runs the Backend without managing a client integration.

## Setup and package-transition state

npm installation and foreground setup are separate operations.
`npm install -g @memorax/memorax-code` installs or replaces package files
without reading terminal input. `memorax-code setup` owns client detection,
connection setup, configuration writes, Codex Hook activation or review, and
final readiness checks.

Default setup reuses a complete effective connection. Otherwise it detects the
logged-in operating-system username and maps the system language to `zh` or
`en`, asking only when a value cannot be detected safely. It then creates or
restores an account-free credential and writes its API key to `config.toml`.
`memorax-code setup --existing-account` bypasses automatic reuse and accepts
an existing connection's username and API key. `--reconfigure` bypasses reuse
and follows the account-free path again.

Successful setup writes a private versioned record at:

```text
$MEMORAX_CODE_HOME/runtime/setup/setup-completion.json
```

The record controls only no-argument CLI routing. When it is valid, the command
shows status. When it is absent and an interactive terminal is available,
`memorax-code` validates and reuses a complete effective configuration, then
runs setup and reconciliation once to write the record. If the configuration
is incomplete or no interactive terminal is available, it points to
`memorax-code setup`. Invalid and unsupported records fail closed. A complete
product uninstall removes this marker while retaining `config.toml`; stop and
partial client uninstall preserve it.

Replacing a running managed Backend uses a separate private record:

```text
$MEMORAX_CODE_HOME/runtime/install/package-transition.json
```

Preinstall records and retires the running installation. Postinstall restores
and verifies it before consuming the record. A fresh or already-stopped
installation has no transition and remains stopped. Do not edit either runtime
record by hand.

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
10 seconds. `user_id` is the configured username; MemoraX Code derives a
repository-scoped identity for Git workspaces and a folder-scoped identity for
non-Git workspaces. It never falls back to the unscoped base identity.

## Retrieval

Automatic prompt retrieval is disabled by default.

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
An existing configuration without `enabled` remains disabled.

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

The global kill switch
`MEMORAX_CODE_MEMORAX_WRITEBACK_ENABLED=false` disables automatic writeback and
explicit `memory add`.

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

| Field | Environment override | Fallback |
| --- | --- | --- |
| `policy` | `MEMORAX_CODE_REPO_MEMORY_UPDATE_POLICY` | `adaptive` |
| `commit_threshold` | `MEMORAX_CODE_REPO_MEMORY_STALE_COMMIT_THRESHOLD` | `5` |
| `cooldown_hours` | `MEMORAX_CODE_REPO_MEMORY_UPDATE_COOLDOWN_HOURS` | `24` |

Supported policies are `every-commit`, `commit-count`, `daily`,
`pull-request`, `pull-request-or-daily`, and `adaptive`. Invalid policy values
fall back to `adaptive`.

In Codex, Claude Code, DSH, and OpenCode, the first eligible prompt starts a
background build only when the Backend has authorized a Git worktree and that
worktree has no `.repo_memory/PROFILE.md`. If the Backend or workspace
authority is unavailable, the client integration skips that attempt instead
of falling back to its local workspace path. DSH schedules this work through
its native pre-step integration rather than a Hook.

A relevant repo-read runs supervised maintenance in all four clients. The
configured policy may select a build, update, or no-op. DSH maintenance
requires an enabled, managed Profile that includes `@deepseek-ai/dsh-headless`.
OpenCode executes the job through its active local server. Desktop-only
installations do not require a standalone `opencode` executable in `PATH`.

## Local traces

`[trace.codex]`, `[trace.claude]`, `[trace.dsh]`, and `[trace.opencode]`
support the same fields:

| Field | Codex environment | Claude environment | DSH environment | OpenCode environment | Fallback |
| --- | --- | --- | --- | --- | --- |
| `enabled` | `MEMORAX_CODE_CODEX_TRACE_ENABLED` | `MEMORAX_CODE_CLAUDE_TRACE_ENABLED` | `MEMORAX_CODE_DSH_TRACE_ENABLED` | `MEMORAX_CODE_OPENCODE_TRACE_ENABLED` | `true` |
| `capture_content` | `MEMORAX_CODE_CODEX_TRACE_CAPTURE_CONTENT` | `MEMORAX_CODE_CLAUDE_TRACE_CAPTURE_CONTENT` | `MEMORAX_CODE_DSH_TRACE_CAPTURE_CONTENT` | `MEMORAX_CODE_OPENCODE_TRACE_CAPTURE_CONTENT` | `true` |
| `retention_days` | `MEMORAX_CODE_CODEX_TRACE_RETENTION_DAYS` | `MEMORAX_CODE_CLAUDE_TRACE_RETENTION_DAYS` | `MEMORAX_CODE_DSH_TRACE_RETENTION_DAYS` | `MEMORAX_CODE_OPENCODE_TRACE_RETENTION_DAYS` | `7` |
| `max_event_chars` | `MEMORAX_CODE_CODEX_TRACE_MAX_EVENT_CHARS` | `MEMORAX_CODE_CLAUDE_TRACE_MAX_EVENT_CHARS` | `MEMORAX_CODE_DSH_TRACE_MAX_EVENT_CHARS` | `MEMORAX_CODE_OPENCODE_TRACE_MAX_EVENT_CHARS` | `20000` |
| `max_file_bytes` | `MEMORAX_CODE_CODEX_TRACE_MAX_FILE_BYTES` | `MEMORAX_CODE_CLAUDE_TRACE_MAX_FILE_BYTES` | `MEMORAX_CODE_DSH_TRACE_MAX_FILE_BYTES` | `MEMORAX_CODE_OPENCODE_TRACE_MAX_FILE_BYTES` | `52428800` |

Depending on the enabled client capabilities, content capture can include
prompts, responses, recalled memory, writeback content, reminder text, and
local paths. Set `capture_content=false` for
metadata-only local traces, or `enabled=false` to disable a client's trace.
Trace files stay under `$MEMORAX_CODE_HOME`; MemoraX Code has no trace upload,
export, or public collector.

DSH trace contains only normalized lifecycle and memory-operation events. Its
native Session Event Log and raw events remain local to DSH; MemoraX Code does
not copy that log into trace.

## Backend runtime settings

Backend connection and process authority is not stored in `config.toml`.
Common operator settings are:

| Environment | Purpose |
| --- | --- |
| `MEMORAX_CODE_HOME` | Select the state and configuration root |
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
- Setup writes completion only after Backend, client, and effective MemoraX
  readiness checks succeed.
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
```

The status commands do not print the MemoraX API key or Backend token.
