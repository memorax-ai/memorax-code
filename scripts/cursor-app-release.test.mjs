import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { baselineRelease, downloadDesktopArtifact, resolveDownload, resolveLatest, validateDesktopRelease,
  validateLinuxRelease } from "./cursor-app-release.mjs";

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

test("baseline provenance remains pinned and latest never promotes unverified checksum fields", async () => {
  const { cursor } = JSON.parse(await readFile(new URL("./fixtures/cursor-app/provenance.json", import.meta.url), "utf8"));
  for (const platform of platforms) {
    const baseline = baselineRelease(platform);
    const pin = cursor[platform === "linux-x64" ? "amd64" : platform === "linux-arm64" ? "arm64" : ""];
    assert.equal(baseline.version, "3.21.18");
    assert.equal(baseline.commitSha, "c4730f7d93d787d9ab120af715999f0345ee5bc5");
    assert.equal(baseline.channel, "baseline");
    assert.equal(baseline.sha256, pin?.sha256 ?? null);
    assert.equal(baseline.hashSource, pin ? "observed-sha256" : "not-provided");
    if (pin) {
      assert.equal(baseline.url, pin.url);
      assert.equal(baseline.debVersion, pin.debVersion);
    }
    const input = metadata(platform, { sha256: "a".repeat(64), hashSource: "publisher-signed", rehUrl: "https://untrusted.invalid" });
    const latest = resolveDownload(platform, input);
    assert.deepEqual(latest, { platform, version, commitSha, channel: "latest",
      url: input.debUrl ?? input.downloadUrl, sha256: null, hashSource: "not-provided" });
    assert.ok(Object.isFrozen(baseline) && Object.isFrozen(latest));
    const key = platform.startsWith("linux-") ? "debUrl" : "downloadUrl";
    assert.deepEqual(resolveDownload(platform, { version: baseline.version, commitSha: baseline.commitSha, [key]: baseline.url }),
      { ...baseline, channel: "latest" });
    const changed = resolveDownload(platform, { version: baseline.version, commitSha, [key]: baseline.url.replace(baseline.commitSha, commitSha) });
    assert.equal(changed.sha256, null);
  }
  for (const platform of ["linux-x64-deb", "darwin-x64", "win32-x64-archive", "toString", undefined]) {
    assert.throws(() => baselineRelease(platform), { code: "CURSOR_RELEASE_PLATFORM_INVALID" });
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

test("release resolution freezes all four feeds atomically and rejects incoherent or partial manifests", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-cursor-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifestPath = join(root, "release.json"), calls = [];
  const manifest = await resolveLatest({ fetchJson: fixtureFetch(calls), manifestPath });
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(calls.length, 4);
  assert.equal(new Set(calls).size, 4);
  for (const platform of platforms) {
    assert.deepEqual(manifest.baseline[platform], baselineRelease(platform));
    assert.deepEqual(manifest.latest[platform], resolveDownload(platform, metadata(platform)));
  }
  assert.ok(Object.isFrozen(manifest) && Object.isFrozen(manifest.latest) && Object.isFrozen(manifest.baseline));
  assert.deepEqual(JSON.parse(await readFile(manifestPath, "utf8")), manifest);
  await writeFile(manifestPath, "existing data");
  await assert.rejects(resolveLatest({ fetchJson: fixtureFetch(), manifestPath }), { code: "CURSOR_RELEASE_FREEZE_FAILED" });
  assert.equal(await readFile(manifestPath, "utf8"), "existing data");
  await rm(manifestPath);
  for (const fetchJson of [async () => { throw new Error("private response"); }, async () => ({ version: "bad" })]) {
    await assert.rejects(resolveLatest({ fetchJson, manifestPath }), (error) => {
      assert.match(error.code, /^CURSOR_RELEASE_LINUX_X64_(?:FETCH_FAILED|METADATA_INVALID)$/);
      assert.equal(error.message, error.code);
      return true;
    });
    assert.deepEqual(await readdir(root), []);
  }
  for (const changes of [{ version: "3.23.13" }, { commitSha: "3".repeat(40) }]) {
    await assert.rejects(resolveLatest({ manifestPath, fetchJson: async (url) => {
      const platform = new URL(url).searchParams.get("platform"), input = metadata(platform);
      if (platform !== "darwin-arm64") return input;
      return { ...input, ...changes,
        downloadUrl: changes.commitSha ? input.downloadUrl.replace(commitSha, changes.commitSha) : input.downloadUrl };
    } }), { code: "CURSOR_RELEASE_LATEST_INCOHERENT" });
    assert.deepEqual(await readdir(root), []);
  }
  for (const manifestPath of ["", null, 42]) {
    await assert.rejects(resolveLatest({ manifestPath, fetchJson: () => assert.fail("destination must be validated first") }),
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

test("desktop descriptors retain exact frozen provenance for both channels", () => {
  for (const platform of ["darwin-arm64", "win32-x64-user"]) {
    for (const selected of [baselineRelease(platform), resolveDownload(platform, metadata(platform))]) {
      assert.deepEqual(validateDesktopRelease(selected, platform), selected);
      assert.ok(Object.isFrozen(validateDesktopRelease(selected, platform)));
      for (const change of [{ channel: "unknown" }, { platform: "linux-x64" }, { sha256: "a".repeat(64) },
        { hashSource: "observed-sha256" }, { url: selected.url + "?x" }]) {
        assert.throws(() => validateDesktopRelease({ ...selected, ...change }, platform));
      }
    }
    const latest = resolveDownload(platform, metadata(platform));
    assert.throws(() => validateDesktopRelease({ ...latest, channel: "baseline" }, platform));
  }
});

test("desktop downloads bound both declared and streamed bytes and preserve abort versus validation errors", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cursor-download-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const release = baselineRelease("darwin-arm64"), bytes = Buffer.from("synthetic image");
  const failure = (code) => Object.assign(new Error(code), { code });
  const oversized = new Uint8Array(1);
  Object.defineProperty(oversized, "byteLength", { value: 600_000_001 });
  let index = 0;
  for (const [response, expected] of [
    [{}, undefined], [{ headers: new Headers() }, undefined],
    ...[{ status: 302 }, { status: 206 }, { status: 500 }, { redirected: true }, { url: release.url + "?x" },
      { body: null }, { body: ["not bytes"] }].map((value) => [value, "DOWNLOAD"]),
    ...["0", "-1", "01", "1.5", "600000001", String(bytes.length + 1)]
      .map((length) => [{ headers: new Headers({ "content-length": length }) }, "DOWNLOAD_SIZE"]),
    [{ headers: new Headers(), body: [] }, "DOWNLOAD_SIZE"],
    [{ headers: new Headers(), body: [oversized] }, "DOWNLOAD_SIZE"],
    [{ body: (async function* () { yield bytes; throw new Error("private"); })() }, "DOWNLOAD"],
  ]) {
    const path = join(root, String(index++));
    const result = downloadDesktopArtifact(release, path, async (url, options) => {
      assert.equal(url, release.url);
      assert.equal(options.redirect, "error");
      assert.equal(options.credentials, "omit");
      assert.equal(options.cache, "no-store");
      assert.ok(options.signal instanceof AbortSignal);
      return { status: 200, redirected: false, url, headers: new Headers({ "content-length": String(bytes.length) }),
        body: [bytes.subarray(0, 4), bytes.subarray(4)], ...response };
    }, undefined, failure);
    if (expected) await assert.rejects(result, { code: expected, message: expected });
    else {
      assert.deepEqual(await result, { bytes: bytes.length, observedSha256: createHash("sha256").update(bytes).digest("hex") });
      assert.deepEqual(await readFile(path), bytes);
    }
  }
  await assert.rejects(downloadDesktopArtifact(release, join(root, "failed"), async () => { throw new Error("private"); },
    undefined, failure), { code: "DOWNLOAD" });
  const controller = new AbortController();
  await assert.rejects(downloadDesktopArtifact(release, join(root, "aborted"), async () => {
    controller.abort();
    throw new Error("private");
  }, controller.signal, failure), { code: "ABORTED" });
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
