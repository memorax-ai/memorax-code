import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { baselineRelease, resolveDownload } from "./cursor-app-release.mjs";
import { projectCursorMacosDetachDiagnostics, selectCursorMacosRelease, withCursorMacosApp } from "./cursor-app-macos-artifact.mjs";

const baseline = baselineRelease("darwin-arm64");
const latest = resolveDownload("darwin-arm64", { version: "3.23.12", commitSha: "1".repeat(40),
  downloadUrl: `https://downloads.cursor.com/production/${"1".repeat(40)}/darwin/arm64/Cursor-darwin-arm64.dmg` });
const manifest = { schemaVersion: 1, baseline: { "darwin-arm64": baseline }, latest: { "darwin-arm64": latest } };
const image = Buffer.from("synthetic image bytes, never mounted by a real process");
const prefix = "CURSOR_APP_MACOS_ARTIFACT_";
const posixTest = process.platform === "win32" ? test.skip : test;
function error(suffix) { return { code: prefix + suffix, message: prefix + suffix }; }

test("detach projection retains only bounded outcomes and fixed enums", () => {
  const input = { exitCode: 1, signal: "SIGKILL", timedOut: true, outputOverflow: false, stderrClass: "resource-busy" };
  assert.deepEqual(projectCursorMacosDetachDiagnostics({ ...input, stderr: "private", path: "/private", token: "private" }), input);
  const invalid = projectCursorMacosDetachDiagnostics({ exitCode: "private", signal: "private", timedOut: "true",
    outputOverflow: 1, stderrClass: "private", stderr: "private" });
  assert.deepEqual(invalid, { exitCode: null, signal: "other", timedOut: false, outputOverflow: false, stderrClass: "other" });
  assert.equal(JSON.stringify(invalid).includes("private"), false);
  for (const exitCode of [-1, 256, 1.5, "1", NaN, Infinity]) {
    assert.equal(projectCursorMacosDetachDiagnostics({ exitCode }).exitCode, null);
  }
  for (const exitCode of [0, 1, 255]) assert.equal(projectCursorMacosDetachDiagnostics({ exitCode }).exitCode, exitCode);
});

function executable() {
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(0x0100000c, 4);
  header.writeUInt32LE(2, 12);
  return header;
}

async function fixture(t, configuration = {}) {
  const root = await mkdtemp(join(tmpdir(), "cursor-macos-artifact-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "unrelated"), "preserve");
  const release = configuration.release ?? baseline;
  const state = { root, calls: [], fetches: [], callbackCount: 0 };
  const info = { CFBundleIdentifier: "com.todesktop.230313mzl4w4u92", CFBundleExecutable: "Cursor",
    CFBundleShortVersionString: release.version, ...configuration.info };
  const packageJson = { version: release.version, ...configuration.packageJson };
  const productJson = { version: release.version, commit: release.commitSha.slice(0, -1) + "0", realCommit: release.commitSha,
    darwinBundleIdentifier: "com.todesktop.230313mzl4w4u92", ...configuration.productJson };
  const execute = async (file, args, options) => {
    const operation = file.endsWith("/hdiutil") ? args[0] : file.endsWith("/plutil")
      ? args.at(-1).endsWith("mount.plist") ? "mount-json" : "info-json"
      : file.endsWith("/codesign") && args.includes("--test-requirement") ? "identity" : file.split("/").at(-1);
    state.calls.push({ operation, file, args, options });
    if (operation === configuration.fail) throw new Error("private command stderr and path must not escape");
    if (operation === configuration.commandError?.operation) throw configuration.commandError.error;
    if (operation === "attach") {
      state.mountpoint = args[args.indexOf("-mountpoint") + 1];
      state.ownedRoot = dirname(state.mountpoint);
      state.appPath = join(state.mountpoint, "Cursor.app");
      for (const directory of ["Contents/Resources/app", "Contents/MacOS"]) {
        await mkdir(join(state.appPath, directory), { recursive: true });
      }
      await writeFile(join(state.appPath, "Contents/Info.plist"), "synthetic plist");
      await writeFile(join(state.appPath, "Contents/Resources/app/package.json"), JSON.stringify(packageJson));
      await writeFile(join(state.appPath, "Contents/Resources/app/product.json"), JSON.stringify(productJson));
      await writeFile(join(state.appPath, "Contents/MacOS/Cursor"), configuration.executable ?? executable(), { mode: 0o755 });
      await configuration.mutateApp?.(state);
      return { stdout: "<plist>synthetic mount metadata</plist>" };
    }
    if (operation === "mount-json") return { stdout: configuration.mountJson ?? JSON.stringify({
      "system-entities": [{ "dev-entry": "/dev/disk999" }, { "dev-entry": "/dev/disk999s1", "mount-point": state.mountpoint }],
    }) };
    if (operation === "info-json") return { stdout: configuration.infoJson ?? JSON.stringify(info) };
    assert.ok(["codesign", "identity", "spctl", "detach"].includes(operation), "only fixed validation commands are permitted");
    return { stdout: "", code: operation === configuration.failCode ? 1 : 0 };
  };
  const fetchImpl = async (url, options) => {
    state.fetches.push({ url, options });
    if (configuration.fetchFailure) throw new Error("private network diagnostic must not escape");
    return { status: 200, redirected: false, url: release.url, headers: new Headers({ "content-length": String(image.length) }),
      body: (async function* () { yield image.subarray(0, 5); yield image.subarray(5); })(), ...configuration.response };
  };
  state.options = { release, root, platform: "darwin", execute, fetchImpl };
  state.run = (callback = async (value) => { state.callbackCount++; return value.evidence; }, overrides = {}) =>
    withCursorMacosApp({ ...state.options, ...overrides }, callback);
  state.assertClean = async () => assert.deepEqual(await readdir(root), ["unrelated"]);
  return state;
}

test("selects only frozen canonical darwin-arm64 descriptors and retains unavailable official hashes", () => {
  for (const channel of ["baseline", "latest"]) {
    const result = selectCursorMacosRelease(manifest, channel);
    assert.deepEqual(result, manifest[channel]["darwin-arm64"]);
    assert.equal(result.sha256, null);
    assert.equal(result.hashSource, "not-provided");
    assert.ok(Object.isFrozen(result));
  }
  const sameRelease = { ...manifest, latest: { "darwin-arm64": { ...baseline, channel: "latest" } } };
  assert.equal(selectCursorMacosRelease(sameRelease, "latest").channel, "latest");
  for (const value of [null, {}, { ...manifest, schemaVersion: 2 }, { ...manifest, latest: {} }]) {
    assert.throws(() => selectCursorMacosRelease(value, "latest"), error("RELEASE"));
  }
  for (const channel of [undefined, "unknown", "linux-x64"]) {
    assert.throws(() => selectCursorMacosRelease(manifest, channel), error("RELEASE"));
  }
  for (const change of [{ platform: "darwin-x64" }, { channel: "baseline" }, { version: "3.23.012" },
    { commitSha: "A".repeat(40) }, { url: latest.url + "?private=value" }, { url: latest.url.replace("https:", "http:") },
    { url: latest.url.replace("downloads.cursor.com", "other.invalid") }, { sha256: "a".repeat(64) },
    { hashSource: "observed-sha256" }]) {
    const input = { ...manifest, latest: { "darwin-arm64": { ...latest, ...change } } };
    assert.throws(() => selectCursorMacosRelease(input, "latest"), error("RELEASE"));
  }
  const changedBaseline = { ...manifest, baseline: { "darwin-arm64": { ...latest, channel: "baseline" } } };
  assert.throws(() => selectCursorMacosRelease(changedBaseline, "baseline"), error("RELEASE"));
});

posixTest("acquires into an owned child, validates before callback, and detaches before removing it", async (t) => {
  const state = await fixture(t);
  const result = await state.run(async ({ appPath, evidence }) => {
    assert.equal(appPath, join(state.appPath, "Contents/MacOS/Cursor"));
    assert.equal((await readFile(join(state.ownedRoot, "Cursor.dmg"))).equals(image), true);
    assert.deepEqual(state.calls.map((call) => call.operation), ["attach", "mount-json", "codesign", "identity", "spctl", "info-json"]);
    assert.deepEqual(evidence, { platform: "darwin-arm64", channel: "baseline", version: baseline.version,
      commitSha: baseline.commitSha, sha256: null, hashSource: "not-provided", bytes: image.length,
      observedSha256: createHash("sha256").update(image).digest("hex"), architecture: "arm64", readOnlyMount: true,
      signatureVerified: true, bundleIdentifier: "com.todesktop.230313mzl4w4u92", teamIdentifier: "VDXQ22DGB9",
      gatekeeperAccepted: true, packageIdentityVerified: true });
    assert.ok(Object.isFrozen(evidence));
    assert.ok(!JSON.stringify(evidence).includes(state.root));
    return "callback-result";
  });
  assert.equal(result, "callback-result");
  assert.equal(state.calls.at(-1).operation, "detach");
  const attach = state.calls[0];
  assert.deepEqual(attach.args, ["attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", state.mountpoint,
    "-plist", join(state.ownedRoot, "Cursor.dmg")]);
  const signature = state.calls.find((call) => call.operation === "codesign");
  assert.equal(signature.file, "/usr/bin/codesign");
  assert.deepEqual(signature.args, ["--verify", "--deep", "--strict", "--all-architectures", state.appPath]);
  const identity = state.calls.find((call) => call.operation === "identity");
  assert.equal(identity.file, "/usr/bin/codesign");
  assert.deepEqual(identity.args, ["--verify", "--strict", "--all-architectures", "--test-requirement",
    '=identifier "com.todesktop.230313mzl4w4u92" and anchor apple generic and certificate leaf[subject.OU] = "VDXQ22DGB9"', state.appPath]);
  const assessment = state.calls.find((call) => call.operation === "spctl");
  assert.equal(assessment.file, "/usr/sbin/spctl");
  assert.deepEqual(assessment.args, ["--assess", "--type", "execute", state.appPath]);
  for (const call of state.calls) {
    assert.equal(call.options.cwd, state.ownedRoot);
    assert.deepEqual(call.options.env, { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: state.ownedRoot,
      CFFIXED_USER_HOME: state.ownedRoot, TMPDIR: state.ownedRoot, TMP: state.ownedRoot, TEMP: state.ownedRoot, LANG: "C", LC_ALL: "C" });
    assert.equal(call.options.killSignal, "SIGKILL");
    assert.equal(call.options.encoding, "utf8");
    assert.equal(call.options.maxBuffer, 1024 * 1024);
    assert.equal(call.options.timeout, call.operation === "detach" ? 30_000 : 120_000);
  }
  const request = state.fetches[0];
  assert.equal(request.url, baseline.url);
  assert.equal(request.options.redirect, "error");
  assert.equal(request.options.credentials, "omit");
  assert.equal(request.options.cache, "no-store");
  assert.deepEqual(request.options.headers, { "User-Agent": "memorax-cursor-app-ci" });
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.deepEqual(state.calls.at(-1).args, ["detach", state.mountpoint]);
  await state.assertClean();
});

posixTest("latest validates the selected exact release, without falling back to baseline", async (t) => {
  const state = await fixture(t, { release: latest });
  const evidence = await state.run();
  assert.equal(evidence.channel, "latest");
  assert.equal(evidence.version, latest.version);
  assert.equal(evidence.commitSha, latest.commitSha);
  assert.equal(state.fetches[0].url, latest.url);
  await state.assertClean();
});

posixTest("release identity requires exact realCommit and never falls back to commit", async (t) => {
  const state = await fixture(t);
  assert.notEqual(baseline.commitSha.slice(0, -1) + "0", baseline.commitSha);
  assert.equal((await state.run()).commitSha, baseline.commitSha);
  await state.assertClean();
  for (const realCommit of [undefined, null, "", baseline.commitSha.slice(0, -1) + "0"]) {
    const invalid = await fixture(t, { productJson: { commit: baseline.commitSha, realCommit } });
    await assert.rejects(invalid.run(), error("PACKAGE"));
    assert.equal(invalid.callbackCount, 0);
    assert.equal(invalid.calls.at(-1).operation, "detach");
    await invalid.assertClean();
  }
});

posixTest("rejects unsupported platforms, invalid roots and release tampering before acquiring", async (t) => {
  const state = await fixture(t);
  for (const platform of ["linux", "win32", "private-invalid-platform"]) {
    await assert.rejects(state.run(undefined, { platform }), error("PLATFORM"));
  }
  for (const root of [undefined, "relative/path", state.root + "\nprivate", state.root + "\0private"]) {
    await assert.rejects(state.run(undefined, { root }), error("ARGUMENTS"));
  }
  for (const root of [join(state.root, "absent"), join(state.root, "unrelated")]) {
    await assert.rejects(state.run(undefined, { root }), error("ROOT"));
  }
  const link = join(state.root, "link");
  await symlink(state.root, link);
  await assert.rejects(state.run(undefined, { root: link }), error("ROOT"));
  await rm(link);
  await assert.rejects(state.run(undefined, { release: { ...baseline, sha256: "a".repeat(64) } }), error("RELEASE"));
  assert.equal(state.fetches.length, 0);
  assert.equal(state.calls.length, 0);
  await state.assertClean();
});

posixTest("download rejects HTTP errors, redirects, substituted URLs and raw network diagnostics", async (t) => {
  for (const response of [{ status: 302 }, { status: 206 }, { status: 500 }, { redirected: true },
    { url: latest.url }, { body: null }]) {
    const state = await fixture(t, { response });
    await assert.rejects(state.run(), error("DOWNLOAD"));
    assert.equal(state.calls.length, 0);
    assert.equal(state.callbackCount, 0);
    assert.equal(state.fetches[0].options.signal.aborted, true);
    await state.assertClean();
  }
  const state = await fixture(t, { fetchFailure: true });
  await assert.rejects(state.run(), error("DOWNLOAD"));
  await state.assertClean();
});

posixTest("download bounds declared and streamed bytes and rejects empty or truncated bodies", async (t) => {
  for (const value of ["600000001", "0", "-1", "1.5", "private", String(image.length + 1)]) {
    const state = await fixture(t, { response: { headers: new Headers({ "content-length": value }) } });
    await assert.rejects(state.run(), error("DOWNLOAD_SIZE"));
    assert.equal(state.calls.length, 0);
    await state.assertClean();
  }
  const oversized = new Uint8Array(1);
  Object.defineProperty(oversized, "byteLength", { value: 600_000_001 });
  for (const chunks of [[], [oversized]]) {
    const state = await fixture(t, { response: { headers: new Headers(), body: (async function* () { yield* chunks; })() } });
    await assert.rejects(state.run(), error("DOWNLOAD_SIZE"));
    await state.assertClean();
  }
  const state = await fixture(t, { response: { headers: new Headers() } });
  assert.equal((await state.run()).bytes, image.length);
  await state.assertClean();
});

posixTest("failed and aborted streams cannot reach mount or callback", async (t) => {
  const interrupted = await fixture(t, { response: { body: (async function* () { yield image.subarray(0, 5); throw new Error("private"); })() } });
  await assert.rejects(interrupted.run(), error("DOWNLOAD"));
  assert.equal(interrupted.calls.length, 0);
  await interrupted.assertClean();
  const controller = new AbortController();
  const aborted = await fixture(t, { response: { body: (async function* () { controller.abort(); yield image; })() } });
  await assert.rejects(aborted.run(undefined, { signal: controller.signal }), error("ABORTED"));
  assert.equal(aborted.fetches[0].options.signal.aborted, true);
  assert.equal(aborted.calls.length, 0);
  await aborted.assertClean();
  const early = await fixture(t);
  await assert.rejects(early.run(undefined, { signal: controller.signal }), error("ABORTED"));
  assert.equal(early.fetches.length, 0);
  await early.assertClean();
});

posixTest("each failed mount, signature, or assessment gate detaches and fails before callback", async (t) => {
  for (const [operation, suffix] of [["attach", "MOUNT"], ["mount-json", "MOUNT_METADATA"], ["codesign", "SIGNATURE"], ["identity", "IDENTITY"],
    ["spctl", "ASSESSMENT"], ["info-json", "PACKAGE"]]) {
    const state = await fixture(t, { fail: operation });
    await assert.rejects(state.run(), error(suffix));
    assert.equal(state.callbackCount, 0);
    assert.equal(state.calls.at(-1).operation, "detach");
    await state.assertClean();
  }
  for (const [failCode, suffix] of [["codesign", "SIGNATURE"], ["identity", "IDENTITY"], ["spctl", "ASSESSMENT"]]) {
    const state = await fixture(t, { failCode });
    await assert.rejects(state.run(), error(suffix));
    await state.assertClean();
  }
});

posixTest("command timeouts remain distinct from rejection, with abort taking precedence", async (t) => {
  for (const details of [{ killed: true, signal: "SIGKILL", code: null }, { code: "ETIMEDOUT" }]) {
    for (const [operation, suffix] of [["attach", "MOUNT"], ["codesign", "SIGNATURE"], ["identity", "IDENTITY"], ["spctl", "ASSESSMENT"]]) {
      const state = await fixture(t, { commandError: { operation, error: Object.assign(new Error("private timeout details"), details) } });
      await assert.rejects(state.run(), error(suffix + "_TIMEOUT"));
      assert.equal(state.callbackCount, 0);
      assert.equal(state.calls.at(-1).operation, "detach");
      await state.assertClean();
    }
  }
  for (const details of [{ code: 1 }, { killed: false, signal: "SIGKILL" }, { killed: true, signal: "SIGTERM" },
    { killed: true, signal: "SIGKILL", code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" }]) {
    const state = await fixture(t, { commandError: { operation: "codesign", error: Object.assign(new Error("private rejection details"), details) } });
    await assert.rejects(state.run(), error("SIGNATURE"));
    assert.equal(state.callbackCount, 0);
    await state.assertClean();
  }
  const controller = new AbortController();
  const state = await fixture(t);
  const execute = state.options.execute;
  await assert.rejects(state.run(undefined, { signal: controller.signal, execute: async (file, args, options) => {
    if (file === "/usr/bin/codesign") {
      controller.abort();
      throw Object.assign(new Error("private aborted command"), { killed: true, signal: "SIGKILL" });
    }
    return execute(file, args, options);
  } }), error("ABORTED"));
  assert.equal(state.callbackCount, 0);
  assert.equal(state.calls.at(-1).operation, "detach");
  assert.equal(state.calls.at(-1).options.signal, undefined);
  await state.assertClean();
});

posixTest("mount metadata must structurally identify exactly the owned mountpoint", async (t) => {
  for (const mountJson of ["private invalid plist conversion", "[]", "{}", JSON.stringify({ "system-entities": {} }),
    JSON.stringify({ "system-entities": [{ "mount-point": "/Volumes/other" }] })]) {
    const state = await fixture(t, { mountJson });
    await assert.rejects(state.run(), error("MOUNT_METADATA"));
    assert.equal(state.calls.at(-1).operation, "detach");
    assert.equal(state.callbackCount, 0);
    await state.assertClean();
  }
});

posixTest("all static version, commit, bundle and executable fields must agree", async (t) => {
  for (const configuration of [
    { info: { CFBundleIdentifier: "other" } }, { info: { CFBundleExecutable: "../other" } },
    { info: { CFBundleShortVersionString: latest.version } }, { packageJson: { version: latest.version } },
    { productJson: { version: latest.version } }, { productJson: { realCommit: "a".repeat(40) } },
    { productJson: { darwinBundleIdentifier: "other" } }, { infoJson: "not json" },
  ]) {
    const state = await fixture(t, configuration);
    await assert.rejects(state.run(), error("PACKAGE"));
    assert.equal(state.callbackCount, 0);
    assert.equal(state.calls.at(-1).operation, "detach");
    await state.assertClean();
  }
});

posixTest("requires a real executable thin arm64 Mach-O header", async (t) => {
  for (const mutate of [(header) => header.writeUInt32LE(0xcafebabe, 0), (header) => header.writeUInt32LE(0x01000007, 4),
    (header) => header.writeUInt32LE(6, 12)]) {
    const header = executable(); mutate(header);
    const state = await fixture(t, { executable: header });
    await assert.rejects(state.run(), error("ARCHITECTURE"));
    assert.equal(state.callbackCount, 0);
    await state.assertClean();
  }
  for (const header of [Buffer.alloc(0), Buffer.alloc(16)]) {
    const state = await fixture(t, { executable: header });
    await assert.rejects(state.run(), error("ARCHITECTURE"));
    await state.assertClean();
  }
  const nonExecutable = await fixture(t, { mutateApp: async ({ appPath }) => chmod(join(appPath, "Contents/MacOS/Cursor"), 0o644) });
  await assert.rejects(nonExecutable.run(), error("ARCHITECTURE"));
  await nonExecutable.assertClean();
});

posixTest("package files and executable cannot escape the mounted application via symlinks", async (t) => {
  for (const [relative, suffix] of [["Contents/Resources/app/product.json", "PACKAGE"], ["Contents/MacOS/Cursor", "ARCHITECTURE"]]) {
    const state = await fixture(t, { mutateApp: async ({ root, appPath }) => {
      const path = join(appPath, relative);
      await rm(path);
      await symlink(join(root, "unrelated"), path);
    } });
    await assert.rejects(state.run(), error(suffix));
    assert.equal(state.callbackCount, 0);
    await state.assertClean();
  }
});

posixTest("callback failure or abort still detaches independently of the original signal", async (t) => {
  const state = await fixture(t);
  const controller = new AbortController();
  const original = Object.assign(new Error("CURSOR_APP_NATIVE_FAILED"), { code: "CURSOR_APP_NATIVE_FAILED" });
  await assert.rejects(state.run(async () => { controller.abort(); throw original; }, { signal: controller.signal }),
    (caught) => caught === original);
  assert.equal(original.artifactDetach, undefined);
  assert.equal(state.calls.at(-1).operation, "detach");
  assert.equal(state.calls.at(-1).options.signal, undefined);
  await state.assertClean();
});

posixTest("busy detach never force-detaches or removes the mount, and preserves primary failure", async (t) => {
  for (const callbackFails of [false, true]) {
    const state = await fixture(t, { commandError: { operation: "detach", error: Object.assign(new Error("private detach diagnostic"),
      { code: 1, stderr: "hdiutil: detach failed - Resource busy\n", stdout: "private command output" }) } });
    const original = Object.assign(new Error("CURSOR_APP_NATIVE_FAILED"), { code: "CURSOR_APP_NATIVE_FAILED" });
    await assert.rejects(state.run(async () => { if (callbackFails) throw original; return "not returned"; }), (caught) => {
      if (callbackFails) {
        assert.equal(caught, original);
        assert.equal(caught.cleanupErrorCode, prefix + "DETACH");
      } else {
        assert.equal(caught.code, prefix + "DETACH");
        assert.equal(caught.cleanupErrorCode, prefix + "DETACH");
      }
      assert.deepEqual(caught.artifactDetach, { exitCode: 1, signal: "none", timedOut: false, outputOverflow: false,
        stderrClass: "resource-busy" });
      assert.equal(JSON.stringify(caught).includes("private"), false);
      return true;
    });
    await access(state.mountpoint);
    await access(join(state.ownedRoot, "Cursor.dmg"));
    assert.deepEqual(state.calls.at(-1).args, ["detach", state.mountpoint]);
    assert.equal(state.calls.filter((call) => call.operation === "detach").length, 1);
    assert.equal(await readFile(join(state.root, "unrelated"), "utf8"), "preserve");
  }
  const timedOut = await fixture(t, { commandError: { operation: "detach", error: Object.assign(new Error("private timeout"), { code: "ETIMEDOUT" }) } });
  await assert.rejects(timedOut.run(), { ...error("DETACH_TIMEOUT"), cleanupErrorCode: prefix + "DETACH_TIMEOUT" });
  await access(timedOut.mountpoint);
});

posixTest("detach diagnostics classify only bounded complete fixed hdiutil error lines", async (t) => {
  for (const [stderr, stderrClass] of [
    ["hdiutil: detach failed - Operation not permitted\n", "operation-not-permitted"],
    ["hdiutil: detach failed - Permission denied\r\n", "permission-denied"],
    ["hdiutil: detach failed - No such file or directory", "missing-target"],
    ["private hdiutil: detach failed - Resource busy\n", "other"],
    ["hdiutil: detach failed -\nResource busy", "other"],
    ["hdiutil: detach failed - Resource busy private", "other"],
    ["hdiutil: detach failed - Resource busy\nhdiutil: detach failed - Permission denied\n", "other"],
    ["x".repeat(4096) + "\nhdiutil: detach failed - Resource busy\n", "other"],
    [Buffer.from("private"), "other"], ["", "absent"], [undefined, "absent"],
  ]) {
    const state = await fixture(t, { commandError: { operation: "detach", error: Object.assign(new Error("private diagnostic"),
      { code: 1, stderr, stdout: "private command output" }) } });
    await assert.rejects(state.run(), (caught) => {
      assert.equal(caught.code, prefix + "DETACH");
      assert.equal(caught.artifactDetach.stderrClass, stderrClass);
      assert.equal(JSON.stringify(caught).includes("private"), false);
      return true;
    });
    assert.equal(state.calls.filter((call) => call.operation === "detach").length, 1);
    await access(state.mountpoint);
  }
});

posixTest("detach diagnostics preserve timeout and output-overflow distinctions without retrying", async (t) => {
  for (const [details, suffix, expected] of [
    [{ code: "ETIMEDOUT" }, "DETACH_TIMEOUT", { exitCode: null, signal: "none", timedOut: true, outputOverflow: false }],
    [{ code: null, killed: true, signal: "SIGKILL" }, "DETACH_TIMEOUT", { exitCode: null, signal: "SIGKILL", timedOut: true, outputOverflow: false }],
    [{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true, signal: "SIGKILL" }, "DETACH",
      { exitCode: null, signal: "SIGKILL", timedOut: false, outputOverflow: true }],
    [{ code: 1, killed: true, signal: "SIGTERM" }, "DETACH", { exitCode: 1, signal: "SIGTERM", timedOut: false, outputOverflow: false }],
    [{ code: "ENOENT", signal: "private" }, "DETACH", { exitCode: null, signal: "other", timedOut: false, outputOverflow: false }],
  ]) {
    const state = await fixture(t, { commandError: { operation: "detach", error: Object.assign(new Error("private"), details) } });
    await assert.rejects(state.run(), (caught) => {
      assert.equal(caught.code, prefix + suffix);
      assert.equal(caught.cleanupErrorCode, prefix + suffix);
      assert.deepEqual(caught.artifactDetach, { ...expected, stderrClass: "absent" });
      assert.equal(JSON.stringify(caught).includes("private"), false);
      return true;
    });
    assert.equal(state.calls.filter((call) => call.operation === "detach").length, 1);
    assert.equal(state.calls.at(-1).options.timeout, 30_000);
    assert.equal(state.calls.at(-1).options.signal, undefined);
    assert.deepEqual(state.calls.at(-1).args, ["detach", state.mountpoint]);
    await access(state.mountpoint);
  }
  const state = await fixture(t, { failCode: "detach" });
  await assert.rejects(state.run(), (caught) => {
    assert.equal(caught.code, prefix + "DETACH");
    assert.equal(caught.artifactDetach.exitCode, 1);
    return true;
  });
  await access(state.mountpoint);
});
