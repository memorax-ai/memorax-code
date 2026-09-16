# Changelog

This file records notable user-facing changes to MemoraX Code. Internal
refactors and test-only changes are omitted unless they affect product
behavior.

## Unreleased

## [0.1.18] - 2026-09-16

### Added

- Added default failure diagnostics for setup, client installation, Backend
  lifecycle, updates, explicit Search/Add, Hooks, and automatic writeback.
  Records identify the failed stage, error code, impact, and recovery guidance
  without requiring Debug or trace logging, and exclude conversation content
  and credentials.
- Added recent failure history to `memorax-code status` and diagnostic lookup
  through `memorax-code logs --diagnostics` and `memorax-code logs --id`.
  Records stay local with a 30-day, 1000-record retention policy. Historical
  failures remain separate from current readiness and can be inspected while
  the Backend is stopped.

### Fixed

- Improved interrupted update recovery with shared manual/automatic update
  locking, bounded restoration retries, and Backend recovery after a failed
  npm installation. Recovery respects later stop, restart, or uninstall
  operations; restoring the Backend does not report a failed update as
  successful. Diagnostics preserve the original failure and recovery outcome.
- Supported newer DSH session persistence APIs and native log formats, resolved
  built-in components from the selected DSH installation during fresh setup,
  and preserved Windows plugin paths containing spaces or special characters.
- Preserved WorkBuddy's original prompt after Slash/Skill expansion so matching
  completed turns remain eligible for automatic QA writeback.
- Fixed Windows partial JSONL repair, retried transient state-file replacement
  failures, allowed lifecycle command output to drain before exit, and avoided
  reporting cleanup failure when the Backend had already exited.
- Updated `smol-toml` to require version 1.8.0 or later, preventing certain
  malformed TOML configurations from hanging configuration reads and lifecycle
  commands.

## [0.1.17] - 2026-09-12

### Added

- Added `memorax-code setup --existing-account --non-interactive` for coding
  agents without an interactive terminal. It accepts one API key through stdin,
  uses the detected username and language, preserves explicit client choices,
  and checks that the saved key matches before completing setup.

### Fixed

- Removed hard-link claims from normal JSON lock acquisition and used direct
  file removal for lock release, reducing failures under client deletion
  protection. Concurrent stale-lock recovery releases losing claims before
  slower process checks. Lock cleanup failures now retain the underlying error
  instead of silently reporting success.
- Reused complete, unchanged Codex and CodeBuddy/WorkBuddy plugin artifacts
  during setup and activation. Skills already included in a copied plugin are
  no longer deleted and copied again; changed or incomplete artifacts are
  still repaired.
- Kept WorkBuddy's inherited configuration-directory alias from redirecting
  standalone CodeBuddy CLI installation into the WorkBuddy directory.
- Allowed Codex uninstall to finish when its marketplace is already absent,
  and included underlying registration and activation errors in setup output.

### Upgrade note

The explicit non-interactive command replaces the saved API key. A reported
key match verifies local persistence, not remote authentication. Interactive
setup remains available, and guest setup still requires a terminal. See
[non-interactive setup](docs/configuration.md#existing-account-setup-without-a-terminal).

## [0.1.16] - 2026-09-10

### Added

- Added independent support for CodeBuddy CLI and WorkBuddy, including
  discovery, plugin installation, Hooks, and lifecycle operations. Either can
  be used alone, or both can be enabled with separate configuration roots.
  Stopping or uninstalling one preserves the other.

### Fixed

- Recognized the official Windows CodeBuddy npm `.cmd` launcher during setup
  and reported unusable selected runtimes instead of silently skipping them.
- Migrated identifiable legacy WorkBuddy installations to the separate
  WorkBuddy client while preserving explicit selections and owned custom
  roots. Hooks with missing or invalid client identity no longer default to
  CodeBuddy, and Windows-equivalent root paths are cleaned up consistently.
- Retried transient Windows directory failures during Trae/OpenCode
  installation and shared Hook runtime publication, with bounded retries and
  explicit failure when access remains unavailable.
- Reported the failing client and installation step accurately during setup,
  without adding another global stop/start cycle after the Backend has
  recovered while a client integration remains incomplete.
- Coordinated concurrent Hook recovery and preserved the managed client set,
  including explicit client stops, when restoring an unavailable Backend.

### Upgrade note

Finish the current reply before updating, then start a new CodeBuddy CLI
session or restart WorkBuddy to load the new Hooks. Legacy installations whose
client ownership is ambiguous require an explicit WorkBuddy home; see the
[configuration guide](docs/configuration.md#codebuddy-and-workbuddy-integration-paths).

## [0.1.15] - 2026-09-09

### Added

- Shared Coding Memory across recognized default chats in Codex, WorkBuddy,
  and OpenCode under `<base-user-id>@General`, while retaining the existing
  scope rules for ordinary workspaces and Git repositories.

### Fixed

- Preserved default-chat memory scope when Codex sessions resume from nested
  directories after Backend restarts, and kept CodeBuddy/WorkBuddy CLI memory
  operations associated with the native session.
- Validated the working directory before reusing a General scope without a
  workspace, and allowed the first verified default workspace to complete that
  scope without losing the current Turn's writeback.
- Allowed device-identity lookup up to five seconds during guest setup,
  preventing valid but slower Windows registry queries from timing out.

### Upgrade note

Existing memories under previous default-chat names are not migrated or
searched alongside `General`.

## [0.1.14] - 2026-09-07

### Added

- Added `memorax-code update --recover` to restore and verify the installed
  package after an interrupted package transition.

### Changed

- User Profile operations now use the packaged Node.js runtime instead of
  Python, while preserving the existing preference-file format.

### Fixed

- Preserved native user and assistant timestamps during automatic QA
  writeback, with explicit observed-time fallbacks when native timestamps are
  unavailable. Buffering, chunking, and retries retain these times.
- Preserved message whitespace across writeback chunk boundaries, including
  whitespace-only fragments.
- Restored CodeBuddy/WorkBuddy automatic writeback during cold starts, after
  long tool chains, and when transcripts use Windows CRLF line endings.
- Kept relative MemoraX Code home paths consistent across Backend startup,
  package updates, and background Repo Memory jobs.
- Preserved distinct User Profile preferences with different applicability or
  exceptions, and prevented empty fields from consuming adjacent fields.
- Skipped provider authentication probes during local-only Repo Memory
  collection and rejected failed OpenCode assistant responses instead of
  treating partial output as completed work.
- Preserved newer Trae turns when an earlier Stop finishes late, and refreshed
  managed runtime paths when recovery configuration changes.
- Kept CLI workspace association and interrupted-turn recovery working when
  local trace event capture is disabled.

## [0.1.13] - 2026-09-04

### Added

- Supported coding agents now briefly identify when recalled Memory materially
  shaped the final answer, while omitting the notice for unused or merely
  confirmatory context.

### Fixed

- Recovered abandoned CodeBuddy/WorkBuddy plugin registry locks after
  interrupted lifecycle operations while preserving unrelated plugin entries.
- Fixed Repo Memory workers launched from installed packages so supported
  clients consistently resolve their packaged runtime, including preserving
  the triggering WorkBuddy plugin root.
- Preserved existing Repo Memory long-option compatibility, including
  `--option=value`, during build and update operations.

## [0.1.12] - 2026-09-02

### Added

- Added managed Trae integration with the shared MemoraX Code Skill, native
  lifecycle Hooks, exact Turn correlation, completed-Turn writeback,
  interrupted-Turn handling, Skill reminders, optional automatic retrieval,
  local traces, and supported setup on macOS, Linux, and Windows. Trae users
  enable Global Hooks once in Trae before the integration can run.

### Changed

- Updates now enable a newly supported coding-agent integration when its
  runtime is detected and its client setting was previously absent. Explicit
  enabled and disabled choices remain unchanged; automatic updates reconcile
  silently, while manual updates prompt for unconfigured detected clients.
- Clarified Trae activation guidance with the exact Global Hooks UI path and
  the runtime status check used to confirm that Hooks have been observed.

### Fixed

- Updated Windows PowerShell Skill commands to invoke `memorax-cli.cmd`,
  avoiding `.ps1` execution-policy failures without requiring users to change
  PowerShell policy.

## [0.1.11] - 2026-09-01

### Fixed

- Updated Windows WorkBuddy setup to prefer `%USERPROFILE%\\.workbuddy` for
  new installations while safely reconciling only MemoraX-managed plugin state
  from legacy `%USERPROFILE%\\.codebuddy` homes, preserving unrelated plugins,
  Skills, and user data.

## [0.1.10] - 2026-09-01

### Added

- Added managed CodeBuddy/WorkBuddy integration with native Turn tracking,
  completed-Turn writeback, interrupted-Turn handling, Skill reminders, quota
  notices, Repo Memory maintenance, local traces, and supported setup on
  macOS, Linux, and Windows.
- Added automatic updates owned by the managed Backend. Stable and preview
  installations check their release channel every eight hours, retry failures
  after 15 minutes, install the exact resolved version, reconcile enabled
  clients non-interactively, silently trust verified Codex Hook changes, and
  replace the Backend process without requiring a new client session.

### Fixed

- Completed manual update reconciliation when the managed Backend was already
  stopped, including client integration assets, Codex Hook trust, setup state,
  and Backend recovery.
- Repaired the Windows user `PATH` during interactive setup when npm's global
  command directory is missing, while preserving existing command priority.
- Repaired missing or disabled Codex plugin registrations even when a valid
  versioned plugin cache already exists, preventing the CLI and active Codex
  plugin from remaining on different versions.

### Fixed

- Stopped `memorax-cli` from exiting with a nonzero status on Windows after
  printing complete results by letting the Node process drain naturally
  instead of calling `process.exit()`.

## [0.1.9] - 2026-08-28

### Fixed

- Restored Codex automatic writeback for current rollout transcripts by reading
  authoritative response-item user and final-assistant messages before falling
  back to legacy event messages.
- Rejected response-item messages whose embedded Turn ID conflicts with the
  active Turn, preventing mismatched content from being written to memory.

## [0.1.8] - 2026-08-24

### Added

- Guest quota reminders can now display the matching anonymous identity's
  Mark ID and 90-day guest term, while registered-account reminders remain
  unchanged.

### Changed

- Clarified existing-account setup, 90-day guest mode, guest activation, and
  cross-device configuration reuse in the installation guidance.

### Fixed

- Preserved OpenCode turns across native context compaction so automatic
  writeback uses the original request and final visible reply instead of
  synthetic compaction content.
- Prevented standalone OpenCode Repo Memory initialization from contending
  with the active client's database.

### Removed

- Removed the local Memory Viewer. Memory search, automatic writeback, quota
  reminders, and supported coding-agent integrations remain available.

## [0.1.7] - 2026-08-22

### Fixed

- Prevented a running Backend from blocking subsequent npm package updates on
  Windows.

### Upgrade note

Windows users upgrading from versions 0.1.3 through 0.1.6 should complete this
one-time sequence:

```powershell
memorax-code stop
memorax-code update --latest
memorax-code
```

Later upgrades do not require this workaround.

## [0.1.6] - 2026-08-22

### Added

- Added account-free setup with server-provisioned credentials stored through
  macOS Keychain, Linux Secret Service, or Windows CurrentUser DPAPI. Existing
  MemoraX users can instead run `memorax-code setup --existing-account`.
- Added localized Add and Search quota reminders in Codex, Claude Code, and
  OpenCode, including account activation guidance for anonymous users.
- Added support for DeepSeek Harness Profiles initialized through its official
  `npx` workflow without requiring a global DSH installation.

### Changed

- Adopted the standard `npm install -g @memorax/memorax-code` installation
  command and moved interactive onboarding into `memorax-code setup`.

### Fixed

- Preserved active coding-agent integrations during package replacement and
  migrated configured earlier installations without asking users to re-enter
  their MemoraX configuration.
- Improved Codex detection on Windows when an inaccessible application alias
  appears before a runnable Codex Desktop runtime.

## [0.1.5] - 2026-08-20

### Added

- Added support for Node.js 20 and later while retaining Node.js 24 as the
  recommended runtime.
- Added installation troubleshooting guidance and Discord and WeChat community
  entry points.

### Changed

- Removed the hidden Linux `procps` requirement from Backend process checks.

## [0.1.4] - 2026-08-18

### Fixed

- Enabled Repo Memory initialization in standalone `opencode run` sessions.
- Enabled Repo Memory background work for DeepSeek Harness installations that
  previously had only web Profiles by provisioning the required headless
  Profile.

## [0.1.3] - 2026-08-17

### Added

- Added managed OpenCode integration with automatic memory retrieval and
  writeback, memory reminders, Repo Memory maintenance, diagnostics, Backend
  recovery, and local activity visibility.
- Added managed DeepSeek Harness integration with its native Turn bridge,
  Personal and Repo Memory, restart-safe writeback, and local activity
  visibility.
- Added local redaction of supported secrets and sensitive identifiers before
  explicit and automatic memory Add operations.
- Added wiki-style Repo Memory pages with configurable commit, pull request,
  and issue history collection.

### Changed

- Refined coding-memory queries and Personal and Procedure Memory update and
  deletion behavior so agents preserve user intent and unrelated saved memory.
- Required a non-empty MemoraX user ID and API key during interactive setup,
  with clearer registration guidance.

[0.1.18]: https://www.npmjs.com/package/@memorax/memorax-code/v/0.1.18
[0.1.17]: https://www.npmjs.com/package/@memorax/memorax-code/v/0.1.17
[0.1.15]: https://www.npmjs.com/package/@memorax/memorax-code/v/0.1.15
[0.1.14]: https://www.npmjs.com/package/@memorax/memorax-code/v/0.1.14
[0.1.10]: https://www.npmjs.com/package/@memorax/memorax-code/v/0.1.10
[0.1.9]: https://www.npmjs.com/package/@memorax/memorax-code/v/0.1.9
[0.1.8]: https://www.npmjs.com/package/@memorax/memorax-code/v/0.1.8
[0.1.7]: https://www.npmjs.com/package/@memorax/memorax-code/v/0.1.7
[0.1.6]: https://www.npmjs.com/package/@memorax/memorax-code/v/0.1.6
[0.1.5]: https://www.npmjs.com/package/@memorax/memorax-code/v/0.1.5
[0.1.4]: https://www.npmjs.com/package/@memorax/memorax-code/v/0.1.4
[0.1.3]: https://www.npmjs.com/package/@memorax/memorax-code/v/0.1.3
