import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const desktopVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const digest = /^[a-fA-F0-9]{64}$/;
const downloadRoot = "https://download.codebuddy.cn/workbuddy/saas";
const platforms = [
  { platform: "linux-x64-deb", os: "ubuntu-24.04", arch: "x64" },
  { platform: "darwin-arm64", os: "macos-15", arch: "arm64" },
  { platform: "win32-x64-user", os: "windows-2025", arch: "x64" },
];
const pins = {
  // Maintainer-reviewed Linux exception; see CONTRIBUTING.md for provenance.
  "linux-x64-deb": ["5.5.6.38337834", "2.137.1", "5f969292", "deb",
    "2ef1bca217d29d9c2ba988c82079aa6ea0077e9f1ff882c6ab5dd7998bddf721"],
  "darwin-arm64": ["5.6.2.39298511", "2.147.0", "37a65c0b", "dmg",
    "251d3e56a940a6061752534e5466e7dab332d4ee06148824a569a739892e1c21"],
  "darwin-x64": ["5.6.2.39298511", "2.147.0", "37a65c0b", "dmg",
    "0bee8b10407eebbfff3e1a177bfc790f6c95f6cd66bceb5676fd13a709b5715b"],
  "win32-x64-user": ["5.6.2.39298511", "2.147.0", "37a65c0b", "exe",
    "627e5a565436d0876740af69c2747759648662c52958d2a5df1ba330a82c3025"],
};
const linuxFeedHash = "03d756b259d7086c22098fa077589a032d60948d1de7313473360eefe11e240f";

export function baselineRelease(platform) {
  assert.ok(Object.hasOwn(pins, platform), "WORKBUDDY_RELEASE_PLATFORM_INVALID");
  const [desktopVersion, runtimeVersion, build, extension, sha256] = pins[platform];
  return { platform, desktopVersion, productVersion: desktopVersion.split(".").slice(0, 3).join("."),
    runtimeVersion, sha256, url: `${downloadRoot}/${platform}/WorkBuddy-${platform}-${desktopVersion}-${build}.${extension}`,
    channel: "baseline" };
}

export function validateRelease(value, platform) {
  const baseline = baselineRelease(platform);
  assert.equal(value?.platform, platform, "WORKBUDDY_RELEASE_PLATFORM_MISMATCH");
  for (const key of ["desktopVersion", "productVersion", "url", "sha256"]) {
    assert.equal(typeof value[key], "string");
    assert.ok(!/[\r\n]/.test(value[key]));
  }
  assert.match(value.desktopVersion, desktopVersion);
  assert.equal(value.productVersion, value.desktopVersion.split(".").slice(0, 3).join("."));
  const extension = pins[platform][3];
  const prefix = `${downloadRoot}/${platform}/WorkBuddy-${platform}-${value.desktopVersion}-`;
  assert.equal(typeof value.url, "string");
  assert.ok(value.url.startsWith(prefix));
  assert.match(value.url.slice(prefix.length), new RegExp(`^[a-f0-9]{8}\\.${extension}$`));
  assert.match(value.sha256, digest);
  assert.ok(["baseline", "baseline+latest", "latest"].includes(value.channel));
  const release = Object.fromEntries(Object.keys(baseline).map((key) => [key, value[key]]));
  release.sha256 = release.sha256.toLowerCase();
  // A known immutable URL must never be repinned by a feed or supplied description.
  if (release.url === baseline.url) assert.equal(release.sha256, baseline.sha256, "WORKBUDDY_RELEASE_PIN_CONFLICT");
  if (release.channel === "latest") assert.equal(release.runtimeVersion, null);
  else assert.deepEqual({ ...release, channel: "baseline" }, baseline);
  return release;
}

export function resolveFeed(platform, feed, wingetManifest) {
  const baseline = baselineRelease(platform);
  assert.match(feed?.version, desktopVersion);
  assert.equal(feed.productVersion, feed.version);
  let url = feed.url;
  // The official macOS download page selects DMG from the update-feed ZIP URL.
  if (platform.startsWith("darwin-") && typeof url === "string") url = url.replace(/\.zip$/, ".dmg");
  let sha256 = feed.sha256hash;
  if (platform === "win32-x64-user" && sha256 === "") {
    assert.equal(wingetManifest?.PackageIdentifier, "Tencent.WorkBuddy");
    assert.equal(wingetManifest.PackageVersion, feed.version.split(".").slice(0, 3).join("."));
    assert.equal(wingetManifest.ManifestType, "installer");
    assert.ok(Array.isArray(wingetManifest.Installers));
    const matches = wingetManifest.Installers.filter((installer) => installer.Architecture === "x64"
      && (installer.Scope ?? wingetManifest.Scope) === "user" && installer.InstallerUrl === url);
    assert.equal(matches.length, 1, "WORKBUDDY_WINGET_INSTALLER_NOT_UNIQUE");
    sha256 = matches[0].InstallerSha256;
  }
  if (platform === "linux-x64-deb" && sha256 === linuxFeedHash) {
    assert.equal(feed.version, baseline.desktopVersion);
    assert.equal(url, baseline.url);
    sha256 = baseline.sha256;
  }
  const release = validateRelease({ platform, desktopVersion: feed.version,
    productVersion: feed.version.split(".").slice(0, 3).join("."), runtimeVersion: null,
    url, sha256, channel: "latest" }, platform);
  return release;
}

export function buildMatrix(latestByPlatform) {
  const include = [];
  for (const { platform, os, arch } of platforms) {
    const baseline = baselineRelease(platform);
    const latest = validateRelease(latestByPlatform[platform], platform);
    assert.equal(latest.channel, "latest");
    const same = latest.desktopVersion === baseline.desktopVersion && latest.url === baseline.url && latest.sha256 === baseline.sha256;
    include.push({ os, arch, node: "24", release: { ...baseline, channel: same ? "baseline+latest" : "baseline" } });
    if (!same) include.push({ os, arch, node: "24", release: latest });
  }
  include.push({ os: "ubuntu-24.04", arch: "x64", node: "20", release: baselineRelease("linux-x64-deb") });
  return { include };
}

async function fetchPublicText(url) {
  const headers = { "User-Agent": "memorax-workbuddy-ci" };
  if (new URL(url).hostname === "api.github.com" && process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  }
  const response = await fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(30_000) });
  assert.ok(response.ok, "WORKBUDDY_RELEASE_METADATA_HTTP_FAILED");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    assert.ok(size <= 1024 * 1024, "WORKBUDDY_RELEASE_METADATA_TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function resolveLatest({ fetchText = fetchPublicText, parseYaml } = {}) {
  const latest = {};
  for (const { platform } of platforms) {
    let stage = "FEED";
    try {
      const feed = JSON.parse(await fetchText(`https://www.workbuddy.cn/v2/update?platform=workbuddy-${platform}`));
      let manifest;
      if (platform === "win32-x64-user" && feed.sha256hash === "") {
        assert.match(feed.version, desktopVersion);
        stage = "WINGET_COMMIT";
        const { sha } = JSON.parse(await fetchText("https://api.github.com/repos/microsoft/winget-pkgs/commits/master"));
        assert.match(sha, /^[a-f0-9]{40}$/);
        const version = feed.version.split(".").slice(0, 3).join(".");
        stage = "WINGET_MANIFEST";
        const source = await fetchText(`https://raw.githubusercontent.com/microsoft/winget-pkgs/${sha}/manifests/t/Tencent/WorkBuddy/${version}/Tencent.WorkBuddy.installer.yaml`);
        assert.equal(typeof parseYaml, "function", "WORKBUDDY_WINGET_PARSER_REQUIRED");
        manifest = parseYaml(source);
      }
      stage = "VALIDATION";
      latest[platform] = resolveFeed(platform, feed, manifest);
    } catch {
      const error = new Error("WorkBuddy latest metadata could not be verified");
      error.code = `WORKBUDDY_LATEST_${platform.replaceAll("-", "_").toUpperCase()}_${stage}_FAILED`;
      throw error;
    }
  }
  return buildMatrix(latest);
}

export function parseWingetManifest(source, parseDocument) {
  const document = parseDocument(source, { uniqueKeys: true, stringKeys: true, strict: true, prettyErrors: false });
  assert.equal(document.errors.length, 0);
  assert.equal(document.warnings.length, 0);
  return document.toJS({ maxAliasCount: 0 });
}

async function main(args) {
  const [command, platform, file] = args;
  if (["select", "select-json"].includes(command)) {
    assert.ok(args.length === 2 || args.length === 3);
    if (args.length === 3) assert.ok(file);
    const release = args.length === 3 ? validateRelease(JSON.parse(await readFile(file, "utf8")), platform) : baselineRelease(platform);
    console.log(command === "select-json" ? JSON.stringify(release)
      : [release.desktopVersion, release.productVersion, release.runtimeVersion ?? "discover", release.sha256, release.url].join("\t"));
    return;
  }
  assert.equal(command, "resolve");
  assert.equal(args.length, 1);
  // Only online resolution needs YAML. Native jobs and offline helper tests use built-ins.
  const { parseDocument } = await import(pathToFileURL(process.env.WORKBUDDY_YAML_MODULE).href);
  const matrix = await resolveLatest({ parseYaml: (source) => parseWingetManifest(source, parseDocument) });
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `matrix=${JSON.stringify(matrix)}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, "### WorkBuddy Release Matrix\n\n" + matrix.include.map((row) =>
      `- ${row.os} (${row.arch}), Node ${row.node}: ${row.release.channel}, desktop ${row.release.desktopVersion}, SHA-256 ${row.release.sha256}`).join("\n") + "\n");
  }
  console.log(JSON.stringify(matrix));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    const code = /^WORKBUDDY_LATEST_[A-Z0-9_]+_FAILED$/.test(error.code ?? "") ? error.code : "WORKBUDDY_RELEASE_RESOLUTION_FAILED";
    console.error(`${code}: release metadata, checksum or parser validation failed; no version fallback.`);
    process.exitCode = 1;
  });
}
