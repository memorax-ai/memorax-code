import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { unsupportedNodeVersionMessage } from "./node-version.mjs";
import { ensureClaudeCommandEnv } from "./resolve-claude-command.mjs";
import { ensureCodexCommandEnv } from "./resolve-codex-command.mjs";

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

export async function runBackendEntrypoint(relativeEntrypoint) {
  if (!ensureSupportedNodeRuntime()) return;
  ensureCodexCommandEnv();
  ensureClaudeCommandEnv();
  ensureBundledSkillEnv();
  ensureClaudeMarketplaceEnv();
  ensureInstallWatchdogEnv();
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

function ensureSupportedNodeRuntime() {
  const message = unsupportedNodeVersionMessage();
  if (!message) return true;
  console.error(`memorax-code: ${message}`);
  process.exitCode = 1;
  return false;
}
