import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { baselineRelease, resolveDownload } from "./cursor-app-release.mjs";
import { installationEvidence, prepareInstallController, runRestrictedInstaller, runWindowsInstallCheck } from "./cursor-app-windows-install-check.mjs";

const platform = "win32-x64-user", release = baselineRelease(platform);
const latest = resolveDownload(platform, { version: release.version, commitSha: release.commitSha, downloadUrl: release.url });
function proof() {
  return { schemaVersion: 1, kind: "restricted-installer-proof", platform: "win32", status: "PASS", stage: "done",
    nativeAcceptance: false, appLaunchRequested: false, externalProbes: false,
    evidence: Object.fromEntries(["freshStandardUser", "baselineFixturesReachable", "parentChildGrandchildSameSid", "allowedLoopback",
      "deniedLoopback", "controllerStillReachesDenied", "filtersSurviveEngineClose", "udpDenied", "mappedIpv6Denied"].map((key) => [key, true])),
    counts: { processLevels: 3, verifiedTokens: 6, deniedAttempts: 18 },
    installation: { installerStarted: true, profileLoaded: true, installerExitCode: 0, jobEmpty: true,
      appIdentityVerified: true, appArchitectureVerified: true, authenticodeVerified: true, publisherVerified: true },
    cleanup: { bounded: true, processHandlesClosed: true, wfpObjectsRemoved: true,
      userRemoved: true, ownedFilesRemoved: true, profileRemoved: true } };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cursor-install-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const environment = { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", RUNNER_OS: "Windows",
    ImageOS: "win25", GITHUB_RUN_ID: "123", RUNNER_TEMP: root, GITHUB_TOKEN: "private-token-canary" };
  let confirmations = 0;
  const context = { release, installerPath: join(root, "verified-installer.exe"), artifact: { observedSha256: "a".repeat(64) },
    confirmProcessesClosed() { confirmations++; } };
  const controller = { root, node: join(root, "node.exe"), coordinator: join(root, "cursor-app-windows-isolation-check.ps1") };
  return { root, environment, context, controller, get confirmations() { return confirmations; } };
}

test("controller snapshots the fixed runtime closure only after protecting its private directory", async (t) => {
  const f = await fixture(t); let prepared = false;
  const controller = await prepareInstallController(f.root, {
    async prepareDirectory({ directory, runtimeDirectory }) {
      assert.equal(directory, join(f.root, "controller"));
      assert.equal(runtimeDirectory, join(f.root, "prepare-runtime"));
      assert.deepEqual(await readdir(directory), []);
      prepared = true;
    },
  });
  assert.equal(prepared, true);
  assert.equal(typeof controller.useInstaller, "function");
  assert.equal(controller.coordinator, join(controller.root, "cursor-app-windows-isolation-check.ps1"));
  assert.equal(controller.node, join(controller.root, "node.exe"));
  assert.equal(await readFile(join(controller.root, "cursor-app-windows-artifact.mjs"), "utf8"),
    await readFile(new URL("./cursor-app-windows-artifact.mjs", import.meta.url), "utf8"));
});

test("installation evidence requires every isolation, identity, exit and cleanup gate", () => {
  const valid = proof();
  assert.equal(installationEvidence(valid, release).installerExecuted, true);
  for (const section of ["evidence", "installation", "cleanup"]) {
    for (const key of Object.keys(valid[section])) {
      const value = structuredClone(valid);
      value[section][key] = typeof value[section][key] === "boolean" ? false : 23;
      assert.throws(() => installationEvidence(value, release), /INSTALL_REPORT/, `${section}:${key}`);
    }
  }
  for (const key of ["processLevels", "verifiedTokens", "deniedAttempts"]) {
    const value = proof(); value.counts[key] = 0;
    assert.throws(() => installationEvidence(value, release), /INSTALL_REPORT/);
  }
  for (const changes of [{ nativeAcceptance: true }, { appLaunchRequested: true }, { externalProbes: true },
    { kind: "network-isolation-proof" }, { stage: "install-run" }, { platform: "linux" }]) {
    assert.throws(() => installationEvidence({ ...proof(), ...changes }, release), /INSTALL_REPORT/);
  }
});

test("failure projection never publishes raw diagnostics and preserves uncertain cleanup", () => {
  for (const clean of [false, true]) {
    const value = proof(); value.status = "FAIL"; value.stage = "private-path"; value.errorCode = "private-message";
    value.cleanup.profileRemoved = clean; value.stderr = "private-stderr";
    assert.throws(() => installationEvidence(value, release), (error) => {
      assert.equal(error.processesClosed, clean);
      assert.equal(error.diagnostic.stage, "unknown");
      assert.equal(error.diagnostic.errorCode, "CURSOR_APP_WINDOWS_INSTALL_FAILED");
      assert.doesNotMatch(JSON.stringify(error), /private-/);
      return true;
    });
  }
});

test("controller runs only the fixed script with clean environment and confirms cleanup after held close", async (t) => {
  const f = await fixture(t);
  const execute = (file, args, options) => {
    assert.equal(file, "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
    assert.ok(args[args.indexOf("-File") + 1].endsWith("cursor-app-windows-isolation-check.ps1"));
    assert.equal(args[args.indexOf("-InstallerPath") + 1], f.context.installerPath);
    assert.equal(args[args.indexOf("-InstallerSha256") + 1], "a".repeat(64));
    assert.equal(options.env.GITHUB_TOKEN, undefined); assert.equal(options.timeout, 540_000);
    assert.equal(options.env.PATHEXT, ".COM;.EXE;.BAT;.CMD");
    assert.equal(options.env.HOME, f.root); assert.equal(options.env.USERPROFILE, f.root);
    const child = new EventEmitter();
    const pending = writeFile(args[args.indexOf("-ReportPath") + 1], JSON.stringify({ ...proof(), raw: "private-canary" }))
      .then(() => {
        setImmediate(() => { assert.equal(f.confirmations, 0); child.emit("close"); });
        return { stdout: "", stderr: "" };
      });
    pending.child = child;
    return pending;
  };
  const result = await runRestrictedInstaller(f.context, { root: f.root, environment: f.environment, controller: f.controller, execute });
  assert.equal(f.confirmations, 1); assert.equal(result.status, "PASS");
  assert.doesNotMatch(JSON.stringify(result), /private-/);
  assert.deepEqual(JSON.parse(await readFile(join(f.root, "release.json"), "utf8")), release);
});

test("Windows clean controller environment resolves node.exe through the real PowerShell command lookup",
  { skip: process.platform !== "win32" }, async (t) => {
    const f = await fixture(t);
    await copyFile(process.execPath, f.controller.node);
    let captured;
    const execute = async (file, args, options) => {
      captured = { file, options };
      await writeFile(args[args.indexOf("-ReportPath") + 1], JSON.stringify(proof()));
      return { stdout: "", stderr: "" };
    };
    await runRestrictedInstaller(f.context, { root: f.root, environment: f.environment, controller: f.controller, execute });
    for (const includeExtensions of [false, true]) {
      const env = { ...captured.options.env };
      if (!includeExtensions) delete env.PATHEXT;
      const result = spawnSync(captured.file, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", [
        "$ErrorActionPreference = 'Stop'",
        "try { $matches = @(Get-Command node -CommandType Application) } catch { exit 23 }",
        "if ($matches.Count -ne 1 -or $matches[0].Source -ine (Join-Path $env:HOME 'node.exe')) { exit 24 }",
        "[Console]::WriteLine('NODE_LOOKUP_PASS')",
      ].join("\n")], { ...captured.options, env, timeout: 15000 });
      assert.ifError(result.error);
      assert.equal(result.stderr, "");
      assert.equal(result.status, includeExtensions ? 0 : 23);
      assert.equal(result.stdout.trim(), includeExtensions ? "NODE_LOOKUP_PASS" : "");
    }
  });

test("setup diagnostics expose only the fixed initialization stage", () => {
  for (const setupStep of ["node-lookup", "probe-directory", "node-preflight", "controller-directory", "controller-runtime",
    "wfp-build", "account-create", "account-acl", "private-path", undefined]) {
    assert.throws(() => installationEvidence({ ...proof(), status: "FAIL", stage: "setup", setupStep }, release), (error) => {
      assert.equal(error.diagnostic.setupStep, setupStep === "private-path" ? undefined : setupStep);
      assert.doesNotMatch(JSON.stringify(error), /private-path/);
      return true;
    });
  }
});

test("profile creation diagnostics accept only its bounded numeric HRESULT", () => {
  for (const sessionNativeHResult of [0x80070005, 0xffffffff, 0, -1, 0x100000000, 1.5, "private-error", undefined]) {
    for (const suffix of ["PROFILE_CREATE", "PROFILE_EXISTS", "PROFILE_LOAD"]) {
      const value = { ...proof(), status: "FAIL", stage: "install-profile", sessionNativeHResult,
        sessionErrorCode: "CURSOR_APP_WINDOWS_SESSION_" + suffix };
      assert.throws(() => installationEvidence(value, release), (error) => {
        const expected = suffix !== "PROFILE_LOAD" && Number.isInteger(sessionNativeHResult)
          && sessionNativeHResult > 0 && sessionNativeHResult <= 0xffffffff ? sessionNativeHResult : undefined;
        assert.equal(error.diagnostic.sessionNativeHResult, expected);
        assert.doesNotMatch(JSON.stringify(error), /private-error/);
        return true;
      });
    }
  }
});

test("PowerShell projects the native HRESULT through a wrapped exception without raw messages", async (t) => {
  const available = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"],
    { encoding: "utf8", timeout: 10000 });
  if (available.error?.code === "ENOENT") return t.skip("PowerShell is not installed");
  assert.equal(available.status, 0);
  const source = (await readFile(new URL("./cursor-app-windows-isolation-check.ps1", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  const helper = source.match(/function Get-SessionNativeHResult\([\s\S]*?\n\}/)?.[0];
  assert.ok(helper);
  const result = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type 'public class CursorWindowsSessionException : System.Exception {
    public uint? NativeHResult { get; set; }
    public CursorWindowsSessionException() : base("private-native-message") {} }'
${helper}
$native = [CursorWindowsSessionException]::new()
$native.NativeHResult = [uint32]2147942405
$wrapped = [System.Exception]::new('private-outer-message', $native)
$withCode = Get-SessionNativeHResult $wrapped
$native.NativeHResult = $null
$withoutCode = Get-SessionNativeHResult $wrapped
$ordinary = Get-SessionNativeHResult ([System.Exception]::new('private-ordinary-message'))
ConvertTo-Json -Compress @{ withCode = $withCode; withoutCode = $withoutCode; ordinary = $ordinary }
`], { encoding: "utf8", timeout: 15000, maxBuffer: 8192 });
  assert.equal(result.status, 0); assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), { withCode: 2147942405, withoutCode: null, ordinary: null });
  assert.doesNotMatch(result.stdout, /private-/);
});

test("PowerShell passes plain string environment entries to the C# installer session", async (t) => {
  const available = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"],
    { encoding: "utf8", timeout: 10000 });
  if (available.error?.code === "ENOENT") return t.skip("PowerShell is not installed");
  assert.equal(available.status, 0);
  const source = (await readFile(new URL("./cursor-app-windows-isolation-check.ps1", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  const start = source.indexOf("    $environment = @{", source.indexOf("function Invoke-RestrictedInstaller"));
  const end = source.indexOf("    $report.stage = 'install-run'", start);
  assert.ok(start >= 0 && end > start);
  const result = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `
$ErrorActionPreference = 'Stop'
Add-Type 'public static class CursorEnvironmentFixture {
    public static bool PlainStrings(System.Collections.IDictionary values) {
        foreach (System.Collections.DictionaryEntry entry in values)
            if (!(entry.Key is string) || !(entry.Value is string)) return false;
        return values.Count == 11;
    }
}'
$profile = [System.IO.Path]::GetTempPath()
$temp = Join-Path $profile 'synthetic-temp'
$env:SystemRoot = $profile
${source.slice(start, end)}
ConvertTo-Json -Compress ([CursorEnvironmentFixture]::PlainStrings($environment))
`], { encoding: "utf8", timeout: 15000, maxBuffer: 8192 });
  assert.equal(result.status, 0); assert.equal(result.stderr, "");
  assert.equal(JSON.parse(result.stdout), true);
});

test("controller failures confirm closure only with a complete cleanup report", async (t) => {
  for (const clean of [false, true]) {
    const f = await fixture(t), value = proof();
    value.status = "FAIL"; value.stage = "install-run"; value.errorCode = "CURSOR_APP_WINDOWS_INSTALL_TIMEOUT";
    value.cleanup.profileRemoved = clean;
    const execute = async (file, args) => {
      await writeFile(args[args.indexOf("-ReportPath") + 1], JSON.stringify(value));
      throw Object.assign(new Error("private-canary"), { code: 1, stdout: "", stderr: "" });
    };
    await assert.rejects(runRestrictedInstaller(f.context, { root: f.root, environment: f.environment, controller: f.controller, execute }),
      { code: "CURSOR_APP_WINDOWS_INSTALL_COORDINATOR_FAILED" });
    assert.equal(f.confirmations, clean ? 1 : 0);
  }
});

test("timeouts, raw output, malformed and oversized reports never authorize installer cleanup", async (t) => {
  for (const mode of ["timeout", "stdout", "stderr", "malformed", "oversized", "extraExit"]) {
    const f = await fixture(t);
    const execute = async (file, args) => {
      const body = mode === "malformed" ? "private-canary" : mode === "oversized" ? "x".repeat(16385) : JSON.stringify(proof());
      await writeFile(args[args.indexOf("-ReportPath") + 1], body);
      if (mode === "timeout") throw { killed: true, code: null, stdout: "", stderr: "" };
      return { code: mode === "extraExit" ? 23 : 0, stdout: mode === "stdout" ? "private-canary" : "",
        stderr: mode === "stderr" ? "private-canary" : "" };
    };
    await assert.rejects(runRestrictedInstaller(f.context, { root: f.root, environment: f.environment, controller: f.controller, execute }));
    assert.equal(f.confirmations, 0);
  }
});

test("installation check freezes both channels once and keeps each user's installation independent", async (t) => {
  const f = await fixture(t), calls = [];
  let resolutions = 0;
  const report = await runWindowsInstallCheck(join(f.root, "public"), {
    environment: f.environment, platform: "win32", arch: "x64", nodeMajor: "24",
    async resolveReleases() { resolutions++; return { schemaVersion: 1, baseline: { [platform]: release }, latest: { [platform]: latest } }; },
    async prepareController(bundleRoot) {
      return { root: bundleRoot, async useInstaller({ release: selected, root }, callback) {
        calls.push(root);
        const result = await callback({ ...f.context, release: selected });
        return { verification: { ...selected, ownedFilesRemoved: true, authenticodeVerified: true, publisherVerified: true }, result };
      } };
    },
    async install(context) { return { ...installationEvidence(proof(), context.release), private: "private-canary" }; },
  });
  assert.equal(resolutions, 1); assert.equal(calls.length, 2); assert.notEqual(calls[0], calls[1]);
  assert.equal(report.status, "PASS"); assert.equal(report.nativeAcceptance, false); assert.equal(report.appLaunchRequested, false);
  assert.equal(report.trustPolicyChanged, false); assert.equal(report.cleanup.ownedFilesRemoved, true);
  assert.deepEqual(report.releases.map((item) => item.channel), ["baseline", "latest"]);
  assert.doesNotMatch(JSON.stringify(report), /private-canary/);
  assert.deepEqual(await readdir(f.root), ["public"]);
});

test("installer acquisition never runs on unsupported hosts or invalid frozen descriptors", async (t) => {
  for (const mode of ["host", "release"]) {
    const f = await fixture(t); let acquisitions = 0;
    const report = await runWindowsInstallCheck(join(f.root, "public"), {
      environment: f.environment, platform: mode === "host" ? "darwin" : "win32", arch: "x64", nodeMajor: "24",
      async resolveReleases() { return { schemaVersion: 1, baseline: { [platform]: release } }; },
      async prepareController() { acquisitions++; },
    });
    assert.equal(report.status, "FAIL"); assert.equal(acquisitions, 0);
  }
});

test("uncertain installer cleanup preserves controller state without exposing private failures", async (t) => {
  const f = await fixture(t);
  const report = await runWindowsInstallCheck(join(f.root, "public"), {
    environment: f.environment, platform: "win32", arch: "x64", nodeMajor: "24",
    async resolveReleases() { return { schemaVersion: 1, baseline: { [platform]: release }, latest: { [platform]: latest } }; },
    async prepareController(bundleRoot) {
      return { root: bundleRoot, async useInstaller() {
        throw Object.assign(new Error("private-canary"), { cleanupErrorCode: "CURSOR_APP_WINDOWS_ARTIFACT_PROCESS_CLEANUP" });
      } };
    },
  });
  assert.equal(report.status, "FAIL"); assert.equal(report.cleanup.ownedFilesRemoved, false);
  assert.equal((await readdir(f.root)).length, 2); assert.doesNotMatch(JSON.stringify(report), /private-canary/);
});

test("PowerShell installer runs after the policy proof and cleans the job and profile before WFP", async () => {
  const source = (await readFile(new URL("./cursor-app-windows-isolation-check.ps1", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  assert.ok(source.indexOf("Invoke-ProbeRun 'restricted'") < source.indexOf("if ($installationMode) { Invoke-RestrictedInstaller }"));
  for (const text of [".CreateAndLoadProfile()", ".StartBootstrap(", ".WaitForEmpty(300000)", ".TerminateAndWait(15000)",
    ".UnloadProfile()", ".DeleteProfile()", "'/MERGETASKS=!runcode'", "Get-FileHash -LiteralPath $copiedInstaller"]) assert.ok(source.includes(text), text);
  const cleanup = source.slice(source.indexOf("} finally {\n    $processesClosed ="));
  assert.ok(cleanup.indexOf(".TerminateAndWait(") < cleanup.indexOf(".UnloadProfile()"));
  assert.ok(cleanup.indexOf(".DeleteProfile()") < cleanup.indexOf("Invoke-Wfp 'remove'"));
  assert.match(cleanup, /\$processesClosed = \$processesClosed -and \$installedVerifierClosed/);
  assert.match(cleanup, /\$processesClosed = \$processesClosed -and \$profileRemoved/);
  assert.match(source, /\(Join-Path \$controllerRoot 'release.json'\), \$controllerRoot, \$profile, \$appDirectory\) -Executable \$controllerNode -WorkingDirectory \$controllerRoot/);
  assert.match(source, /\$controllerNode = Join-Path \$controllerRoot 'node.exe'\s+Copy-Item -LiteralPath \$sourceNode -Destination \$controllerNode/);
  assert.doesNotMatch(source, /taskkill|Stop-Process|Kill\(\$true\)|Set-ExecutionPolicy|Import-Certificate/);
});
