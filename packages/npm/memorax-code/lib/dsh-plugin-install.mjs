import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveWindowsCliInvocation } from "./windows-cli-invocation.mjs";

const PACKAGE_LIB = dirname(fileURLToPath(import.meta.url));
const stagedCommon = join(PACKAGE_LIB, "memorax-code-adapter-common", "src", "config-utils.mjs");
const sourceCommon = resolve(PACKAGE_LIB, "../../../ts/memorax-code-adapter-common/src/config-utils.mjs");
const {
  atomicWriteJson,
  readAdapterState,
  withJsonFileLockAsync,
} = await import(pathToFileURL(existsSync(stagedCommon) ? stagedCommon : sourceCommon).href);

const STATE_VERSION = 1;
const RUNTIME = "dsh";
const ADAPTER_PACKAGE_NAME = "@memorax-code/dsh-adapter";
const DSH_SUPPORTED_VERSIONS = Object.freeze(["0.1.0-rc.6"]);
const DSH_SUPPORTED_VERSION_SET = new Set(DSH_SUPPORTED_VERSIONS);
const DSH_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const DSH_VERSION_MAX_LENGTH = 128;
const DSH_VERSION_TIMEOUT_MS = 10_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_LIFECYCLE_LOCK_TIMEOUT_MS = 600_000;

export function discoverDshProfiles(options = {}) {
  const paths = resolvePaths(options);
  let entries;
  try {
    entries = readdirSync(paths.profilesRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && validProfileName(entry.name))
    .map((entry) => readProfile(entry.name, join(paths.profilesRoot, entry.name)))
    .filter(Boolean)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function collectDshAdapterStatus(options = {}) {
  try {
    const paths = resolvePaths(options);
    const state = readAdapterState(paths.statePath);
    const stateProblem = validateState(state, paths);
    const discoveredProfiles = discoverDshProfiles({ ...options, dshHome: paths.dshHome });
    const managedNames = new Set(stateProblem ? [] : state?.profiles ?? []);
    const profiles = projectProfileStatus(discoveredProfiles, managedNames, true);
    const managed = Boolean(state) && !stateProblem;
    const installed = profiles.length > 0
      && profiles.every((profile) => profile.managed && profile.exists && profile.installed);
    const base = {
      integration: "plugin",
      managed,
      installed,
      enabled: false,
      profiles,
    };
    if (stateProblem) {
      return { ok: false, ...base, reason: stateProblem.reason };
    }
    if (!state && profiles.length === 0) {
      return { ok: true, ...base, skipped: true, reason: "no_existing_profiles" };
    }

    const dshCommand = resolveDshCommand(options, paths, state);
    const compatibility = inspectDshCompatibility(options, paths, dshCommand);
    const version = compatibility.dshVersion;
    if (compatibility.reason === "dsh_version_unavailable") {
      return {
        ok: false,
        ...base,
        compatible: false,
        reason: compatibility.reason,
      };
    }
    if (compatibility.compatible !== true) {
      return {
        ok: true,
        ...base,
        ...(version ? { version } : {}),
        compatible: false,
        skipped: true,
        reason: compatibility.reason,
      };
    }
    if (!state) {
      return {
        ok: true,
        ...base,
        version,
        compatible: true,
        skipped: true,
        reason: "not_managed",
      };
    }
    return {
      ok: true,
      ...base,
      enabled: state.enabled === true && installed,
      version,
      compatible: true,
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
      managed: false,
      installed: false,
      enabled: false,
      profiles: [],
      reason: "dsh_status_unavailable",
    };
  }
}

/**
 * Serialize one product lifecycle command with adapter recovery and DSH state
 * mutation. The callback must use the supplied unlocked operations only.
 */
export function withDshPluginLifecycleLock(options = {}, operation) {
  if (typeof operation !== "function") {
    throw new TypeError("DSH lifecycle lock requires an operation");
  }
  const paths = resolvePaths(options);
  return withJsonFileLockAsync(paths.statePath, () => operation(Object.freeze({
    discoverProfiles: () => discoverDshProfiles({ ...options, dshHome: paths.dshHome }),
    status: () => readDshPluginStatusUnlocked(paths, options),
    ensureInstalled: (overrides = {}) => ensureDshPluginInstalledUnlocked(
      paths,
      { ...options, ...overrides },
    ),
    activate: (overrides = {}) => activateDshPluginInstallationUnlocked(
      paths,
      { ...options, ...overrides },
    ),
    disable: (overrides = {}) => disableDshPluginInstallationUnlocked(
      paths,
      { ...options, ...overrides },
      false,
    ),
    remove: (overrides = {}) => disableDshPluginInstallationUnlocked(
      paths,
      { ...options, ...overrides },
      true,
    ),
  })), {
    timeoutMs: DEFAULT_LIFECYCLE_LOCK_TIMEOUT_MS,
  });
}

function readDshPluginStatusUnlocked(paths, options) {
  const state = readAdapterState(paths.statePath);
  const stateProblem = validateState(state, paths);
  if (stateProblem) return { ...stateProblem, action: "dsh-plugin-status" };
  if (!state) {
    return {
      ok: true,
      action: "dsh-plugin-status",
      runtime: RUNTIME,
      installed: false,
      enabled: false,
      managed: false,
      profiles: [],
    };
  }

  const profiles = discoverDshProfiles({ ...options, dshHome: paths.dshHome });
  const managedProfiles = projectProfileStatus(profiles, new Set(state.profiles), false);
  const installed = state.profiles.length > 0
    && managedProfiles.every((profile) => profile.installed);
  return {
    ok: true,
    action: "dsh-plugin-status",
    runtime: RUNTIME,
    installed,
    enabled: state.enabled === true && installed,
    managed: true,
    authorityEnabled: state.enabled === true,
    revision: state.updatedAt,
    profiles: managedProfiles,
  };
}

function ensureDshPluginInstalledUnlocked(paths, options) {
  const state = readAdapterState(paths.statePath);
  const stateProblem = validateState(state, paths);
  if (stateProblem) return { ...stateProblem, action: "dsh-plugin-install" };

  const profiles = discoverDshProfiles({ ...options, dshHome: paths.dshHome });
  if (profiles.length === 0) {
    if (state) atomicWriteJson(paths.statePath, disabledState(state, []));
    return {
      ok: true,
      action: "dsh-plugin-install",
      runtime: RUNTIME,
      installed: false,
      enabled: false,
      managed: Boolean(state),
      skipped: true,
      reason: "no_existing_profiles",
      detectedProfiles: [],
    };
  }

  const dshCommand = resolveDshCommand(options, paths, state);
  const compatibility = inspectDshCompatibility(options, paths, dshCommand);
  if (compatibility.compatible !== true) {
    const nextState = state?.enabled === true
      ? disabledState(state, state.profiles)
      : state;
    if (nextState && nextState !== state) atomicWriteJson(paths.statePath, nextState);
    return {
      ok: true,
      action: "dsh-plugin-install",
      runtime: RUNTIME,
      installed: false,
      enabled: false,
      managed: Boolean(state),
      skipped: true,
      detectedProfiles: profiles.map((profile) => profile.name),
      ...compatibility,
    };
  }

  const previouslyManaged = new Set(state?.profiles ?? []);
  const conflicts = profiles
    .filter((profile) => profileMentionsAdapter(profile) && !previouslyManaged.has(profile.name))
    .map((profile) => profile.name);
  if (conflicts.length > 0) {
    return {
      ok: false,
      action: "dsh-plugin-install",
      runtime: RUNTIME,
      reason: "profile_plugin_conflict",
      profiles: conflicts,
    };
  }

  const memoraxCodeCommand = resolveMemoraxCodeCommand(options.memoraxCodeCommand);
  atomicWriteJson(join(paths.adapterRoot, ".memorax-code-package.json"), {
    version: 1,
    memoraxCodeCommand,
    memoraxCodeHome: paths.memoraxCodeHome,
    dshHome: paths.dshHome,
    dshCommand,
    dshVersion: compatibility.dshVersion,
    sourceAdapterRoot: paths.adapterRoot,
  });

  const now = new Date().toISOString();
  const pendingState = {
    version: STATE_VERSION,
    runtime: RUNTIME,
    integration: "plugin",
    enabled: false,
    dshHome: paths.dshHome,
    memoraxCodeHome: paths.memoraxCodeHome,
    adapterRoot: paths.adapterRoot,
    memoraxCodeCommand,
    dshCommand,
    dshVersion: compatibility.dshVersion,
    // Claim each target before invoking DSH so an interrupted or partially
    // successful native add remains repairable and removable on the next run.
    profiles: profiles.map((profile) => profile.name).sort(),
    updatedAt: now,
  };
  atomicWriteJson(paths.statePath, pendingState);

  const installedProfiles = [];
  const failedProfiles = [];
  for (const profile of profiles) {
    if (!readProfile(profile.name, profile.path)) {
      failedProfiles.push({ name: profile.name, reason: "profile_disappeared" });
      continue;
    }
    const result = runDsh(options, paths, [
      "plugin",
      "--profile",
      profile.name,
      "add",
      `file:${paths.adapterRoot}`,
    ], dshCommand);
    const installed = result.status === 0
      && !result.error
      && profileHasAdapter(readProfile(profile.name, profile.path));
    if (installed) installedProfiles.push(profile.name);
    else failedProfiles.push(commandFailure(
      profile.name,
      result,
      result.status === 0 ? "dsh_bundle_not_activated" : undefined,
    ));
  }

  const currentProfiles = discoverDshProfiles({ ...options, dshHome: paths.dshHome });
  const pendingProfiles = new Set(pendingState.profiles);
  const managedProfiles = currentProfiles
    .filter((profile) => pendingProfiles.has(profile.name))
    .map((profile) => profile.name)
    .sort();
  const enabled = options.enabled !== false
    && failedProfiles.length === 0
    && managedProfiles.length > 0;
  const nextState = {
    ...pendingState,
    enabled,
    profiles: managedProfiles,
    updatedAt: new Date().toISOString(),
  };
  atomicWriteJson(paths.statePath, nextState);

  return {
    ok: failedProfiles.length === 0,
    action: "dsh-plugin-install",
    runtime: RUNTIME,
    installed: failedProfiles.length === 0 && managedProfiles.length > 0,
    enabled,
    managed: true,
    detectedProfiles: profiles.map((profile) => profile.name),
    dshVersion: compatibility.dshVersion,
    supportedDshVersions: [...DSH_SUPPORTED_VERSIONS],
    installedProfiles,
    failedProfiles,
  };
}

function activateDshPluginInstallationUnlocked(paths, options) {
  const state = readAdapterState(paths.statePath);
  const stateProblem = validateState(state, paths);
  if (stateProblem) return { ...stateProblem, action: "dsh-plugin-activate" };
  if (!state) return notManaged(paths, "dsh-plugin-activate");
  if (!DSH_SUPPORTED_VERSION_SET.has(state.dshVersion)) {
    return {
      ok: false,
      action: "dsh-plugin-activate",
      runtime: RUNTIME,
      reason: "dsh_version_not_verified",
    };
  }
  const profiles = discoverDshProfiles({ ...options, dshHome: paths.dshHome });
  const profileByName = new Map(profiles.map((profile) => [profile.name, profile]));
  if (state.profiles.length === 0
    || state.profiles.some((name) => !profileHasAdapter(profileByName.get(name)))) {
    return {
      ok: false,
      action: "dsh-plugin-activate",
      runtime: RUNTIME,
      reason: "managed_profiles_not_installed",
    };
  }
  const nextState = { ...state, enabled: true, updatedAt: new Date().toISOString() };
  atomicWriteJson(paths.statePath, nextState);
  return {
    ok: true,
    action: "dsh-plugin-activate",
    runtime: RUNTIME,
    installed: true,
    enabled: true,
    managed: true,
    profiles: [...state.profiles],
  };
}

function disableDshPluginInstallationUnlocked(paths, options, removeState) {
  const state = readAdapterState(paths.statePath);
  const action = removeState ? "dsh-plugin-remove" : "dsh-plugin-disable";
  const stateProblem = validateState(state, paths);
  if (stateProblem) return { ...stateProblem, action };
  if (!state) return notManaged(paths, action);

  const disabled = disabledState(state, state.profiles);
  atomicWriteJson(paths.statePath, disabled);
  const dshCommand = resolveDshCommand(options, paths, state);
  const profiles = discoverDshProfiles({ ...options, dshHome: paths.dshHome });
  const profileByName = new Map(profiles.map((profile) => [profile.name, profile]));
  const removedProfiles = [];
  const failedProfiles = [];
  for (const name of state.profiles) {
    const profile = profileByName.get(name);
    if (!profile || !profileMentionsAdapter(profile)) {
      removedProfiles.push(name);
      continue;
    }
    const result = runDsh(
      options,
      paths,
      ["plugin", "--profile", name, "remove", ADAPTER_PACKAGE_NAME],
      dshCommand,
    );
    const removed = result.status === 0
      && !result.error
      && !profileMentionsAdapter(readProfile(name, profile.path));
    if (removed) removedProfiles.push(name);
    else failedProfiles.push(commandFailure(
      name,
      result,
      result.status === 0 ? "dsh_bundle_not_removed" : undefined,
    ));
  }

  if (failedProfiles.length > 0) {
    atomicWriteJson(paths.statePath, disabledState(disabled, failedProfiles.map((profile) => profile.name).sort()));
    return {
      ok: false,
      action,
      runtime: RUNTIME,
      enabled: false,
      removedProfiles,
      failedProfiles,
    };
  }

  if (removeState) rmSync(paths.statePath, { force: true });
  else atomicWriteJson(paths.statePath, disabledState(disabled, []));
  return {
    ok: true,
    action,
    runtime: RUNTIME,
    removed: removeState,
    installed: false,
    enabled: false,
    managed: !removeState,
    removedProfiles,
  };
}

function resolvePaths(options) {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const memoraxCodeHome = resolveHomePath(
    options.memoraxCodeHome ?? nonEmpty(env.MEMORAX_CODE_HOME) ?? join(homeDir, ".memorax-code"),
    homeDir,
  );
  const adapterRoot = resolve(options.adapterRoot ?? join(PACKAGE_LIB, "memorax-code-dsh-adapter"));
  const statePath = resolve(options.statePath ?? join(memoraxCodeHome, "adapters", RUNTIME, "state.json"));
  const configuredDshHome = options.dshHome ?? nonEmpty(env.DSH_HOME);
  const dshHome = configuredDshHome === undefined
    ? persistedDshHome({ statePath, memoraxCodeHome, adapterRoot }, homeDir)
      ?? resolveHomePath(join(homeDir, ".dsh"), homeDir)
    : resolveHomePath(configuredDshHome, homeDir);
  return {
    env,
    dshHome,
    memoraxCodeHome,
    adapterRoot,
    profilesRoot: join(dshHome, "profiles"),
    statePath,
  };
}

function persistedDshHome(paths, homeDir) {
  const state = readAdapterState(paths.statePath);
  const value = nonEmpty(state?.dshHome);
  if (!value) return undefined;
  const dshHome = resolveHomePath(value, homeDir);
  return validateState(state, { ...paths, dshHome }) ? undefined : dshHome;
}

function validateState(state, paths) {
  if (!state) return undefined;
  if (state.unreadable) return { ok: false, runtime: RUNTIME, reason: "state_unreadable", statePath: paths.statePath };
  if (state.version !== STATE_VERSION
    || state.runtime !== RUNTIME
    || state.integration !== "plugin"
    || typeof state.enabled !== "boolean"
    || resolve(state.dshHome ?? "") !== paths.dshHome
    || resolve(state.memoraxCodeHome ?? "") !== paths.memoraxCodeHome
    || typeof state.adapterRoot !== "string"
    || typeof state.memoraxCodeCommand !== "string"
    || typeof state.dshCommand !== "string"
    || (state.dshVersion !== undefined && !nonEmpty(state.dshVersion))
    || !timestampString(state.updatedAt)
    || !Array.isArray(state.profiles)
    || !state.profiles.every(validProfileName)) {
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
  return configured && !configured.includes("/") && !configured.includes("\\")
    ? configured
    : resolve(configured ?? join(PACKAGE_LIB, "..", "bin", "memorax-code.mjs"));
}

function resolveDshCommand(options, paths, state) {
  const command = nonEmpty(options.dshCommand)
    ?? nonEmpty(paths.env.MEMORAX_CODE_DSH_COMMAND)
    ?? nonEmpty(state?.dshCommand)
    ?? "dsh";
  return command.includes("/") || command.includes("\\") ? resolve(command) : command;
}

function runDsh(options, paths, args, command) {
  const env = { ...paths.env, DSH_HOME: paths.dshHome };
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
    cwd: paths.adapterRoot,
    env,
    timeout: args.length === 1 && args[0] === "--version"
      ? DSH_VERSION_TIMEOUT_MS
      : DEFAULT_COMMAND_TIMEOUT_MS,
  };
  if (typeof options.runDsh === "function") {
    try {
      return options.runDsh(invocation) ?? { status: 1 };
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

function inspectDshCompatibility(options, paths, command) {
  const result = runDsh(options, paths, ["--version"], command);
  if (result.status !== 0 || result.error) {
    return {
      compatible: false,
      reason: "dsh_version_unavailable",
      supportedDshVersions: [...DSH_SUPPORTED_VERSIONS],
    };
  }
  const output = typeof result.stdout === "string" ? result.stdout.trim() : "";
  if (!output
    || output.length > DSH_VERSION_MAX_LENGTH
    || !DSH_VERSION_PATTERN.test(output)) {
    return {
      compatible: false,
      reason: "dsh_version_unavailable",
      supportedDshVersions: [...DSH_SUPPORTED_VERSIONS],
    };
  }
  if (!DSH_SUPPORTED_VERSION_SET.has(output)) {
    return {
      compatible: false,
      reason: "unsupported_dsh_version",
      dshVersion: output,
      supportedDshVersions: [...DSH_SUPPORTED_VERSIONS],
    };
  }
  return {
    compatible: true,
    dshVersion: output,
    supportedDshVersions: [...DSH_SUPPORTED_VERSIONS],
  };
}

function commandFailure(name, result, contractReason) {
  return {
    name,
    reason: contractReason
      ? contractReason
      : result.error?.code === "ENOENT"
        ? "dsh_not_found"
        : "dsh_command_failed",
    status: Number.isInteger(result.status) ? result.status : undefined,
  };
}

function readProfile(name, path) {
  try {
    const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
    const bundles = manifest?.dsh?.profile?.bundles;
    if (!Array.isArray(bundles) || !bundles.every((value) => typeof value === "string")) return undefined;
    return {
      name,
      path,
      dependencies: manifest.dependencies && typeof manifest.dependencies === "object"
        ? manifest.dependencies
        : {},
      bundles,
    };
  } catch {
    return undefined;
  }
}

function profileMentionsAdapter(profile) {
  return Boolean(profile
    && (Object.hasOwn(profile.dependencies, ADAPTER_PACKAGE_NAME)
      || profile.bundles.includes(ADAPTER_PACKAGE_NAME)));
}

function profileHasAdapter(profile) {
  return Boolean(profile
    && Object.hasOwn(profile.dependencies, ADAPTER_PACKAGE_NAME)
    && profile.bundles.includes(ADAPTER_PACKAGE_NAME));
}

function projectProfileStatus(discoveredProfiles, managedNames, includeUnmanaged) {
  const profileByName = new Map(discoveredProfiles.map((profile) => [profile.name, profile]));
  const names = includeUnmanaged
    ? new Set([...managedNames, ...profileByName.keys()])
    : managedNames;
  return [...names]
    .sort((left, right) => left.localeCompare(right))
    .map((name) => {
      const profile = profileByName.get(name);
      return {
        name,
        ...(includeUnmanaged ? { managed: managedNames.has(name) } : {}),
        exists: Boolean(profile),
        installed: profileHasAdapter(profile),
      };
    });
}

function validProfileName(value) {
  return typeof value === "string"
    && value.length > 0
    && value !== "."
    && value !== ".."
    && value !== "node_modules"
    && !value.includes("/")
    && !value.includes("\\");
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
