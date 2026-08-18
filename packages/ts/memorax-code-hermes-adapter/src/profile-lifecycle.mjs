import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  HERMES_TESTED_VERSIONS,
  isTestedHermesVersion,
  parseHermesVersion,
} from "./hermes-version.mjs";
import {
  HOOK_EVENTS,
  allowlistContains,
  configContainsCommand,
  installHookEntries,
  listEntryCommands,
  readAllowlistApprovals,
  readConfigText,
  removeHookEntries,
  writeAllowlistApprovals,
  writeConfigText,
} from "./hermes-config.mjs";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const ADAPTER_ROOT = resolve(MODULE_DIR, "..");
const stagedCommonRoot = resolve(ADAPTER_ROOT, "../memorax-code-adapter-common/src");
const sourceCommonRoot = resolve(MODULE_DIR, "../../memorax-code-adapter-common/src");
const commonRoot = existsSync(join(stagedCommonRoot, "config-utils.mjs"))
  ? stagedCommonRoot
  : sourceCommonRoot;
const {
  atomicWriteJson,
  readAdapterState,
  withJsonFileLockAsync,
} = await import(pathToFileURL(join(commonRoot, "config-utils.mjs")).href);
const { resolveWindowsCliInvocation } = await import(
  pathToFileURL(join(commonRoot, "windows-cli-invocation.mjs")).href
);

const STATE_VERSION = 1;
const RUNTIME = "hermes";
const ADAPTER_PACKAGE_NAME = "@memorax-code/hermes-memorax-code";
const HERMES_VERSION_TIMEOUT_MS = 10_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_LIFECYCLE_LOCK_TIMEOUT_MS = 600_000;
const PACKAGE_METADATA_FILE = ".memorax-code-package.json";
const PROFILE_NAME = "default";
const BUNDLE_FILES = Object.freeze([
  PACKAGE_METADATA_FILE,
  "src/index.mjs",
  "src/profile-lifecycle.mjs",
  "src/hermes-config.mjs",
  "src/hermes-version.mjs",
  "hooks/memorax-code-hermes-hook.mjs",
  "memorax-code-adapter-common/src/backend-connection.mjs",
  "memorax-code-adapter-common/src/config-utils.mjs",
  "memorax-code-adapter-common/src/runtime-record.mjs",
  "memorax-code-adapter-common/src/windows-cli-invocation.mjs",
]);

export function collectHermesAdapterStatus(options = {}) {
  try {
    const paths = resolvePaths(options);
    const state = readAdapterState(paths.statePath);
    const stateProblem = validateState(state, paths);
    const config = readConfigText(paths.configPath);
    const installed = stateProblem
      ? false
      : hermesInstallationInstalled(state, paths, config);
    const base = {
      integration: "plugin",
      runtime: RUNTIME,
      managed: Boolean(state) && !stateProblem,
      installed,
      enabled: installed && state?.enabled === true,
      profiles: [{
        name: PROFILE_NAME,
        exists: config.missing !== true,
        managed: Boolean(state) && !stateProblem,
        installed,
      }],
    };
    if (stateProblem) {
      return { ok: false, ...base, reason: stateProblem.reason };
    }
    if (!state) {
      if (config.missing) {
        return { ok: true, ...base, skipped: true, reason: "no_existing_profiles" };
      }
      const compatibility = inspectHermesCompatibility(options, paths);
      if (compatibility.reason === "hermes_version_unavailable") {
        return {
          ok: false,
          ...base,
          compatible: false,
          reason: compatibility.reason,
        };
      }
      return {
        ok: true,
        ...base,
        version: compatibility.hermesVersion,
        compatible: true,
        hermesVersionTested: compatibility.hermesVersionTested,
        testedHermesVersions: [...HERMES_TESTED_VERSIONS],
        skipped: true,
        reason: "not_managed",
      };
    }
    const compatibility = inspectHermesCompatibility(options, paths, state);
    if (compatibility.reason === "hermes_version_unavailable") {
      return {
        ok: false,
        ...base,
        compatible: false,
        reason: compatibility.reason,
      };
    }
    return {
      ok: true,
      ...base,
      enabled: state.enabled === true && installed,
      version: compatibility.hermesVersion,
      compatible: true,
      hermesVersionTested: compatibility.hermesVersionTested,
      testedHermesVersions: [...HERMES_TESTED_VERSIONS],
      revision: state.updatedAt,
      ...(state.enabled !== true
        ? { reason: "disabled" }
        : !installed
          ? { reason: "profile_drift" }
          : {}),
    };
  } catch {
    return {
      ok: false,
      integration: "plugin",
      runtime: RUNTIME,
      managed: false,
      installed: false,
      enabled: false,
      profiles: [{ name: PROFILE_NAME, exists: false, managed: false, installed: false }],
      reason: "hermes_status_unavailable",
    };
  }
}

/**
 * Serialize one Hermes lifecycle command with adapter recovery and Hermes
 * state mutation. The callback must use the supplied unlocked operations only.
 */
export function withHermesPluginLifecycleLock(options = {}, operation) {
  if (typeof operation !== "function") {
    throw new TypeError("Hermes lifecycle lock requires an operation");
  }
  const paths = resolvePaths(options);
  return withJsonFileLockAsync(paths.statePath, () => operation(Object.freeze({
    status: () => readHermesPluginStatusUnlocked(paths, options),
    ensureInstalled: (overrides = {}) => ensureHermesPluginInstalledUnlocked(
      paths,
      { ...options, ...overrides },
    ),
    activate: () => activateHermesPluginInstallationUnlocked(paths, options),
    quiesce: () => quiesceHermesPluginInstallationUnlocked(paths),
    disable: () => disableHermesPluginInstallationUnlocked(paths, options, false),
    remove: () => disableHermesPluginInstallationUnlocked(paths, options, true),
  })), {
    timeoutMs: DEFAULT_LIFECYCLE_LOCK_TIMEOUT_MS,
  });
}

function readHermesPluginStatusUnlocked(paths, options) {
  const state = readAdapterState(paths.statePath);
  const stateProblem = validateState(state, paths);
  if (stateProblem) return { ...stateProblem, action: "hermes-plugin-status" };
  if (!state) return notManaged(paths, "hermes-plugin-status");
  const config = readConfigText(paths.configPath);
  const installed = hermesInstallationInstalled(state, paths, config);
  return {
    ok: true,
    action: "hermes-plugin-status",
    runtime: RUNTIME,
    installed,
    enabled: state.enabled === true && installed,
    managed: true,
    authorityEnabled: state.enabled === true,
    revision: state.updatedAt,
    profiles: [{
      name: PROFILE_NAME,
      exists: config.missing !== true,
      managed: true,
      installed,
    }],
  };
}

function ensureHermesPluginInstalledUnlocked(paths, options) {
  const state = readAdapterState(paths.statePath);
  const stateProblem = validateState(state, paths);
  if (stateProblem) return { ...stateProblem, action: "hermes-plugin-install" };

  const config = readConfigText(paths.configPath);
  if (config.missing) {
    if (state) atomicWriteJson(paths.statePath, disabledState(state, []));
    return {
      ok: !state,
      action: "hermes-plugin-install",
      runtime: RUNTIME,
      installed: false,
      enabled: false,
      managed: Boolean(state),
      ...(!state ? { skipped: true } : {}),
      reason: "no_existing_profiles",
      detectedProfiles: [],
    };
  }
  if (config.unreadable) {
    return {
      ok: false,
      action: "hermes-plugin-install",
      runtime: RUNTIME,
      reason: "hermes_config_unreadable",
      configPath: paths.configPath,
    };
  }

  const hermesCommand = resolveHermesCommand(options, state);
  const compatibility = inspectHermesCompatibility(options, paths, state, hermesCommand);
  if (compatibility.reason === "hermes_version_unavailable") {
    return {
      ok: false,
      action: "hermes-plugin-install",
      runtime: RUNTIME,
      installed: false,
      enabled: false,
      managed: Boolean(state),
      detectedProfiles: [PROFILE_NAME],
      compatible: false,
      reason: compatibility.reason,
    };
  }

  const metadata = {
    version: 1,
    runtime: RUNTIME,
    memoraxCodeCommand: resolveMemoraxCodeCommand(options.memoraxCodeCommand),
    memoraxCodeHome: paths.memoraxCodeHome,
    hermesHome: paths.hermesHome,
    hermesCommand,
    hermesVersion: compatibility.hermesVersion,
    sourceAdapterRoot: paths.adapterRoot,
  };
  const runtimeBundleRoot = materializeRuntimeBundle(paths, metadata);
  const command = hookCommand(runtimeBundleRoot);
  const configResult = replaceAdapterHookEntries(config.text, command, paths.runtimeRoot);
  if (configResult.error) {
    return {
      ok: false,
      action: "hermes-plugin-install",
      runtime: RUNTIME,
      reason: configResult.error,
      configPath: paths.configPath,
    };
  }
  const nextConfig = configResult;

  const now = new Date().toISOString();
  const pendingState = {
    version: STATE_VERSION,
    runtime: RUNTIME,
    integration: "plugin",
    enabled: false,
    hermesHome: paths.hermesHome,
    memoraxCodeHome: paths.memoraxCodeHome,
    adapterRoot: paths.adapterRoot,
    runtimeBundleRoot,
    command,
    memoraxCodeCommand: metadata.memoraxCodeCommand,
    hermesCommand,
    hermesVersion: compatibility.hermesVersion,
    updatedAt: now,
  };
  atomicWriteJson(paths.statePath, pendingState);

  if (nextConfig.changed) {
    try {
      writeConfigText(paths.configPath, nextConfig.text);
    } catch (error) {
      rmSync(runtimeBundleRoot, { recursive: true, force: true });
      return {
        ok: false,
        action: "hermes-plugin-install",
        runtime: RUNTIME,
        reason: "hermes_config_unwritable",
        configPath: paths.configPath,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const allowlistPath = paths.allowlistPath;
  const approvals = readAllowlistApprovals(allowlistPath);
  const missingApprovals = HOOK_EVENTS.filter((event) => (
    !allowlistContains(approvals, event, command)
  ));
  if (missingApprovals.length > 0) {
    try {
      writeAllowlistApprovals(allowlistPath, [
        ...approvals.filter((entry) => (
          !HOOK_EVENTS.some((event) => allowlistContains([entry], event, command))
        )),
        ...HOOK_EVENTS.map((event) => ({ event, command })),
      ]);
    } catch (error) {
      return {
        ok: false,
        action: "hermes-plugin-install",
        runtime: RUNTIME,
        reason: "hermes_allowlist_unwritable",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const enabled = options.enabled !== false;
  const nextState = {
    ...pendingState,
    enabled,
    updatedAt: new Date().toISOString(),
  };
  atomicWriteJson(paths.statePath, nextState);
  cleanupRuntimeGenerations(paths.runtimeRoot, runtimeBundleRoot);

  return {
    ok: true,
    action: "hermes-plugin-install",
    runtime: RUNTIME,
    installed: true,
    enabled,
    managed: true,
    detectedProfiles: [PROFILE_NAME],
    installedProfiles: [PROFILE_NAME],
    version: compatibility.hermesVersion,
    compatible: true,
    hermesVersionTested: compatibility.hermesVersionTested,
    testedHermesVersions: [...HERMES_TESTED_VERSIONS],
    command,
    configPath: paths.configPath,
    hookPath: join(runtimeBundleRoot, "hooks", "memorax-code-hermes-hook.mjs"),
  };
}

function activateHermesPluginInstallationUnlocked(paths, options) {
  const state = readAdapterState(paths.statePath);
  const stateProblem = validateState(state, paths);
  if (stateProblem) return { ...stateProblem, action: "hermes-plugin-activate" };
  if (!state) return notManaged(paths, "hermes-plugin-activate");
  const config = readConfigText(paths.configPath);
  if (!hermesInstallationInstalled(state, paths, config)) {
    return {
      ok: false,
      action: "hermes-plugin-activate",
      runtime: RUNTIME,
      reason: "managed_profiles_not_installed",
    };
  }
  const nextState = { ...state, enabled: true, updatedAt: new Date().toISOString() };
  atomicWriteJson(paths.statePath, nextState);
  return {
    ok: true,
    action: "hermes-plugin-activate",
    runtime: RUNTIME,
    installed: true,
    enabled: true,
    managed: true,
    profiles: [{ name: PROFILE_NAME, exists: true, managed: true, installed: true }],
  };
}

function quiesceHermesPluginInstallationUnlocked(paths) {
  const state = readAdapterState(paths.statePath);
  const stateProblem = validateState(state, paths);
  if (stateProblem) return { ...stateProblem, action: "hermes-plugin-quiesce" };
  if (!state) return notManaged(paths, "hermes-plugin-quiesce");
  const nextState = disabledState(state, [PROFILE_NAME]);
  atomicWriteJson(paths.statePath, nextState);
  return {
    ok: true,
    action: "hermes-plugin-quiesce",
    runtime: RUNTIME,
    installed: true,
    enabled: false,
    managed: true,
    authorityEnabled: false,
    previouslyEnabled: state.enabled === true,
    revision: nextState.updatedAt,
    profiles: [{ name: PROFILE_NAME, exists: true, managed: true, installed: true }],
  };
}

function disableHermesPluginInstallationUnlocked(paths, options, removeState) {
  const state = readAdapterState(paths.statePath);
  const action = removeState ? "hermes-plugin-remove" : "hermes-plugin-disable";
  const stateProblem = validateState(state, paths);
  if (stateProblem) return { ...stateProblem, action };
  if (!state) return notManaged(paths, action);

  const config = readConfigText(paths.configPath);
  if (!config.missing && !config.unreadable) {
    const removed = removeHookEntries(config.text, state.command);
    if (removed.changed) {
      try {
        writeConfigText(paths.configPath, removed.text);
      } catch (error) {
        return {
          ok: false,
          action,
          runtime: RUNTIME,
          reason: "hermes_config_unwritable",
          configPath: paths.configPath,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  }

  const approvals = readAllowlistApprovals(paths.allowlistPath);
  const retainedApprovals = approvals.filter((entry) => (
    !HOOK_EVENTS.some((event) => allowlistContains([entry], event, state.command))
  ));
  if (retainedApprovals.length !== approvals.length) {
    try {
      writeAllowlistApprovals(paths.allowlistPath, retainedApprovals);
    } catch (error) {
      return {
        ok: false,
        action,
        runtime: RUNTIME,
        reason: "hermes_allowlist_unwritable",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (removeState) {
    rmSync(paths.statePath, { force: true });
    rmSync(paths.runtimeRoot, { recursive: true, force: true });
  } else {
    atomicWriteJson(paths.statePath, disabledState(state, [PROFILE_NAME]));
  }
  return {
    ok: true,
    action,
    runtime: RUNTIME,
    removed: removeState,
    installed: false,
    enabled: false,
    managed: !removeState,
    removedProfiles: [PROFILE_NAME],
    ...(config.missing ? { reason: "no_existing_profiles" } : {}),
  };
}

function hermesInstallationInstalled(state, paths, config) {
  if (!state || !config || config.missing || config.unreadable) return false;
  if (!nonEmpty(state.command)
    || !nonEmpty(state.runtimeBundleRoot)
    || !isPathInside(state.runtimeBundleRoot, paths.runtimeRoot)) return false;
  if (!configContainsCommand(config.text, state.command)) return false;
  const approvals = readAllowlistApprovals(paths.allowlistPath);
  if (!HOOK_EVENTS.every((event) => allowlistContains(approvals, event, state.command))) {
    return false;
  }
  if (!lstatSyncQuietDirectory(state.runtimeBundleRoot)) return false;
  try {
    const metadata = readJsonObject(join(state.runtimeBundleRoot, PACKAGE_METADATA_FILE));
    if (!metadata || metadata.runtime !== RUNTIME || metadata.runtimeBundleRoot !== state.runtimeBundleRoot) {
      return false;
    }
    return existsSync(join(state.runtimeBundleRoot, "hooks", "memorax-code-hermes-hook.mjs"));
  } catch {
    return false;
  }
}

function materializeRuntimeBundle(paths, metadata) {
  const manifest = readJsonObject(join(paths.adapterRoot, "package.json"));
  if (manifest?.name !== ADAPTER_PACKAGE_NAME
    || !nonEmpty(manifest.version)
    || manifest.main !== "src/index.mjs"
    || !isDeepStrictEqual(manifest.exports, { ".": "./src/index.mjs" })
    || !isDeepStrictEqual([...manifest.files].sort(), [...BUNDLE_FILES].sort())) {
    throw new Error("MemoraX Code Hermes adapter source manifest is invalid");
  }

  const sourceFiles = BUNDLE_FILES
    .filter((relativePath) => relativePath !== PACKAGE_METADATA_FILE)
    .map((relativePath) => {
      const path = bundleSourcePath(paths, relativePath);
      if (!lstatSync(path).isFile()) {
        throw new Error(`MemoraX Code Hermes runtime source is not a file: ${relativePath}`);
      }
      return { relativePath, path, content: readFileSync(path) };
    });
  const generation = runtimeGenerationId(metadata, sourceFiles);
  const runtimeBundleRoot = join(paths.runtimeRoot, generation);
  const runtimeMetadata = { ...metadata, runtimeBundleRoot };
  if (runtimeBundleMatches(runtimeBundleRoot, runtimeMetadata, sourceFiles)) {
    return runtimeBundleRoot;
  }

  mkdirSync(paths.runtimeRoot, { recursive: true, mode: 0o700 });
  rmSync(runtimeBundleRoot, { recursive: true, force: true });
  const temporaryRoot = join(paths.runtimeRoot, `.${generation}.${randomUUID()}.tmp`);
  try {
    mkdirSync(temporaryRoot, { mode: 0o700 });
    for (const { relativePath, path: sourcePath } of sourceFiles) {
      const destinationPath = join(temporaryRoot, relativePath);
      mkdirSync(dirname(destinationPath), { recursive: true, mode: 0o700 });
      copyFileSync(sourcePath, destinationPath);
    }
    atomicWriteJson(join(temporaryRoot, PACKAGE_METADATA_FILE), runtimeMetadata);
    renameSync(temporaryRoot, runtimeBundleRoot);
    return runtimeBundleRoot;
  } catch (error) {
    rmSync(temporaryRoot, { recursive: true, force: true });
    throw error;
  }
}

function runtimeGenerationId(metadata, sourceFiles) {
  const hash = createHash("sha256");
  hash.update(JSON.stringify(metadata));
  for (const { relativePath, content } of sourceFiles) {
    hash.update("\0");
    hash.update(relativePath);
    hash.update("\0");
    hash.update(content);
  }
  return hash.digest("hex");
}

function runtimeBundleMatches(root, metadata, sourceFiles) {
  try {
    if (!lstatSync(root).isDirectory()
      || !isDeepStrictEqual(readJsonObject(join(root, PACKAGE_METADATA_FILE)), metadata)) {
      return false;
    }
    return sourceFiles.every(({ relativePath, content }) => {
      const path = join(root, relativePath);
      return lstatSync(path).isFile() && readFileSync(path).equals(content);
    });
  } catch {
    return false;
  }
}

function bundleSourcePath(paths, relativePath) {
  const commonPrefix = "memorax-code-adapter-common/src/";
  if (relativePath.startsWith(commonPrefix)) {
    return join(commonRoot, relativePath.slice(commonPrefix.length));
  }
  return join(paths.adapterRoot, relativePath);
}

function replaceAdapterHookEntries(config, command, runtimeRoot) {
  const staleCommands = listEntryCommands(config).filter((candidate) => (
    candidate !== command && adapterOwnedHookCommand(candidate, runtimeRoot)
  ));
  let text = config;
  let changed = false;
  for (const stale of staleCommands) {
    const removed = removeHookEntries(text, stale);
    if (removed.error) return removed;
    if (removed.changed) {
      text = removed.text;
      changed = true;
    }
  }
  const installed = installHookEntries(text, command);
  if (installed.error) return installed;
  return { text: installed.text, changed: changed || installed.changed };
}

function adapterOwnedHookCommand(command, runtimeRoot) {
  const marker = join("hooks", "memorax-code-hermes-hook.mjs");
  const index = command.indexOf(marker);
  if (index === -1 || index === 0) return false;
  let start = index;
  while (start > 0 && command[start - 1] !== '"' && command[start - 1] !== "'") start -= 1;
  const hookPath = command.slice(start).trim().replace(/^["']|["']$/g, "");
  const bundleRoot = resolve(dirname(hookPath), "..");
  return isPathInside(bundleRoot, runtimeRoot);
}

function cleanupRuntimeGenerations(runtimeRoot, activeRoot) {
  let entries;
  try {
    entries = readdirSync(runtimeRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = resolve(runtimeRoot, entry.name);
    if (candidate === resolve(activeRoot)) continue;
    try {
      rmSync(candidate, { recursive: true, force: true });
    } catch {
      // The active generation is authoritative; stale cleanup is best effort.
    }
  }
}

function resolvePaths(options) {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const memoraxCodeHome = resolveHomePath(
    options.memoraxCodeHome ?? nonEmpty(env.MEMORAX_CODE_HOME) ?? join(homeDir, ".memorax-code"),
    homeDir,
  );
  const adapterRoot = resolve(options.adapterRoot ?? ADAPTER_ROOT);
  const statePath = join(memoraxCodeHome, "adapters", RUNTIME, "state.json");
  const runtimeRoot = join(memoraxCodeHome, "adapters", RUNTIME, "runtime", "generations");
  const configuredHermesHome = options.hermesHome ?? nonEmpty(env.HERMES_HOME);
  const hermesHome = configuredHermesHome === undefined
    ? persistedHermesHome({ statePath, memoraxCodeHome, adapterRoot, runtimeRoot }, homeDir)
      ?? resolveHomePath(join(homeDir, ".hermes"), homeDir)
    : resolveHomePath(configuredHermesHome, homeDir);
  return {
    env,
    hermesHome,
    memoraxCodeHome,
    adapterRoot,
    runtimeRoot,
    configPath: join(hermesHome, "config.yaml"),
    allowlistPath: join(hermesHome, "shell-hooks-allowlist.json"),
    statePath,
  };
}

function persistedHermesHome(paths, homeDir) {
  const state = readAdapterState(paths.statePath);
  const value = nonEmpty(state?.hermesHome);
  if (!value) return undefined;
  const hermesHome = resolveHomePath(value, homeDir);
  return validateState(state, { ...paths, hermesHome }) === undefined
    ? hermesHome
    : undefined;
}

function validateState(state, paths) {
  if (!state) return undefined;
  if (state.unreadable) {
    return { ok: false, runtime: RUNTIME, reason: "state_unreadable", statePath: paths.statePath };
  }
  if (state.version !== STATE_VERSION
    || state.runtime !== RUNTIME
    || state.integration !== "plugin"
    || typeof state.enabled !== "boolean"
    || resolve(state.hermesHome ?? "") !== paths.hermesHome
    || resolve(state.memoraxCodeHome ?? "") !== paths.memoraxCodeHome
    || typeof state.adapterRoot !== "string"
    || !isPathInside(state.runtimeBundleRoot, paths.runtimeRoot)
    || typeof state.command !== "string"
    || !nonEmpty(state.command)
    || !timestampString(state.updatedAt)) {
    return { ok: false, runtime: RUNTIME, reason: "state_invalid", statePath: paths.statePath };
  }
  return undefined;
}

function disabledState(state, profiles) {
  return {
    ...state,
    enabled: false,
    profiles,
    updatedAt: new Date().toISOString(),
  };
}

function notManaged(paths, action) {
  return {
    ok: true,
    action,
    runtime: RUNTIME,
    installed: false,
    enabled: false,
    managed: false,
    skipped: true,
    reason: "not_managed",
  };
}

function resolveMemoraxCodeCommand(value) {
  const configured = nonEmpty(value);
  const stagedCommand = resolve(ADAPTER_ROOT, "..", "..", "bin", "memorax-code.mjs");
  const sourceCommand = resolve(
    ADAPTER_ROOT,
    "..",
    "..",
    "npm",
    "memorax-code",
    "bin",
    "memorax-code.mjs",
  );
  return configured && !configured.includes("/") && !configured.includes("\\")
    ? configured
    : resolve(configured ?? (existsSync(stagedCommand) ? stagedCommand : sourceCommand));
}

function resolveHermesCommand(options, state) {
  const command = nonEmpty(options.hermesCommand)
    ?? nonEmpty(options.env?.MEMORAX_CODE_HERMES_COMMAND)
    ?? nonEmpty(state?.hermesCommand)
    ?? "hermes";
  return command.includes("/") || command.includes("\\") ? resolve(command) : command;
}

function runHermes(options, paths, args, command) {
  const env = { ...paths.env, HERMES_HOME: paths.hermesHome };
  let executable;
  try {
    executable = resolveWindowsCliInvocation(command, args, {
      ...options.windowsCliResolution,
      env,
    });
  } catch (error) {
    return { status: 1, error };
  }
  const invocation = {
    command: executable.command,
    args: executable.args,
    cwd: existsSync(paths.adapterRoot) ? paths.adapterRoot : paths.hermesHome,
    env,
    timeout: args.length === 1 && args[0] === "--version"
      ? HERMES_VERSION_TIMEOUT_MS
      : DEFAULT_COMMAND_TIMEOUT_MS,
  };
  if (typeof options.runHermes === "function") {
    try {
      return options.runHermes(invocation) ?? { status: 1 };
    } catch (error) {
      return { status: 1, error };
    }
  }
  return spawnSync(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: invocation.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: invocation.timeout,
    windowsHide: true,
  });
}

function inspectHermesCompatibility(options, paths, state, commandOverride) {
  const command = commandOverride ?? resolveHermesCommand(options, state);
  const result = runHermes(options, paths, ["--version"], command);
  if (result.status !== 0 || result.error) {
    return {
      compatible: false,
      reason: "hermes_version_unavailable",
      testedHermesVersions: [...HERMES_TESTED_VERSIONS],
    };
  }
  const output = parseHermesVersion(result.stdout);
  if (!output) {
    return {
      compatible: false,
      reason: "hermes_version_unavailable",
      testedHermesVersions: [...HERMES_TESTED_VERSIONS],
    };
  }
  return {
    compatible: true,
    hermesVersion: output,
    hermesVersionTested: isTestedHermesVersion(output),
    testedHermesVersions: [...HERMES_TESTED_VERSIONS],
  };
}

function hookCommand(runtimeBundleRoot) {
  const hookPath = join(runtimeBundleRoot, "hooks", "memorax-code-hermes-hook.mjs");
  return `"${process.execPath}" "${hookPath}"`;
}

function readJsonObject(path) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function lstatSyncQuietDirectory(path) {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function resolveHomePath(value, homeDir) {
  const normalized = String(value);
  if (normalized === "~") return resolve(homeDir);
  if (normalized.startsWith("~/") || normalized.startsWith("~\\")) {
    return resolve(homeDir, normalized.slice(2));
  }
  return resolve(normalized);
}

function nonEmpty(value) {
  const normalized = String(value ?? "").trim();
  return normalized || undefined;
}

function timestampString(value) {
  const normalized = nonEmpty(value);
  return normalized && Number.isFinite(Date.parse(normalized)) ? normalized : undefined;
}

function isPathInside(value, parent) {
  if (typeof value !== "string" || !value.trim()) return false;
  const child = relative(resolve(parent), resolve(value));
  return child !== ""
    && child !== ".."
    && !child.startsWith(`..${sep}`)
    && !isAbsolute(child);
}
