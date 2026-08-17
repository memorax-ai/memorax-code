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

For a proactive add, write all generated prose in `--memory`, `--reason`, and the confirmation in the language of the user's current request; preserve exact code, API, path, workflow, and project identifiers.

Run from the active task workspace. Pass the memory and reason directly. Put every dynamically generated `--memory` and `--reason` value in single quotes, never double quotes. Treat `$HOME`, backticks, and `$(command)` as literal text inside those quotes. Replace each literal single quote in a value with the exact POSIX sequence `'\''`.

```bash
memorax-cli add \
  --memory 'Concise reusable memory.' \
  --type procedural \
  --reason 'Capture reusable coding memory.'
```

Use an appropriate supported type such as `core`, `semantic`, `procedural`, `episodic`, or `unclassified`. Use `preference` only for an engineering convention owned by MemoraX Code coding memory, not for a personal interaction preference.

For a complex verified repair or failed approach, use this compact card when it improves later retrieval:

```text
CODE_AGENT_MEMORY
repo: <repository or product area>
scope: <module/path::symbol/API or lifecycle boundary>
status: <verified|failed_attempt|candidate>
signal: <test, CI, review, reproduction, deployment, failure, or unknown>
problem: <small behavioral symptom or engineering situation>
technical_context: <stable API, lifecycle, state owner, or data-shape detail>
surfaces: <observable producer/consumer or setup/runtime/cleanup boundaries>
failed_shape: <reusable wrong assumption or unsafe patch shape, or none>
validation: <small reusable check contract>
principle: <abstract invariant or decision rule>
anchors: <stable repository source, tests, or public docs>
```

Keep the card under 1,100 characters when practical. It must guide future investigation while still requiring live-code inspection.

Pass a completed multi-line card as one single-quoted `--memory` argument:

```bash
memorax-cli add \
  --memory 'CODE_AGENT_MEMORY
repo: owner/name
scope: module/path::symbol
status: verified
signal: focused test passed
problem: concise reusable symptom
technical_context: stable implementation fact
surfaces: affected boundary
failed_shape: reusable pitfall or none
validation: smallest reusable check
principle: reusable invariant
anchors: stable/source/path' \
  --type procedural \
  --reason 'Capture verified reusable coding memory.'
```

If add fails, report the exact failure and do not retry automatically, bypass the CLI, or call MemoraX directly.

If a successful Add result reports `workspaceScopeFallbackReason: git_metadata_invalid`, malformed or incomplete metadata inside a direct `.git` directory was downgraded to the normalized local folder scope. Add has already been submitted with the reported `effectiveUserId`. Present its `userNotice` once without pausing the current task or asking the user to repair Git first, then continue the current task. After the repository or `.git` metadata is repaired, later Search, Add, and automatic writeback in the same client session automatically use the restored Git repository scope.

If `memorax-cli add` reports `workspace_scope_mismatch` or `workspace_scope_unavailable`, do not bypass the scope. Do not change the CLI working directory and retry. Tell the user that the memory was not submitted and no request was sent to MemoraX, then present the CLI's `userAction` in natural language. Continue the current task using only live code and documentation.

## Exclusions

Do not add secrets, credentials, private URLs, raw authorization headers, exact patches, target commits, hidden tests, target diffs, vulnerability details, exploit steps, copied source, long logs, stack traces, raw transcripts, temporary errors, or facts directly recoverable from current files and git history.

Do not add speculation, assistant-only praise, or a current instruction merely because it contains "remember". Return to `SKILL.md` when the content belongs to personal memory or repo memory.

## Output

After an add request is accepted, confirm briefly that it was submitted for processing and identify the reusable coding lesson at a high level. If add is disabled or fails, report the issue and continue without bypassing the CLI.
