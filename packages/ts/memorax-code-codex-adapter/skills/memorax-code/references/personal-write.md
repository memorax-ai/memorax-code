# Personal Memory Write

Use these instructions only to save, update, forget, or delete repository-scoped personal memory. Classify by what the content prescribes, not wording such as "I prefer", "I like", "我的习惯", or "我喜欢".

## Route The Write

- **Procedure memory:** actions, ordering, checklists, prerequisites, gates, validation, exceptions, or repeatable repository work rules. Require the user to explicitly ask to remember, save, record, update, forget, or delete them.
- **User-profile memory:** preferred name, language, tone, verbosity, explanation style, result presentation, or another safe personal profile fact. A durable repository-scoped profile preference may be saved implicitly.

Store each part under its own authority when a request genuinely contains both. Do not persist current-task instructions or temporary plans.

## Procedure Memory

Before writing, ensure the repository root `.gitignore` contains `.repo_memory/`. Store each procedure topic in its own concise kebab-case file directly under:

```text
<repo>/.repo_memory/procedure-memory/
```

Do not create a global procedures file, index, event log, generated metadata, or version history. Do not edit `.repo_memory/PROFILE.md`, `.repo_memory/resources/`, `.repo_memory/raw/`, or `.repo_memory/user-profile/`.

Choose the closest existing topic file before writing:

- New topic: create a file.
- Addition or refinement to the same topic: update the existing file.
- A new rule directly conflicts with or replaces an old rule: update the existing file and remove the superseded content.
- An old rule references a command, file, or workflow that no longer exists: update the invalid part; delete the file if the entire procedure is obsolete.
- Equivalent content: do not add a duplicate.
- If it is unclear whether the change is durable or only applies to the current task: ask the user.

Do not modify existing memory because of a one-time instruction for the current task. Do not scan or clean up unrelated topics.

Use this shape when useful:

```markdown
# Reviewing Code

Use when: reviewing changes in this repository.

## Procedure

1. Review the changes before creating a PR.
2. Resolve blocking findings.
3. Create the PR only after review is complete.

## Exceptions

- Follow a more specific current user instruction first.
```

Do not retain deleted text in tombstones, backups, inactive entries, or history files. Apply the same rule to superseded text.

## User-Profile Memory

Use only:

```text
<repo>/.repo_memory/user-profile/preferences.md
```

Resolve `<skill-dir>` as the parent directory of the `references/` directory containing this file. The script owns directory creation, `.gitignore` updates, parsing, normalization, locking, duplicate detection, counts, and deterministic rewriting. Do not hand-edit `preferences.md` except when diagnosing a script failure.

List existing preferences before adding and perform semantic matching:

```bash
python3 <skill-dir>/scripts/user_profile_memory.py list --repo <repo>
```

Handle the semantic match before writing:

- New preference: add a new preference.
- Equivalent content: do not add a duplicate.
- Addition or refinement to the same preference: update the existing preference.
- A new preference directly conflicts with or replaces an old preference in the same scope: update the existing id and remove the superseded content.
- The user explicitly says a preference no longer applies: delete that preference.
- Its `Applies when` environment, tool, or workflow no longer exists: update the scope; delete it if the entire preference is obsolete.

Do not modify or delete existing preferences because of a one-time instruction for the current task. Do not scan or clean up unrelated preferences.

Use the matching id for updates. Add only a genuinely new preference:

```bash
python3 <skill-dir>/scripts/user_profile_memory.py add \
  --repo <repo> \
  --type communication \
  --description "User prefers concise Chinese answers for this repository." \
  --applies-when "Answering questions in this repository." \
  --do-not-apply-when "The user explicitly requests another language or format."
```

Allowed script types are `communication`, `workflow`, `environment`, and `profile`. These type names do not expand this authority: never use `workflow` or `environment` to store an executable repository procedure.

Update a clearly identified preference in place:

```bash
python3 <skill-dir>/scripts/user_profile_memory.py update \
  --repo <repo> \
  --id <preference-id> \
  --description <current-description> \
  --applies-when <current-scope> \
  --do-not-apply-when <exception>
```

If multiple preferences may match, or it is unclear whether the change is durable, ask the user. Delete only an explicitly identified preference:

```bash
python3 <skill-dir>/scripts/user_profile_memory.py delete \
  --repo <repo> \
  --id <preference-id>
```

For delete-all requests, list active preferences and delete each id. Do not preserve deleted text elsewhere.

## Safety And Output

Do not store secrets, tokens, credentials, `.env` content, sensitive personal data, repository facts, code history, design rationale, one-off task details, raw transcripts, hidden tests, exact patches, raw diffs, target commits, or unsafe destructive commands.

After a successful write, update, or deletion, identify the affected topic or preference briefly and confirm that it is local to the current repository.
