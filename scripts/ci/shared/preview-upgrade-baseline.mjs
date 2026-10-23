// A preview package has no published upgrade baseline yet. Build an explicitly synthetic
// fixture from a fixed published formal package; only its outer npm identity changes.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SOURCE_NAME = "@memorax/memorax-code";
const TARGET_NAME = "@memorax/memorax-code-preview";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const options = { encoding: "utf8", timeout: 60_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true };

export async function createPreviewUpgradeBaseline({ directory, version, runNpm, fetchImpl = fetch }) {
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  const response = await fetchImpl(
    `https://registry.npmjs.org/${encodeURIComponent(SOURCE_NAME)}/${version}`,
    { signal: AbortSignal.timeout(60_000), headers: { accept: "application/json" } },
  );
  assert.equal(response.status, 200, "PREVIEW_BASELINE_MANIFEST_UNAVAILABLE");
  const metadata = await response.json();
  assert.equal(metadata.name, SOURCE_NAME, "PREVIEW_BASELINE_SOURCE_IDENTITY");
  assert.equal(metadata.version, version, "PREVIEW_BASELINE_SOURCE_VERSION");
  const url = new URL(metadata.dist?.tarball);
  assert.equal(url.origin, "https://registry.npmjs.org", "PREVIEW_BASELINE_SOURCE_ORIGIN");
  assert.equal(url.username + url.password, "", "PREVIEW_BASELINE_SOURCE_CREDENTIALS");
  assert.match(metadata.dist?.integrity ?? "", /^sha512-[A-Za-z0-9+/]+={0,2}$/, "PREVIEW_BASELINE_INTEGRITY_REQUIRED");
  const artifact = await fetchImpl(url, { signal: AbortSignal.timeout(60_000), redirect: "error" });
  assert.equal(artifact.status, 200, "PREVIEW_BASELINE_ARTIFACT_UNAVAILABLE");
  const bytes = Buffer.from(await artifact.arrayBuffer());
  assert.equal(`sha512-${createHash("sha512").update(bytes).digest("base64")}`, metadata.dist.integrity,
    "PREVIEW_BASELINE_INTEGRITY_MISMATCH");
  await mkdir(directory, { recursive: false });
  const source = join(directory, "published-source.tgz");
  await writeFile(source, bytes);
  const extract = join(directory, "extracted");
  await mkdir(extract);
  await execFileAsync("tar", ["-xzf", source, "-C", extract], options);
  const packageRoot = join(extract, "package");
  const manifestPath = join(packageRoot, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.name, SOURCE_NAME, "PREVIEW_BASELINE_PACKED_IDENTITY");
  assert.equal(manifest.version, version, "PREVIEW_BASELINE_PACKED_VERSION");
  manifest.name = TARGET_NAME;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  // Use the runner's isolated npm invocation and never execute publication scripts.
  const packed = await runNpm(["pack", packageRoot, "--ignore-scripts", "--json", "--pack-destination", directory]);
  const records = JSON.parse(packed.stdout);
  const filename = `memorax-memorax-code-preview-${version}.tgz`;
  assert.equal(records.length, 1, "PREVIEW_BASELINE_PACK_RESULT");
  assert.equal(records[0].filename, filename, "PREVIEW_BASELINE_PACK_FILENAME");
  assert.equal(records[0].name, TARGET_NAME, "PREVIEW_BASELINE_PACK_IDENTITY");
  assert.equal(records[0].version, version, "PREVIEW_BASELINE_PACK_VERSION");
  const tarball = join(directory, filename);
  const record = { kind: "synthetic-preview-baseline", sourcePackage: SOURCE_NAME, version,
    sourceIntegrity: metadata.dist.integrity, sourceSha256: sha256(bytes),
    packageName: TARGET_NAME, sha256: sha256(await readFile(tarball)), changes: ["outer-package-name"],
    limitation: "This fixture is not a published preview release; it does not establish an upgrade from a released preview." };
  return { tarball, record };
}
