import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { createCursorLifecycleRegistry, cursorLifecycleEnvironment, makeCursorReplacementFault,
  runCursorLifecycleCheck } from "./cursor-lifecycle-check.mjs";

test("Cursor lifecycle environment does not inherit credentials, client commands or npm configuration", () => {
  const keys = ["CURSOR_API_KEY", "MEMORAX_CODE_MEMORAX_API_KEY", "MEMORAX_CODE_MEMORAX_ENDPOINT",
    "MEMORAX_CODE_MEMORAX_USER_ID", "MEMORAX_CODE_CODEX_COMMAND", "npm_config_userconfig", "PATH"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = "private-parent-canary";
    const root = join(tmpdir(), "owned-lifecycle");
    const options = { root, home: join(root, "home"), stateHome: join(root, "state"), cursorHome: join(root, "cursor"),
      prefix: join(root, "npm"), npmCli: join(root, "tools/npm-cli.js"), port: 12345 };
    const env = cursorLifecycleEnvironment(options);
    assert.equal(JSON.stringify(env).includes("private-parent-canary"), false);
    assert.equal(env.HOME, options.home);
    assert.equal(env.MEMORAX_CODE_HOME, options.stateHome);
    assert.equal(env.CURSOR_HOME, options.cursorHome);
    assert.equal(env.npm_config_prefix, options.prefix);
    assert.equal(env.npm_config_userconfig, join(root, "user.npmrc"));
    assert.equal(env.npm_config_globalconfig, join(root, "global.npmrc"));
    assert.equal(env.MEMORAX_CODE_NPM_EXEC_PATH, options.npmCli);
    assert.equal(env.MEMORAX_CODE_BACKEND_HOST, "127.0.0.1");
    assert.equal(env.MEMORAX_CODE_AUTO_UPDATE, "false");
    assert.equal(env.MEMORAX_CODE_INSTALL_WATCHDOG, "0");
    for (const name of ["MEMORAX_CODE_MEMORAX_API_KEY", "MEMORAX_CODE_MEMORAX_ENDPOINT", "MEMORAX_CODE_MEMORAX_USER_ID",
      "MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED", "MEMORAX_CODE_SETUP_ASSUME_INTERACTIVE"]) assert.equal(env[name], undefined);
    for (const client of ["CODEX", "CLAUDE", "OPENCODE", "DSH", "CODEBUDDY", "WORKBUDDY", "TRAE"]) {
      assert.equal(env[`${client}_HOME`], join(options.home, `.${client.toLowerCase()}`));
      assert.equal(env[`MEMORAX_CODE_${client}_COMMAND`], join(root, "missing-client"));
      assert.equal(env[`MEMORAX_CODE_SKIP_${client}_ADAPTER_INSTALL`], "1");
    }
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    }
  }
});

test("Cursor lifecycle scoped registry serves only the selected artifact and supports download failure and retry", async () => {
  const manifest = { name: "@memorax/memorax-code", version: "0.1.19", scripts: { postinstall: "node original.mjs" } };
  const artifact = Buffer.from("synthetic candidate");
  const registry = await createCursorLifecycleRegistry(manifest, artifact);
  try {
    assert.match(registry.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    const metadata = await (await fetch(`${registry.url}/@memorax%2fmemorax-code`)).json();
    assert.equal(metadata["dist-tags"].latest, manifest.version);
    assert.deepEqual(Object.keys(metadata.versions), [manifest.version]);
    assert.equal(metadata.versions[manifest.version].dist.shasum, createHash("sha1").update(artifact).digest("hex"));
    assert.equal(metadata.versions[manifest.version].dist.tarball, `${registry.url}/candidate.tgz`);
    registry.rejectDownload = true;
    assert.equal((await fetch(`${registry.url}/candidate.tgz`)).status, 503);
    registry.rejectDownload = false;
    assert.equal(await (await fetch(`${registry.url}/candidate.tgz`)).text(), artifact.toString());
    registry.setArtifact({ ...manifest, scripts: { postinstall: "node fault.mjs" } }, Buffer.from("fault candidate"));
    const fault = await (await fetch(`${registry.url}/@memorax/memorax-code`)).json();
    assert.equal(fault.versions[manifest.version].scripts.postinstall, "node fault.mjs");
    assert.equal(await (await fetch(`${registry.url}/candidate.tgz`)).text(), "fault candidate");
    for (const path of ["/@foreign/package", "/private-canary", "/candidate.tgz/extra"]) {
      assert.equal((await fetch(registry.url + path)).status, 404);
    }
    assert.equal((await fetch(`${registry.url}/candidate.tgz`, { method: "POST" })).status, 404);
    assert.deepEqual(registry.counts, { manifest: 2, artifact: 2, rejected: 1 });
  } finally { await registry.close(); }
});

test("replacement fault preserves real preinstall and emits evidence only after old Backend retirement", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-lifecycle-fault-test-"));
  try {
    const packageRoot = join(root, "package"), faultMarker = join(root, "fault.json");
    await mkdir(join(packageRoot, "bin"), { recursive: true });
    await mkdir(join(packageRoot, "node_modules/omitted"), { recursive: true });
    const manifest = { name: "@memorax/memorax-code", version: "0.1.19",
      scripts: { preinstall: "node bin/preinstall.mjs", postinstall: "node bin/postinstall.mjs" } };
    await writeFile(join(packageRoot, "package.json"), JSON.stringify(manifest));
    await writeFile(join(packageRoot, "bin/preinstall.mjs"), "original preinstall");
    await writeFile(join(packageRoot, "node_modules/omitted/private"), "must not copy");
    const fault = await makeCursorReplacementFault({ packageRoot, root, faultMarker, oldPid: 12345,
      async npm(args) {
        assert.deepEqual(args, ["pack", join(root, "fault-candidate"), "--ignore-scripts", "--pack-destination", join(root, "fault-candidate"), "--json"]);
        return { stdout: JSON.stringify([{ filename: "fixture.tgz" }]) };
      } });
    assert.deepEqual(JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")), manifest);
    assert.equal(await readFile(join(root, "fault-candidate/bin/preinstall.mjs"), "utf8"), "original preinstall");
    await assert.rejects(readFile(join(root, "fault-candidate/node_modules/omitted/private")), { code: "ENOENT" });
    assert.equal(fault.manifest.scripts.preinstall, manifest.scripts.preinstall);
    assert.equal(fault.manifest.scripts.postinstall, "node ./bin/ci-replacement-failure.mjs");
    assert.equal(fault.tarball, join(root, "fault-candidate/fixture.tgz"));
    const script = (await readFile(join(root, "fault-candidate/bin/ci-replacement-failure.mjs"), "utf8"))
      .split("\n").filter((line) => !line.startsWith("import ")).join("\n");
    for (const [state, oldAlive, expectedExit] of [["retired", false, 23], ["retired", true, 24], ["prepared", false, 24]]) {
      const writes = [];
      assert.throws(() => runInNewContext(script, { join,
        readFileSync: () => JSON.stringify({ state }), writeFileSync: (path, text) => writes.push([path, JSON.parse(text)]),
        process: { env: { MEMORAX_CODE_HOME: join(root, "state") }, kill(pid, signal) {
          assert.equal(pid, 12345); assert.equal(signal, 0);
          if (!oldAlive) throw Object.assign(new Error("gone"), { code: "ESRCH" });
        }, exit(code) { throw Object.assign(new Error("exit"), { exitCode: code }); } },
      }, { timeout: 100 }), { exitCode: expectedExit });
      assert.equal(writes.length, expectedExit === 23 ? 1 : 0);
      if (writes.length) assert.deepEqual(writes[0], [faultMarker,
        { stage: "postinstall", transitionState: "retired", oldBackendStopped: true, candidateVersion: manifest.version }]);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Cursor lifecycle preflight reports fixed errors without private paths or command output", async () => {
  const root = await mkdtemp(join(tmpdir(), "cursor-lifecycle-preflight-"));
  try {
    const report = await runCursorLifecycleCheck(join(root, "private-path-token-canary.tgz"), join(root, "report"));
    assert.equal(report.status, "FAIL");
    assert.equal(report.stage, "prerequisites");
    assert.equal(report.systemCode, "ENOENT");
    assert.equal(report.cleanup, "PASS");
    assert.equal(JSON.stringify(report).includes(root), false);
    assert.equal(JSON.stringify(report).includes("private-path-token-canary"), false);
    assert.deepEqual(JSON.parse(await readFile(join(root, "report/report.json"), "utf8")), report);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("lifecycle cleanup verifies shutdown even when the first npm install failed or started Backend unexpectedly", async () => {
  const source = await readFile(new URL("./cursor-lifecycle-check.mjs", import.meta.url), "utf8");
  assert.ok(source.includes('product(["stop", "--clients", "none", "--json"], true)'),
    "cleanup must also work with the published baseline that predates Cursor support");
  assert.ok(source.indexOf("installationStarted = true;") < source.indexOf("await npmInstall(candidate);"));
  const body = source.split("  async function clean() {")[1]?.split("\n}\n\nexport function cursorLifecycleEnvironment")[0];
  assert.ok(body);
  for (const mode of ["entrypoint", "partial-install", "shutdown-fails", "command-cleanup-fails"]) {
    const calls = [], report = { status: "FAIL" };
    const cleanup = runInNewContext(`(async function clean() {${body})`, {
      commands: [], installationStarted: true, entrypoint: "/owned/npm/bin/memorax-code.mjs", root: "/owned/root",
      commandsClean: mode !== "command-cleanup-fails", report, registry: undefined, endpoint: undefined,
      exists: async () => mode !== "partial-install",
      async stop() { calls.push("stop"); if (mode === "shutdown-fails") throw new Error("private-canary"); },
      async stopped() { calls.push("stopped"); },
      async rm(path, options) { calls.push("remove"); assert.equal(path, "/owned/root"); assert.equal(options.recursive, true); },
      check(value) { if (!value) throw new Error("cleanup failed"); },
    }, { timeout: 100 });
    await cleanup();
    const failed = mode === "shutdown-fails" || mode === "command-cleanup-fails";
    assert.deepEqual(calls, [mode === "partial-install" ? "stopped" : "stop", ...(!failed ? ["remove"] : [])]);
    assert.equal(report.cleanup, failed ? "FAIL" : "PASS");
    assert.equal(report.status, "FAIL", "successful cleanup never erases the original failure");
    assert.equal(JSON.stringify(report).includes("private-canary"), false);
  }
});
