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

## Route The Write

- **Procedure memory:** actions, ordering, checklists, prerequisites, gates, validation, exceptions, or repeatable work rules. Require the user to explicitly ask to remember, save, record, update, forget, or delete them.
- **User-profile memory:** preferred name, language, tone, verbosity, explanation style, result presentation, or another safe personal profile fact. A durable preference may be saved implicitly when the user clearly states that it should persist.

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

After a successful write, update, or deletion, identify the affected topic or
preference briefly and confirm that it is stored in the user's global
`MEMORAX_CODE_HOME` personal-memory directory.
