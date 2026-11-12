import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertSafeNpmStagingRemoval,
  resolveSafeNpmStagingOutDir,
} from "../../../../scripts/npm-staging-paths.mjs";

test("npm staging output validation accepts only POSIX dist descendants", () => {
  const options = { repoRoot: "/work/memorax-code", platform: "linux" };
  assert.equal(resolveSafeNpmStagingOutDir(options), "/work/memorax-code/dist/npm");
  assert.equal(
    resolveSafeNpmStagingOutDir({ ...options, outDir: "dist/npm/package" }),
    "/work/memorax-code/dist/npm/package",
  );
  for (const outDir of [
    "/",
    "/work",
    "/work/memorax-code",
    "/work/memorax-code/dist",
    ".",
    "..",
    "../sibling",
    "dist/..",
    "dist/../../sibling",
    "/tmp/npm",
  ]) {
    assert.throws(
      () => resolveSafeNpmStagingOutDir({ ...options, outDir }),
      /descendant of the repository dist directory/,
      outDir,
    );
  }
});

test("npm staging removal rejects a native directory link ancestor", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-staging-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "memorax-code-staging-outside-"));
  try {
    await mkdir(join(root, "dist"));
    await symlink(outside, join(root, "dist", "npm"), process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
      assertSafeNpmStagingRemoval({
        repoRoot: root,
        outDir: "dist/npm/output",
        platform: process.platform,
      }),
      /symlink or junction/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("npm staging removal rejects injected Windows junction semantics", async () => {
  const existing = new Set([
    "C:\\work\\memorax-code",
    "C:\\work\\memorax-code\\dist",
    "C:\\work\\memorax-code\\dist\\npm",
  ]);
  await assert.rejects(
    assertSafeNpmStagingRemoval({
      repoRoot: "C:\\work\\memorax-code",
      outDir: "dist\\npm\\output",
      platform: "win32",
      operations: {
        lstat: async (path) => {
          if (!existing.has(path)) {
            throw Object.assign(new Error("missing"), { code: "ENOENT" });
          }
          return { isSymbolicLink: () => path.endsWith("\\npm") };
        },
        realpath: async (path) => path,
      },
    }),
    /symlink or junction/,
  );
});

test("npm staging output validation accepts only Windows dist descendants", () => {
  const options = { repoRoot: "C:\\work\\memorax-code", platform: "win32" };
  assert.equal(resolveSafeNpmStagingOutDir(options), "C:\\work\\memorax-code\\dist\\npm");
  assert.equal(
    resolveSafeNpmStagingOutDir({ ...options, outDir: "dist\\npm\\package" }),
    "C:\\work\\memorax-code\\dist\\npm\\package",
  );
  for (const outDir of [
    "C:\\",
    "C:\\work",
    "C:\\work\\memorax-code",
    "C:\\work\\memorax-code\\dist",
    ".",
    "..",
    "..\\sibling",
    "dist\\..",
    "dist\\..\\..\\sibling",
    "D:\\dist\\npm",
  ]) {
    assert.throws(
      () => resolveSafeNpmStagingOutDir({ ...options, outDir }),
      /descendant of the repository dist directory/,
      outDir,
    );
  }
});
