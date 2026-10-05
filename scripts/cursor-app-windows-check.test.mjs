import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { projectNativeReport } from "./cursor-app-container-check.mjs";
import { runWindowsCheck, windowsCheckEnvironment, windowsInstallerCommand } from "./cursor-app-windows-check.mjs";

test("Windows wrapper builds a clean environment with only the hosted Git directory added", () => {
  const env = windowsCheckEnvironment("C:\\owned root", "C:\\node\\node.exe", "D:\\Windows");
  assert.equal(env.HOME, "C:\\owned root\\home");
  assert.equal(env.LOCALAPPDATA, "C:\\owned root\\home\\AppData\\Local");
  assert.equal(env.SystemRoot, "D:\\Windows");
  assert.equal(env.RUNNER_OS, "Windows");
  assert.equal(env.GITHUB_ACTIONS, "true");
  assert.equal(env.npm_config_cache, "C:\\owned root\\npm-cache");
  assert.equal(env.PATH, "C:\\owned root\\candidate\\node_modules\\.bin;C:\\node;D:\\Windows\\System32;D:\\Windows;D:\\Windows\\System32\\WindowsPowerShell\\v1.0;C:\\Program Files\\Git\\cmd");
  for (const key of ["NODE_OPTIONS", "NODE_PATH", "GITHUB_TOKEN", "GH_TOKEN", "CURSOR_API_KEY", "VSCODE_PORTABLE",
    "npm_config_userconfig", "MEMORAX_CODE_MEMORAX_API_KEY"]) assert.equal(Object.hasOwn(env, key), false);
});

test("the Windows wrapper does not run on a developer desktop or another platform", async () => {
  if (process.platform === "win32" && process.arch === "x64" && process.env.GITHUB_ACTIONS === "true"
    && process.env.RUNNER_OS === "Windows") return;
  const report = await runWindowsCheck("never-read", "never-write");
  assert.equal(report.status, "FAIL");
  assert.equal(report.errorCode, "CURSOR_APP_WINDOWS_RUNNER");
  assert.deepEqual(report.evidence, {});
});

test("Windows installer invocation is silent, prevents automatic App start and waits for descendants", () => {
  const args = windowsInstallerCommand("C:\\owned ' installer\\CursorUserSetup.exe", "C:\\owned app\\Cursor");
  assert.deepEqual(args.slice(0, -1), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand"]);
  const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
  assert.match(script, /Start-Process -FilePath 'C:\\owned '' installer\\CursorUserSetup\.exe'/);
  assert.match(script, /'\/VERYSILENT','\/SUPPRESSMSGBOXES','\/NORESTART','\/MERGETASKS=!runcode','\/DIR="C:\\owned app\\Cursor"'/);
  assert.match(script, /-Wait -PassThru; exit \$installer\.ExitCode$/);
  assert.doesNotMatch(script, /ExecutionPolicy|RunAs|no-sandbox/i);
  for (const invalid of ["relative", "C:\\a\0b", "C:\\a\r\nb", 'C:\\a"b']) {
    assert.throws(() => windowsInstallerCommand(invalid, "C:\\app"), { code: "CURSOR_APP_WINDOWS_ARGUMENTS" });
  }
});

test("the real encoded installer script preserves arguments and exit status with a synthetic PowerShell command", (t) => {
  const available = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"], { encoding: "utf8", timeout: 10000 });
  if (available.error?.code === "ENOENT") return t.skip("PowerShell is not installed");
  assert.equal(available.status, 0);
  const args = windowsInstallerCommand("C:\\owned ' \u5b89\u88c5\\CursorUserSetup.exe", "C:\\owned app\\Cursor");
  const script = `function Start-Process {
param([string]$FilePath, [string[]]$ArgumentList, [switch]$Wait, [switch]$PassThru)
if ($FilePath -cne 'C:\\owned '' \u5b89\u88c5\\CursorUserSetup.exe' -or -not $Wait -or -not $PassThru) { throw 'FIXTURE_ARGUMENTS' }
if (($ArgumentList -join '|') -cne '/VERYSILENT|/SUPPRESSMSGBOXES|/NORESTART|/MERGETASKS=!runcode|/DIR="C:\\owned app\\Cursor"') { throw 'FIXTURE_FLAGS' }
[pscustomobject]@{ ExitCode=7 }
}
${Buffer.from(args.at(-1), "base64").toString("utf16le")}`;
  const result = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
    { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 7);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});

test("Windows wrapper CLI requires the same five arguments as the other native wrappers", () => {
  const script = fileURLToPath(new URL("./cursor-app-windows-check.mjs", import.meta.url));
  for (const args of [[], ["candidate"], ["candidate", "report", "manifest", "baseline"],
    ["candidate", "report", "manifest", "baseline", "24", "extra"]]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", timeout: 5000 });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.trim(), "CURSOR_APP_WINDOWS_ARGUMENTS");
  }
});

function nativeReport() {
  return { status: "PASS", client: "cursor", kind: "app-native-session-flows", platform: "win32", node: "24.20.0",
    version: "3.21.18", stage: "complete", evidence: { agentTransport: true, nativeHooks: true, exactAutomaticAdd: true,
      sameSessionFollowup: true, sessionIsolation: true, appResume: true, skillSearch: true, skillAdd: true, pendingShellInterrupted: true, cleanup: true,
      nativeContent: [3, 6, 3, 9, 15, 21].map((blobCount) => ({ composerMatched: true, stateMatched: true, blobCount })) },
    agent: { runs: 7, ancillaryRequestCount: 5, unsupportedRpcCount: 1, cancelled: [false, false, false, false, false, false, true], errors: [],
      writes: [3, 3, 3, 3, 6, 6, 0], acknowledgements: [3, 3, 3, 3, 6, 6, 0], historyTurns: [0, 1, 0, 2, 3, 4, 0],
      reads: [0, 3, 0, 6, 9, 15, 0], readResults: [0, 3, 0, 6, 9, 15, 0],
      execRequests: [0, 0, 0, 0, 3, 3, 1], execResults: [0, 0, 0, 0, 3, 3, 0], execCloses: [0, 0, 0, 0, 3, 3, 0],
      contextRequests: [1, 1, 1, 1, 1, 1, 1], contextResults: [1, 1, 1, 1, 1, 1, 1], contextCloses: [1, 1, 1, 1, 1, 1, 1] }, memoryRequestCount: 8 };
}

test("Windows orchestration uses verified artifacts and preserves every native or cleanup failure", async (t) => {
  const source = (await readFile(new URL("./cursor-app-windows-check.mjs", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  assert.doesNotMatch(source, /cursor-app-windows-isolation|owned-session|runWindowsIsolation|New-LocalUser|WFP/);
  const body = source.split("export async function runWindowsCheck(")[1]?.split("\nif (process.argv[1]")[0];
  assert.ok(body);
  for (const kind of ["success", "candidate-failure", "probe-failure", "smoke-failure", "artifact-failure", "installer-failure",
    "installed-failure", "installed-cleanup-failure", "native-failure", "native-exit-with-pass", "native-cleanup-failure",
    "invalid-report", "missing-report", "artifact-cleanup-failure", "state-cleanup-failure"]) {
    await t.test(kind, async () => {
      const calls = [], output = new Map(), abort = new AbortController();
      const error = (code) => Object.assign(new Error("private-canary"), { code });
      const native = nativeReport(); native.privateCanary = "private-canary";
      if (["native-failure", "native-cleanup-failure"].includes(kind)) {
        native.status = "FAIL"; native.stage = "app-start"; native.errorCode = "CURSOR_APP_EXITED";
      }
      if (kind === "native-cleanup-failure") { native.evidence.cleanup = false; native.cleanupError = "CURSOR_APP_CLEANUP_DESCENDANTS"; }
      if (kind === "invalid-report") native.platform = "linux";
      const run = runInNewContext(`(async function runWindowsCheck(${body})`, {
        process: { platform: "win32", arch: "x64", versions: { node: "24.20.0" }, execPath: "C:\\node\\node.exe",
          env: { GITHUB_ACTIONS: "true", RUNNER_OS: "Windows", SystemRoot: "C:\\Windows", GITHUB_TOKEN: "private-canary" } },
        dirname: win32.dirname, join: win32.join, resolve: win32.resolve, scripts: "C:\\scripts", tmpdir: () => "C:\\temp",
        gitDirectory: "C:\\Program Files\\Git\\cmd", windowsCheckEnvironment, windowsInstallerCommand, projectNativeReport,
        check(value, code) { if (!value) throw error(code); }, safeCode: (caught) => /^CURSOR_/.test(caught.code ?? "") ? caught.code : "CURSOR_APP_WINDOWS_CHECK_FAILED",
        async lstat(path) {
          if (kind === "missing-report" && path.endsWith("report.json")) throw error("ENOENT");
          return { isFile: () => true, isDirectory: () => true, isSymbolicLink: () => false, size: 100 };
        },
        async mkdir() {}, async readdir() { return []; }, async realpath(path) { return path; }, async mkdtemp() { return "C:\\runtime"; },
        async writeFile(path, value) { output.set(path, value); },
        async rm(path) { calls.push("remove"); assert.equal(path, "C:\\runtime"); if (kind === "state-cleanup-failure") throw error("EBUSY"); },
        selectCursorWindowsRelease(manifest, channel) {
          assert.equal(manifest, "frozen inventory"); assert.equal(channel, "baseline"); return { version: "3.21.18" };
        },
        async exec(file, args, options) {
          assert.equal(options.env.HOME, "C:\\runtime\\home"); assert.equal(options.env.GITHUB_TOKEN, undefined);
          assert.equal(options.signal, abort.signal);
          if (args[0].endsWith("npm-cli.js")) {
            assert.equal(file, "C:\\node\\node.exe"); assert.equal(args[0], "C:\\node\\node_modules\\npm\\bin\\npm-cli.js");
            const prefix = win32.basename(args[args.indexOf("--prefix") + 1]); calls.push(prefix);
            assert.ok(args.includes("--ignore-scripts") && args.includes("--no-audit") && args.includes("--no-fund"));
            const user = args[args.indexOf("--userconfig") + 1], global = args[args.indexOf("--globalconfig") + 1];
            assert.notEqual(user, global); assert.equal(output.get(user), ""); assert.equal(output.get(global), "");
            if (kind === `${prefix}-failure`) throw error(1);
          } else if (args[0].endsWith("cursor-npm-package-smoke.mjs")) {
            calls.push("smoke"); assert.equal(args[1], "C:\\runtime\\candidate\\node_modules\\@memorax\\memorax-code");
            if (kind === "smoke-failure") throw error("ETIMEDOUT");
          } else if (file.endsWith("powershell.exe")) {
            calls.push("installer"); assert.equal(options.timeout, 300_000);
            assert.deepEqual(Array.from(args), windowsInstallerCommand("C:\\verified\\CursorUserSetup.exe", "C:\\runtime\\home\\AppData\\Local\\Programs\\Cursor"));
            if (kind === "installer-failure") throw error("ETIMEDOUT");
          } else {
            calls.push("native"); assert.equal(file, "C:\\node\\node.exe");
            assert.deepEqual(Array.from(args), ["C:\\scripts\\cursor-app-native-check.mjs", "C:\\runtime\\candidate\\node_modules\\@memorax\\memorax-code",
              "C:\\runtime\\home\\AppData\\Local\\Programs\\Cursor\\Cursor.exe", "3.21.18", "C:\\runtime\\probe\\node_modules\\playwright-core",
              "C:\\runtime\\native-report", "24"]);
            if (kind.startsWith("native-")) throw error(1);
          }
          return { stdout: "", stderr: "" };
        },
        async readFile(path) { assert.equal(path, "C:\\runtime\\native-report\\report.json"); return JSON.stringify(native); },
        async verifyCursorWindowsInstalledApp(options) {
          calls.push("verify-installed"); assert.equal(options.root, "C:\\runtime"); assert.equal(options.profileRoot, "C:\\runtime\\home");
          assert.equal(options.appDirectory, "C:\\runtime\\home\\AppData\\Local\\Programs\\Cursor");
          if (kind.startsWith("installed-")) {
            const caught = error("CURSOR_APP_WINDOWS_ARTIFACT_PACKAGE");
            if (kind === "installed-cleanup-failure") caught.cleanupErrorCode = "CURSOR_APP_WINDOWS_ARTIFACT_PROCESS_CLEANUP";
            throw caught;
          }
          return { appIdentityVerified: true, appArchitectureVerified: true, authenticodeVerified: true };
        },
        async withVerifiedCursorWindowsInstaller(options, callback) {
          calls.push("artifact"); if (kind === "artifact-failure") throw error("CURSOR_APP_WINDOWS_ARTIFACT_SIGNATURE");
          let confirmed = false, caught;
          try { await callback({ installerPath: "C:\\verified\\CursorUserSetup.exe", confirmProcessesClosed() { confirmed = true; calls.push("confirmed"); } }); }
          catch (failure) { caught = failure; }
          if (!confirmed || kind === "artifact-cleanup-failure") {
            caught ??= error("CURSOR_APP_WINDOWS_ARTIFACT_PROCESS_CLEANUP");
            caught.cleanupErrorCode = "CURSOR_APP_WINDOWS_ARTIFACT_PROCESS_CLEANUP";
          }
          if (caught) throw caught;
        },
      }, { timeout: 100 });
      const result = await run("C:\\candidate.tgz", "C:\\report", { releaseManifest: "frozen inventory", channel: "baseline", signal: abort.signal });
      assert.equal(result.status, kind === "success" ? "PASS" : "FAIL");
      assert.equal(JSON.stringify(result).includes("private-canary"), false);
      assert.equal(output.get("C:\\report\\report.json"), `${JSON.stringify(result, null, 2)}\n`);
      const retained = ["smoke-failure", "installer-failure", "installed-cleanup-failure", "native-cleanup-failure", "invalid-report", "missing-report", "artifact-cleanup-failure"].includes(kind);
      assert.equal(calls.includes("remove"), !retained);
      if (retained || kind === "state-cleanup-failure") assert.ok(result.cleanupError);
      if (kind === "success") assert.deepEqual(calls, ["candidate", "probe", "smoke", "artifact", "installer", "verify-installed", "native", "confirmed", "remove"]);
      if (["candidate-failure", "probe-failure", "smoke-failure", "artifact-failure", "installer-failure", "installed-failure", "installed-cleanup-failure"].includes(kind)) {
        assert.equal(calls.includes("native"), false);
      }
      if (kind === "native-failure") assert.equal(result.errorCode, "CURSOR_APP_EXITED");
      if (kind === "native-exit-with-pass") assert.equal(result.errorCode, "CURSOR_APP_WINDOWS_NATIVE_EXIT");
    });
  }
});
