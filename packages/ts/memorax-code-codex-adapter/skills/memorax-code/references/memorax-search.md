# MemoraX Code Coding Memory Search

Use these instructions only to search reusable coding memory through `memorax-cli`. Invoke the skill as `$memorax-code` in Codex or `/memorax-code` in Claude Code. In OpenCode, ask the agent to use the `memorax-code` skill by name. Do not route memory operations through the lifecycle-only `memorax-code` CLI. Do not call MemoraX HTTP endpoints directly, print credentials, or edit memory storage by hand.

## Scope

Run the CLI from the active task workspace. The installed Hook and session binding supply the authoritative workspace root; do not run `git rev-parse`, infer the root from Git metadata, or substitute an unrelated working directory. Do not make `memorax-cli status` a mandatory preflight; use it only to diagnose a configuration or scope failure.

Coding memory uses `<MemoraX base user ID>@<normalized repository name>` for Git workspaces and the normalized folder name for genuine non-Git directories. MemoraX Code resolves `.git`, `gitdir`, and `commondir` without executing Git. Linked worktrees share one repository scope; another clone, repository, or non-Git directory retains a different local session key even when its readable name matches.

If a successful Search result reports `workspaceScopeFallbackReason: git_metadata_invalid`, malformed or incomplete metadata inside a direct `.git` directory was downgraded to the normalized local folder scope. Search has already run with the reported `effectiveUserId`. Present its `userNotice` once without pausing the current task or asking the user to repair Git first, then continue with the returned memory and live evidence. After the repository or `.git` metadata is repaired, later Search, Add, and automatic writeback in the same client session automatically use the restored Git repository scope.

Require a readable active workspace binding. A CLI command from a linked worktree of the bound repository is valid. If `memorax-cli search` reports `workspace_scope_mismatch` or `workspace_scope_unavailable`, do not bypass the scope or fall back to an unscoped user id. Do not change the CLI working directory and retry. Tell the user that memory search was not executed and no request was sent to MemoraX, then present the CLI's `userAction` in natural language. Continue the current task using only live code and documentation.

If `memorax-cli` is not on `PATH`, or memory is disabled, unconfigured, or unavailable, report that briefly and continue with live code or documentation. Authenticate through MemoraX Code configuration; never recover credentials from shell history or place tokens in prompts. Treat injected memory as a hypothesis and verify it against the current checkout.

## Search Decision

Search when prior coding memory may change localization, implementation, review, validation, or explanation. Typical triggers include:

- a request for a previous fix, failed approach, coding convention, design decision, or reusable lesson;
- implementation, review, planning, API, schema, parser, workflow-contract, or migration work where prior project guidance may matter;
- explicit instructions to follow previous agreements or remembered engineering conventions.

Skip search for simple current-code facts, tiny edits, typo fixes, one-shot commands, or behavior directly established by a clear live source.

Choose the closest coding scene to shape the query:

- **Development:** implementation, debugging, refactoring, test repair, build failures, feature work, API design, or migration planning.
- **Review:** diff, commit, PR, patch, audit, risk assessment, or review-comment handling.
- **Understanding:** implementation location, module explanation, architecture rationale, or repository comprehension when repo memory is not the requested authority.

If the user asks for commit, PR, MR, issue, or repository architecture evidence, return to `SKILL.md` and route to repo memory instead.

## Query Workflow

Run at most one focused search before answering or editing. A development task may run one additional materially different search only after a failed test or dead-end investigation.

Write each query as one short natural-language question or intent statement, not a keyword list. Derive it from the user's retrieval goal instead of copying or concatenating nouns from the prompt. Follow the user's language for the prose while preserving exact code, API, path, workflow, and project identifiers. State what prior knowledge is needed and the relationship, decision, constraint, behavior, or risk being investigated. Include 2-5 stable exact identifiers when they are relevant and known, but integrate them grammatically instead of appending search tags or filler.

Pass the query directly with `--query`. Put every dynamically generated query in single quotes, never double quotes. Treat `$HOME`, backticks, and `$(command)` as literal text inside those quotes. Replace each literal single quote in the value with the exact POSIX sequence `'\''`.

For example:

```bash
memorax-cli search --query 'What prior decisions define the memorax-code parser API failure boundary for malformed input?'
memorax-cli search --query 'What prior review policies and regression risks apply to the memorax-code parser API cleanup boundary?'
memorax-cli search --query 'memorax-code 中 Backend、Codex adapter 与 memory 层的职责如何衔接，之前为什么这样划分？'
```

Keep queries under 25 words when practical for the language, but do not shorten them into ungrammatical fragments. Exclude secrets, private URLs, full prompts, raw transcripts, copied files, long logs, stack traces, and one-off task details.

Read or summarize at most two relevant items. Prefer memories matching the current repository, module, API, lifecycle surface, ownership boundary, behavior, and failure mode. Treat verified memories as routing and validation hints, not patch recipes. Treat failed-attempt memories as negative evidence. Ignore stale or unrelated items and anything conflicting with current source, tests, or durable documentation.

## Transport Failures

If search fails with `fetch failed`, `This operation was aborted`, a timeout, DNS failure, `ENOTFOUND`, `EAI_AGAIN`, or a similar transport or sandbox error, retry the same `memorax-cli search` once in an approved network-enabled execution mode when one is available. Preserve the same query, workspace, and environment variables.

Do not apply this retry to `memorax-cli add`, authentication or configuration failures, or HTTP errors. If no approved mode is available or the one retry fails, report the exact CLI failure and continue with live evidence. Do not interpret a transport failure as an empty result, bypass the CLI, or call MemoraX directly.

## Output

Mention only an invariant, pitfall, convention, or validation idea that materially affects the answer. Ground claims about current implementation behavior in live code and checks.
