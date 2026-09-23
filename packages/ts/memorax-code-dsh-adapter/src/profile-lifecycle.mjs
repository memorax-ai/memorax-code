import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  DSH_TESTED_VERSIONS,
  isTestedDshVersion,
  parseDshVersion,
} from "./dsh-version.mjs";
import {
  buildDshCommand,
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
const { attachDeploymentFailure, deploymentFailure } = await import(
  pathToFileURL(join(commonRoot, "deployment-failure.mjs")).href
);

const STATE_VERSION = 1;
const RUNTIME = "dsh";
const DSH_PACKAGE_NAME = "@deepseek-ai/dsh";
const ADAPTER_PACKAGE_NAME = "@memorax-code/dsh-memorax-code";
const HEADLESS_PROFILE_NAME = "headless";
const HEADLESS_BUNDLE_NAME = "@deepseek-ai/dsh-headless";
const LEGACY_ADAPTER_PACKAGE_NAMES = Object.freeze(["@memorax-code/dsh-adapter"]);
const MANAGED_ADAPTER_PACKAGE_NAMES = Object.freeze([
  ADAPTER_PACKAGE_NAME,
  ...LEGACY_ADAPTER_PACKAGE_NAMES,
]);
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
  "skills/memorax-code/scripts/repo-memory.mjs",
  "skills/memorax-code/scripts/user-profile-memory.mjs",
  "src/index.mjs",
  "src/backend-client.mjs",
  "src/dsh-message.mjs",
  "src/dsh-version.mjs",
  "src/reminder-cadence.mjs",
  "src/http-client.mjs",
  "src/personal-context-worker.mjs",
  "src/personal-context.mjs",
  "src/plugin.mjs",
  "src/protocol.mjs",
  "src/runtime-state.mjs",
  "memorax-code-adapter-common/src/backend-command.mjs",
  "memorax-code-adapter-common/src/backend-connection.mjs",
  "memorax-code-adapter-common/src/config-utils.mjs",
  "memorax-code-adapter-common/src/diagnostic-record.mjs",
  "memorax-code-adapter-common/src/setup-completion.mjs",
  "memorax-code-adapter-common/src/hooks/ensure-backend-runner.mjs",
  "memorax-code-adapter-common/src/hooks/hook-diagnostics.mjs",
  "memorax-code-adapter-common/src/hooks/memory-skill-reminder-policy.mjs",
  "memorax-code-adapter-common/src/repo-memory/repo-memory-auto-build.mjs",
  "memorax-code-adapter-common/src/repo-memory/repo-memory-job-artifacts.mjs",
  "memorax-code-adapter-common/src/repo-memory/repo-memory-job-context.mjs",
  "memorax-code-adapter-common/src/repo-memory/repo-memory-job-marker.mjs",
  "memorax-code-adapter-common/src/repo-memory/repo-memory-job-supervisor.mjs",
  "memorax-code-adapter-common/src/repo-memory/repo-memory-job-worker.mjs",
  "memorax-code-adapter-common/src/personal-memory/procedure-memory-context.mjs",
  "memorax-code-adapter-common/src/repo-memory/repo-memory-update-policy-evaluator.mjs",
  "memorax-code-adapter-common/src/repo-memory/repo-memory-update-policy.mjs",
  "memorax-code-adapter-common/src/personal-memory/user-profile-context.mjs",
  "memorax-code-adapter-common/src/runtime-record.mjs",
  "memorax-code-adapter-common/src/windows-directory-retry.mjs",
  "memorax-code-adapter-common/src/windows-cli-invocation.mjs",
]);

export function discoverDshProfiles(options = {}) {
  const paths = resolvePaths(options);
  let entries;
  try {
    entries = readdirSync(paths.profilesRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw attachDeploymentFailure(error, "discover");
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
      && profiles.every((profile) => profile.managed && profile.exists && profile.installed)
      && managedProfilesHaveInstalledHeadlessBundle(
        discoveredProfiles, managedNames, options, paths, state?.dshCommand,
      );
    const base = {
      integration: "plugin",
      managed,
      installed,
      enabled: false,
      profiles,
    };
    if (stateProblem) {
      return { ok: false, ...base, reason: stateProblem.reason, failure: stateProblem.failure };
    }
    if (!state && profiles.length === 0) {
      return { ok: true, ...base, skipped: true, reason: "no_existing_profiles" };
    }

    const { dshCommand, compatibility } = resolveDshStatusCompatibility(
      options,
      paths,
      state,
    );
    const version = compatibility.dshVersion;
    const versionStatus = {
      dshVersionTested: compatibility.dshVersionTested,
      testedDshVersions: [...DSH_TESTED_VERSIONS],
    };
    if (compatibility.reason === "dsh_version_unavailable"
      || compatibility.reason === "dsh_profile_runtime_stale") {
      return {
        ok: false,
        ...base,
        compatible: false,
        reason: compatibility.reason,
        failure: compatibility.failure,
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
  } catch (error) {
    return {
      ok: false,
      integration: "plugin",
      managed: false,
      installed: false,
      enabled: false,
      profiles: [],
      reason: "dsh_status_unavailable",
      failure: deploymentFailure(error, "discover"),
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
  let entered = false;
  return withJsonFileLockAsync(paths.statePath, () => {
    entered = true;
    return operation(Object.freeze({
      status: () => readDshPluginStatusUnlocked(paths, options),
      ensureInstalled: (overrides = {}) => ensureDshPluginInstalledUnlocked(
        paths,
        { ...options, ...overrides },
      ),
      activate: () => activateDshPluginInstallationUnlocked(paths, options),
      quiesce: () => quiesceDshPluginInstallationUnlocked(paths),
      disable: () => disableDshPluginInstallationUnlocked(paths, options, false),
      remove: () => disableDshPluginInstallationUnlocked(paths, options, true),
    }));
  }, {
    timeoutMs: DEFAULT_LIFECYCLE_LOCK_TIMEOUT_MS,
  }).catch((error) => {
    const stage = !entered || error?.code === "JSON_FILE_LOCK_RELEASE_FAILED" ? "lock" : "deploy";
    throw attachDeploymentFailure(error, stage);
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
    && managedProfiles.every((profile) => profile.installed)
    && managedProfilesHaveInstalledHeadlessBundle(
      profiles, new Set(state.profiles), options, paths, state.dshCommand,
    );
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
    if (state) writeDshState(paths, disabledState(state, []));
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
      ...(state ? { failure: deploymentFailure(undefined, "discover", { failureReason: "not_ready" }) } : {}),
    };
  }

  const { dshCommand, compatibility } = resolveDshCompatibility(options, paths, state);
  if (compatibility.compatible !== true) {
    const nextState = state?.enabled === true
      ? disabledState(state, state.profiles)
      : state;
    if (nextState && nextState !== state) writeDshState(paths, nextState);
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
      failure: deploymentFailure(undefined, "plugin-install", { failureReason: "conflict" }),
      profiles: conflicts,
    };
  }

  const installAnchor = resolveDshInstallAnchor(dshCommand, options, paths);
  let workerProfileName = profiles.find((profile) => (
    profileHasInstalledHeadlessBundle(profile, installAnchor)
  ))?.name;
  let targetProfiles = profiles;
  let initializeWorkerProfile = false;
  if (!workerProfileName) {
    const headlessPath = join(paths.profilesRoot, HEADLESS_PROFILE_NAME);
    const headless = inspectProfile(HEADLESS_PROFILE_NAME, headlessPath);
    if (headless.status === "manifest_unreadable") {
      return {
        ok: false,
        action: "dsh-plugin-install",
        runtime: RUNTIME,
        reason: "profile_manifest_unreadable",
        failure: headless.failure ?? deploymentFailure(undefined, "config-read", { failureReason: "invalid_record" }),
        profiles: [HEADLESS_PROFILE_NAME],
      };
    }
    if (headless.status === "valid") {
      return {
        ok: false,
        action: "dsh-plugin-install",
        runtime: RUNTIME,
        reason: "headless_profile_not_capable",
        failure: deploymentFailure(undefined, "verify-native", { failureReason: "not_ready" }),
        profiles: [HEADLESS_PROFILE_NAME],
      };
    }
    workerProfileName = HEADLESS_PROFILE_NAME;
    initializeWorkerProfile = true;
    targetProfiles = [
      ...profiles,
      { name: HEADLESS_PROFILE_NAME, path: headlessPath },
    ].sort((left, right) => left.name.localeCompare(right.name));
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
      ...targetProfiles.map((profile) => profile.name),
    ])].sort(),
    updatedAt: now,
  };
  writeDshState(paths, pendingState);

  const installedProfiles = [];
  const failedProfiles = [];
  const mutatedProfiles = [];
  for (const profile of targetProfiles) {
    let current = inspectProfile(profile.name, profile.path);
    if (current.status !== "valid"
      && !(initializeWorkerProfile
        && profile.name === workerProfileName
        && current.status === "directory_missing")) {
      failedProfiles.push(current.status === "directory_missing"
        ? { name: profile.name, reason: "profile_disappeared" }
        : profileManifestFailure(profile.name, current));
      continue;
    }
    if (!profileHasInstalledAdapter(current.profile, runtimeBundleRoot, pendingState)) {
      const result = runDsh(options, paths, [
        "plugin",
        "--profile",
        profile.name,
        "add",
        `file:${runtimeBundleRoot}`,
      ], dshCommand);
      current = inspectProfile(profile.name, profile.path);
      if (previouslyManaged.has(profile.name)
        || (current.status === "valid" && profileMentionsAdapter(current.profile))) {
        mutatedProfiles.push(profile.name);
      }
      if (result.status !== 0
        || result.error
        || current.status !== "valid"
        || !profileHasInstalledAdapter(current.profile, runtimeBundleRoot, pendingState)
        || (profile.name === workerProfileName
          && !profileHasInstalledHeadlessBundle(current.profile, installAnchor))) {
        failedProfiles.push(profileMutationFailure(
          profile.name,
          result,
          current,
          profile.name === workerProfileName
            ? "headless_profile_not_capable"
            : "dsh_bundle_not_activated",
        ));
        continue;
      }
    }

    if (LEGACY_ADAPTER_PACKAGE_NAMES.some((packageName) => (
      profileMentionsPackage(current.profile, packageName)
    ))) {
      mutatedProfiles.push(profile.name);
      const cleanup = removeProfileAdapterPackages(
        paths,
        options,
        profile.name,
        LEGACY_ADAPTER_PACKAGE_NAMES,
        dshCommand,
      );
      current = cleanup.profile;
      if (cleanup.failure) {
        failedProfiles.push(cleanup.failure);
        continue;
      }
    }

    if (current.status === "valid"
      && profileHasInstalledAdapter(current.profile, runtimeBundleRoot, pendingState)
      && (profile.name !== workerProfileName
        || profileHasInstalledHeadlessBundle(current.profile, installAnchor))) {
      installedProfiles.push(profile.name);
    } else {
      failedProfiles.push(profileMutationFailure(
        profile.name,
        { status: 0 },
        current,
        "dsh_bundle_not_activated",
      ));
    }
  }

  const finalProfiles = pendingState.profiles.map((name) => (
    inspectProfile(name, join(paths.profilesRoot, name))
  ));
  for (const profile of finalProfiles) {
    if (failedProfiles.some((failure) => failure.name === profile.name)) continue;
    if (profile.status === "manifest_unreadable") {
      failedProfiles.push(profileManifestFailure(profile.name, profile));
    } else if (profile.status === "valid"
      && !profileHasInstalledAdapter(profile.profile, runtimeBundleRoot, pendingState)) {
      failedProfiles.push({ name: profile.name, reason: "dsh_bundle_not_activated" });
    }
  }
  if (!finalProfiles.some((profile) => (
    profile.status === "valid" && profileHasInstalledHeadlessBundle(profile.profile, installAnchor)
  )) && !failedProfiles.some((failure) => failure.name === workerProfileName)) {
    failedProfiles.push({ name: workerProfileName, reason: "headless_profile_not_capable" });
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
      failure: deploymentFailure({ failure: failedProfiles[0].failure }, "verify-native", {
        failureReason: "verification_failed",
        ...(rollback.failedProfiles.length > 0 ? {
          cleanupError: { code: rollback.failedProfiles[0].failure?.systemCode },
        } : {}),
      }),
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
  writeDshState(paths, nextState);
  // A failed reconciliation may reinstall the prior bundle during rollback,
  // so retire old generations only after every target Profile succeeds.
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
    ...(failedProfiles.length > 0 ? {
      failure: failedProfiles[0].failure ?? deploymentFailure(undefined, "verify-native", { failureReason: "verification_failed" }),
    } : {}),
    ...(failureReason ? { reason: failureReason } : {}),
  };
}

function rollbackDshPluginReconciliation(paths, options, state, mutatedProfiles, dshCommand) {
  const previouslyManaged = new Set(state.profiles);
  const previousPackageName = runtimeAdapterPackageName(state.runtimeBundleRoot)
    ?? ADAPTER_PACKAGE_NAME;
  const replacementPackageNames = MANAGED_ADAPTER_PACKAGE_NAMES
    .filter((packageName) => packageName !== previousPackageName);
  const rollbackFailedProfiles = [];
  const residualProfiles = [];
  const managedMutationResults = new Map();
  const recordFailure = (failure) => {
    if (!rollbackFailedProfiles.some(({ name }) => name === failure.name)) {
      rollbackFailedProfiles.push(failure);
    }
  };
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
      const restored = inspectProfile(name, profilePath);
      if (result.status === 0
        && !result.error
        && restored.status === "valid"
        && profileHasAdapter(restored.profile, previousPackageName)) {
        const cleanup = removeProfileAdapterPackages(
          paths,
          options,
          name,
          replacementPackageNames,
          dshCommand,
        );
        if (cleanup.failure) recordFailure(cleanup.failure);
      }
      continue;
    }
    if (before.status === "directory_missing"
      || (before.status === "valid" && !profileMentionsAdapter(before.profile))) {
      continue;
    }
    const cleanup = removeProfileAdapterPackages(
      paths,
      options,
      name,
      MANAGED_ADAPTER_PACKAGE_NAMES,
      dshCommand,
    );
    if (cleanup.profile.status !== "directory_missing"
      && (cleanup.profile.status !== "valid"
        || profileMentionsAdapter(cleanup.profile.profile))) {
      residualProfiles.push(name);
    }
    if (cleanup.failure) recordFailure(cleanup.failure);
  }
  const rollbackState = residualProfiles.length > 0
    ? {
        ...state,
        profiles: [...new Set([...state.profiles, ...residualProfiles])].sort(),
        updatedAt: new Date().toISOString(),
      }
    : state;
  // Keep runtime authority disabled until installed Profiles have been
  // verified against the prior bundle, even if native rollback commands succeeded.
  const verificationState = rollbackState.enabled
    ? { ...rollbackState, enabled: false }
    : rollbackState;
  writeDshState(paths, verificationState);
  let authorityRestored = true;
  for (const name of state.profiles) {
    const profile = inspectProfile(name, join(paths.profilesRoot, name));
    if (profile.status === "valid"
      && profileHasInstalledAdapter(
        profile.profile,
        state.runtimeBundleRoot,
        verificationState,
      )
      && !replacementPackageNames.some((packageName) => (
        profileMentionsPackage(profile.profile, packageName)
      ))) {
      continue;
    }
    authorityRestored = false;
    recordFailure(profileMutationFailure(
      name,
      managedMutationResults.get(name) ?? { status: 0 },
      profile,
      "dsh_bundle_not_restored",
    ));
  }
  if (authorityRestored) writeDshState(paths, rollbackState);
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
    ))
    || !managedProfilesHaveInstalledHeadlessBundle(
      profiles, new Set(state.profiles), options, paths, state.dshCommand,
    )) {
    return {
      ok: false,
      action: "dsh-plugin-activate",
      runtime: RUNTIME,
      reason: "managed_profiles_not_installed",
      failure: deploymentFailure(undefined, "verify-native", { failureReason: "not_ready" }),
    };
  }
  const nextState = { ...state, enabled: true, updatedAt: new Date().toISOString() };
  writeDshState(paths, nextState);
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
  writeDshState(paths, nextState);
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
  writeDshState(paths, disabled);
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
      failedProfiles.push(profileManifestFailure(name, before));
      continue;
    }
    if (!profileMentionsAdapter(before.profile)) {
      removedProfiles.push(name);
      continue;
    }
    const cleanup = removeProfileAdapterPackages(
      paths,
      options,
      name,
      MANAGED_ADAPTER_PACKAGE_NAMES,
      dshCommand,
    );
    if (cleanup.failure) failedProfiles.push(cleanup.failure);
    else removedProfiles.push(name);
  }

  if (failedProfiles.length > 0) {
    writeDshState(paths, disabledState(disabled, failedProfiles.map((profile) => profile.name).sort()));
    const failureReason = pluginManagerFailureReason(failedProfiles);
    return {
      ok: false,
      action,
      runtime: RUNTIME,
      enabled: false,
      removedProfiles,
      failedProfiles,
      failure: failedProfiles[0].failure ?? deploymentFailure(undefined, "verify-native", { failureReason: "verification_failed" }),
      ...(failureReason ? { reason: failureReason } : {}),
    };
  }

  if (removeState) {
    try { rmSync(paths.statePath, { force: true }); }
    catch (error) { throw attachDeploymentFailure(error, "state-write"); }
    try { rmSync(paths.runtimeRoot, { recursive: true, force: true }); }
    catch (error) { throw attachDeploymentFailure(error, "plugin-remove"); }
  }
  else writeDshState(paths, disabledState(disabled, []));
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

function removeProfileAdapterPackages(
  paths,
  options,
  name,
  packageNames,
  dshCommand,
) {
  const profilePath = join(paths.profilesRoot, name);
  let profile = inspectProfile(name, profilePath);
  let failure;
  for (const packageName of packageNames) {
    if (profile.status === "directory_missing") break;
    if (profile.status !== "valid") {
      failure ??= profileManifestFailure(name, profile);
      break;
    }
    if (!profileMentionsPackage(profile.profile, packageName)) continue;
    const result = runDsh(
      options,
      paths,
      ["plugin", "--profile", name, "remove", packageName],
      dshCommand,
    );
    profile = inspectProfile(name, profilePath);
    if (result.status !== 0
      || result.error
      || (profile.status !== "directory_missing"
        && (profile.status !== "valid"
          || profileMentionsPackage(profile.profile, packageName)))) {
      failure ??= profileMutationFailure(
        name,
        result,
        profile,
        "dsh_bundle_not_removed",
      );
    }
  }
  if (!failure
    && profile.status !== "directory_missing"
    && (profile.status !== "valid"
      || packageNames.some((packageName) => (
        profileMentionsPackage(profile.profile, packageName)
      )))) {
    failure = profileMutationFailure(name, { status: 0 }, profile, "dsh_bundle_not_removed");
  }
  return { profile, failure };
}

function materializeRuntimeBundle(paths, metadata) {
  try { return materializeRuntimeBundleUnchecked(paths, metadata); }
  catch (error) { throw attachDeploymentFailure(error, "runtime-stage"); }
}

function materializeRuntimeBundleUnchecked(paths, metadata) {
  const manifest = readJsonObject(join(paths.adapterRoot, "package.json"));
  if (manifest?.name !== ADAPTER_PACKAGE_NAME
    || !nonEmpty(manifest.version)
    || manifest.main !== "src/index.mjs"
    || !isDeepStrictEqual(manifest.exports, { ".": "./src/index.mjs" })
    || !isDeepStrictEqual(manifest.files, PROFILE_BUNDLE_FILES)) {
    throw attachDeploymentFailure(new Error("MemoraX Code DSH adapter source manifest is invalid"), "runtime-stage", { failureReason: "invalid_configuration" });
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
  let stage = "runtime-stage";
  try {
    mkdirSync(temporaryRoot, { mode: 0o700 });
    for (const { relativePath, path: sourcePath } of sourceFiles) {
      const destinationPath = join(temporaryRoot, relativePath);
      mkdirSync(dirname(destinationPath), { recursive: true, mode: 0o700 });
      copyFileSync(sourcePath, destinationPath);
    }
    atomicWriteJson(join(temporaryRoot, PACKAGE_METADATA_FILE), runtimeMetadata);
    stage = "runtime-publish";
    renameSync(temporaryRoot, runtimeBundleRoot);
    return runtimeBundleRoot;
  } catch (error) {
    let cleanupError;
    try { rmSync(temporaryRoot, { recursive: true, force: true }); }
    catch (failure) { cleanupError = failure; }
    throw attachDeploymentFailure(error, stage, { cleanupError });
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
    ? persistedDshHome({ statePath, memoraxCodeHome, adapterRoot, runtimeRoot }, homeDir)
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
  if (state.unreadable) return { ok: false, runtime: RUNTIME, reason: "state_unreadable", statePath: paths.statePath, failure: deploymentFailure(undefined, "state-read", { failureReason: "invalid_record" }) };
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
    return { ok: false, runtime: RUNTIME, reason: "state_invalid", statePath: paths.statePath, failure: deploymentFailure(undefined, "state-read", { failureReason: "invalid_record" }) };
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

function writeDshState(paths, state) {
  try { atomicWriteJson(paths.statePath, state); }
  catch (error) { throw attachDeploymentFailure(error, "state-write"); }
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
  const normalized = normalizeDshCommand(command);
  if (normalized) return normalized;
  const profileRuntime = inspectProfileDshRuntime(paths, state);
  return profileRuntime?.compatibility.compatible === true
    ? profileRuntime.dshCommand
    : "dsh";
}

function resolveDshStatusCompatibility(options, paths, state) {
  if (state?.enabled !== true) return resolveDshCompatibility(options, paths, state);
  const dshCommand = normalizeDshCommand(state.dshCommand);
  if (!dshCommand) {
    return {
      dshCommand: state.dshCommand,
      compatibility: unavailableDshCompatibility("dsh_version_unavailable"),
    };
  }
  const profileRuntime = inspectProfileDshRuntime(paths, state);
  return profileRuntime?.dshCommand === dshCommand
    ? profileRuntime
    : { dshCommand, compatibility: inspectDshCompatibility(options, paths, dshCommand) };
}

function resolveDshCompatibility(options, paths, state) {
  const configured = nonEmpty(options.dshCommand)
    ?? nonEmpty(paths.env.MEMORAX_CODE_DSH_COMMAND);
  if (configured) {
    const dshCommand = normalizeDshCommand(configured);
    return dshCommand
      ? { dshCommand, compatibility: inspectDshCompatibility(options, paths, dshCommand) }
      : {
          dshCommand: configured,
          compatibility: unavailableDshCompatibility("dsh_version_unavailable"),
        };
  }

  const profileRuntime = inspectProfileDshRuntime(paths, state);
  const attemptedCommands = new Set();
  let unavailable;
  for (const value of [state?.dshCommand, "dsh"]) {
    const dshCommand = normalizeDshCommand(value);
    if (!dshCommand || attemptedCommands.has(dshCommand)) continue;
    attemptedCommands.add(dshCommand);
    if (dshCommand === profileRuntime?.dshCommand) {
      if (profileRuntime.compatibility.compatible === true) return profileRuntime;
      continue;
    }
    const compatibility = inspectDshCompatibility(options, paths, dshCommand);
    if (compatibility.compatible === true) return { dshCommand, compatibility };
    unavailable ??= { dshCommand, compatibility };
  }
  if (profileRuntime?.compatibility.compatible === true) return profileRuntime;
  if (profileRuntime?.compatibility.reason === "dsh_profile_runtime_stale") {
    return {
      dshCommand: profileRuntime.dshCommand ?? unavailable?.dshCommand ?? "dsh",
      compatibility: profileRuntime.compatibility,
    };
  }
  return unavailable ?? {
    dshCommand: "dsh",
    compatibility: unavailableDshCompatibility("dsh_version_unavailable"),
  };
}

function normalizeDshCommand(value) {
  const command = nonEmpty(value);
  if (!command) return undefined;
  const name = command
    .split(/[\\/]/)
    .at(-1)
    .replace(/\.(?:cmd|bat|exe|com)$/i, "")
    .toLowerCase();
  if (name === "npx") return undefined;
  return command.includes("/") || command.includes("\\") ? resolve(command) : command;
}

function inspectProfileDshRuntime(paths, state) {
  const packageRoot = join(paths.profilesRoot, "node_modules", ...DSH_PACKAGE_NAME.split("/"));
  const persistedCommand = normalizeDshCommand(state?.dshCommand);
  const profileCommand = persistedCommand && isPathInside(persistedCommand, packageRoot)
    ? persistedCommand
    : undefined;
  try {
    lstatSync(packageRoot);
  } catch (error) {
    return error?.code === "ENOENT" && !profileCommand
      ? undefined
      : {
          dshCommand: profileCommand,
          compatibility: unavailableDshCompatibility("dsh_profile_runtime_stale"),
        };
  }

  try {
    const realPackageRoot = realpathSync(packageRoot);
    if (!lstatSync(realPackageRoot).isDirectory()) throw new Error("DSH package root is not a directory");
    const manifest = readJsonObject(join(realPackageRoot, "package.json"));
    const version = manifest?.name === DSH_PACKAGE_NAME
      ? parseDshVersion(manifest.version)
      : undefined;
    const bin = manifest?.bin !== null
      && typeof manifest?.bin === "object"
      && !Array.isArray(manifest.bin)
      ? nonEmpty(manifest.bin.dsh)
      : undefined;
    if (!version || !bin || isAbsolute(bin)) throw new Error("DSH package metadata is invalid");

    const dshCommand = resolve(packageRoot, bin);
    const realCommand = realpathSync(dshCommand);
    if (!isPathInside(dshCommand, packageRoot)
      || !isPathInside(realCommand, realPackageRoot)
      || !lstatSync(realCommand).isFile()) {
      throw new Error("DSH package entrypoint is invalid");
    }
    return {
      dshCommand,
      compatibility: {
        compatible: true,
        dshVersion: version,
        dshVersionTested: isTestedDshVersion(version),
        testedDshVersions: [...DSH_TESTED_VERSIONS],
      },
    };
  } catch {
    return {
      dshCommand: profileCommand,
      compatibility: unavailableDshCompatibility("dsh_profile_runtime_stale"),
    };
  }
}

function unavailableDshCompatibility(reason) {
  return {
    compatible: false,
    reason,
    testedDshVersions: [...DSH_TESTED_VERSIONS],
    failure: deploymentFailure(undefined, "verify-native", { failureReason: "not_ready" }),
  };
}

// This preload is embedded so an npm replacement can still remove Profiles after
// deleting the package files. It runs only in the Windows DSH plugin subprocess.
async function installWindowsDshPnpmCompatibility() {
  if (process.platform !== "win32") return;
  const { default: childProcess } = await import("node:child_process");
  const { existsSync, readFileSync, statSync } = await import("node:fs");
  const { dirname, join, resolve } = await import("node:path");
  const { syncBuiltinESMExports } = await import("node:module");
  const spawn = childProcess.spawnSync;
  // Our entrypoint is: node dsh.js plugin --profile <name> <pnpm arguments>.
  const expectedArgs = process.argv.slice(5);
  childProcess.spawnSync = (command, args, options) => {
    // Leave newer DSH launchers that disable the shell or escape their arguments alone.
    if (command !== "pnpm" || options?.shell !== true
      || !Array.isArray(args) || args.length !== expectedArgs.length
      || args.some((value, index) => value !== expectedArgs[index])) {
      return spawn(command, args, options);
    }
    // Use Unicode environment paths directly; where.exe output follows the
    // console code page and cannot reliably be decoded as UTF-8.
    const env = options.env ?? process.env;
    const envValue = (name) => env[Object.keys(env).sort()
      .find((key) => key.toLowerCase() === name.toLowerCase())];
    const cwd = options.cwd ?? process.cwd();
    const directories = envValue("NoDefaultCurrentDirectoryInExePath") === undefined ? [cwd] : [];
    directories.push(...String(envValue("PATH") ?? "").split(";")
      .map((value) => resolve(cwd, value.replace(/^"(.*)"$/, "$1"))));
    const extensions = String(envValue("PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
    let executable;
    try {
      for (const directory of directories) {
        for (const extension of extensions) {
          const candidate = join(directory, "pnpm" + extension.toLowerCase());
          try {
            if (statSync(candidate).isFile()) {
              executable = candidate;
              break;
            }
          } catch (error) {
            if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
          }
        }
        if (executable) break;
      }
    } catch (error) {
      return { status: null, signal: null, error };
    }
    if (!executable) {
      return {
        status: null,
        signal: null,
        error: Object.assign(new Error("pnpm not found on PATH"), { code: "ENOENT" }),
      };
    }
    if (executable && /\.(?:exe|com)$/i.test(executable)) {
      return spawn(executable, args, { ...options, shell: false });
    }
    let entrypoint;
    if (executable) {
      try {
        // Read the selected shim's target: pnpm and Corepack can coexist in one prefix.
        const shim = readFileSync(executable, "utf8").replaceAll("\\", "/");
        const target = /%(?:dp0%|~dp0)[/]((?:node_modules\/|\.\.\/)(?:pnpm\/bin\/pnpm\.cjs|corepack\/dist\/pnpm\.js))"/i.exec(shim)?.[1];
        const candidate = target && join(dirname(executable), target);
        if (candidate && existsSync(candidate)) entrypoint = candidate;
      } catch (error) {
        return { status: null, signal: null, error };
      }
    }
    if (!entrypoint) {
      return {
        status: null,
        signal: null,
        error: Object.assign(new Error("Cannot resolve pnpm's Windows Node entrypoint"), { code: "ENOEXEC" }),
      };
    }
    // Forward the original arguments, including literal percent signs, without
    // cmd.exe expansion. DSH still owns Profile mutation and reconciliation.
    return spawn(process.execPath, [entrypoint, ...args], { ...options, shell: false });
  };
  syncBuiltinESMExports();
}

const WINDOWS_DSH_PNPM_PRELOAD = "data:text/javascript;base64," + Buffer.from(
  "await (" + installWindowsDshPnpmCompatibility.toString() + ")();",
).toString("base64");

function runDsh(options, paths, args, command) {
  const env = { ...paths.env, DSH_HOME: paths.dshHome };
  let executable;
  try {
    const [launcher, ...launcherArgs] = buildDshCommand(command, args, {
      nodePath: options.windowsCliResolution?.nodePath,
    });
    executable = resolveWindowsCliInvocation(launcher, launcherArgs, {
      ...options.windowsCliResolution,
      env,
    });
  } catch (error) {
    return { status: 1, error };
  }
  if ((options.windowsCliResolution?.platform ?? process.platform) === "win32"
    && args[0] === "plugin"
    && /\.(?:cjs|mjs|js)$/i.test(executable.args[0] ?? "")) {
    executable.args = ["--import", WINDOWS_DSH_PNPM_PRELOAD, ...executable.args];
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
      failure: deploymentFailure(result.error, "native-command", { commandResult: result }),
    };
  }
  const output = parseDshVersion(result.stdout);
  if (!output) {
    return {
      compatible: false,
      reason: "dsh_version_unavailable",
      testedDshVersions: [...DSH_TESTED_VERSIONS],
      failure: deploymentFailure(undefined, "verify-native", { failureReason: "invalid_response" }),
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
  const verificationFailed = contractReason && result.status === 0 && !result.error && !result.signal;
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
    failure: deploymentFailure(result.error, verificationFailed ? "verify-native" : "native-command", {
      commandResult: result,
      ...(verificationFailed ? { failureReason: "verification_failed" } : {}),
    }),
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
        failure: claimedProfiles.find((profile) => profile.status === "manifest_unreadable")?.failure
          ?? deploymentFailure(undefined, "config-read", { failureReason: "invalid_record" }),
      }
    : undefined;
}

function profileManifestFailure(name, profile) {
  return {
    name, reason: "profile_manifest_unreadable",
    failure: profile?.failure ?? deploymentFailure(undefined, "config-read", { failureReason: "invalid_record" }),
  };
}

function profileMutationFailure(name, result, profile, contractReason) {
  return result.status === 0 && !result.error && profile.status === "manifest_unreadable"
    ? profileManifestFailure(name, profile)
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
    return {
      status: error?.code === "ENOENT" ? "directory_missing" : "manifest_unreadable", name,
      ...(error?.code !== "ENOENT" ? { failure: deploymentFailure(error, "config-read") } : {}),
    };
  }
  let stage = "config-read";
  try {
    const text = readFileSync(join(path, "package.json"), "utf8");
    stage = "config-parse";
    const manifest = JSON.parse(text);
    const bundles = manifest?.dsh?.profile?.bundles;
    if (!Array.isArray(bundles) || !bundles.every((value) => typeof value === "string")) {
      return { status: "manifest_unreadable", name, failure: deploymentFailure(undefined, stage, { failureReason: "invalid_record" }) };
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
  } catch (error) {
    return { status: "manifest_unreadable", name, failure: deploymentFailure(error, stage, {
      ...(stage === "config-parse" ? { failureReason: "invalid_record" } : {}),
    }) };
  }
}

function profileMentionsAdapter(profile) {
  return MANAGED_ADAPTER_PACKAGE_NAMES.some((packageName) => (
    profileMentionsPackage(profile, packageName)
  ));
}

function profileMentionsPackage(profile, packageName) {
  return Boolean(profile
    && (Object.hasOwn(profile.dependencies, packageName)
      || profile.bundles.includes(packageName)));
}

function profileHasAdapter(profile, packageName = ADAPTER_PACKAGE_NAME) {
  return Boolean(profile
    && Object.hasOwn(profile.dependencies, packageName)
    && profile.bundles.includes(packageName));
}

function managedProfilesHaveInstalledHeadlessBundle(profiles, managedNames, options, paths, command) {
  const installAnchor = resolveDshInstallAnchor(command, options, paths);
  return profiles.some((profile) => (
    managedNames.has(profile.name) && profileHasInstalledHeadlessBundle(profile, installAnchor)
  ));
}

function resolveDshInstallAnchor(command, options, paths) {
  if (!command) return undefined;
  try {
    const [launcher, ...args] = buildDshCommand(command, [], {
      nodePath: options.windowsCliResolution?.nodePath,
    });
    const invocation = resolveWindowsCliInvocation(launcher, args, {
      ...options.windowsCliResolution,
      env: paths.env,
    });
    let entrypoint = invocation.args[0] ?? invocation.command;
    if (!isAbsolute(entrypoint)) {
      entrypoint = (paths.env.PATH ?? "").split(delimiter)
        .map((directory) => resolve(paths.adapterRoot, directory, entrypoint))
        .find((candidate) => {
          try {
            accessSync(candidate, constants.X_OK);
            return true;
          } catch {
            return false;
          }
        });
    }
    if (!entrypoint) return undefined;
    // Follow the selected CLI's npm symlink or Windows shim, not this adapter's
    // dependencies: DSH resolves built-in bundles from its own installation.
    for (let root = dirname(realpathSync(entrypoint)); ; root = dirname(root)) {
      const manifestPath = join(root, "package.json");
      if (existsSync(manifestPath)
        && JSON.parse(readFileSync(manifestPath, "utf8")).name === DSH_PACKAGE_NAME) {
        return manifestPath;
      }
      if (dirname(root) === root) return undefined;
    }
  } catch {
    // Older or packaged CLIs may expose only the Profile's shared module tree.
    return undefined;
  }
}

function profileHasInstalledHeadlessBundle(profile, installAnchor) {
  if (!profile?.bundles.includes(HEADLESS_BUNDLE_NAME)) return false;
  // Modern DSH uses installation-first resolution before a session has created
  // profiles/node_modules. Keep the Profile tree as the legacy fallback.
  for (const anchor of [installAnchor, join(profile.path, "package.json")].filter(Boolean)) {
    const requireFromAnchor = createRequire(anchor);
    if (!(requireFromAnchor.resolve.paths(HEADLESS_BUNDLE_NAME) ?? []).some((directory) => (
      existsSync(join(directory, HEADLESS_BUNDLE_NAME, "package.json"))
    ))) continue;
    try {
      readFileSync(requireFromAnchor.resolve(HEADLESS_BUNDLE_NAME), "utf8");
      return true;
    } catch {
      // A broken selected bundle must not be hidden by a different legacy copy.
      return false;
    }
  }
  return false;
}

function profileHasInstalledAdapter(
  profile,
  runtimeBundleRoot,
  state,
) {
  if (!state || !nonEmpty(runtimeBundleRoot)) return false;
  try {
    const sourceManifest = readJsonObject(join(runtimeBundleRoot, "package.json"));
    const packageName = sourceManifest?.name;
    if (!MANAGED_ADAPTER_PACKAGE_NAMES.includes(packageName)
      || !profileHasAdapter(profile, packageName)
      || !nonEmpty(sourceManifest.version)) return false;

    const requireFromProfile = createRequire(join(profile.path, "package.json"));
    const packageRoot = (requireFromProfile.resolve.paths(packageName) ?? [])
      .map((searchPath) => join(searchPath, packageName))
      .find((candidate) => existsSync(join(candidate, "package.json")));
    if (!packageRoot) return false;

    const installedManifest = readJsonObject(join(packageRoot, "package.json"));
    const sourcePatch = sourceManifest?.dsh?.bundle?.patch;
    if (installedManifest?.name !== packageName
      || installedManifest.version !== sourceManifest.version
      || installedManifest.main !== sourceManifest.main
      || !isDeepStrictEqual(installedManifest.exports, sourceManifest.exports)
      || typeof sourcePatch !== "string"
      || !sourcePatch
      || installedManifest?.dsh?.bundle?.patch !== sourcePatch) return false;

    readFileSync(join(packageRoot, sourcePatch), "utf8");
    readFileSync(requireFromProfile.resolve(packageName), "utf8");
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

function runtimeAdapterPackageName(runtimeBundleRoot) {
  try {
    const packageName = readJsonObject(join(runtimeBundleRoot, "package.json"))?.name;
    return MANAGED_ADAPTER_PACKAGE_NAMES.includes(packageName) ? packageName : undefined;
  } catch {
    return undefined;
  }
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
