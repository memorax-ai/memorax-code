#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const RELEASE_VERSION_AUTHORITY = Object.freeze({
  file: "packages/npm/memorax-code/package.json",
  field: ["version"],
});

export const RELEASE_VERSION_TARGETS = Object.freeze([
  { file: "packages/ts/memorax-code-backend/package.json", field: ["version"] },
  { file: "packages/ts/memorax-code-backend/package-lock.json", field: ["version"] },
  { file: "packages/ts/memorax-code-backend/package-lock.json", field: ["packages", "", "version"] },
  { file: "packages/ts/memorax-code-codex-adapter/package.json", field: ["version"] },
  { file: "packages/ts/memorax-code-codex-adapter/.codex-plugin/plugin.json", field: ["version"] },
  { file: "packages/ts/memorax-code-codex-adapter/hooks/runtime-shell.json", field: ["shellVersion"] },
  { file: "packages/ts/memorax-code-claude-adapter/package.json", field: ["version"] },
  { file: "packages/ts/memorax-code-claude-adapter/.claude-plugin/plugin.json", field: ["version"] },
  { file: "packages/ts/memorax-code-claude-adapter/hooks/runtime-shell.json", field: ["shellVersion"] },
  { file: "packages/ts/memorax-code-dsh-adapter/package.json", field: ["version"] },
  { file: "packages/ts/memorax-code-opencode-adapter/package.json", field: ["version"] },
]);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export async function syncReleaseVersion({ root = REPO_ROOT, write = false } = {}) {
  const documents = new Map();
  const load = async (file) => {
    if (!documents.has(file)) {
      documents.set(file, JSON.parse(await readFile(resolve(root, file), "utf8")));
    }
    return documents.get(file);
  };
  const authority = await load(RELEASE_VERSION_AUTHORITY.file);
  const version = fieldValue(authority, RELEASE_VERSION_AUTHORITY);
  if (typeof version !== "string" || !SEMVER.test(version)) {
    throw new Error(`${RELEASE_VERSION_AUTHORITY.file} has an invalid release version`);
  }

  const mismatches = [];
  const changedFiles = new Set();
  for (const target of RELEASE_VERSION_TARGETS) {
    const document = await load(target.file);
    const actual = fieldValue(document, target);
    if (actual === version) continue;
    mismatches.push({ ...target, actual, expected: version });
    if (write) {
      setFieldValue(document, target, version);
      changedFiles.add(target.file);
    }
  }
  for (const file of changedFiles) {
    await writeFile(resolve(root, file), `${JSON.stringify(documents.get(file), null, 2)}\n`, "utf8");
  }
  return { ok: write || mismatches.length === 0, version, mismatches, changedFiles: [...changedFiles] };
}

function fieldValue(document, target) {
  let current = document;
  for (const key of target.field) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) {
      throw new Error(`${target.file} is missing ${target.field.join(".")}`);
    }
    current = current[key];
  }
  return current;
}

function setFieldValue(document, target, value) {
  let current = document;
  for (const key of target.field.slice(0, -1)) current = current[key];
  current[target.field.at(-1)] = value;
}

async function main() {
  const mode = process.argv[2] ?? "--check";
  if (!["--check", "--write"].includes(mode) || process.argv.length > 3) {
    throw new Error("usage: node scripts/sync-release-version.mjs [--check|--write]");
  }
  const result = await syncReleaseVersion({ write: mode === "--write" });
  if (!result.ok) {
    for (const mismatch of result.mismatches) {
      console.error(`${mismatch.file}:${mismatch.field.join(".")} is ${JSON.stringify(mismatch.actual)}; expected ${result.version}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(mode === "--write"
    ? `release version ${result.version}: updated ${result.changedFiles.length} file(s)`
    : `release version ${result.version}: all targets match`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
