import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { baselineRelease } from "./cursor-app-release.mjs";
import { verifyCursorWindowsInstalledApp } from "./cursor-app-windows-artifact.mjs";
import { readInstalledRelease } from "./cursor-app-windows-installed.mjs";

const release = baselineRelease("win32-x64-user"), prefix = "CURSOR_APP_WINDOWS_ARTIFACT_";
const helperPath = new URL("./cursor-app-windows-authenticode.ps1", import.meta.url);
const entryPath = new URL("./cursor-app-windows-installed.mjs", import.meta.url);
function executable(machine = 0x8664) {
  const bytes = Buffer.alloc(512);
  bytes.write("MZ"); bytes.writeUInt32LE(128, 60); bytes.writeUInt32LE(0x4550, 128);
  bytes.writeUInt16LE(machine, 132); bytes.writeUInt16LE(1, 134);
  bytes.writeUInt16LE(240, 148); bytes.writeUInt16LE(2, 150); bytes.writeUInt16LE(0x20b, 152);
  return bytes;
}
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "cursor-installed-fixture-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scratch = join(root, "controller"), profileRoot = join(root, "profile");
  const appDirectory = join(profileRoot, "AppData", "Local", "Programs", "Cursor");
  await mkdir(scratch); await mkdir(join(appDirectory, "resources", "app"), { recursive: true });
  await writeFile(join(scratch, "unrelated"), "preserve");
  await writeFile(join(appDirectory, "Cursor.exe"), executable());
  await writeFile(join(appDirectory, "resources", "app", "package.json"), JSON.stringify({ version: release.version }));
  await writeFile(join(appDirectory, "resources", "app", "product.json"), JSON.stringify({ version: release.version,
    commit: "0".repeat(40), realCommit: release.commitSha }));
  const calls = [];
  const options = { release, root: scratch, profileRoot, appDirectory, platform: "win32",
    async execute(file, args, configuration) {
      const operation = args[args.indexOf("-Operation") + 1];
      calls.push({ file, args, configuration, operation });
      return { stdout: JSON.stringify(operation === "prepare" ? { status: "PASS", operation, privateDirectory: true }
        : { status: "PASS", operation, appIdentityVerified: true, appArchitectureVerified: true,
          authenticodeVerified: true, publisherVerified: true }), stderr: "" };
    } };
  return { root, scratch, profileRoot, appDirectory, options, calls };
}

test("installed App verifier uses separate controller scratch and passes exact frozen identity", async (t) => {
  const f = await fixture(t), result = await verifyCursorWindowsInstalledApp(f.options);
  assert.deepEqual(result, { platform: "win32-x64-user", channel: "baseline", version: release.version,
    commitSha: release.commitSha, architecture: "x64", appIdentityVerified: true, appArchitectureVerified: true,
    authenticodeVerified: true, publisherVerified: true, ownedFilesRemoved: true });
  assert.ok(Object.isFrozen(result));
  assert.deepEqual(f.calls.map((call) => call.operation), ["prepare", "installed"]);
  const call = f.calls[1], payload = call.args[call.args.indexOf("-Directory") + 1];
  assert.deepEqual(call.args.slice(5), ["-Operation", "installed", "-Directory", payload,
    "-ProfileRoot", f.profileRoot, "-AppDirectory", f.appDirectory, "-Version", release.version, "-Commit", release.commitSha]);
  assert.equal(dirname(payload), dirname(call.configuration.cwd));
  assert.notEqual(call.configuration.env.USERPROFILE, f.profileRoot);
  assert.equal(call.configuration.env.USERPROFILE, call.configuration.cwd);
  assert.deepEqual(await readdir(f.scratch), ["unrelated"]);
  assert.deepEqual(await readFile(join(f.appDirectory, "Cursor.exe")), executable());
  assert.equal(JSON.stringify(result).includes(f.root), false);
});

test("installed App verifier rejects unsupported or missing authority before calling PowerShell", async (t) => {
  const f = await fixture(t);
  for (const override of [{ platform: "darwin" }, { profileRoot: "relative" }, { appDirectory: "relative" },
    { root: "relative" }, { execute: null }, { release: { ...release, commitSha: "a".repeat(40) } }]) {
    await assert.rejects(verifyCursorWindowsInstalledApp({ ...f.options, ...override }));
  }
  assert.equal(f.calls.length, 0);
});

test("installed App fixed failures and invalid receipts never produce identity evidence", async (t) => {
  for (const suffix of ["INSTALLED_PATH", "PACKAGE", "ARCHITECTURE", "SIGNATURE", "PUBLISHER"]) {
    const f = await fixture(t), execute = f.options.execute;
    f.options.execute = async (...args) => {
      if (args[1].includes("installed")) throw { code: 1, stdout: JSON.stringify({ status: "FAIL", errorCode: prefix + suffix }), stderr: "" };
      return execute(...args);
    };
    await assert.rejects(verifyCursorWindowsInstalledApp(f.options), { code: prefix + suffix });
    assert.deepEqual(await readdir(f.scratch), ["unrelated"]);
  }
  for (const change of [{ appIdentityVerified: false }, { appArchitectureVerified: false }, { privatePath: "private-canary" }]) {
    const f = await fixture(t), execute = f.options.execute;
    f.options.execute = async (...args) => {
      const result = await execute(...args);
      if (args[1].includes("installed")) result.stdout = JSON.stringify({ ...JSON.parse(result.stdout), ...change });
      return result;
    };
    await assert.rejects(verifyCursorWindowsInstalledApp(f.options), { code: prefix + "HELPER_INSTALLED_OUTPUT" });
  }
});

test("installed verifier retains controller scratch when the helper close is unconfirmed", async (t) => {
  const f = await fixture(t), execute = f.options.execute;
  f.options.execute = (...args) => {
    const result = execute(...args);
    if (args[1].includes("installed")) result.child = new EventEmitter();
    return result;
  };
  await assert.rejects(verifyCursorWindowsInstalledApp(f.options), {
    code: prefix + "PROCESS_CLEANUP", cleanupErrorCode: prefix + "PROCESS_CLEANUP",
  });
  const entries = await readdir(f.scratch);
  assert.equal(entries.length, 2);
  assert.equal(entries.filter((entry) => entry.startsWith("cursor-windows-installed-")).length, 1);
  assert.deepEqual(await readFile(join(f.appDirectory, "Cursor.exe")), executable());
});

test("installed CLI reads only a bounded canonical regular descriptor and emits fixed failures", async (t) => {
  const f = await fixture(t), descriptor = join(f.root, "descriptor.json");
  await writeFile(descriptor, JSON.stringify(release));
  assert.deepEqual(await readInstalledRelease(descriptor), release);
  for (const value of ["", "private-canary", " ".repeat(16385), Buffer.from([0xc0, 0xaf])]) {
    await writeFile(descriptor, value);
    await assert.rejects(readInstalledRelease(descriptor), { code: prefix + "RELEASE", message: prefix + "RELEASE" });
  }
  for (const path of ["relative", f.root, join(f.root, "missing-private-canary")]) {
    await assert.rejects(readInstalledRelease(path), { code: prefix + "RELEASE", message: prefix + "RELEASE" });
  }
  if (process.platform !== "win32") {
    const linked = join(f.root, "descriptor-link.json");
    await symlink(descriptor, linked);
    await assert.rejects(readInstalledRelease(linked), { code: prefix + "RELEASE" });
  }
  const result = spawnSync(process.execPath, [fileURLToPath(entryPath), descriptor, f.scratch, f.profileRoot, f.appDirectory],
    { encoding: "utf8", timeout: 10000 });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.trim(), prefix + "RELEASE");
  const missingArguments = spawnSync(process.execPath, [fileURLToPath(entryPath)], { encoding: "utf8", timeout: 10000 });
  assert.equal(missingArguments.status, 1);
  assert.equal(missingArguments.stdout, "");
  assert.equal(missingArguments.stderr.trim(), prefix + "ARGUMENTS");
});

test("installed App PowerShell validates real files, metadata, PE identity and reparse paths without executing them", async (t) => {
  const available = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"],
    { encoding: "utf8", timeout: 10000 });
  if (available.error?.code === "ENOENT") return t.skip("PowerShell is not installed");
  assert.equal(available.status, 0);
  const source = (await readFile(helperPath, "utf8")).replaceAll("\r\n", "\n");
  const functions = source.match(/function Assert-InstalledPath\([\s\S]*?(?=\ntry \{\n    if \(-not \$IsWindows)/)?.[0];
  assert.ok(functions);
  const cases = [
    ["valid", undefined, "PASS"],
    ["package-version", async (f) => writeFile(join(f.appDirectory, "resources/app/package.json"), '{"version":"0.0.0"}'), "PACKAGE"],
    ["product-version", async (f) => writeFile(join(f.appDirectory, "resources/app/product.json"), JSON.stringify({ version: "0.0.0", realCommit: release.commitSha })), "PACKAGE"],
    ["real-commit-required", async (f) => writeFile(join(f.appDirectory, "resources/app/product.json"), JSON.stringify({ version: release.version, commit: release.commitSha })), "PACKAGE"],
    ["wrong-commit", async (f) => writeFile(join(f.appDirectory, "resources/app/product.json"), JSON.stringify({ version: release.version, realCommit: "a".repeat(40) })), "PACKAGE"],
    ["malformed-json", async (f) => writeFile(join(f.appDirectory, "resources/app/product.json"), "private malformed metadata"), "PACKAGE"],
    ["oversized-json", async (f) => writeFile(join(f.appDirectory, "resources/app/package.json"), " ".repeat(1048577)), "PACKAGE"],
    ["arm64-exe", async (f) => writeFile(join(f.appDirectory, "Cursor.exe"), executable(0xaa64)), "ARCHITECTURE"],
    ["x86-exe", async (f) => writeFile(join(f.appDirectory, "Cursor.exe"), executable(0x14c)), "ARCHITECTURE"],
    ["truncated-exe", async (f) => writeFile(join(f.appDirectory, "Cursor.exe"), executable().subarray(0, 150)), "ARCHITECTURE"],
    ["bad-pe", async (f) => { const data = executable(); data.writeUInt32LE(0, 128); await writeFile(join(f.appDirectory, "Cursor.exe"), data); }, "ARCHITECTURE"],
    ["outside-profile", async (f) => { f.profileRoot = join(f.root, "other-profile"); await mkdir(f.profileRoot); }, "INSTALLED_PATH"],
  ];
  if (process.platform !== "win32") cases.push(["metadata-link", async (f) => {
    const path = join(f.appDirectory, "resources/app/package.json"), target = join(f.root, "outside.json");
    await writeFile(target, JSON.stringify({ version: release.version })); await rm(path); await symlink(target, path);
  }, "INSTALLED_PATH"]);
  cases.push(["metadata-directory-link", async (f) => {
    const path = join(f.appDirectory, "resources"), target = join(f.root, "outside-resources");
    await mkdir(join(target, "app"), { recursive: true });
    await writeFile(join(target, "app", "package.json"), JSON.stringify({ version: release.version }));
    await writeFile(join(target, "app", "product.json"), JSON.stringify({ version: release.version, realCommit: release.commitSha }));
    await rm(path, { recursive: true }); await symlink(target, path, process.platform === "win32" ? "junction" : "dir");
  }, "INSTALLED_PATH"]);
  const inputs = [];
  for (const [name, change, expected] of cases) {
    const f = await fixture(t); await change?.(f);
    inputs.push({ name, expected, profileRoot: f.profileRoot, appDirectory: f.appDirectory });
  }
  const script = `$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Get-TestSignature { param($LiteralPath, $ErrorAction) return 'synthetic' }
function Assert-CursorPublisher($Signature) { if ($Signature -cne 'synthetic') { throw '${prefix}SIGNATURE' } }
${functions.replaceAll("Microsoft.PowerShell.Security\\Get-AuthenticodeSignature", "Get-TestSignature")}
$cases = '${JSON.stringify(inputs).replaceAll("'", "''")}' | ConvertFrom-Json -AsHashtable
$results = foreach ($case in $cases) {
    $outcome = 'PASS'
    try { Assert-InstalledCursor $case.profileRoot $case.appDirectory '${release.version}' '${release.commitSha}' }
    catch { $outcome = $_.Exception.Message }
    [ordered]@{ name = $case.name; outcome = $outcome }
}
ConvertTo-Json -InputObject @($results) -Compress`;
  const result = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", timeout: 30000, maxBuffer: 32768 });
  assert.equal(result.status, 0, "PowerShell installed metadata fixtures failed");
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), inputs.map(({ name, expected }) => ({ name,
    outcome: expected === "PASS" ? expected : prefix + expected })));
  assert.equal(result.stdout.includes("private malformed"), false);
});
