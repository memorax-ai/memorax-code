import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { baselineRelease, resolveDownload } from "./cursor-app-release.mjs";
import { runWindowsArtifactCheck } from "./cursor-app-windows-artifact-check.mjs";

const platform = "win32-x64-user", baseline = baselineRelease(platform);
const latest = resolveDownload(platform, { version: "3.23.12", commitSha: "2d29876d567da1607532b23bbf2cd5ddbca496fe",
  downloadUrl: "https://downloads.cursor.com/production/2d29876d567da1607532b23bbf2cd5ddbca496fe/win32/x64/user-setup/CursorUserSetup-x64-3.23.12.exe" });
function manifest(release = latest) { return { schemaVersion: 1, baseline: { [platform]: baseline }, latest: { [platform]: release } }; }
function receipt(release) {
  return { platform, channel: release.channel, version: release.version, commitSha: release.commitSha,
    sha256: null, hashSource: "not-provided", bytes: 1234, observedSha256: "a".repeat(64),
    authenticodeVerified: true, publisherVerified: true, signatureType: "Authenticode", publisher: "Anysphere, Inc.",
    installerExecuted: false, appIdentityVerified: false, appArchitectureVerified: false, ownedFilesRemoved: true };
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "cursor-artifact-check-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = join(root, "public report"), calls = [];
  let resolutions = 0;
  const options = { platform: "win32", arch: "x64", nodeMajor: "24",
    environment: { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted", RUNNER_OS: "Windows",
      ImageOS: "win25", GITHUB_RUN_ID: "123", RUNNER_TEMP: root },
    async resolveReleases() { resolutions++; return manifest(); },
    async verifyInstaller(args) {
      calls.push(args);
      assert.equal(args.platform, "win32");
      await writeFile(join(args.root, "synthetic-owned-file"), "synthetic");
      return receipt(args.release);
    } };
  return { root, output, calls, options, get resolutions() { return resolutions; } };
}

test("Windows artifact check freezes once, verifies both channels and removes owned state", async (t) => {
  const f = await fixture(t), report = await runWindowsArtifactCheck(f.output, f.options);
  assert.equal(f.resolutions, 1);
  assert.deepEqual(f.calls.map((call) => call.release), [baseline, latest]);
  assert.equal(report.status, "PASS"); assert.equal(report.stage, "done");
  assert.deepEqual(report.releases.map((entry) => entry.channels), [["baseline"], ["latest"]]);
  assert.ok(report.releases.every((entry) => entry.status === "PASS" && entry.hashSource === "observed-sha256"
    && entry.officialChecksumProvided === false));
  for (const field of ["installerExecuted", "appStarted", "nativeAcceptance", "appIdentityVerified", "appArchitectureVerified", "trustPolicyChanged"]) {
    assert.equal(report[field], false);
  }
  assert.equal(report.cleanup.ownedFilesRemoved, true);
  assert.deepEqual(await readdir(f.root), ["public report"]);
  assert.deepEqual(JSON.parse(await readFile(join(f.output, "report.json"), "utf8")), report);
});

test("Windows artifact check merges only complete identical artifact identities", async (t) => {
  for (const changedCommit of [false, true]) {
    const f = await fixture(t), commitSha = changedCommit ? "b".repeat(40) : baseline.commitSha;
    const release = resolveDownload(platform, { version: baseline.version, commitSha,
      downloadUrl: baseline.url.replace(baseline.commitSha, commitSha) });
    f.options.resolveReleases = async () => manifest(release);
    const report = await runWindowsArtifactCheck(f.output, f.options);
    assert.equal(report.status, "PASS");
    assert.equal(f.calls.length, changedCommit ? 2 : 1);
    assert.deepEqual(report.releases[0].channels, changedCommit ? ["baseline"] : ["baseline", "latest"]);
    assert.equal(f.calls[0].release.channel, "baseline");
  }
});

test("Windows artifact check rejects non-hosted and invalid environments before acquisition", async (t) => {
  for (const override of [{ platform: "darwin" }, { arch: "arm64" }, { nodeMajor: "22" },
    ...["GITHUB_ACTIONS", "RUNNER_ENVIRONMENT", "RUNNER_OS", "ImageOS", "GITHUB_RUN_ID"].map((key) => ({ environment: { [key]: "invalid" } }))]) {
    const f = await fixture(t);
    const report = await runWindowsArtifactCheck(f.output, { ...f.options, ...override,
      environment: { ...f.options.environment, ...override.environment } });
    assert.equal(report.errorCode, "CURSOR_APP_WINDOWS_ARTIFACT_RUNNER");
    assert.equal(f.resolutions, 0); assert.equal(f.calls.length, 0);
    assert.deepEqual(await readdir(f.root), []);
  }
});

test("Windows artifact check does not overwrite an existing report directory", async (t) => {
  const f = await fixture(t);
  const first = await runWindowsArtifactCheck(f.output, f.options);
  const second = await runWindowsArtifactCheck(f.output, f.options);
  assert.equal(first.status, "PASS"); assert.equal(second.status, "FAIL");
  assert.equal(f.resolutions, 1);
  assert.deepEqual(JSON.parse(await readFile(join(f.output, "report.json"), "utf8")), first);
});

test("Windows artifact check validates both frozen descriptors before downloading either", async (t) => {
  for (const invalid of [undefined, { ...latest, url: latest.url.replace("downloads.cursor.com", "invalid.example") },
    { ...latest, channel: "baseline" }, { ...latest, sha256: "b".repeat(64) }]) {
    const f = await fixture(t);
    f.options.resolveReleases = async () => ({ schemaVersion: 1, baseline: { [platform]: baseline }, latest: { [platform]: invalid } });
    const report = await runWindowsArtifactCheck(f.output, f.options);
    assert.equal(report.status, "FAIL"); assert.equal(report.stage, "release-resolution");
    assert.equal(f.calls.length, 0); assert.equal(report.cleanup.ownedFilesRemoved, true);
  }
});

test("Windows artifact check fails closed on invalid or overclaiming receipts", async (t) => {
  for (const invalid of [{ authenticodeVerified: false }, { publisherVerified: false }, { signatureType: "Catalog" },
    { publisher: "untrusted" }, { observedSha256: "invalid" }, { bytes: 0 }, { bytes: 600_000_001 },
    { ownedFilesRemoved: false }, { installerExecuted: true }, { appIdentityVerified: true },
    { appArchitectureVerified: true }, { sha256: "a".repeat(64) }, { channel: "latest" }]) {
    const f = await fixture(t);
    f.options.verifyInstaller = async ({ release }) => ({ ...receipt(release), ...invalid });
    const report = await runWindowsArtifactCheck(f.output, f.options);
    assert.equal(report.status, "FAIL");
    assert.equal(report.errorCode, "CURSOR_APP_WINDOWS_ARTIFACT_RECEIPT");
    assert.equal(report.releases[0].status, "FAIL");
  }
});

test("Windows artifact public reports omit raw failures, private paths and extra receipt properties", async (t) => {
  for (const fails of [false, true]) {
    const f = await fixture(t), sentinel = "PRIVATE_DIAGNOSTIC_SENTINEL";
    f.options.verifyInstaller = async ({ release }) => {
      if (fails) throw Object.assign(new Error(sentinel), { stdout: sentinel, path: f.root });
      return { ...receipt(release), path: f.root, secret: sentinel, rawSignature: { Subject: sentinel } };
    };
    const report = await runWindowsArtifactCheck(f.output, f.options);
    assert.equal(report.status, fails ? "FAIL" : "PASS");
    assert.ok(!JSON.stringify(report).includes(sentinel));
    assert.ok(!JSON.stringify(report).includes(f.root));
  }
});

test("Windows artifact check preserves the primary failure and retains state after uncertain cleanup", async (t) => {
  const f = await fixture(t);
  let ownedRoot;
  f.options.verifyInstaller = async ({ root }) => {
    ownedRoot = root;
    throw Object.assign(new Error("private"), { code: "CURSOR_APP_WINDOWS_ARTIFACT_SIGNATURE",
      cleanupErrorCode: "CURSOR_APP_WINDOWS_ARTIFACT_CLEANUP" });
  };
  const report = await runWindowsArtifactCheck(f.output, f.options);
  assert.equal(report.errorCode, "CURSOR_APP_WINDOWS_ARTIFACT_SIGNATURE");
  assert.equal(report.cleanupErrorCode, "CURSOR_APP_WINDOWS_ARTIFACT_CLEANUP");
  assert.equal(report.cleanup.ownedFilesRemoved, false);
  assert.ok((await lstat(ownedRoot)).isDirectory());
});

test("Windows artifact check aborts before verification and cleans its state", async (t) => {
  const f = await fixture(t), controller = new AbortController();
  controller.abort();
  const report = await runWindowsArtifactCheck(f.output, { ...f.options, signal: controller.signal });
  assert.equal(report.status, "FAIL"); assert.equal(report.errorCode, "CURSOR_APP_WINDOWS_ARTIFACT_ABORTED");
  assert.equal(f.calls.length, 0); assert.equal(report.cleanup.ownedFilesRemoved, true);
});
