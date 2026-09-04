---
name: memorax-code
description: >-
  Use this skill as the single router for persistent coding and repository-local
  memory. Invoke it whenever a request may involve prior-work knowledge,
  repository memory, reusable procedures or rules, durable profile or
  interaction preferences, or information worth retaining beyond the current
  task. This applies without memory wording, including habits, preferences,
  checklists, action sequences, prerequisites, gates, exceptions, validation
  rules, communication style, preferred language, or result presentation.
  Classify the request as coding memory, repository memory, personal procedure
  memory, personal profile memory, or no persistent memory, then route it to the
  matching operation. Invoking this router does not require coding-memory
  search. Reuse a relevant coding-memory result already retrieved in this
  conversation; otherwise let the matching operation decide on search. Prefer
  this router over underlying memory workflows. Ask one focused question only when
  memory authority remains ambiguous.
---

# MemoraX Code

Classify the requested memory authority first, then its operation. Load only the matching reference unless the request genuinely spans authorities or operations.

After selecting an operation reference, read it completely in a standalone
tool call and wait for the full result before constructing or executing that
operation. Never combine reading a required reference with the command or
action it governs in the same shell command or tool call.

## Authority Router

### MemoraX Code Coding Memory

Use MemoraX Code coding memory for reusable engineering knowledge learned across coding work: prior fixes, failed approaches, coding conventions, implementation pitfalls, validation patterns, and design rationale.

- Read [references/memorax-search.md](references/memorax-search.md) to recall or search coding memory.
- Read [references/memorax-add.md](references/memorax-add.md) to save a grounded reusable coding lesson.

### Repo Memory

Use repo memory for repository identity, architecture maps, module routing, local commit history, and GitHub or GitLab PR, MR, and issue evidence stored under `.repo_memory/PROFILE.md`, `.repo_memory/resources/`, and `.repo_memory/raw/`.

- Read [references/repo-read.md](references/repo-read.md) to inspect existing repo memory.
- Read [references/repo-build.md](references/repo-build.md) for first-time creation, full rebuilds, or full refreshes.
- Read [references/repo-update.md](references/repo-update.md) for incremental updates to an existing bundle.
- Read [references/repo-templates.md](references/repo-templates.md) only when the build or update operation needs to author repo memory files.

### Personal Memory

Use personal memory for user-owned repository procedures and durable profile or interaction preferences stored under `.repo_memory/procedure-memory/` and `.repo_memory/user-profile/`.

- Read [references/personal-read.md](references/personal-read.md) to list, recall, or apply personal memory.
- Read [references/personal-write.md](references/personal-write.md) to save, update, forget, or delete personal memory.

## Tie Breakers

- Route ordered actions, checklists, prerequisites, gates, exceptions, and validation rules to personal procedure memory, even when phrased as "I prefer", "I like", "我的习惯", or "我喜欢".
- Route preferred name, answer language, tone, verbosity, explanation style, and result presentation to personal profile memory.
- Route task-learned repairs, coding pitfalls, project engineering conventions, and reusable design lessons to MemoraX Code coding memory.
- Route prior project discussions, experiment conclusions, saved engineering findings, earlier fixes, and reusable project lessons to MemoraX Code coding memory. Do not route them to repo memory merely because they concern a project. Use repo memory for repository identity, architecture, module maps, commits, PRs, MRs, and issues.
- Route repository architecture, module maps, commit history, PRs, MRs, and issues to repo memory. Verify claims about current behavior against live code.
- Use both repo memory and MemoraX Code coding memory only when a request genuinely needs distinct repository evidence and reusable engineering lessons. This can apply to implementation, debugging, refactoring, migration planning, or validation when the answer may depend on repository module maps, commit/PR/issue evidence, and prior fixes, pitfalls, conventions, validation patterns, or design rationale. Do not use both authorities just because a request mentions a repository, file, module, or "previous".
- Route current-task instructions and temporary plans to the current task only; do not persist them.
- Current-task-only applies only when completing the request does not depend on prior project state. Do not select it merely because the requested action happens in the current turn. When implementation, debugging, review, experiment continuation, or validation depends on earlier project decisions, results, fixes, constraints, or plans that the user has not explicitly and completely supplied, route to MemoraX Code coding memory.
- Do not infer an authority from verbs such as "remember", "recall", "refresh", or "update" alone. Ask one focused question when the target remains ambiguous.

Examples:

- "先测试再提 PR，帮我记住" routes to personal procedure write.
- "我喜欢中文简短回答" routes to personal profile write.
- "之前这个 bug 怎么修的？" routes to MemoraX Code coding memory search unless the user asks for commit or PR evidence.
- "这个仓库的架构是什么？" routes to repo memory read.
- "重新生成仓库 memory" routes to repo memory build.
- "更新一下 memory" requires clarification when no authority is identifiable.

## Natural Final-Answer Mention

For Codex and Claude Code only, mention memory in the final answer when memory read in the current turn materially changed localization, a decision, implementation, validation, or the delivered answer. Eligible sources are an accepted Coding Memory result from a successful explicit `memorax-cli search`, a relevant Repo Memory read, applied Procedure Memory, or applied Profile Memory. A Search or read alone is insufficient: omit the mention for empty, unrelated, stale, rejected, merely confirmatory, or unused memory.

Treat accepted memory as materially helpful when the answer uses it to recover or substantiate historical intent, rationale, a prior decision, a constraint, or a reusable lesson, even when live code independently confirms the conclusion. `Merely confirmatory` means the answer does not rely on the memory for a claim and the memory changes neither its framing, scope, nor confidence.

When eligible, begin the final answer with one brief opening paragraph before the normal task result. Put a blank line after it, keep the entire paragraph under 600 characters, and use the same language and tone as the rest of the answer. Prefer one sentence. Use a second sentence only when two independent memory points each materially affected the task. The paragraph must literally include `MemoraX Code` and the generic label `Memory`. Do not name or enumerate the specific source type in the opening paragraph. Describe only the smallest useful change Memory caused, such as what it helped choose, check, or avoid. Use direct task attribution such as `这次我参考了 MemoraX Code 的 Memory...`, `I used MemoraX Code Memory...`, or `Memory from MemoraX Code helped...`. Do not repeat the task or result, reproduce the memory, or narrate the full execution steps or reasoning. Do not expose raw memory text, IDs, scores, query text, private paths, or secrets. Do not mention a routine language or tone preference.

Keep it conversational. Do not add a heading, card, label, or colon-led report. Do not open with stock wording such as `MemoraX Code 的 Memory 提示：`, `本轮借助...`, `Memory impact:`, or `The memory said...`. Use only normal visible prose: do not include HTML or XML comments, Markdown markers, tags, zero-width text, hidden control text, or metadata. A natural shape is: `这次我参考了 MemoraX Code 的 Memory，避开了之前验证过无效的修复路径。`

Do not report active Add, automatic writeback, Repo Memory build or update, or automatic coding-memory retrieval as memory that helped the current turn. Omit the opening paragraph when no eligible memory materially helped.

## Shared Rules

For MemoraX Code coding memory, run the platform command from the active task workspace. In Windows PowerShell, use `memorax-cli.cmd`; on macOS and Linux, use `memorax-cli`. Never invoke `memorax-cli.ps1`. Never run `Set-ExecutionPolicy` or otherwise change PowerShell execution policy for MemoraX commands. If an unqualified Windows invocation is blocked before the CLI starts with `UnauthorizedAccess` or `PSSecurityException`, retry the same command once with `memorax-cli.cmd`, preserving all arguments, the active workspace, and environment variables.

The installed Hook and session binding supply the authoritative workspace root; do not run Git commands to discover or replace it. The Backend resolves repository scope from that trusted workspace and read-only filesystem Git metadata.

Repo memory and personal memory remain local `.repo_memory` authorities. Resolve their repository root exactly as described by the selected reference, including its Git requirements.

Apply instructions in this order: system and developer instructions, `AGENTS.md`, the current user request, then stored memory. Memory is guidance or historical context, not proof of current repository behavior.

For MemoraX Code coding memory, use `memorax-cli` exactly as described by the selected reference. Invoke this skill as `$memorax-code` in Codex or `/memorax-code` in Claude Code. In OpenCode, ask the agent to use the `memorax-code` skill by name. These invocation forms are not shell commands. `memorax-code` is the lifecycle CLI and must not be used for memory search or add. Do not call MemoraX HTTP endpoints directly.

Never store secrets, credentials, `.env` content, sensitive personal data, raw transcripts, hidden tests, exact patches, temporary target commits, or unsafe destructive commands. Do not announce internal routing or reference loading.
