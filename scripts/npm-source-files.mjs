import { execFileSync } from "node:child_process";
import { cp, lstat, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export const npmMainSourceTrees = Object.freeze([
  { source: "packages/npm/memorax-code/bin", destination: "bin" },
  { source: "packages/npm/memorax-code/lib", destination: "lib" },
  { source: "packages/ts/memorax-code-adapter-common/src", destination: "lib/memorax-code-adapter-common/src" },
  ...["src", "hooks", "runtime-hooks", "skills", "assets", ".codex-plugin"].map((name) => ({
    source: `packages/ts/memorax-code-codex-adapter/${name}`,
    destination: `lib/memorax-code-codex-adapter/${name}`,
  })),
  ...["src", "hooks", "runtime-hooks", "scripts", ".claude-plugin"].map((name) => ({
    source: `packages/ts/memorax-code-claude-adapter/${name}`,
    destination: `lib/memorax-code-claude-adapter/${name}`,
  })),
  {
    source: "packages/ts/memorax-code-opencode-adapter/src",
    destination: "lib/memorax-code-opencode-adapter/src",
  },
  {
    source: "packages/ts/memorax-code-opencode-adapter/hooks",
    destination: "lib/memorax-code-opencode-adapter/hooks",
  },
  {
    source: "packages/ts/memorax-code-codex-adapter/skills/memorax-code",
    destination: "lib/memorax-code-claude-adapter/skills/memorax-code",
  },
  {
    source: "packages/ts/memorax-code-codex-adapter/skills/memorax-code",
    destination: "lib/memorax-code-opencode-adapter/skills/memorax-code",
  },
]);

export function loadDeclaredNpmSourceFiles(repoRoot) {
  const output = gitFiles(repoRoot, ["ls-files", "-z"]);
  return createDeclaredNpmSourceFiles(output.split("\0").filter(Boolean));
}

export function loadUndeclaredNpmPackPaths(repoRoot) {
  const declared = loadDeclaredNpmSourceFiles(repoRoot);
  const untracked = gitFiles(repoRoot, ["ls-files", "--others", "--exclude-standard", "-z"])
    .split("\0")
    .filter(Boolean)
    .map(normalizeRepoPath)
    .filter((path) => !declared.has(path));
  const directPaths = untracked.flatMap((path) => npmMainSourceTrees
    .filter(({ source }) => path.startsWith(`${source}/`))
    .map((mapping) => [
      `${mapping.destination}/${path.slice(mapping.source.length + 1)}`,
      path,
    ]));
  return new Map(directPaths.flatMap(([packPath, sourcePath]) => [
    [packPath, sourcePath],
    ...npmMarketplaceAliases(packPath).map((alias) => [alias, sourcePath]),
  ]));
}

export function createDeclaredNpmSourceFiles(trackedFiles) {
  return new Set(trackedFiles.map(normalizeRepoPath));
}

export function assertDeclaredNpmSource(source, declaredFiles) {
  const normalized = normalizeRepoPath(source);
  if (!declaredFiles.has(normalized)) {
    throw new Error(`npm package source is not tracked: ${normalized}`);
  }
}

export async function copyDeclaredNpmSourceTree({
  repoRoot,
  source,
  destination,
  declaredFiles,
}) {
  const normalizedSource = normalizeRepoPath(source).replace(/\/$/, "");
  const prefix = `${normalizedSource}/`;
  const files = [...declaredFiles].filter((path) => path.startsWith(prefix)).sort();
  if (files.length === 0) {
    throw new Error(`npm package source tree has no tracked files: ${normalizedSource}`);
  }
  for (const file of files) {
    const target = join(destination, ...file.slice(prefix.length).split("/"));
    const sourcePath = join(repoRoot, ...file.split("/"));
    const metadata = await lstat(sourcePath);
    if (metadata.isSymbolicLink()) {
      throw new Error(`npm package source tree contains a symbolic link: ${file}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await cp(sourcePath, target, { force: true });
  }
}

export function npmMarketplaceAliases(packPath) {
  const pluginPrefix = "lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/";
  if (packPath.startsWith("lib/memorax-code-claude-adapter/")) {
    return [`${pluginPrefix}${packPath.slice("lib/memorax-code-claude-adapter/".length)}`];
  }
  if (packPath.startsWith("lib/memorax-code-adapter-common/src/")) {
    return [
      `${pluginPrefix}memorax-code-adapter-common/src/${packPath.slice("lib/memorax-code-adapter-common/src/".length)}`,
    ];
  }
  return [];
}

function normalizeRepoPath(path) {
  return String(path).replaceAll("\\", "/").replace(/^\.\//, "");
}

function gitFiles(repoRoot, args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
