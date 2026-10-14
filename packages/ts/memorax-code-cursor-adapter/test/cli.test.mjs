import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cli = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

test("Cursor CLI retains its recorded home across standalone lifecycle commands", async (t) => {
  const fixture = await createFixture(t);
  const cursorHome = join(fixture.root, "Custom Cursor");
  const installed = fixture.run(["enable", "--cursor-home", cursorHome, "--json"]);
  assert.equal(installed.status, 0, installed.stderr);
  assert.equal(JSON.parse(installed.stdout).cursorHome, cursorHome);

  const status = fixture.run(["--json"]);
  assert.equal(status.status, 0, status.stdout);
  const report = JSON.parse(status.stdout);
  assert.equal(report.cursorHome, cursorHome);
  assert.equal(report.cursorHooks.runtimeObserved, false);
  assert.equal(report.cursorAgents.ok, true);
  const agentPath = join(cursorHome, "agents", "memorax-repo-memory.md");
  assert.match(await readFile(agentPath, "utf8"), /model: inherit\nis_background: true/);

  const hooksPath = join(cursorHome, "hooks.json");
  const hooks = await readFile(hooksPath, "utf8");
  const conflicting = { CURSOR_HOME: join(fixture.root, "Other Cursor") };
  const rejected = fixture.run(["disable", "--json"], conflicting);
  assert.equal(rejected.status, 1);
  assert.equal(JSON.parse(rejected.stdout).reason, "state_paths_invalid");
  assert.equal(await readFile(hooksPath, "utf8"), hooks);
  assert.equal(fixture.run(["status", "--cursor-home", cursorHome], conflicting).status, 0);

  for (const command of ["disable", "enable", "remove"]) {
    const result = fixture.run([command, "--json"]);
    assert.equal(result.status, 0, result.stdout || result.stderr);
    assert.equal(JSON.parse(result.stdout).cursorHome, cursorHome);
  }
  await assert.rejects(readFile(join(cursorHome, "skills", "memorax-code", "SKILL.md")), /ENOENT/);
  await assert.rejects(readFile(agentPath), /ENOENT/);
  await assert.rejects(readFile(join(fixture.userHome, ".cursor", "hooks.json")), /ENOENT/);
});

test("Cursor CLI text status agrees with readiness without changing JSON query success", async (t) => {
  const fixture = await createFixture(t);
  function assertNotReady() {
    const text = fixture.run(["status"]);
    assert.equal(text.status, 1);
    assert.match(text.stdout, /^status: failed\n/);
    const json = fixture.run(["status", "--json"]);
    assert.equal(json.status, 1);
    const report = JSON.parse(json.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.enabled, false);
  }
  assertNotReady();
  const enabled = fixture.run(["enable"]);
  assert.equal(enabled.status, 0, enabled.stderr);
  assert.match(enabled.stdout, /^status: ok\n/);
  const ready = fixture.run([]);
  assert.equal(ready.status, 0, ready.stdout);
  assert.match(ready.stdout, /^status: ok\n/);
  await rm(join(fixture.userHome, ".cursor", "agents", "memorax-repo-memory.md"));
  assertNotReady();
  assert.equal(fixture.run(["enable"]).status, 0);
  const disabled = fixture.run(["disable"]);
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.match(disabled.stdout, /^disable: ok\n/);
  assertNotReady();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const removed = fixture.run(["remove"]);
    assert.equal(removed.status, 0, removed.stderr);
    assert.match(removed.stdout, /^cursor-adapter-remove: ok\n/);
    assert.ok(removed.stdout.includes(`home: ${join(fixture.userHome, ".cursor")}`));
  }
});

async function createFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-cursor-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userHome = join(root, "user");
  const temp = join(root, "tmp");
  await Promise.all([userHome, temp].map(path => mkdir(path, { recursive: true })));
  const env = {
    PATH: process.env.PATH,
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    HOME: userHome,
    USERPROFILE: userHome,
    APPDATA: join(userHome, "AppData", "Roaming"),
    LOCALAPPDATA: join(userHome, "AppData", "Local"),
    MEMORAX_CODE_HOME: join(root, "state"),
    TMPDIR: temp,
    TEMP: temp,
    TMP: temp,
  };
  return {
    root, userHome,
    run(args, overrides = {}) {
      const result = spawnSync(process.execPath, [cli, ...args], {
        cwd: root, env: { ...env, ...overrides }, encoding: "utf8", timeout: 15_000,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.signal, null);
      return result;
    },
  };
}
