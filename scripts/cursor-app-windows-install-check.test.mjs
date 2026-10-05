import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
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
