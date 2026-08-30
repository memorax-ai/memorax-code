import { readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { unsupportedNodeVersionMessage } from "./node-version.mjs";
import { resolveNpmExecPath } from "./npm-invocation.mjs";
import { ensureClaudeCommandEnv } from "./resolve-claude-command.mjs";
import { ensureCodexCommandEnv } from "./resolve-codex-command.mjs";
import { ensureCodeBuddyCommandEnv } from "./resolve-codebuddy-command.mjs";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function ensureBundledSkillEnv() {
  const skillsRoot = join(packageRoot, "lib", "memorax-code-codex-adapter", "skills");
  if (!process.env.MEMORAX_CODE_CODEX_DEFAULT_SKILLS_ROOT?.trim()) {
    process.env.MEMORAX_CODE_CODEX_DEFAULT_SKILLS_ROOT = skillsRoot;
  }
}

export function ensureClaudeMarketplaceEnv() {
  const marketplaceRoot = join(packageRoot, "lib", "memorax-code-claude-marketplace");
  if (!process.env.MEMORAX_CODE_CLAUDE_MARKETPLACE_ROOT?.trim()) {
    process.env.MEMORAX_CODE_CLAUDE_MARKETPLACE_ROOT = marketplaceRoot;
  }
  const skillsRoot = join(packageRoot, "lib", "memorax-code-claude-adapter", "skills");
  if (!process.env.MEMORAX_CODE_CLAUDE_SKILLS_ROOT?.trim()) {
    process.env.MEMORAX_CODE_CLAUDE_SKILLS_ROOT = skillsRoot;
  }
}

export function installWatchPathsForPackageRoot(root = packageRoot) {
  return [
    join(root, "package.json"),
    join(root, "bin", "memorax-code.mjs"),
    join(root, "lib", "memorax-code-backend", "dist", "server.js"),
  ];
}

export function ensureInstallWatchdogEnv(root = packageRoot) {
  if (!process.env.MEMORAX_CODE_INSTALL_WATCH_PATHS?.trim()) {
    process.env.MEMORAX_CODE_INSTALL_WATCH_PATHS = installWatchPathsForPackageRoot(root).join(delimiter);
  }
  if (!process.env.MEMORAX_CODE_INSTALL_WATCHDOG?.trim()) {
    process.env.MEMORAX_CODE_INSTALL_WATCHDOG = "1";
  }
}

export function ensureNpmPackageRuntimeEnv(root = packageRoot, options = {}) {
  const env = options.env ?? process.env;
  const resolvedRoot = resolve(root);
  const metadata = JSON.parse(readFileSync(join(resolvedRoot, "package.json"), "utf8"));
  const version = typeof metadata.version === "string" ? metadata.version.trim() : "";
  if (!version) throw new Error("MemoraX Code package version is missing");
  env.MEMORAX_CODE_NPM_PACKAGE_ROOT = resolvedRoot;
  env.MEMORAX_CODE_NPM_PACKAGE_VERSION = version;
  const npmExecPath = resolveNpmExecPath({ ...options, env });
  if (npmExecPath) env.MEMORAX_CODE_NPM_EXEC_PATH = npmExecPath;
}

export async function runBackendEntrypoint(relativeEntrypoint) {
  if (!ensureSupportedNodeRuntime()) return;
  ensureCodexCommandEnv();
  ensureClaudeCommandEnv();
  ensureCodeBuddyCommandEnv();
  ensureBundledSkillEnv();
  ensureClaudeMarketplaceEnv();
  ensureInstallWatchdogEnv();
  ensureNpmPackageRuntimeEnv();
  const entrypoint = join(packageRoot, "lib", "memorax-code-backend", "dist", relativeEntrypoint);
  const previousArgv1 = process.argv[1];
  process.argv[1] = entrypoint;
  try {
    await import(pathToFileURL(entrypoint).href);
  } finally {
    process.argv[1] = previousArgv1;
  }
}

export async function runCodexAdapterCli() {
  if (!ensureSupportedNodeRuntime()) return;
  ensureCodexCommandEnv();
  ensureBundledSkillEnv();
  const entrypoint = join(packageRoot, "lib", "memorax-code-codex-adapter", "src", "cli.mjs");
  await import(pathToFileURL(entrypoint).href);
}

export async function runClaudeAdapterCli() {
  if (!ensureSupportedNodeRuntime()) return;
  ensureClaudeCommandEnv();
  ensureClaudeMarketplaceEnv();
  const entrypoint = join(packageRoot, "lib", "memorax-code-claude-adapter", "src", "cli.mjs");
  await import(pathToFileURL(entrypoint).href);
}

export async function runOpenCodeAdapterCli() {
  if (!ensureSupportedNodeRuntime()) return;
  const entrypoint = join(packageRoot, "lib", "memorax-code-opencode-adapter", "src", "cli.mjs");
  await import(pathToFileURL(entrypoint).href);
}

export async function runCodeBuddyAdapterCli() {
  if (!ensureSupportedNodeRuntime()) return;
  ensureCodeBuddyCommandEnv();
  const entrypoint = join(packageRoot, "lib", "memorax-code-codebuddy-adapter", "src", "cli.mjs");
  await import(pathToFileURL(entrypoint).href);
}

function ensureSupportedNodeRuntime() {
  const message = unsupportedNodeVersionMessage();
  if (!message) return true;
  console.error(`memorax-code: ${message}`);
  process.exitCode = 1;
  return false;
}
