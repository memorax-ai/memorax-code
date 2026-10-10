import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, chmod, cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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
    if (operation === configuration.failCopied && args.at(-1).startsWith(state.copiedPath)) {
      throw new Error("private copied-App diagnostic must not escape");
    }
    if (operation === configuration.commandError?.operation) throw configuration.commandError.error;
    if (operation === "attach") {
      state.mountpoint = args[args.indexOf("-mountpoint") + 1];
      state.ownedRoot = dirname(state.mountpoint);
      state.appPath = join(state.mountpoint, "Cursor.app");
      state.copiedPath = join(state.ownedRoot, "Cursor.app");
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
    if (operation === "ditto") {
      assert.deepEqual(args, [state.appPath, state.copiedPath]);
      await cp(state.appPath, state.copiedPath, { recursive: true, verbatimSymlinks: true });
      await configuration.mutateCopy?.(state);
    }
    if (operation === "detach" && operation !== configuration.failCode && state.appPath) {
      await rm(state.appPath, { recursive: true, force: true });
    }
    assert.ok(["codesign", "identity", "spctl", "detach", "ditto"].includes(operation), "only fixed acquisition commands are permitted");
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

test("selects each frozen macOS release without fallback or invented hashes", () => {
  for (const channel of ["baseline", "latest"]) {
    assert.deepEqual(selectCursorMacosRelease(manifest, channel), manifest[channel]["darwin-arm64"]);
  }
  for (const input of [null, {}, { ...manifest, schemaVersion: 2 }, { ...manifest, latest: {} }]) {
    assert.throws(() => selectCursorMacosRelease(input, "latest"), error("RELEASE"));
  }
  assert.throws(() => selectCursorMacosRelease(manifest, "unknown"), error("RELEASE"));
});

posixTest("both releases verify a private copy and detach before launching with isolated command state", async (t) => {
  for (const release of [baseline, latest]) {
    const state = await fixture(t, { release });
    const result = await state.run(async ({ appPath, evidence }) => {
      assert.equal(appPath, join(state.copiedPath, "Contents/MacOS/Cursor"));
      assert.deepEqual(await readFile(appPath), executable());
      await assert.rejects(access(state.appPath), { code: "ENOENT" });
      assert.deepEqual(evidence, { platform: "darwin-arm64", channel: release.channel, version: release.version,
        commitSha: release.commitSha, sha256: null, hashSource: "not-provided", bytes: image.length,
        observedSha256: createHash("sha256").update(image).digest("hex"), architecture: "arm64", readOnlyMount: true,
        copiedBundleVerified: true, imageDetachedBeforeLaunch: true, signatureVerified: true,
        bundleIdentifier: "com.todesktop.230313mzl4w4u92", teamIdentifier: "VDXQ22DGB9",
        gatekeeperAccepted: true, packageIdentityVerified: true });
      assert.ok(Object.isFrozen(evidence));
      return "callback-result";
    });
    assert.equal(result, "callback-result");
    assert.deepEqual(state.calls.map(({ operation }) => operation), ["attach", "mount-json", "codesign", "identity",
      "spctl", "info-json", "ditto", "codesign", "identity", "spctl", "info-json", "detach"]);
    const operations = Object.fromEntries(state.calls.map((call) => [call.operation, call]));
    assert.deepEqual(operations.attach.args, ["attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint",
      state.mountpoint, "-plist", join(state.ownedRoot, "Cursor.dmg")]);
    assert.deepEqual(operations.codesign.args, ["--verify", "--deep", "--strict", "--all-architectures", state.copiedPath]);
    assert.deepEqual(operations.identity.args, ["--verify", "--strict", "--all-architectures", "--test-requirement",
      '=identifier "com.todesktop.230313mzl4w4u92" and anchor apple generic and certificate leaf[subject.OU] = "VDXQ22DGB9"', state.copiedPath]);
    assert.deepEqual(operations.spctl.args, ["--assess", "--type", "execute", state.copiedPath]);
    for (const { options, operation } of state.calls) {
      assert.deepEqual(options.env, { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: state.ownedRoot,
        CFFIXED_USER_HOME: state.ownedRoot, TMPDIR: state.ownedRoot, TMP: state.ownedRoot, TEMP: state.ownedRoot, LANG: "C", LC_ALL: "C" });
      assert.equal(options.timeout, operation === "detach" ? 30_000 : 120_000);
      assert.equal(options.killSignal, "SIGKILL");
    }
    assert.equal(state.fetches[0].url, release.url);
    await state.assertClean();
  }
});

async function rejectsBeforeLaunch(t, configuration, suffix) {
  const state = await fixture(t, configuration);
  await assert.rejects(state.run(), error(suffix));
  assert.equal(state.callbackCount, 0);
  assert.equal(state.calls.at(-1).operation, "detach");
  await state.assertClean();
}

posixTest("mounted and copied bundles independently enforce every signature and static identity gate", async (t) => {
  for (const [operation, suffix] of [["attach", "MOUNT"], ["mount-json", "MOUNT_METADATA"], ["codesign", "SIGNATURE"],
    ["identity", "IDENTITY"], ["spctl", "ASSESSMENT"], ["info-json", "PACKAGE"], ["ditto", "COPY"]]) {
    await rejectsBeforeLaunch(t, { fail: operation }, suffix);
    if (["codesign", "identity", "spctl", "info-json"].includes(operation)) {
      await rejectsBeforeLaunch(t, { failCopied: operation }, suffix);
    }
  }
  for (const configuration of [
    { info: { CFBundleIdentifier: "other" } }, { info: { CFBundleExecutable: "../other" } },
    { info: { CFBundleShortVersionString: latest.version } }, { packageJson: { version: latest.version } },
    { productJson: { version: latest.version } }, { productJson: { darwinBundleIdentifier: "other" } }, { infoJson: "not json" },
    ...[undefined, null, "", "a".repeat(40)].map((realCommit) => ({ productJson: { commit: baseline.commitSha, realCommit } })),
    { mutateCopy: ({ copiedPath }) => writeFile(join(copiedPath, "Contents/Resources/app/product.json"), "{}") },
  ]) await rejectsBeforeLaunch(t, configuration, "PACKAGE");
  for (const mountJson of ["private invalid JSON", "[]", "{}", JSON.stringify({ "system-entities": {} }),
    JSON.stringify({ "system-entities": [{ "mount-point": "/Volumes/other" }] })]) {
    await rejectsBeforeLaunch(t, { mountJson }, "MOUNT_METADATA");
  }
  for (const mutate of [(header) => header.writeUInt32LE(0xcafebabe, 0), (header) => header.writeUInt32LE(0x01000007, 4),
    (header) => header.writeUInt32LE(6, 12)]) {
    const header = executable();
    mutate(header);
    await rejectsBeforeLaunch(t, { executable: header }, "ARCHITECTURE");
  }
  for (const header of [Buffer.alloc(0), Buffer.alloc(16)]) await rejectsBeforeLaunch(t, { executable: header }, "ARCHITECTURE");
  await rejectsBeforeLaunch(t, { mutateApp: ({ appPath }) => chmod(join(appPath, "Contents/MacOS/Cursor"), 0o644) }, "ARCHITECTURE");
  await rejectsBeforeLaunch(t, { mutateCopy: ({ copiedPath }) => writeFile(join(copiedPath, "Contents/MacOS/Cursor"), Buffer.alloc(32)) }, "ARCHITECTURE");
  for (const [relative, suffix] of [["Contents/Resources/app/product.json", "PACKAGE"], ["Contents/MacOS/Cursor", "ARCHITECTURE"]]) {
    for (const stage of ["mutateApp", "mutateCopy"]) {
      await rejectsBeforeLaunch(t, { [stage]: async ({ root, appPath, copiedPath }) => {
        const path = join(stage === "mutateApp" ? appPath : copiedPath, relative);
        await rm(path);
        await symlink(join(root, "unrelated"), path);
      } }, suffix);
    }
  }
});

posixTest("invalid authority and failed downloads cannot mount or launch", async (t) => {
  const state = await fixture(t);
  const linked = join(state.root, "link");
  await symlink(state.root, linked);
  for (const [overrides, suffix] of [
    [{ platform: "linux" }, "PLATFORM"], [{ root: "relative" }, "ARGUMENTS"],
    [{ root: state.root + "\0private" }, "ARGUMENTS"], [{ root: linked }, "ROOT"],
    [{ root: join(state.root, "unrelated") }, "ROOT"], [{ root: join(state.root, "missing") }, "ROOT"],
    [{ release: { ...baseline, sha256: "a".repeat(64) } }, "RELEASE"], [{ signal: AbortSignal.abort() }, "ABORTED"],
  ]) await assert.rejects(state.run(undefined, overrides), error(suffix));
  assert.equal(state.calls.length, 0);
  assert.equal(state.fetches.length, 0);
  await rm(linked);
  await state.assertClean();
  const failed = await fixture(t, { response: { redirected: true } });
  await assert.rejects(failed.run(), error("DOWNLOAD"));
  assert.equal(failed.calls.length, 0);
  await failed.assertClean();
});

posixTest("command failure, timeout and cancellation remain distinct and detach once", async (t) => {
  for (const [details, suffix] of [[{ code: 1 }, "SIGNATURE"], [{ code: "ETIMEDOUT" }, "SIGNATURE_TIMEOUT"],
    [{ killed: true, signal: "SIGKILL" }, "SIGNATURE_TIMEOUT"],
    [{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true, signal: "SIGKILL" }, "SIGNATURE"]]) {
    await rejectsBeforeLaunch(t, { commandError: { operation: "codesign", error: details } }, suffix);
  }
  await rejectsBeforeLaunch(t, { failCode: "codesign" }, "SIGNATURE");
  for (const phase of ["download", "copy", "signature"]) {
    const controller = new AbortController();
    const state = await fixture(t, phase === "copy" ? { mutateCopy: () => controller.abort() }
      : phase === "download" ? { response: { body: (async function* () { controller.abort(); yield image; })() } } : {});
    const execute = state.options.execute;
    await assert.rejects(state.run(undefined, { signal: controller.signal, execute: async (...args) => {
      if (phase === "signature" && args[0] === "/usr/bin/codesign") {
        controller.abort();
        throw { killed: true, signal: "SIGKILL" };
      }
      return execute(...args);
    } }), error("ABORTED"));
    assert.equal(state.callbackCount, 0);
    const detached = state.calls.filter(({ operation }) => operation === "detach");
    assert.equal(detached.length, phase === "download" ? 0 : 1);
    if (detached.length) assert.equal(detached[0].options.signal, undefined);
    await state.assertClean();
  }
});

posixTest("callback failure retains its private copy until the outer controller verifies cleanup", async (t) => {
  const state = await fixture(t);
  const original = new Error("CURSOR_APP_NATIVE_FAILED");
  await assert.rejects(state.run(async () => { throw original; }), (caught) => caught === original);
  await access(state.copiedPath);
  await assert.rejects(access(state.appPath), { code: "ENOENT" });
  assert.equal(state.calls.filter(({ operation }) => operation === "detach").length, 1);
});

posixTest("failed detach prevents launch, retains the mount and exposes only bounded diagnostics", async (t) => {
  const cases = [
    [{ code: 1, stderr: "hdiutil: detach failed - Resource busy\n" }, "DETACH", "resource-busy"],
    [{ code: 1, stderr: "hdiutil: detach failed - Operation not permitted\n" }, "DETACH", "operation-not-permitted"],
    [{ code: 1, stderr: "hdiutil: detach failed - Permission denied\r\n" }, "DETACH", "permission-denied"],
    [{ code: 1, stderr: "hdiutil: detach failed - No such file or directory" }, "DETACH", "missing-target"],
    ...["private hdiutil: detach failed - Resource busy\n", "hdiutil: detach failed -\nResource busy",
      "hdiutil: detach failed - Resource busy\nhdiutil: detach failed - Permission denied\n", "x".repeat(4097)]
      .map((stderr) => [{ code: 1, stderr }, "DETACH", "other"]),
    [{ code: "ETIMEDOUT" }, "DETACH_TIMEOUT", "absent"],
    [{ killed: true, signal: "SIGKILL" }, "DETACH_TIMEOUT", "absent"],
    [{ code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true, signal: "SIGKILL" }, "DETACH", "absent"],
    [{ code: 1, signal: "SIGTERM" }, "DETACH", "absent"],
  ];
  for (const [details, suffix, stderrClass] of cases) {
    const state = await fixture(t, { commandError: { operation: "detach", error: { ...details, stdout: "private" } } });
    await assert.rejects(state.run(), (caught) => {
      assert.equal(caught.code, prefix + suffix);
      assert.equal(caught.cleanupErrorCode, prefix + suffix);
      assert.equal(caught.artifactDetach.stderrClass, stderrClass);
      assert.equal(caught.artifactDetach.timedOut, suffix.endsWith("_TIMEOUT"));
      assert.equal(caught.artifactDetach.outputOverflow, details.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER");
      assert.equal(JSON.stringify(caught).includes("private"), false);
      return true;
    });
    assert.equal(state.callbackCount, 0);
    assert.equal(state.calls.filter(({ operation }) => operation === "detach").length, 1);
    await access(state.mountpoint);
    await access(join(state.ownedRoot, "Cursor.dmg"));
  }
  const state = await fixture(t, { fail: "ditto", commandError: { operation: "detach", error: { code: 1 } } });
  await assert.rejects(state.run(), { ...error("COPY"), cleanupErrorCode: prefix + "DETACH" });
  await access(state.mountpoint);
});
