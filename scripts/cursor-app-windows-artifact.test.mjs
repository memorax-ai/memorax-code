import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { baselineRelease, resolveDownload } from "./cursor-app-release.mjs";
import { selectCursorWindowsRelease, withVerifiedCursorWindowsInstaller } from "./cursor-app-windows-artifact.mjs";

const baseline = baselineRelease("win32-x64-user");
const latest = resolveDownload("win32-x64-user", { version: "3.23.12", commitSha: "1".repeat(40),
  downloadUrl: `https://downloads.cursor.com/production/${"1".repeat(40)}/win32/x64/user-setup/CursorUserSetup-x64-3.23.12.exe` });
const manifest = { schemaVersion: 1, baseline: { "win32-x64-user": baseline }, latest: { "win32-x64-user": latest } };
const bytes = Buffer.from("Synthetic unsigned bytes. Never execute this fixture.");
const prefix = "CURSOR_APP_WINDOWS_ARTIFACT_";
const rootStages = ["PATH_SHAPE", "ITEM", "IDENTITY", "NOT_EMPTY", "ACL_SET", "ACL_READ", "PROTECTION",
  "OWNER", "RULE_COUNT", "RULE_SHAPE"];
const helper = async () => (await readFile(new URL("./cursor-app-windows-authenticode.ps1", import.meta.url), "utf8"))
  .replaceAll("\r\n", "\n");
const error = (suffix) => ({ code: prefix + suffix, message: prefix + suffix });

async function fixture(t, configuration = {}) {
  const root = await mkdtemp(join(tmpdir(), "cursor-windows-artifact-test-"));
  t.after(async () => { await chmod(root, 0o700); await rm(root, { recursive: true, force: true }); });
  await writeFile(join(root, "unrelated"), "preserve");
  const release = configuration.release ?? baseline;
  const state = { root, calls: [], fetches: [] };
  const execute = async (file, args, options) => {
    const operation = args[args.indexOf("-Operation") + 1];
    state.payloadRoot = args[args.indexOf("-Directory") + 1];
    state.ownedRoot = dirname(state.payloadRoot);
    state.runtimeRoot = options.cwd;
    state.path = join(state.payloadRoot, "CursorUserSetup.exe");
    state.calls.push({ file, args, options, operation });
    assert.ok(["prepare", "verify"].includes(operation));
    if (configuration.runtimeWrites) {
      for (const key of ["HOME", "TMP"]) await writeFile(join(options.env[key], `${operation}-${key}.cache`), "runtime");
    }
    if (operation === "prepare" && (await readdir(state.payloadRoot)).length !== 0) {
      throw { code: 1, stdout: JSON.stringify({ status: "FAIL", errorCode: prefix + "ROOT_NOT_EMPTY" }), stderr: "" };
    }
    if (operation === configuration.fail) throw new Error("private command path and stderr");
    if (operation === configuration.commandError?.operation) throw configuration.commandError.error;
    if (operation === "verify") await configuration.onVerify?.(state);
    return configuration.outputs?.[operation] ?? { stdout: JSON.stringify(operation === "prepare"
      ? { status: "PASS", operation, privateDirectory: true }
      : { status: "PASS", operation, authenticodeVerified: true, publisherVerified: true }), stderr: "" };
  };
  const fetchImpl = async (url, options) => {
    state.fetches.push({ url, options });
    assert.deepEqual(state.calls.map((call) => call.operation), ["prepare"]);
    if (configuration.fetchError) throw new Error("private network diagnostics");
    return { status: 200, redirected: false, url: release.url,
      headers: new Headers({ "content-length": String(bytes.length) }),
      body: (async function* () { yield bytes.subarray(0, 4); yield bytes.subarray(4); })(), ...configuration.response };
  };
  state.options = { release, root, platform: "win32", execute, fetchImpl };
  state.run = async (overrides = {}) => {
    const { verification } = await withVerifiedCursorWindowsInstaller({ ...state.options, ...overrides },
      async ({ confirmProcessesClosed }) => { confirmProcessesClosed(); });
    return verification;
  };
  state.assertClean = async () => assert.deepEqual(await readdir(root), ["unrelated"]);
  return state;
}

test("selects only canonical frozen Windows UserSetup descriptors without inventing official checksums", () => {
  for (const channel of ["baseline", "latest"]) {
    const selected = selectCursorWindowsRelease(manifest, channel);
    assert.deepEqual(selected, manifest[channel]["win32-x64-user"]);
    assert.equal(selected.sha256, null);
    assert.equal(selected.hashSource, "not-provided");
    assert.ok(Object.isFrozen(selected));
  }
  assert.equal(selectCursorWindowsRelease({ ...manifest,
    latest: { "win32-x64-user": { ...baseline, channel: "latest" } } }, "latest").channel, "latest");
  for (const value of [null, {}, { ...manifest, schemaVersion: 2 }, { ...manifest, latest: {} }]) {
    assert.throws(() => selectCursorWindowsRelease(value, "latest"), error("RELEASE"));
  }
  for (const channel of [undefined, "unknown", "darwin-arm64"]) {
    assert.throws(() => selectCursorWindowsRelease(manifest, channel), error("RELEASE"));
  }
  for (const change of [{ platform: "win32-arm64-user" }, { channel: "baseline" }, { version: "3.23.012" },
    { commitSha: "A".repeat(40) }, { url: latest.url + "?private=value" }, { url: latest.url.replace("https:", "http:") },
    { url: latest.url.replace("downloads.cursor.com", "private.invalid") }, { sha256: "a".repeat(64) },
    { hashSource: "observed-sha256" }, { url: latest.url.replace("user-setup", "system-setup") }]) {
    assert.throws(() => selectCursorWindowsRelease({ ...manifest,
      latest: { "win32-x64-user": { ...latest, ...change } } }, "latest"), error("RELEASE"));
  }
  assert.throws(() => selectCursorWindowsRelease({ ...manifest,
    baseline: { "win32-x64-user": { ...latest, channel: "baseline" } } }, "baseline"), error("RELEASE"));
});

test("verifies synthetic downloaded bytes and removes only its owned directory after the callback closes", async (t) => {
  const state = await fixture(t, { onVerify: async ({ path }) => assert.deepEqual(await readFile(path), bytes) });
  const result = await state.run();
  assert.deepEqual(result, { platform: "win32-x64-user", channel: "baseline", version: baseline.version,
    commitSha: baseline.commitSha, sha256: null, hashSource: "not-provided", bytes: bytes.length,
    observedSha256: createHash("sha256").update(bytes).digest("hex"), authenticodeVerified: true,
    publisherVerified: true, signatureType: "Authenticode", publisher: "Anysphere, Inc.", ownedFilesRemoved: true });
  assert.ok(Object.isFrozen(result));
  assert.equal(JSON.stringify(result).includes(state.root), false);
  assert.deepEqual(state.calls.map((call) => call.operation), ["prepare", "verify"]);
  for (const call of state.calls) {
    assert.equal(call.file, "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
    assert.deepEqual(call.args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-File"]);
    assert.ok(call.args[4].endsWith("cursor-app-windows-authenticode.ps1"));
    assert.deepEqual(call.args.slice(5), ["-Operation", call.operation, "-Directory", state.payloadRoot]);
    assert.equal(call.options.cwd, state.runtimeRoot);
    assert.equal(call.options.timeout, 120_000);
    assert.equal(call.options.maxBuffer, 4096);
    assert.equal(call.options.encoding, "utf8");
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.killSignal, "SIGKILL");
    assert.deepEqual(Object.keys(call.options.env).sort(), ["APPDATA", "COMSPEC", "HOME", "LOCALAPPDATA", "PATH",
      "PSModulePath", "ProgramFiles", "SystemRoot", "TEMP", "TMP", "USERPROFILE", "WINDIR"].sort());
    assert.equal(call.options.env.PSModulePath, "C:\\Program Files\\PowerShell\\7\\Modules");
    assert.equal(call.options.env.PATH, "C:\\Program Files\\PowerShell\\7;C:\\Windows\\System32");
    for (const key of ["HOME", "USERPROFILE", "TEMP", "TMP"]) assert.equal(call.options.env[key], state.runtimeRoot);
  }
  assert.equal(state.fetches.length, 1);
  assert.equal(state.fetches[0].url, baseline.url);
  const options = state.fetches[0].options;
  assert.equal(options.redirect, "error");
  assert.equal(options.credentials, "omit");
  assert.equal(options.cache, "no-store");
  assert.deepEqual(options.headers, { "User-Agent": "memorax-cursor-app-ci" });
  assert.ok(options.signal instanceof AbortSignal);
  await assert.rejects(access(state.path), { code: "ENOENT" });
  await state.assertClean();
});

test("PowerShell HOME and TMP startup files cannot pollute the empty payload or installer fingerprints", async (t) => {
  const state = await fixture(t, { runtimeWrites: true, onVerify: async ({ payloadRoot, path }) => {
    assert.deepEqual(await readdir(payloadRoot), ["CursorUserSetup.exe"]);
    assert.deepEqual(await readFile(path), bytes);
  } });
  const result = await state.run();
  assert.equal(result.authenticodeVerified, true);
  assert.equal(result.observedSha256, createHash("sha256").update(bytes).digest("hex"));
  assert.deepEqual(state.calls.map((call) => call.operation), ["prepare", "verify"]);
  assert.equal(state.payloadRoot, join(state.ownedRoot, "payload"));
  assert.equal(state.runtimeRoot, join(state.ownedRoot, "runtime"));
  for (const call of state.calls) {
    assert.equal(call.options.env.APPDATA, join(state.runtimeRoot, "AppData", "Roaming"));
    assert.equal(call.options.env.LOCALAPPDATA, join(state.runtimeRoot, "AppData", "Local"));
  }
  await assert.rejects(access(state.ownedRoot), { code: "ENOENT" });
  await state.assertClean();
});

test("verified installer use stays private and waits for explicit process cleanup before deleting bytes", async (t) => {
  const state = await fixture(t);
  const value = { synthetic: true };
  const result = await withVerifiedCursorWindowsInstaller(state.options, async (context) => {
    assert.deepEqual(state.calls.map((call) => call.operation), ["prepare", "verify"]);
    assert.equal(context.installerPath, state.path);
    assert.deepEqual(context.release, baseline);
    assert.equal(context.artifact.observedSha256, createHash("sha256").update(bytes).digest("hex"));
    assert.ok(Object.isFrozen(context.release));
    assert.ok(Object.isFrozen(context.artifact));
    assert.deepEqual(await readFile(context.installerPath), bytes);
    context.confirmProcessesClosed();
    await Promise.resolve();
    assert.deepEqual(await readFile(context.installerPath), bytes);
    return value;
  });
  assert.equal(result.result, value);
  assert.equal(result.verification.authenticodeVerified, true);
  assert.equal(result.verification.ownedFilesRemoved, true);
  assert.equal(Object.hasOwn(result.verification, "installerPath"), false);
  assert.equal(JSON.stringify(result.verification).includes(state.root), false);
  await state.assertClean();
});

test("unconfirmed callback cleanup retains installer bytes on either return or failure", async (t) => {
  for (const throws of [false, true]) {
    const state = await fixture(t);
    const primary = new Error("private callback failure");
    await assert.rejects(withVerifiedCursorWindowsInstaller(state.options, async () => {
      if (throws) throw primary;
      return "not cleanup evidence";
    }), (caught) => {
      if (throws) assert.equal(caught, primary);
      else assert.equal(caught.code, prefix + "PROCESS_CLEANUP");
      assert.equal(caught.cleanupErrorCode, prefix + "PROCESS_CLEANUP");
      return true;
    });
    assert.deepEqual(await readFile(state.path), bytes);
  }
});

test("confirmed callback failure preserves its primary error while safely removing owned bytes", async (t) => {
  const state = await fixture(t), primary = new Error("private callback failure");
  await assert.rejects(withVerifiedCursorWindowsInstaller(state.options, async ({ confirmProcessesClosed }) => {
    try { throw primary; } finally { confirmProcessesClosed(); }
  }), (caught) => caught === primary && caught.cleanupErrorCode === undefined);
  await state.assertClean();
});

test("installer callbacks cannot run before verification or hide changed bytes and cancellation", async (t) => {
  let calls = 0;
  const invalid = await fixture(t, { fail: "verify" });
  await assert.rejects(withVerifiedCursorWindowsInstaller(invalid.options, async () => { calls++; }), error("HELPER_VERIFY_EXIT"));
  assert.equal(calls, 0);
  await invalid.assertClean();
  await assert.rejects(withVerifiedCursorWindowsInstaller(invalid.options, null), error("ARGUMENTS"));
  for (const abort of [false, true]) {
    const state = await fixture(t), controller = new AbortController();
    await assert.rejects(withVerifiedCursorWindowsInstaller({ ...state.options, signal: controller.signal },
      async ({ installerPath, confirmProcessesClosed }) => {
        if (abort) controller.abort();
        else await writeFile(installerPath, Buffer.alloc(bytes.length, 1));
        confirmProcessesClosed();
      }), error(abort ? "ABORTED" : "CHANGED"));
    await state.assertClean();
  }
});

test("latest is independently selected without falling back to baseline", async (t) => {
  const state = await fixture(t, { release: latest, response: { headers: new Headers() } });
  const result = await state.run();
  assert.equal(result.channel, "latest");
  assert.equal(result.version, latest.version);
  assert.equal(result.commitSha, latest.commitSha);
  assert.equal(state.fetches[0].url, latest.url);
  await state.assertClean();
});

test("unsupported hosts, release changes, roots and aborts fail before download", async (t) => {
  const state = await fixture(t);
  for (const [overrides, suffix] of [[{ platform: "linux" }, "PLATFORM"], [{ root: "relative" }, "ARGUMENTS"],
    [{ root: join(state.root, "unrelated") }, "ROOT_ITEM"], [{ root: join(state.root, "missing") }, "ROOT_ITEM"],
    [{ release: { ...baseline, sha256: "a".repeat(64) } }, "RELEASE"],
    [{ execute: null }, "ARGUMENTS"], [{ fetchImpl: null }, "ARGUMENTS"], [{ signal: AbortSignal.abort() }, "ABORTED"]]) {
    await assert.rejects(state.run(overrides), error(suffix));
  }
  assert.equal(state.calls.length, 0);
  assert.equal(state.fetches.length, 0);
  await state.assertClean();
});

test("redirects, download failures, malformed lengths and oversized or empty streams fail closed", async (t) => {
  class OversizedChunk extends Uint8Array { get byteLength() { return 600_000_001; } }
  const cases = [
    { fetchError: true }, { response: { status: 302 } }, { response: { redirected: true } },
    { response: { url: baseline.url + "?private=value" } }, { response: { body: null } },
    { response: { body: (async function* () { yield "private-invalid-body"; })() } },
    ...["0", "-1", "01", "1.5", "600000001", String(bytes.length + 1)].map((length) => ({
      response: { headers: new Headers({ "content-length": length }) }, size: true })),
    { response: { headers: new Headers(), body: (async function* () {})() }, size: true },
    { response: { headers: new Headers(), body: (async function* () { yield new OversizedChunk(1); })() }, size: true },
  ];
  for (const configuration of cases) {
    const state = await fixture(t, configuration);
    await assert.rejects(state.run(), error(configuration.size ? "DOWNLOAD_SIZE" : "DOWNLOAD"));
    assert.deepEqual(state.calls.map((call) => call.operation), ["prepare"]);
    await state.assertClean();
  }
});

test("helper output is exact fixed JSON and rejects diagnostics, false verification and command failures", async (t) => {
  for (const operation of ["prepare", "verify"]) {
    for (const output of [{ stdout: "private invalid JSON", stderr: "" }, { stdout: "[]", stderr: "" },
      { stdout: "{}\n{}", stderr: "" }, { stdout: "{}", stderr: "private diagnostic" },
      { stdout: "x".repeat(4097), stderr: "" }, { stdout: Buffer.from("{}"), stderr: "" },
      { stdout: JSON.stringify({ status: "PASS", operation, authenticodeVerified: false, publisherVerified: true }), stderr: "" },
      { stdout: JSON.stringify({ status: "PASS", operation, authenticodeVerified: true, publisherVerified: true, path: "private" }), stderr: "" }]) {
      const state = await fixture(t, { outputs: { [operation]: output } });
      await assert.rejects(state.run(), error(`HELPER_${operation.toUpperCase()}_OUTPUT`));
      await state.assertClean();
    }
  }
});

test("helper root failures expose only fixed stages bound to the requested operation", async (t) => {
  for (const operation of ["prepare", "verify"]) {
    for (const stage of rootStages) {
      const state = await fixture(t, { commandError: { operation, error: { code: 1, stderr: "",
        stdout: JSON.stringify({ status: "FAIL", errorCode: prefix + "ROOT_" + stage }) } } });
      await assert.rejects(state.run(), error(`ROOT_${operation.toUpperCase()}_${stage}`));
      assert.equal(state.fetches.length, operation === "prepare" ? 0 : 1);
      await state.assertClean();
    }
  }
  for (const suffix of ["PLATFORM", "SIGNATURE", "PUBLISHER"]) {
    const state = await fixture(t, { commandError: { operation: "verify", error: { code: 1, stderr: "",
      stdout: JSON.stringify({ status: "FAIL", errorCode: prefix + suffix }) } } });
    await assert.rejects(state.run(), error(suffix));
    await state.assertClean();
  }
});

test("helper execution failures and untrusted diagnostics never become ACL or signature findings", async (t) => {
  const privateText = "C:\\Users\\private-account\\private-path CN=private-certificate raw-stderr-canary";
  const rootFailure = { status: "FAIL", errorCode: prefix + "ROOT_OWNER" };
  for (const operation of ["prepare", "verify"]) {
    for (const [caught, suffix] of [
      [new Error(privateText), "EXIT"],
      [{ code: "ENOENT", syscall: "spawn " + privateText, message: privateText }, "SPAWN"],
      [{ code: "EACCES", syscall: "spawn " + privateText, message: privateText }, "SPAWN"],
      [{ code: "ETIMEDOUT", message: privateText }, "TIMEOUT"],
      [{ code: null, killed: true, signal: "SIGKILL", stderr: privateText }, "TIMEOUT"],
      [{ code: 1, killed: true, signal: "SIGKILL", stdout: JSON.stringify(rootFailure), stderr: "" }, "TIMEOUT"],
      [{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true, signal: "SIGKILL", stderr: privateText }, "OUTPUT"],
      [{ code: 1, stdout: JSON.stringify({ status: "FAIL", errorCode: privateText }), stderr: "" }, "EXIT"],
      [{ code: 1, stdout: JSON.stringify({ ...rootFailure, path: privateText }), stderr: "" }, "EXIT"],
      [{ code: 1, stdout: JSON.stringify(rootFailure), stderr: privateText }, "EXIT"],
      [{ code: 1, stdout: JSON.stringify({ status: "FAIL", errorCode: prefix + "ROOT_UNKNOWN" }), stderr: "" }, "EXIT"],
      [{ code: 1, stdout: "private invalid JSON", stderr: "" }, "EXIT"],
      [{ code: 1, stdout: JSON.stringify(rootFailure).repeat(4096), stderr: "" }, "EXIT"],
    ]) {
      const state = await fixture(t, { commandError: { operation, error: caught } });
      await assert.rejects(state.run(), (failure) => {
        assert.equal(failure.code, `${prefix}HELPER_${operation.toUpperCase()}_${suffix}`);
        assert.equal(failure.message, failure.code);
        assert.equal(JSON.stringify(failure).includes(privateText), false);
        assert.equal(failure.stack.includes(privateText), false);
        return true;
      });
      await state.assertClean();
    }
  }
});

test("signature verification cannot accept file changes or a replaced non-file", async (t) => {
  for (const onVerify of [({ path }) => writeFile(path, Buffer.alloc(bytes.length, 1)),
    ({ path }) => writeFile(path, "changed length"), async ({ path }) => { await rm(path); await mkdir(path); }]) {
    const state = await fixture(t, { onVerify });
    await assert.rejects(state.run(), error("CHANGED"));
    await state.assertClean();
  }
});

test("symbolic-link replacement is rejected without deleting its target", { skip: process.platform === "win32" }, async (t) => {
  const state = await fixture(t, { onVerify: async ({ path, root }) => { await rm(path); await symlink(join(root, "unrelated"), path); } });
  await assert.rejects(state.run(), error("CHANGED"));
  assert.equal(await readFile(join(state.root, "unrelated"), "utf8"), "preserve");
  await state.assertClean();
});

test("aborting a helper waits for its held child close before cleanup", async (t) => {
  const controller = new AbortController();
  const state = await fixture(t, { runtimeWrites: true });
  let closeObserved = false;
  const execute = (file, args, options) => {
    if (args[args.indexOf("-Operation") + 1] === "prepare") return state.options.execute(file, args, options);
    const child = new EventEmitter();
    const pending = Promise.reject(Object.assign(new Error("private abort diagnostic"), { code: "ABORT_ERR" }));
    pending.child = child;
    controller.abort();
    setImmediate(async () => {
      try {
        await access(state.path);
        await access(join(state.runtimeRoot, "prepare-HOME.cache"));
        closeObserved = true;
      }
      finally { child.emit("close", null, "SIGKILL"); }
    });
    return pending;
  };
  await assert.rejects(state.run({ execute, signal: controller.signal }), error("ABORTED"));
  assert.equal(closeObserved, true);
  await state.assertClean();
});

test("unproven helper exit retains its owned directory and preserves the primary failure", async (t) => {
  const state = await fixture(t, { runtimeWrites: true });
  const execute = (file, args, options) => {
    if (args[args.indexOf("-Operation") + 1] === "prepare") return state.options.execute(file, args, options);
    const pending = Promise.reject(new Error("private failure"));
    pending.child = new EventEmitter();
    return pending;
  };
  await assert.rejects(state.run({ execute }), { ...error("HELPER_VERIFY_EXIT"), cleanupErrorCode: prefix + "PROCESS_CLEANUP" });
  assert.deepEqual(await readFile(state.path), bytes);
  assert.deepEqual((await readdir(state.ownedRoot)).sort(), ["payload", "runtime"]);
  assert.equal(await readFile(join(state.runtimeRoot, "prepare-HOME.cache"), "utf8"), "runtime");
});

test("cleanup failure does not replace the signature error or return successful evidence",
  { skip: process.platform === "win32" || process.getuid?.() === 0 }, async (t) => {
    const state = await fixture(t, { onVerify: async ({ root }) => { await chmod(root, 0o500); throw new Error("private signature failure"); } });
    await assert.rejects(state.run(), { ...error("HELPER_VERIFY_EXIT"), cleanupErrorCode: prefix + "CLEANUP" });
  });

test("static PowerShell helper is Windows-only and invokes only the system signature cmdlet", async () => {
  const source = await helper();
  assert.match(source, /if \(-not \$IsWindows\)/);
  assert.match(source, /Microsoft\.PowerShell\.Security\\Get-AuthenticodeSignature -LiteralPath \$path -ErrorAction Stop/);
  assert.match(source, /\$signatures.Count -ne 1/);
  assert.match(source, /SetAccessRuleProtection\(\$true, \$false\)/);
  assert.match(source, /\$rules.Count -ne 2/);
  assert.match(source, /\$actual.AreAccessRulesProtected/);
  assert.match(source, /\$matching\[0\].IsInherited/);
  for (const stage of rootStages) assert.ok(source.includes(`$stage = '${stage}'`));
  assert.match(source, /GetSingleElementType\(\).Value/);
  assert.match(source, /GetSingleElementValue\(\)/);
  assert.doesNotMatch(source, /Start-Process|Invoke-Expression|Import-Certificate|Set-ExecutionPolicy|\/VERYSILENT|Format-List/);
});

test("PowerShell public diagnostics whitelist fixed codes without paths, accounts, certificates or raw errors", async (t) => {
  const available = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"],
    { encoding: "utf8", timeout: 10000 });
  if (available.error?.code === "ENOENT") return t.skip("PowerShell is not installed");
  assert.equal(available.status, 0);
  const source = await helper();
  const catchBody = source.match(/\} catch \{\n(    \$code = \$_\.Exception\.Message[\s\S]*?)\n    exit 1\n\}\s*$/)?.[1];
  assert.ok(catchBody);
  const cases = ["prepare", "verify"].flatMap((operation) => [
    ...rootStages.map((stage) => ({ operation, code: prefix + "ROOT_" + stage, expected: prefix + "ROOT_" + stage })),
    ...["C:\\Users\\private-account\\private-path", "CN=private-certificate", "raw-stderr-canary",
      prefix + "ROOT_OWNER\nprivate-account", prefix + "ROOT_UNKNOWN"].map((code) => ({ operation, code,
      expected: prefix + (operation === "prepare" ? "HELPER" : "SIGNATURE") })),
  ]);
  const script = `
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
foreach ($case in ('${JSON.stringify(cases)}' | ConvertFrom-Json -AsHashtable)) {
    $Operation = $case.operation
    try { throw $case.code } catch {
${catchBody}
    }
}
`;
  const result = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", timeout: 10000, maxBuffer: 65536 });
  assert.equal(result.status, 0, "PowerShell fixed diagnostic fixtures failed");
  assert.equal(result.stderr, "");
  assert.equal(/private-account|private-path|private-certificate|raw-stderr-canary/.test(result.stdout), false);
  assert.deepEqual(result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line)),
    cases.map(({ expected }) => ({ status: "FAIL", errorCode: expected })));
});

test("structured publisher validation rejects invalid trust, type, missing, duplicate and multivalued identities", async (t) => {
  const available = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"],
    { encoding: "utf8", timeout: 10000 });
  if (available.error?.code === "ENOENT") return t.skip("PowerShell is not installed");
  assert.equal(available.status, 0);
  const source = (await helper()).match(/function Assert-CursorPublisher\([\s\S]*?(?=\nfunction Assert-PrivateDirectory)/)?.[0];
  assert.ok(source);
  const cn = { oid: "2.5.4.3", value: "Anysphere, Inc." }, org = { oid: "2.5.4.10", value: "Anysphere, Inc." };
  const rdns = [[cn], [org], [{ oid: "2.5.4.6", value: "US" }]];
  const cases = [
    { name: "valid", rdns, expected: "PASS" },
    ...["NotSigned", "HashMismatch", "NotTrusted", "UnknownError"].map((status) => ({ name: status, rdns, status, expected: "SIGNATURE" })),
    { name: "catalog", rdns, type: "Catalog", expected: "SIGNATURE" },
    { name: "noSigner", rdns, noSigner: true, expected: "SIGNATURE" },
    { name: "wrongCN", rdns: [[{ ...cn, value: "private-canary" }], [org]], expected: "PUBLISHER" },
    { name: "wrongO", rdns: [[cn], [{ ...org, value: "private-canary" }]], expected: "PUBLISHER" },
    { name: "caseChanged", rdns: [[{ ...cn, value: "anysphere, Inc." }], [org]], expected: "PUBLISHER" },
    { name: "missingCN", rdns: [[org]], expected: "PUBLISHER" },
    { name: "missingO", rdns: [[cn]], expected: "PUBLISHER" },
    { name: "duplicateCN", rdns: [[cn], [org], [cn]], expected: "PUBLISHER" },
    { name: "duplicateO", rdns: [[cn], [org], [org]], expected: "PUBLISHER" },
    { name: "multivalued", rdns: [[cn, org]], expected: "PUBLISHER" },
    { name: "manyRDNs", rdns: [...rdns, ...Array.from({ length: 30 }, () => [{ oid: "2.5.4.11", value: "synthetic" }])], expected: "PUBLISHER" },
    { name: "noSubject", rdns, noSubject: true, expected: "PUBLISHER" },
  ];
  const script = `
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
${source}
$results = foreach ($case in ('${JSON.stringify(cases)}' | ConvertFrom-Json -AsHashtable)) {
    $writer = [System.Formats.Asn1.AsnWriter]::new([System.Formats.Asn1.AsnEncodingRules]::DER)
    $null = $writer.PushSequence()
    foreach ($rdn in $case.rdns) {
        $null = $writer.PushSetOf()
        foreach ($attribute in $rdn) {
            $null = $writer.PushSequence()
            $writer.WriteObjectIdentifier($attribute.oid)
            $writer.WriteCharacterString([System.Formats.Asn1.UniversalTagNumber]::UTF8String, $attribute.value)
            $writer.PopSequence()
        }
        $writer.PopSetOf()
    }
    $writer.PopSequence()
    $subject = [Security.Cryptography.X509Certificates.X500DistinguishedName]::new($writer.Encode())
    $signature = [pscustomobject]@{ Status = 'Valid'; SignatureType = 'Authenticode'
        SignerCertificate = [pscustomobject]@{ SubjectName = $subject } }
    if ($case.ContainsKey('status')) { $signature.Status = $case.status }
    if ($case.ContainsKey('type')) { $signature.SignatureType = $case.type }
    if ($case.ContainsKey('noSigner')) { $signature.SignerCertificate = $null }
    if ($case.ContainsKey('noSubject')) { $signature.SignerCertificate.SubjectName = $null }
    $outcome = 'PASS'
    try { Assert-CursorPublisher $signature } catch { $outcome = $_.Exception.Message }
    [ordered]@{ name = $case.name; outcome = $outcome }
}
ConvertTo-Json -InputObject @($results) -Compress
`;
  const result = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", timeout: 25000, maxBuffer: 65536 });
  assert.equal(result.status, 0, "PowerShell publisher fixtures failed");
  assert.equal(result.stderr, "");
  assert.equal(result.stdout.includes("private-canary"), false);
  assert.deepEqual(JSON.parse(result.stdout), cases.map(({ name, expected }) => ({ name,
    outcome: expected === "PASS" ? expected : prefix + expected })));
});
