import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runMemoryCli } from "../../packages/ts/memorax-code-backend/dist/memory/cli.js";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../packages/ts/memorax-code-codex-adapter");
const skillsRoot = join(packageRoot, "skills");
const skillRoot = join(skillsRoot, "memorax-code");

function readSkillFile(path) {
  return readFileSync(join(skillRoot, path), "utf8");
}

test("memorax-code is the single progressive router for all memory authorities", () => {
  const skill = readSkillFile("SKILL.md");

  assert.match(skill, /name: memorax-code/);
  assert.match(skill, /current-task instructions and temporary plans/);
  assert.match(skill, /Do not call MemoraX HTTP endpoints directly/);
  assert.match(skill, /`\$memorax-code` in Codex/);
  assert.match(skill, /`\/memorax-code` in Claude Code/);
  assert.match(skill, /In OpenCode, ask the agent to use the `memorax-code` skill by name/);
  assert.match(skill, /In Qoder, ask the agent to invoke the native `memorax-code` skill by name/);
  assert.match(skill, /`memorax-code` is the lifecycle CLI and must not be used for memory search or add/);

  for (const reference of [
    "references/memorax-search.md",
    "references/memorax-add.md",
    "references/repo-read.md",
    "references/repo-build.md",
    "references/repo-update.md",
    "references/repo-templates.md",
    "references/personal-read.md",
    "references/personal-write.md",
  ]) {
    assert.equal(existsSync(join(skillRoot, reference)), true, `${reference} should exist`);
    assert.match(skill, new RegExp(reference.replaceAll(".", "\\.")));
  }
});

test("memorax-code removes competing top-level memory skill entries", () => {
  const skillDirectories = readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skillsRoot, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual(skillDirectories, ["memorax-code"]);
});

test("memorax-code references keep authority and operation boundaries explicit", () => {
  const memoraxSearch = readSkillFile("references/memorax-search.md");
  const memoraxAdd = readSkillFile("references/memorax-add.md");
  const repoRead = readSkillFile("references/repo-read.md");
  const repoBuild = readSkillFile("references/repo-build.md");
  const repoUpdate = readSkillFile("references/repo-update.md");

  assert.match(memoraxSearch, /memorax-cli search --query '/);
  assert.match(readSkillFile("SKILL.md"), /### Work Memory/);
  assert.match(memoraxSearch, /--sources document/);
  assert.match(memoraxSearch, /--sources dialogue/);
  assert.doesNotMatch(memoraxSearch, /--document-id\b|\bdocument_ids\b/);
  assert.match(memoraxSearch, /do not\s+retry without the restriction/);
  assert.match(memoraxSearch, /`workspace_scope_mismatch` or `workspace_scope_unavailable`/);
  assert.match(memoraxSearch, /Do not change the CLI working directory and retry/);
  assert.match(memoraxSearch, /`workspaceScopeFallbackReason: git_metadata_invalid`/);
  assert.match(memoraxSearch, /successful Search returns `quotaNotice`/);
  assert.match(memoraxSearch, /preview edition uses registered accounts; direct account and quota questions to the website/);
  assert.doesNotMatch(memoraxSearch, /anonymous-account claim|Mark ID|--show-mark-id/);
  assert.doesNotMatch(memoraxSearch, /--query-file/);
  assert.match(memoraxAdd, /CODE_AGENT_MEMORY/);
  assert.match(memoraxAdd, /memorax-cli add[\s\S]*--memory '/);
  assert.match(memoraxAdd, /`workspace_scope_mismatch` or `workspace_scope_unavailable`/);
  assert.match(memoraxAdd, /Do not change the CLI working directory and retry/);
  assert.match(memoraxAdd, /`workspaceScopeFallbackReason: git_metadata_invalid`/);
  assert.match(memoraxAdd, /successful Add returns `quotaNotice`/);
  assert.match(memoraxAdd, /preview edition uses registered accounts; direct account and quota questions to the website/);
  assert.doesNotMatch(memoraxAdd, /anonymous-account claim|Mark ID|--show-mark-id/);
  assert.doesNotMatch(memoraxAdd.split("## Eligible Knowledge")[1], /--memory-file/);
  assert.match(repoRead, /Current implementation claims and code edits still require live-code verification/);
  assert.match(repoBuild, /scripts\/repo-memory\.mjs collect/);
  assert.match(repoUpdate, /scripts\/repo-memory\.mjs detect-updates/);
});

test("work attachment routing covers bare files and keeps current answers independent of ingestion", () => {
  const router = readSkillFile("SKILL.md");
  const add = readSkillFile("references/memorax-add.md");
  const search = readSkillFile("references/memorax-search.md");
  const workRouter = router.split("### Work Memory")[1].split("### Repo Memory")[0];

  assert.match(router.split("---")[1], /supplied or indexed office documents[\s\S]*attachments\s+without accompanying text/);
  for (const format of ["PDF", "DOCX", "XLSX", "PPTX", ".md", ".txt", "CSV", "TSV", "JSON", "YAML", "HTML", "source code"]) {
    assert.ok(workRouter.includes(format), `${format} should have a document import route`);
  }
  assert.match(workRouter, /bare\s+attachment/);
  assert.match(workRouter, /references\/memorax-add\.md[\s\S]*submit document Add/);
  assert.match(workRouter, /No summary, analysis, question, or\s+separate storage instruction is required/);
  assert.match(add, /Process\s+each eligible file in a multi-file submission independently/);
  assert.match(add, /current summary, analysis or question[\s\S]*available file-reading tools/);
  assert.match(search, /file-reading tools for the current answer/);
  assert.match(search, /an accepted upload does not guarantee that its\s+content is searchable yet/);
  assert.match(add, /A bare attachment or storage-only request needs\s+no Search/);
});

test("work attachment guidance delegates content validation and keeps explicit snapshots separate", () => {
  const router = readSkillFile("SKILL.md");
  const add = readSkillFile("references/memorax-add.md");
  const attachments = add.split("### Document attachment imports")[1].split("### Full document snapshots")[0];
  const snapshots = add.split("### Full document snapshots")[1].split("## Eligible Knowledge")[0];

  assert.match(router, /`--document-file` or `--document-manifest`[\s\S]*original bytes/);
  assert.match(router, /Unknown extensions and\s+extensionless text files also qualify/);
  assert.match(attachments, /service validates the\s+format, encoding and content/);
  assert.match(attachments, /including\s+MD and TXT/);
  assert.match(attachments, /not an extension whitelist/);
  assert.match(attachments, /not\s+instructions to read or validate the entire file locally/);
  assert.match(attachments, /stored as `document` content, including source code/);
  assert.match(attachments, /HTML tags, CSV\/JSON syntax\s+and Notebook JSON remain raw text/);
  assert.match(attachments, /format\s+or encoding rejection is not permission to convert the file, fall back to a text\s+snapshot/);
  assert.match(attachments, /Credential files[\s\S]*Never import their contents/);
  assert.match(attachments, /not files merely selected or visible[\s\S]*scanning the workspace/);
  assert.match(snapshots, /only when the requested input is already a complete\s+text snapshot or the user explicitly requests a text snapshot/);
  assert.match(snapshots, /including MD and TXT, use the original-file upload workflow/);
});

for (const filename of ["policy.pdf", "policy.md", "policy.txt", "people.csv", "main.py", "config.unlisted", "README", ".editorconfig"]) {
  test("work attachment example uploads original " + filename + " bytes once and returns an accepted receipt", async (t) => {
    const add = readSkillFile("references/memorax-add.md");
    const attachments = add.split("### Document attachment imports")[1].split("### Full document snapshots")[0];
    const commands = [...attachments.matchAll(/```bash\n([\s\S]*?)\n```/g)]
      .map((match) => match[1].replace(/\\\r?\n\s*/g, " "));
    assert.equal(commands.length, 1);
    const args = commands[0].match(/'[^']*'|\S+/g)
      .map((token) => token.startsWith("'") ? token.slice(1, -1) : token);
    assert.equal(args.shift(), "memorax-cli");
    const option = (flag) => args[args.indexOf(flag) + 1];
    assert.equal(args[0], "add");
    assert.equal(option("--document-file"), "./policy.pdf");
    assert.ok(!args.includes("--memory-file"));
    const documentId = option("--document-id");
    const inputId = option("--input-id");
    const root = mkdtempSync(join(tmpdir(), "memorax-skill-attachment-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const file = join(root, filename);
    const content = Buffer.from("\uFEFF  # Office policy\r\n" + "文😀".repeat(2500) + "\r\n  ");
    writeFileSync(file, content);
    args[args.indexOf("--document-file") + 1] = file;
    const requests = [];
    const result = await runMemoryCli(args, {
      cwd: root,
      env: {
        MEMORAX_CODE_HOME: join(root, "state"),
        MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
        MEMORAX_CODE_MEMORAX_API_KEY: "synthetic-test-key",
        MEMORAX_CODE_MEMORAX_USER_ID: "skill-test-user",
      },
      fetchImpl: async (url, init) => {
        const upload = init.body.get("file");
        requests.push({ url, method: init.method, request: JSON.parse(init.body.get("request")),
          filename: upload.name, bytes: Buffer.from(await upload.arrayBuffer()) });
        return Response.json({ success: true, data: { task_id: "skill-document-import", status: "accepted",
          document_id: documentId, input_id: inputId, revision: null, data: null } }, { status: 202 });
      },
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.receipt.status, "accepted");
    assert.equal(result.receipt.pending, true);
    assert.equal(result.receipt.task_id, "skill-document-import");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "http://memorax.test/v1/memories/add");
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].request.content_type, "document");
    assert.equal(requests[0].request.async_mode, true);
    assert.equal(requests[0].request.document_id, documentId);
    assert.equal(requests[0].request.input_id, inputId);
    assert.equal(requests[0].request.expected_revision, 0);
    assert.equal(requests[0].filename, filename);
    assert.deepEqual(requests[0].bytes, content);
  });
}

for (const extension of ["md", "txt"]) {
  test(`explicit ${extension} snapshot example submits the full document once and returns an accepted receipt`, async (t) => {
    const add = readSkillFile("references/memorax-add.md");
    const snapshots = add.split("### Full document snapshots")[1].split("## Eligible Knowledge")[0];
    const commands = [...snapshots.matchAll(/```bash\n([\s\S]*?)\n```/g)]
      .map((match) => match[1].replace(/\\\r?\n\s*/g, " "));
    assert.equal(commands.length, 1);
    const tokens = commands[0].match(/'[^']*'|\S+/g)
      .map((token) => token.startsWith("'") ? token.slice(1, -1) : token);
    assert.equal(tokens.shift(), "memorax-cli");
    const args = tokens;
    const option = (flag) => args[args.indexOf(flag) + 1];
    assert.equal(args[0], "add");
    assert.equal(option("--content-type"), "document");
    assert.equal(option("--memory-file"), "./document-snapshot.txt");
    assert.equal(option("--expected-revision"), "0");
    assert.ok(args.includes("--json"));
    const documentId = option("--document-id");
    const inputId = option("--input-id");
    for (const identity of [documentId, inputId]) {
      assert.match(identity, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
    }
    assert.notEqual(documentId, inputId);

    const root = mkdtempSync(join(tmpdir(), `memorax-skill-${extension}-snapshot-`));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const file = join(root, `policy.${extension}`);
    const content = `\uFEFF  # Office policy\r\n${"文😀".repeat(2500)}\r\n  `;
    writeFileSync(file, content);
    args[args.indexOf("--memory-file") + 1] = file;
    const requests = [];
    const result = await runMemoryCli(args, {
      cwd: root,
      env: {
        MEMORAX_CODE_HOME: join(root, "state"),
        MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
        MEMORAX_CODE_MEMORAX_API_KEY: "synthetic-test-key",
        MEMORAX_CODE_MEMORAX_USER_ID: "skill-test-user",
      },
      fetchImpl: async (url, init) => {
        requests.push({ url, method: init.method, body: JSON.parse(init.body) });
        return Response.json({ success: true, data: { task_id: "skill-document-import", status: "accepted" } }, { status: 202 });
      },
    });

    assert.equal(result.ok, true, result.error);
    assert.equal(result.receipt.accepted, true);
    assert.equal(result.receipt.pending, true);
    assert.equal(result.receipt.task_id, "skill-document-import");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "http://memorax.test/v1/memories/add");
    assert.equal(requests[0].method, "POST");
    assert.equal(requests[0].body.content_type, "document");
    assert.equal(requests[0].body.async_mode, true);
    assert.deepEqual(requests[0].body.documents, [{
      document_id: documentId,
      input_id: inputId,
      expected_revision: 0,
      content,
    }]);
    assert.deepEqual(Buffer.from(requests[0].body.documents[0].content), readFileSync(file));
  });
}

test("work imports reuse accepted receipts only for the same scope and unchanged file", () => {
  const add = readSkillFile("references/memorax-add.md");
  const attachments = add.split("### Document attachment imports")[1].split("### Full document snapshots")[0];

  assert.match(attachments, /current task's known receipts/);
  assert.match(attachments, /Reuse an accepted\s+receipt only when it belongs to the same account\/workspace scope and the same\s+unchanged file/);
  assert.match(attachments, /original upload or a matching SHA-256/);
  assert.match(attachments, /filename alone is not identity evidence/);
  assert.match(attachments, /Acceptance is enough to skip a duplicate\s+Add even while the backend is still processing/);
  assert.match(attachments, /no persistent file-to-document identity cache/);
  assert.match(attachments, /Acceptance alone does not confirm a new revision/);
  assert.match(attachments, /revision is unknown[\s\S]*do not guess a revision or silently create another document/);
  assert.match(attachments, /unchanged\s+user-authorized retry must reuse the exact file, input ID, revision, scope, output\s+language and optional checksum/);
  assert.match(attachments, /Do not retry\s+an uncertain submission automatically or generate a replacement ID/);
  assert.match(attachments, /On failure or `submission_unknown`[\s\S]*do not automatically retransmit the file/);
});

test("work document guidance stops at the upload response and exposes no task polling commands", () => {
  const router = readSkillFile("SKILL.md");
  const add = readSkillFile("references/memorax-add.md");
  const search = readSkillFile("references/memorax-search.md");
  const attachments = add.split("### Document attachment imports")[1].split("### Full document snapshots")[0];
  const uploadCommands = [...attachments.matchAll(/```bash\n([\s\S]*?)\n```/g)]
    .map((match) => match[1].replace(/\\\r?\n\s*/g, " "));

  assert.equal(uploadCommands.length, 1);
  const command = uploadCommands[0];
  assert.match(command, /^memorax-cli add --document-file /);
  assert.match(command, /--expected-revision 0 --json/);
  const documentId = command.match(/--document-id '([^']+)'/)?.[1];
  const inputId = command.match(/--input-id '([^']+)'/)?.[1];
  for (const identity of [documentId, inputId]) {
    assert.match(identity ?? "", /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
  }
  assert.notEqual(documentId, inputId);
  assert.match(attachments, /nonempty[\s\S]*150 MiB/);
  assert.match(attachments, /Wait for the upload HTTP response/);
  assert.match(attachments, /Once accepted, retain the receipt and end the\s+import operation/);
  assert.match(attachments, /Do not query task status or\s+wait for backend processing/);
  assert.match(attachments, /`pending: true` confirms submission only/);
  assert.match(attachments, /Preserve the\s+returned task ID[\s\S]*does not confirm a completed revision/);
  for (const guidance of [router, add, search]) {
    assert.doesNotMatch(guidance, /memorax-cli(?:\.cmd)? add-status\b/);
    assert.doesNotMatch(guidance, /--(?:wait(?:-timeout-ms)?|poll-interval-ms)\b/);
  }
});

test("memorax-code keeps memory-impact attribution bounded and private", () => {
  const router = readSkillFile("SKILL.md");

  assert.match(router, /A Search or read alone is insufficient/);
  assert.match(router, /must literally include `MemoraX Code` and the generic label `Memory`/);
  assert.match(router, /do not include HTML or XML comments, Markdown markers, tags, zero-width text, hidden control text, or metadata/i);
  assert.doesNotMatch(router, /memorax-impact/);
  assert.match(router, /raw memory text, IDs, scores, query text, private paths, or secrets/);
  assert.match(router, /Do not report active Add, automatic writeback, or Repo Memory build or update/);
  assert.match(router, /A personal-memory save, update, or deletion made in the current turn is not memory that helped the current turn/);
});

test("memorax-code retries read-only search once after transport or sandbox failure", () => {
  const memoraxSearch = readSkillFile("references/memorax-search.md");

  assert.match(memoraxSearch, /`fetch failed`/);
  assert.match(memoraxSearch, /retry the same `memorax-cli search` once/);
  assert.match(memoraxSearch, /approved network-enabled execution mode/);
  assert.match(memoraxSearch, /Preserve the same query, workspace, and environment variables/);
  assert.match(memoraxSearch, /Do not apply this retry to `memorax-cli add`/);
  assert.match(memoraxSearch, /authentication or configuration failures, or HTTP errors/);
});

test("memorax-code selects the Windows cmd shim without changing execution policy", () => {
  const skill = readSkillFile("SKILL.md");
  const memoraxSearch = readSkillFile("references/memorax-search.md");
  const memoraxAdd = readSkillFile("references/memorax-add.md");

  for (const guidance of [skill, memoraxSearch, memoraxAdd]) {
    assert.match(guidance, /Windows PowerShell[\s\S]*`memorax-cli\.cmd`/);
    assert.match(guidance, /macOS and Linux[\s\S]*`memorax-cli`/);
    assert.match(guidance, /Never invoke `memorax-cli\.ps1`/);
    assert.match(guidance, /Never run `Set-ExecutionPolicy`/);
  }
  assert.match(memoraxSearch, /memorax-cli\.cmd search --query '/);
  assert.match(memoraxAdd, /memorax-cli\.cmd add --memory '/);
  assert.match(memoraxAdd, /blocked before the CLI starts[\s\S]*retry that command once with `memorax-cli\.cmd`/);
  assert.match(memoraxAdd, /Do not retry Add after the CLI may have started/);
  for (const reference of [memoraxSearch, memoraxAdd]) {
    assert.match(reference, /Windows PowerShell:[\s\S]*two single quotes \(`''`\)/);
    assert.match(reference, /`don't` becomes `'don''t'`/);
    assert.match(reference, /macOS and Linux:[\s\S]*exact POSIX sequence/);
  }
});

test("memorax-code uses POSIX-safe direct CLI arguments", () => {
  const memoraxSearch = readSkillFile("references/memorax-search.md");
  const memoraxAdd = readSkillFile("references/memorax-add.md");
  const guidance = `${memoraxSearch}\n${memoraxAdd}`;

  assert.match(memoraxSearch, /dynamically generated query in single quotes, never double quotes/);
  assert.match(memoraxAdd, /dynamically generated `--memory` and `--reason` value in single quotes, never double quotes/);
  assert.match(guidance, /Treat `\$HOME`, backticks, and `\$\(command\)` as literal text/);
  assert.match(guidance, /exact POSIX sequence/);
});

test("memorax-code declares OpenAI and Claude implicit invocation metadata", () => {
  const openaiYaml = readSkillFile("agents/openai.yaml");
  const claudeYaml = readSkillFile("agents/claude.yaml");

  assert.match(openaiYaml, /display_name: "MemoraX Code"/);
  assert.match(openaiYaml, /default_prompt: "[^"]*\$memorax-code(?=\s|")/);
  assert.match(openaiYaml, /allow_implicit_invocation: true/);

  assert.match(claudeYaml, /display_name: "MemoraX Code"/);
  assert.match(claudeYaml, /default_prompt: "[^"]*\/memorax-code-claude-adapter:memorax-code(?=\s|")/);
  assert.match(claudeYaml, /~\/\.claude\/skills\/memorax-code/);
  assert.match(claudeYaml, /allow_implicit_invocation: true/);
});

test("repo-memory launcher uses Node for an extensionless packaged CLI", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-launcher-"));
  try {
    const pluginRoot = join(root, "plugin");
    const scriptDir = join(pluginRoot, "skills", "memorax-code", "scripts");
    const command = join(root, "memorax-code");
    mkdirSync(scriptDir, { recursive: true });
    copyFileSync(
      join(skillRoot, "scripts", "repo-memory.mjs"),
      join(scriptDir, "repo-memory.mjs"),
    );
    writeFileSync(
      command,
      "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
      { mode: 0o644 },
    );
    writeFileSync(
      join(pluginRoot, ".memorax-code-package.json"),
      `${JSON.stringify({ version: 1, memoraxCodeCommand: command })}\n`,
    );

    const result = spawnSync(
      process.execPath,
      [join(scriptDir, "repo-memory.mjs"), "validate", join(root, "repo with spaces")],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), [
      "repo-memory",
      "validate",
      join(root, "repo with spaces"),
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-memory launcher resolves the runtime from a Claude marketplace layout", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-repo-memory-claude-marketplace-"));
  try {
    const libRoot = join(root, "lib");
    const scriptDir = join(
      libRoot,
      "memorax-code-claude-marketplace",
      "plugins",
      "memorax-code-claude-adapter",
      "skills",
      "memorax-code",
      "scripts",
    );
    const runtimeDir = join(libRoot, "memorax-code-backend", "dist", "repo-memory");
    mkdirSync(scriptDir, { recursive: true });
    mkdirSync(runtimeDir, { recursive: true });
    copyFileSync(
      join(skillRoot, "scripts", "repo-memory.mjs"),
      join(scriptDir, "repo-memory.mjs"),
    );
    writeFileSync(
      join(libRoot, "memorax-code-backend", "package.json"),
      `${JSON.stringify({ type: "module" })}\n`,
    );
    writeFileSync(
      join(runtimeDir, "cli.js"),
      [
        "export async function runRepoMemoryCli(args, { skillDir }) {",
        "  process.stdout.write(JSON.stringify({ args, skillDir }));",
        "  return 0;",
        "}",
        "",
      ].join("\n"),
    );

    const result = spawnSync(
      process.execPath,
      [join(scriptDir, "repo-memory.mjs"), "validate", join(root, "repo")],
      { encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(result.stdout), {
      args: ["validate", join(root, "repo")],
      skillDir: realpathSync(dirname(scriptDir)),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
