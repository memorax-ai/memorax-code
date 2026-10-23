import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createPreviewUpgradeBaseline } from "./preview-upgrade-baseline.mjs";

const run = promisify(execFile);
const npmCli = [process.env.npm_execpath, join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
  resolve(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js")].find((path) => path && existsSync(path));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "preview-baseline-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "source");
  const packageRoot = join(directory, "package");
  await mkdir(packageRoot, { recursive: true });
  const manifest = { name: "@memorax/memorax-code", version: "0.1.18",
    files: ["payload.txt"], scripts: { prepack: "node -e \"process.exit(63)\"" },
    memoraxFixture: { componentVersion: "0.1.18" } };
  await writeFile(join(packageRoot, "package.json"), JSON.stringify(manifest));
  await writeFile(join(packageRoot, "payload.txt"), "Historical component content.\n");
  const source = join(root, "source.tgz");
  await run("tar", ["-czf", source, "-C", directory, "package"]);
  const bytes = await readFile(source);
  const metadata = { name: manifest.name, version: manifest.version, dist: {
    tarball: "https://registry.npmjs.org/@memorax/memorax-code/-/memorax-code-0.1.18.tgz",
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  } };
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url: String(url), options });
    return requests.length === 1 ? { status: 200, json: async () => metadata }
      : { status: 200, arrayBuffer: async () => bytes };
  };
  const userHome = join(root, "home");
  await mkdir(userHome);
  const env = { PATH: process.env.PATH, HOME: userHome, USERPROFILE: userHome,
    npm_config_cache: join(root, "cache"), npm_config_userconfig: join(root, "empty.npmrc"),
    npm_config_globalconfig: join(root, "empty-global.npmrc") };
  for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) if (process.env[key]) env[key] = process.env[key];
  const runNpm = (args) => {
    assert.ok(npmCli, "npm CLI JavaScript entrypoint is required for fixture packing");
    return run(process.execPath, [npmCli, ...args], { env, cwd: root, encoding: "utf8", timeout: 60_000 });
  };
  return { root, manifest, metadata, bytes, requests, fetchImpl, runNpm };
}

test("synthetic preview baseline preserves historical contents and reports its exact source and output", async (t) => {
  const input = await fixture(t);
  const { tarball, record } = await createPreviewUpgradeBaseline({ directory: join(input.root, "baseline"),
    version: "0.1.18", fetchImpl: input.fetchImpl, runNpm: input.runNpm });
  const packed = JSON.parse((await run("tar", ["-xOzf", tarball, "package/package.json"], { encoding: "utf8" })).stdout);
  assert.deepEqual(packed, { ...input.manifest, name: "@memorax/memorax-code-preview" });
  assert.equal((await run("tar", ["-xOzf", tarball, "package/payload.txt"], { encoding: "utf8" })).stdout,
    "Historical component content.\n");
  assert.deepEqual(record, { kind: "synthetic-preview-baseline", sourcePackage: input.manifest.name, version: "0.1.18",
    sourceIntegrity: input.metadata.dist.integrity, sourceSha256: createHash("sha256").update(input.bytes).digest("hex"),
    packageName: "@memorax/memorax-code-preview", sha256: createHash("sha256").update(await readFile(tarball)).digest("hex"),
    changes: ["outer-package-name"],
    limitation: "This fixture is not a published preview release; it does not establish an upgrade from a released preview." });
  assert.equal(input.requests[0].url, "https://registry.npmjs.org/%40memorax%2Fmemorax-code/0.1.18");
  assert.equal(input.requests[1].options.redirect, "error");
});

for (const [label, change, code] of [
  ["wrong source name", (metadata) => { metadata.name = "@memorax/memorax-code-preview"; }, "PREVIEW_BASELINE_SOURCE_IDENTITY"],
  ["wrong version", (metadata) => { metadata.version = "0.1.19"; }, "PREVIEW_BASELINE_SOURCE_VERSION"],
  ["external origin", (metadata) => { metadata.dist.tarball = "https://example.invalid/source.tgz"; }, "PREVIEW_BASELINE_SOURCE_ORIGIN"],
  ["missing integrity", (metadata) => { delete metadata.dist.integrity; }, "PREVIEW_BASELINE_INTEGRITY_REQUIRED"],
  ["corrupted bytes", (metadata) => { metadata.dist.integrity = `sha512-${Buffer.alloc(64).toString("base64")}`; }, "PREVIEW_BASELINE_INTEGRITY_MISMATCH"],
]) {
  test("synthetic baseline rejects " + label + " before npm packing", async (t) => {
    const input = await fixture(t);
    change(input.metadata);
    await assert.rejects(createPreviewUpgradeBaseline({ directory: join(input.root, "baseline"),
      version: "0.1.18", fetchImpl: input.fetchImpl,
      runNpm: () => { throw new Error("UNEXPECTED_NPM_INVOCATION"); } }), new RegExp(code));
    assert.equal(existsSync(join(input.root, "baseline")), false);
  });
}

test("synthetic baseline rejects a missing published source instead of pretending it is a preview release", async (t) => {
  const input = await fixture(t);
  await assert.rejects(createPreviewUpgradeBaseline({ directory: join(input.root, "baseline"), version: "0.1.18",
    fetchImpl: async () => ({ status: 404 }), runNpm: () => { throw new Error("UNEXPECTED_NPM_INVOCATION"); } }),
  /PREVIEW_BASELINE_MANIFEST_UNAVAILABLE/);
});
