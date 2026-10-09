#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertLocalTraceOnly } from "./check-local-trace-only.mjs";
import {
  assertRequiredNpmPackageFiles,
  isAllowedNpmPackFilePath,
  isAllowedNpmPackPath,
} from "./npm-package-layout.mjs";
import { loadUndeclaredNpmPackPaths } from "./npm-source-files.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [reportPath] = process.argv.slice(2);
if (!reportPath) {
  throw new Error("usage: node scripts/validate-npm-pack-json.mjs PACK_JSON");
}

const raw = (await readFile(reportPath, "utf8")).replace(/^\uFEFF/, "");
const reports = JSON.parse(raw);
const report = Array.isArray(reports) ? reports[0] : undefined;
if (!report || !Array.isArray(report.files)) {
  throw new Error("npm pack JSON did not contain file entries");
}
const tarballFilename = String(report.filename ?? "");
if (
  !tarballFilename
  || basename(tarballFilename) !== tarballFilename
  || !tarballFilename.endsWith(".tgz")
) {
  throw new Error(`npm pack JSON did not contain a safe tarball filename: ${tarballFilename || "<empty>"}`);
}

const forbidden = /(^|\/)(?:target|test|tests|__pycache__|\.git|\.env(?:\.|$)|coverage)(?:\/|$)|\.(?:py[co]?|pem|key)$/i;
const undeclaredWorkspacePaths = loadUndeclaredNpmPackPaths(repoRoot);

for (const entry of report.files) {
  const path = String(entry?.path ?? "").replaceAll("\\", "/");
  if (!path || path.startsWith("/") || /^[A-Za-z]:\//.test(path) || path.includes("../")) {
    throw new Error(`invalid npm pack path: ${path || "<empty>"}`);
  }
  if (!isAllowedNpmPackPath(path)) {
    throw new Error(`undeclared npm pack entry: ${path}`);
  }
  if (undeclaredWorkspacePaths.has(path)) {
    throw new Error(
      `npm pack contains untracked workspace source ${undeclaredWorkspacePaths.get(path)} as ${path}`,
    );
  }
  if (forbidden.test(path) || !isAllowedNpmPackFilePath(path)) {
    throw new Error(`forbidden npm pack entry: ${path}`);
  }
}

const tarballPath = join(dirname(resolve(reportPath)), "tarballs", tarballFilename);
if (!(await stat(tarballPath).catch(() => undefined))?.isFile()) {
  throw new Error(`npm pack tarball is missing: ${tarballPath}`);
}
const extracted = await mkdtemp(join(tmpdir(), "memorax-code-npm-pack-validation-"));
try {
  const unpacked = spawnSync(
    "tar",
    ["-xzf", tarballPath, "-C", extracted],
    {
      encoding: "utf8",
      timeout: 30_000,
      killSignal: "SIGKILL",
    },
  );
  if (unpacked.status !== 0 || unpacked.error) {
    throw new Error(
      unpacked.stderr?.trim()
      || unpacked.error?.message
      || `tar exited with status ${unpacked.status ?? "unknown"}`,
    );
  }
  await assertRequiredNpmPackageFiles(join(extracted, "package"));
  const sourceLicense = await readFile(join(repoRoot, "LICENSE"), "utf8");
  const packedLicense = await readFile(join(extracted, "package", "LICENSE"), "utf8");
  if (packedLicense !== sourceLicense) {
    throw new Error("npm pack LICENSE does not match the repository license");
  }
  const packedManifest = JSON.parse(
    await readFile(join(extracted, "package", "package.json"), "utf8"),
  );
  if (packedManifest.engines?.node !== ">=20") {
    throw new Error("npm pack must require Node.js 20 or newer");
  }
  const packedDshSkill = await readFile(
    join(extracted, "package", "lib/memorax-code-dsh-adapter/skills/memorax-code/SKILL.md"),
    "utf8",
  );
  const canonicalSkill = await readFile(
    join(repoRoot, "packages/ts/memorax-code-codex-adapter/skills/memorax-code/SKILL.md"),
    "utf8",
  );
  if (packedDshSkill !== canonicalSkill) {
    throw new Error("npm pack DSH skill must remain byte-identical to the canonical skill");
  }
  const packedTraeSkill = await readFile(
    join(extracted, "package", "lib/memorax-code-trae-adapter/skills/memorax-code/SKILL.md"),
    "utf8",
  );
  if (packedTraeSkill !== canonicalSkill) {
    throw new Error("npm pack Trae skill must remain byte-identical to the canonical skill");
  }
  const packedCursorSkill = await readFile(
    join(extracted, "package", "lib/memorax-code-cursor-adapter/skills/memorax-code/SKILL.md"),
    "utf8",
  );
  if (packedCursorSkill !== canonicalSkill) {
    throw new Error("npm pack Cursor skill must remain byte-identical to the canonical skill");
  }
  await assertLocalTraceOnly({
    repoRoot,
    artifactRoots: [extracted],
    includeSource: false,
  });
} finally {
  await rm(extracted, { recursive: true, force: true });
}

console.log(`npm pack entries passed allowlist validation (${report.files.length} files)`);
