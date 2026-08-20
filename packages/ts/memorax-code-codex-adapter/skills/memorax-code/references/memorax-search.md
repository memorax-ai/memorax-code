# MemoraX Code Coding Memory Search

Use these instructions only to search reusable coding memory through `memorax-cli`. Invoke the skill as `$memorax-code` in Codex or `/memorax-code` in Claude Code. In OpenCode, ask the agent to use the `memorax-code` skill by name. Do not route memory operations through the lifecycle-only `memorax-code` CLI. Do not call MemoraX HTTP endpoints directly, print credentials, or edit memory storage by hand.

## Scope

Run the CLI from the active task workspace. The installed Hook and session binding supply the authoritative workspace root; do not run `git rev-parse`, infer the root from Git metadata, or substitute an unrelated working directory. Do not make `memorax-cli status` a mandatory preflight; use it only to diagnose a configuration or scope failure.

Coding memory uses `<MemoraX base username>@<normalized repository name>` for Git workspaces and the normalized folder name for genuine non-Git directories. MemoraX Code resolves `.git`, `gitdir`, and `commondir` without executing Git. Linked worktrees share one repository scope; another clone, repository, or non-Git directory retains a different local session key even when its readable name matches.

If a successful Search result reports `workspaceScopeFallbackReason: git_metadata_invalid`, malformed or incomplete metadata inside a direct `.git` directory was downgraded to the normalized local folder scope. Search has already run with the reported `effectiveUserId`. Present its `userNotice` once without pausing the current task or asking the user to repair Git first, then continue with the returned memory and live evidence. After the repository or `.git` metadata is repaired, later Search, Add, and automatic writeback in the same client session automatically use the restored Git repository scope.

Require a readable active workspace binding. A CLI command from a linked worktree of the bound repository is valid. If `memorax-cli search` reports `workspace_scope_mismatch` or `workspace_scope_unavailable`, do not bypass the scope or fall back to an unscoped username. Do not change the CLI working directory and retry. Tell the user that memory search was not executed and no request was sent to MemoraX, then present the CLI's `userAction` in natural language. Continue the current task using only live code and documentation.

If `memorax-cli` is not on `PATH`, or memory is disabled, unconfigured, or unavailable, report that briefly and continue with live code or documentation. Authenticate through MemoraX Code configuration; never recover credentials from shell history or place tokens in prompts. Treat injected memory as a hypothesis and verify it against the current checkout.

## Search Decision

Search when prior coding memory may change localization, implementation, review, validation, or explanation. Typical triggers include:

- a request for a previous fix, failed approach, coding convention, design decision, or reusable lesson;
- implementation, review, planning, API, schema, parser, workflow-contract, or migration work where prior project guidance may matter;
- explicit instructions to follow previous agreements or remembered engineering conventions.
- a request to recover, verify, or apply prior project discussions, experiment results, saved memory, earlier decisions, previous changes, or historical constraints, unless the needed facts are fully present in the current visible context.
- a requested action that depends on prior project state, results, fixes, constraints, or plans when the exact evidence needed is not explicitly present in the current user-provided material.

Skip search for simple current-code facts, tiny edits, typo fixes, one-shot commands, or behavior directly established by a clear live source. Do not skip merely by saying the current conversation is sufficient or a relevant result was already retrieved; skip only when the current user message, selected text, or nearby visible context fully contains the facts needed for the answer. A nearby summary is sufficient for explaining that summary, but not automatically sufficient for diagnosing a regression, continuing an experiment, reviewing consistency with prior behavior, or claiming a complete historical account. A word such as "previous", "earlier", "remember", or "history" is not enough by itself to search when the visible context already contains the requested prior facts.

Do not search merely because a prior result or fix might exist. For an exact calculation from currently available data, or a current screenshot or reproducible symptom with sufficient live evidence, use the current evidence first. Search only when the user request or visible context establishes a concrete historical dependency.

Choose the closest coding scene to shape the query:

- **Development:** implementation, debugging, refactoring, test repair, build failures, feature work, API design, or migration planning.
- **Review:** diff, commit, PR, patch, audit, risk assessment, or review-comment handling.
- **Understanding:** implementation location, module explanation, architecture rationale, or repository comprehension when repo memory is not the requested authority.

If the user asks for commit, PR, MR, issue, or repository architecture evidence, return to `SKILL.md` and route to repo memory instead.

## Query Workflow

Before searching, identify the user's current action, target, concrete behavior or symptom, and the historical knowledge that could change the next action. When the request is fragmented, derive one narrow working intent from only its explicit target, condition, and requested or implied outcome. Do not add generic security, authorization, concurrency, auditing, reliability, or best-practice concerns unless the request names that boundary or it is necessary to resolve the working intent. Ask one focused question when no actionable intent can be named.

Run up to two focused first-round searches before answering or editing: a primary query for the smallest user-facing decision, and a materially different complementary query only when a second independent fact can change the action. Keep one query when the request describes one strongly coupled calculation, diagnosis, ownership question, or lifecycle decision; do not split it merely to create coverage. Run independent first-round searches in parallel by default. If parallel execution encounters a transport, rate-limit, or caller-environment failure, run any remaining searches serially; do not switch solely because a successful search returns an unexpected number of items. After merging the first-round results, run at most one follow-up query only when one named residual gap can change implementation, localization, risk, or validation. Do not use the follow-up merely because results are few, generic, or incomplete.

Write each query as one short natural-language question or intent statement, not a keyword list. Derive it from the user's retrieval goal instead of copying or concatenating nouns from the prompt. Follow the user's language for the prose while preserving exact code, API, path, workflow, and project identifiers. Retain at least one distinctive noun phrase from the user's wording as an anchor, together with any explicit negation, time/order, quantity, or scope qualifier. Also retain one stable task entity explicitly established by the current conversation or live code/documentation when it is needed to resolve that anchor or make the target decidable; do not drop it merely because it is absent from the newest fragmented user message. Do not replace an anchor or stable entity with a more abstract mechanism, a more specific implementation guess, or an unverified term. Preserve whether a retained detail is an observed symptom, desired outcome, disputed field or hypothesis, or explicit exclusion; do not turn an observation into a required invariant or replace a named disputed field with a generic reference.

Preserve the user's requested answer shape as well as the target: for example, whether a value was introduced by a prior code change, which failed experiments require rerun, how a negative case differs, what source boundary applies, or which existing plan remains current. Encode an explicit exclusion, source boundary, or qualifier such as only, previous, failed, negative, not, latest, or before/after when it changes the answer. Do not turn an imperative, URL, copied log, or full task request into the query verbatim; extract the smallest reusable historical fact that could change the next action. When the user explicitly names several independent deliverables and their respective historical facts could change different next actions, use the existing two-query allowance for complementary coverage: let the primary query cover the central implementation or decision, and let the complementary query cover the separate validation, artifact, reporting, or boundary question. Do not split one tightly coupled task or create a second query merely to enumerate every noun.

State a fact-sized relationship that can change the next action: a target under a condition, and the decision, invariant, consequence, root cause, ownership, compatibility, validation question, or requested answer at issue. For behavior, data, and lifecycle work, every query must use this visible shape: `<target>: <condition>，<decision / invariant / consequence / validation question>?`. Keep the colon in both Chinese and English so the target, condition, and decision boundary remain explicit. Do not emit a generic topic, a keyword list, a label such as `primary query`, or an explanation around the query.

For a complementary first-round pair, each query must stand alone and cover a different decision boundary. Use a complementary pair only when the provided context gives each decision boundary a distinct exact code, API, path, workflow, or project identifier; otherwise keep one focused combined query that preserves both user-stated facts. Do not merely restate the same question with synonyms. If the user describes only one tightly coupled decision, emit exactly one query. Use one or two stable exact identifiers when they sharpen the query, and integrate them grammatically instead of appending search tags or filler. Use only user-provided anchors and stable terms from live code or documentation; do not reconstruct unseen fact wording from recalled memory.

Pass the query directly with `--query`. Put every dynamically generated query in single quotes, never double quotes. Treat `$HOME`, backticks, and `$(command)` as literal text inside those quotes. Replace each literal single quote in the value with the exact POSIX sequence `'\''`.

Use these actual output shapes as examples. They are queries themselves, not full user prompts or instructions for the user. Each Chinese/English pair is a language variant: choose the one matching the user, never run both merely because both are shown. The comments explain the example only and are not part of emitted query text.

```bash
# One tightly coupled decision: emit one query.
memorax-cli search --query 'Trace 生产版本：升级后到达的记录中，应以哪个客户端版本字段判断由旧插件产生，而非新版本上传进程？'
memorax-cli search --query 'Trace producer version: after an upgrade, which client-version field shows that an event came from the old plugin rather than the new uploader?'

# Two independent boundaries: emit a complementary pair.
memorax-cli search --query '任务上下文：升级新包后已打开任务仍按旧提示，是否绑定旧版本且必须新开对话？'
memorax-cli search --query '包缓存版本冲突：本地新包与缓存冲突时，已打开任务为何仍使用旧提示，如何确认实际加载版本？'
memorax-cli search --query 'Task context after upgrade: can an already-open task keep old injected context, and must validation use a fresh task?'
memorax-cli search --query 'Package-cache version collision: how do we confirm which version the active task actually loaded?'

# Preserve an explicit lifecycle condition and the required invariant.
memorax-cli search --query '自动写回：事件回调不等待 Promise 时，如何在消息终态后执行并防止重复？'
memorax-cli search --query 'Automatic writeback: when an event callback does not await a Promise, how should it run after message terminal state without duplicates?'

# Preserve a source boundary rather than turning it into a generic SDK question.
memorax-cli search --query '桌面 SDK 数据权威：无原生命令行时，应从哪些规范化消息和会话生命周期事件获取数据？'
memorax-cli search --query 'Desktop SDK authority: without a native CLI, which normalized messages and session lifecycle events are authoritative?'
```

Keep queries under 25 words when practical for the language, but do not shorten them into ungrammatical fragments. Exclude secrets, private URLs, full prompts, raw transcripts, copied files, long logs, stack traces, and one-off task details.

Do not use abstract query facets such as "state", "fix", "safety", or "best practice" unless they are the concrete target. Do not use generic security or safety queries as complementary queries; bind every query to an exact target, condition, and behavior boundary.

Merge and deduplicate first-round results by item identity when available, otherwise by matching scope, condition, claim, and consequence. Accept a memory only when all three checks pass: it has the same component, API, workflow, or ownership boundary; it has the same behavior, symptom, condition, or change; and it supplies a condition, conclusion, consequence, fix, or validation idea that can change the current action. Read or summarize at most two accepted direct hits. Prefer memories matching the current repository, module, API, lifecycle surface, ownership boundary, behavior, and failure mode. Treat verified memories as routing and validation hints, not patch recipes. Treat failed-attempt memories as negative evidence. Ignore stale or unrelated items and anything conflicting with current source, tests, or durable documentation. For application questions, reject retrieval-strategy, evaluation, prompting, or workflow-process memories as domain evidence even if they repeat application terms. If no memory passes all three checks, say that memory is insufficient for the requested decision rather than filling the gap with a generic principle.

## Transport Failures

If search fails with `fetch failed`, `This operation was aborted`, a timeout, DNS failure, `ENOTFOUND`, `EAI_AGAIN`, or a similar transport or sandbox error, retry the same `memorax-cli search` once in an approved network-enabled execution mode when one is available. Preserve the same query, workspace, and environment variables.

Do not apply this retry to `memorax-cli add`, authentication or configuration failures, or HTTP errors. If no approved mode is available or the one retry fails, report the exact CLI failure and continue with live evidence. Do not interpret a transport failure as an empty result, bypass the CLI, or call MemoraX directly.

## Output

If a successful Search returns `quotaNotice`, or prints it as a quota-reminder line in the default CLI output, present the complete reminder once and prominently before the normal result summary. Do not reduce it to only a percentage or omit its account URL or conditional local Mark ID retrieval instructions. Never run `memorax-code account --show-mark-id` for the user, ask for its output, or reproduce a Mark ID in chat. Treat the reminder as user-facing operational output, not recalled memory, and continue the current task.

Mention only an invariant, pitfall, convention, or validation idea that materially affects the answer. Ground claims about current implementation behavior in live code and checks.
