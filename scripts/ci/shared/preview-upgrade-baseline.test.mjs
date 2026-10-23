import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, win32 } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createPreviewUpgradeBaseline, extractPreviewBaseline } from "./preview-upgrade-baseline.mjs";

const run = promisify(execFile);
const npmCli = [process.env.npm_execpath, join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
  resolve(dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js")].find((path) => path && existsSync(path));

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "preview baseline 空间-"));
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
  await run("tar", ["-czf", "source.tgz", "-C", "source", "package"], { cwd: root });
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
  const packed = JSON.parse((await run("tar", ["-xOzf", basename(tarball), "package/package.json"], { cwd: dirname(tarball), encoding: "utf8" })).stdout);
  assert.deepEqual(packed, { ...input.manifest, name: "@memorax/memorax-code-preview" });
  assert.equal((await run("tar", ["-xOzf", basename(tarball), "package/payload.txt"], { cwd: dirname(tarball), encoding: "utf8" })).stdout,
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

test("baseline extraction keeps Windows drive letters and Unicode outside tar operands", async () => {
  for (const directory of ["C:\\preview fixture\\空间", "D:\\a\\_temp\\preview baseline"]) {
    let calls = 0;
    await extractPreviewBaseline(directory, async (command, args, options) => {
      calls += 1;
      assert.equal(command, "tar");
      assert.equal(options.cwd, directory);
      const archive = args[args.indexOf("-xzf") + 1], destination = args[args.indexOf("-C") + 1];
      // GNU tar treats a colon in the archive operand as remote-host syntax.
      assert.ok(!archive.includes(":"));
      assert.equal(win32.isAbsolute(archive), false);
      assert.equal(win32.isAbsolute(destination), false);
      assert.equal(options.windowsHide, true);
      assert.ok(options.timeout > 0);
    });
    assert.equal(calls, 1);
  }
});

test("baseline extraction identifies its failure without returning private command output", async () => {
  for (const code of [2, "ENOENT", "ETIMEDOUT", "PRIVATE_UNKNOWN_CODE"]) {
    await assert.rejects(extractPreviewBaseline("D:\\private fixture", async () => {
      throw Object.assign(new Error("private path and output"), { code, stdout: "private stdout", stderr: "private stderr" });
    }), (error) => {
      assert.equal(error.message, "INSTALL_PREVIEW_BASELINE_EXTRACT_FAILED");
      assert.equal(error.diagnosticCode, "INSTALL_PREVIEW_BASELINE_EXTRACT_FAILED");
      assert.equal(error.code, code === "PRIVATE_UNKNOWN_CODE" ? undefined : code);
      assert.equal(error.stdout, undefined);
      assert.equal(error.stderr, undefined);
      assert.ok(!error.stack.includes("private path"));
      return true;
    });
  }
});
