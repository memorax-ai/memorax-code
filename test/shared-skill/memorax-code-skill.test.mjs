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
  assert.match(memoraxSearch, /`workspace_scope_mismatch` or `workspace_scope_unavailable`/);
  assert.match(memoraxSearch, /Do not change the CLI working directory and retry/);
  assert.match(memoraxSearch, /`workspaceScopeFallbackReason: git_metadata_invalid`/);
  assert.match(memoraxSearch, /successful Search returns `quotaNotice`/);
  assert.match(memoraxSearch, /Never run `memorax-code account --show-mark-id` for the user/);
  assert.doesNotMatch(memoraxSearch, /--query-file/);
  assert.match(memoraxAdd, /CODE_AGENT_MEMORY/);
  assert.match(memoraxAdd, /memorax-cli add[\s\S]*--memory '/);
  assert.match(memoraxAdd, /`workspace_scope_mismatch` or `workspace_scope_unavailable`/);
  assert.match(memoraxAdd, /Do not change the CLI working directory and retry/);
  assert.match(memoraxAdd, /`workspaceScopeFallbackReason: git_metadata_invalid`/);
  assert.match(memoraxAdd, /successful Add returns `quotaNotice`/);
  assert.match(memoraxAdd, /Never run `memorax-code account --show-mark-id` for the user/);
  assert.doesNotMatch(memoraxAdd, /--memory-file/);
  assert.match(repoRead, /Current implementation claims and code edits still require live-code verification/);
  assert.match(repoBuild, /scripts\/repo-memory\.mjs collect/);
  assert.match(repoUpdate, /scripts\/repo-memory\.mjs detect-updates/);
});

test("memorax-code keeps memory-impact attribution bounded and private", () => {
  const router = readSkillFile("SKILL.md");

  assert.match(router, /A Search or read alone is insufficient/);
  assert.match(router, /must literally include `MemoraX Code` and the generic label `Memory`/);
  assert.match(router, /do not include HTML or XML comments, Markdown markers, tags, zero-width text, hidden control text, or metadata/i);
  assert.doesNotMatch(router, /memorax-impact/);
  assert.match(router, /raw memory text, IDs, scores, query text, private paths, or secrets/);
  assert.match(router, /Do not report active Add, automatic writeback, Repo Memory build or update, or automatic coding-memory retrieval/);
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
