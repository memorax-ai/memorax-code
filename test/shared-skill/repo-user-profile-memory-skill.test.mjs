import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildRepoUserProfilePreferencesContext } from "../../packages/ts/memorax-code-adapter-common/src/repo-memory/repo-user-profile-context.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../packages/ts/memorax-code-codex-adapter");
const skillRoot = join(packageRoot, "skills", "memorax-code");
const scriptPath = join(skillRoot, "scripts", "user-profile-memory.mjs");

function readSkillFile(path) {
  return readFileSync(join(skillRoot, path), "utf8");
}

function runGit(cwd, args) {
  const result = spawnSync(
    "git",
    ["-c", "user.name=User Profile Test", "-c", "user.email=user-profile-test@example.invalid", ...args],
    { cwd, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

function createRepo(root) {
  const repo = join(root, "repo");
  mkdirSync(repo);
  runGit(repo, ["init", "-b", "main"]);
  writeFileSync(join(repo, "README.md"), "# Test repo\n");
  runGit(repo, ["add", "README.md"]);
  runGit(repo, ["commit", "-m", "initial docs"]);
  return repo;
}

function runProfile(command, repo, args = []) {
  const result = spawnSync(process.execPath, [scriptPath, command, "--repo", repo, ...args], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function runProfileRaw(command, repo, args = []) {
  return spawnSync(process.execPath, [scriptPath, command, "--repo", repo, ...args], {
    cwd: packageRoot,
    encoding: "utf8",
  });
}

function runProfileAsync(command, repo, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath, command, "--repo", repo, ...args], {
      cwd: packageRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

test("repo memory skills route user-profile reads and writes", () => {
  const reference = readSkillFile("references/personal-write.md");
  const readReference = readSkillFile("references/personal-read.md");

  assert.match(reference, /\.repo_memory\/user-profile\/preferences\.md/);
  assert.match(reference, /Require the user to explicitly ask/);
  assert.match(reference, /may be saved implicitly/);
  assert.match(reference, /Do not modify or delete existing preferences because of a one-time instruction/);
  assert.match(reference, /Do not scan or clean up unrelated preferences/);
  assert.match(reference, /multiple preferences may match, or it is unclear whether the change is durable, ask the user/);
  assert.match(reference, /never use `workflow` or `environment` to store an executable repository procedure/);
  assert.match(reference, /node <skill-dir>\/scripts\/user-profile-memory\.mjs/);
  assert.match(reference, /Do not preserve deleted text elsewhere/);

  assert.match(readReference, /user-profile-memory\.mjs list --repo <repo>/);
  assert.match(readReference, /Do not write, normalize, migrate, repair, or delete memory/);
});

test("repo-user-profile-memory script performs add duplicate update delete with counts", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-user-profile-crud."));
  try {
    const repo = createRepo(root);
    const preferences = join(repo, ".repo_memory", "user-profile", "preferences.md");
    const events = join(repo, ".repo_memory", "user-profile", "events.jsonl");
    const originalDescription = "User prefers 中文 answers: use `brief` style. ## injected\n---\nNext line";

    const added = runProfile("add", repo, [
      "--type", "communication",
      "--description", originalDescription,
      "--applies-when", "Answering repo questions: reviews\nand debugging.",
      "--do-not-apply-when", "User asks for English.",
    ]);
    assert.equal(added.status, "added");
    assert.match(added.id, /^pref_\d{8}_/);
    assert.equal(added.active_count, 1);
    assert.equal(added.total_count, 1);
    assert.equal(readFileSync(join(repo, ".gitignore"), "utf8"), ".repo_memory/\n");
    assert.equal(existsSync(preferences), true);
    assert.equal(existsSync(events), false);

    let text = readFileSync(preferences, "utf8");
    assert.match(text, /active_count: 1/);
    assert.match(text, /total_count: 1/);
    assert.match(text, new RegExp(`## Preference ${added.id}`));
    assert.match(text, /- Type: `communication`/);
    assert.match(text, /- Description: User prefers 中文 answers: use `brief` style\. ## injected --- Next line/);
    assert.doesNotMatch(text, /^## injected$/m);
    assert.doesNotMatch(text, /^--- Next line$/m);

    const duplicate = runProfile("add", repo, [
      "--type", "communication",
      "--description", originalDescription,
      "--applies-when", "Answering repo questions.",
    ]);
    assert.equal(duplicate.status, "duplicate");
    assert.equal(duplicate.id, added.id);
    assert.equal(duplicate.active_count, 1);
    assert.equal((readFileSync(preferences, "utf8").match(/^## Preference /gm) ?? []).length, 1);

    const contentAlreadyPresent = runProfile("add", repo, [
      "--type", "profile",
      "--description", "User prefers 中文 answers",
      "--applies-when", "Handling profile-related requests.",
    ]);
    assert.equal(contentAlreadyPresent.status, "duplicate");
    assert.equal(contentAlreadyPresent.id, added.id);
    assert.equal(contentAlreadyPresent.active_count, 1);
    assert.equal((readFileSync(preferences, "utf8").match(/^## Preference /gm) ?? []).length, 1);

    const updatedDescription = "User prefers detailed Chinese answers with reasons.";
    const updated = runProfile("update", repo, [
      "--id", added.id,
      "--description", updatedDescription,
      "--applies-when", "Planning, review, and implementation discussions.",
    ]);
    assert.equal(updated.status, "updated");
    assert.equal(updated.id, added.id);
    assert.equal(updated.active_count, 1);
    assert.equal(updated.total_count, 1);
    text = readFileSync(preferences, "utf8");
    assert.match(text, /active_count: 1/);
    assert.match(text, /total_count: 1/);
    assert.match(text, /User prefers detailed Chinese answers with reasons\./);
    assert.doesNotMatch(text, /use `brief` style/);
    assert.doesNotMatch(text, /- Created: ``/);
    assert.doesNotMatch(text, /- Updated: ``/);
    assert.equal((text.match(new RegExp(added.id, "g")) ?? []).length, 2);

    const listed = runProfile("list", repo);
    assert.equal(listed.active_count, 1);
    assert.equal(listed.total_count, 1);
    assert.equal(listed.preferences[0].id, added.id);
    assert.equal(listed.preferences[0].description, updatedDescription);
    assert.equal(listed.preferences[0].applies_when, "Planning, review, and implementation discussions.");
    assert.equal(listed.preferences[0].do_not_apply_when, "User asks for English.");

    const deleted = runProfile("delete", repo, ["--id", added.id]);
    assert.equal(deleted.status, "deleted");
    assert.equal(deleted.active_count, 0);
    text = readFileSync(preferences, "utf8");
    assert.match(text, /active_count: 0/);
    assert.match(text, /total_count: 0/);
    assert.doesNotMatch(text, /User prefers detailed Chinese answers/);
    assert.doesNotMatch(text, new RegExp(added.id));
    assert.doesNotMatch(text, /- Status: `(deleted|superseded)`/);
    assert.equal(existsSync(events), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-user-profile-memory script works outside a git repository", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-user-profile-non-git."));
  try {
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const added = runProfile("add", workspace, [
      "--type", "profile",
      "--description", "User prefers to be called Alex in this workspace.",
      "--applies-when", "Addressing the user in this workspace.",
    ]);
    assert.equal(added.status, "added");
    assert.equal(added.active_count, 1);
    assert.equal(existsSync(join(workspace, ".repo_memory", "user-profile", "preferences.md")), true);
    assert.equal(readFileSync(join(workspace, ".gitignore"), "utf8"), ".repo_memory/\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-user-profile-memory script keeps multiple entries isolated during update and delete", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-user-profile-multiple."));
  try {
    const repo = createRepo(root);
    const preferences = join(repo, ".repo_memory", "user-profile", "preferences.md");

    writeFileSync(join(repo, ".gitignore"), "node_modules\n");
    const communication = runProfile("add", repo, [
      "--type", "communication",
      "--description", "User prefers Chinese answers in this repository.",
      "--applies-when", "Answering repo-local questions.",
    ]);
    const workflow = runProfile("add", repo, [
      "--type", "workflow",
      "--description", "User prefers focused tests before broad validation.",
      "--applies-when", "Choosing validation commands after code changes.",
    ]);
    assert.notEqual(communication.id, workflow.id);
    assert.equal(workflow.active_count, 2);
    assert.equal(readFileSync(join(repo, ".gitignore"), "utf8"), "node_modules\n.repo_memory/\n");

    const duplicate = runProfile("add", repo, [
      "--type", "workflow",
      "--description", "User prefers focused tests before broad validation.",
      "--applies-when", "Choosing validation commands.",
    ]);
    assert.equal(duplicate.status, "duplicate");
    assert.equal(duplicate.id, workflow.id);
    assert.equal(duplicate.active_count, 2);
    assert.equal(duplicate.total_count, 2);

    const listed = runProfile("list", repo);
    assert.equal(listed.active_count, 2);
    assert.deepEqual(new Set(listed.preferences.map((pref) => pref.id)), new Set([communication.id, workflow.id]));
    const selected = listed.preferences.find((preference) => preference.id === workflow.id);
    assert.equal(selected?.description, "User prefers focused tests before broad validation.");

    const updated = runProfile("update", repo, [
      "--id", selected.id,
      "--description", "User prefers running focused tests first, then broader validation if the change crosses layers.",
      "--do-not-apply-when", "The user explicitly asks for full validation only.",
    ]);
    assert.equal(updated.id, workflow.id);
    assert.equal(updated.active_count, 2);
    let text = readFileSync(preferences, "utf8");
    assert.match(text, /active_count: 2/);
    assert.match(text, /total_count: 2/);
    assert.equal((text.match(/^## Preference /gm) ?? []).length, 2);
    assert.match(text, /User prefers Chinese answers in this repository\./);
    assert.match(text, /focused tests first, then broader validation/);
    assert.doesNotMatch(text, /User prefers focused tests before broad validation\./);
    assert.match(text, /Choosing validation commands after code changes\./);
    assert.match(text, /The user explicitly asks for full validation only\./);

    const replaced = runProfile("update", repo, [
      "--id", workflow.id,
      "--description", "用户偏好：跨层改动后直接运行完整验证。",
    ]);
    assert.equal(replaced.id, workflow.id);
    assert.equal(replaced.active_count, 2);
    assert.equal(replaced.total_count, 2);
    text = readFileSync(preferences, "utf8");
    assert.equal((text.match(/^## Preference /gm) ?? []).length, 2);
    assert.match(text, /用户偏好：跨层改动后直接运行完整验证。/);
    assert.doesNotMatch(text, /focused tests first, then broader validation/);
    assert.doesNotMatch(text, /User prefers focused tests before broad validation\./);
    assert.match(text, /Choosing validation commands after code changes\./);
    assert.match(text, /The user explicitly asks for full validation only\./);
    assert.match(text, /User prefers Chinese answers in this repository\./);
    assert.doesNotMatch(text, /- Status: `(deleted|superseded)`/);

    const deleted = runProfile("delete", repo, ["--id", workflow.id]);
    assert.equal(deleted.status, "deleted");
    assert.equal(deleted.active_count, 1);
    text = readFileSync(preferences, "utf8");
    assert.match(text, /active_count: 1/);
    assert.match(text, /total_count: 1/);
    assert.match(text, new RegExp(communication.id));
    assert.match(text, /User prefers Chinese answers in this repository\./);
    assert.doesNotMatch(text, new RegExp(workflow.id));
    assert.doesNotMatch(text, /用户偏好：跨层改动后直接运行完整验证。/);
    assert.doesNotMatch(text, /focused tests first, then broader validation/);
    assert.doesNotMatch(text, /- Status: `(deleted|superseded)`/);

    const missingDelete = runProfileRaw("delete", repo, ["--id", workflow.id]);
    assert.notEqual(missingDelete.status, 0);
    assert.match(missingDelete.stderr, /Preference id not found/);

    const missingUpdate = runProfileRaw("update", repo, [
      "--id", "pref_20990101_missing",
      "--description", "This should not be written.",
    ]);
    assert.notEqual(missingUpdate.status, 0);
    assert.match(missingUpdate.stderr, /Preference id not found/);
    assert.doesNotMatch(readFileSync(preferences, "utf8"), /This should not be written/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-user-profile-memory script preserves concurrent adds with a cross-process lock", async () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-user-profile-concurrent."));
  try {
    const repo = createRepo(root);
    const preferences = join(repo, ".repo_memory", "user-profile", "preferences.md");

    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => runProfileAsync("add", repo, [
      "--type", index % 2 === 0 ? "communication" : "workflow",
      "--description", `token${String(index).padStart(2, "0")} concurrent repo user preference.`,
      "--applies-when", `Handling concurrent preference ${index}.`,
    ])));

    for (const result of results) {
      assert.equal(result.status, 0, result.stderr || result.stdout);
      assert.equal(JSON.parse(result.stdout).status, "added");
    }
    const listed = runProfile("list", repo);
    assert.equal(listed.active_count, 20);
    assert.equal(listed.total_count, 20);
    assert.equal(new Set(listed.preferences.map((pref) => pref.description)).size, 20);
    const text = readFileSync(preferences, "utf8");
    assert.match(text, /active_count: 20/);
    assert.match(text, /total_count: 20/);
    assert.equal((text.match(/^## Preference /gm) ?? []).length, 20);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-user-profile-memory script fails closed on corrupt preferences", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-user-profile-corrupt."));
  try {
    const repo = createRepo(root);
    const dir = join(repo, ".repo_memory", "user-profile");
    const preferences = join(dir, "preferences.md");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(repo, ".gitignore"), ".repo_memory/\n");
    const corrupt = [
      "---",
      'schema: "wrong"',
      'scope: "repo"',
      'owner: "repo-user-profile-memory"',
      'trust_state: "user_stated"',
      "active_count: 1",
      "total_count: 1",
      "---",
      "",
      "## Preference pref_20260710_corrupt",
      "",
      "- Type: `communication`",
      "- Status: `active`",
      "- Description: Corrupt content should not be overwritten.",
      "",
    ].join("\n");
    writeFileSync(preferences, corrupt);

    const add = runProfileRaw("add", repo, [
      "--type", "communication",
      "--description", "This add must fail closed.",
      "--applies-when", "Testing corrupt storage.",
    ]);
    const update = runProfileRaw("update", repo, [
      "--id", "pref_20260710_corrupt",
      "--description", "This update must fail closed.",
    ]);
    const deleted = runProfileRaw("delete", repo, ["--id", "pref_20260710_corrupt"]);
    const listed = runProfileRaw("list", repo);

    for (const result of [add, update, deleted, listed]) {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Invalid repo user profile preferences/);
    }
    assert.equal(readFileSync(preferences, "utf8"), corrupt);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo-user-profile-memory script rejects oversized writes without changing preferences", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-user-profile-oversized."));
  try {
    const repo = createRepo(root);
    const preferences = join(repo, ".repo_memory", "user-profile", "preferences.md");
    const seeded = runProfile("add", repo, [
      "--type", "communication",
      "--description", "User prefers concise answers in this repository.",
      "--applies-when", "Answering repo-local questions.",
    ]);
    const original = readFileSync(preferences, "utf8");
    const oversizedDescription = "界".repeat(24 * 1024);

    const add = runProfileRaw("add", repo, [
      "--type", "profile",
      "--description", oversizedDescription,
      "--applies-when", "Answering repo-local questions.",
    ]);
    assert.notEqual(add.status, 0);
    assert.match(add.stderr, /rendered preferences\.md exceeds 65536 bytes/);
    assert.equal(readFileSync(preferences, "utf8"), original);

    const update = runProfileRaw("update", repo, [
      "--id", seeded.id,
      "--description", oversizedDescription,
    ]);
    assert.notEqual(update.status, 0);
    assert.match(update.stderr, /rendered preferences\.md exceeds 65536 bytes/);
    assert.equal(readFileSync(preferences, "utf8"), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the Node profile writer preserves read-only listing and feeds the existing context reader", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-profile 中文 "));
  try {
    const repo = createRepo(root);
    const options = { adapterDir: "codex", sessionKeyPrefix: "codex", debugEnv: "MEMORAX_CODE_CODEX_HOOK_DEBUG" };
    assert.deepEqual(runProfile("list", repo).preferences, []);
    assert.equal(existsSync(join(repo, ".repo_memory")), false);
    assert.equal(existsSync(join(repo, ".gitignore")), false);

    const added = runProfile("add", repo, [
      "--type", "communication",
      "--description", "用户希望用中文回答。",
      "--applies-when", "解释当前仓库。",
    ]);
    assert.match(buildRepoUserProfilePreferencesContext({ cwd: repo }, options), /用户希望用中文回答。/);
    runProfile("update", repo, ["--id", added.id, "--description", "用户希望先给出结论。"]);
    const updatedContext = buildRepoUserProfilePreferencesContext({ cwd: repo }, options);
    assert.match(updatedContext, /用户希望先给出结论。/);
    assert.doesNotMatch(updatedContext, /用户希望用中文回答。/);
    runProfile("delete", repo, ["--id", added.id]);
    assert.equal(buildRepoUserProfilePreferencesContext({ cwd: repo }, options), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
