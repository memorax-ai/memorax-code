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
  "lib/client-hook-runtime.mjs",
  "lib/dsh-plugin-install.mjs",
  "lib/node-version.mjs",
  "lib/resolve-claude-command.mjs",
  "lib/resolve-codex-command.mjs",
  "lib/run-entrypoint.mjs",
  "lib/vscode-extension-command.mjs",
  "lib/windows-cli-invocation.mjs",
]);

export function isAllowedNpmPackPath(rawPath) {
  const path = String(rawPath).replaceAll("\\", "/");
  return path === "lib"
    || rootFiles.has(path)
    || packageFiles.has(path)
    || rootLibFiles.has(path)
    || packagePrefixes.some((prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix));
}
