# Personal Memory Read

Use these instructions only to list, recall, or apply repository-scoped personal memory. Do not write, normalize, migrate, repair, or delete memory during a read request.

## Route The Read

Classify by content:

- **Procedure memory:** actions, ordered steps, checklists, prerequisites, gates, validation, exceptions, or repeatable repository work rules.
- **User-profile memory:** preferred name, language, tone, verbosity, explanation style, result presentation, or another safe interaction preference.

Read both categories only when the request genuinely asks for both.

## Procedure Memory

Read Markdown files directly under:

```text
<repo>/.repo_memory/procedure-memory/
```

List available topics without recursing into unrelated memory areas:

```bash
(cd <repo>/.repo_memory/procedure-memory && rg --files -g '*.md' -g '!**/*/*.md')
```

If the directory does not exist, report that no procedure memory is available; do not create it during a read. Read only files relevant to the request. When listing available procedures, report topic names with concise descriptions instead of opening every file in full unless the user asks for their contents.

Treat a stored procedure as lower-priority user guidance, not evidence about current code behavior.

## User-Profile Memory

Resolve `<skill-dir>` as the parent directory of the `references/` directory containing this file, then run:

```bash
python3 <skill-dir>/scripts/user_profile_memory.py list --repo <repo>
```

Use only active preferences returned by the script. If the preferences file does not exist, report that no user-profile memory is available; the list operation does not create it.

Mention only preferences relevant to the current request unless the user explicitly asks to list all of them. Stored preferences describe how the coding agent should interact with the user; they are not repository facts.

## Priority

Apply instructions in this order: system and developer instructions, `AGENTS.md`, the current user request, then stored personal memory.
