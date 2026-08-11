#!/usr/bin/env node
import {
  chmod,
  cp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildClaudeMarketplace } from "../packages/ts/memorax-code-claude-adapter/scripts/build-marketplace.mjs";
import { assertLocalTraceOnly } from "./check-local-trace-only.mjs";
import { isAllowedNpmPackPath } from "./npm-package-layout.mjs";
import { npmShippedDocs } from "./npm-shipped-docs.mjs";
import {
  assertDeclaredNpmSource,
  copyDeclaredNpmSourceTree,
  loadDeclaredNpmSourceFiles,
  npmMainSourceTrees,
} from "./npm-source-files.mjs";
import {
  assertSafeNpmStagingRemoval,
  resolveSafeNpmStagingOutDir,
} from "./npm-staging-paths.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const options = parseArgs(process.argv.slice(2));

if (options.help) {
  console.log([
    "Usage: node scripts/build-npm-packages.mjs [--out-dir DIR]",
    "",
    "The Backend must already be built. DIR must be a descendant of repository dist/.",
  ].join("\n"));
  process.exit(0);
}

const outDir = resolveSafeNpmStagingOutDir({ repoRoot, outDir: options.outDir });
const backendDist = join(repoRoot, "packages/ts/memorax-code-backend/dist");
if (!(await stat(backendDist).catch(() => undefined))?.isDirectory()) {
  throw new Error("Backend dist is missing; run npm run build --prefix packages/ts/memorax-code-backend first");
}

const declaredSourceFiles = loadDeclaredNpmSourceFiles(repoRoot);
await assertLocalTraceOnly({ repoRoot });
await validateSourceManifest();
await assertSafeNpmStagingRemoval({ repoRoot, outDir });
await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

const mainPackage = join(outDir, "memorax-code");
await stageMainPackage(mainPackage);
await validateStaging(mainPackage);
await assertLocalTraceOnly({
  repoRoot,
  artifactRoots: [mainPackage],
  includeSource: false,
});

console.log(`npm package staging written to ${relative(repoRoot, outDir) || outDir}`);

async function stageMainPackage(destination) {
  for (const path of [
    "bin",
    "docs",
    "lib/memorax-code-adapter-common",
    "lib/memorax-code-codex-adapter",
    "lib/memorax-code-claude-adapter",
    "lib/memorax-code-opencode-adapter",
  ]) {
    await mkdir(join(destination, path), { recursive: true });
  }

  await copyFile("packages/npm/memorax-code/package.json", join(destination, "package.json"));
  await copyFile("LICENSE", join(destination, "LICENSE"));
  await copyFile("packages/npm/memorax-code/README.md", join(destination, "README.md"));
  for (const name of npmShippedDocs) {
    await copyFile(`docs/${name}`, join(destination, "docs", name));
  }
  for (const mapping of npmMainSourceTrees) {
    await copyTree(mapping.source, join(destination, mapping.destination));
  }
  await copyGeneratedTree(
    "packages/ts/memorax-code-backend/dist",
    join(destination, "lib/memorax-code-backend/dist"),
  );
  await copyFile(
    "packages/ts/memorax-code-backend/package.json",
    join(destination, "lib/memorax-code-backend/package.json"),
  );
  await copyFile(
    "packages/ts/memorax-code-codex-adapter/package.json",
    join(destination, "lib/memorax-code-codex-adapter/package.json"),
  );
  await copyFile(
    "packages/ts/memorax-code-claude-adapter/package.json",
    join(destination, "lib/memorax-code-claude-adapter/package.json"),
  );
  await copyFile(
    "packages/ts/memorax-code-opencode-adapter/package.json",
    join(destination, "lib/memorax-code-opencode-adapter/package.json"),
  );

  await buildClaudeMarketplace({
    outputDir: join(destination, "lib/memorax-code-claude-marketplace"),
    adapterRoot: join(destination, "lib/memorax-code-claude-adapter"),
  });

  await removeMatching(
    destination,
    (path, entry) => entry.name === "__pycache__" || /\.py[co]$/.test(path),
  );
  if (process.platform !== "win32") {
    for (const name of await readdir(join(destination, "bin"))) {
      if (name.endsWith(".mjs")) await chmod(join(destination, "bin", name), 0o755);
    }
  }
}

async function validateSourceManifest() {
  const manifest = await readJson(join(repoRoot, "packages/npm/memorax-code/package.json"));
  if (manifest.name !== "@memorax/memorax-code") {
    throw new Error("main npm package name must be @memorax/memorax-code");
  }
  if (typeof manifest.version !== "string" || !manifest.version) {
    throw new Error("main npm package version is required");
  }
  if (manifest.engines?.node !== ">=24") {
    throw new Error("main npm package must require Node.js 24 or newer");
  }
}

async function validateStaging(packageRoot) {
  for (const requiredPath of [
    "LICENSE",
    "bin/memorax-code.mjs",
    "bin/memorax-cli.mjs",
    "bin/memorax-code-npm-preinstall.mjs",
    "lib/client-hook-runtime.mjs",
    "lib/node-version.mjs",
    "lib/resolve-claude-command.mjs",
    "lib/resolve-codex-command.mjs",
    "lib/vscode-extension-command.mjs",
    "lib/npm-invocation.mjs",
    "lib/windows-cli-invocation.mjs",
    "lib/memorax-code-adapter-common/src/backend-connection.mjs",
    "lib/memorax-code-adapter-common/src/hooks/client-hook-launcher.mjs",
    "lib/memorax-code-adapter-common/src/clients/codex-plugin-artifact.mjs",
    "lib/memorax-code-adapter-common/src/hooks/hook-runtime-generation.mjs",
    "lib/memorax-code-adapter-common/src/memorax-code-config-file.mjs",
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
    "lib/memorax-code-codex-adapter/src/workspace-kind.mjs",
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
    "lib/memorax-code-opencode-adapter/src/plugin.mjs",
    "lib/memorax-code-opencode-adapter/src/plugin-install.mjs",
    "lib/memorax-code-opencode-adapter/src/repo-memory-server-runner.mjs",
    "lib/memorax-code-opencode-adapter/hooks/repo-memory-job.mjs",
    "lib/memorax-code-opencode-adapter/skills/memorax-code/SKILL.md",
  ]) {
    if (!(await stat(join(packageRoot, requiredPath)).catch(() => undefined))?.isFile()) {
      throw new Error(`staged npm package is missing required runtime entrypoint: ${requiredPath}`);
    }
  }
  await walk(packageRoot, async (path, entry) => {
    const relativePath = relative(packageRoot, path);
    if (!isAllowedNpmPackPath(relativePath)) {
      throw new Error(`undeclared staged path: ${relativePath}`);
    }
    if (entry.isSymbolicLink()) {
      throw new Error(`staged npm package contains a symbolic link: ${relativePath}`);
    }
    if (relativePath.split(/[\\/]/).some((part) => part === "target" || part === "__pycache__")) {
      throw new Error(`forbidden staged path: ${relativePath}`);
    }
    if (entry.isFile() && /\.py[co]$/.test(path)) {
      throw new Error(`forbidden staged path: ${relativePath}`);
    }
  });
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--out-dir") {
      const value = argv[++index];
      if (!value) throw new Error("--out-dir requires a value");
      parsed.outDir = value;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return parsed;
}

async function copyFile(source, destination) {
  assertDeclaredNpmSource(source, declaredSourceFiles);
  await mkdir(dirname(destination), { recursive: true });
  await cp(join(repoRoot, source), destination, { force: true });
}

async function copyTree(source, destination) {
  await copyDeclaredNpmSourceTree({
    repoRoot,
    source,
    destination,
    declaredFiles: declaredSourceFiles,
  });
}

async function copyGeneratedTree(source, destination) {
  if (source !== "packages/ts/memorax-code-backend/dist") {
    throw new Error(`unsupported generated npm package source: ${source}`);
  }
  const sourceRoot = join(repoRoot, source);
  const trackedBackendPrefix = "packages/ts/memorax-code-backend/src/";
  const trackedBackendSources = [...declaredSourceFiles]
    .filter((path) => path.startsWith(trackedBackendPrefix) && path.endsWith(".ts"))
    .sort();
  const emittedJavaScript = new Set();
  await walk(sourceRoot, async (path, entry) => {
    const outputPath = relative(sourceRoot, path).replaceAll("\\", "/");
    if (entry.isSymbolicLink()) {
      throw new Error(`generated Backend output contains a symbolic link: ${outputPath}`);
    }
    if (!entry.isFile()) return;
    let sourceSuffix;
    if (outputPath.endsWith(".d.ts")) sourceSuffix = `${outputPath.slice(0, -5)}.ts`;
    else if (outputPath.endsWith(".js")) sourceSuffix = `${outputPath.slice(0, -3)}.ts`;
    else throw new Error(`unsupported generated Backend output: ${outputPath}`);
    assertDeclaredNpmSource(`${trackedBackendPrefix}${sourceSuffix}`, declaredSourceFiles);
    if (!outputPath.endsWith(".js")) return;
    emittedJavaScript.add(outputPath);
    const target = join(destination, ...outputPath.split("/"));
    await mkdir(dirname(target), { recursive: true });
    await cp(path, target, { force: true });
  });
  for (const trackedSource of trackedBackendSources) {
    const expectedOutput = `${trackedSource.slice(trackedBackendPrefix.length, -3)}.js`;
    if (!emittedJavaScript.has(expectedOutput)) {
      throw new Error(`generated Backend output is missing for tracked source: ${trackedSource}`);
    }
  }
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function removeMatching(root, predicate) {
  const removals = [];
  await walk(root, async (path, entry) => {
    if (predicate(path, entry)) removals.push(path);
  });
  removals.sort((left, right) => right.length - left.length);
  for (const path of removals) await rm(path, { recursive: true, force: true });
}

async function walk(root, visitor) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    await visitor(path, entry);
    if (entry.isDirectory()) await walk(path, visitor);
  }
}
