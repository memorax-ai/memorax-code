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
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DSH_TESTED_VERSIONS,
  isTestedDshVersion,
  parseDshVersion,
} from "./dsh-version.mjs";
import {
  requireDshRuntimeAuthority,
  requireEnabledDshRuntime,
} from "./runtime-state.mjs";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const ADAPTER_ROOT = resolve(MODULE_DIR, "..");
const stagedCommonRoot = resolve(ADAPTER_ROOT, "../memorax-code-adapter-common/src");
const sourceCommonRoot = resolve(MODULE_DIR, "../../memorax-code-adapter-common/src");
const commonRoot = existsSync(join(stagedCommonRoot, "config-utils.mjs"))
  ? stagedCommonRoot
  : sourceCommonRoot;
const stagedSkillRoot = resolve(ADAPTER_ROOT, "skills/memorax-code");
const sourceSkillRoot = resolve(MODULE_DIR, "../../memorax-code-codex-adapter/skills/memorax-code");
const skillRoot = existsSync(join(stagedSkillRoot, "SKILL.md"))
  ? stagedSkillRoot
  : sourceSkillRoot;
const {
  atomicWriteJson,
  readAdapterState,
  withJsonFileLockAsync,
} = await import(pathToFileURL(join(commonRoot, "config-utils.mjs")).href);
const { resolveWindowsCliInvocation } = await import(
  pathToFileURL(join(commonRoot, "windows-cli-invocation.mjs")).href
);

const STATE_VERSION = 1;
const RUNTIME = "dsh";
const ADAPTER_PACKAGE_NAME = "@memorax-code/dsh-adapter";
const DSH_VERSION_TIMEOUT_MS = 10_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_LIFECYCLE_LOCK_TIMEOUT_MS = 600_000;
const PACKAGE_METADATA_FILE = ".memorax-code-package.json";
const PROFILE_BUNDLE_FILES = Object.freeze([
  PACKAGE_METADATA_FILE,
  "cordis.patch.yml",
  "hooks/repo-memory-job.mjs",
  "skills/memorax-code/SKILL.md",
  "skills/memorax-code/agents/claude.yaml",
  "skills/memorax-code/agents/openai.yaml",
  "skills/memorax-code/defaults.json",
  "skills/memorax-code/references/memorax-add.md",
  "skills/memorax-code/references/memorax-search.md",
  "skills/memorax-code/references/personal-read.md",
  "skills/memorax-code/references/personal-write.md",
  "skills/memorax-code/references/repo-build.md",
  "skills/memorax-code/references/repo-read.md",
  "skills/memorax-code/references/repo-templates.md",
  "skills/memorax-code/references/repo-update.md",
  "skills/memorax-code/scripts/collect_all.py",
  "skills/memorax-code/scripts/detect_updates.py",
  "skills/memorax-code/scripts/git_commit_facets.py",
  "skills/memorax-code/scripts/github_resource_facets.py",
  "skills/memorax-code/scripts/gitlab_resource_facets.py",
  "skills/memorax-code/scripts/prepare_repo_memory.py",
  "skills/memorax-code/scripts/user_profile_memory.py",
  "skills/memorax-code/scripts/validate_memory.py",
  "src/index.mjs",
  "src/backend-client.mjs",
  "src/dsh-message.mjs",
  "src/dsh-version.mjs",
  "src/http-client.mjs",
  "src/personal-context-worker.mjs",
  "src/personal-context.mjs",
  "src/plugin.mjs",
  "src/protocol.mjs",
  "src/runtime-state.mjs",
  "memorax-code-adapter-common/src/backend-connection.mjs",
  "memorax-code-adapter-common/src/config-utils.mjs",
  "memorax-code-adapter-common/src/hooks/ensure-backend-runner.mjs",
  "memorax-code-adapter-common/src/hooks/memory-skill-reminder-policy.mjs",
  "memorax-code-adapter-common/src/repo-memory/repo-memory-auto-build.mjs",
  "memorax-code-adapter-common/src/repo-memory/repo-memory-job-context.mjs",
  "memorax-code-adapter-common/src/repo-memory/repo-memory-job-marker.mjs",
  "memorax-code-adapter-common/src/repo-memory/repo-memory-job-supervisor.mjs",
  "memorax-code-adapter-common/src/repo-memory/repo-memory-job-worker.mjs",
  "memorax-code-adapter-common/src/repo-memory/repo-procedure-memory-context.mjs",
  "memorax-code-adapter-common/src/repo-memory/repo-memory-update-policy-evaluator.mjs",
  "memorax-code-adapter-common/src/repo-memory/repo-memory-update-policy.mjs",
  "memorax-code-adapter-common/src/repo-memory/repo-user-profile-context.mjs",
  "memorax-code-adapter-common/src/runtime-record.mjs",
  "memorax-code-adapter-common/src/windows-cli-invocation.mjs",
]);

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
    const profiles = projectProfileStatus(
      discoveredProfiles,
      managedNames,
      true,
      state?.runtimeBundleRoot,
      stateProblem ? undefined : state,
    );
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
    const versionStatus = {
      dshVersionTested: compatibility.dshVersionTested,
      testedDshVersions: [...DSH_TESTED_VERSIONS],
    };
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
        ...versionStatus,
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
        ...versionStatus,
        skipped: true,
        reason: "not_managed",
      };
    }
    if (state.enabled === true) {
      try {
        requireEnabledDshRuntime(state.runtimeBundleRoot);
      } catch {
        return {
          ok: false,
          ...base,
          version,
          compatible: true,
          ...versionStatus,
          reason: "runtime_authority_invalid",
        };
      }
    }
    return {
      ok: true,
      ...base,
      enabled: state.enabled === true && installed,
      version,
      compatible: true,
      ...versionStatus,
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
    status: () => readDshPluginStatusUnlocked(paths, options),
    ensureInstalled: (overrides = {}) => ensureDshPluginInstalledUnlocked(
      paths,
      { ...options, ...overrides },
    ),
    activate: () => activateDshPluginInstallationUnlocked(paths, options),
    quiesce: () => quiesceDshPluginInstallationUnlocked(paths),
    disable: () => disableDshPluginInstallationUnlocked(paths, options, false),
    remove: () => disableDshPluginInstallationUnlocked(paths, options, true),
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
  const managedProfiles = projectProfileStatus(
    profiles,
    new Set(state.profiles),
    false,
    state.runtimeBundleRoot,
    state,
  );
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
  const claimedProfiles = (state?.profiles ?? []).map((name) => (
    inspectProfile(name, join(paths.profilesRoot, name))
  ));
  const manifestProblem = managedProfileManifestProblem(claimedProfiles);
  if (manifestProblem) return manifestProblem;

  const profiles = discoverDshProfiles({ ...options, dshHome: paths.dshHome });
  if (profiles.length === 0) {
    if (state) atomicWriteJson(paths.statePath, disabledState(state, []));
    return {
      ok: !state,
      action: "dsh-plugin-install",
      runtime: RUNTIME,
      installed: false,
      enabled: false,
      managed: Boolean(state),
      ...(!state ? { skipped: true } : {}),
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
      ok: false,
      action: "dsh-plugin-install",
      runtime: RUNTIME,
      installed: false,
      enabled: false,
      managed: Boolean(state),
      detectedProfiles: profiles.map((profile) => profile.name),
      ...compatibility,
    };
  }

  const previouslyManaged = new Set(claimedProfiles
    .filter((profile) => profile.status !== "directory_missing")
    .map((profile) => profile.name));
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
  const metadata = {
    version: 1,
    memoraxCodeCommand,
    memoraxCodeHome: paths.memoraxCodeHome,
    dshHome: paths.dshHome,
    dshCommand,
    dshVersion: compatibility.dshVersion,
    sourceAdapterRoot: paths.adapterRoot,
  };
  const runtimeBundleRoot = materializeRuntimeBundle(paths, metadata);

  const now = new Date().toISOString();
  const pendingState = {
    version: STATE_VERSION,
    runtime: RUNTIME,
    integration: "plugin",
    enabled: false,
    dshHome: paths.dshHome,
    memoraxCodeHome: paths.memoraxCodeHome,
    adapterRoot: paths.adapterRoot,
    runtimeBundleRoot,
    memoraxCodeCommand,
    dshCommand,
    dshVersion: compatibility.dshVersion,
    // Preserve prior claims and claim each target before invoking DSH so an
    // interrupted or partial native add remains repairable and removable.
    profiles: [...new Set([
      ...previouslyManaged,
      ...profiles.map((profile) => profile.name),
    ])].sort(),
    updatedAt: now,
  };
  atomicWriteJson(paths.statePath, pendingState);

  const installedProfiles = [];
  const failedProfiles = [];
  const mutatedProfiles = [];
  for (const profile of profiles) {
    const before = inspectProfile(profile.name, profile.path);
    if (before.status !== "valid") {
      failedProfiles.push(before.status === "directory_missing"
        ? { name: profile.name, reason: "profile_disappeared" }
        : profileManifestFailure(profile.name));
      continue;
    }
    if (profileHasInstalledAdapter(before.profile, runtimeBundleRoot, pendingState)) {
      installedProfiles.push(profile.name);
      continue;
    }
    const result = runDsh(options, paths, [
      "plugin",
      "--profile",
      profile.name,
      "add",
      `file:${runtimeBundleRoot}`,
    ], dshCommand);
    const after = inspectProfile(profile.name, profile.path);
    if (previouslyManaged.has(profile.name)
      || (after.status === "valid" && profileMentionsAdapter(after.profile))) {
      mutatedProfiles.push(profile.name);
    }
    const installed = result.status === 0
      && !result.error
      && after.status === "valid"
      && profileHasInstalledAdapter(after.profile, runtimeBundleRoot, pendingState);
    if (installed) installedProfiles.push(profile.name);
    else failedProfiles.push(profileMutationFailure(
      profile.name,
      result,
      after,
      "dsh_bundle_not_activated",
    ));
  }

  const finalProfiles = pendingState.profiles.map((name) => (
    inspectProfile(name, join(paths.profilesRoot, name))
  ));
  for (const profile of finalProfiles) {
    if (failedProfiles.some((failure) => failure.name === profile.name)) continue;
    if (profile.status === "manifest_unreadable") {
      failedProfiles.push(profileManifestFailure(profile.name));
    } else if (profile.status === "valid"
      && !profileHasInstalledAdapter(profile.profile, runtimeBundleRoot, pendingState)) {
      failedProfiles.push({ name: profile.name, reason: "dsh_bundle_not_activated" });
    }
  }
  const managedProfiles = finalProfiles
    .filter((profile) => profile.status !== "directory_missing")
    .map((profile) => profile.name);
  if (failedProfiles.length > 0 && state) {
    const rollback = rollbackDshPluginReconciliation(
      paths,
      options,
      state,
      mutatedProfiles,
      dshCommand,
    );
    const failureReason = pluginManagerFailureReason(failedProfiles);
    return {
      ok: false,
      action: "dsh-plugin-install",
      runtime: RUNTIME,
      installed: false,
      enabled: rollback.authorityRestored && state.enabled,
      managed: true,
      detectedProfiles: profiles.map((profile) => profile.name),
      dshVersion: compatibility.dshVersion,
      dshVersionTested: compatibility.dshVersionTested,
      testedDshVersions: [...DSH_TESTED_VERSIONS],
      installedProfiles,
      failedProfiles,
      ...(failureReason ? { reason: failureReason } : {}),
      ...(rollback.failedProfiles.length > 0
        ? { rollbackFailedProfiles: rollback.failedProfiles }
        : {}),
    };
  }
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
  if (failedProfiles.length === 0 && managedProfiles.length > 0) {
    cleanupRuntimeGenerations(paths.runtimeRoot, runtimeBundleRoot);
  }
  const failureReason = pluginManagerFailureReason(failedProfiles);

  return {
    ok: failedProfiles.length === 0,
    action: "dsh-plugin-install",
    runtime: RUNTIME,
    installed: failedProfiles.length === 0 && managedProfiles.length > 0,
    enabled,
    managed: true,
    detectedProfiles: profiles.map((profile) => profile.name),
    dshVersion: compatibility.dshVersion,
    dshVersionTested: compatibility.dshVersionTested,
    testedDshVersions: [...DSH_TESTED_VERSIONS],
    installedProfiles,
    failedProfiles,
    ...(failureReason ? { reason: failureReason } : {}),
  };
}

function rollbackDshPluginReconciliation(paths, options, state, mutatedProfiles, dshCommand) {
  const previouslyManaged = new Set(state.profiles);
  const rollbackFailedProfiles = [];
  const residualProfiles = [];
  const managedMutationResults = new Map();
  for (const name of [...new Set(mutatedProfiles)]) {
    const profilePath = join(paths.profilesRoot, name);
    const before = inspectProfile(name, profilePath);
    if (previouslyManaged.has(name)) {
      const result = runDsh(options, paths, [
        "plugin",
        "--profile",
        name,
        "add",
        `file:${state.runtimeBundleRoot}`,
      ], dshCommand);
      managedMutationResults.set(name, result);
      continue;
    }
    if (before.status === "directory_missing"
      || (before.status === "valid" && !profileMentionsAdapter(before.profile))) {
      continue;
    }
    const result = runDsh(options, paths, [
      "plugin",
      "--profile",
      name,
      "remove",
      ADAPTER_PACKAGE_NAME,
    ], dshCommand);
    const after = inspectProfile(name, profilePath);
    if (after.status !== "directory_missing"
      && (result.status !== 0
        || result.error
        || after.status !== "valid"
        || profileMentionsAdapter(after.profile))) {
      residualProfiles.push(name);
    }
    if (result.status !== 0
      || result.error
      || (after.status !== "directory_missing"
        && (after.status !== "valid" || profileMentionsAdapter(after.profile)))) {
      rollbackFailedProfiles.push(profileMutationFailure(
        name,
        result,
        after,
        "dsh_bundle_not_removed",
      ));
    }
  }
  const rollbackState = residualProfiles.length > 0
    ? {
        ...state,
        profiles: [...new Set([...state.profiles, ...residualProfiles])].sort(),
        updatedAt: new Date().toISOString(),
      }
    : state;
  const verificationState = rollbackState.enabled
    ? { ...rollbackState, enabled: false }
    : rollbackState;
  atomicWriteJson(paths.statePath, verificationState);
  let authorityRestored = true;
  for (const name of state.profiles) {
    const profile = inspectProfile(name, join(paths.profilesRoot, name));
    if (profile.status === "valid"
      && profileHasInstalledAdapter(profile.profile, state.runtimeBundleRoot, verificationState)) {
      continue;
    }
    authorityRestored = false;
    rollbackFailedProfiles.push(profileMutationFailure(
      name,
      managedMutationResults.get(name) ?? { status: 0 },
      profile,
      "dsh_bundle_not_restored",
    ));
  }
  if (authorityRestored) atomicWriteJson(paths.statePath, rollbackState);
  return { authorityRestored, failedProfiles: rollbackFailedProfiles };
}

function activateDshPluginInstallationUnlocked(paths, options) {
  const state = readAdapterState(paths.statePath);
  const stateProblem = validateState(state, paths);
  if (stateProblem) return { ...stateProblem, action: "dsh-plugin-activate" };
  if (!state) return notManaged(paths, "dsh-plugin-activate");
  const profiles = discoverDshProfiles({ ...options, dshHome: paths.dshHome });
  const profileByName = new Map(profiles.map((profile) => [profile.name, profile]));
  if (state.profiles.length === 0
    || state.profiles.some((name) => (
      !profileHasInstalledAdapter(profileByName.get(name), state.runtimeBundleRoot, state)
    ))) {
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

function quiesceDshPluginInstallationUnlocked(paths) {
  const state = readAdapterState(paths.statePath);
  const stateProblem = validateState(state, paths);
  if (stateProblem) return { ...stateProblem, action: "dsh-plugin-quiesce" };
  if (!state) return notManaged(paths, "dsh-plugin-quiesce");
  const nextState = disabledState(state, state.profiles);
  atomicWriteJson(paths.statePath, nextState);
  return {
    ok: true,
    action: "dsh-plugin-quiesce",
    runtime: RUNTIME,
    installed: state.profiles.length > 0,
    enabled: false,
    managed: true,
    authorityEnabled: false,
    previouslyEnabled: state.enabled === true,
    revision: nextState.updatedAt,
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
  const removedProfiles = [];
  const failedProfiles = [];
  for (const name of state.profiles) {
    const before = inspectProfile(name, join(paths.profilesRoot, name));
    if (before.status === "directory_missing") {
      removedProfiles.push(name);
      continue;
    }
    if (before.status === "manifest_unreadable") {
      failedProfiles.push(profileManifestFailure(name));
      continue;
    }
    if (!profileMentionsAdapter(before.profile)) {
      removedProfiles.push(name);
      continue;
    }
    const result = runDsh(
      options,
      paths,
      ["plugin", "--profile", name, "remove", ADAPTER_PACKAGE_NAME],
      dshCommand,
    );
    const after = inspectProfile(name, before.profile.path);
    const removed = result.status === 0
      && !result.error
      && (after.status === "directory_missing"
        || (after.status === "valid" && !profileMentionsAdapter(after.profile)));
    if (removed) removedProfiles.push(name);
    else failedProfiles.push(profileMutationFailure(
      name,
      result,
      after,
      "dsh_bundle_not_removed",
    ));
  }

  if (failedProfiles.length > 0) {
    atomicWriteJson(paths.statePath, disabledState(disabled, failedProfiles.map((profile) => profile.name).sort()));
    const failureReason = pluginManagerFailureReason(failedProfiles);
    return {
      ok: false,
      action,
      runtime: RUNTIME,
      enabled: false,
      removedProfiles,
      failedProfiles,
      ...(failureReason ? { reason: failureReason } : {}),
    };
  }

  if (removeState) {
    rmSync(paths.statePath, { force: true });
    rmSync(paths.runtimeRoot, { recursive: true, force: true });
  }
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

function materializeRuntimeBundle(paths, metadata) {
  const manifest = readJsonObject(join(paths.adapterRoot, "package.json"));
  if (manifest?.name !== ADAPTER_PACKAGE_NAME
    || !nonEmpty(manifest.version)
    || manifest.main !== "src/index.mjs"
    || !isDeepStrictEqual(manifest.exports, { ".": "./src/index.mjs" })
    || !isDeepStrictEqual(manifest.files, PROFILE_BUNDLE_FILES)) {
    throw new Error("MemoraX Code DSH adapter source manifest is invalid");
  }

  const sourceFiles = ["package.json", ...PROFILE_BUNDLE_FILES]
    .filter((relativePath) => relativePath !== PACKAGE_METADATA_FILE)
    .map((relativePath) => {
      const path = bundleSourcePath(paths, relativePath);
      if (!lstatSync(path).isFile()) {
        throw new Error(`MemoraX Code DSH runtime source is not a file: ${relativePath}`);
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
  const skillPrefix = "skills/memorax-code/";
  return relativePath.startsWith(skillPrefix)
    ? join(skillRoot, relativePath.slice(skillPrefix.length))
    : join(paths.adapterRoot, relativePath);
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
    runtimeRoot,
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
    || !isPathInside(state.runtimeBundleRoot, paths.runtimeRoot)
    || typeof state.memoraxCodeCommand !== "string"
    || typeof state.dshCommand !== "string"
    || !parseDshVersion(state.dshVersion)
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
    // The install watchdog may run a preloaded cleanup after npm has already
    // removed the adapter files. DSH plugin removal itself only needs DSH_HOME.
    cwd: existsSync(paths.adapterRoot) ? paths.adapterRoot : paths.dshHome,
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
      testedDshVersions: [...DSH_TESTED_VERSIONS],
    };
  }
  const output = parseDshVersion(result.stdout);
  if (!output) {
    return {
      compatible: false,
      reason: "dsh_version_unavailable",
      testedDshVersions: [...DSH_TESTED_VERSIONS],
    };
  }
  return {
    compatible: true,
    dshVersion: output,
    dshVersionTested: isTestedDshVersion(output),
    testedDshVersions: [...DSH_TESTED_VERSIONS],
  };
}

function commandFailure(name, result, contractReason) {
  return {
    name,
    reason: contractReason
      ? contractReason
      : /pnpm not found on PATH/i.test(String(result.stderr ?? ""))
        ? "pnpm_not_found"
        : result.error?.code === "ENOENT"
          ? "dsh_not_found"
          : "dsh_command_failed",
    status: Number.isInteger(result.status) ? result.status : undefined,
  };
}

function pluginManagerFailureReason(failures) {
  return failures.some((failure) => failure.reason === "pnpm_not_found")
    ? "pnpm_not_found"
    : undefined;
}

function managedProfileManifestProblem(claimedProfiles) {
  const profiles = claimedProfiles
    .filter((profile) => profile.status === "manifest_unreadable")
    .map((profile) => profile.name);
  return profiles.length > 0
    ? {
        ok: false,
        action: "dsh-plugin-install",
        runtime: RUNTIME,
        reason: "profile_manifest_unreadable",
        profiles,
      }
    : undefined;
}

function profileManifestFailure(name) {
  return { name, reason: "profile_manifest_unreadable" };
}

function profileMutationFailure(name, result, profile, contractReason) {
  return result.status === 0 && !result.error && profile.status === "manifest_unreadable"
    ? profileManifestFailure(name)
    : commandFailure(name, result, result.status === 0 ? contractReason : undefined);
}

function readProfile(name, path) {
  const result = inspectProfile(name, path);
  return result.status === "valid" ? result.profile : undefined;
}

function inspectProfile(name, path) {
  try {
    if (!lstatSync(path).isDirectory()) return { status: "manifest_unreadable", name };
  } catch (error) {
    return { status: error?.code === "ENOENT" ? "directory_missing" : "manifest_unreadable", name };
  }
  try {
    const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
    const bundles = manifest?.dsh?.profile?.bundles;
    if (!Array.isArray(bundles) || !bundles.every((value) => typeof value === "string")) {
      return { status: "manifest_unreadable", name };
    }
    return {
      status: "valid",
      name,
      profile: {
        name,
        path,
        dependencies: manifest.dependencies && typeof manifest.dependencies === "object"
          ? manifest.dependencies
          : {},
        bundles,
      },
    };
  } catch {
    return { status: "manifest_unreadable", name };
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

function profileHasInstalledAdapter(profile, runtimeBundleRoot, state) {
  if (!profileHasAdapter(profile) || !state || !nonEmpty(runtimeBundleRoot)) return false;
  try {
    const sourceManifest = readJsonObject(join(runtimeBundleRoot, "package.json"));
    if (sourceManifest?.name !== ADAPTER_PACKAGE_NAME
      || !nonEmpty(sourceManifest.version)) return false;

    const requireFromProfile = createRequire(join(profile.path, "package.json"));
    const packageRoot = (requireFromProfile.resolve.paths(ADAPTER_PACKAGE_NAME) ?? [])
      .map((searchPath) => join(searchPath, ADAPTER_PACKAGE_NAME))
      .find((candidate) => existsSync(join(candidate, "package.json")));
    if (!packageRoot) return false;

    const installedManifest = readJsonObject(join(packageRoot, "package.json"));
    const sourcePatch = sourceManifest?.dsh?.bundle?.patch;
    if (installedManifest?.name !== ADAPTER_PACKAGE_NAME
      || installedManifest.version !== sourceManifest.version
      || installedManifest.main !== sourceManifest.main
      || !isDeepStrictEqual(installedManifest.exports, sourceManifest.exports)
      || typeof sourcePatch !== "string"
      || !sourcePatch
      || installedManifest?.dsh?.bundle?.patch !== sourcePatch) return false;

    readFileSync(join(packageRoot, sourcePatch), "utf8");
    readFileSync(requireFromProfile.resolve(ADAPTER_PACKAGE_NAME), "utf8");
    const authority = requireDshRuntimeAuthority(packageRoot);
    return authority.enabled === state.enabled
      && authority.sourceAdapterRoot === resolve(state.adapterRoot)
      && authority.runtimeBundleRoot === resolve(state.runtimeBundleRoot)
      && authority.runtimeBundleRoot === resolve(runtimeBundleRoot)
      && authority.memoraxCodeHome === resolve(state.memoraxCodeHome)
      && authority.dshHome === resolve(state.dshHome)
      && authority.memoraxCodeCommand === state.memoraxCodeCommand
      && authority.dshCommand === state.dshCommand
      && authority.dshVersion === state.dshVersion
      && isDeepStrictEqual(authority.profiles, state.profiles)
      && authority.revision === state.updatedAt;
  } catch {
    return false;
  }
}

function readJsonObject(path) {
  const value = JSON.parse(readFileSync(path, "utf8"));
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value
    : undefined;
}

function projectProfileStatus(
  discoveredProfiles,
  managedNames,
  includeUnmanaged,
  runtimeBundleRoot,
  state,
) {
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
        installed: profileHasInstalledAdapter(profile, runtimeBundleRoot, state),
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

function isPathInside(value, parent) {
  if (typeof value !== "string" || !value.trim()) return false;
  const child = relative(resolve(parent), resolve(value));
  return child !== ""
    && child !== ".."
    && !child.startsWith(`..${sep}`)
    && !isAbsolute(child);
}
