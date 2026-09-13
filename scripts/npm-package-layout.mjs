import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { npmShippedDocs } from "./npm-shipped-docs.mjs";

const rootFiles = new Set(["LICENSE", "README.md", "package.json"]);
const packagePrefixes = [
  "lib/memorax-code-adapter-common/",
  "lib/memorax-code-backend/",
  "lib/memorax-code-claude-adapter/",
  "lib/memorax-code-claude-marketplace/",
  "lib/memorax-code-codex-adapter/",
  "lib/memorax-code-dsh-adapter/",
  "lib/memorax-code-opencode-adapter/",
  "lib/memorax-code-codebuddy-adapter/",
  "lib/memorax-code-trae-adapter/",
];
const packageFiles = new Set([
  "bin",
  "bin/memorax-code-backend.mjs",
  "bin/memorax-code-claude.mjs",
  "bin/memorax-code-plugin-postinstall.mjs",
  "bin/memorax-code-setup.mjs",
  "bin/memorax-code-codex.mjs",
  "bin/memorax-code-opencode.mjs",
  "bin/memorax-code-codebuddy.mjs",
  "bin/memorax-code-trae.mjs",
  "bin/memorax-code-npm-preinstall.mjs",
  "bin/memorax-code.mjs",
  "bin/memorax-cli.mjs",
  "docs",
  ...npmShippedDocs.flatMap((path) => parentPaths(`docs/${path}`)),
  ...npmShippedDocs.map((path) => `docs/${path}`),
]);

function parentPaths(path) {
  const parts = path.split("/");
  const parents = [];
  for (let index = 1; index < parts.length - 1; index += 1) {
    parents.push(parts.slice(0, index + 1).join("/"));
  }
  return parents;
}
const rootLibFiles = new Set([
  "lib/automatic-update.mjs",
  "lib/npm-invocation.mjs",
  "lib/package-transition.mjs",
  "lib/client-hook-runtime.mjs",
  "lib/dsh-plugin-install.mjs",
  "lib/node-version.mjs",
  "lib/resolve-claude-command.mjs",
  "lib/resolve-codex-command.mjs",
  "lib/resolve-codebuddy-command.mjs",
  "lib/run-entrypoint.mjs",
  "lib/setup-memory-preferences.mjs",
  "lib/setup-api-key-input.mjs",
  "lib/setup-reconcile.mjs",
  "lib/setup-diagnostics.mjs",
  "lib/trial-plugin-mark.mjs",
  "lib/trial-provision-client.mjs",
  "lib/trial-provision-flow.mjs",
  "lib/trial-setup.mjs",
  "lib/vscode-extension-command.mjs",
  "lib/windows-cli-invocation.mjs",
  "lib/windows-user-path.mjs",
]);
const reviewedCredentialFiles = new Set([
  "linux-secret-service.mjs",
  "macos-keychain.mjs",
  "secure-command.mjs",
  "trial-credential-record.d.mts",
  "trial-credential-record.mjs",
  "trial-credential-store.d.mts",
  "trial-credential-store.mjs",
  "windows-dpapi.mjs",
]);
const credentialRuntimePrefixes = [
  "lib/memorax-code-adapter-common/src/credentials/",
  "lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/memorax-code-adapter-common/src/credentials/",
];
const sensitivePath = /(?:secret|credential|authorization|api[_-]?key)/i;

// Required entrypoints are a completeness check, separate from the publish allowlist.
// Source-tree copying and TS output mapping cover internal implementation files.
export function requiredNpmPackagePaths(manifest) {
  const bins = Object.values(manifest.bin ?? {});
  if (bins.length === 0 || bins.some((path) => typeof path !== "string"
    || !path.startsWith("bin/") || !isAllowedNpmPackFilePath(path))) {
    throw new Error("npm package must declare supported bin entrypoints");
  }
  const adapterRoots = packagePrefixes.filter((prefix) => prefix.endsWith("-adapter/"));
  const skillRoots = [
    ...adapterRoots,
    "lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/",
  ];
  return [
    ...rootFiles,
    ...bins,
    ...npmShippedDocs.map((path) => `docs/${path}`),
    "bin/memorax-code-npm-preinstall.mjs",
    "bin/memorax-code-plugin-postinstall.mjs",
    "bin/memorax-code-setup.mjs",
    "lib/run-entrypoint.mjs",
    "lib/memorax-code-backend/package.json",
    ...["memorax-code", "memorax-cli", "server", "service-entrypoint", "repo-memory", "user-profile"]
      .map((name) => `lib/memorax-code-backend/dist/${name}.js`),
    ...adapterRoots.map((root) => `${root}package.json`),
    ...adapterRoots.filter((root) => !root.endsWith("dsh-adapter/"))
      .map((root) => `${root}src/cli.mjs`),
    ...skillRoots.flatMap((root) => [
      `${root}skills/memorax-code/SKILL.md`,
      `${root}skills/memorax-code/scripts/repo-memory.mjs`,
      `${root}skills/memorax-code/scripts/user-profile-memory.mjs`,
    ]),
    ...["codex", "claude"].flatMap((client) => [
      `lib/memorax-code-${client}-adapter/.${client}-plugin/plugin.json`,
      `lib/memorax-code-${client}-adapter/hooks/hooks.json`,
      `lib/memorax-code-${client}-adapter/hooks/runtime-hook.mjs`,
      `lib/memorax-code-${client}-adapter/hooks/runtime-shell.json`,
    ]),
    "lib/memorax-code-codex-adapter/assets/composer-icon.png",
    "lib/memorax-code-codex-adapter/assets/logo.png",
    "lib/memorax-code-claude-marketplace/.claude-plugin/marketplace.json",
    "lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/.claude-plugin/plugin.json",
    "lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/hooks/hooks.json",
    "lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/hooks/runtime-hook.mjs",
    "lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/hooks/runtime-shell.json",
    "lib/memorax-code-dsh-adapter/cordis.patch.yml",
    "lib/memorax-code-dsh-adapter/src/index.mjs",
    "lib/memorax-code-opencode-adapter/src/plugin.mjs",
    "lib/memorax-code-codebuddy-adapter/.codebuddy-plugin/plugin.json",
    "lib/memorax-code-codebuddy-adapter/hooks/hooks.json",
    "lib/memorax-code-codebuddy-adapter/hooks/runtime-hook.mjs",
    "lib/memorax-code-trae-adapter/hooks/runtime-hook.mjs",
  ];
}

export async function assertRequiredNpmPackageFiles(packageRoot) {
  const manifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
  for (const path of requiredNpmPackagePaths(manifest)) {
    if (!(await lstat(join(packageRoot, path)).catch(() => undefined))?.isFile()) {
      throw new Error(`npm package is missing required file: ${path}`);
    }
  }
}

export function isAllowedNpmPackPath(rawPath) {
  const path = String(rawPath).replaceAll("\\", "/");
  return path === "lib"
    || rootFiles.has(path)
    || packageFiles.has(path)
    || rootLibFiles.has(path)
    || packagePrefixes.some((prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix));
}

export function isReviewedCredentialRuntimePath(rawPath) {
  const path = String(rawPath).replaceAll("\\", "/");
  if (path === "lib/setup-api-key-input.mjs") return true;
  const prefix = credentialRuntimePrefixes.find((candidate) => path.startsWith(candidate));
  return prefix !== undefined && reviewedCredentialFiles.has(path.slice(prefix.length));
}

export function isAllowedNpmPackFilePath(rawPath) {
  const path = String(rawPath).replaceAll("\\", "/");
  return isAllowedNpmPackPath(path)
    && !/\.(?:py|pyc|pyo)$/i.test(path)
    && (!sensitivePath.test(path) || isReviewedCredentialRuntimePath(path));
}
