#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertLocalTraceOnly } from "./check-local-trace-only.mjs";
import { isAllowedNpmPackPath } from "./npm-package-layout.mjs";
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

const forbidden = /(^|\/)(?:target|test|tests|__pycache__|\.git|\.env(?:\.|$)|coverage)(?:\/|$)|\.(?:py[co]|pem|key)$/i;
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
  if (forbidden.test(path) || /(?:secret|credential|authorization|api[_-]?key)/i.test(path)) {
    throw new Error(`forbidden npm pack entry: ${path}`);
  }
}

const paths = new Set(report.files.map((entry) => String(entry.path).replaceAll("\\", "/")));
for (const requiredPath of [
  "LICENSE",
  "package.json",
  "README.md",
  "bin/memorax-code-npm-preinstall.mjs",
  "bin/memorax-code-opencode.mjs",
  "lib/client-hook-runtime.mjs",
  "lib/node-version.mjs",
  "lib/npm-invocation.mjs",
  "lib/resolve-claude-command.mjs",
  "lib/resolve-codex-command.mjs",
  "lib/vscode-extension-command.mjs",
  "lib/windows-cli-invocation.mjs",
  "lib/memorax-code-adapter-common/src/backend-connection.mjs",
  "lib/memorax-code-adapter-common/src/hooks/client-hook-launcher.mjs",
  "lib/memorax-code-adapter-common/src/clients/codex-plugin-artifact.mjs",
  "lib/memorax-code-adapter-common/src/hooks/hook-runtime-generation.mjs",
  "lib/memorax-code-adapter-common/src/memorax-defaults.mjs",
  "lib/memorax-code-adapter-common/src/runtime-record.mjs",
  "lib/memorax-code-adapter-common/src/hooks/ensure-backend-runner.mjs",
  "lib/memorax-code-adapter-common/src/windows-cli-invocation.mjs",
  "lib/memorax-code-backend/dist/server.js",
  "lib/memorax-code-backend/dist/memorax-cli.js",
  "lib/memorax-code-backend/dist/service-entrypoint.js",
  "lib/memorax-code-backend/dist/windows-cli-invocation.js",
  "lib/memorax-code-codex-adapter/skills/memorax-code/SKILL.md",
  "lib/memorax-code-codex-adapter/assets/composer-icon.png",
  "lib/memorax-code-codex-adapter/assets/logo.png",
  "lib/memorax-code-codex-adapter/hooks/runtime-hook.mjs",
  "lib/memorax-code-codex-adapter/hooks/runtime-shell.json",
  "lib/memorax-code-codex-adapter/runtime-hooks/memory-writeback.mjs",
  "lib/memorax-code-claude-adapter/skills/memorax-code/SKILL.md",
  "lib/memorax-code-claude-adapter/hooks/runtime-hook.mjs",
  "lib/memorax-code-claude-adapter/hooks/runtime-shell.json",
  "lib/memorax-code-claude-adapter/runtime-hooks/memory-turn.mjs",
  "lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/skills/memorax-code/SKILL.md",
  "lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/hooks/runtime-hook.mjs",
  "lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/hooks/runtime-shell.json",
  "lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/runtime-hooks/memory-turn.mjs",
  "lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/memorax-code-adapter-common/src/backend-connection.mjs",
  "lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/memorax-code-adapter-common/src/runtime-record.mjs",
  "lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/memorax-code-adapter-common/src/hooks/ensure-backend-runner.mjs",
  "lib/memorax-code-opencode-adapter/src/cli.mjs",
]) {
  if (!paths.has(requiredPath)) {
    throw new Error(`npm pack is missing required runtime entrypoint: ${requiredPath}`);
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
  const sourceLicense = await readFile(join(repoRoot, "LICENSE"), "utf8");
  const packedLicense = await readFile(join(extracted, "package", "LICENSE"), "utf8");
  if (packedLicense !== sourceLicense) {
    throw new Error("npm pack LICENSE does not match the repository license");
  }
  const packedManifest = JSON.parse(
    await readFile(join(extracted, "package", "package.json"), "utf8"),
  );
  if (packedManifest.engines?.node !== ">=24") {
    throw new Error("npm pack must require Node.js 24 or newer");
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
