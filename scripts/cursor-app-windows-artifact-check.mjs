import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLatest } from "./cursor-app-release.mjs";
import { selectCursorWindowsRelease, verifyCursorWindowsInstaller } from "./cursor-app-windows-artifact.mjs";

const prefix = "CURSOR_APP_WINDOWS_ARTIFACT_";
function check(value, suffix) { if (!value) throw Object.assign(new Error(prefix + suffix), { code: prefix + suffix }); }
function errorCode(error) {
  return /^CURSOR_(?:APP_WINDOWS_ARTIFACT|RELEASE)_[A-Z0-9_]{1,80}$/.test(error?.code ?? "")
    ? error.code : prefix + "CHECK_FAILED";
}

function receiptEvidence(receipt, release) {
  check(receipt?.platform === release.platform && receipt.channel === release.channel
    && receipt.version === release.version && receipt.commitSha === release.commitSha
    && receipt.sha256 === null && receipt.hashSource === "not-provided"
    && Number.isSafeInteger(receipt.bytes) && receipt.bytes > 0 && receipt.bytes <= 600_000_000
    && typeof receipt.observedSha256 === "string" && /^[a-f0-9]{64}$/.test(receipt.observedSha256)
    && receipt.authenticodeVerified === true && receipt.publisherVerified === true
    && receipt.signatureType === "Authenticode" && receipt.publisher === "Anysphere, Inc."
    && receipt.installerExecuted === false && receipt.appIdentityVerified === false
    && receipt.appArchitectureVerified === false && receipt.ownedFilesRemoved === true, "RECEIPT");
  return { bytes: receipt.bytes, observedSha256: receipt.observedSha256, hashSource: "observed-sha256",
    officialChecksumProvided: false, authenticodeVerified: true, publisherVerified: true,
    signatureType: "Authenticode", publisher: "Anysphere, Inc.", ownedFilesRemoved: true };
}

export async function runWindowsArtifactCheck(reportPath, { signal, environment = process.env,
  platform = process.platform, arch = process.arch, nodeMajor = process.versions.node.split(".")[0],
  resolveReleases = resolveLatest, verifyInstaller = verifyCursorWindowsInstaller } = {}) {
  const report = { schemaVersion: 1, kind: "installer-artifact-proof", platform: "win32", status: "FAIL", stage: "guard",
    installerExecuted: false, appStarted: false, nativeAcceptance: false,
    appIdentityVerified: false, appArchitectureVerified: false, trustPolicyChanged: false,
    releases: [], cleanup: { ownedFilesRemoved: false } };
  let output, root, cleanupFailed = false;
  try {
    check(platform === "win32" && arch === "x64" && nodeMajor === "24"
      && environment.GITHUB_ACTIONS === "true" && environment.RUNNER_ENVIRONMENT === "github-hosted"
      && environment.RUNNER_OS === "Windows" && ["win25", "win25-vs2026"].includes(environment.ImageOS)
      && /^\d+$/.test(environment.GITHUB_RUN_ID ?? ""), "RUNNER");
    check(typeof environment.RUNNER_TEMP === "string" && isAbsolute(environment.RUNNER_TEMP)
      && typeof reportPath === "string" && isAbsolute(reportPath)
      && !/[\0\r\n]/.test(environment.RUNNER_TEMP + reportPath), "OUTPUT");
    const temp = await realpath(environment.RUNNER_TEMP), destination = resolve(reportPath);
    check(await realpath(dirname(destination)) === temp, "OUTPUT");
    await mkdir(destination, { mode: 0o700 });
    const outputInfo = await lstat(destination);
    check(outputInfo.isDirectory() && !outputInfo.isSymbolicLink(), "OUTPUT");
    output = await realpath(destination);
    root = await realpath(await mkdtemp(join(temp, "cursor-windows-artifacts-")));
    report.stage = "release-resolution";
    check(!signal?.aborted, "ABORTED");
    // Both channels use one metadata snapshot; channel labels never alter artifact identity.
    const manifest = await resolveReleases();
    const releases = ["baseline", "latest"].map((channel) => selectCursorWindowsRelease(manifest, channel));
    const unique = new Map();
    for (const release of releases) {
      const key = JSON.stringify([release.platform, release.version, release.commitSha, release.url, release.sha256, release.hashSource]);
      if (unique.has(key)) unique.get(key).channels.push(release.channel);
      else unique.set(key, { release, channels: [release.channel] });
    }
    for (const { release, channels } of unique.values()) {
      check(!signal?.aborted, "ABORTED");
      report.stage = "artifact-verification";
      const entry = { channels, platform: release.platform, version: release.version, commitSha: release.commitSha, status: "FAIL" };
      report.releases.push(entry);
      const receipt = await verifyInstaller({ release, root, signal, platform });
      Object.assign(entry, receiptEvidence(receipt, release), { status: "PASS" });
    }
    check(!signal?.aborted, "ABORTED");
    report.status = "PASS"; report.stage = "done";
  } catch (error) {
    report.errorCode = errorCode(error);
    if (error.cleanupErrorCode) {
      cleanupFailed = true;
      report.cleanupErrorCode = errorCode({ code: error.cleanupErrorCode });
    }
  } finally {
    if (root && !cleanupFailed) {
      try { await rm(root, { recursive: true, force: true }); report.cleanup.ownedFilesRemoved = true; }
      catch { cleanupFailed = true; report.cleanupErrorCode = prefix + "STATE_CLEANUP"; }
    }
    if (cleanupFailed) report.status = "FAIL";
    if (output) await writeFile(join(output, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  }
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort()); process.once("SIGTERM", () => controller.abort());
  try {
    check(process.argv.length === 3, "ARGUMENTS");
    const report = await runWindowsArtifactCheck(process.argv[2], { signal: controller.signal });
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== "PASS") process.exitCode = 1;
  } catch (error) { console.error(errorCode(error)); process.exitCode = 1; }
}
