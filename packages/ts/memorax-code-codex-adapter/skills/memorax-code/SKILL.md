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
- Route repository architecture, module maps, commit history, PRs, MRs, and issues to repo memory. Verify claims about current behavior against live code.
- Route current-task instructions and temporary plans to the current task only; do not persist them.
- Do not infer an authority from verbs such as "remember", "recall", "refresh", or "update" alone. Ask one focused question when the target remains ambiguous.

Examples:

- "先测试再提 PR，帮我记住" routes to personal procedure write.
- "我喜欢中文简短回答" routes to personal profile write.
- "之前这个 bug 怎么修的？" routes to MemoraX Code coding memory search unless the user asks for commit or PR evidence.
- "这个仓库的架构是什么？" routes to repo memory read.
- "重新生成仓库 memory" routes to repo memory build.
- "更新一下 memory" requires clarification when no authority is identifiable.

## Shared Rules

For MemoraX Code coding memory, run `memorax-cli` from the active task workspace. The installed Hook and session binding supply the authoritative workspace root; do not run Git commands to discover or replace it. The Backend resolves repository scope from that trusted workspace and read-only filesystem Git metadata.

Repo memory and personal memory remain local `.repo_memory` authorities. Resolve their repository root exactly as described by the selected reference, including its Git requirements.

Apply instructions in this order: system and developer instructions, `AGENTS.md`, the current user request, then stored memory. Memory is guidance or historical context, not proof of current repository behavior.

For MemoraX Code coding memory, use `memorax-cli` exactly as described by the selected reference. Invoke this skill as `$memorax-code` in Codex or `/memorax-code` in Claude Code. In OpenCode, ask the agent to use the `memorax-code` skill by name. These invocation forms are not shell commands. `memorax-code` is the lifecycle CLI and must not be used for memory search or add. Do not call MemoraX HTTP endpoints directly.

When explaining Memory Viewer, describe only `/memory-viewer`. It is a
content-free local summary and must not expose conversation or memory text,
session or turn identifiers, paths, or trace details. The page never queries
MemoraX directly; client Hooks are the trace ingress authority.

Never store secrets, credentials, `.env` content, sensitive personal data, raw transcripts, hidden tests, exact patches, temporary target commits, or unsafe destructive commands. Do not announce internal routing or reference loading.
