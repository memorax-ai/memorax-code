import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../../dist/user-profile.js", import.meta.url));
// Captured from the previous writer; the second entry represents its supported
// legacy inactive-record format. Tests do not need the previous interpreter.
const legacyFixture = readFileSync(new URL("./fixtures/legacy-preferences.md", import.meta.url), "utf8");

function workspace(t, name = "home with 中文 spaces") {
  const root = mkdtempSync(join(tmpdir(), "memorax-user-profile-ts-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, name);
  mkdirSync(home);
  return realpathSync(home);
}

function preferencesPath(home) {
  return join(home, "personal-memory", "user-profile", "preferences.md");
}

function raw(command, home, args = [], options = {}) {
  return spawnSync(process.execPath, [cli, "user-profile", command, "--home", home, ...args], {
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
}

function run(command, home, args = [], options = {}) {
  const result = raw(command, home, args, options);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function seed(home, text = legacyFixture) {
  const path = preferencesPath(home);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

test("legacy preferences retain IDs, fields and timestamps across CRLF updates and old lock files", (t) => {
  for (const oldLock of [Buffer.alloc(0), Buffer.from([0])]) {
    const repo = workspace(t, `legacy-${oldLock.length}`);
    const original = legacyFixture.replaceAll("\n", "\r\n");
    const path = seed(repo, original);
    const oldLockPath = join(dirname(path), ".preferences.lock");
    writeFileSync(oldLockPath, oldLock);

    const listed = run("list", repo);
    assert.equal(listed.active_count, 1);
    assert.equal(listed.total_count, 1);
    assert.deepEqual(listed.preferences, [{
      id: "pref_20260710_legacy-workflow",
      type: "workflow",
      description: "User prefers concise 中文 replies: use `short` answers.",
      applies_when: "Answering questions in this repository.",
      do_not_apply_when: "The user requests detailed reasoning.",
      created: "2026-07-10T09:00:00.000Z",
      updated: "2026-07-10T10:00:00.000Z",
      confidence: "user_stated",
      status: "active",
    }]);
    assert.equal(readFileSync(path, "utf8"), original);

    const id = listed.preferences[0].id;
    run("update", repo, ["--id", id, "--description", "User prefers concise 中文 explanations."]);
    const current = run("list", repo).preferences[0];
    assert.equal(current.id, id);
    assert.equal(current.created, listed.preferences[0].created);
    assert.notEqual(current.updated, listed.preferences[0].updated);
    assert.equal(current.applies_when, listed.preferences[0].applies_when);
    assert.equal(current.do_not_apply_when, listed.preferences[0].do_not_apply_when);
    const text = readFileSync(path, "utf8");
    assert.doesNotMatch(text, /\r|Obsolete nickname|pref_20260710_removed-profile/);
    assert.match(text, /active_count: 1\ntotal_count: 1/);
    assert.deepEqual(readFileSync(oldLockPath), oldLock);
    assert.equal(existsSync(`${path}.lock`), false);
    assert.deepEqual(readdirSync(dirname(path)).sort(), [".preferences.lock", "preferences.md"]);
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
  }
});

test("listing an empty global home is read-only", (t) => {
  const repo = workspace(t);
  const nested = join(dirname(repo), "nested", "folder");
  mkdirSync(nested, { recursive: true });
  const listed = run("list", repo, [], { cwd: nested });
  assert.equal(listed.active_count, 0);
  assert.deepEqual(listed.preferences, []);
  assert.equal(listed.preferences_path, preferencesPath(repo));
  assert.equal(existsSync(join(repo, "personal-memory")), false);
});

test("global preferences are shared across non-git working directories and ignore old repo storage", (t) => {
  const home = workspace(t, "global-home");
  const root = dirname(home);
  const firstCwd = join(root, "first-cwd");
  const secondCwd = join(root, "second-cwd");
  mkdirSync(firstCwd);
  mkdirSync(secondCwd);
  const oldPath = join(firstCwd, ".repo_memory", "user-profile", "preferences.md");
  mkdirSync(dirname(oldPath), { recursive: true });
  const oldRepoFixture = legacyFixture
    .replace("user_profile_memory.v0.1", "repo_user_profile_memory.v0.1")
    .replace('scope: "user"', 'scope: "repo"')
    .replace('owner: "user-profile-memory"', 'owner: "repo-user-profile-memory"');
  writeFileSync(oldPath, oldRepoFixture);

  const initial = run("list", home, [], { cwd: firstCwd });
  assert.deepEqual(initial.preferences, []);
  assert.equal(existsSync(preferencesPath(home)), false);
  assert.equal(readFileSync(oldPath, "utf8"), oldRepoFixture);

  const added = run("add", home, [
    "--type", "communication",
    "--description", "User prefers global answers.",
    "--applies-when", "Answering questions from any working directory.",
  ], { cwd: secondCwd });
  assert.equal(added.active_count, 1);
  const listed = run("list", home, [], { cwd: firstCwd });
  assert.equal(listed.preferences[0].description, "User prefers global answers.");
  assert.equal(listed.preferences_path, preferencesPath(home));
  assert.equal(readFileSync(oldPath, "utf8"), oldRepoFixture);
  assert.equal(existsSync(join(firstCwd, ".gitignore")), false);
  assert.equal(existsSync(join(secondCwd, ".gitignore")), false);
});

test("CLI defaults to MEMORAX_CODE_HOME when --home is omitted", (t) => {
  const home = workspace(t, "configured-global-home");
  const result = raw("add", home, [
    "--type", "workflow", "--description", "Keep preferences across repositories.",
    "--applies-when", "Always.",
  ], { env: { ...process.env, MEMORAX_CODE_HOME: home } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const stored = readFileSync(preferencesPath(home), "utf8");
  assert.match(stored, /scope: "user"/);
  assert.match(stored, /owner: "user-profile-memory"/);
});

test("Unicode case folding preserves multilingual duplicate detection without merging dotless i", (t) => {
  const repo = workspace(t);
  const pairs = [
    ["Straße", "STRASSE"], ["ẞ", "ss"], ["ΟΣ", "οσ"], ["ος", "οσ"],
    ["ﬀ", "FF"], ["Ꭰ", "ꭰ"], ["ᏸ", "Ᏸ"], ["İ", "i\u0307"],
  ];
  for (const [index, [stored, requested]] of pairs.entries()) {
    const prefix = `key${String(index).padStart(2, "0")} `;
    const added = run("add", repo, ["--type", "profile", "--description", prefix + stored, "--applies-when", "In this repo."]);
    const duplicate = run("add", repo, ["--type", "communication", "--description", prefix + requested, "--applies-when", " in THIS   repo. "]);
    assert.equal(duplicate.status, "duplicate", `${stored} / ${requested}`);
    assert.equal(duplicate.id, added.id);
  }
  const latin = run("add", repo, ["--type", "profile", "--description", "dotless I", "--applies-when", "In this repo."]);
  const dotless = run("add", repo, ["--type", "profile", "--description", "dotless ı", "--applies-when", "In this repo."]);
  assert.equal(dotless.status, "added");
  assert.notEqual(dotless.id, latin.id);

  const unscoped = run("add", repo, ["--type", "profile", "--description", "Use short answers.", "--applies-when", ""]);
  const duplicate = run("add", repo, [
    "--type", "communication", "--description", "  USE short answers. ",
    "--applies-when", "-", "--do-not-apply-when", "-",
  ]);
  assert.equal(duplicate.status, "duplicate");
  assert.equal(duplicate.id, unscoped.id);
});

test("field normalization preserves the previous whitespace and literal BOM semantics", (t) => {
  const repo = workspace(t);
  run("add", repo, [
    "--type", "communication", "--description", " \u0085User\u001cprefers\n中文\u3000answers. ",
    "--applies-when", "\uFEFFLiteral BOM remains content.\uFEFF",
    "--do-not-apply-when", "\tA one-time override.\r\n",
  ]);
  const pref = run("list", repo).preferences[0];
  assert.equal(pref.description, "User prefers 中文 answers.");
  assert.equal(pref.applies_when, "\uFEFFLiteral BOM remains content.\uFEFF");
  assert.equal(pref.do_not_apply_when, "A one-time override.");
});

test("duplicate detection preserves distinct descriptions, scopes and exceptions", (t) => {
  const original = ["Use English in comments.", "Writing public docs.", "User requests Chinese."];
  const changes = [
    ["Use English in comments.", "Writing commit messages.", original[2]],
    [original[0], original[1], "Translating external documents."],
    ["English in comments.", original[1], original[2]],
    [original[1], original[1], original[2]],
    [original[2], original[1], original[2]],
  ];
  for (const [index, changed] of changes.entries()) {
    const repo = workspace(t, `distinct-${index}`);
    const add = ([description, scope, exception]) => run("add", repo, [
      "--type", "communication", "--description", description,
      "--applies-when", scope, "--do-not-apply-when", exception,
    ]);
    const first = add(original);
    const second = add(changed);
    assert.equal(second.status, "added", JSON.stringify(changed));
    assert.notEqual(second.id, first.id);
    assert.equal(run("list", repo).active_count, 2);
  }
});

test("blank descriptions are rejected before creating or rewriting storage", (t) => {
  for (const command of ["add", "update"]) {
    const repo = workspace(t, command);
    const path = command === "update" ? seed(repo) : preferencesPath(repo);
    const args = command === "add"
      ? ["--type", "communication", "--applies-when", "In this repo."]
      : ["--id", "pref_20260710_legacy-workflow"];
    for (const description of ["", " \t\u0085\u001c\u3000 "]) {
      const result = raw(command, repo, [...args, "--description", description]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /description must not be empty/);
      if (command === "update") {
        assert.equal(readFileSync(path, "utf8"), legacyFixture);
        assert.equal(existsSync(join(repo, "personal-memory")), true);
        assert.equal(run("list", repo).active_count, 1);
      } else {
        assert.equal(existsSync(join(repo, "personal-memory")), false);
      }
    }
  }
});

test("invalid UTF-8 is rejected without rewriting existing preferences", (t) => {
  const repo = workspace(t);
  const bytes = Buffer.concat([Buffer.from(legacyFixture.replace("User prefers", "User ")), Buffer.from([0xc3, 0x28])]);
  const path = seed(repo, bytes);
  for (const [command, args] of [
    ["list", []],
    ["update", ["--id", "pref_20260710_legacy-workflow", "--description", "Changed preference."]],
  ]) {
    const result = raw(command, repo, args);
    assert.equal(result.status, 1);
    const error = JSON.parse(result.stderr);
    assert.equal(error.ok, false);
    assert.match(error.error, /not valid UTF-8/);
    assert.deepEqual(readFileSync(path), bytes);
  }
});

test("preference writes respect live locks and reclaim locks from exited processes", (t) => {
  const repo = workspace(t);
  const path = seed(repo);
  const lockPath = `${path}.lock`;
  const lock = {
    version: 1, ownerId: "test-current-owner", pid: process.pid,
    processStartedAt: new Date(performance.timeOrigin).toISOString(), createdAt: new Date().toISOString(),
  };
  writeFileSync(lockPath, JSON.stringify(lock));
  const blocked = raw("delete", repo, ["--id", "pref_20260710_legacy-workflow"]);
  assert.equal(blocked.status, 1);
  assert.match(blocked.stderr, /timed out waiting for JSON state lock/);
  assert.equal(readFileSync(path, "utf8"), legacyFixture);
  assert.deepEqual(JSON.parse(readFileSync(lockPath, "utf8")), lock);

  const exited = spawnSync(process.execPath, ["-e", ""], { windowsHide: true });
  assert.equal(exited.status, 0);
  writeFileSync(lockPath, JSON.stringify({ ...lock, pid: exited.pid, ownerId: "test-exited-owner" }));
  const deleted = run("delete", repo, ["--id", "pref_20260710_legacy-workflow"]);
  assert.equal(deleted.active_count, 0);
  assert.equal(existsSync(lockPath), false);
});

test("CLI validation and help are side-effect free, while inline values retain equals signs", (t) => {
  const repo = workspace(t);
  for (const [command, args] of [
    ["add", ["--description", "Missing type and applicability."]],
    ["add", ["--type", "unexpected", "--description", "Invalid type.", "--applies-when", "Always."]],
    ["update", ["--id", "pref_missing"]],
    ["list", ["--unknown", "value"]],
  ]) {
    const result = raw(command, repo, args);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Usage: memorax-code user-profile/);
  }
  const help = raw("add", repo, ["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--description/);
  assert.equal(existsSync(join(repo, "personal-memory")), false);

  run("add", repo, ["--type=environment", "--description=Use FOO=bar in this repo.", "--applies-when=Configuring tests."]);
  assert.equal(run("list", repo).preferences[0].description, "Use FOO=bar in this repo.");
});

test("symlinked preference parents are rejected without touching their targets", (t) => {
  const repo = workspace(t);
  const outside = workspace(t, "outside");
  const target = join(outside, "personal-memory", "user-profile");
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "preferences.md"), legacyFixture);
  mkdirSync(join(repo, "personal-memory"));
  symlinkSync(target, join(repo, "personal-memory", "user-profile"), process.platform === "win32" ? "junction" : "dir");
  const result = raw("delete", repo, ["--id", "pref_20260710_legacy-workflow"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /preferences directories must be regular directories/);
  assert.equal(readFileSync(join(target, "preferences.md"), "utf8"), legacyFixture);
  assert.deepEqual(readdirSync(target), ["preferences.md"]);
});
