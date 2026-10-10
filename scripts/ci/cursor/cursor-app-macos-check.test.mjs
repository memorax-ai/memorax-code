import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { posix } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { macosCheckEnvironment, runMacosCheck } from "./cursor-app-macos-check.mjs";
import { projectNativeReport } from "./cursor-app-container-check.mjs";
import { projectCursorMacosDetachDiagnostics } from "./cursor-app-macos-artifact.mjs";
const { dirname, join, resolve } = posix;

test("macOS acquisition uses isolated state and runs only on the hosted macOS runner", async () => {
  assert.deepEqual(macosCheckEnvironment("/owned/fixture", "/owned/node/bin/node"), {
    PATH: "/owned/node/bin:/usr/bin:/bin:/usr/sbin:/sbin", HOME: "/owned/fixture/home",
    CFFIXED_USER_HOME: "/owned/fixture/home", TMPDIR: "/owned/fixture/tmp", TMP: "/owned/fixture/tmp", TEMP: "/owned/fixture/tmp",
    npm_config_cache: "/owned/fixture/npm-cache", GITHUB_ACTIONS: "true", RUNNER_OS: "macOS", LANG: "en_US.UTF-8",
  });
  if (process.platform === "darwin" && process.arch === "arm64"
    && process.env.GITHUB_ACTIONS === "true" && process.env.RUNNER_OS === "macOS") return;
  const report = await runMacosCheck("/never/read", "/never/write");
  assert.equal(report.status, "FAIL");
  assert.equal(report.errorCode, "CURSOR_APP_MACOS_RUNNER");
});

test("macOS controller preserves failures and removes state only after confirmed cleanup", async (t) => {
  const source = await readFile(new URL("./cursor-app-macos-check.mjs", import.meta.url), "utf8");
  const body = source.replaceAll("\r\n", "\n").split("export async function runMacosCheck(")[1].split("\nif (process.argv[1]")[0];
  for (const [kind, code, retained] of [
    ["candidate", "CURSOR_APP_MACOS_CANDIDATE_INSTALL", false], ["probe", "CURSOR_APP_MACOS_PROBE_INSTALL", false],
    ["smoke", "CURSOR_APP_MACOS_PACKAGE_SMOKE", true], ["artifact", "CURSOR_APP_MACOS_ARTIFACT_SIGNATURE", false],
    ["detach", "CURSOR_APP_MACOS_ARTIFACT_DETACH", true], ["native", "CURSOR_APP_DRIVER", false],
    ["native-cleanup", "CURSOR_APP_DRIVER", true], ["native-detach", "CURSOR_APP_DRIVER", true],
    ["invalid-report", "CURSOR_CONTAINER_REPORT", true], ["missing-report", "CURSOR_APP_MACOS_CHECK_FAILED", true],
  ]) {
    await t.test(kind, async () => {
      const calls = [], output = new Map();
      const failure = (code) => Object.assign(new Error("private-canary"), { code });
      const native = { status: "FAIL", client: "cursor", kind: "app-native-session-flows", platform: "darwin",
        node: "24.20.0", version: "3.21.18", stage: "native-submit", errorCode: "CURSOR_APP_DRIVER",
        evidence: { cleanup: kind !== "native-cleanup" }, privateCanary: "private-canary" };
      const detach = () => Object.assign(failure("CURSOR_APP_MACOS_ARTIFACT_DETACH"), {
        cleanupErrorCode: "CURSOR_APP_MACOS_ARTIFACT_DETACH",
        artifactDetach: { exitCode: 16, stderrClass: "resource-busy", stderr: "private-canary" },
      });
      const run = runInNewContext("(async function runMacosCheck(" + body + ")", {
        process: { platform: "darwin", arch: "arm64", versions: { node: "24.20.0" }, execPath: "/node/bin/node",
          env: { GITHUB_ACTIONS: "true", RUNNER_OS: "macOS" } },
        dirname, join, resolve, scripts: "/scripts", tmpdir: () => "/tmp", macosCheckEnvironment,
        projectNativeReport, projectCursorMacosDetachDiagnostics,
        check(value, code) { if (!value) throw failure(code); },
        safeCode: (error) => /^CURSOR_(?:APP|CONTAINER)_[A-Z0-9_]{1,100}$/.test(error.code) ? error.code : "CURSOR_APP_MACOS_CHECK_FAILED",
        async lstat(path) {
          if (kind === "missing-report" && path.endsWith("report.json")) throw failure("ENOENT");
          return { isFile: () => true, isDirectory: () => true, isSymbolicLink: () => false, size: 100 };
        },
        async mkdir() {}, async readdir() { return []; }, async realpath(path) { return path; },
        async mkdtemp() { return "/runtime"; }, async writeFile(path, value) { output.set(path, value); },
        async rm(path) { assert.equal(path, "/runtime"); calls.push("remove"); },
        selectCursorMacosRelease: () => ({ version: "3.21.18" }),
        async exec(file, args) {
          const stage = args[0].endsWith("npm-cli.js") ? posix.basename(args[args.indexOf("--prefix") + 1])
            : args[0].endsWith("cursor-npm-package-smoke.mjs") ? "smoke" : "native";
          calls.push(stage);
          if (stage === kind || stage === "native") throw failure("ETIMEDOUT");
        },
        async readFile() { return JSON.stringify(kind === "invalid-report" ? { ...native, platform: "linux" } : native); },
        async withCursorMacosApp(options, callback) {
          calls.push("artifact");
          if (kind === "artifact") throw failure("CURSOR_APP_MACOS_ARTIFACT_SIGNATURE");
          if (kind === "detach") throw detach();
          try { return await callback({ appPath: "/verified/Cursor.app/Contents/MacOS/Cursor", evidence: { signatureVerified: true } }); }
          catch (error) {
            if (kind === "native-detach") Object.assign(error, { cleanupErrorCode: detach().code, artifactDetach: detach().artifactDetach });
            throw error;
          }
        },
      });
      const report = await run("/candidate.tgz", "/report", { releaseManifest: {}, channel: "baseline" });
      assert.equal(report.status, "FAIL");
      assert.equal(report.errorCode, code);
      assert.equal(calls.includes("remove"), !retained);
      assert.equal(Boolean(report.cleanupError), retained);
      assert.equal(output.get("/report/report.json"), JSON.stringify(report, null, 2) + "\n");
      assert.equal(JSON.stringify(report).includes("private-canary"), false);
      if (["candidate", "probe", "smoke", "artifact", "detach"].includes(kind)) assert.equal(calls.includes("native"), false);
      if (kind.endsWith("detach")) {
        assert.equal(report.artifactCleanupError, "CURSOR_APP_MACOS_ARTIFACT_DETACH");
        assert.deepEqual(report.artifactDetach, { exitCode: 16, signal: "none", timedOut: false,
          outputOverflow: false, stderrClass: "resource-busy" });
      }
    });
  }
});
