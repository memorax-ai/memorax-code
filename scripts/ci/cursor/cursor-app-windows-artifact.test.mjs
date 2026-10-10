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

test("selects each frozen Windows UserSetup release without fallback or invented hashes", () => {
  for (const channel of ["baseline", "latest"]) {
    assert.deepEqual(selectCursorWindowsRelease(manifest, channel), manifest[channel]["win32-x64-user"]);
  }
  for (const input of [null, {}, { ...manifest, schemaVersion: 2 }, { ...manifest, latest: {} }]) {
    assert.throws(() => selectCursorWindowsRelease(input, "latest"), error("RELEASE"));
  }
  assert.throws(() => selectCursorWindowsRelease(manifest, "unknown"), error("RELEASE"));
});

test("both releases verify private bytes, isolate PowerShell startup files and require callback cleanup", async (t) => {
  for (const release of [baseline, latest]) {
    const state = await fixture(t, { release, runtimeWrites: true });
    const result = await withVerifiedCursorWindowsInstaller(state.options, async (context) => {
      assert.deepEqual(state.calls.map(({ operation }) => operation), ["prepare", "verify"]);
      assert.equal(context.installerPath, state.path);
      assert.deepEqual(await readdir(state.payloadRoot), ["CursorUserSetup.exe"]);
      assert.deepEqual(await readFile(context.installerPath), bytes);
      assert.ok(Object.isFrozen(context.release) && Object.isFrozen(context.artifact));
      context.confirmProcessesClosed();
      return "callback-result";
    });
    assert.equal(result.result, "callback-result");
    assert.deepEqual(result.verification, { platform: "win32-x64-user", channel: release.channel, version: release.version,
      commitSha: release.commitSha, sha256: null, hashSource: "not-provided", bytes: bytes.length,
      observedSha256: createHash("sha256").update(bytes).digest("hex"), authenticodeVerified: true,
      publisherVerified: true, signatureType: "Authenticode", publisher: "Anysphere, Inc.", ownedFilesRemoved: true });
    assert.ok(Object.isFrozen(result.verification));
    assert.equal(JSON.stringify(result.verification).includes(state.root), false);
    assert.equal(state.fetches[0].url, release.url);
    for (const { file, args, options, operation } of state.calls) {
      assert.equal(file, "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
      assert.deepEqual(args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-File"]);
      assert.ok(args[4].endsWith("cursor-app-windows-authenticode.ps1"));
      assert.deepEqual(args.slice(5), ["-Operation", operation, "-Directory", state.payloadRoot]);
      assert.equal(options.timeout, 120_000);
      assert.equal(options.maxBuffer, 4096);
      assert.equal(options.killSignal, "SIGKILL");
      assert.deepEqual(Object.keys(options.env).sort(), ["APPDATA", "COMSPEC", "HOME", "LOCALAPPDATA", "PATH",
        "PSModulePath", "ProgramFiles", "SystemRoot", "TEMP", "TMP", "USERPROFILE", "WINDIR"].sort());
      assert.equal(options.env.PATH, "C:\\Program Files\\PowerShell\\7;C:\\Windows\\System32");
      for (const key of ["HOME", "USERPROFILE", "TEMP", "TMP"]) assert.equal(options.env[key], state.runtimeRoot);
      assert.notEqual(state.runtimeRoot, state.payloadRoot);
    }
    await state.assertClean();
  }
});

test("callback return or failure only releases bytes after explicit process-close confirmation", async (t) => {
  for (const confirmed of [false, true]) {
    for (const throws of [false, true]) {
      const state = await fixture(t), primary = new Error("private callback failure");
      const pending = withVerifiedCursorWindowsInstaller(state.options, async ({ confirmProcessesClosed }) => {
        if (confirmed) confirmProcessesClosed();
        if (throws) throw primary;
      });
      if (confirmed && !throws) await pending;
      else await assert.rejects(pending, (caught) => {
        if (throws) assert.equal(caught, primary);
        else assert.equal(caught.code, prefix + "PROCESS_CLEANUP");
        assert.equal(caught.cleanupErrorCode, confirmed ? undefined : prefix + "PROCESS_CLEANUP");
        return true;
      });
      if (confirmed) await state.assertClean();
      else assert.deepEqual(await readFile(state.path), bytes);
    }
  }
});

test("callbacks cannot run before verification or conceal changed bytes and cancellation", async (t) => {
  const invalid = await fixture(t, { fail: "verify" });
  await assert.rejects(withVerifiedCursorWindowsInstaller(invalid.options, () => assert.fail("verification must precede callback")),
    error("HELPER_VERIFY_EXIT"));
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

test("invalid authority fails before download, and failed downloads cannot reach signature verification", async (t) => {
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
  const failed = await fixture(t, { response: { redirected: true } });
  await assert.rejects(failed.run(), error("DOWNLOAD"));
  assert.deepEqual(failed.calls.map(({ operation }) => operation), ["prepare"]);
  await failed.assertClean();
});

async function rejectsClean(t, configuration, suffix) {
  const state = await fixture(t, configuration);
  await assert.rejects(state.run(), error(suffix));
  await state.assertClean();
}

test("helper receipts and failures retain only exact fixed schemas and operation-bound codes", async (t) => {
  for (const operation of ["prepare", "verify"]) {
    for (const output of [{ stdout: "private invalid JSON", stderr: "" }, { stdout: "[]", stderr: "" },
      { stdout: "{}\n{}", stderr: "" }, { stdout: "{}", stderr: "private diagnostic" }, { stdout: "x".repeat(4097), stderr: "" },
      { stdout: JSON.stringify({ status: "PASS", operation, authenticodeVerified: false, publisherVerified: true }), stderr: "" },
      { stdout: JSON.stringify({ status: "PASS", operation, authenticodeVerified: true, publisherVerified: true, path: "private" }), stderr: "" }]) {
      await rejectsClean(t, { outputs: { [operation]: output } }, "HELPER_" + operation.toUpperCase() + "_OUTPUT");
    }
    for (const stage of rootStages) {
      await rejectsClean(t, { commandError: { operation, error: { code: 1, stderr: "",
        stdout: JSON.stringify({ status: "FAIL", errorCode: prefix + "ROOT_" + stage }) } } },
      "ROOT_" + operation.toUpperCase() + "_" + stage);
    }
    for (const [caught, suffix] of [
      [new Error("private"), "EXIT"], [{ code: "ENOENT", syscall: "spawn private" }, "SPAWN"],
      [{ code: "ETIMEDOUT" }, "TIMEOUT"], [{ killed: true, signal: "SIGKILL" }, "TIMEOUT"],
      [{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true, signal: "SIGKILL" }, "OUTPUT"],
      ...[{ errorCode: "private" }, { errorCode: prefix + "ROOT_UNKNOWN" }, { errorCode: prefix + "ROOT_OWNER", path: "private" }]
        .map((change) => [{ code: 1, stdout: JSON.stringify({ status: "FAIL", ...change }), stderr: "" }, "EXIT"]),
      [{ code: 1, stdout: JSON.stringify({ status: "FAIL", errorCode: prefix + "ROOT_OWNER" }), stderr: "private" }, "EXIT"],
    ]) await rejectsClean(t, { commandError: { operation, error: caught } }, "HELPER_" + operation.toUpperCase() + "_" + suffix);
  }
  for (const suffix of ["PLATFORM", "SIGNATURE", "PUBLISHER"]) {
    await rejectsClean(t, { commandError: { operation: "verify", error: { code: 1, stderr: "",
      stdout: JSON.stringify({ status: "FAIL", errorCode: prefix + suffix }) } } }, suffix);
  }
});

test("signature verification rejects changed bytes and replacement files", async (t) => {
  const mutations = [({ path }) => writeFile(path, Buffer.alloc(bytes.length, 1)), ({ path }) => writeFile(path, "changed length"),
    async ({ path }) => { await rm(path); await mkdir(path); }];
  if (process.platform !== "win32") mutations.push(async ({ path, root }) => { await rm(path); await symlink(join(root, "unrelated"), path); });
  for (const onVerify of mutations) await rejectsClean(t, { onVerify }, "CHANGED");
});

test("helper cancellation waits for its held child and retains state when closure is unproven", async (t) => {
  for (const closes of [false, true]) {
    const controller = new AbortController();
    const state = await fixture(t, { runtimeWrites: true });
    let observed = false;
    const execute = (...args) => {
      if (args[1].includes("prepare")) return state.options.execute(...args);
      const pending = Promise.reject(new Error("private"));
      pending.child = new EventEmitter();
      controller.abort();
      if (closes) setImmediate(async () => {
        await access(state.path);
        await access(join(state.runtimeRoot, "prepare-HOME.cache"));
        observed = true;
        pending.child.emit("close");
      });
      return pending;
    };
    await assert.rejects(state.run({ execute, signal: controller.signal }), { ...error("ABORTED"),
      ...(!closes ? { cleanupErrorCode: prefix + "PROCESS_CLEANUP" } : {}) });
    assert.equal(observed, closes);
    if (closes) await state.assertClean();
    else assert.deepEqual(await readFile(state.path), bytes);
  }
});

test("cleanup errors preserve the primary verification failure",
  { skip: process.platform === "win32" || process.getuid?.() === 0 }, async (t) => {
    const state = await fixture(t, { onVerify: async ({ root }) => { await chmod(root, 0o500); throw new Error("private"); } });
    await assert.rejects(state.run(), { ...error("HELPER_VERIFY_EXIT"), cleanupErrorCode: prefix + "CLEANUP" });
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
