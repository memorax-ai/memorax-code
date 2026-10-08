import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { open, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { verifyLinuxAptReleases } from "./cursor-app-apt.mjs";

const platforms = ["linux-x64", "linux-arm64", "darwin-arm64", "win32-x64-user"];
const provenance = JSON.parse(readFileSync(new URL("./fixtures/cursor-app/provenance.json", import.meta.url), "utf8")).cursor;
const stableVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const commitPattern = /^[a-f0-9]{40}$/;
const hashPattern = /^[a-f0-9]{64}$/;
const baselineCommit = "c4730f7d93d787d9ab120af715999f0345ee5bc5";

function fail(code) { throw Object.assign(new Error(code), { code }); }
function check(value, code = "CURSOR_RELEASE_METADATA_INVALID") { if (!value) fail(code); }
function checkPlatform(platform) { check(platforms.includes(platform), "CURSOR_RELEASE_PLATFORM_INVALID"); }
function validDebVersion(debVersion, version) {
  if (typeof debVersion !== "string" || !debVersion.startsWith(version + "-")) return false;
  const revision = debVersion.slice(version.length + 1);
  return revision === revision.trim() && /^[1-9]\d*$/.test(revision) && Number.isSafeInteger(Number(revision));
}
function artifactUrl(platform, version, commitSha) {
  const prefix = `https://downloads.cursor.com/production/${commitSha}`;
  if (platform === "darwin-arm64") return `${prefix}/darwin/arm64/Cursor-darwin-arm64.dmg`;
  if (platform === "win32-x64-user") return `${prefix}/win32/x64/user-setup/CursorUserSetup-x64-${version}.exe`;
  const architecture = platform === "linux-x64" ? "x64" : "arm64";
  const debArchitecture = architecture === "x64" ? "amd64" : "arm64";
  return `${prefix}/linux/${architecture}/deb/${debArchitecture}/deb/cursor_${version}_${debArchitecture}.deb`;
}

export function baselineRelease(platform) {
  checkPlatform(platform);
  check(provenance.version === "3.21.18", "CURSOR_RELEASE_BASELINE_INVALID");
  const url = artifactUrl(platform, provenance.version, baselineCommit);
  const pin = platform.startsWith("linux-") ? provenance[platform === "linux-x64" ? "amd64" : "arm64"] : undefined;
  if (platform.startsWith("linux-")) check(pin?.url === url && typeof pin.sha256 === "string" && pin.sha256.length === 64
    && hashPattern.test(pin.sha256) && provenance.hashSource === "observed-sha256"
    && validDebVersion(pin.debVersion, provenance.version), "CURSOR_RELEASE_BASELINE_INVALID");
  return Object.freeze({ platform, version: provenance.version, commitSha: baselineCommit, url, channel: "baseline",
    sha256: pin?.sha256 ?? null, hashSource: pin ? "observed-sha256" : "not-provided", ...(pin ? { debVersion: pin.debVersion } : {}) });
}

export function resolveDownload(platform, metadata) {
  checkPlatform(platform);
  check(metadata && typeof metadata === "object" && !Array.isArray(metadata));
  const { version, commitSha } = metadata;
  check(typeof version === "string" && version === version.trim() && stableVersion.test(version)
    && version.split(".").every((part) => Number.isSafeInteger(Number(part))));
  check(typeof commitSha === "string" && commitSha.length === 40 && commitPattern.test(commitSha));
  const url = platform.startsWith("linux-") ? metadata.debUrl : metadata.downloadUrl;
  // Exact paths reject alternate hosts, encodings, credentials, redirects and mutable aliases.
  check(typeof url === "string" && url === artifactUrl(platform, version, commitSha));
  const baseline = baselineRelease(platform);
  const knownArtifact = version === baseline.version && commitSha === baseline.commitSha && url === baseline.url;
  // The public download API does not authenticate any artifact checksum.
  return Object.freeze({ platform, version, commitSha, url, channel: "latest",
    sha256: knownArtifact ? baseline.sha256 : null,
    hashSource: knownArtifact ? baseline.hashSource : "not-provided",
    ...(knownArtifact && baseline.debVersion ? { debVersion: baseline.debVersion } : {}) });
}

export function validateLinuxRelease(input, platform) {
  check(["linux-x64", "linux-arm64"].includes(platform) && input?.platform === platform, "CURSOR_RELEASE_PLATFORM_INVALID");
  const source = resolveDownload(platform, { version: input.version, commitSha: input.commitSha, debUrl: input.url });
  check(typeof input.sha256 === "string" && input.sha256.length === 64 && hashPattern.test(input.sha256)
    && validDebVersion(input.debVersion, input.version), "CURSOR_RELEASE_LINUX_INVALID");
  check(["baseline", "latest"].includes(input.channel), "CURSOR_RELEASE_LINUX_INVALID");
  const baseline = baselineRelease(platform);
  if (source.url === baseline.url) check(input.sha256 === baseline.sha256 && input.debVersion === baseline.debVersion,
    "CURSOR_RELEASE_PIN_CONFLICT");
  const release = { ...source, channel: input.channel, sha256: input.sha256, hashSource: input.hashSource, debVersion: input.debVersion };
  if (input.channel === "latest") {
    check(input.hashSource === "official-apt-sha256" && Number.isSafeInteger(input.size) && input.size > 0
      && input.size <= 300_000_000, "CURSOR_RELEASE_LINUX_INVALID");
    release.size = input.size;
  } else {
    check(Object.keys(baseline).every((key) => key === "channel" || release[key] === baseline[key]), "CURSOR_RELEASE_PIN_CONFLICT");
  }
  return Object.freeze(release);
}

export function validateDesktopRelease(input, platform, channel = input?.channel) {
  check(["darwin-arm64", "win32-x64-user"].includes(platform) && input?.platform === platform
    && input.channel === channel && ["baseline", "latest"].includes(channel));
  const canonical = channel === "baseline" ? baselineRelease(platform)
    : resolveDownload(platform, { version: input.version, commitSha: input.commitSha, downloadUrl: input.url });
  check(Object.keys(canonical).every((key) => input[key] === canonical[key]));
  return canonical;
}

export async function downloadDesktopArtifact(release, path, fetchImpl, signal, failure) {
  const check = (value, suffix) => { if (!value) throw failure(suffix); };
  const checkAborted = (value) => check(!value?.aborted, "ABORTED");
  const maxDownloadBytes = 600_000_000;
  const controller = new AbortController();
  const downloadSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(300_000), ...(signal ? [signal] : [])]);
  let file;
  try {
    checkAborted(signal);
    const response = await fetchImpl(release.url, { credentials: "omit", redirect: "error", cache: "no-store",
      headers: { "User-Agent": "memorax-cursor-app-ci" }, signal: downloadSignal });
    check(response?.status === 200 && response.body && response.redirected === false && response.url === release.url, "DOWNLOAD");
    const length = response.headers.get("content-length");
    const expectedBytes = length === null ? undefined : Number(length);
    check(length === null || (/^[1-9]\d*$/.test(length) && Number.isSafeInteger(expectedBytes)
      && expectedBytes <= maxDownloadBytes), "DOWNLOAD_SIZE");
    file = await open(path, "wx", 0o600);
    let bytes = 0;
    const hash = createHash("sha256");
    for await (const chunk of response.body) {
      checkAborted(downloadSignal);
      check(chunk instanceof Uint8Array, "DOWNLOAD");
      bytes += chunk.byteLength;
      check(bytes <= maxDownloadBytes, "DOWNLOAD_SIZE");
      hash.update(chunk);
      await file.writeFile(chunk);
    }
    check(bytes > 0 && (expectedBytes === undefined || bytes === expectedBytes), "DOWNLOAD_SIZE");
    checkAborted(downloadSignal);
    return { bytes, observedSha256: hash.digest("hex") };
  } catch (error) {
    if (signal?.aborted) throw failure("ABORTED");
    if (error?.code === failure("DOWNLOAD_SIZE").code) throw error;
    throw failure("DOWNLOAD");
  } finally {
    controller.abort();
    await file?.close();
  }
}

async function fetchDownloadMetadata(url) {
  const response = await fetch(url, { headers: { "User-Agent": "memorax-cursor-app-ci" }, credentials: "omit",
    redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30_000) });
  check(response.ok && response.body, "CURSOR_RELEASE_METADATA_HTTP_FAILED");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    check(size <= 64 * 1024, "CURSOR_RELEASE_METADATA_TOO_LARGE");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function resolveLatest({ fetchJson = fetchDownloadMetadata, manifestPath, verifyLinux = false, aptOptions } = {}) {
  check(manifestPath === undefined || (typeof manifestPath === "string" && manifestPath.length > 0), "CURSOR_RELEASE_FREEZE_FAILED");
  check(typeof verifyLinux === "boolean", "CURSOR_RELEASE_ARGUMENTS_INVALID");
  const baseline = {}, latest = {};
  for (const platform of platforms) {
    const errorPrefix = `CURSOR_RELEASE_${platform.replaceAll("-", "_").toUpperCase()}`;
    let metadata;
    try {
      metadata = await fetchJson(`https://cursor.com/api/download?platform=${platform}&releaseTrack=stable`);
    } catch { fail(`${errorPrefix}_FETCH_FAILED`); }
    try {
      baseline[platform] = baselineRelease(platform);
      latest[platform] = resolveDownload(platform, metadata);
    } catch { fail(`${errorPrefix}_METADATA_INVALID`); }
  }
  const releases = Object.values(latest);
  check(releases.every((release) => release.version === releases[0].version && release.commitSha === releases[0].commitSha),
    "CURSOR_RELEASE_LATEST_INCOHERENT");
  if (verifyLinux) {
    const verified = await verifyLinuxAptReleases(latest, aptOptions);
    for (const platform of ["linux-x64", "linux-arm64"]) latest[platform] = validateLinuxRelease(verified[platform], platform);
  }
  const manifest = Object.freeze({ schemaVersion: 1, baseline: Object.freeze(baseline), latest: Object.freeze(latest) });
  if (manifestPath !== undefined) {
    try { await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
    catch { fail("CURSOR_RELEASE_FREEZE_FAILED"); }
  }
  return manifest;
}

async function main(args) {
  const [command, value] = args;
  if (command === "baseline") {
    check(args.length === 2, "CURSOR_RELEASE_ARGUMENTS_INVALID");
    console.log(JSON.stringify(baselineRelease(value)));
    return;
  }
  check((command === "resolve" && (args.length === 1 || args.length === 2))
    || (command === "resolve-linux" && args.length === 2), "CURSOR_RELEASE_ARGUMENTS_INVALID");
  console.log(JSON.stringify(await resolveLatest({ manifestPath: value, verifyLinux: command === "resolve-linux" })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(/^CURSOR_RELEASE_[A-Z0-9_]+$/.test(error?.code ?? "") ? error.code : "CURSOR_RELEASE_RESOLUTION_FAILED");
    process.exitCode = 1;
  });
}
