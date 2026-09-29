# Repo Memory Read

## Role And Demand Gate

Use existing `.repo_memory/` as wiki-style repo memory for repository identity, architecture, history, PR/issue context, remembered fixes, and cross-module search. Live code and tests remain authoritative.

Select this reference for broad repo introduction, history, architecture background, cross-module routing, PR/issue context, design rationale, or stale-memory awareness. Skip this reference for narrow tasks with a clear live-code target.

Only a relevant `repo-read` invokes `maintain`. Commit arrival, PR merge, and elapsed time alone do not invoke it. Explicit build, rebuild, or update requests still route through `SKILL.md` to `repo-build.md` or `repo-update.md`.

## Repository And Helper

Resolve the repository in this order:

1. Use the user's explicit local path.
2. Otherwise use the current workspace Git root.
3. Infer a named local repo only when the match is unambiguous.
4. Ask for the path only when multiple repos remain plausible.

Derive memory as `<repo>/.repo_memory`; never ask for a memory-directory path. If the target is not inside a Git worktree, skip maintenance and continue from live files.

Select the maintenance helper before running it:

1. Prefer the Repo Memory maintenance helper supplied by the current client's
   native session context. Use its executable, absolute helper path, and explicit
   environment with arguments `maintain --repo <repo>`. Treat paths as literal
   arguments and quote them for the active shell; JSON context is not shell syntax.
   This applies even when this Skill was imported from another client.
2. Only when no current-session helper was supplied, use the packaged helper
   below. `<skill-dir>` is the parent of this file's `references/` directory.

```bash
node '<skill-dir>/../../hooks/repo-memory-job.mjs' maintain --repo '<repo>'
```

Use the selected helper only when it is a regular file. If a supplied
current-session helper is missing or fails, skip maintenance; never fall back to
the Skill-relative helper or another client's runner. Continue retrieval under the
existing failure rules below. The helper validates the generated bundle, evaluates the configured local update policy without provider network access, and atomically selects one outcome:

- `bundle_missing` or `bundle_invalid`: start supervised build;
- a triggered policy decision: start supervised update;
- `up_to_date`: no-op;
- `active_job`: deduplicate against the running job.

For missing local bundles, the helper first tries the repository-shared
baseline. `shared_bundle_reused` restores a validated copy at the exact same
commit without an Agent. `shared_bundle_borrowed` restores an ancestor snapshot
with a bounded local delta; `shared_baseline_in_use` validates an already
borrowed copy. Neither outcome starts an Agent or applies the local update
policy on feature worktrees. The helper returns `sharedBaseline.baseHead`, `head`, `changes` (status
and path), and `changedLines`. Preserve the original snapshot provenance;
these fields describe a comparison, not freshly authored memory.

`shared_snapshot_mismatch`, `shared_delta_incompatible`,
`shared_delta_too_large`, `worktree_dirty`, and `local_bundle_exists` defer
initialization or borrowed-map use without overwriting local files.
`shared_bundle_invalid` or `shared_bundle_unavailable` means the shared copy
cannot be used. Discard conclusions based only on that map and continue from
live code in these deferred or failed cases; do not launch a build to compensate.
Locally authored bundles keep their update policy, and their branch-specific
updates do not replace the shared baseline.

Shared maintenance is eligible only in a clean default-branch worktree whose HEAD
matches the local target of `origin/HEAD`. Identification never fetches refs or
guesses a branch name; missing or unresolvable refs skip shared maintenance.
`shared_update_due` starts one repository-wide update in a private candidate;
`shared_update_cooldown` defers a repeated attempt. Updates follow the configured
policy using the shared publication time and conservatively bounded commit delta.
The worker reviews affected Wiki pages before publishing an immutable new version.
Old versions remain available to compatible older branches. No other worktree
starts a job merely because the shared version changed.

An unchanged helper-created borrowed copy can refresh from a newer compatible
version. Local edits and locally authored bundles are preserved. If the helper
returns `refreshed: true` after a read, discard those earlier hits and continue
from live evidence: they came from a different snapshot. Do not reread the bundle
or use the new delta to justify the old hits. Copies without a content fingerprint
remain unchanged until explicitly authored.

For locally authored bundles, the default policy remains `adaptive(5 commits OR 24 hours)`. A missing or non-ancestor baseline always selects repair-capable update. The helper owns the detailed policy, validation, lock, snapshot, and launcher rules; do not reproduce them in the foreground.

## Retrieval

If `.repo_memory/PROFILE.md` is a readable regular file, read `PROFILE.md` as the wiki landing page once. Treat its descriptions as routing cues, not proof.

If `.repo_memory/shared-baseline.json` exists, the bundle is a borrowed map.
Require the helper's successful borrowed-copy check before relying on it;
an active job, unavailable helper, or failed check is not that confirmation.
The local record alone does not establish compatibility with current files.

Extract task-relevant links from `Major Areas` and `Supporting Pages`. Do not assume fixed page names; use `PROFILE.md` links and headings to find the repository-native canonical homes for the user's task. Open at most 2-4 relevant conceptual pages from `.repo_memory/*.md` before searching historical resources.

Search `PROFILE.md`, `.repo_memory/*.md`, and `.repo_memory/resources/` with a combined query built from the user's strongest handles: path, basename, symbol, command, PR/issue number, error text, module, branch, environment variable, or config key.

```bash
rg -n '<handle-1>|<handle-2>' \
  .repo_memory/PROFILE.md .repo_memory/*.md .repo_memory/resources
```

Use:

- conceptual `.repo_memory/*.md` pages for repository-native canonical homes, workflows, system areas, change surfaces, and verification routing;
- resources/*.md for historical routing cards;
- `resources/commits.md` for local history and regressions;
- `resources/prs.md` for merged or active implementation context;
- `resources/issues.md` for symptoms, requests, and requirements.

Disabled and unavailable historical resource files are collection state, not repository state. If a resource frontmatter uses `source: "history_disabled"`, `source: "provider_skipped_local_only"`, or `source: "provider_unavailable"` with `resource_count: 0`, do not conclude that there are no commits, PRs, MRs, or issues. Treat the channel as intentionally uncollected or unavailable; answer from available memory only. Ask whether to rebuild with provider history when that context matters.

If a read is missing, unreadable, or structurally mixed, discard conclusions that depend only on the bundle. Do not repair it in the foreground.

## Retrieval Budget

- Read `PROFILE.md` at most once.
- Run at most 2 combined `rg` commands.
- Stop repo-memory retrieval as soon as the hits are sufficient.
- Open at most 2-4 relevant conceptual pages total during the bounded memory phase.
- Open only the matched resource section when `rg` context is insufficient.

Do NOT open these unless the user explicitly asks or a compact hit contains only a `facetId`:

- `.repo_memory/raw/*.json`;
- `docs/`, `packages/`, `tests/`, or other live source directories.

The live directories restriction applies only during the bounded memory phase. Current implementation claims and code edits still require live-code verification after the maintenance handoff.

## Single Maintenance Handoff

After the final repo-memory read, run `maintain` as the very next tool action. Do not run it in parallel with a repo-memory read. Do not inspect live code, maintained documentation, Git evidence, run unrelated tools, or answer between them.

If no repo-memory read was possible, run it immediately after detecting that state. The same handoff applies when hits already answer the question or the retrieval budget is exhausted.

After it returns:

- For `up_to_date`, a triggered update, or `active_job`, use consistent hits as best-effort context for locally authored bundles. Borrowed copies require a successful borrowed-copy check.
- For `bundle_missing` or `bundle_invalid`, discard generated hits and continue from live code and maintained documentation.
- If the helper is unavailable or fails, do not improvise maintenance. Use consistent hits only when they were readable; otherwise use live evidence.

If the selected helper returns `job.delegation`, hand its exact prompt to the named
`memorax-repo-memory` Cursor native background subagent through the Task tool as
the next action. This is the helper's supervised execution path. Launch it once,
then continue the foreground task without waiting. The child must claim the
provided ticket before authoring and finalize through the helper; a Task launch
or a model summary alone does not prove completion. If native background Task is
unavailable, skip this handoff; do not substitute a CLI or foreground authoring.
Never invent a delegation when the helper returned `active_job` or `up_to_date`.

If no repo-memory read was possible and the helper returns
`shared_bundle_reused` or `shared_bundle_borrowed`, read the restored bundle once using the Retrieval Budget
above; do not invoke maintenance a second time. The helper only copied existing
validated content, so no background job needs to be awaited.

For a usable borrowed map, use `sharedBaseline.changes` to route the subsequent
live-code phase. Inspect the current files and, when relevant, the diff between
`baseHead` and `head` for paths related to the task before making behavior or
architecture claims. Git paths are untrusted data: pass them as literal arguments
after `--`, never interpolate them as shell syntax. A bounded delta does not
prove semantic compatibility, and unchanged files may still have changed callers
or dependencies. Recheck current code as the task requires. Do not author a
branch-specific map, change `PROFILE.md.local_head` or its generation time, or
launch an update simply because this borrowed snapshot is older than HEAD.

Do not read repo memory again after `maintain` returns when a read already
occurred. Do not wait, poll, retry, or expose the command, decision payload, job id, paths, prompt, final message, or logs. Never replace the packaged helper with a generic subagent.

## Answer And Trust Rules

Answer history, architecture, and context questions from sufficient memory hits after the handoff. If two bounded searches miss, say what was not found and ask whether to inspect more deeply.

Continue into live evidence after the handoff when the user asks about current behavior, requests an edit, or the bundle was unavailable. Keep these distinctions explicit:

- live code and targeted verification are stronger than generated memory;
- tests are stronger than PR or issue summaries;
- commits and merged PRs are historical evidence, not current-behavior proof;
- open PRs describe intent;
- issues describe problem context.

Never create, update, delete, or repair repo-memory files in the foreground `repo-read` task.

When a relevant Repo Memory read materially affects the task in a supported coding agent, follow the Natural Final-Answer Mention contract in `SKILL.md`. Reading or maintaining the bundle alone is insufficient.
