import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { baselineRelease, resolveDownload, resolveLatest, validateLinuxRelease } from "./cursor-app-release.mjs";

const platforms = ["linux-x64", "linux-arm64", "darwin-arm64", "win32-x64-user"];
const version = "3.23.12";
const commitSha = "2".repeat(40);
function metadata(platform, overrides = {}) {
  const baseline = baselineRelease(platform);
  const url = baseline.url.replace(baseline.commitSha, commitSha).replaceAll(baseline.version, version);
  return { version, commitSha, [platform.startsWith("linux-") ? "debUrl" : "downloadUrl"]: url, ...overrides };
}
function fixtureFetch(calls = []) {
  return async (url) => {
    calls.push(url);
    const endpoint = new URL(url);
    assert.equal(endpoint.origin + endpoint.pathname, "https://cursor.com/api/download");
    assert.equal(endpoint.searchParams.get("releaseTrack"), "stable");
    return metadata(endpoint.searchParams.get("platform"));
  };
}

test("Cursor baseline preserves existing Linux pins and does not invent desktop checksums", async () => {
  const { cursor } = JSON.parse(await readFile(new URL("./fixtures/cursor-app/provenance.json", import.meta.url), "utf8"));
  for (const [platform, arch] of [["linux-x64", "amd64"], ["linux-arm64", "arm64"]]) {
    const release = baselineRelease(platform);
    assert.equal(release.version, "3.21.18");
    assert.equal(release.url, cursor[arch].url);
    assert.equal(release.sha256, cursor[arch].sha256);
    assert.equal(release.hashSource, "observed-sha256");
    assert.equal(release.debVersion, cursor[arch].debVersion);
  }
  for (const platform of ["darwin-arm64", "win32-x64-user"]) {
    const release = baselineRelease(platform);
    assert.equal(release.commitSha, "c4730f7d93d787d9ab120af715999f0345ee5bc5");
    assert.equal(release.sha256, null);
    assert.equal(release.hashSource, "not-provided");
    assert.equal(release.channel, "baseline");
  }
  for (const platform of ["linux-x64-deb", "darwin-x64", "win32-x64-archive", "toString", undefined]) {
    assert.throws(() => baselineRelease(platform), { code: "CURSOR_RELEASE_PLATFORM_INVALID" });
  }
});

test("Cursor latest selects desktop artifacts and never promotes unverified API checksum fields", () => {
  for (const platform of platforms) {
    const release = resolveDownload(platform, metadata(platform, {
      sha256: "a".repeat(64), hashSource: "publisher-signed", rehUrl: "https://example.com/remote-server",
      ...(platform.startsWith("linux-") ? { downloadUrl: "https://example.com/not-the-deb" } : {}),
    }));
    assert.equal(release.version, version);
    assert.equal(release.commitSha, commitSha);
    assert.equal(release.channel, "latest");
    assert.equal(release.sha256, null);
    assert.equal(release.hashSource, "not-provided");
    assert.deepEqual(Object.keys(release).sort(), ["channel", "commitSha", "hashSource", "platform", "sha256", "url", "version"]);
    assert.ok(Object.isFrozen(release));
  }
});

test("Cursor latest may reuse only the exact existing observed baseline artifact hash", () => {
  for (const platform of platforms) {
    const baseline = baselineRelease(platform);
    const key = platform.startsWith("linux-") ? "debUrl" : "downloadUrl";
    const latest = resolveDownload(platform, { version: baseline.version, commitSha: baseline.commitSha, [key]: baseline.url });
    assert.deepEqual(latest, { ...baseline, channel: "latest" });
    const changed = resolveDownload(platform, { version: baseline.version, commitSha, [key]: baseline.url.replace(baseline.commitSha, commitSha) });
    assert.equal(changed.sha256, null);
    assert.equal(changed.hashSource, "not-provided");
  }
});

test("Cursor Linux acquisition validates exact baseline pins and verified apt descriptors", () => {
  for (const platform of ["linux-x64", "linux-arm64"]) {
    const baseline = baselineRelease(platform);
    assert.deepEqual(validateLinuxRelease(baseline, platform), baseline);
    assert.throws(() => validateLinuxRelease({ ...baseline, channel: "baseline+latest" }, platform));
    const latest = { ...resolveDownload(platform, metadata(platform)), sha256: "a".repeat(64),
      hashSource: "official-apt-sha256", debVersion: `${version}-1790831722`, size: 200 };
    assert.deepEqual(validateLinuxRelease({ ...latest, privateDiagnostic: "do not export" }, platform), latest);
    for (const change of [{ platform: "darwin-arm64" }, { sha256: null }, { sha256: "a".repeat(64) + "\n" },
      { hashSource: "observed-sha256" }, { hashSource: "not-provided" }, { debVersion: "3.23.11-1790831722" },
      { debVersion: `${version}-1790831722\n` }, { debVersion: `${version}-1-extra` }, { size: undefined },
      { size: 0 }, { size: 300000001 }, { channel: "baseline" }, { url: latest.url + "?x" }]) {
      assert.throws(() => validateLinuxRelease({ ...latest, ...change }, platform));
    }
    assert.throws(() => validateLinuxRelease({ ...baseline, sha256: "b".repeat(64) }, platform));
    assert.throws(() => validateLinuxRelease({ ...baseline, debVersion: baseline.debVersion + "0" }, platform));
    assert.throws(() => validateLinuxRelease({ ...baseline, channel: "latest", hashSource: "official-apt-sha256",
      size: 200, sha256: "b".repeat(64) }, platform));
  }
  assert.throws(() => validateLinuxRelease(baselineRelease("darwin-arm64"), "darwin-arm64"));
});

test("Cursor rejects untrusted, cross-platform, mutable, and inconsistent artifact URLs", () => {
  for (const platform of platforms) {
    const input = metadata(platform);
    const key = platform.startsWith("linux-") ? "debUrl" : "downloadUrl";
    const otherPlatform = platforms[(platforms.indexOf(platform) + 1) % platforms.length];
    const other = metadata(otherPlatform);
    for (const url of [input[key].replace("https:", "http:"), input[key].replace("downloads.cursor.com", "example.com"),
      input[key].replace("downloads.cursor.com", "downloads.cursor.com.example.com"),
      input[key].replace("https://", "https://user@"), input[key].replace(".com/", ".com:443/"),
      input[key] + "?download=1", input[key] + "#fragment", input[key] + "\n",
      input[key].replace(commitSha, "3".repeat(40)), input[key].replace("/production/", "/production/../production/"),
      input[key].replace("/production/", "/%70roduction/"), other.debUrl ?? other.downloadUrl,
      `https://downloads.cursor.com/production/${commitSha}/cursor/latest`]) {
      assert.throws(() => resolveDownload(platform, { ...input, [key]: url }));
    }
    if (platform !== "darwin-arm64") assert.throws(() => resolveDownload(platform, { ...input, [key]: input[key].replace(version, "3.23.11") }));
  }
});

test("Cursor metadata requires stable semantic versions and exact immutable commit IDs", () => {
  for (const platform of platforms) {
    const input = metadata(platform);
    for (const change of [{ version: "3.23" }, { version: "3.23.12-beta" }, { version: "03.23.12" },
      { version: "3.23.12\n" }, { version: "9007199254740992.1.1" }, { version: 3 },
      { commitSha: "main" }, { commitSha: "A".repeat(40) }, { commitSha: "a".repeat(39) },
      { commitSha: commitSha + "\n" }, { commitSha: null }, { debUrl: null, downloadUrl: null }]) {
      assert.throws(() => resolveDownload(platform, { ...input, ...change }));
    }
  }
  for (const input of [null, [], "metadata", 42]) assert.throws(() => resolveDownload("linux-x64", input));
});

test("Cursor resolves the four stable feeds once and freezes only projected descriptors", async () => {
  const calls = [];
  const manifest = await resolveLatest({ fetchJson: fixtureFetch(calls) });
  assert.equal(manifest.schemaVersion, 1);
  assert.deepEqual(Object.keys(manifest.baseline), platforms);
  assert.deepEqual(Object.keys(manifest.latest), platforms);
  assert.equal(calls.length, 4);
  assert.equal(new Set(calls).size, 4);
  for (const platform of platforms) {
    assert.deepEqual(manifest.baseline[platform], baselineRelease(platform));
    assert.deepEqual(manifest.latest[platform], resolveDownload(platform, metadata(platform)));
  }
  assert.ok(Object.isFrozen(manifest));
  assert.ok(Object.isFrozen(manifest.latest));
  assert.throws(() => { manifest.latest["linux-x64"].version = "0.0.0"; });
});

test("Cursor rejects cross-platform version or commit rollout differences without fallback", async () => {
  for (const changes of [{ version: "3.23.13" }, { commitSha: "3".repeat(40) }]) {
    await assert.rejects(resolveLatest({ fetchJson: async (url) => {
      const platform = new URL(url).searchParams.get("platform");
      const input = metadata(platform);
      if (platform !== "darwin-arm64") return input;
      const changed = { ...input, ...changes };
      if (changes.commitSha) changed.downloadUrl = input.downloadUrl.replace(commitSha, changes.commitSha);
      return changed;
    } }), { code: "CURSOR_RELEASE_LATEST_INCOHERENT" });
  }
});

test("Cursor metadata failures never write a partial manifest or leak response details", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-cursor-release-"));
  try {
    for (const fetchJson of [async () => { throw new Error("private response body"); }, async () => ({ version: "bad" })]) {
      await assert.rejects(resolveLatest({ fetchJson, manifestPath: join(root, "release.json") }), (error) => {
        assert.match(error.code, /^CURSOR_RELEASE_LINUX_X64_(?:FETCH_FAILED|METADATA_INVALID)$/);
        assert.equal(error.message, error.code);
        return true;
      });
      assert.deepEqual(await readdir(root), []);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Cursor freeze writes one manifest exclusively and preserves existing files", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-cursor-release-"));
  const manifestPath = join(root, "release.json");
  try {
    const manifest = await resolveLatest({ fetchJson: fixtureFetch(), manifestPath });
    assert.deepEqual(JSON.parse(await readFile(manifestPath, "utf8")), manifest);
    await writeFile(manifestPath, "owned existing data");
    await assert.rejects(resolveLatest({ fetchJson: fixtureFetch(), manifestPath }), { code: "CURSOR_RELEASE_FREEZE_FAILED" });
    assert.equal(await readFile(manifestPath, "utf8"), "owned existing data");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Cursor rejects an invalid freeze destination before fetching release metadata", async () => {
  for (const manifestPath of ["", null, 42]) {
    await assert.rejects(resolveLatest({ manifestPath, fetchJson: () => assert.fail("Must validate the destination first") }),
      { code: "CURSOR_RELEASE_FREEZE_FAILED" });
  }
});

test("Cursor verified Linux resolution enriches both frozen releases and leaves desktop checksums unknown", async () => {
  const bodies = Object.fromEntries(["amd64", "arm64"].map((arch) => [arch, Buffer.from(
    `Package: cursor\nVersion: ${version}-1790831722\nArchitecture: ${arch}\nFilename: pool/stable/c/cu/cursor_${version}_${arch}.deb\nSize: 200\nSHA256: ${"a".repeat(64)}\n`)]));
  const signedIndex = `Codename: stable\nArchitectures: amd64 arm64\nComponents: main\nSHA256:\n${Object.entries(bodies).map(([arch, bytes]) =>
    ` ${createHash("sha256").update(bytes).digest("hex")} ${bytes.length} main/binary-${arch}/Packages`).join("\n")}\n`;
  const calls = [];
  const aptOptions = { fetchBytes: async (url) => {
    calls.push(url);
    return url.endsWith("/InRelease") ? Buffer.from("signed fixture") : bodies[url.match(/binary-(amd64|arm64)/)[1]];
  }, verifySignature: async () => signedIndex };
  const manifest = await resolveLatest({ verifyLinux: true, fetchJson: fixtureFetch(), aptOptions });
  assert.equal(calls.length, 3);
  for (const platform of ["linux-x64", "linux-arm64"]) {
    assert.deepEqual(validateLinuxRelease(manifest.latest[platform], platform), manifest.latest[platform]);
    assert.equal(manifest.latest[platform].hashSource, "official-apt-sha256");
    assert.equal(manifest.latest[platform].debVersion, `${version}-1790831722`);
    assert.equal(manifest.latest[platform].size, 200);
  }
  for (const platform of ["darwin-arm64", "win32-x64-user"]) {
    assert.equal(manifest.latest[platform].sha256, null);
    assert.equal(manifest.latest[platform].hashSource, "not-provided");
  }
  const root = await mkdtemp(join(tmpdir(), "memorax-cursor-release-"));
  try {
    await assert.rejects(resolveLatest({ verifyLinux: true, fetchJson: fixtureFetch(), manifestPath: join(root, "manifest.json"),
      aptOptions: { ...aptOptions, verifySignature: async () => { throw new Error("untrusted signed index"); } } }),
    { code: "CURSOR_RELEASE_APT_SIGNATURE_FAILED" });
    assert.deepEqual(await readdir(root), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("Cursor official fetch is bounded, rejects redirects and sanitizes HTTP or JSON failures", async (t) => {
  const cases = [new Response("bad", { status: 503 }), new Response("invalid JSON"),
    new Response(" ".repeat(64 * 1024 + 1)), new Response(null, { status: 204 })];
  for (const response of cases) {
    t.mock.method(globalThis, "fetch", async (url, options) => {
      assert.equal(url, "https://cursor.com/api/download?platform=linux-x64&releaseTrack=stable");
      assert.equal(options.redirect, "error");
      assert.equal(options.credentials, "omit");
      assert.equal(options.cache, "no-store");
      assert.ok(options.signal instanceof AbortSignal);
      assert.equal(options.headers.Authorization, undefined);
      return response;
    });
    await assert.rejects(resolveLatest(), { code: "CURSOR_RELEASE_LINUX_X64_FETCH_FAILED" });
    t.mock.restoreAll();
  }
});

test("Cursor CLI prints a baseline descriptor and rejects invalid arguments without fallback", () => {
  const script = fileURLToPath(new URL("./cursor-app-release.mjs", import.meta.url));
  for (const platform of platforms) {
    const result = spawnSync(process.execPath, [script, "baseline", platform], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), baselineRelease(platform));
  }
  for (const args of [[], ["latest"], ["baseline"], ["baseline", "linux-x64", "extra"], ["resolve", "", "extra"], ["resolve", ""],
    ["resolve-linux"], ["resolve-linux", ""], ["resolve-linux", "path", "extra"]]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr.trim(), /^CURSOR_RELEASE_(?:ARGUMENTS_INVALID|FREEZE_FAILED)$/);
  }
});
