import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { baselineRelease, parseWingetManifest, resolveFeed, resolveLatest } from "./workbuddy-release-matrix.mjs";

const execute = promisify(execFile);
const script = fileURLToPath(new URL("./workbuddy-release-matrix.mjs", import.meta.url));
const yamlModule = process.env.WORKBUDDY_YAML_MODULE;
let parseDocument;
if (yamlModule) {
  assert.ok(isAbsolute(yamlModule), "WORKBUDDY_YAML_MODULE must be an absolute module path");
  ({ parseDocument } = await import(pathToFileURL(yamlModule).href));
  assert.equal(typeof parseDocument, "function");
}
const parserOnly = { skip: !yamlModule };
const platform = "win32-x64-user";
const baseline = baselineRelease(platform);
const version = "5.7.0.40000000";
const feed = { version, productVersion: version,
  url: baseline.url.replace(baseline.desktopVersion, version), sha256hash: "" };
const hash = "A".repeat(64);
const machineInstaller = `  - Architecture: x64
    Scope: machine
    InstallerUrl: "${feed.url}"
    InstallerSha256: ${hash}
`;
const userInstaller = `  - InstallerSha256: "${hash}"
    InstallerUrl: '${feed.url}' # Exact URL, quoted independently of the other installer
    Architecture: "x64" # This entry inherits the root user scope
`;
const source = `# Reordered manifest keys and mixed quoting are valid YAML.
ManifestType: 'installer'
Scope: user
Installers:
${machineInstaller}${userInstaller}PackageVersion: "5.7.0"
PackageIdentifier: 'Tencent.WorkBuddy'
`;

test("real winget YAML parsing preserves quoted, reordered and commented installer authority", parserOnly, () => {
  const explicitUser = source.replace("Scope: user\n", "Scope: machine\n")
    .replace(userInstaller, `${userInstaller}    Scope: user\n`);
  for (const input of [source, explicitUser]) {
    const manifest = parseWingetManifest(input, parseDocument);
    assert.equal(manifest.Installers.length, 2);
    assert.deepEqual(resolveFeed(platform, feed, manifest), {
      platform, desktopVersion: version, productVersion: "5.7.0", runtimeVersion: null,
      sha256: hash.toLowerCase(), url: feed.url, channel: "latest",
    });
  }
});

test("Windows fallback resolves a real YAML manifest without bypassing its parser or installer checks", parserOnly, async () => {
  const sha = "1".repeat(40), requested = "5.8.0.42000000";
  const run = (candidate) => resolveLatest({
    parseYaml: (text) => parseWingetManifest(text, parseDocument),
    fetchText: async (url) => {
      if (url.startsWith("https://www.workbuddy.cn/")) {
        const selected = new URL(url).searchParams.get("platform").slice("workbuddy-".length);
        const release = baselineRelease(selected);
        return JSON.stringify(selected === platform ? { ...feed, version: requested, productVersion: requested,
          url: feed.url.replace(version, requested) } : { version: release.desktopVersion,
          productVersion: release.desktopVersion, url: release.url, sha256hash: release.sha256 });
      }
      if (url.endsWith("/commits/master")) return JSON.stringify({ sha });
      if (url.includes("/5.8.0/")) throw Object.assign(new Error("missing manifest"), { status: 404 });
      if (url.includes("/contents/")) return JSON.stringify([{ name: "5.7.0", type: "dir" }]);
      assert.equal(url, `https://raw.githubusercontent.com/microsoft/winget-pkgs/${sha}/manifests/t/Tencent/WorkBuddy/5.7.0/Tencent.WorkBuddy.installer.yaml`);
      return candidate;
    },
  });
  const row = (await run(source)).include.find((entry) => entry.release.channel === "fallback");
  assert.equal(row.requestedDesktopVersion, requested);
  assert.equal(row.release.desktopVersion, version);
  assert.equal(row.release.sha256, hash.toLowerCase());
  for (const invalid of [`${source}PackageIdentifier: Other\n`, source.replaceAll(hash, "invalid-hash"),
    source.replaceAll(feed.url, feed.url.replace("download.codebuddy.cn", "example.com")),
    source.replaceAll(feed.url, feed.url.replace(version, "5.6.9.39000000")),
    source.replace(userInstaller, userInstaller + userInstaller)]) {
    await assert.rejects(run(invalid), { code: "WORKBUDDY_LATEST_WIN32_X64_USER_WINGET_FALLBACK_FAILED" });
  }
});

for (const [name, input] of [
  ["duplicate keys", `${source}PackageIdentifier: 'Other.Product'\n`],
  ["multiple documents", `${source}---\nPackageIdentifier: 'Other.Product'\n`],
  ["aliases", `${source.replace("Installers:\n", "Installers: &installers\n")}OtherInstallers: *installers\n`],
  ["unknown tags", source.replace("'Tencent.WorkBuddy'", "!untrusted 'Tencent.WorkBuddy'")],
  ["malformed YAML", source.replace("Installers:\n", "Installers: [\n")],
]) {
  test(`real winget YAML parsing rejects ${name} instead of using partial data`, parserOnly, () => {
    assert.throws(() => parseWingetManifest(input, parseDocument));
  });
}

test("parsed winget data must still identify one exact x64 user installer", parserOnly, () => {
  for (const [name, input] of [
    ["package identity", source.replace("'Tencent.WorkBuddy'", "'Other.Product'")],
    ["package version", source.replace('"5.7.0"', '"5.6.2"')],
    ["manifest type", source.replace("'installer'", "'version'")],
    ["installer array", source.replace(machineInstaller + userInstaller, "")],
    ["architecture", source.replace(userInstaller, userInstaller.replace('"x64"', '"arm64"'))],
    ["installer URL", source.replace(userInstaller, userInstaller.replace(feed.url, `${feed.url}?other=1`))],
    ["installer hash", source.replace(userInstaller, userInstaller.replace(hash, "not-a-sha256"))],
    ["machine-only scope", source.replace("Scope: user\n", "Scope: machine\n")],
    ["missing scope", source.replace("Scope: user\n", "")],
    ["duplicate matching installers", source.replace(userInstaller, userInstaller + userInstaller)],
  ]) {
    const manifest = parseWingetManifest(input, parseDocument);
    assert.throws(() => resolveFeed(platform, feed, manifest), name);
  }
});

test("offline select-json works without an available optional YAML module", async () => {
  await fixture(async ({ root, run }) => {
    for (const module of [undefined, join(root, "missing-yaml.mjs")]) {
      for (const selected of ["linux-x64-deb", "darwin-arm64", "darwin-x64", platform]) {
        const result = await run(["select-json", selected], module);
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.stderr, "");
        assert.deepEqual(JSON.parse(result.stdout), baselineRelease(selected));
      }
    }
  });
});

test("offline select-json validates supplied descriptors and redacts all failure output", async () => {
  await fixture(async ({ root, run }) => {
    const secret = "PRIVATE_DESCRIPTOR_SECRET_DO_NOT_PRINT";
    const failureMessage = "WORKBUDDY_RELEASE_RESOLUTION_FAILED: release metadata, checksum or parser validation failed; no unverified version fallback.\n";
    const path = join(root, `${secret}.json`);
    await writeFile(path, JSON.stringify(baseline));
    const selected = await run(["select-json", platform, path]);
    assert.equal(selected.code, 0, selected.stderr);
    assert.deepEqual(JSON.parse(selected.stdout), baseline);
    for (const raw of [`{ "private": "${secret}"`, JSON.stringify({ ...baseline, url: `https://example.com/${secret}` }),
      JSON.stringify({ ...baseline, sha256: secret }), "null"]) {
      await writeFile(path, raw);
      const result = await run(["select-json", platform, path], join(root, "missing-yaml.mjs"));
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, failureMessage);
      for (const privateValue of [secret, path, root, raw]) assert.equal(result.stderr.includes(privateValue), false);
    }
    const emptyPath = await run(["select-json", platform, ""]);
    assert.equal(emptyPath.code, 1);
    assert.equal(emptyPath.stdout, "");
    assert.equal(emptyPath.stderr, failureMessage);
  });
});

async function fixture(callback) {
  const root = await mkdtemp(join(tmpdir(), "workbuddy-winget-parser-"));
  try {
    const home = join(root, "home"), temporary = join(root, "tmp");
    await mkdir(home);
    await mkdir(temporary);
    const env = { PATH: dirname(process.execPath), HOME: home, USERPROFILE: home,
      TMPDIR: temporary, TMP: temporary, TEMP: temporary, MEMORAX_CODE_HOME: join(root, "state") };
    for (const name of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
      if (process.env[name]) env[name] = process.env[name];
    }
    const run = async (args, module) => {
      const childEnv = { ...env, ...(module === undefined ? {} : { WORKBUDDY_YAML_MODULE: module }) };
      try { return { code: 0, ...await execute(process.execPath, [script, ...args],
        { cwd: root, env: childEnv, timeout: 10_000, maxBuffer: 64 * 1024 }) }; }
      catch (error) {
        if (typeof error.code !== "number") throw error;
        return { code: error.code, stdout: error.stdout, stderr: error.stderr };
      }
    };
    await callback({ root, run });
  } finally { await rm(root, { recursive: true, force: true }); }
}
