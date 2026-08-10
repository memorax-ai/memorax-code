import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  activeCodexPluginRoot,
  isCompleteCodexPluginArtifact,
} from "../../../../memorax-code-adapter-common/src/clients/codex-plugin-artifact.mjs";
import { atomicWriteJson } from "../../../../memorax-code-adapter-common/src/config-utils.mjs";
import {
  confirmHookTrust,
  listMemoraxCodeHooks,
  trustCodexPluginHookSelection,
  type CodexHook,
} from "./plugin-hooks.js";
import { resolveWindowsCliInvocation } from "../../shared/windows-cli-invocation.js";

const PLUGIN_NAME = "memorax-code-codex-adapter";
const CLI_MARKETPLACE_NAME = "memorax-code";
const ADAPTER_COMMON_NAME = "memorax-code-adapter-common";

type MarketplaceEntry = {
  name: string;
  source: { source: "local"; path: string };
  policy: { installation: "AVAILABLE"; authentication: "ON_INSTALL" };
  category: string;
};

type MarketplaceFile = {
  name?: unknown;
  interface?: unknown;
  plugins?: unknown;
  [key: string]: unknown;
};

export type CodexPluginInstallOptions = {
  codexHome?: string;
  marketplacePath?: string;
  homeDir?: string;
  pluginSourcePath?: string;
  codexCommand?: string;
};

export type CodexPluginRemoveOptions = CodexPluginInstallOptions & {
  workspace?: string;
};

export type CodexPluginActivateOptions = CodexPluginInstallOptions & {
  workspace?: string;
  yes?: boolean;
};

export type CodexPluginInstallReport = {
  ok: boolean;
  action: "codex-plugin-install";
  registrationMode: "bootstrap" | "versioned-update";
  codexHome: string;
  marketplacePath: string;
  marketplaceName: string;
  pluginSourcePath: string;
  marketplaceSourcePath: string;
  startsBackend: false;
  changed: boolean;
};

export type CodexPluginActivateReport = {
  ok: boolean;
  action: "codex-plugin-activate";
  install: CodexPluginInstallReport;
  codexCommand: string;
  workspace: string;
  marketplaceAdd: CodexPluginCommandResult;
  pluginAdd: CodexPluginCommandResult;
  hooks: CodexHook[];
  trustedHooks: number;
  configPath: string;
  startsBackend: false;
};

type CodexPluginCommandResult = {
  ok: boolean;
  stdout: string;
  stderr: string;
  skipped?: boolean;
  reason?: string;
};

export type CodexPluginRemoveReport = {
  ok: boolean;
  action: "codex-plugin-remove";
  codexHome: string;
  marketplacePath: string;
  pluginSourcePath: string;
  pluginRemove: { ok: boolean; skipped?: boolean; reason?: string; stdout: string; stderr: string };
  removedPaths: string[];
  marketplaceChanged: boolean;
  startsBackend: false;
};

export type BackendRemovalCleanupReport = {
  ok: boolean;
  action: "backend-removal-cleanup";
  memoraxCodeHome: string;
  codexHome: string;
  statePath: string;
  codexPlugin: CodexPluginRemoveReport;
};

export async function installCodexPlugin(options: CodexPluginInstallOptions = {}): Promise<CodexPluginInstallReport> {
  const home = resolveHome(options.homeDir);
  const codexHome = resolveCodexHome(options.codexHome, home);
  const marketplacePath = resolve(options.marketplacePath ?? join(home, ".agents", "plugins", "marketplace.json"));
  const pluginSourcePath = resolve(options.pluginSourcePath ?? defaultPluginSourcePath(codexHome));
  const sourceRoot = adapterSourceRoot();
  const canonicalMarketplacePath = join(
    codexCliMarketplaceRoot(codexHome),
    ".agents",
    "plugins",
    "marketplace.json",
  );
  if (!options.marketplacePath
    && !options.pluginSourcePath
    && existsSync(canonicalMarketplacePath)
    && activeCodexPluginRoot(codexHome)) {
    return await updateVersionedCodexPlugin(
      codexHome,
      sourceRoot,
      options.codexCommand ?? process.env.CODEX_CLI_PATH,
    );
  }
  const sourcePath = marketplaceSourcePath(marketplacePath, pluginSourcePath);

  await stagePluginSource(sourceRoot, pluginSourcePath);
  await writePluginMetadata(pluginSourcePath, options.codexCommand ?? process.env.CODEX_CLI_PATH);
  const changed = await upsertPersonalMarketplace(marketplacePath, pluginEntry(sourcePath));
  const marketplace = await readMarketplace(marketplacePath);

  const report: CodexPluginInstallReport = {
    ok: true,
    action: "codex-plugin-install",
    registrationMode: "bootstrap",
    codexHome,
    marketplacePath,
    marketplaceName: marketplaceName(marketplace),
    pluginSourcePath,
    marketplaceSourcePath: sourcePath,
    startsBackend: false,
    changed,
  };
  if (existsSync(codexCliMarketplaceRoot(codexHome))) await stageCodexCliMarketplace(report);
  return report;
}

async function updateVersionedCodexPlugin(
  codexHome: string,
  sourceRoot: string,
  codexCommand?: string,
): Promise<CodexPluginInstallReport> {
  const manifest = await readJsonRecord(join(sourceRoot, ".codex-plugin", "plugin.json"));
  const version = stringField(manifest, "version");
  if (!version) throw new Error("bundled Codex plugin manifest is missing version");

  const marketplaceRoot = codexCliMarketplaceRoot(codexHome);
  const marketplacePath = join(marketplaceRoot, ".agents", "plugins", "marketplace.json");
  const pluginSourcePath = join(marketplaceRoot, "versions", version, "plugins", PLUGIN_NAME);
  await publishImmutableDirectory(pluginSourcePath, dirname(pluginSourcePath), version, async (temporaryRoot) => {
    await stagePluginSource(sourceRoot, temporaryRoot);
    await writePluginMetadata(temporaryRoot, codexCommand);
  });

  const cacheRoot = join(codexHome, "plugins", "cache", CLI_MARKETPLACE_NAME, PLUGIN_NAME);
  const cachePath = join(cacheRoot, version);
  await publishImmutableDirectory(cachePath, dirname(cacheRoot), version, async (temporaryRoot) => {
    await cp(pluginSourcePath, temporaryRoot, { recursive: true });
  });

  const marketplace = await readMarketplace(marketplacePath);
  const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  const index = plugins.findIndex((item) => isRecord(item) && item.name === PLUGIN_NAME);
  const sourcePath = marketplaceSourcePath(marketplacePath, pluginSourcePath);
  if (index < 0) {
    plugins.push(pluginEntry(sourcePath));
  } else {
    const current = isRecord(plugins[index]) ? plugins[index] : {};
    plugins[index] = { ...current, source: { source: "local", path: sourcePath } };
  }
  marketplace.plugins = plugins;
  const previousMarketplace = await readFile(marketplacePath, "utf8");
  const nextMarketplace = `${JSON.stringify(marketplace, null, 2)}\n`;
  const changed = previousMarketplace !== nextMarketplace;
  if (changed) atomicWriteJson(marketplacePath, marketplace);

  return {
    ok: true,
    action: "codex-plugin-install",
    registrationMode: "versioned-update",
    codexHome,
    marketplacePath,
    marketplaceName: CLI_MARKETPLACE_NAME,
    pluginSourcePath,
    marketplaceSourcePath: sourcePath,
    startsBackend: false,
    changed,
  };
}

export async function cleanupCodexAfterBackendRemoval(
  options: Pick<CodexPluginRemoveOptions, "codexHome" | "homeDir" | "marketplacePath" | "pluginSourcePath" | "codexCommand" | "workspace"> & {
    memoraxCodeHome?: string;
  } = {},
): Promise<BackendRemovalCleanupReport> {
  const home = resolveHome(options.homeDir);
  const memoraxCodeHome = resolve(options.memoraxCodeHome ?? process.env.MEMORAX_CODE_HOME ?? join(home, ".memorax-code"));
  const statePath = join(memoraxCodeHome, "adapters", "codex", "state.json");
  const state = await readJsonRecord(statePath);
  const codexHome = resolveCodexHome(options.codexHome ?? stringField(state, "codexHome"), home);
  const codexPlugin = await removeCodexPlugin({ ...options, codexHome, homeDir: home });
  return {
    ok: codexPlugin.ok,
    action: "backend-removal-cleanup",
    memoraxCodeHome,
    codexHome,
    statePath,
    codexPlugin,
  };
}

export async function activateCodexPlugin(options: CodexPluginActivateOptions = {}): Promise<CodexPluginActivateReport> {
  const home = resolveHome(options.homeDir);
  const bootstrapMarketplacePath = resolve(
    options.marketplacePath ?? join(home, ".agents", "plugins", "marketplace.json"),
  );
  const install = await installCodexPlugin(options);
  const codexCommand = options.codexCommand ?? process.env.CODEX_CLI_PATH ?? "codex";
  const workspace = resolve(options.workspace ?? process.cwd());
  const env = {
    ...process.env,
    HOME: home,
    CODEX_HOME: install.codexHome,
  };
  const cliMarketplaceRoot = codexCliMarketplaceRoot(install.codexHome);
  if (!existsSync(join(cliMarketplaceRoot, ".agents", "plugins", "marketplace.json"))) {
    await stageCodexCliMarketplace(install);
  }
  let marketplaceAdd: CodexPluginCommandResult;
  let pluginAdd: CodexPluginCommandResult;
  if (install.registrationMode === "bootstrap") {
    marketplaceAdd = await runCommand(codexCommand, ["plugin", "marketplace", "add", cliMarketplaceRoot, "--json"], { cwd: workspace, env });
    if (!marketplaceAdd.ok) {
      throw new Error(`codex plugin marketplace add failed: ${marketplaceAdd.stderr || marketplaceAdd.stdout || "unknown error"}`);
    }
    pluginAdd = await runCommand(codexCommand, ["plugin", "add", `${PLUGIN_NAME}@${CLI_MARKETPLACE_NAME}`, "--json"], { cwd: workspace, env });
    if (!pluginAdd.ok) {
      throw new Error(`codex plugin add failed: ${pluginAdd.stderr || pluginAdd.stdout || "unknown error"}`);
    }
  } else {
    marketplaceAdd = skippedPluginCommand("versioned_installation_preserved");
    pluginAdd = skippedPluginCommand("versioned_installation_preserved");
  }
  await removePersonalMarketplaceEntry(bootstrapMarketplacePath);
  const hooks = await listMemoraxCodeHooks(codexCommand, workspace, env);
  if (hooks.length === 0) {
    throw new Error("no MemoraX Code plugin hooks found after installing the Codex plugin");
  }
  if (!options.yes) await confirmHookTrust(hooks);
  const configPath = join(install.codexHome, "config.toml");
  await trustCodexPluginHookSelection({
    codexHome: install.codexHome,
    homeDir: options.homeDir,
    codexCommand,
    workspace,
    hooks,
  });
  return {
    ok: true,
    action: "codex-plugin-activate",
    install,
    codexCommand,
    workspace,
    marketplaceAdd,
    pluginAdd,
    hooks,
    trustedHooks: hooks.length,
    configPath,
    startsBackend: false,
  };
}

export async function removeCodexPlugin(options: CodexPluginRemoveOptions = {}): Promise<CodexPluginRemoveReport> {
  const home = resolveHome(options.homeDir);
  const codexHome = resolveCodexHome(options.codexHome, home);
  const marketplacePath = resolve(options.marketplacePath ?? join(home, ".agents", "plugins", "marketplace.json"));
  const pluginSourcePath = resolve(options.pluginSourcePath ?? defaultPluginSourcePath(codexHome));
  const removedPaths: string[] = [];

  const pluginRemove = await removeActivatedCodexPlugin(options, home, codexHome);
  const marketplaceChanged = await removePersonalMarketplaceEntry(marketplacePath);
  await removeStagedPluginSource(pluginSourcePath, removedPaths);
  await removeCachedPluginRoots(codexHome, removedPaths);

  return {
    ok: true,
    action: "codex-plugin-remove",
    codexHome,
    marketplacePath,
    pluginSourcePath,
    pluginRemove,
    removedPaths,
    marketplaceChanged,
    startsBackend: false,
  };
}

async function removeActivatedCodexPlugin(
  options: CodexPluginRemoveOptions,
  home: string,
  codexHome: string,
): Promise<{ ok: boolean; skipped?: boolean; reason?: string; stdout: string; stderr: string }> {
  const codexCommand = options.codexCommand ?? process.env.CODEX_CLI_PATH ?? "codex";
  const workspace = resolve(options.workspace ?? process.cwd());
  const env = { ...process.env, HOME: home, CODEX_HOME: codexHome };
  const explicit = await runCommand(codexCommand, ["plugin", "remove", `${PLUGIN_NAME}@${CLI_MARKETPLACE_NAME}`], { cwd: workspace, env });
  if (commandUnavailable(explicit)) return { ...explicit, ok: true, skipped: true, reason: "codex_cli_unavailable" };
  const marketplace = await runCommand(codexCommand, ["plugin", "marketplace", "remove", CLI_MARKETPLACE_NAME], { cwd: workspace, env });
  if (commandUnavailable(marketplace)) return { ...marketplace, ok: true, skipped: true, reason: "codex_cli_unavailable" };
  const results = [explicit, marketplace];
  const failed = results.find((result) => !result.ok && !/not found|not installed|unknown marketplace/i.test(result.stderr || result.stdout));
  if (failed) return failed;
  return {
    ok: true,
    stdout: results.map((result) => result.stdout).filter(Boolean).join("\n"),
    stderr: results.map((result) => result.stderr).filter(Boolean).join("\n"),
  };
}

async function stageCodexCliMarketplace(install: CodexPluginInstallReport): Promise<string> {
  const root = codexCliMarketplaceRoot(install.codexHome);
  const pluginPath = join(root, "plugins", PLUGIN_NAME);
  await rm(root, { recursive: true, force: true });
  await mkdir(join(root, ".agents", "plugins"), { recursive: true });
  await mkdir(dirname(pluginPath), { recursive: true });
  await cp(install.pluginSourcePath, pluginPath, { recursive: true });
  await writeFile(join(root, ".agents", "plugins", "marketplace.json"), `${JSON.stringify({
    name: CLI_MARKETPLACE_NAME,
    interface: { displayName: "MemoraX Code" },
    plugins: [pluginEntry(`./plugins/${PLUGIN_NAME}`)],
  }, null, 2)}\n`, "utf8");
  return root;
}

function codexCliMarketplaceRoot(codexHome: string): string {
  return join(codexHome, ".memorax-code", "marketplaces", CLI_MARKETPLACE_NAME);
}

export function isCodexPluginStaged(options: Pick<CodexPluginInstallOptions, "codexHome" | "homeDir"> = {}): boolean {
  const home = resolveHome(options.homeDir);
  const codexHome = resolveCodexHome(options.codexHome, home);
  return isCompleteCodexPluginArtifact(defaultPluginSourcePath(codexHome));
}

export function isCodexPluginActive(options: Pick<CodexPluginInstallOptions, "codexHome" | "homeDir"> = {}): boolean {
  const home = resolveHome(options.homeDir);
  const codexHome = resolveCodexHome(options.codexHome, home);
  return activeCodexPluginRoot(codexHome) !== undefined;
}

export function resolveCodexHome(value: string | undefined, homeDir = homedir()): string {
  const configured = nonEmpty(value) ?? nonEmpty(process.env.CODEX_HOME);
  return resolve(expandHome(configured ?? join(homeDir, ".codex"), homeDir));
}

function resolveHome(value: string | undefined): string {
  return resolve(expandHome(nonEmpty(value) ?? process.env.HOME ?? homedir(), homedir()));
}

async function readJsonRecord(path: string): Promise<Record<string, unknown> | undefined> {
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function adapterSourceRoot(): string {
  const current = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(current, "..", "..", "..", "..", "memorax-code-codex-adapter"),
    resolve(current, "..", "..", "..", "memorax-code-codex-adapter"),
  ];
  const found = candidates.find((candidate) => existsSync(join(candidate, ".codex-plugin", "plugin.json")));
  if (!found) throw new Error("bundled Codex plugin source is missing .codex-plugin/plugin.json");
  return found;
}

function defaultPluginSourcePath(codexHome: string): string {
  return join(codexHome, ".memorax-code", "plugins", PLUGIN_NAME);
}

async function publishImmutableDirectory(
  targetRoot: string,
  temporaryParent: string,
  version: string,
  stage: (temporaryRoot: string) => Promise<void>,
): Promise<void> {
  if (existsSync(targetRoot)) {
    await verifyVersionedPlugin(targetRoot, version);
    return;
  }
  await mkdir(temporaryParent, { recursive: true });
  const temporaryRoot = join(
    temporaryParent,
    `.${PLUGIN_NAME}-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    await stage(temporaryRoot);
    await verifyVersionedPlugin(temporaryRoot, version);
    await mkdir(dirname(targetRoot), { recursive: true });
    await rename(temporaryRoot, targetRoot);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function verifyVersionedPlugin(root: string, version: string): Promise<void> {
  const manifest = await readJsonRecord(join(root, ".codex-plugin", "plugin.json"));
  const pluginInterface = isRecord(manifest?.interface) ? manifest.interface : undefined;
  const shell = await readJsonRecord(join(root, "hooks", "runtime-shell.json"));
  const metadata = await readJsonRecord(join(root, ".memorax-code-package.json"));
  if (stringField(manifest, "name") !== PLUGIN_NAME
    || stringField(manifest, "version") !== version
    || stringField(pluginInterface, "composerIcon") !== "./assets/composer-icon.png"
    || stringField(pluginInterface, "logo") !== "./assets/logo.png"
    || shell?.version !== 1
    || shell.runtimeAbi !== 1
    || stringField(shell, "shellVersion") !== version
    || !stringField(metadata, "memoraxCodeCommand")) {
    throw new Error(`Codex plugin artifact version does not match ${version}`);
  }
  if (!isCompleteCodexPluginArtifact(root)) {
    throw new Error("Codex plugin artifact is missing the manifest or memory skill");
  }
  if (!await readJsonRecord(join(root, "hooks", "hooks.json"))) {
    throw new Error("Codex plugin artifact has invalid hooks/hooks.json");
  }
  for (const path of [
    "assets/composer-icon.png",
    "assets/logo.png",
    "hooks/hook-launcher.mjs",
    "hooks/runtime-hook.mjs",
  ]) {
    if (!existsSync(join(root, ...path.split("/")))) {
      throw new Error(`Codex plugin artifact is missing ${path}`);
    }
  }
}

async function stagePluginSource(sourceRoot: string, targetRoot: string): Promise<void> {
  await mkdir(dirname(targetRoot), { recursive: true });
  await rm(targetRoot, { recursive: true, force: true });
  await rm(join(dirname(targetRoot), ADAPTER_COMMON_NAME), { recursive: true, force: true });
  await mkdir(targetRoot, { recursive: true });
  for (const entry of [".codex-plugin", "assets", "hooks", "runtime-hooks", "skills", "src", "package.json"]) {
    await cp(join(sourceRoot, entry), join(targetRoot, entry), { recursive: true });
  }
  await stageAdapterCommonSource(sourceRoot, targetRoot);
}

async function stageAdapterCommonSource(sourceRoot: string, targetRoot: string): Promise<void> {
  const commonSourceRoot = resolve(sourceRoot, "..", ADAPTER_COMMON_NAME);
  if (!existsSync(join(commonSourceRoot, "src"))) {
    throw new Error(`bundled adapter common source is missing: ${commonSourceRoot}`);
  }
  const commonTargetRoot = join(targetRoot, ADAPTER_COMMON_NAME);
  await rm(commonTargetRoot, { recursive: true, force: true });
  await cp(commonSourceRoot, commonTargetRoot, { recursive: true });
  await rewriteAdapterCommonImports(targetRoot);
}

async function rewriteAdapterCommonImports(targetRoot: string): Promise<void> {
  for (const dir of ["hooks", "runtime-hooks", "src"]) {
    for (const path of mjsFiles(join(targetRoot, dir))) {
      const text = await readFile(path, "utf8");
      const next = text.replaceAll("../../memorax-code-adapter-common/src/", "../memorax-code-adapter-common/src/");
      if (next !== text) await writeFile(path, next, "utf8");
    }
  }
}

function mjsFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...mjsFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".mjs")) files.push(path);
  }
  return files;
}

async function writePluginMetadata(pluginSourcePath: string, codexCommand?: string): Promise<void> {
  const normalizedCodexCommand = nonEmpty(codexCommand);
  const metadata = {
    version: 1,
    memoraxCodeCommand: process.argv[1],
    ...(normalizedCodexCommand ? { codexCommand: normalizedCodexCommand } : {}),
    writtenAt: new Date().toISOString(),
  };
  await writeFile(join(pluginSourcePath, ".memorax-code-package.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
}

async function upsertPersonalMarketplace(marketplacePath: string, entry: MarketplaceEntry): Promise<boolean> {
  const before = existsSync(marketplacePath) ? await readFile(marketplacePath, "utf8") : undefined;
  const marketplace = await readMarketplace(marketplacePath);
  marketplace.interface ??= { displayName: "Personal" };
  const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  const nextPlugins = [...plugins];
  const index = nextPlugins.findIndex((item) => isRecord(item) && item.name === entry.name);
  if (index >= 0) {
    const existing = isRecord(nextPlugins[index]) ? nextPlugins[index] : {};
    nextPlugins[index] = { ...existing, ...entry };
  } else {
    nextPlugins.push(entry);
  }
  marketplace.plugins = nextPlugins;
  await mkdir(dirname(marketplacePath), { recursive: true });
  const next = `${JSON.stringify(marketplace, null, 2)}\n`;
  await writeFile(marketplacePath, next, "utf8");
  return before !== next;
}

async function removePersonalMarketplaceEntry(marketplacePath: string): Promise<boolean> {
  if (!existsSync(marketplacePath)) return false;
  const before = await readFile(marketplacePath, "utf8");
  const marketplace = await readMarketplace(marketplacePath);
  const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  marketplace.plugins = plugins.filter((item) => !(isRecord(item) && item.name === PLUGIN_NAME));
  const next = `${JSON.stringify(marketplace, null, 2)}\n`;
  if (before === next) return false;
  await writeFile(marketplacePath, next, "utf8");
  return true;
}

async function removeStagedPluginSource(pluginSourcePath: string, removedPaths: string[]): Promise<void> {
  for (const entry of [".codex-plugin", "assets", "hooks", "runtime-hooks", "skills", "src", "package.json", ".memorax-code-package.json", ADAPTER_COMMON_NAME]) {
    const target = join(pluginSourcePath, entry);
    if (!existsSync(target)) continue;
    await rm(target, { recursive: true, force: true });
    removedPaths.push(target);
  }
  const commonTargetRoot = join(dirname(pluginSourcePath), ADAPTER_COMMON_NAME);
  if (existsSync(commonTargetRoot)) {
    await rm(commonTargetRoot, { recursive: true, force: true });
    removedPaths.push(commonTargetRoot);
  }
}

async function removeCachedPluginRoots(codexHome: string, removedPaths: string[]): Promise<void> {
  for (const cacheRoot of [
    join(codexHome, "plugins", "cache", CLI_MARKETPLACE_NAME, PLUGIN_NAME),
    codexCliMarketplaceRoot(codexHome),
  ]) {
    if (!existsSync(cacheRoot)) continue;
    await rm(cacheRoot, { recursive: true, force: true });
    removedPaths.push(cacheRoot);
  }
}

async function readMarketplace(marketplacePath: string): Promise<MarketplaceFile> {
  if (!existsSync(marketplacePath)) return { name: "personal", interface: { displayName: "Personal" }, plugins: [] };
  const parsed = JSON.parse(await readFile(marketplacePath, "utf8"));
  if (!isRecord(parsed)) throw new Error(`${marketplacePath} must contain a JSON object`);
  if (!nonEmpty(typeof parsed.name === "string" ? parsed.name : undefined)) parsed.name = "personal";
  return parsed;
}

function skippedPluginCommand(reason: string): CodexPluginCommandResult {
  return { ok: true, stdout: "", stderr: "", skipped: true, reason };
}

function pluginEntry(sourcePath: string): MarketplaceEntry {
  return {
    name: PLUGIN_NAME,
    source: { source: "local", path: sourcePath },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Productivity",
  };
}

function marketplaceSourcePath(marketplacePath: string, pluginSourcePath: string): string {
  const root = marketplaceRoot(marketplacePath);
  const rel = relative(root, pluginSourcePath).split(sep).join("/");
  if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel.startsWith("./") ? rel : `./${rel}`;
  return pluginSourcePath;
}

function marketplaceRoot(marketplacePath: string): string {
  const normalized = resolve(marketplacePath);
  const parts = normalized.split(sep);
  const last = parts.at(-1);
  if (last === "marketplace.json" && parts.at(-2) === "plugins" && parts.at(-3) === ".agents") {
    return parts.slice(0, -3).join(sep) || sep;
  }
  return dirname(normalized);
}

function marketplaceName(marketplace: MarketplaceFile): string {
  return nonEmpty(typeof marketplace.name === "string" ? marketplace.name : undefined) ?? "personal";
}

function runCommand(command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv }): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolveResult) => {
    let invocation;
    try {
      invocation = resolveWindowsCliInvocation(command, args, { env: options.env });
    } catch (error) {
      resolveResult({
        ok: false,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const child = spawn(invocation.command, invocation.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      resolveResult({ ok: false, stdout, stderr: stderr || error.message });
    });
    child.on("close", (code) => {
      resolveResult({ ok: code === 0, stdout, stderr });
    });
  });
}

function commandUnavailable(result: { stdout: string; stderr: string }): boolean {
  return /ENOENT|command not found/i.test(result.stderr || result.stdout);
}

function expandHome(value: string, homeDir: string): string {
  if (value === "~") return homeDir;
  if (value.startsWith(`~${sep}`) || value.startsWith("~/")) return join(homeDir, value.slice(2));
  return value;
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
