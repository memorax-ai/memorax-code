# Changelog

This file records notable user-facing changes to MemoraX Code. Internal
refactors and test-only changes are omitted unless they affect product
behavior.

## Unreleased

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

[0.1.10]: https://www.npmjs.com/package/@memorax/memorax-code/v/0.1.10
[0.1.9]: https://www.npmjs.com/package/@memorax/memorax-code/v/0.1.9
[0.1.8]: https://www.npmjs.com/package/@memorax/memorax-code/v/0.1.8
[0.1.7]: https://www.npmjs.com/package/@memorax/memorax-code/v/0.1.7
[0.1.6]: https://www.npmjs.com/package/@memorax/memorax-code/v/0.1.6
[0.1.5]: https://www.npmjs.com/package/@memorax/memorax-code/v/0.1.5
[0.1.4]: https://www.npmjs.com/package/@memorax/memorax-code/v/0.1.4
[0.1.3]: https://www.npmjs.com/package/@memorax/memorax-code/v/0.1.3
