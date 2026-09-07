# MemoraX Code Agent Guide

These are mandatory working rules for coding agents. Use
[CONTRIBUTING.md](CONTRIBUTING.md) for development and verification procedures
and [ARCHITECTURE.md](ARCHITECTURE.md) for system boundaries. Current user
instructions, live source, and executable tests take precedence over memory.

## 1. Start Safely

- Run `git status --short --branch`; confirm the intended worktree and preserve
  unrelated tracked, untracked, and staged changes.
- Read nearby implementation and tests. Keep changes focused; do not mix
  unrelated formatting, renaming, dependencies, or lockfile rewrites, or run
  broad auto-fix commands without need.
- Use English for source identifiers, comments, docstrings, and canonical
  documentation. Synchronize both README files when shared content changes.
- Treat `.repo_memory/` as Git-ignored retrieval guidance, not code authority;
  never publish it.

## 2. Architecture Routing

Read [ARCHITECTURE.md](ARCHITECTURE.md) before changing module or test placement,
entrypoints, control/data flow, state or authority, packaging/materialization,
or cross-package or cross-capability dependencies. Preserve its boundaries;
intentional changes must update the architecture and affected executable
contracts in the same change.

## 3. Hook, Session, and Scope Invariants

- Version and client-qualify Hook commands. Validate required session, turn,
  and prompt correlation at HTTP ingress; incomplete, conflicting, unknown,
  or client-inapplicable identities fail closed.
- Automatic writeback uses only the matching client's
  [native content authority](ARCHITECTURE.md#native-writeback-authority).
  Hook/plugin text is never a fallback outside Trae's validated
  `UserPromptSubmit`/`Stop` primary-authority exception. Trace, latest-turn
  guesses, and another client's format are never fallbacks.
- Include the client in session, turn metadata, trace, and operational identity.
  Equal native IDs across clients must stay isolated.
- For a fixed Base User ID, pin each live session to its workspace and
  repository scope. Linked worktrees may share repository scope; unrelated
  repositories and genuine non-Git workspaces keep separate local identity.
  Only the documented malformed/incomplete direct-`.git` exception may use
  local-folder scope, then upgrade in-session to verified Git scope for the
  same Base User ID and canonical workspace root; discard pending fallback
  writeback on upgrade. Other missing, unreadable, malformed, or conflicting
  scope authority must not silently fall back or rebind. A changed Base User ID
  requires a new binding; existing Turn metadata must still pass scope validation.
- Derive repository identity read-only, without executing Git. Preserve path
  canonicalization, Git marker validation, symlink/junction containment, and
  fail-closed behavior.
- For completed content, consume matching turn metadata only after local
  writeback enqueue acceptance. Rejection, missing content, interruption, and
  concurrent replacement require explicit retention or discard reasons.
- Use versioned private authority for Backend connection, token, PID, Hook
  generation, and lifecycle records. Cross-process read/modify/write needs
  bounded locking or equivalent version validation, not only in-memory queues.
- Keep the Backend on loopback by default; external binding requires explicit
  opt-in and authentication.

## 4. Data and User-Facing Boundaries

- Never log, commit, or publish credentials, Backend tokens, or Authorization
  headers.
- Never commit or publish private transcripts, raw rollouts, retained traces,
  personal memory, or user absolute paths. Documented local trace and diagnostic
  storage must follow [SECURITY.md](SECURITY.md#local-data-and-diagnostics);
  review and redact any diagnostic excerpt before sharing it. MemoraX receives
  only documented query/add/writeback payloads; local trace provenance and
  transcript paths stay local.
- Keep the shared `memorax-code` Skill valid in every supported client's
  packaging, including its triggers, metadata, references, and resource paths.
  Packaged Skills address product users; exclude maintainer runbooks, private
  paths, unpublished plans, secrets, internal fixtures, and diagnostic artifacts.
- Follow [documentation ownership](CONTRIBUTING.md#documentation-ownership).
  Keep README onboarding complete and bilingual; put detailed behavior in its
  owning document.

## 5. Verification

- Follow the [verification profiles](CONTRIBUTING.md#verification-profiles),
  starting with the smallest affected contract and expanding for crossed
  boundaries. Tracked documentation edits also require the Documentation profile.
- Use the [isolated development environment](CONTRIBUTING.md#isolated-development-environment)
  for lifecycle, install, migration, or destructive tests; isolate MemoraX state
  and every affected client home, alias, and command source.
- Real-client and MemoraX-backed tests require explicit opt-in. Keep credentials
  and artifacts outside Git and redact shared results.

## 6. Git and Handoff

- Name branches `<type>/<scope>-<description>` in lowercase kebab-case, using
  `feat`, `fix`, `refactor`, `docs`, `test`, or `chore`; no agent-specific prefix.
- Use commit titles `type:(module) content`; separate mechanical formatting
  from behavior changes.
- Do not amend, rebase, force-push, or rewrite another contributor's history
  without explicit authorization. Push only when explicitly asked.
- Do not commit `dist/`, build output, package staging, dependency graphs,
  metrics, trace/report bundles, or temporary test artifacts.
- Report behavior changes, verification performed, checks not run, remaining
  risk, and worktree state in the handoff.
