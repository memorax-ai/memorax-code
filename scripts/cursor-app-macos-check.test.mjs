import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { macosCheckEnvironment, runMacosCheck } from "./cursor-app-macos-check.mjs";
import { projectNativeReport } from "./cursor-app-container-check.mjs";
import { projectCursorMacosDetachDiagnostics } from "./cursor-app-macos-artifact.mjs";
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
  const source = (await readFile(new URL("./cursor-app-macos-check.mjs", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  assert.doesNotMatch(source, /cursor-app-macos-isolation-check|runMacosIsolationProof|networkIsolationFailure/);
  const body = source.split("export async function runMacosCheck(")[1]?.split("\nif (process.argv[1]")[0];
  assert.ok(body);
  for (const kind of ["native-failure", "native-cleanup-failure", "candidate-install-failure", "probe-install-failure",
    "package-smoke-failure", "package-smoke-timeout", "package-smoke-abort",
    "artifact-failure", "prelaunch-detach-failure", "busy-detach", "busy-detach-with-native-cleanup", "invalid-report", "missing-report"]) {
    await t.test(kind, async () => {
      const calls = [], output = new Map();
      const abort = new AbortController();
      const error = (code) => Object.assign(new Error(code), { code });
      const report = { status: "FAIL", client: "cursor", kind: "app-native-session-flows", platform: "darwin",
        node: "24.20.0", version: "3.21.18", stage: "native-submit", errorCode: "CURSOR_APP_DRIVER",
        evidence: { cleanup: true }, privateCanary: "/private/unpublished-canary" };
      if (["native-cleanup-failure", "busy-detach-with-native-cleanup"].includes(kind)) {
        report.cleanupError = "CURSOR_APP_CLEANUP_DESCENDANTS";
        report.evidence.cleanup = false;
      }
      const run = runInNewContext(`(async function runMacosCheck(${body})`, {
        process: { platform: "darwin", arch: "arm64", versions: { node: "24.20.0" }, execPath: "/owned/node/bin/node",
          env: { GITHUB_ACTIONS: "true", RUNNER_OS: "macOS" } },
        dirname, join, resolve, scripts: "/owned/scripts", tmpdir: () => "/owned/tmp", macosCheckEnvironment, projectNativeReport,
        projectCursorMacosDetachDiagnostics,
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
          } else if (args[0].endsWith("cursor-npm-package-smoke.mjs")) {
            calls.push(["package-smoke"]);
            assert.deepEqual(Array.from(args), ["/owned/scripts/cursor-npm-package-smoke.mjs",
              "/owned/runtime/candidate/node_modules/@memorax/memorax-code"]);
            assert.equal(options.cwd, "/owned/runtime");
            assert.equal(options.timeout, 180_000);
            assert.equal(options.maxBuffer, 1024 * 1024);
            assert.equal(options.killSignal, "SIGKILL");
            assert.equal(options.signal, abort.signal);
            if (kind.startsWith("package-smoke-")) throw Object.assign(new Error("/private/unpublished-canary"), {
              code: kind === "package-smoke-timeout" ? "ETIMEDOUT" : kind === "package-smoke-abort" ? "ABORT_ERR" : 1,
              stdout: "/private/unpublished-canary", stderr: "/private/unpublished-canary",
            });
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
          if (kind === "prelaunch-detach-failure") {
            calls.push(["detach"]);
            throw Object.assign(error("CURSOR_APP_MACOS_ARTIFACT_DETACH"), {
              cleanupErrorCode: "CURSOR_APP_MACOS_ARTIFACT_DETACH",
              artifactDetach: { exitCode: 16, stderrClass: "resource-busy", stderr: "/private/unpublished-canary" },
            });
          }
          try { return await callback({ appPath: "/owned/verified/Cursor.app/Contents/MacOS/Cursor", evidence: { signatureVerified: true } }); }
          catch (caught) {
            if (kind.startsWith("busy-detach")) {
              caught.cleanupErrorCode = "CURSOR_APP_MACOS_ARTIFACT_DETACH";
              caught.artifactDetach = { exitCode: 1, signal: "none", timedOut: false, outputOverflow: false,
                stderrClass: "resource-busy", stderr: "/private/unpublished-canary", path: "/private/unpublished-canary" };
              if (kind === "busy-detach-with-native-cleanup") Object.assign(caught.artifactDetach,
                { exitCode: "unpublished-canary", signal: "unpublished-canary", stderrClass: "unpublished-canary" });
            }
            throw caught;
          } finally { calls.push(["detach"]); }
        },
      }, { timeout: 100 });
      const result = await run("/owned/candidate.tgz", "/owned/report", {
        releaseManifest: "frozen inventory", channel: "baseline", signal: abort.signal,
      });
      assert.equal(result.status, "FAIL");
      assert.equal(result.evidence.networkIsolation, undefined);
      assert.equal(JSON.stringify(result).includes("unpublished-canary"), false);
      assert.equal(output.get("/owned/report/report.json"), `${JSON.stringify(result, null, 2)}\n`);
      assert.deepEqual(calls[0], ["install"]);
      if (["candidate-install-failure", "probe-install-failure", "artifact-failure", "prelaunch-detach-failure"].includes(kind)
        || kind.startsWith("package-smoke-")) {
        assert.equal(calls.some(([type]) => type === "native"), false);
      }
      const smoke = calls.findIndex(([type]) => type === "package-smoke");
      if (["candidate-install-failure", "probe-install-failure"].includes(kind)) assert.equal(smoke, -1);
      else {
        assert.equal(smoke, 2, "The package smoke must follow both installs");
        if (kind.startsWith("package-smoke-")) {
          assert.equal(calls.some(([type]) => type === "artifact"), false);
          assert.equal(result.stage, "macos-package-smoke");
          assert.equal(result.errorCode, "CURSOR_APP_MACOS_PACKAGE_SMOKE");
          assert.equal(result.cleanupError, "CURSOR_APP_MACOS_CLEANUP");
        } else assert.ok(smoke < calls.findIndex(([type]) => type === "artifact"));
      }
      if (kind.endsWith("install-failure")) {
        assert.equal(result.stage, "macos-installation");
        assert.equal(result.errorCode, kind === "candidate-install-failure"
          ? "CURSOR_APP_MACOS_CANDIDATE_INSTALL" : "CURSOR_APP_MACOS_PROBE_INSTALL");
        assert.equal(calls.filter(([type]) => type === "install").length, kind === "candidate-install-failure" ? 1 : 2);
      }
      const removed = calls.findIndex(([type]) => type === "remove");
      if (["native-cleanup-failure", "prelaunch-detach-failure", "busy-detach", "busy-detach-with-native-cleanup", "invalid-report", "missing-report"].includes(kind)
        || kind.startsWith("package-smoke-")) {
        assert.equal(removed, -1); assert.ok(result.cleanupError);
      } else assert.ok(removed > 0);
      if (kind === "native-failure") {
        assert.equal(result.errorCode, "CURSOR_APP_DRIVER");
        assert.ok(removed > calls.findIndex(([type]) => type === "detach"));
      }
      if (kind === "busy-detach") assert.equal(result.cleanupError, "CURSOR_APP_MACOS_ARTIFACT_DETACH");
      if (kind.startsWith("busy-detach")) assert.equal(result.artifactCleanupError, "CURSOR_APP_MACOS_ARTIFACT_DETACH");
      if (kind.startsWith("busy-detach")) assert.deepEqual(result.artifactDetach, {
        exitCode: kind === "busy-detach" ? 1 : null, signal: kind === "busy-detach" ? "none" : "other",
        timedOut: false, outputOverflow: false, stderrClass: kind === "busy-detach" ? "resource-busy" : "other",
      });
      else if (kind === "prelaunch-detach-failure") {
        assert.equal(result.stage, "macos-acquisition");
        assert.equal(result.errorCode, "CURSOR_APP_MACOS_ARTIFACT_DETACH");
        assert.equal(result.artifactCleanupError, "CURSOR_APP_MACOS_ARTIFACT_DETACH");
        assert.deepEqual(result.artifactDetach, { exitCode: 16, signal: "none", timedOut: false,
          outputOverflow: false, stderrClass: "resource-busy" });
      } else assert.equal(result.artifactDetach, undefined);
      if (kind === "busy-detach-with-native-cleanup") assert.equal(result.cleanupError, "CURSOR_APP_CLEANUP_DESCENDANTS");
    });
  }
});
