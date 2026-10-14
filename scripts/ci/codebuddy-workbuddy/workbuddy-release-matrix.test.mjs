import assert from "node:assert/strict";
import test from "node:test";
import { baselineRelease, buildMatrix, coverageSummary, resolveFeed, resolveLatest, validateRelease } from "./workbuddy-release-matrix.mjs";

const platforms = ["linux-x64-deb", "darwin-arm64", "win32-x64-user"];
const linuxFeedHash = "03d756b259d7086c22098fa077589a032d60948d1de7313473360eefe11e240f";
function feed(platform, newer = false) {
  const baseline = baselineRelease(platform);
  const version = newer ? "5.7.0.40000000" : baseline.desktopVersion;
  let url = baseline.url.replace(baseline.desktopVersion, version);
  if (platform.startsWith("darwin-")) url = url.replace(/\.dmg$/, ".zip");
  return { version, productVersion: version, url, sha256hash: newer ? "a".repeat(64)
    : platform === "linux-x64-deb" ? linuxFeedHash : baseline.sha256 };
}
function releases(updated = []) {
  return Object.fromEntries(platforms.map((platform) => [platform, resolveFeed(platform, feed(platform, updated.includes(platform)))]));
}

test("WorkBuddy latest deduplicates each platform and retains Linux minimum Node baseline", () => {
  for (const updated of [[], ["linux-x64-deb"], ["darwin-arm64", "win32-x64-user"], platforms]) {
    const { include } = buildMatrix(releases(updated));
    assert.equal(include.length, 4 + updated.length);
    const minimum = include.filter((row) => row.node === "20");
    assert.equal(minimum.length, 1);
    assert.equal(minimum[0].os, "ubuntu-24.04");
    assert.deepEqual(minimum[0].release, baselineRelease("linux-x64-deb"));
    for (const platform of platforms) {
      const rows = include.filter((row) => row.node === "24" && row.release.platform === platform);
      assert.deepEqual(rows.map((row) => row.release.channel), updated.includes(platform) ? ["baseline", "latest"] : ["baseline+latest"]);
    }
  }
});

test("WorkBuddy does not deduplicate different desktop builds or changed artifacts", () => {
  const latest = releases(["linux-x64-deb"]);
  assert.equal(buildMatrix(latest).include.length, 5);
  latest["linux-x64-deb"] = { ...baselineRelease("linux-x64-deb"), channel: "latest", runtimeVersion: null,
    url: baselineRelease("linux-x64-deb").url.replace("5f969292", "abcdef12"), sha256: "a".repeat(64) };
  assert.equal(buildMatrix(latest).include.length, 5);
});

test("WorkBuddy Linux retains advisory feed hashes and deduplicates the same release URL", () => {
  const platform = "linux-x64-deb";
  const baseline = baselineRelease(platform);
  for (const sha256hash of [linuxFeedHash, "b".repeat(64)]) {
    const latest = resolveFeed(platform, { ...feed(platform), sha256hash });
    assert.equal(latest.sha256, sha256hash);
    const { include } = buildMatrix({ ...releases(), [platform]: latest });
    assert.equal(include.length, 4);
    const linux = include.filter((row) => row.release.platform === platform);
    assert.deepEqual(linux.map((row) => row.release.channel), ["baseline+latest", "baseline"]);
    for (const { release } of include) assert.deepEqual(validateRelease(release, release.platform), release);
    assert.equal(linux[0].release.sha256, baseline.sha256);
  }
  const newer = feed(platform, true);
  assert.equal(resolveFeed(platform, { ...newer, sha256hash: linuxFeedHash }).sha256, linuxFeedHash);
  assert.throws(() => resolveFeed(platform, { ...feed(platform), version: newer.version }));
});

test("WorkBuddy release validation rejects malformed, cross-platform and untrusted descriptions", () => {
  const valid = resolveFeed("linux-x64-deb", feed("linux-x64-deb", true));
  for (const change of [{ platform: "win32-x64-user" }, { productVersion: "1.0.0" }, { desktopVersion: "5.7.0.1\ninjected" },
    { url: valid.url.replace("https:", "http:") }, { url: valid.url.replace("download.codebuddy.cn", "example.com") },
    { url: valid.url + "?download=1" }, { url: valid.url.replace("/saas/", "/saas/../saas/") },
    { sha256: "" }, { sha256: "a".repeat(63) }, { runtimeVersion: "3.0.0" }, { channel: "unknown" },
    { channel: "baseline" }, { channel: "baseline+latest" }]) {
    assert.throws(() => validateRelease({ ...valid, ...change }, "linux-x64-deb"));
  }
  for (const key of ["desktopVersion", "productVersion", "url", "sha256"]) {
    assert.throws(() => validateRelease({ ...valid, [key]: valid[key] + "\n" }, "linux-x64-deb"));
  }
  assert.throws(() => buildMatrix({}));
  for (const change of [{ version: "5.7.0.40000000-beta" }, { productVersion: "5.6.2" }, { sha256hash: "" }]) {
    assert.throws(() => resolveFeed("darwin-arm64", { ...feed("darwin-arm64", true), ...change }));
  }
});

test("WorkBuddy known artifact checksums remain strict outside Linux", () => {
  for (const platform of [...platforms, "darwin-x64"]) {
    const latest = { ...baselineRelease(platform), channel: "latest", runtimeVersion: null };
    assert.deepEqual(validateRelease(latest, platform), latest);
    const changed = { ...latest, sha256: "a".repeat(64) };
    if (platform === "linux-x64-deb") assert.deepEqual(validateRelease(changed, platform), changed);
    else assert.throws(() => validateRelease(changed, platform), /WORKBUDDY_RELEASE_PIN_CONFLICT/);
  }
});

test("WorkBuddy Windows SHA must match one exact x64 winget installer", () => {
  const value = { ...feed("win32-x64-user", true), sha256hash: "" };
  const manifest = { PackageIdentifier: "Tencent.WorkBuddy", PackageVersion: "5.7.0", ManifestType: "installer",
    Installers: [{ Architecture: "x64", Scope: "user", InstallerUrl: value.url, InstallerSha256: "A".repeat(64) }] };
  assert.equal(resolveFeed("win32-x64-user", value, manifest).sha256, "a".repeat(64));
  assert.equal(resolveFeed("win32-x64-user", value, { ...manifest,
    Installers: [...manifest.Installers, { ...manifest.Installers[0], Scope: "machine" }] }).sha256, "a".repeat(64));
  for (const altered of [{ ...manifest, PackageIdentifier: "Other" }, { ...manifest, PackageVersion: "5.6.2" },
    { ...manifest, Installers: [] }, { ...manifest, Installers: [...manifest.Installers, ...manifest.Installers] },
    { ...manifest, Installers: [{ ...manifest.Installers[0], Architecture: "arm64" }] },
    { ...manifest, Installers: [{ ...manifest.Installers[0], InstallerUrl: value.url + "?x" }] },
    { ...manifest, Installers: [{ ...manifest.Installers[0], InstallerSha256: "bad" }] }]) {
    assert.throws(() => resolveFeed("win32-x64-user", value, altered));
  }
  assert.throws(() => resolveFeed("win32-x64-user", value));
});

test("WorkBuddy discovery freezes the winget commit and resolves each required feed only once", async () => {
  const calls = [], sha = "1".repeat(40);
  const windows = { ...feed("win32-x64-user"), sha256hash: "" };
  const matrix = await resolveLatest({
    fetchText: async (url) => {
      calls.push(url);
      if (url.startsWith("https://www.workbuddy.cn/v2/update?platform=workbuddy-")) {
        const platform = new URL(url).searchParams.get("platform").slice("workbuddy-".length);
        return JSON.stringify(platform === "win32-x64-user" ? windows : feed(platform));
      }
      if (url === "https://api.github.com/repos/microsoft/winget-pkgs/commits/master") return JSON.stringify({ sha });
      assert.equal(url, `https://raw.githubusercontent.com/microsoft/winget-pkgs/${sha}/manifests/t/Tencent/WorkBuddy/5.6.2/Tencent.WorkBuddy.installer.yaml`);
      return "fixture manifest";
    },
    parseYaml: (source) => {
      assert.equal(source, "fixture manifest");
      return { PackageIdentifier: "Tencent.WorkBuddy", PackageVersion: "5.6.2", ManifestType: "installer",
        Installers: [{ Architecture: "x64", Scope: "user", InstallerUrl: windows.url, InstallerSha256: baselineRelease("win32-x64-user").sha256 }] };
    },
  });
  assert.equal(matrix.include.length, 4);
  assert.equal(calls.length, 5);
  assert.equal(new Set(calls).size, calls.length);
});

test("WorkBuddy discovery fails without fallback on network, JSON, or winget failures", async () => {
  for (const fetchText of [async () => { throw new Error("HTTP failure"); }, async () => "bad JSON"]) {
    await assert.rejects(resolveLatest({ fetchText }), { code: "WORKBUDDY_LATEST_LINUX_X64_DEB_FEED_FAILED" });
  }
  await assert.rejects(resolveLatest({ fetchText: async (url) => {
    if (url.startsWith("https://api.github.com/")) return JSON.stringify({ sha: "master" });
    const platform = new URL(url).searchParams.get("platform").slice("workbuddy-".length);
    return JSON.stringify({ ...feed(platform), ...(platform === "win32-x64-user" ? { sha256hash: "" } : {}) });
  }, parseYaml: () => assert.fail("Must reject mutable ref before parsing") }), { code: "WORKBUDDY_LATEST_WIN32_X64_USER_WINGET_COMMIT_FAILED" });
});

function fallbackDiscovery({ versions = ["5.6.2"], selectedVersion = "5.6.2", changes = {},
  manifestError = 404, manifestSource, feedChanges = {}, directoryError, candidateError } = {}) {
  const sha = "1".repeat(40), calls = [];
  const baseline = baselineRelease("win32-x64-user");
  const windows = { ...feed("win32-x64-user", true), sha256hash: "", ...feedChanges };
  const fullVersion = selectedVersion === baseline.productVersion ? baseline.desktopVersion : `${selectedVersion}.39000000`;
  const url = baseline.url.replace(baseline.desktopVersion, fullVersion);
  const manifest = { PackageIdentifier: "Tencent.WorkBuddy", PackageVersion: selectedVersion, ManifestType: "installer",
    Installers: [{ Architecture: "x64", Scope: "user", InstallerUrl: url,
      InstallerSha256: selectedVersion === baseline.productVersion ? baseline.sha256 : "b".repeat(64) }], ...changes };
  return { calls, run: () => resolveLatest({ parseYaml: JSON.parse, fetchText: async (url) => {
    calls.push(url);
    if (url.startsWith("https://www.workbuddy.cn/v2/update?")) {
      const platform = new URL(url).searchParams.get("platform").slice("workbuddy-".length);
      return JSON.stringify(platform === "win32-x64-user" ? windows : feed(platform));
    }
    if (url.endsWith("/commits/master")) return JSON.stringify({ sha });
    if (url.includes("/5.7.0/Tencent.WorkBuddy.installer.yaml")) {
      if (manifestSource !== undefined) return manifestSource;
      throw Object.assign(new Error("manifest request failed"), { status: manifestError });
    }
    if (url.includes("/contents/")) {
      assert.equal(url, `https://api.github.com/repos/microsoft/winget-pkgs/contents/manifests/t/Tencent/WorkBuddy?ref=${sha}`);
      if (directoryError) throw directoryError;
      return JSON.stringify(versions.map((name) => ({ name, type: "dir" })));
    }
    assert.equal(url, `https://raw.githubusercontent.com/microsoft/winget-pkgs/${sha}/manifests/t/Tencent/WorkBuddy/${selectedVersion}/Tencent.WorkBuddy.installer.yaml`);
    if (candidateError) throw candidateError;
    return JSON.stringify(manifest);
  } }) };
}

test("Windows missing latest manifest falls back without claiming latest or duplicating baseline", async () => {
  const { run, calls } = fallbackDiscovery();
  const matrix = await run();
  const windows = matrix.include.filter((row) => row.release.platform === "win32-x64-user");
  assert.equal(matrix.include.length, 4);
  assert.equal(windows.length, 1);
  assert.deepEqual(windows[0].release, baselineRelease("win32-x64-user"));
  assert.equal(windows[0].requestedDesktopVersion, "5.7.0.40000000");
  assert.equal(coverageSummary(matrix), "Coverage degraded: Windows latest 5.7.0.40000000 not tested (winget manifest missing); selected 5.6.2.39298511.");
  assert.equal(calls.filter((url) => url.endsWith("/commits/master")).length, 1);
  assert.equal(coverageSummary(buildMatrix(releases())), "All official latest releases resolved.");
});

test("Windows fallback selects the highest stable lower version numerically, not fixed baseline", async () => {
  const matrix = await fallbackDiscovery({ versions: ["5.6.2", "5.6.9", "5.6.10", "5.7.0", "5.8.0", "5.6.11-beta", "05.6.12", "5.6.12\n"],
    selectedVersion: "5.6.10" }).run();
  const windows = matrix.include.filter((row) => row.release.platform === "win32-x64-user");
  assert.equal(windows.length, 2);
  assert.deepEqual(windows.map((row) => row.release.channel), ["baseline", "fallback"]);
  assert.equal(windows[1].release.desktopVersion, "5.6.10.39000000");
  assert.equal(windows[1].requestedDesktopVersion, "5.7.0.40000000");
  assert.equal(windows[1].release.runtimeVersion, null);
  assert.deepEqual(validateRelease(windows[1].release, "win32-x64-user"), windows[1].release);
  assert.throws(() => validateRelease({ ...releases()["darwin-arm64"], channel: "fallback" }, "darwin-arm64"));
});

test("Windows fallback is limited to a missing exact manifest, never transport or invalid metadata", async () => {
  for (const manifestSource of ["invalid YAML", "null", "{}"]) {
    const fixture = fallbackDiscovery({ manifestSource });
    await assert.rejects(fixture.run());
    assert.equal(fixture.calls.some((url) => url.includes("/contents/")), false);
  }
  for (const status of [401, 403, 429, 500, "404", null]) {
    const fixture = fallbackDiscovery({ manifestError: status });
    await assert.rejects(fixture.run());
    assert.equal(fixture.calls.some((url) => url.includes("/contents/")), false);
  }
  for (const change of [{ version: "bad" }, { productVersion: "5.6.2" }, { sha256hash: null }, { sha256hash: "bad" },
    { url: "https://example.com/WorkBuddy.exe" }]) {
    const fixture = fallbackDiscovery({ feedChanges: change });
    await assert.rejects(fixture.run());
    assert.equal(fixture.calls.some((url) => url.includes("/contents/")), false);
  }
  for (const options of [{ versions: [] }, { versions: ["5.7.0", "5.8.0"] },
    { directoryError: Object.assign(new Error("directory missing"), { status: 404 }) },
    { candidateError: Object.assign(new Error("candidate missing"), { status: 404 }) },
    { changes: { PackageIdentifier: "Other" } }, { changes: { PackageVersion: "5.6.1" } },
    { changes: { Installers: [] } }, { changes: { Installers: [{ Architecture: "x64", Scope: "user",
      InstallerUrl: baselineRelease("win32-x64-user").url, InstallerSha256: "a".repeat(64) }] } }]) {
    await assert.rejects(fallbackDiscovery(options).run());
  }
});
