# MemoraX Code Coding Memory Add

Use these instructions only to add reusable coding knowledge through `memorax-cli`. Invoke the skill as `$memorax-code` in Codex or `/memorax-code` in Claude Code. In OpenCode, ask the agent to use the `memorax-code` skill by name. Do not route memory operations through the lifecycle-only `memorax-code` CLI. Do not use this authority for personal procedures, interaction preferences, generated repository facts, or one-off task details.

## Eligible Knowledge

Add a coding memory only when the task yields stable, grounded, reusable engineering knowledge, such as:

- a verified repair invariant or validation pattern;
- a reusable failed-attempt lesson;
- a confirmed coding convention, lifecycle boundary, or implementation pitfall;
- durable design rationale that will help future coding work.

Route user-owned ordered actions, checklists, gates, and work rules to personal procedure memory. Route preferred language, tone, verbosity, name, and presentation to personal profile memory. Route commit, PR, issue, architecture-map, and repository-history facts to repo memory.

Do not add positive repair lessons based only on unverified edits or assistant self-report. Verification may come from a focused test, evaluator, CI check, accepted review, manual reproduction, or deployed behavior. A failed attempt may be saved as negative evidence when the failure itself is clear and reusable.

## Add Workflow

Before composing a proactive add, determine `memory_output_language` as exactly `zh` or `en` from the natural-language instructions in the user's current request:

- Choose `zh` when the request is primarily Chinese, even when it contains English code, API, path, test, workflow, or project identifiers.
- Choose `en` when the request is primarily English.
- If the request genuinely uses both languages equally, use the language of its final explicit instruction.

Use only the current user request for this decision. Do not substitute the language of server responses, retrieved memories, configuration, surrounding documentation, examples, or technical identifiers. Then use exactly one matching language branch below; never combine the Chinese and English examples.

Write all generated prose in `--memory`, `--reason`, and the confirmation in `memory_output_language`; preserve exact code, API, path, workflow, and project identifiers, as well as field-name and enum identifiers. In a `CODE_AGENT_MEMORY` card, keep fixed keys such as `repo`, `scope`, `status`, `signal`, and `problem` in English, but write their natural-language values in `memory_output_language`.

Immediately before each `memorax-cli add` invocation, emit exactly one shell audit comment in the same shell input:

```text
# memorax-memory-language: <zh|en>; source=current_user_request
```

Replace `<zh|en>` with the selected value. The comment records the decision only: do not include the user's text, memory content, repository path, identity, or other private data. It is not the user-facing confirmation.

Before execution, compare the audit comment, `--memory`, `--reason`, and planned confirmation. If the comment says `zh` but multi-sentence natural-language prose in `--memory` contains no meaningful Chinese, rewrite it before invoking the CLI. Apply the equivalent check for `en`; ignore preserved identifiers and fixed card keys when checking consistency.

Run from the active task workspace. Pass the memory and reason directly. Put every dynamically generated `--memory` and `--reason` value in single quotes, never double quotes. Treat `$HOME`, backticks, and `$(command)` as literal text inside those quotes. Replace each literal single quote in a value with the exact POSIX sequence `'\''`.

For a Chinese request, use only the Chinese branch:

```bash
# memorax-memory-language: zh; source=current_user_request
memorax-cli add \
  --memory '解析器处理空数组时，应先检查长度再访问元素。' \
  --type procedural \
  --reason '记录经过验证、可复用的解析器边界检查。'
```

For an English request, use only the English branch:

```bash
# memorax-memory-language: en; source=current_user_request
memorax-cli add \
  --memory 'When a parser handles an empty array, check its length before accessing an element.' \
  --type procedural \
  --reason 'Capture a verified, reusable parser boundary check.'
```

Use an appropriate supported type such as `core`, `semantic`, `procedural`, `episodic`, or `unclassified`. Use `preference` only for an engineering convention owned by MemoraX Code coding memory, not for a personal interaction preference.

For a complex verified repair or failed approach, use this compact card when it improves later retrieval:

```text
CODE_AGENT_MEMORY
repo: <repo>
scope: <scope>
status: <verified|failed_attempt|candidate>
signal: <signal>
problem: <problem>
technical_context: <technical context>
surfaces: <surfaces>
failed_shape: <failed shape or none>
validation: <validation>
principle: <principle>
anchors: <anchors>
```

Keep the card under 1,100 characters when practical. It must guide future investigation while still requiring live-code inspection.

Pass a completed multi-line card as one single-quoted `--memory` argument. For a Chinese request:

```bash
# memorax-memory-language: zh; source=current_user_request
memorax-cli add \
  --memory 'CODE_AGENT_MEMORY
repo: owner/name
scope: module/path::symbol
status: verified
signal: 聚焦测试通过
problem: 解析器在空数组上发生越界
technical_context: 读取首个元素前必须检查数组长度
surfaces: 输入校验与元素读取边界
failed_shape: 假设数组至少包含一个元素
validation: 空数组和单元素数组的聚焦测试均通过
principle: 访问集合元素前先验证边界
anchors: stable/source/path' \
  --type procedural \
  --reason '记录经过验证、可复用的解析器边界规则。'
```

For an English request:

```bash
# memorax-memory-language: en; source=current_user_request
memorax-cli add \
  --memory 'CODE_AGENT_MEMORY
repo: owner/name
scope: module/path::symbol
status: verified
signal: focused test passed
problem: the parser reads past an empty array
technical_context: check array length before reading the first element
surfaces: input validation and element-access boundary
failed_shape: assuming every array contains an element
validation: focused tests pass for empty and single-element arrays
principle: validate collection bounds before element access
anchors: stable/source/path' \
  --type procedural \
  --reason 'Capture a verified, reusable parser boundary rule.'
```

If add fails, report the exact failure and do not retry automatically, bypass the CLI, or call MemoraX directly.

If a successful Add result reports `workspaceScopeFallbackReason: git_metadata_invalid`, malformed or incomplete metadata inside a direct `.git` directory was downgraded to the normalized local folder scope. Add has already been submitted with the reported `effectiveUserId`. Present its `userNotice` once without pausing the current task or asking the user to repair Git first, then continue the current task. After the repository or `.git` metadata is repaired, later Search, Add, and automatic writeback in the same client session automatically use the restored Git repository scope.

If `memorax-cli add` reports `workspace_scope_mismatch` or `workspace_scope_unavailable`, do not bypass the scope. Do not change the CLI working directory and retry. Tell the user that the memory was not submitted and no request was sent to MemoraX, then present the CLI's `userAction` in natural language. Continue the current task using only live code and documentation.

## Exclusions

Do not add secrets, credentials, private URLs, raw authorization headers, exact patches, target commits, hidden tests, target diffs, vulnerability details, exploit steps, copied source, long logs, stack traces, raw transcripts, temporary errors, or facts directly recoverable from current files and git history.

Do not add speculation, assistant-only praise, or a current instruction merely because it contains "remember". Return to `SKILL.md` when the content belongs to personal memory or repo memory.

## Output

After an add request is accepted, confirm briefly that it was submitted for processing and identify the reusable coding lesson at a high level. If add is disabled or fails, report the issue and continue without bypassing the CLI.
