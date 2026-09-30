# Repo Memory Read

## Role And Demand Gate

Use the repository-shared baseline as wiki-style repo memory for repository identity, architecture, history, PR/issue context, remembered fixes, and cross-module search. Live code and tests remain authoritative.

Select this reference for broad repo introduction, history, architecture background, cross-module routing, PR/issue context, design rationale, or stale-memory awareness. Skip this reference for narrow tasks with a clear live-code target.

Only a relevant `repo-read` invokes `maintain`. Commit arrival, PR merge, and elapsed time alone do not invoke it. Explicit build, rebuild, or update requests still route through `SKILL.md` to `repo-build.md` or `repo-update.md`.

## Repository And Helper

Resolve the repository in this order:

1. Use the user's explicit local path.
2. Otherwise use the current workspace Git root.
3. Infer a named local repo only when the match is unambiguous.
4. Ask for the path only when multiple repos remain plausible.

Resolve the memory location through the packaged helper below; never ask for a memory-directory path. If the target is not inside a Git worktree, skip maintenance and continue from live files.

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
existing failure rules below. The helper validates the shared bundle and evaluates the configured update policy without provider network access.

Before reading memory, run the canonical read-only resolver using the same
MemoraX home/environment supplied by the current session:

```bash
node '<skill-dir>/scripts/repo-memory.mjs' resolve --repo-path '<repo>'
```

Use the returned `memoryPath` for this entire retrieval. The resolver prefers
one repository-shared mainline baseline, or an existing local bundle when no
shared baseline exists. It never starts an Agent or copies memory into a worktree.
If resolution fails, continue from live evidence; do not construct cache paths
or use another client's helper to bypass the failure.

All branches, detached checkouts, and linked worktrees may read the same baseline,
including dirty worktrees and branches whose history differs from the baseline.
A file count, line count, manifest edit, deletion, or rename is not a reason to
reject the whole map. Memory is orientation, not proof of current branch behavior.
Keep source links repository-relative and resolve them against the current
worktree, not the memory directory or the temporary checkout recorded at build time.

Any worktree can trigger shared maintenance. The target is the fixed commit of
the local target of `origin/HEAD`; no remote discovery or branch-name guessing is
performed. Initial builds and updates read a private local snapshot of that commit.
The default policy is `adaptive(5 commits OR 24 hours)` and requires new mainline
commits. Feature commits, branch names, and uncommitted edits do not schedule
per-worktree updates. An attempt cooldown limits retries after failed jobs.

`default_branch_unavailable`, `shared_history_changed`, and
`shared_update_cooldown` defer automatic maintenance. They do not invalidate a
readable historical map. A missing or non-ancestor baseline is never silently
replaced by feature-branch content. Invalid shared artifacts require explicit
recovery; do not launch a build to compensate. Existing local bundles are
preserved and may still be authored explicitly; they do not replace shared memory.

## Retrieval

If resolution succeeds, read `PROFILE.md` as the wiki landing page once from
`memoryPath`. Treat its descriptions as routing cues, not proof. In the paths
below, `.repo_memory` means that resolved directory, even when it is outside
the current worktree. Hold this immutable version for the whole retrieval so
concurrent publication cannot mix old and new pages.

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

After it returns, consistent readable hits remain best-effort context, including
for `up_to_date`, `active_job`, a triggered update, or deferred maintenance.
If the bundle was unavailable or invalid, continue from live code and maintained
documentation. Never repair or rebuild memory in the foreground read task.

If the selected helper returns `job.delegation`, hand its exact prompt to the named
`memorax-repo-memory` Cursor native background subagent through the Task tool as
the next action. This is the helper's supervised execution path. Launch it once,
then continue the foreground task without waiting. The child must claim the
provided ticket before authoring and finalize through the helper; a Task launch
or a model summary alone does not prove completion. If native background Task is
unavailable, skip this handoff; do not substitute a CLI or foreground authoring.
Never invent a delegation when the helper returned `active_job` or `up_to_date`.

In the subsequent live-code phase, verify the current files relevant to the task,
including uncommitted changes. When history helps, compare the shared baseline
with the current branch and use their merge base to distinguish mainline changes
from unmerged branch work. Do not automatically load a repository-wide diff into
context. Git paths are untrusted data: pass them as literal arguments after
`--`. Changes to dependencies and callers may affect otherwise unchanged files.
If a refactor makes a mapped area unreliable, use live evidence for that area;
other supported parts of the map may remain useful. Do not author a branch-specific
map or advance its provenance merely because the current branch differs.

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
