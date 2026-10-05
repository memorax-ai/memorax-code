import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { macosCheckEnvironment, runMacosCheck } from "./cursor-app-macos-check.mjs";
import { projectNativeReport } from "./cursor-app-container-check.mjs";
import { projectMacosNetworkDiagnostic } from "./cursor-app-macos-isolation-check.mjs";
const { dirname, join, resolve } = posix;

test("macOS acquisition and native controller use only isolated state and an environment whitelist", () => {
  const env = macosCheckEnvironment("/owned/fixture", "/owned/node/bin/node");
  assert.deepEqual(env, { PATH: "/owned/node/bin:/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/owned/fixture/home",
    CFFIXED_USER_HOME: "/owned/fixture/home", TMPDIR: "/owned/fixture/tmp", TMP: "/owned/fixture/tmp", TEMP: "/owned/fixture/tmp",
    npm_config_cache: "/owned/fixture/npm-cache", GITHUB_ACTIONS: "true", RUNNER_OS: "macOS", LANG: "en_US.UTF-8" });
  for (const key of ["NODE_OPTIONS", "NODE_PATH", "GITHUB_TOKEN", "GH_TOKEN", "CURSOR_HOME", "VSCODE_PORTABLE",
    "VSCODE_APPDATA", "npm_config_userconfig", "MEMORAX_CODE_MEMORAX_API_KEY", "MEMORAX_CODE_HOME"]) {
    assert.equal(Object.hasOwn(env, key), false);
  }
});

test("the macOS wrapper never starts local or non-macOS native Apps", async () => {
  const allowedRunner = process.platform === "darwin" && process.arch === "arm64"
    && process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_OS === "macOS";
  if (allowedRunner) return;
  const result = await runMacosCheck("/never/read/candidate", "/never/write/report");
  assert.equal(result.status, "FAIL");
  assert.equal(result.errorCode, "CURSOR_APP_MACOS_RUNNER");
  assert.deepEqual(result.evidence, {});
});

test("macOS wrapper CLI rejects incomplete invocation with only a fixed error", () => {
  const script = fileURLToPath(new URL("./cursor-app-macos-check.mjs", import.meta.url));
  for (const args of [[], ["candidate"], ["candidate", "output", "manifest", "baseline"],
    ["candidate", "output", "manifest", "baseline", "24", "extra"]]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 5000 });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.trim(), "CURSOR_APP_MACOS_ARGUMENTS");
  }
});

test("the actual macOS orchestration fails closed before launch and preserves cleanup failures", async (t) => {
  const source = await readFile(new URL("./cursor-app-macos-check.mjs", import.meta.url), "utf8");
  const body = source.split("export async function runMacosCheck(")[1]?.split("\nif (process.argv[1]")[0];
  assert.ok(body);
  for (const kind of ["native-failure", "proof-failure", "candidate-install-failure", "probe-install-failure",
    "artifact-failure", "busy-detach", "invalid-report", "missing-report"]) {
    await t.test(kind, async () => {
      const calls = [], output = new Map();
      const error = (code) => Object.assign(new Error(code), { code });
      const report = { status: "FAIL", client: "cursor", kind: "app-native-session-flows", platform: "darwin",
        node: "24.20.0", version: "3.21.18", stage: "native-submit", errorCode: "CURSOR_APP_DRIVER",
        evidence: { networkIsolation: true, cleanup: true }, privateCanary: "/private/unpublished-canary" };
      const run = runInNewContext(`(async function runMacosCheck(${body})`, {
        process: { platform: "darwin", arch: "arm64", versions: { node: "24.20.0" }, execPath: "/owned/node/bin/node",
          env: { GITHUB_ACTIONS: "true", RUNNER_OS: "macOS" } },
        dirname, join, resolve, scripts: "/owned/scripts", tmpdir: () => "/owned/tmp", macosCheckEnvironment, projectNativeReport,
        projectMacosNetworkDiagnostic,
        check(value, code) { if (!value) throw error(code); }, safeCode: (caught) => caught.code ?? "CURSOR_APP_MACOS_CHECK_FAILED",
        async lstat(path) {
          if (kind === "missing-report" && path.endsWith("report.json")) throw error("ENOENT");
          return { isFile: () => true, isDirectory: () => true, isSymbolicLink: () => false, size: 100 };
        },
        async mkdir() {}, async readdir() { return []; }, async realpath(path) { return path; },
        async mkdtemp() { return "/owned/runtime"; },
        async writeFile(path, value) { output.set(path, value); },
        async rm(path) { calls.push(["remove", path]); },
        selectCursorMacosRelease(manifest, channel) {
          assert.equal(manifest, "frozen inventory"); assert.equal(channel, "baseline");
          return { version: "3.21.18" };
        },
        async runMacosIsolationProof() {
          calls.push(["proof"]);
          return { status: kind === "proof-failure" ? "FAIL" : "PASS", errorCode: "CURSOR_APP_MACOS_PROOF_FAILED" };
        },
        async exec(file, args, options) {
          assert.equal(file, "/owned/node/bin/node");
          assert.equal(options.env.HOME, "/owned/runtime/home");
          if (args[0].endsWith("npm-cli.js")) {
            calls.push(["install"]);
            assert.ok(args.includes("--ignore-scripts") && args.includes("--globalconfig") && args.includes("--userconfig"));
            const userConfig = args[args.indexOf("--userconfig") + 1], globalConfig = args[args.indexOf("--globalconfig") + 1];
            assert.notEqual(userConfig, globalConfig, "npm refuses to load the same file for two configuration layers");
            assert.equal(output.get(userConfig), ""); assert.equal(output.get(globalConfig), "");
            const prefix = args[args.indexOf("--prefix") + 1];
            if ((kind === "candidate-install-failure" && prefix.endsWith("/candidate"))
              || (kind === "probe-install-failure" && prefix.endsWith("/probe"))) throw error("CURSOR_APP_MACOS_INSTALL_FAILED");
          } else {
            calls.push(["native"]);
            assert.equal(args[0], "/owned/scripts/cursor-app-native-check.mjs");
            assert.equal(args[2], "/owned/verified/Cursor.app/Contents/MacOS/Cursor");
            throw error("CURSOR_APP_MACOS_NATIVE_EXIT");
          }
        },
        async readFile(path) {
          assert.equal(path, "/owned/runtime/native-report/report.json");
          return JSON.stringify(kind === "invalid-report" ? { ...report, platform: "linux" } : report);
        },
        async withCursorMacosApp(options, callback) {
          calls.push(["artifact"]);
          if (kind === "artifact-failure") throw error("CURSOR_APP_MACOS_ARTIFACT_SIGNATURE");
          try { return await callback({ appPath: "/owned/verified/Cursor.app/Contents/MacOS/Cursor", evidence: { signatureVerified: true } }); }
          catch (caught) {
            if (kind === "busy-detach") caught.cleanupErrorCode = "CURSOR_APP_MACOS_ARTIFACT_DETACH";
            throw caught;
          } finally { calls.push(["detach"]); }
        },
      }, { timeout: 100 });
      const result = await run("/owned/candidate.tgz", "/owned/report", { releaseManifest: "frozen inventory", channel: "baseline" });
      assert.equal(result.status, "FAIL");
      assert.equal(JSON.stringify(result).includes("unpublished-canary"), false);
      assert.equal(output.get("/owned/report/report.json"), `${JSON.stringify(result, null, 2)}\n`);
      assert.deepEqual(calls[0], ["proof"]);
      if (kind === "proof-failure") assert.deepEqual(calls, [["proof"]]);
      if (["proof-failure", "candidate-install-failure", "probe-install-failure", "artifact-failure"].includes(kind)) {
        assert.equal(calls.some(([type]) => type === "native"), false);
      }
      if (kind.endsWith("install-failure")) {
        assert.equal(result.stage, "macos-installation");
        assert.equal(result.errorCode, kind === "candidate-install-failure"
          ? "CURSOR_APP_MACOS_CANDIDATE_INSTALL" : "CURSOR_APP_MACOS_PROBE_INSTALL");
        assert.equal(calls.filter(([type]) => type === "install").length, kind === "candidate-install-failure" ? 1 : 2);
      }
      const removed = calls.findIndex(([type]) => type === "remove");
      if (["busy-detach", "invalid-report", "missing-report"].includes(kind)) {
        assert.equal(removed, -1); assert.ok(result.cleanupError);
      } else if (kind !== "proof-failure") assert.ok(removed > 0);
      if (kind === "native-failure") {
        assert.equal(result.errorCode, "CURSOR_APP_DRIVER");
        assert.ok(removed > calls.findIndex(([type]) => type === "detach"));
      }
      if (kind === "busy-detach") assert.equal(result.cleanupError, "CURSOR_APP_MACOS_ARTIFACT_DETACH");
    });
  }
});
