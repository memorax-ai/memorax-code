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
overrides. Trial and existing-account setup write the effective API key to the
private configuration so that the connection can be moved to another computer.
After editing the file, run:

```sh
memorax-code start
memorax-code status
memorax-cli status
```

This reconciles the managed Backend and client integrations. Some Hook and CLI
processes reread configuration sooner, but `memorax-code start` is the
supported consistency boundary.

The MemoraX API key has one additional setup-managed source. Its precedence is:

```text
MEMORAX_CODE_MEMORAX_API_KEY > [memorax].api_key > ready secure trial credential
```

A TOML key is used directly regardless of whether it was entered for an
existing account or copied from a provisioned trial. The ready secure trial
credential is consulted only when neither an environment nor TOML key is
available. Legacy `credential_source` fields are ignored by the runtime and
removed the next time setup reconciles the connection.

TOML booleans are `true` or `false`. Environment booleans accept
`true/false`, `1/0`, `yes/no`, and `on/off`. Unknown fields are ignored and
are not a compatibility contract.

## New configuration

The generated template selects both clients, disables automatic retrieval,
enables automatic writeback, sets the preferred language to Chinese (`zh`),
uses a five-turn skill reminder and the adaptive repository-update policy, and
enables content-bearing local traces for both clients. Interactive setup may
narrow `[clients]` to clients detected on the host. npm package installation
does not detect clients or change this selection. The tables below list all
fallbacks, including tuning fields omitted from the generated file.

On POSIX systems MemoraX Code creates `$MEMORAX_CODE_HOME` with mode `0700`
and a new `config.toml` with mode `0600`. Windows relies on the current user's
filesystem ACLs.

## Client selection

If `[clients]` is absent, lifecycle commands select both clients. If it is
present, `codex` and `claude` are boolean fields and an omitted client is
disabled. The command-line override is:

```text
--clients codex|claude|codex,claude|all|none
```

On a fresh interactive setup, MemoraX Code enables every runnable supported
client it detects. Later setup runs preserve enabled clients and also probe
each disabled client. Setup offers each runnable disabled integration for
activation with a default of yes. Declining the prompt keeps that integration
disabled. A selected client that is temporarily unavailable remains selected
in the configuration instead of being permanently disabled. When setup newly
enables Codex, or restores a selected integration whose plugin was removed, it
activates the bundled Codex Hooks without a second confirmation. New or
changed Hook command hashes discovered during later updates still require
foreground review.

`memorax-code update` performs package replacement first. When the managed
Backend is running and the command has an interactive terminal, it then runs
setup in update mode to review newly available clients and changed Codex
Hooks. That review does not ask for MemoraX credentials again. Direct npm
updates and non-interactive product updates do not change `[clients]` or
authorize Hooks; run `memorax-code setup` later when review is required.

Client selection controls plugin and Hook lifecycle only. It does not change
Codex or Claude Code provider settings. `--clients none` runs the Backend
without managing either client integration.

## Setup, reconciliation, and package-transition state

Interactive setup and npm package installation are separate control-plane
operations. `npm install -g @memorax/memorax-code` installs or replaces the
package without reading terminal input. `memorax-code setup` owns client
detection, prompts, configuration writes, initial Codex Hook activation,
exact review of later Hook changes, and final readiness.

Setup has two connection-handling modes. Interactive `memorax-code setup` first
checks for a locally ready MemoraX connection and asks whether to reuse its
saved connection and memory preferences. Accepting preserves them. If no ready
connection exists, or reuse is declined, setup uses the logged-in operating-
system account name as the User ID and maps the user's system language to `zh`
or `en`. It asks only for a preference that cannot be detected safely, then
asks whether the user already has a MemoraX account. Selecting an existing
account prompts for its API key, writes it with the connection preferences,
and skips trial provisioning. Selecting no, or pressing Enter, creates or
restores a secure trial credential and writes the preferences plus a portable
API-key copy. After the secure trial credential is ready, setup replaces any
`[memorax].api_key` with that credential's current API key. An environment API
key remains a higher-precedence override. Setup reached from
`memorax-code update` preserves the existing MemoraX connection without asking
for memory preferences or changing credentials; for a legacy trial connection
that has no TOML key, it copies the retained secure key into TOML. Accepting a
saved trial connection during reinstall performs the same one-time backfill.

Setup stages the packaged Hook runtime and reconciles the selected clients
with `memorax-code start` followed by `memorax-code status`. An ordinary start
failure gets one bounded stop/start recovery attempt. Deterministic Hook
activation, lifecycle-lock, or persisted runtime-authority failures skip that
automatic stop so uncertain authority is not overwritten. The staged Hook
generation becomes active only through a successful lifecycle start. Outside
update mode, setup checks config-only MemoraX readiness again after Backend
reconciliation and does not record completion unless that check succeeds.

Successful readiness is recorded in the private, versioned file:

```text
$MEMORAX_CODE_HOME/runtime/setup/setup-completion.json
```

The record controls only no-argument CLI routing. If it is absent,
`memorax-code` tells the user to run `memorax-code setup`; if it is valid, the
command shows status. Invalid or unsupported records fail closed.
`memorax-code setup` always runs interactive setup and is serialized with the
matching JSON lock. Completion is written only after the final readiness check
succeeds.

A complete product uninstall removes this routing marker after removing the
managed integrations, while preserving `config.toml`. After reinstall, the
no-argument command points the user to `memorax-code setup`, which can offer to
reuse that configuration and its retained secure trial credential. A normal
stop and a partial client uninstall preserve the completion record.

Package replacement uses a separate private, versioned record:

```text
$MEMORAX_CODE_HOME/runtime/install/package-transition.json
```

When preinstall proves that the managed Backend PID is live, it first writes a
`retiring` transition, then runs a Backend-only stop. It advances the record to
`retired` only after the stop succeeds and PID authority disappears.
Postinstall consumes only a fresh `retired` record, runs `start` and `status`
without a `--clients` override, and therefore uses the persisted `[clients]`
selection. It never detects clients, prompts, or authorizes Hooks. On success
it preserves a valid setup-completion record or creates one when absent, then
removes the transition record. Any failure retains the transition for explicit
diagnosis and retry.

When no managed PID exists, preinstall has no install-state side effects. A
dead or malformed PID may be passed to the Backend-only stop for safe cleanup,
but it does not schedule a postinstall restart. Consequently, package
installation does not start a Backend that was already stopped.

## MemoraX connection

MemoraX is the required remote-memory service:

```toml
[memorax]
endpoint = "https://platform.memorax.net"
api_key = "your-api-key"
user_id = "your-user-id"
# timeout_ms = 5000
# startup_timeout_ms = 3000
```

Both trial and existing-account setup write `api_key` here. Trial setup also
retains the complete versioned trial identity in the operating-system secure
credential store. The plugin uses the same TOML key before and after account
activation and does not classify current account status locally. A manually
managed connection may set `api_key` or supply
`MEMORAX_CODE_MEMORAX_API_KEY`.

| Field | Environment override | Fallback |
| --- | --- | --- |
| `endpoint` | `MEMORAX_CODE_MEMORAX_ENDPOINT` | `https://platform.memorax.net` |
| `user_id` | `MEMORAX_CODE_MEMORAX_USER_ID` | required User ID |
| `api_key` | `MEMORAX_CODE_MEMORAX_API_KEY` | ready secure trial credential; otherwise required |
| `timeout_ms` | `MEMORAX_CODE_MEMORAX_TIMEOUT_MS` | `5000` ms |
| `startup_timeout_ms` | `MEMORAX_CODE_MEMORAX_STARTUP_TIMEOUT_MS` | `3000` ms |

Interactive setup determines whether the connection can be reused through the
same config-only status resolution used by `memorax-cli status`, including the
precedence documented above. A non-empty User ID, an effective API key from
one of those sources, and a valid `zh` or `en` memory output language form a
locally ready connection; an omitted output language uses the `zh` fallback.
This check does not send a network request or prove that the API key is
accepted by the memory API. Trial provisioning is a separate foreground
network operation. Both paths write the endpoint, User ID, language, and API
key to `config.toml`. Environment variables remain higher-precedence
overrides.

After a trial account is activated, its API key can be reused on another
computer by placing the copied endpoint, User ID, and API key in that
computer's private `config.toml`. The copied connection works as an explicit
TOML connection; device-local trial metadata remains in the original
operating-system credential store, while local quota-reminder history remains
in the original computer's private runtime state.

MemoraX requests send the API key and the query or content required by the
selected memory operation to the HTTPS endpoint. Override `endpoint` only with
a compatible MemoraX service you trust.

`startup_timeout_ms` controls synchronous automatic retrieval and is capped at
10 seconds. `user_id` is the stable User ID; MemoraX Code derives a
repository-scoped identity for Git workspaces and a folder-scoped identity for
non-Git workspaces. It never falls back to the unscoped User ID.

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
form is comma-separated. `enabled` controls automatic `UserPromptSubmit`
retrieval only. Explicit `memorax-cli search` remains available when
credentials and a trusted workspace scope resolve.

## Writeback and explicit add

New configurations explicitly set automatic transcript writeback to enabled.
An existing configuration without `enabled` remains disabled.

| Field | Environment override | Fallback |
| --- | --- | --- |
| `enabled` | `MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED` | `false` when absent |
| `buffer_enabled` | `MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED` | `true` |
| `buffer_max_turns` | `MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_TURNS` | `8`; `-1` disables automatic Hook writeback |
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
value controls the reminder cadence for both clients, beginning with the first
eligible prompt.

| Field | Environment override | Fallback |
| --- | --- | --- |
| `policy` | `MEMORAX_CODE_REPO_MEMORY_UPDATE_POLICY` | `adaptive` |
| `commit_threshold` | `MEMORAX_CODE_REPO_MEMORY_STALE_COMMIT_THRESHOLD` | `5` |
| `cooldown_hours` | `MEMORAX_CODE_REPO_MEMORY_UPDATE_COOLDOWN_HOURS` | `24` |

Supported policies are `every-commit`, `commit-count`, `daily`,
`pull-request`, `pull-request-or-daily`, and `adaptive`. Invalid policy values
fall back to `adaptive`.

The first eligible prompt starts a background build only when the Backend has
authorized a Git worktree and that worktree has no `.repo_memory/PROFILE.md`.
If the Backend or workspace authority is unavailable, the Hook skips the
initial build instead of falling back to its local `cwd`.

## Local traces

`[trace.codex]` and `[trace.claude]` support the same fields:

| Field | Codex environment | Claude environment | Fallback |
| --- | --- | --- | --- |
| `enabled` | `MEMORAX_CODE_CODEX_TRACE_ENABLED` | `MEMORAX_CODE_CLAUDE_TRACE_ENABLED` | `true` |
| `capture_content` | `MEMORAX_CODE_CODEX_TRACE_CAPTURE_CONTENT` | `MEMORAX_CODE_CLAUDE_TRACE_CAPTURE_CONTENT` | `true` |
| `retention_days` | `MEMORAX_CODE_CODEX_TRACE_RETENTION_DAYS` | `MEMORAX_CODE_CLAUDE_TRACE_RETENTION_DAYS` | `7` |
| `max_event_chars` | `MEMORAX_CODE_CODEX_TRACE_MAX_EVENT_CHARS` | `MEMORAX_CODE_CLAUDE_TRACE_MAX_EVENT_CHARS` | `20000` |
| `max_file_bytes` | `MEMORAX_CODE_CODEX_TRACE_MAX_FILE_BYTES` | `MEMORAX_CODE_CLAUDE_TRACE_MAX_FILE_BYTES` | `52428800` |

Content capture can include prompts, responses, recalled memory, writeback
content, reminder text, and local paths. Set `capture_content=false` for
metadata-only local traces, or `enabled=false` to disable a client's trace.
Trace files stay under `$MEMORAX_CODE_HOME`; MemoraX Code has no trace upload,
export, or public collector.

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
`$MEMORAX_CODE_HOME/runtime/backend/`. Setup completion and in-progress package
replacement use the private records described above. Do not hand-edit runtime
records while a setup, npm, or lifecycle command may still be active.

## Failure behavior and diagnostics

- Missing `config.toml` is treated as an empty configuration and can be seeded
  on startup.
- Malformed TOML, a non-table root, or invalid `[clients]` types block
  lifecycle mutations before adapters or processes are changed.
- Interactive setup offers to reuse a locally ready MemoraX connection. If none
  exists or reuse is declined, it detects the User ID and language from the
  local user environment, asks for any value that could not be detected, and
  then asks for the account choice. It configures the entered existing-account
  API key or provisions a trial credential. A malformed TOML file remains
  fail-closed and is not overwritten by the setup flow.
- Ordinary memory and trace readers use safe fallbacks when the file cannot be
  read or parsed; memory readers may also warn. Unsupported field types are
  ignored.
- Targeted configuration updates preserve unrelated and unknown TOML content.
- Invalid or unsupported Backend runtime records fail closed instead of
  silently falling back to `127.0.0.1:8787`.
- Invalid or unsupported setup-completion and package-transition records fail
  closed instead of rerunning setup or restarting a Backend implicitly.

Use these commands before editing state manually:

```sh
memorax-code status
memorax-code status --json
memorax-cli status
memorax-cli status --json
memorax-code-codex doctor
memorax-code-claude doctor
```

The status commands do not print the MemoraX API key or Backend token.
