import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { attachDeploymentFailure, deploymentFailure } from "../../memorax-code-adapter-common/src/deployment-failure.mjs";
import { removeDeepAgentsPluginInstallation } from "./plugin-install.mjs";
import {
  DEFAULT_BACKEND_URL,
  DEFAULT_TOKEN_ENV,
  RUNTIME,
  adapterSessionRegistryPath,
  adapterStatePath,
  adapterWorkspaceStatePath,
  defaultDeepAgentsHome,
  defaultMemoraxCodeHome,
  normalizeBackendUrl,
  tempDeepAgentsHome,
} from "./adapter-paths.mjs";

export {
  DEFAULT_BACKEND_URL,
  DEFAULT_TOKEN_ENV,
  RUNTIME,
  adapterSessionRegistryPath,
  adapterStatePath,
  adapterWorkspaceStatePath,
  defaultDeepAgentsHome,
  defaultMemoraxCodeHome,
  normalizeBackendUrl,
  tempDeepAgentsHome,
} from "./adapter-paths.mjs";

import {
  atomicWriteJson,
  readAdapterState,
  stringOption,
} from "./config-utils.mjs";
export { readAdapterState, sha256 } from "./config-utils.mjs";

const DEEPAGENTS_ADAPTER_STATE_VERSION = 1;
const DEEPAGENTS_INTEGRATION = "plugin";
const DEEPAGENTS_PLUGIN_SKILL_NAMES = ["memorax-code"];

export function enableDeepAgentsAdapter(options = {}) {
  const deepAgentsHome = options.deepAgentsHome ?? defaultDeepAgentsHome();
  const memoraxCodeHome = options.memoraxCodeHome ?? defaultMemoraxCodeHome();
  const statePath = options.statePath ?? adapterStatePath(memoraxCodeHome, RUNTIME);
  const previousState = readAdapterState(statePath);
  if (previousState?.unreadable) {
    return {
      ok: false,
      action: "enable",
      reason: "state_unreadable",
      statePath,
      failure: deploymentFailure(undefined, "state-read", { failureReason: "unknown" }),
    };
  }
  if (previousState && previousState.version !== DEEPAGENTS_ADAPTER_STATE_VERSION) {
    return {
      ok: false,
      action: "enable",
      reason: "state_version_unsupported",
      statePath,
      failure: deploymentFailure(undefined, "state-read", { failureReason: "unsupported_version" }),
      expectedVersion: DEEPAGENTS_ADAPTER_STATE_VERSION,
      actualVersion: previousState.version,
    };
  }
  const backendUrl = options.backendUrl ?? previousState?.backendUrl ?? DEFAULT_BACKEND_URL;
  const pluginSkillsRoot = stringOption(options.deepAgentsPluginSkillsRoot);
  const deepAgentsSkills = deepAgentsPluginSkillsSummary(pluginSkillsRoot);
  if (deepAgentsSkills.ok === false) {
    return {
      ok: false,
      action: "enable",
      reason: "skill_delivery_failed",
      statePath,
      deepAgentsSkills,
      failure: deploymentFailure(undefined, "verify", { failureReason: "verification_failed" }),
    };
  }
  const state = {
    version: DEEPAGENTS_ADAPTER_STATE_VERSION,
    runtime: RUNTIME,
    integration: DEEPAGENTS_INTEGRATION,
    enabled: true,
    enabledAt: previousState?.enabled === true && stringOption(previousState.enabledAt)
      ? previousState.enabledAt
      : new Date().toISOString(),
    deepAgentsHome,
    backendUrl: normalizeBackendUrl(backendUrl),
    deepAgentsSkillDelivery: "plugin",
    ...(pluginSkillsRoot ? { deepAgentsPluginSkillsRoot: pluginSkillsRoot } : {}),
  };
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    atomicWriteJson(statePath, state);
  } catch (error) { throw attachDeploymentFailure(error, "state-write"); }
  return {
    ok: true,
    action: "enable",
    deepAgentsHome,
    memoraxCodeHome,
    statePath,
    state,
    installed: true,
    enabled: true,
    integration: DEEPAGENTS_INTEGRATION,
    changed: previousState?.enabled !== true
      || previousState?.integration !== DEEPAGENTS_INTEGRATION
      || previousState?.deepAgentsSkillDelivery !== "plugin"
      || stringOption(previousState?.deepAgentsPluginSkillsRoot) !== pluginSkillsRoot,
    deepAgentsSkills,
  };
}

export function disableDeepAgentsAdapter(options = {}) {
  const deepAgentsHome = options.deepAgentsHome ?? defaultDeepAgentsHome();
  const memoraxCodeHome = options.memoraxCodeHome ?? defaultMemoraxCodeHome();
  const statePath = options.statePath ?? adapterStatePath(memoraxCodeHome, RUNTIME);
  const state = readAdapterState(statePath);
  if (state?.unreadable) {
    return { ok: false, action: "disable", reason: "state_unreadable", statePath };
  }
  if (state && state.version !== DEEPAGENTS_ADAPTER_STATE_VERSION) {
    return {
      ok: false,
      action: "disable",
      reason: "state_version_unsupported",
      statePath,
      expectedVersion: DEEPAGENTS_ADAPTER_STATE_VERSION,
      actualVersion: state.version,
    };
  }
  const deepAgentsSkills = deepAgentsPluginSkillsSummary(
    stringOption(options.deepAgentsPluginSkillsRoot) ?? stringOption(state?.deepAgentsPluginSkillsRoot),
  );
  const disabledState = {
    version: DEEPAGENTS_ADAPTER_STATE_VERSION,
    runtime: RUNTIME,
    integration: DEEPAGENTS_INTEGRATION,
    enabled: false,
    disabledAt: new Date().toISOString(),
    deepAgentsHome,
    backendUrl: normalizeBackendUrl(options.backendUrl ?? state?.backendUrl ?? DEFAULT_BACKEND_URL),
  };
  mkdirSync(dirname(statePath), { recursive: true });
  atomicWriteJson(statePath, disabledState);
  return {
    ok: true,
    action: "disable",
    deepAgentsHome,
    memoraxCodeHome,
    statePath,
    state: disabledState,
    installed: false,
    enabled: false,
    integration: DEEPAGENTS_INTEGRATION,
    changed: state?.enabled === true,
    deepAgentsSkills,
  };
}

export function readDeepAgentsAdapterStatus(options = {}) {
  const deepAgentsHome = options.deepAgentsHome ?? defaultDeepAgentsHome();
  const memoraxCodeHome = options.memoraxCodeHome ?? defaultMemoraxCodeHome();
  const statePath = options.statePath ?? adapterStatePath(memoraxCodeHome, RUNTIME);
  const state = readAdapterState(statePath);
  const enabled = state?.unreadable !== true
    && state?.version === DEEPAGENTS_ADAPTER_STATE_VERSION
    && state?.enabled === true
    && state?.integration === DEEPAGENTS_INTEGRATION;
  const configuredBackendUrl = stringOption(state?.backendUrl)
    ? normalizeBackendUrl(state.backendUrl)
    : undefined;
  const expectedBackendUrl = stringOption(options.backendUrl)
    ? normalizeBackendUrl(options.backendUrl)
    : undefined;
  return {
    ok: true,
    action: "status",
    deepAgentsHome,
    memoraxCodeHome,
    statePath,
    state,
    installed: enabled,
    enabled,
    integration: DEEPAGENTS_INTEGRATION,
    memoryIntegration: DEEPAGENTS_INTEGRATION,
    configuredBackendUrl,
    expectedBackendUrl,
    backendUrlMatches: !expectedBackendUrl
      || configuredBackendUrl === expectedBackendUrl
      || (!configuredBackendUrl && !enabled),
    deepAgentsSkills: deepAgentsPluginSkillsSummary(
      stringOption(options.deepAgentsPluginSkillsRoot) ?? stringOption(state?.deepAgentsPluginSkillsRoot),
    ),
  };
}

function deepAgentsPluginSkillsSummary(rootPath) {
  const skills = DEEPAGENTS_PLUGIN_SKILL_NAMES.map((name) => {
    const sourcePath = rootPath ? join(rootPath, name) : "";
    const sourceExists = Boolean(rootPath) && existsSync(join(sourcePath, "SKILL.md"));
    return {
      name,
      sourcePath,
      targetPath: "",
      sourceKind: "plugin",
      sourceExists,
      targetExists: false,
      targetIsSymlink: false,
      ok: sourceExists,
      status: sourceExists ? "plugin-managed" : "missing",
      ...(!sourceExists ? { reason: "plugin_skill_missing" } : {}),
    };
  });
  const missing = skills.filter((skill) => !skill.sourceExists).length;
  return {
    ok: missing === 0,
    status: missing === 0 ? "plugin-managed" : "missing",
    delivery: "plugin",
    rootPath: rootPath ?? "",
    skills,
    counts: {
      total: skills.length,
      linked: 0,
      missing,
      conflict: 0,
      sourceMissing: 0,
      failed: 0,
      changed: 0,
      removed: 0,
    },
  };
}

export function readDeepAgentsWorkspaceStatus(options = {}) {
  const memoraxCodeHome = options.memoraxCodeHome ?? defaultMemoraxCodeHome();
  const path = adapterWorkspaceStatePath(memoraxCodeHome, RUNTIME);
  const state = readAdapterState(path);
  const latest = state?.latest && typeof state.latest === "object" ? state.latest : undefined;
  return {
    ok: true,
    path,
    captured: Boolean(latest?.cwd),
    latest,
    sessionCount: state?.sessions && typeof state.sessions === "object" ? Object.keys(state.sessions).length : 0,
    state,
  };
}

export function removeDeepAgentsAdapter(options = {}) {
  return removeDeepAgentsPluginInstallation(options);
}
