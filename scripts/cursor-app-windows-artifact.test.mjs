import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { baselineRelease, resolveDownload } from "./cursor-app-release.mjs";
import { selectCursorWindowsRelease, verifyCursorWindowsInstaller } from "./cursor-app-windows-artifact.mjs";

const baseline = baselineRelease("win32-x64-user");
const latest = resolveDownload("win32-x64-user", { version: "3.23.12", commitSha: "1".repeat(40),
  downloadUrl: `https://downloads.cursor.com/production/${"1".repeat(40)}/win32/x64/user-setup/CursorUserSetup-x64-3.23.12.exe` });
const manifest = { schemaVersion: 1, baseline: { "win32-x64-user": baseline }, latest: { "win32-x64-user": latest } };
const bytes = Buffer.from("Synthetic unsigned bytes. Never execute this fixture.");
const prefix = "CURSOR_APP_WINDOWS_ARTIFACT_";
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
    state.ownedRoot = args[args.indexOf("-Directory") + 1];
    state.path = join(state.ownedRoot, "CursorUserSetup.exe");
    state.calls.push({ file, args, options, operation });
    assert.ok(["prepare", "verify"].includes(operation));
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
  state.run = (overrides = {}) => verifyCursorWindowsInstaller({ ...state.options, ...overrides });
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

test("verifies synthetic downloaded bytes statically and removes only its owned directory before returning", async (t) => {
  const state = await fixture(t, { onVerify: async ({ path }) => assert.deepEqual(await readFile(path), bytes) });
  const result = await state.run();
  assert.deepEqual(result, { platform: "win32-x64-user", channel: "baseline", version: baseline.version,
    commitSha: baseline.commitSha, sha256: null, hashSource: "not-provided", bytes: bytes.length,
    observedSha256: createHash("sha256").update(bytes).digest("hex"), authenticodeVerified: true,
    publisherVerified: true, signatureType: "Authenticode", publisher: "Anysphere, Inc.", installerExecuted: false,
    appIdentityVerified: false, appArchitectureVerified: false, ownedFilesRemoved: true });
  assert.ok(Object.isFrozen(result));
  assert.equal(JSON.stringify(result).includes(state.root), false);
  assert.deepEqual(state.calls.map((call) => call.operation), ["prepare", "verify"]);
  for (const call of state.calls) {
    assert.equal(call.file, "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
    assert.deepEqual(call.args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-File"]);
    assert.ok(call.args[4].endsWith("cursor-app-windows-authenticode.ps1"));
    assert.deepEqual(call.args.slice(5), ["-Operation", call.operation, "-Directory", state.ownedRoot]);
    assert.equal(call.options.cwd, state.ownedRoot);
    assert.equal(call.options.timeout, 120_000);
    assert.equal(call.options.maxBuffer, 4096);
    assert.equal(call.options.encoding, "utf8");
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.killSignal, "SIGKILL");
    assert.deepEqual(Object.keys(call.options.env).sort(), ["APPDATA", "COMSPEC", "HOME", "LOCALAPPDATA", "PATH",
      "PSModulePath", "ProgramFiles", "SystemRoot", "TEMP", "TMP", "USERPROFILE", "WINDIR"].sort());
    assert.equal(call.options.env.PSModulePath, "C:\\Program Files\\PowerShell\\7\\Modules");
    assert.equal(call.options.env.PATH, "C:\\Program Files\\PowerShell\\7;C:\\Windows\\System32");
    for (const key of ["HOME", "USERPROFILE", "TEMP", "TMP"]) assert.equal(call.options.env[key], state.ownedRoot);
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
    [{ root: join(state.root, "unrelated") }, "ROOT"], [{ release: { ...baseline, sha256: "a".repeat(64) } }, "RELEASE"],
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
      await assert.rejects(state.run(), error(operation === "prepare" ? "ROOT" : "SIGNATURE"));
      await state.assertClean();
    }
  }
  for (const [caught, suffix] of [
    [new Error("private stderr and path"), "SIGNATURE"],
    [{ code: 1, stdout: JSON.stringify({ status: "FAIL", errorCode: prefix + "PUBLISHER" }), stderr: "" }, "PUBLISHER"],
    [{ code: 1, stdout: JSON.stringify({ status: "FAIL", errorCode: "private-code" }), stderr: "" }, "SIGNATURE"],
    [{ code: "ETIMEDOUT" }, "SIGNATURE_TIMEOUT"],
    [{ code: null, killed: true, signal: "SIGKILL" }, "SIGNATURE_TIMEOUT"],
    [{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true, signal: "SIGKILL" }, "SIGNATURE"],
  ]) {
    const state = await fixture(t, { commandError: { operation: "verify", error: caught } });
    await assert.rejects(state.run(), error(suffix));
    await state.assertClean();
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
  const state = await fixture(t);
  let closeObserved = false;
  const execute = (file, args, options) => {
    if (args[args.indexOf("-Operation") + 1] === "prepare") return state.options.execute(file, args, options);
    const child = new EventEmitter();
    const pending = Promise.reject(Object.assign(new Error("private abort diagnostic"), { code: "ABORT_ERR" }));
    pending.child = child;
    controller.abort();
    setImmediate(async () => {
      try { await access(state.path); closeObserved = true; }
      finally { child.emit("close", null, "SIGKILL"); }
    });
    return pending;
  };
  await assert.rejects(state.run({ execute, signal: controller.signal }), error("ABORTED"));
  assert.equal(closeObserved, true);
  await state.assertClean();
});

test("unproven helper exit retains its owned directory and preserves the primary failure", async (t) => {
  const state = await fixture(t);
  const execute = (file, args, options) => {
    if (args[args.indexOf("-Operation") + 1] === "prepare") return state.options.execute(file, args, options);
    const pending = Promise.reject(new Error("private failure"));
    pending.child = new EventEmitter();
    return pending;
  };
  await assert.rejects(state.run({ execute }), { ...error("SIGNATURE"), cleanupErrorCode: prefix + "PROCESS_CLEANUP" });
  assert.deepEqual(await readFile(state.path), bytes);
});

test("cleanup failure does not replace the signature error or return successful evidence",
  { skip: process.platform === "win32" || process.getuid?.() === 0 }, async (t) => {
    const state = await fixture(t, { onVerify: async ({ root }) => { await chmod(root, 0o500); throw new Error("private signature failure"); } });
    await assert.rejects(state.run(), { ...error("SIGNATURE"), cleanupErrorCode: prefix + "CLEANUP" });
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
  assert.match(source, /GetSingleElementType\(\).Value/);
  assert.match(source, /GetSingleElementValue\(\)/);
  assert.doesNotMatch(source, /Start-Process|Invoke-Expression|Import-Certificate|Set-ExecutionPolicy|\/VERYSILENT|Format-List/);
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
