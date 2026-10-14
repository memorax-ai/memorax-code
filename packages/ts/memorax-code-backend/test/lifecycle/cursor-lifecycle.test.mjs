import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { freePort } from "../support/helpers.mjs";
import { pathExists, runCli } from "./support/backend-service-fixtures.mjs";

const cliPath = fileURLToPath(new URL("../../dist/memorax-code.js", import.meta.url));

test("Cursor lifecycle works alone, preserves client scope, and removes only owned Hooks", { timeout: 30_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-cursor-lifecycle-"));
  const home = join(root, "backend");
  const cursorHome = join(root, "cursor");
  const traeHome = join(root, "trae");
  const hooksPath = join(cursorHome, "hooks.json");
  const port = await freePort();
  const args = ["--home", home, "--port", String(port), "--json"];
  const env = {
    HOME: join(root, "user"),
    USERPROFILE: join(root, "user"),
    MEMORAX_CODE_HOME: home,
    CURSOR_HOME: join(root, "unused-cursor"),
    TRAE_HOME: traeHome,
    TRAE_CN_HOME: traeHome,
    CODEX_HOME: join(root, "codex"),
    CLAUDE_CONFIG_DIR: join(root, "claude"),
    DSH_HOME: join(root, "dsh"),
    OPENCODE_CONFIG_DIR: join(root, "opencode"),
    CODEBUDDY_HOME: join(root, "codebuddy"),
    WORKBUDDY_HOME: join(root, "workbuddy"),
    MEMORAX_CODE_CLAUDE_COMMAND: join(root, "missing-claude"),
    MEMORAX_CODE_AUTO_UPDATE: "false",
    MEMORAX_CODE_MEMORAX_API_KEY: "",
    MEMORAX_CODE_MEMORAX_USER_ID: "",
    MEMORAX_CODE_MEMORAX_ENDPOINT: "http://127.0.0.1:1",
    MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "false",
    MEMORAX_CODE_NPM_PACKAGE_ROOT: "",
    MEMORAX_CODE_NPM_PACKAGE_VERSION: "",
  };
  const run = async (command, extra = []) => {
    const result = await runCli(cliPath, [command, ...args, ...extra], { env });
    const backendLog = result.code === 0 ? "" : await readFile(join(home, "runtime", "backend", "backend.log"), "utf8").catch(() => "");
    assert.equal(result.code, 0, result.stdout + result.stderr + backendLog);
    return JSON.parse(result.stdout);
  };
  await mkdir(cursorHome, { recursive: true });
  const userHook = { command: "user-owned-cursor-hook" };
  await writeFile(hooksPath, JSON.stringify({ version: 1, custom: true, hooks: { beforeSubmitPrompt: [userHook] } }));
  try {
    const first = await run("start", ["--clients", "cursor", "--cursor-home", cursorHome]);
    assert.equal(first.cursorAdapter.installed, true);
    assert.equal(first.cursorAdapter.enabled, true);
    assert.equal(first.cursorAdapter.cursorHooks.configured, true);
    assert.equal(first.cursorAdapter.cursorHooks.runtimeObserved, false);
    assert.equal(first.cursorAdapter.globalHooksActivationRequired, undefined);
    assert.equal(first.claudeAdapter, undefined);
    assert.equal(await pathExists(join(env.CLAUDE_CONFIG_DIR, "settings.json")), false);
    assert.equal(await pathExists(env.CURSOR_HOME), false);
    assert.equal(await pathExists(join(cursorHome, "skills", "memorax-code", "SKILL.md")), true);
    env.CURSOR_HOME = "";
    assert.equal((await run("status")).cursorAdapter.enabled, true);
    assert.equal((await run("restart", ["--preserve-clients"])).cursorAdapter.enabled, true);

    await run("start", ["--clients", "cursor,trae", "--trae-home", traeHome]);
    const stopped = await run("stop", ["--clients", "cursor"]);
    assert.equal(stopped.backend.reason, "active_clients_remaining");
    assert.equal(stopped.cursorAdapter.enabled, false);
    assert.deepEqual(JSON.parse(await readFile(hooksPath, "utf8")), { version: 1, custom: true, hooks: { beforeSubmitPrompt: [userHook] } });
    assert.equal((await run("status")).traeAdapter.enabled, true);
    const removed = await run("uninstall", ["--clients", "cursor"]);
    assert.equal(removed.cursorPlugin.ok, true);
    assert.equal(removed.npmPackageRemoval.reason, "partial_client_uninstall");
    assert.equal(await pathExists(join(cursorHome, "skills", "memorax-code")), false);
    assert.equal(await pathExists(join(home, "adapters", "cursor", "state.json")), false);
    assert.equal((await run("status")).traeAdapter.enabled, true);
  } finally {
    await runCli(cliPath, ["stop", ...args, "--clients", "cursor,trae", "--cursor-home", cursorHome, "--trae-home", traeHome], { env });
    await rm(root, { recursive: true, force: true });
  }
});
