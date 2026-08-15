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
overrides or credentials that should not be written to disk. After editing the
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

The generated template selects both clients, disables automatic retrieval,
enables automatic writeback, sets the preferred language to Chinese (`zh`),
uses a five-turn skill reminder and the adaptive repository-update policy, and
enables content-bearing local traces for both clients. npm installation may
narrow `[clients]` to clients detected on the host. The tables below list all
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

A normal npm install or reinstall refreshes `[clients]` from the runnable
clients detected at that time. Update-mode postinstall runs preserve enabled
clients and also probe each disabled client. An interactive update offers each
runnable disabled integration for activation with a default of yes. Declining
the prompt, or running non-interactively, keeps that integration disabled. A
selected client that is temporarily unavailable also remains selected in the
configuration instead of being permanently disabled. When an update newly
enables Codex, it requests initial Hook activation after the client-selection
prompt.

Client selection controls plugin and Hook lifecycle only. It does not change
Codex or Claude Code provider settings. `--clients none` runs the Backend
without managing either client integration.

DeepSeek Harness (DSH) is not part of `[clients]`. It is a standalone adapter
installed into a DSH profile. The adapter is not yet published to npm, so
install it from a local checkout of the repository:

```sh
git clone https://github.com/memorax-ai/memorax-code.git
dsh plugin --profile <name> add ./memorax-code/packages/ts/memorax-code-dsh-adapter
```

Publishing `@memorax/memorax-code-dsh-adapter` to npm is pending maintainer
action; once published it can be installed with
`dsh plugin --profile <name> add @memorax/memorax-code-dsh-adapter`.

The adapter forwards DSH `turn/start` and `turn/end` events to the same
Backend. It resolves its connection in this order: the plugin's `backendUrl`
config, `MEMORAX_CODE_BACKEND_URL`, `MEMORAX_CODE_BACKEND_HOST`/`PORT`, the
managed Backend's connection record under the MemoraX Code home
(`runtime/backend/backend-connection.json`, which also points at the Backend
token file when the Backend runs with a token), and finally
`http://127.0.0.1:8787`. The token comes from `MEMORAX_CODE_BACKEND_TOKEN`,
the plugin's `backendToken` config, or that token file — but the file's token
is only used when the URL itself came from the connection record, so a
managed token is never sent to a manually configured URL. An invalid
connection record is reported to stderr and skipped, never fatal. Requests
time out with `MEMORAX_CODE_DSH_HOOK_TIMEOUT_MS` (default `5000`).
Set `MEMORAX_CODE_DSH_HOOK_DEBUG=true` to print adapter diagnostics to stderr;
with debug on, Backend-side writeback skips (`turn_metadata_missing`,
`prompt_mismatch`) are logged too. When the Backend is unreachable the
adapter fails silently and never blocks a DSH turn.

Retrieval injection into DSH conversations needs BOTH switches, and neither
one alone is enough:

1. Backend-side automatic retrieval (`[memory.retrieval]` /
   `MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED`, default `false`). The Backend only
   computes and returns `additionalContext` when this is enabled.
2. Adapter-side injection (`MEMORAX_CODE_DSH_RETRIEVAL_INJECT=true`). The
   adapter only weaves returned context into the live DSH conversation when
   this is enabled.

With only the Backend switch on, retrieved context is computed but never
reaches the DSH conversation; with only the adapter switch on, the Backend
returns nothing to inject. Codex and Claude Code are unaffected by the
adapter switch.

The Backend keeps DSH turn metadata in memory (exempt from the five-minute
TTL, but sharing the same 256-turn cap as Codex and Claude Code turns), so a
very long-running session can evict its oldest DSH turns. If the metadata for
a writeback is gone, the Backend recovers the turn from the local current-turn
trace file written at turn-start, and skips the writeback when that file does
not attest the same session and turn.

## MemoraX connection

MemoraX is the required remote-memory service:

```toml
[memorax]
endpoint = "https://platform.memorax.net"
user_id = "your-base-user-id"
api_key = "your-api-key"
# timeout_ms = 5000
# startup_timeout_ms = 3000
```

| Field | Environment override | Fallback |
| --- | --- | --- |
| `endpoint` | `MEMORAX_CODE_MEMORAX_ENDPOINT` | `https://platform.memorax.net` |
| `user_id` | `MEMORAX_CODE_MEMORAX_USER_ID` | required |
| `api_key` | `MEMORAX_CODE_MEMORAX_API_KEY` | required |
| `timeout_ms` | `MEMORAX_CODE_MEMORAX_TIMEOUT_MS` | `5000` ms |
| `startup_timeout_ms` | `MEMORAX_CODE_MEMORAX_STARTUP_TIMEOUT_MS` | `3000` ms |

MemoraX requests send the API key and the query or content required by the
selected memory operation to the HTTPS endpoint. Override `endpoint` only with
a compatible MemoraX service you trust.

`startup_timeout_ms` controls synchronous automatic retrieval and is capped at
10 seconds. `user_id` is a base identity; MemoraX Code derives a
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

`[trace.codex]`, `[trace.claude]`, and `[trace.dsh]` support the same fields:

| Field | Codex environment | Claude environment | DSH environment | Fallback |
| --- | --- | --- | --- | --- |
| `enabled` | `MEMORAX_CODE_CODEX_TRACE_ENABLED` | `MEMORAX_CODE_CLAUDE_TRACE_ENABLED` | `MEMORAX_CODE_DSH_TRACE_ENABLED` | `true` |
| `capture_content` | `MEMORAX_CODE_CODEX_TRACE_CAPTURE_CONTENT` | `MEMORAX_CODE_CLAUDE_TRACE_CAPTURE_CONTENT` | `MEMORAX_CODE_DSH_TRACE_CAPTURE_CONTENT` | `true` |
| `retention_days` | `MEMORAX_CODE_CODEX_TRACE_RETENTION_DAYS` | `MEMORAX_CODE_CLAUDE_TRACE_RETENTION_DAYS` | `MEMORAX_CODE_DSH_TRACE_RETENTION_DAYS` | `7` |
| `max_event_chars` | `MEMORAX_CODE_CODEX_TRACE_MAX_EVENT_CHARS` | `MEMORAX_CODE_CLAUDE_TRACE_MAX_EVENT_CHARS` | `MEMORAX_CODE_DSH_TRACE_MAX_EVENT_CHARS` | `20000` |
| `max_file_bytes` | `MEMORAX_CODE_CODEX_TRACE_MAX_FILE_BYTES` | `MEMORAX_CODE_CLAUDE_TRACE_MAX_FILE_BYTES` | `MEMORAX_CODE_DSH_TRACE_MAX_FILE_BYTES` | `52428800` |

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
```

The status commands do not print the MemoraX API key or Backend token.
