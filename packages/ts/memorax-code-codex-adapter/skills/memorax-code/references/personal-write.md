# Personal Memory Write

Use these instructions only to save, update, forget, or delete global personal
memory. Classify by what the content prescribes, not wording such as "I
prefer", "I like", "我的习惯", or "我喜欢". Personal Memory is user-owned and
separate from repository-local Repo Memory. Existing personal-memory files under
a repository's `.repo_memory/` directory are ignored; do not migrate or merge
them.

## Resolve The Personal-Memory Home

Resolve the same home for both User Profile and Procedure Memory. An explicit
User Profile `--home` argument takes precedence. Otherwise use the first
non-empty value in this order:

1. The caller's `MEMORAX_CODE_HOME` environment variable.
2. `memoraxCodeHome` in `<skill-dir>/.memorax-code-package.json`.
3. `memoraxCodeHome` in the package root's `.memorax-code-package.json`.
4. `~/.memorax-code`, using the platform user's home directory.

`<skill-dir>` is the parent of this `references/` directory; the package root is
two directories above `<skill-dir>`. Skip absent or unreadable metadata. The
User Profile launcher resolves this order automatically. For direct Procedure
Memory writes, use the resolved home explicitly; shell tools may not inherit a
Hook's environment. The personal-memory root is:

```text
$MEMORAX_CODE_HOME/personal-memory/
```

The User Profile file uses schema `user_profile_memory.v0.1`, scope `user`,
and owner `user-profile-memory`. Preserve these fields through script-managed
writes.

Personal-memory writes do not require Git, a repository root, or a worktree. A
stored `Applies when` condition may mention a repository, tool, or workflow, but
the memory file is global to the user.

## Decide Whether To Save

Judge the user's intent, not trigger words. Save without waiting for
"remember", "save", or "记住" when all three conditions hold:

1. **Durable:** the user means it to keep applying after the current task.
2. **General:** it covers a class of situations, not only the current file,
   command, or object.
3. **User-owned:** it is the user's own working rule or preference, not a
   repository fact, a one-off arrangement, or a secret.

| User statement | Action | Why |
| --- | --- | --- |
| "以后优先使用 node 来读取 git" | Save a procedure | A durable, general working rule |
| "不要在 commit 里加 Claude 署名" | Save a procedure | A durable rule stated as a correction |
| "读 git 用 node 更稳，按这个来" | Save a procedure | The same intent without trigger words |
| "以后回答先给结论" | Save a profile preference | A durable presentation preference |
| "这次先别跑测试" | Do not save | It applies only to the current task |
| "用 node 读一下这个文件" | Do not save | It is a current-task action |
| "这个仓库用 pnpm" | Do not save as personal memory | It is a repository fact |
| "我觉得 node 读 git 好像更稳" | Ask once | It may be an opinion rather than a rule |

Finish the current task first and keep memory remarks at the end of the answer.
When the intent is clear, save it and tell the user briefly at the end; do not
interrupt the current task. When durability or scope is unclear, do not save:
finish the task and ask one short question at the end of the answer, never
before or during the task. Do not save when any condition fails.

## Route The Write

- **Procedure memory:** how the user wants work done: actions, ordering, tools, checklists, prerequisites, gates, validation, exceptions, or repeatable work rules, including single-sentence rules.
- **User-profile memory:** how the user wants the agent to communicate and present results: preferred name, language, tone, verbosity, explanation style, result presentation, or another safe personal profile fact.

Store each part under its own authority when a request genuinely contains both.
Do not persist current-task instructions or temporary plans.

Keep file names, schema and script field names, type values, command options, and
fixed Markdown headings in English. Write human-readable memory content in the
user's current interaction language unless the user explicitly requests
another storage language. This includes procedure titles and steps and
user-profile descriptions, applicability, and exceptions. Preserve exact code
identifiers, commands, paths, API names, and quoted literals without
translation.

## Procedure Memory

Store each procedure topic in its own concise kebab-case Markdown file directly
under:

```text
$MEMORAX_CODE_HOME/personal-memory/procedure-memory/
```

Do not create a global procedures file, index, event log, generated metadata,
or version history. Do not edit repository `.repo_memory/` files. The procedure
reader uses direct topic files; there is no semantic selection or index to
maintain.

Choose the closest existing topic file before writing:

- New topic: create a file.
- Addition or refinement to the same topic: update the existing file.
- A new rule directly conflicts with or replaces an old rule: update the existing file and remove the superseded content.
- An old rule references a command, file, or workflow that no longer exists: update the invalid part; delete the file if the entire procedure is obsolete.
- Equivalent content: do not add a duplicate.
- If it is unclear whether the change is durable or only applies to the current task: ask the user.

Merge a single rule into the closest existing topic instead of creating one file
per rule. Procedure context is budgeted, so keep each topic concise and update
rules in place rather than appending variants. Write `Use when:` narrowly
enough that a rule learned for one repository, tool, or environment does not
apply everywhere, and name that repository, tool, or environment when the rule
depends on it.

Do not modify existing memory because of a one-time instruction for the current
task. Do not scan or clean up unrelated topics.

Use this shape when useful:

```markdown
# Reviewing Code

Use when: reviewing changes in a repository.

## Procedure

1. Review the changes before creating a PR.
2. Resolve blocking findings.
3. Create the PR only after review is complete.

## Exceptions

- Follow a more specific current user instruction first.
```

Delete only the topic file, section, or step the user explicitly identifies,
and preserve unrelated content. Do not retain deleted text in tombstones,
backups, inactive entries, or history files. Apply the same rule to superseded
text.

## User-Profile Memory

Use only:

```text
$MEMORAX_CODE_HOME/personal-memory/user-profile/preferences.md
```

Resolve `<skill-dir>` as the parent directory of the `references/` directory
containing this file. The script owns directory creation, parsing,
normalization, locking, duplicate detection, counts, and deterministic
rewriting. Do not hand-edit `preferences.md` except when diagnosing a script
failure.

List existing preferences before adding and perform semantic matching:

```bash
node <skill-dir>/scripts/user-profile-memory.mjs list --home <memorax-code-home>
```

The `--home` value is optional when the launcher's resolved home is desired,
but it replaces the old repository argument when an
explicit home is supplied.

Handle the semantic match before writing:

- New preference: add a new preference.
- Equivalent content: do not add a duplicate.
- Addition or refinement to the same preference: update the existing preference.
- A new preference directly conflicts with or replaces an old preference in the same scope: update the existing id and remove the superseded content.
- The user explicitly says a preference no longer applies: delete that preference.
- Its `Applies when` environment, tool, or workflow no longer exists: update the scope; delete it if the entire preference is obsolete.

Do not modify or delete existing preferences because of a one-time instruction for
the current task. Do not scan or clean up unrelated preferences.

Use the matching id for updates. Add only a genuinely new preference:

```bash
node <skill-dir>/scripts/user-profile-memory.mjs add \
  --home <memorax-code-home> \
  --type communication \
  --description "User prefers concise Chinese answers." \
  --applies-when "Answering the user's requests." \
  --do-not-apply-when "The user explicitly requests another language or format."
```

Allowed script types are `communication`, `workflow`, `environment`, and
`profile`. These type names do not expand this authority: never use `workflow`
or `environment` to store an executable procedure.

Update a clearly identified preference in place:

```bash
node <skill-dir>/scripts/user-profile-memory.mjs update \
  --home <memorax-code-home> \
  --id <preference-id> \
  --description <current-description> \
  --applies-when <current-scope> \
  --do-not-apply-when <exception>
```

If multiple preferences may match, or it is unclear whether the change is
durable, ask the user. Delete only an explicitly identified preference:

```bash
node <skill-dir>/scripts/user-profile-memory.mjs delete \
  --home <memorax-code-home> \
  --id <preference-id>
```

For delete-all requests, list active preferences and delete each id. Do not
preserve deleted text elsewhere.

## Safety And Output

Do not store secrets, tokens, credentials, `.env` content, sensitive personal
data, repository facts, code history, design rationale, one-off task details,
raw transcripts, hidden tests, exact patches, raw diffs, target commits, or
unsafe destructive commands.

After a successful write, update, or deletion, tell the user in one sentence
what was stored or changed and where it applies, and that they can ask to
forget it. Confirm that it is stored in the user's global `MEMORAX_CODE_HOME`
personal-memory directory.
