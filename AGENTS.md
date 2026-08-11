# MemoraX Code Agent Guide

This file defines the durable working rules for coding agents in this
repository. Current user instructions, live source, and executable tests take
precedence over generated memory or historical context.

## 1. Start Safely

- Run `git status --short --branch` before editing. Confirm the intended
  worktree and preserve unrelated tracked, untracked, and staged changes.
- Read the nearest implementation and tests before changing behavior. Prefer a
  small, layered change with an explicit verification target.
- Do not mix unrelated formatting, renaming, dependency updates, or lockfile
  rewrites into the task. Do not run broad auto-fix commands unless required.
- Use English for source identifiers, comments, docstrings, and canonical
  public documentation. Keep `README.md` and `README.zh.md` synchronized for
  user-facing changes.
- Treat `.repo_memory/` as local retrieval guidance, not current-code
  authority. It is Git-ignored and must not leak into public artifacts.
- Use isolated `MEMORAX_CODE_HOME`, `CODEX_HOME`, and `CLAUDE_CONFIG_DIR`
  locations for lifecycle, install, migration, or destructive tests.

## 2. Architecture Routing

[ARCHITECTURE.md](ARCHITECTURE.md) is the canonical map for system shape,
package ownership, runtime flows, Backend source and test placement, dependency
direction, stable root surfaces, and executable architecture contracts.

Read it before adding or moving modules or tests, changing entrypoints,
control/data flow, state or authority, packaging/materialization, or
cross-package or cross-capability dependencies.

Preserve the documented boundaries. When an intentional architecture change is
required, update `ARCHITECTURE.md` and the affected executable contract in the
same change, then run the matching verification profile in Section 5.

## 3. Hook, Session, and Scope Invariants

- Hook commands are versioned and client-qualified. Required session, turn, or
  prompt correlation must be validated at the HTTP boundary; incomplete,
  conflicting, unknown, or client-inapplicable identities fail closed.
- Codex rollout JSONL and Claude Code transcript JSONL are the only content
  authorities for their respective automatic writeback. Hook text, local
  trace, latest-turn guesses, or the other client's format are not fallbacks.
- Session, turn metadata, trace, and operational identity always include the
  client. Equal native IDs from different clients must remain isolated.
- A live session is pinned to its resolved workspace and repository scope.
  Linked worktrees of one repository may share repository scope; unrelated
  repositories and genuine non-Git workspaces keep separate local identity.
  The documented direct-`.git` exception may use local-folder scope when its
  internal metadata is malformed or incomplete, then upgrade in-session only
  to verified Git scope for the same Base User ID and canonical workspace
  root. Discard pending fallback writeback during that upgrade. Missing,
  unreadable, malformed, or conflicting scope authority outside this narrow
  exception must not silently fall back or rebind.
- Repository resolution is read-only and must not execute Git merely to derive
  memory identity. Preserve path canonicalization, Git marker validation,
  symlink/junction containment, and fail-closed behavior.
- Consume turn metadata only after the matching downstream operation is
  accepted. Rejection, missing content, interruption, or concurrent
  replacement must retain or discard metadata with an explicit reason.
- Backend connection, token, PID, Hook generation, and lifecycle authority use
  versioned private records. Cross-process read/modify/write requires bounded
  locking or equivalent version validation; in-memory serialization is not
  sufficient.
- Keep the default Backend on loopback. External binding requires explicit
  opt-in and authentication.

## 4. Data and User-Facing Boundaries

- Never log, commit, or publish provider or MemoraX credentials, Backend
  tokens, Authorization headers, private transcripts, raw rollout data,
  retained trace files, personal memory, or user absolute paths.
- MemoraX receives only documented query/add/writeback payloads. Retained
  trace artifacts, trace-only provenance, and local transcript paths stay
  local.
- Memory Viewer is a content-free local projection, not memory, transcript,
  session, or lifecycle authority.
- `memorax-code` is the shared user-facing skill. Changes must work in Codex,
  Claude Code, and OpenCode packaging and must keep triggers, metadata,
  references, and resource paths valid.
- Packaged skills must address product users. Do not include maintainer
  runbooks, private paths, unpublished plans, secrets, internal fixtures, or
  local diagnostic artifacts.
- Public commands, requirements, data handling, or client support changes
  update both README files. Configuration changes update
  `docs/configuration.md`; user-facing diagnosis updates
  `docs/troubleshooting.md`; vulnerability and trust-boundary changes update
  `SECURITY.md`.

## 5. Verification

Run the smallest relevant check first, then expand when a change crosses
boundaries:

- **Backend**: `npm run typecheck --prefix packages/ts/memorax-code-backend` and
  `npm test --prefix packages/ts/memorax-code-backend`.
- **Codex**: `npm test --prefix packages/ts/memorax-code-codex-adapter`.
- **Claude Code**:
  `npm test --prefix packages/ts/memorax-code-claude-adapter`.
- **OpenCode**:
  `npm test --prefix packages/ts/memorax-code-opencode-adapter`.
- **Adapter-common/shared Hook**: `adapter-common` has no standalone suite. Run
  affected Backend tests and all three adapter suites; add
  `make npm-package-check` when staged runtime or package layout changes.
- **Trace/local-only boundary**: for trace, provider, or outbound transport,
  run `make test-npm-package` in addition to affected package tests.
- **Documentation**: `make docs-check`.
- **Install/artifacts**: for install, update, uninstall, CLI, or artifacts, run
  `make npm-package-check`.
- **Broad cross-layer**: `make test`.

If the change edits tracked documentation, also run the **Documentation**
profile even when another profile applies.

Real-client and MemoraX-backed checks are explicit opt-in tests. Keep their
credentials and artifacts outside Git and redact results before sharing.

## 6. Git and Handoff

- Name branches for the change with `feat/`, `fix/`, `refactor/`, `docs/`,
  `test/`, or `chore/` plus lowercase kebab-case. Do not use agent-specific
  prefixes.
- Use commit titles in the form `type:(module) content`. Separate mechanical
  formatting from behavior changes.
- Do not amend, rebase, force-push, or rewrite another contributor's history
  without explicit authorization.
- Do not commit `dist/`, build output, package staging, dependency graphs,
  metrics, trace/report bundles, or temporary test artifacts.
- In the handoff, report changed behavior, verification performed, checks not
  run, remaining risk, and worktree state. Push only when explicitly asked.
