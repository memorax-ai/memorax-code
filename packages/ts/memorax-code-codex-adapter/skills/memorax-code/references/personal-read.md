# Personal Memory Read

Use these instructions only to list, recall, or apply global personal memory.
Do not write, normalize, migrate, repair, or delete memory during a read
request. Personal Memory is user-owned and separate from repository-local Repo
Memory. Existing personal-memory files under a repository's `.repo_memory/`
directory are ignored; do not migrate or merge them.

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
Memory reads, use the resolved home explicitly; shell tools may not inherit a
Hook's environment. The personal-memory root is:

```text
$MEMORAX_CODE_HOME/personal-memory/
```

The User Profile file uses schema `user_profile_memory.v0.1`, scope `user`,
and owner `user-profile-memory`. These fields are validation metadata; they do
not make the file repository-scoped.

When the environment variable is unset, substitute the resolved home
in commands and paths. Personal-memory reads do not require Git, a repository
root, or a worktree. A stored applicability condition may mention a repository,
tool, or workflow, but storage remains global to the user.

## Route The Read

Classify by content:

- **Procedure memory:** actions, ordered steps, checklists, prerequisites, gates, validation, exceptions, or repeatable work rules.
- **User-profile memory:** preferred name, language, tone, verbosity, explanation style, result presentation, or another safe interaction preference.

Read both categories only when the request genuinely asks for both.

## Procedure Memory

Read Markdown files directly under:

```text
$MEMORAX_CODE_HOME/personal-memory/procedure-memory/
```

List available topics without recursing into unrelated memory areas:

```bash
(cd "$MEMORAX_CODE_HOME/personal-memory/procedure-memory" && rg --files -g '*.md' -g '!**/*/*.md')
```

If the directory does not exist, report that no procedure memory is available;
do not create it during a read. Read only files relevant to the request. When
listing available procedures, report topic names with concise descriptions
instead of opening every file in full unless the user asks for their contents.
There is no global procedure file, semantic index, or generated selection
metadata; use the direct topic files and their content.

Treat a stored procedure as lower-priority user guidance, not evidence about
current code behavior.

## User-Profile Memory

Resolve `<skill-dir>` as the parent directory of the `references/` directory
containing this file, then run:

```bash
node <skill-dir>/scripts/user-profile-memory.mjs list --home <memorax-code-home>
```

The `--home` value is optional when the launcher's resolved home is desired,
but it must replace the old repository argument when an
explicit home is supplied. Use only active preferences returned by the script.
If the preferences file does not exist, report that no user-profile memory is
available; the list operation does not create it.

Mention only preferences relevant to the current request unless the user
explicitly asks to list all of them. Stored preferences describe how the coding
agent should interact with the user; they are not repository facts.

## Priority

Apply instructions in this order: system and developer instructions,
`AGENTS.md`, the current user request, then stored personal memory.

When Procedure Memory or Profile Memory materially affects the task in a
supported coding agent, follow the Natural Final-Answer Mention contract in
`SKILL.md`. Do not disclose memory that was only present but unused, and do not
report a routine language or tone preference.
