import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  activeCodexPluginRoot,
  isCompleteCodexPluginArtifact,
} from "../../../../memorax-code-adapter-common/src/clients/codex-plugin-artifact.mjs";
import { atomicWriteJson } from "../../../../memorax-code-adapter-common/src/config-utils.mjs";
import { attachDeploymentFailure, deploymentFailure, type DeploymentFailure } from "../../../../memorax-code-adapter-common/src/deployment-failure.mjs";
import { fileTreeMatches } from "../../../../memorax-code-adapter-common/src/file-tree-match.mjs";
import {
  confirmHookTrust,
  listMemoraxCodeHooks,
  trustCodexPluginHookSelection,
  type CodexHook,
} from "./plugin-hooks.js";
import { resolveWindowsCliInvocation } from "../../shared/windows-cli-invocation.js";

const PLUGIN_NAME = "memorax-code-codex-adapter";
const CLI_MARKETPLACE_NAME = "memorax-code";
const PLUGIN_ID = `${PLUGIN_NAME}@${CLI_MARKETPLACE_NAME}`;
const ADAPTER_COMMON_NAME = "memorax-code-adapter-common";
const PLUGIN_LIST_TIMEOUT_MS = 10_000;
const PLUGIN_SOURCE_ENTRIES = [".codex-plugin", "assets", "hooks", "runtime-hooks", "skills", "src", "package.json"];

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

export type CodexPluginRegistrationReport = {
  ok: true;
  action: "codex-plugin-registration";
  codexHome: string;
  codexCommand: string;
  workspace: string;
  available: boolean;
  registered: boolean;
  enabled: boolean;
  version?: string;
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
  registrationBefore: CodexPluginRegistrationReport;
  registration: CodexPluginRegistrationReport;
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
  failure?: DeploymentFailure;
};

export type CodexPluginRemoveReport = {
  ok: boolean;
  action: "codex-plugin-remove";
  codexHome: string;
  marketplacePath: string;
  pluginSourcePath: string;
  pluginRemove: CodexPluginCommandResult;
  failure?: DeploymentFailure;
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
  if (!version) throw attachDeploymentFailure(new Error("bundled Codex plugin manifest is missing version"), "plugin-stage", { failureReason: "invalid_record" });

  const marketplaceRoot = codexCliMarketplaceRoot(codexHome);
  const marketplacePath = join(marketplaceRoot, ".agents", "plugins", "marketplace.json");
  const pluginSourcePath = join(marketplaceRoot, "versions", version, "plugins", PLUGIN_NAME);
  // Existing sessions may still reference an older directory. Publish or reuse
  // immutable versioned artifacts before switching the marketplace pointer.
  await publishImmutableDirectory(pluginSourcePath, dirname(pluginSourcePath), version, async (temporaryRoot) => {
    await stagePluginSource(sourceRoot, temporaryRoot);
    await writePluginMetadata(temporaryRoot, codexCommand);
  });

  const cacheRoot = join(codexHome, "plugins", "cache", CLI_MARKETPLACE_NAME, PLUGIN_NAME);
  const cachePath = join(cacheRoot, version);
  await publishImmutableDirectory(cachePath, dirname(cacheRoot), version, async (temporaryRoot) => {
    await cp(pluginSourcePath, temporaryRoot, { recursive: true }).catch((error) => {
      throw attachDeploymentFailure(error, "plugin-stage");
    });
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
  if (changed) {
    try { atomicWriteJson(marketplacePath, marketplace); }
    catch (error) { throw attachDeploymentFailure(error, "plugin-register"); }
  }

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
  const registrationBefore = await inspectCodexPluginRegistration({
    ...options,
    codexHome: install.codexHome,
    codexCommand,
    workspace,
  });
  let marketplaceAdd: CodexPluginCommandResult;
  let pluginAdd: CodexPluginCommandResult;
  if (!registrationBefore.registered || !registrationBefore.enabled) {
    if (registrationBefore.available) {
      marketplaceAdd = skippedPluginCommand("marketplace_registration_preserved");
    } else {
      marketplaceAdd = await runCommand(codexCommand, ["plugin", "marketplace", "add", cliMarketplaceRoot, "--json"], { cwd: workspace, env, failureStage: "plugin-register" });
      if (!marketplaceAdd.ok) {
        throw Object.assign(new Error(`codex plugin marketplace add failed: ${marketplaceAdd.stderr || marketplaceAdd.stdout || "unknown error"}`), { failure: deploymentFailure(marketplaceAdd, "plugin-register") });
      }
    }
    pluginAdd = await runCommand(codexCommand, ["plugin", "add", PLUGIN_ID, "--json"], { cwd: workspace, env, failureStage: "plugin-install" });
    if (!pluginAdd.ok) {
      throw Object.assign(new Error(`codex plugin add failed: ${pluginAdd.stderr || pluginAdd.stdout || "unknown error"}`), { failure: deploymentFailure(pluginAdd, "plugin-install") });
    }
  } else {
    marketplaceAdd = skippedPluginCommand("versioned_installation_preserved");
    pluginAdd = skippedPluginCommand("versioned_installation_preserved");
  }
  const registration = await inspectCodexPluginRegistration({
    ...options,
    codexHome: install.codexHome,
    codexCommand,
    workspace,
  });
  const expectedVersion = stringField(
    await readJsonRecord(join(install.pluginSourcePath, ".codex-plugin", "plugin.json")),
    "version",
  );
  if (!registration.registered || !registration.enabled) {
    throw attachDeploymentFailure(new Error("Codex plugin registration was not enabled after activation"), "verify-native", { failureReason: "verification_failed" });
  }
  if (!expectedVersion || registration.version !== expectedVersion) {
    throw attachDeploymentFailure(new Error(`Codex plugin registration version does not match ${expectedVersion ?? "the installed plugin"}`), "verify-native", { failureReason: "verification_failed" });
  }
  await removePersonalMarketplaceEntry(bootstrapMarketplacePath);
  const hooks = await listMemoraxCodeHooks(codexCommand, workspace, env).catch((error) => {
    throw attachDeploymentFailure(error, "hooks-read");
  });
  if (hooks.length === 0) {
    throw attachDeploymentFailure(new Error("no MemoraX Code plugin hooks found after installing the Codex plugin"), "verify-native", { failureReason: "verification_failed" });
  }
  if (!options.yes) await confirmHookTrust(hooks);
  const configPath = join(install.codexHome, "config.toml");
  await trustCodexPluginHookSelection({
    codexHome: install.codexHome,
    homeDir: options.homeDir,
    codexCommand,
    workspace,
    hooks,
  }).catch((error) => { throw attachDeploymentFailure(error, "hooks-write"); });
  return {
    ok: true,
    action: "codex-plugin-activate",
    install,
    codexCommand,
    workspace,
    marketplaceAdd,
    pluginAdd,
    registrationBefore,
    registration,
    hooks,
    trustedHooks: hooks.length,
    configPath,
    startsBackend: false,
  };
}

export async function inspectCodexPluginRegistration(
  options: Pick<CodexPluginActivateOptions, "codexHome" | "homeDir" | "codexCommand" | "workspace"> = {},
): Promise<CodexPluginRegistrationReport> {
  const home = resolveHome(options.homeDir);
  const codexHome = resolveCodexHome(options.codexHome, home);
  const codexCommand = options.codexCommand ?? process.env.CODEX_CLI_PATH ?? "codex";
  const workspace = resolve(options.workspace ?? process.cwd());
  const result = await runCommand(codexCommand, ["plugin", "list", "--available", "--json"], {
    cwd: workspace,
    env: { ...process.env, HOME: home, CODEX_HOME: codexHome },
    timeoutMs: PLUGIN_LIST_TIMEOUT_MS,
    failureStage: "plugin-list",
  });
  if (!result.ok) {
    throw Object.assign(new Error(`codex plugin list failed: ${result.stderr || result.stdout || "unknown error"}`), { failure: deploymentFailure(result, "plugin-list") });
  }
  let state;
  try { state = parseCodexPluginList(result.stdout); }
  catch (error) { throw attachDeploymentFailure(error, "plugin-list", { failureReason: "invalid_response" }); }
  return {
    ok: true,
    action: "codex-plugin-registration",
    codexHome,
    codexCommand,
    workspace,
    ...state,
  };
}

export async function removeCodexPlugin(options: CodexPluginRemoveOptions = {}): Promise<CodexPluginRemoveReport> {
  const home = resolveHome(options.homeDir);
  const codexHome = resolveCodexHome(options.codexHome, home);
  const marketplacePath = resolve(options.marketplacePath ?? join(home, ".agents", "plugins", "marketplace.json"));
  const pluginSourcePath = resolve(options.pluginSourcePath ?? defaultPluginSourcePath(codexHome));
  const removedPaths: string[] = [];

  const pluginRemove = await removeActivatedCodexPlugin(options, home, codexHome);
  let marketplaceChanged = false;
  // A failed native removal may leave registration pointing at these files.
  // Retain them for retry and let the outer lifecycle stop npm removal.
  if (pluginRemove.ok) {
    marketplaceChanged = await removePersonalMarketplaceEntry(marketplacePath);
    await removeStagedPluginSource(pluginSourcePath, removedPaths);
    await removeCachedPluginRoots(codexHome, removedPaths);
  }

  return {
    ok: pluginRemove.ok,
    action: "codex-plugin-remove",
    codexHome,
    marketplacePath,
    pluginSourcePath,
    pluginRemove,
    ...(!pluginRemove.ok ? { failure: deploymentFailure(pluginRemove, "plugin-remove") } : {}),
    removedPaths,
    marketplaceChanged,
    startsBackend: false,
  };
}

async function removeActivatedCodexPlugin(
  options: CodexPluginRemoveOptions,
  home: string,
  codexHome: string,
): Promise<CodexPluginCommandResult> {
  const codexCommand = options.codexCommand ?? process.env.CODEX_CLI_PATH ?? "codex";
  const workspace = resolve(options.workspace ?? process.cwd());
  const env = { ...process.env, HOME: home, CODEX_HOME: codexHome };
  const explicit = await runCommand(codexCommand, ["plugin", "remove", `${PLUGIN_NAME}@${CLI_MARKETPLACE_NAME}`], { cwd: workspace, env, failureStage: "plugin-remove" });
  if (commandUnavailable(explicit)) return { ok: true, stdout: explicit.stdout, stderr: explicit.stderr, skipped: true, reason: "codex_cli_unavailable" };
  const marketplace = await runCommand(codexCommand, ["plugin", "marketplace", "remove", CLI_MARKETPLACE_NAME], { cwd: workspace, env, failureStage: "plugin-remove" });
  if (commandUnavailable(marketplace)) return { ok: true, stdout: marketplace.stdout, stderr: marketplace.stderr, skipped: true, reason: "codex_cli_unavailable" };
  const results = [explicit, marketplace];
  const failed = results.find((result) => !result.ok && !/not found|not installed|not configured or installed|unknown marketplace/i.test(result.stderr || result.stdout));
  if (failed) return failed;
  return {
    ok: true,
    stdout: results.map((result) => result.stdout).filter(Boolean).join("\n"),
    stderr: results.map((result) => result.stderr).filter(Boolean).join("\n"),
  };
}

async function stageCodexCliMarketplace(install: CodexPluginInstallReport): Promise<string> {
  try {
    const root = codexCliMarketplaceRoot(install.codexHome);
    const pluginPath = join(root, "plugins", PLUGIN_NAME);
    const manifestPath = join(root, ".agents", "plugins", "marketplace.json");
    const manifest = {
      name: CLI_MARKETPLACE_NAME,
      interface: { displayName: "MemoraX Code" },
      plugins: [pluginEntry(`./plugins/${PLUGIN_NAME}`)],
    };
    if (await fileTreeMatches(install.pluginSourcePath, pluginPath)
      && isDeepStrictEqual(await readJsonRecord(manifestPath), manifest)) return root;
    await rm(root, { recursive: true, force: true });
    await mkdir(dirname(manifestPath), { recursive: true });
    await mkdir(dirname(pluginPath), { recursive: true });
    await cp(install.pluginSourcePath, pluginPath, { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return root;
  } catch (error) {
    throw attachDeploymentFailure(error, "plugin-stage");
  }
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
  if (!found) throw attachDeploymentFailure(new Error("bundled Codex plugin source is missing .codex-plugin/plugin.json"), "discover", { failureReason: "missing_source" });
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
  await mkdir(temporaryParent, { recursive: true }).catch((error) => {
    throw attachDeploymentFailure(error, "plugin-stage");
  });
  const temporaryRoot = join(
    temporaryParent,
    `.${PLUGIN_NAME}-${process.pid}-${randomUUID()}.tmp`,
  );
  let stageError: unknown;
  try {
    await stage(temporaryRoot);
    await verifyVersionedPlugin(temporaryRoot, version);
    await mkdir(dirname(targetRoot), { recursive: true });
    await rename(temporaryRoot, targetRoot);
  } catch (error) {
    stageError = attachDeploymentFailure(error, "plugin-publish");
    throw stageError;
  } finally {
    try { await rm(temporaryRoot, { recursive: true, force: true }); }
    catch (error) {
      if (error && typeof error === "object") {
        Object.assign(error, { failure: stageError
          ? deploymentFailure(stageError, "plugin-publish", { cleanupError: error })
          : deploymentFailure(error, "cleanup") });
      }
      throw error;
    }
  }
}

async function verifyVersionedPlugin(root: string, version: string): Promise<void> {
  try {
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
  } catch (error) {
    throw attachDeploymentFailure(error, "verify", { failureReason: "verification_failed" });
  }
}

async function stagePluginSource(sourceRoot: string, targetRoot: string): Promise<void> {
  try {
    // activate also ensures installation; reuse the complete, transformed tree.
    if (await stagedPluginMatches(sourceRoot, targetRoot)) return;
    await mkdir(dirname(targetRoot), { recursive: true });
    await rm(targetRoot, { recursive: true, force: true });
    await rm(join(dirname(targetRoot), ADAPTER_COMMON_NAME), { recursive: true, force: true });
    await mkdir(targetRoot, { recursive: true });
    for (const entry of PLUGIN_SOURCE_ENTRIES) {
      await cp(join(sourceRoot, entry), join(targetRoot, entry), { recursive: true });
    }
    await stageAdapterCommonSource(sourceRoot, targetRoot);
  } catch (error) {
    throw attachDeploymentFailure(error, "plugin-stage");
  }
}

async function stagedPluginMatches(sourceRoot: string, targetRoot: string): Promise<boolean> {
  const target = await lstat(targetRoot).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!target?.isDirectory() || target.isSymbolicLink()) return false;
  const entries = (await readdir(targetRoot)).filter((name) => name !== ".memorax-code-package.json").sort();
  if (!isDeepStrictEqual(entries, [...PLUGIN_SOURCE_ENTRIES, ADAPTER_COMMON_NAME].sort())) return false;
  for (const name of PLUGIN_SOURCE_ENTRIES) {
    if (!await fileTreeMatches(join(sourceRoot, name), join(targetRoot, name), {
      transform: (path, content) => ["hooks", "runtime-hooks", "src"].includes(name) && path.endsWith(".mjs")
        ? Buffer.from(rewriteCommonImportContent(content.toString("utf8")))
        : content,
    })) return false;
  }
  return fileTreeMatches(resolve(sourceRoot, "..", ADAPTER_COMMON_NAME), join(targetRoot, ADAPTER_COMMON_NAME));
}

async function stageAdapterCommonSource(sourceRoot: string, targetRoot: string): Promise<void> {
  try {
    const commonSourceRoot = resolve(sourceRoot, "..", ADAPTER_COMMON_NAME);
    if (!existsSync(join(commonSourceRoot, "src"))) {
      throw attachDeploymentFailure(new Error(`bundled adapter common source is missing: ${commonSourceRoot}`), "runtime-stage", { failureReason: "missing_source" });
    }
    const commonTargetRoot = join(targetRoot, ADAPTER_COMMON_NAME);
    await rm(commonTargetRoot, { recursive: true, force: true });
    await cp(commonSourceRoot, commonTargetRoot, { recursive: true });
    await rewriteAdapterCommonImports(targetRoot);
  } catch (error) {
    throw attachDeploymentFailure(error, "runtime-stage");
  }
}

async function rewriteAdapterCommonImports(targetRoot: string): Promise<void> {
  for (const dir of ["hooks", "runtime-hooks", "src"]) {
    for (const path of mjsFiles(join(targetRoot, dir))) {
      const text = await readFile(path, "utf8");
      const next = rewriteCommonImportContent(text);
      if (next !== text) await writeFile(path, next, "utf8");
    }
  }
}

function rewriteCommonImportContent(text: string): string {
  return text.replaceAll("../../memorax-code-adapter-common/src/", "../memorax-code-adapter-common/src/");
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
  try {
    const normalizedCodexCommand = nonEmpty(codexCommand);
    const npmExecPath = nonEmpty(process.env.MEMORAX_CODE_NPM_EXEC_PATH);
    const metadata = {
      version: 1,
      memoraxCodeCommand: process.argv[1],
      ...(normalizedCodexCommand ? { codexCommand: normalizedCodexCommand } : {}),
      ...(npmExecPath ? { npmExecPath } : {}),
    };
    const path = join(pluginSourcePath, ".memorax-code-package.json");
    const { writtenAt: _writtenAt, ...previous } = await readJsonRecord(path) ?? {};
    if (isDeepStrictEqual(previous, metadata)) return;
    await writeFile(path, `${JSON.stringify({ ...metadata, writtenAt: new Date().toISOString() }, null, 2)}\n`, "utf8");
  } catch (error) {
    throw attachDeploymentFailure(error, "plugin-write");
  }
}

async function upsertPersonalMarketplace(marketplacePath: string, entry: MarketplaceEntry): Promise<boolean> {
  try {
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
  } catch (error) {
    throw attachDeploymentFailure(error, "plugin-register");
  }
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
  let content;
  try { content = await readFile(marketplacePath, "utf8"); }
  catch (error) { throw attachDeploymentFailure(error, "config-read"); }
  let parsed;
  try {
    parsed = JSON.parse(content);
    if (!isRecord(parsed)) throw new Error(`${marketplacePath} must contain a JSON object`);
  } catch (error) { throw attachDeploymentFailure(error, "config-parse", { failureReason: "invalid_configuration" }); }
  if (!nonEmpty(typeof parsed.name === "string" ? parsed.name : undefined)) parsed.name = "personal";
  return parsed;
}

function skippedPluginCommand(reason: string): CodexPluginCommandResult {
  return { ok: true, stdout: "", stderr: "", skipped: true, reason };
}

function parseCodexPluginList(stdout: string): {
  available: boolean;
  registered: boolean;
  enabled: boolean;
  version?: string;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("codex plugin list returned invalid JSON");
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.installed) || !Array.isArray(parsed.available)) {
    throw new Error("codex plugin list returned an invalid registry payload");
  }
  const installed = matchingPluginEntry(parsed.installed, "installed");
  const available = matchingPluginEntry(parsed.available, "available");
  if (!installed) {
    return {
      available: available !== undefined,
      registered: false,
      enabled: false,
    };
  }
  const version = typeof installed.version === "string" ? nonEmpty(installed.version) : undefined;
  if (installed.installed !== true
    || typeof installed.enabled !== "boolean"
    || !version) {
    throw new Error("codex plugin list returned an invalid MemoraX Code registration");
  }
  return {
    available: true,
    registered: true,
    enabled: installed.enabled,
    version,
  };
}

function matchingPluginEntry(entries: unknown[], collection: string): Record<string, unknown> | undefined {
  const matches = entries.filter((entry): entry is Record<string, unknown> => isRecord(entry) && (
    entry.pluginId === PLUGIN_ID
    || (entry.name === PLUGIN_NAME && entry.marketplaceName === CLI_MARKETPLACE_NAME)
  ));
  if (matches.length > 1) {
    throw new Error(`codex plugin list returned duplicate MemoraX Code ${collection} entries`);
  }
  const entry = matches[0];
  if (!entry) return undefined;
  if (entry.pluginId !== PLUGIN_ID
    || entry.name !== PLUGIN_NAME
    || entry.marketplaceName !== CLI_MARKETPLACE_NAME) {
    throw new Error(`codex plugin list returned an invalid MemoraX Code ${collection} entry`);
  }
  return entry;
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

function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number; failureStage?: string },
): Promise<CodexPluginCommandResult> {
  return new Promise((resolveResult) => {
    let invocation;
    try {
      invocation = resolveWindowsCliInvocation(command, args, { env: options.env });
    } catch (error) {
      resolveResult({
        ok: false,
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        failure: deploymentFailure(error, options.failureStage ?? "native-command", { commandResult: { error } }),
      });
      return;
    }
    let child;
    try {
      child = spawn(invocation.command, invocation.args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      throw attachDeploymentFailure(error, options.failureStage ?? "native-command", { commandResult: { error } });
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;
    const finish = (result: CodexPluginCommandResult) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolveResult(result);
    };
    if (options.timeoutMs) {
      timeout = setTimeout(() => {
        child.kill();
        finish({
          ok: false,
          stdout,
          stderr: stderr || `command timed out after ${options.timeoutMs}ms`,
          failure: deploymentFailure(undefined, options.failureStage ?? "native-command", { failureReason: "timeout" }),
        });
      }, options.timeoutMs);
    }
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => {
      finish({ ok: false, stdout, stderr: stderr || error.message,
        failure: deploymentFailure(error, options.failureStage ?? "native-command", { commandResult: { error } }),
      });
    });
    child.on("close", (code, signal) => {
      finish({ ok: code === 0, stdout, stderr,
        ...(code !== 0 ? { failure: deploymentFailure(undefined, options.failureStage ?? "native-command", { commandResult: { status: code, signal } }) } : {}),
      });
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
