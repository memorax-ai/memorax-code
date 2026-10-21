import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { sharedRepoMemoryPath } from "../../packages/ts/memorax-code-adapter-common/src/repo-memory/repo-memory-shared-bundle.mjs";

const sourceSkill = fileURLToPath(new URL("../../packages/ts/memorax-code-codex-adapter/skills/memorax-code/", import.meta.url));
const backendEntrypoint = fileURLToPath(new URL("../../packages/ts/memorax-code-backend/dist/repo-memory.js", import.meta.url));

test("standalone Qoder Repo Memory launcher preserves installation context and explicit overrides", (t) => {
  const root = fixture(t);
  const skill = join(root, "user", ".qoder", "skills", "memorax-code");
  const installedHome = join(root, "installed memory");
  const explicitHome = join(root, "explicit memory");
  const explicitSkill = join(root, "explicit skill");
  const command = mockBackend(root);
  copyLauncher(skill);
  writeJson(join(skill, "defaults.json"), { summaryChars: 777 });
  writeJson(join(explicitSkill, "defaults.json"), { summaryChars: 888 });
  writeJson(join(skill, ".memorax-code-package.json"), { memoraxCodeHome: installedHome, memoraxCodeCommand: command });

  for (const overrides of [{}, { MEMORAX_CODE_HOME: explicitHome }, {
    MEMORAX_CODE_HOME: explicitHome, MEMORAX_CODE_REPO_MEMORY_SKILL_DIR: explicitSkill,
  }]) {
    const result = launch(root, skill, ["collect", "--repo-path", join(root, "repo with spaces")], overrides);
    assert.equal(result.status, 7, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      args: ["collect", "--repo-path", join(root, "repo with spaces")],
      home: overrides.MEMORAX_CODE_HOME ?? installedHome,
      skillDir: overrides.MEMORAX_CODE_REPO_MEMORY_SKILL_DIR ?? skill,
      defaults: { summaryChars: overrides.MEMORAX_CODE_REPO_MEMORY_SKILL_DIR ? 888 : 777 },
    });
  }
});

test("packaged Repo Memory launcher uses Skill then package home metadata without replacing explicit environment", (t) => {
  const root = fixture(t);
  mockBackend(root);
  const plugin = join(root, "lib", "memorax-code-codex-adapter");
  const skill = join(plugin, "skills", "memorax-code");
  copyLauncher(skill);
  const skillHome = join(root, "skill memory");
  const pluginHome = join(root, "plugin memory");
  const explicitHome = join(root, "explicit memory");
  for (const scenario of [
    { skillHome, pluginHome, expected: skillHome },
    { pluginHome, expected: pluginHome },
    { skillHome, pluginHome, env: { MEMORAX_CODE_HOME: explicitHome }, expected: explicitHome },
    { expected: null },
  ]) {
    writeJson(join(skill, ".memorax-code-package.json"), { memoraxCodeHome: scenario.skillHome });
    writeJson(join(plugin, ".memorax-code-package.json"), { memoraxCodeHome: scenario.pluginHome });
    const result = launch(root, skill, ["validate", join(root, "repo")], scenario.env);
    assert.equal(result.status, 7, result.stderr);
    assert.equal(JSON.parse(result.stdout).home, scenario.expected);
  }
});

test("standalone Qoder Repo Memory resolve reads the configured shared bundle without an inherited home", (t) => {
  const root = fixture(t);
  const skill = join(root, "user", ".qoder", "skills", "memorax-code");
  const home = join(root, "installed memory");
  const repo = join(root, "repo");
  mkdirSync(repo);
  copyLauncher(skill);
  writeJson(join(skill, ".memorax-code-package.json"), { memoraxCodeHome: home, memoraxCodeCommand: backendEntrypoint });
  const bundle = sharedRepoMemoryPath(home, repo);
  const memory = join(bundle, ".repo_memory");
  const head = "a".repeat(40);
  writeJson(join(bundle, "baseline.json"), { schema: "repo_memory_shared_bundle.v1", repository: repo, head });
  writeJson(join(memory, "raw", "git-commits.json"), []);
  writeFileSync(join(memory, "PROFILE.md"), `---\nschema: "repo_memory_profile.v0.1"\nlocal_head: "${head}"\n---\n\n# Synthetic repository\n`);
  for (const [name, schema] of [["commits", "commit"], ["prs", "pr"], ["issues", "issue"]]) {
    mkdirSync(join(memory, "resources"), { recursive: true });
    writeFileSync(join(memory, "resources", `${name}.md`), `---\nschema: "repo_memory_${schema}_resource.v0.1"\nsource: "history_disabled"\nresource_count: 0\ntrust_state: "unavailable_local_only"\nraw_source: ""\n---\n\n# Synthetic ${name}\n`);
  }
  const result = launch(root, skill, ["resolve", "--repo-path", repo]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ok: true, reason: "shared_baseline_in_use", memoryPath: memory, sharedBaseline: { head } });
});

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "memorax-repo-launcher-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function copyLauncher(skill) {
  mkdirSync(join(skill, "scripts"), { recursive: true });
  copyFileSync(join(sourceSkill, "scripts", "repo-memory.mjs"), join(skill, "scripts", "repo-memory.mjs"));
}

function mockBackend(root) {
  const backend = join(root, "lib", "memorax-code-backend", "dist");
  writeJson(join(root, "package.json"), { type: "module" });
  mkdirSync(join(backend, "repo-memory"), { recursive: true });
  copyFileSync(backendEntrypoint, join(backend, "repo-memory.js"));
  writeFileSync(join(backend, "repo-memory", "cli.js"), [
    'import { readFileSync } from "node:fs";',
    'import { join } from "node:path";',
    "export function runRepoMemoryCli(args, { skillDir }) {",
    '  const defaults = JSON.parse(readFileSync(join(skillDir, "defaults.json"), "utf8"));',
    "  process.stdout.write(JSON.stringify({ args, home: process.env.MEMORAX_CODE_HOME ?? null, skillDir, defaults }));",
    "  return 7;",
    "}",
  ].join("\n"));
  writeJson(join(root, "lib", "memorax-code-codex-adapter", "skills", "memorax-code", "defaults.json"), { summaryChars: 4000 });
  return join(backend, "repo-memory.js");
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function launch(root, skill, args, overrides = {}) {
  const home = join(root, "user");
  return spawnSync(process.execPath, [join(skill, "scripts", "repo-memory.mjs"), ...args], {
    cwd: root,
    env: {
      HOME: home, PATH: join(root, "empty-bin"),
      ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, USERPROFILE: home } : {}),
      ...overrides,
    },
    encoding: "utf8", timeout: 5000, windowsHide: true,
  });
}
