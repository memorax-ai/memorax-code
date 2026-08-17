import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillRoot = join(packageRoot, "skills", "memorax-code");
const scriptPath = join(skillRoot, "scripts", "user_profile_memory.py");

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
  const result = spawnSync("python3", [scriptPath, command, "--repo", repo, ...args], {
    cwd: packageRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function runProfileRaw(command, repo, args = []) {
  return spawnSync("python3", [scriptPath, command, "--repo", repo, ...args], {
    cwd: packageRoot,
    encoding: "utf8",
  });
}

function runProfileAsync(command, repo, args = []) {
  return new Promise((resolve) => {
    const child = spawn("python3", [scriptPath, command, "--repo", repo, ...args], {
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
  const skill = readSkillFile("SKILL.md");
  const reference = readSkillFile("references/personal-write.md");
  const readReference = readSkillFile("references/personal-read.md");
  const openaiYaml = readSkillFile("agents/openai.yaml");

  assert.match(skill, /name: memorax-code/);
  assert.match(skill, /durable profile or interaction preferences/);
  assert.match(skill, /personal profile write/);
  assert.match(reference, /\.repo_memory\/user-profile\/preferences\.md/);
  assert.match(reference, /may be saved implicitly/);
  assert.match(reference, /Handle the semantic match before writing/);
  assert.match(reference, /New preference: add a new preference/);
  assert.match(reference, /Equivalent content: do not add a duplicate/);
  assert.match(reference, /Addition or refinement to the same preference: update the existing preference/);
  assert.match(reference, /directly conflicts with or replaces an old preference in the same scope: update the existing id and remove the superseded content/);
  assert.match(reference, /explicitly says a preference no longer applies: delete that preference/);
  assert.match(reference, /environment, tool, or workflow no longer exists: update the scope; delete it if the entire preference is obsolete/);
  assert.match(reference, /Do not modify or delete existing preferences because of a one-time instruction/);
  assert.match(reference, /Do not scan or clean up unrelated preferences/);
  assert.match(reference, /multiple preferences may match, or it is unclear whether the change is durable, ask the user/);
  assert.match(reference, /never use `workflow` or `environment` to store an executable repository procedure/);
  assert.match(reference, /python3 <skill-dir>\/scripts\/user_profile_memory\.py/);
  assert.match(reference, /Do not preserve deleted text elsewhere/);
  assert.match(openaiYaml, /display_name: "MemoraX Code"/);
  assert.match(openaiYaml, /default_prompt: "Use \$memorax-code/);
  assert.match(openaiYaml, /allow_implicit_invocation: true/);

  assert.match(readReference, /user_profile_memory\.py list --repo <repo>/);
  assert.match(readReference, /list operation does not create it/);
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
    assert.equal(listed.preferences[0].id, added.id);
    assert.equal(listed.preferences[0].description, updatedDescription);

    const deleted = runProfile("delete", repo, ["--id", added.id]);
    assert.equal(deleted.status, "deleted");
    assert.equal(deleted.active_count, 0);
    text = readFileSync(preferences, "utf8");
    assert.match(text, /active_count: 0/);
    assert.match(text, /total_count: 0/);
    assert.doesNotMatch(text, /User prefers detailed Chinese answers/);
    assert.doesNotMatch(text, new RegExp(added.id));
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

    const listed = runProfile("list", repo);
    assert.equal(listed.active_count, 2);
    assert.deepEqual(new Set(listed.preferences.map((pref) => pref.id)), new Set([communication.id, workflow.id]));

    const updated = runProfile("update", repo, [
      "--id", workflow.id,
      "--description", "User prefers running focused tests first, then broader validation if the change crosses layers.",
      "--do-not-apply-when", "The user explicitly asks for full validation only.",
    ]);
    assert.equal(updated.active_count, 2);
    let text = readFileSync(preferences, "utf8");
    assert.match(text, /active_count: 2/);
    assert.match(text, /User prefers Chinese answers in this repository\./);
    assert.match(text, /focused tests first, then broader validation/);
    assert.match(text, /The user explicitly asks for full validation only\./);

    const deleted = runProfile("delete", repo, ["--id", communication.id]);
    assert.equal(deleted.active_count, 1);
    text = readFileSync(preferences, "utf8");
    assert.match(text, /active_count: 1/);
    assert.match(text, /total_count: 1/);
    assert.doesNotMatch(text, /Chinese answers/);
    assert.doesNotMatch(text, new RegExp(communication.id));
    assert.match(text, new RegExp(workflow.id));
    assert.match(text, /focused tests first, then broader validation/);

    const missingDelete = runProfileRaw("delete", repo, ["--id", communication.id]);
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

test("documented user-profile lifecycle updates the selected id and physically removes obsolete content", () => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-user-profile-semantic."));
  try {
    const repo = createRepo(root);
    const preferences = join(repo, ".repo_memory", "user-profile", "preferences.md");

    const first = runProfile("add", repo, [
      "--type", "communication",
      "--description", "用户偏好：我喜欢用中文回答。",
      "--applies-when", "回答当前 repo 的问题。",
      "--do-not-apply-when", "用户明确要求其他语言。",
    ]);
    const unrelated = runProfile("add", repo, [
      "--type", "profile",
      "--description", "用户希望在这个 repo 中被称为 Alex。",
      "--applies-when", "在这个 repo 中称呼用户。",
    ]);
    const duplicate = runProfile("add", repo, [
      "--type", "communication",
      "--description", "用户偏好：我喜欢用中文回答。",
      "--applies-when", "回答当前 repo 的问题。",
    ]);
    assert.equal(duplicate.status, "duplicate");
    assert.equal(duplicate.id, first.id);
    assert.equal(duplicate.active_count, 2);

    const candidates = runProfile("list", repo);
    assert.equal(candidates.active_count, 2);
    const selected = candidates.preferences.find((preference) => preference.id === first.id);
    assert.equal(selected?.description, "用户偏好：我喜欢用中文回答。");

    const refined = runProfile("update", repo, [
      "--id", selected.id,
      "--description", "用户偏好：在这个 repo 里希望我用中文回答，除非明确要求其他语言。",
      "--applies-when", "回答当前 repo 的设计、实现、review 或调试问题。",
      "--do-not-apply-when", "用户明确要求英文或其他语言。",
    ]);
    assert.equal(refined.id, first.id);
    assert.equal(refined.active_count, 2);

    let text = readFileSync(preferences, "utf8");
    assert.equal((text.match(/^## Preference /gm) ?? []).length, 2);
    assert.match(text, /active_count: 2/);
    assert.match(text, /在这个 repo 里希望我用中文回答/);
    assert.doesNotMatch(text, /我喜欢用中文回答/);
    assert.match(text, /被称为 Alex/);

    const replaced = runProfile("update", repo, [
      "--id", first.id,
      "--description", "用户偏好：在这个 repo 里默认使用英文回答。",
      "--applies-when", "回答当前 repo 的问题。",
      "--do-not-apply-when", "用户明确要求其他语言。",
    ]);
    assert.equal(replaced.id, first.id);
    assert.equal(replaced.active_count, 2);

    text = readFileSync(preferences, "utf8");
    assert.match(text, /默认使用英文回答/);
    assert.doesNotMatch(text, /在这个 repo 里希望我用中文回答/);
    assert.match(text, /被称为 Alex/);

    const deleted = runProfile("delete", repo, ["--id", first.id]);
    assert.equal(deleted.status, "deleted");
    assert.equal(deleted.active_count, 1);

    text = readFileSync(preferences, "utf8");
    assert.match(text, /active_count: 1/);
    assert.match(text, new RegExp(unrelated.id));
    assert.match(text, /被称为 Alex/);
    assert.doesNotMatch(text, new RegExp(first.id));
    assert.doesNotMatch(text, /默认使用英文回答/);
    assert.doesNotMatch(text, /- Status: `(deleted|superseded)`/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("repo memory user-profile skill files exist", () => {
  assert.equal(existsSync(join(skillRoot, "SKILL.md")), true);
  assert.equal(existsSync(join(skillRoot, "agents", "openai.yaml")), true);
  assert.equal(existsSync(scriptPath), true);
  assert.equal(existsSync(join(skillRoot, "references", "personal-read.md")), true);
  assert.equal(existsSync(join(skillRoot, "references", "personal-write.md")), true);
});
