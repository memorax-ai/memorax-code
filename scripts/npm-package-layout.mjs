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
];
const packageFiles = new Set([
  "bin",
  "bin/memorax-code-backend.mjs",
  "bin/memorax-code-claude.mjs",
  "bin/memorax-code-plugin-postinstall.mjs",
  "bin/memorax-code-setup.mjs",
  "bin/memorax-code-codex.mjs",
  "bin/memorax-code-opencode.mjs",
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
  "lib/npm-invocation.mjs",
  "lib/package-transition.mjs",
  "lib/client-hook-runtime.mjs",
  "lib/dsh-plugin-install.mjs",
  "lib/node-version.mjs",
  "lib/resolve-claude-command.mjs",
  "lib/resolve-codex-command.mjs",
  "lib/run-entrypoint.mjs",
  "lib/setup-memory-preferences.mjs",
  "lib/setup-reconcile.mjs",
  "lib/trial-plugin-mark.mjs",
  "lib/trial-provision-client.mjs",
  "lib/trial-provision-flow.mjs",
  "lib/trial-setup.mjs",
  "lib/vscode-extension-command.mjs",
  "lib/windows-cli-invocation.mjs",
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
  const prefix = credentialRuntimePrefixes.find((candidate) => path.startsWith(candidate));
  return prefix !== undefined && reviewedCredentialFiles.has(path.slice(prefix.length));
}

export function isAllowedNpmPackFilePath(rawPath) {
  const path = String(rawPath).replaceAll("\\", "/");
  return isAllowedNpmPackPath(path)
    && (!sensitivePath.test(path) || isReviewedCredentialRuntimePath(path));
}
