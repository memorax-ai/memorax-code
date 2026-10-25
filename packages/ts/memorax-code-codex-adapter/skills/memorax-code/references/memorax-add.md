# MemoraX Code Coding and Work Memory Add

Use these instructions to add reusable coding knowledge, user-requested work dialogue, or documents under the Work Memory workflow below through `memorax-cli`. Invoke the skill as `$memorax-code` in Codex or `/memorax-code` in Claude Code. In OpenCode, ask the agent to use the `memorax-code` skill by name. Do not route memory operations through the lifecycle-only `memorax-code` CLI. Do not use this authority for personal procedures, interaction preferences, generated repository facts, or one-off task details.

## Work Memory Add

Select the content type from the source being saved, not from the client name
or search results. In any client, use `--content-type work --mode default`
for grounded office requirements, discussions, and decisions. Use
`--content-type code --mode pre_summarized` for reusable coding lessons. The
service applies Chat rules to work or dialogue; do not wrap work facts in a
`CODE_AGENT_MEMORY` card or promote an unresolved request into a completed fact.
The coding eligibility and card guidance below applies only to coding memory.

```bash
memorax-cli add --content-type work --mode default \
  --memory 'The user requested the travel reimbursement approval threshold; the policy still needs verification.' \
  --type episodic --reason 'Preserve the office requirement requested by the user.'
```

Use `--content-type auto --mode default` when MemoraX should classify an
ordinary completed discussion as code or work. Auto and work accept only default
mode. Omitted content type defaults to auto/default in every client. Do not add a
coding card or code extraction instructions to auto/work content.

### Document attachment imports

Use this workflow whenever the user sends a PDF, DOCX, XLSX, PPTX or text file.
Text examples include Markdown (`.md`/`.markdown`), TXT, CSV, TSV, JSON, YAML,
HTML and source code. Unknown extensions and extensionless text files also
qualify; these examples are not an extension whitelist. Use the attachment's
available name, type and context to identify document or text candidates, without
implementing local format or encoding validation. This does not add parsing for
images, archives, legacy DOC/XLS/PPT or other unsupported binary formats.
Sending an eligible file triggers document Add, including a bare attachment
without any accompanying text. Do not ask its purpose or require a summary,
analysis, question, or "save to MemoraX" instruction before importing it. Process
each eligible file in a multi-file submission independently. Apply these
boundaries before uploading:

- The original file must be a readable, nonempty regular file no larger than
  150 MiB. The CLI checks these local conditions; the service validates the
  format, encoding and content. Report local failures or server rejections and
  continue processing the other eligible files.
- If the user says not to save, or requests temporary-only use, do not Add the
  document or route its contents through dialogue Add. Use available local
  reading tools; explain any limitation without silently importing it.
- Credential files supplied for configuration, including AccessKey exports,
  secrets and `.env` files, are not memory documents. Never import their contents.
- Import the files the user actually sends, not files merely selected or visible
  in an editor, nor files found by scanning the workspace.

Briefly tell the user that the document will be imported into MemoraX for parsing
and later retrieval, then proceed without another confirmation. Use the original
file bytes, up to 150 MiB, through `--document-file` for every format, including
MD and TXT. Do not decode, convert, summarize, trim or rewrite the attachment
before upload. If the host has not exposed a readable local file, ask for access
to the file; do not invent a path or upload scraped tool output.

The service validates PDF/Office formats before parsing them. All other files
must pass strict UTF-8 text validation (UTF-8 BOM is accepted), be nonblank,
contain no binary control characters, and have at most 2,000,000 Unicode
characters. GBK and UTF-16 are not accepted. These are service-side rules, not
instructions to read or validate the entire file locally. Text attachments are
stored as `document` content, including source code. HTML tags, CSV/JSON syntax
and Notebook JSON remain raw text; the service does not execute code, extract
embedded attachments, or convert them into formatted document content.

Before a new upload, check the current task's known receipts. Reuse an accepted
receipt only when it belongs to the same account/workspace scope and the same
unchanged file, verified from the original upload or a matching SHA-256. A
filename alone is not identity evidence. Acceptance is enough to skip a duplicate
Add even while the backend is still processing the file. Do not claim cross-session
deduplication: the plugin has no persistent file-to-document identity cache.

For a first import with no previous task or document identity, allocate a new
opaque document UUID and a separate input UUID with a UUID generator, and use
`expected_revision=0`. This allocates a new identity; it does not infer an
existing document ID from a filename. Preserve the IDs and receipt in the task
context. For an update or retry, use the confirmed identity and revision rules
below; missing update identity requires clarification, not a new document.

Pass those actual IDs in place of the illustrative values below:

```bash
memorax-cli add --document-file './policy.pdf' \
  --document-id '22345678-1234-4234-8234-123456789abc' \
  --input-id '12345678-1234-4234-8234-123456789abc' --expected-revision 0 --json
```

Wait for the upload HTTP response. Once accepted, retain the receipt and end the
import operation: tell the user the file was submitted for processing, without
claiming that parsing or indexing has completed. Do not query task status or
wait for backend processing. A bare attachment or storage-only request needs
no Search. Do not invent a question for it.

For a current summary, analysis or question about the attachment, use the
agent's available file-reading tools. Upload prepares memory for later retrieval;
the current answer must not depend on immediate Search results from the new
upload. If local reading cannot cover the request, explain the limitation.
For a later request about already indexed documents, follow
[memorax-search.md](memorax-search.md) for source selection and query
construction. Retrieved chunks do not establish full-document coverage.

The same command uploads PDF/Office and text attachments as original bytes;
replace the example path with the actual supplied file. Attachment upload does
not require `--type` or `--reason`. Keep `--memory-file` only for explicit
complete-text snapshots described below, not as the MD/TXT attachment route.
For multiple files use `--document-manifest` with a JSON array; each entry contains
`path`, `document_id`, `input_id`, `expected_revision` and optional `sha256`.
Paths are relative to the manifest; every input ID must be unique. Each entry
has an independent result, so preserve successful receipts when another fails.

A new snapshot needs a fresh input UUID and the last confirmed revision (`0`
for creation). Acceptance alone does not confirm a new revision. If an update's
revision is unknown, obtain confirmed revision evidence before submitting it;
do not guess a revision or silently create another document. An unchanged
user-authorized retry must reuse the exact file, input ID, revision, scope, output
language and optional checksum. Upload uses the input ID as its request
idempotency key. Do not retry
an uncertain submission automatically or generate a replacement ID for it.
An accepted receipt with `pending: true` confirms submission only. Preserve the
returned task ID as part of the receipt; it does not confirm a completed revision.
On failure or `submission_unknown`, keep the original IDs, file and any receipt,
report the result, and do not automatically retransmit the file. A server format
or encoding rejection is not permission to convert the file, fall back to a text
snapshot, or save its contents as dialogue.

### Full document snapshots

Use this separate workflow only when the requested input is already a complete
text snapshot or the user explicitly requests a text snapshot. File attachments,
including MD and TXT, use the original-file upload workflow above. Apply the
same no-save requests, credential-file exclusions, receipt reuse, scope and
retry rules. Do not read or convert attachments merely to select this route.

For a first import, generate a new opaque document UUID and a separate input
UUID, and use `expected_revision=0`. Preserve both IDs and the receipt in the
current task. For a replacement, use the confirmed document ID and revision;
do not infer an existing identity from the filename.

Send the supplied complete text snapshot through
`--content-type document --memory-file`. Replace the sample path and UUIDs
below with the actual snapshot and generated identities:

```bash
memorax-cli add --content-type document --memory-file './document-snapshot.txt' \
  --document-id '22345678-1234-4234-8234-123456789abc' \
  --input-id '12345678-1234-4234-8234-123456789abc' --expected-revision 0 --json
```

Use a fresh input UUID for a new snapshot and the last confirmed document revision
(`0` when creating it). The file's full text is preserved, including BOM,
whitespace and line endings, up to 2,000,000 Unicode characters and 8,000,000
UTF-8 bytes. This path does
not need `--type` or `--reason` and bypasses the ordinary memory size limit.
Never summarize, trim, prefix, truncate, or wrap the document in a coding card.
Do not infer IDs or revisions, parse binary files, scrape tool output, watch
files, or simulate indexing by sending document text as dialogue. Empty text
requires explicit `--allow-empty` and user intent to clear that document.

Wait for the Add HTTP response, retain any accepted receipt, and end the import
operation. Acceptance does not confirm completed extraction or indexing. Do not
poll status or require an immediate Search result. Use the agent's available
file-reading tools for any current summary, analysis or question; never use that
summary in place of the complete document snapshot.

A user-authorized retry of the identical snapshot must reuse the exact input
ID, expected revision, text, scope, and output language. Do not automatically
retry after an uncertain result. No local version cache is maintained. A receipt
with `pending: true` acknowledges submission and exposes `task_id`; it does not
confirm completed extraction or the new revision. Completed synchronous results
preserve structured `events`; use their document ID/revision if present. Never
guess a revision from acceptance or human-readable memory text.
The scope, quoting, failure, and quota rules below apply to all Add routes. On
Windows PowerShell use `memorax-cli.cmd`.

## Eligible Knowledge

Add a coding memory only when the task yields stable, grounded, reusable engineering knowledge, such as:

- a verified repair invariant or validation pattern;
- a reusable failed-attempt lesson;
- a confirmed coding convention, lifecycle boundary, or implementation pitfall;
- durable design rationale that will help future coding work.

Route user-owned ordered actions, checklists, gates, and work rules to personal procedure memory. Route preferred language, tone, verbosity, name, and presentation to personal profile memory. Route commit, PR, issue, architecture-map, and repository-history facts to repo memory.

Do not add positive repair lessons based only on unverified edits or assistant self-report. Verification may come from a focused test, evaluator, CI check, accepted review, manual reproduction, or deployed behavior. A failed attempt may be saved as negative evidence when the failure itself is clear and reusable.

## Add Workflow

Select the executable before constructing any Add command. In Windows PowerShell, use `memorax-cli.cmd`; on macOS and Linux, use `memorax-cli`. Never invoke `memorax-cli.ps1`. Never run `Set-ExecutionPolicy` or otherwise change PowerShell execution policy for MemoraX commands. If an unqualified Windows invocation is blocked before the CLI starts with `UnauthorizedAccess` or `PSSecurityException`, retry that command once with `memorax-cli.cmd`, preserving all arguments, the active workspace, and environment variables.

For a proactive add, write all generated prose in `--memory`, `--reason`, and the confirmation in the language of the user's current request; preserve exact code, API, path, workflow, and project identifiers.

Run from the active task workspace. Pass the memory and reason directly. Put every dynamically generated `--memory` and `--reason` value in single quotes, never double quotes. Apply the escaping rule for the active shell:

- Windows PowerShell: single quotes keep `$HOME`, backticks, and `$(command)` literal. Replace each literal single quote in a value with two single quotes (`''`); for example, `don't` becomes `'don''t'`.
- macOS and Linux: Treat `$HOME`, backticks, and `$(command)` as literal text inside the quotes. Replace each literal single quote in a value with the exact POSIX sequence `'\''`.

Windows PowerShell:

```powershell
memorax-cli.cmd add --memory 'Concise reusable memory.' --content-type code --mode pre_summarized --type procedural --reason 'Capture reusable coding memory.'
```

macOS and Linux:

```bash
memorax-cli add --content-type code --mode pre_summarized \
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

Pass a completed multi-line card as one single-quoted `--memory` argument. On Windows PowerShell, the command must start with `memorax-cli.cmd add`; on macOS and Linux, use the form shown below.

```bash
memorax-cli add --content-type code --mode pre_summarized \
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

Except for the pre-start Windows shim correction above, if add fails, report the exact failure and do not retry automatically, bypass the CLI, or call MemoraX directly. Do not retry Add after the CLI may have started.

If a successful Add result reports `workspaceScopeFallbackReason: git_metadata_invalid`, malformed or incomplete metadata inside a direct `.git` directory was downgraded to the normalized local folder scope. Add has already been submitted with the reported `effectiveUserId`. Present its `userNotice` once without pausing the current task or asking the user to repair Git first, then continue the current task. After the repository or `.git` metadata is repaired, later Search, Add, and automatic writeback in the same client session automatically use the restored Git repository scope.

If `memorax-cli add` reports `workspace_scope_mismatch` or `workspace_scope_unavailable`, do not bypass the scope. Do not change the CLI working directory and retry. Tell the user that the memory was not submitted and no request was sent to MemoraX, then present the CLI's `userAction` in natural language. Continue the current task using only live code and documentation.

## Exclusions

Do not add secrets, credentials, private URLs, raw authorization headers, exact patches, target commits, hidden tests, target diffs, vulnerability details, exploit steps, copied source, long logs, stack traces, raw transcripts, temporary errors, or facts directly recoverable from current files and git history.

Do not add speculation, assistant-only praise, or a current instruction merely because it contains "remember". Return to `SKILL.md` when the content belongs to personal memory or repo memory.

## Output

If a successful Add returns `quotaNotice`, or prints it as a quota-reminder line in the default CLI output, present the complete reminder once and prominently before the normal result summary. Do not reduce it to only a percentage or omit its account URL. The preview edition uses registered accounts; direct account and quota questions to the website named in the reminder. Treat the reminder as user-facing operational output, not coding memory content, and continue the current task.

After an add request is accepted, confirm briefly that it was submitted for processing and identify the reusable coding lesson at a high level. If add is disabled or fails, report the issue and continue without bypassing the CLI.
