import { existsSync, lstatSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { attachDeploymentFailure, deploymentFailure } from "../../memorax-code-adapter-common/src/deployment-failure.mjs";
import {
  DEFAULT_BACKEND_URL,
  DEFAULT_TOKEN_ENV,
  RUNTIME,
  adapterSessionRegistryPath,
  adapterStatePath,
  adapterWorkspaceStatePath,
  claudeSettingsPath,
  defaultClaudeHome,
  defaultMemoraxCodeHome,
  normalizeBackendUrl,
  tempClaudeHome,
} from "./adapter-paths.mjs";
export {
  DEFAULT_BACKEND_URL,
  DEFAULT_TOKEN_ENV,
  RUNTIME,
  adapterSessionRegistryPath,
  adapterStatePath,
  adapterWorkspaceStatePath,
  claudeSettingsPath,
  defaultClaudeHome,
  defaultMemoraxCodeHome,
  normalizeBackendUrl,
  tempClaudeHome,
} from "./adapter-paths.mjs";
import {
  atomicWriteJson,
  readAdapterState,
  sha256,
  stringOption,
  withJsonFileLock,
} from "./config-utils.mjs";
export { readAdapterState, sha256 } from "./config-utils.mjs";

const CLAUDE_ADAPTER_STATE_VERSION = 1;
const CLAUDE_INTEGRATION = "hooks";
const CLAUDE_PLUGIN_SKILL_NAMES = ["memorax-code"];

export function enableClaudeAdapter(options = {}) {
  const claudeHome = options.claudeHome ?? defaultClaudeHome();
  const memoraxCodeHome = options.memoraxCodeHome ?? defaultMemoraxCodeHome();
  const statePath = options.statePath ?? adapterStatePath(memoraxCodeHome, RUNTIME);
  const previousState = readAdapterState(statePath);
  if (previousState?.unreadable) {
    return { ok: false, action: "enable", reason: "state_unreadable", statePath,
      failure: deploymentFailure(undefined, "state-read", { failureReason: "unknown" }),
    };
  }
  if (previousState && previousState.version !== CLAUDE_ADAPTER_STATE_VERSION) {
    return {
      ok: false,
      action: "enable",
      reason: "state_version_unsupported",
      failure: deploymentFailure(undefined, "state-read", { failureReason: "unsupported_version" }),
      statePath,
      expectedVersion: CLAUDE_ADAPTER_STATE_VERSION,
      actualVersion: previousState.version,
    };
  }
  const backendUrl = options.backendUrl
    ?? previousState?.backendUrl
    ?? DEFAULT_BACKEND_URL;
  const nativeBaseline = seedExistingClaudeSessionsAsNative({ ...options, claudeHome, memoraxCodeHome, dryRun: true });
  if (!nativeBaseline.ok) return { ok: false, action: "enable", statePath, ...nativeBaseline,
    failure: deploymentFailure(nativeBaseline, "state-read", { failureReason: "unknown" }),
  };
  const claudePluginSkillsRoot = stringOption(options.claudePluginSkillsRoot);
  const claudeSkills = claudePluginSkillsSummary(claudePluginSkillsRoot);
  if (claudeSkills.ok === false) {
    return { ok: false, action: "enable", reason: "skill_delivery_failed", statePath, claudeSkills,
      failure: deploymentFailure(undefined, "verify", { failureReason: "verification_failed" }),
    };
  }
  const state = {
    version: CLAUDE_ADAPTER_STATE_VERSION,
    runtime: RUNTIME,
    integration: CLAUDE_INTEGRATION,
    enabled: true,
    enabledAt: previousState?.enabled === true && stringOption(previousState.enabledAt)
      ? previousState.enabledAt
      : new Date().toISOString(),
    claudeHome,
    backendUrl: normalizeBackendUrl(backendUrl),
    claudeSkillDelivery: "plugin",
    ...(claudePluginSkillsRoot ? { claudePluginSkillsRoot } : {}),
  };
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    atomicWriteJson(statePath, state);
  } catch (error) { throw attachDeploymentFailure(error, "state-write"); }
  const seededNativeSessions = seedExistingClaudeSessionsAsNative({ ...options, claudeHome, memoraxCodeHome });
  return {
    ok: true,
    action: "enable",
    claudeHome,
    memoraxCodeHome,
    statePath,
    state,
    installed: true,
    enabled: true,
    integration: CLAUDE_INTEGRATION,
    changed: previousState?.enabled !== true
      || previousState?.integration !== CLAUDE_INTEGRATION
      || previousState?.claudeSkillDelivery !== "plugin"
      || stringOption(previousState?.claudePluginSkillsRoot) !== claudePluginSkillsRoot,
    seededNativeSessions,
    claudeSkills,
  };
}

export function disableClaudeAdapter(options = {}) {
  const claudeHome = options.claudeHome ?? defaultClaudeHome();
  const memoraxCodeHome = options.memoraxCodeHome ?? defaultMemoraxCodeHome();
  const statePath = options.statePath ?? adapterStatePath(memoraxCodeHome, RUNTIME);
  const state = readAdapterState(statePath);
  if (state?.unreadable) {
    return { ok: false, action: "disable", reason: "state_unreadable", statePath };
  }
  if (state && state.version !== CLAUDE_ADAPTER_STATE_VERSION) {
    return {
      ok: false,
      action: "disable",
      reason: "state_version_unsupported",
      statePath,
      expectedVersion: CLAUDE_ADAPTER_STATE_VERSION,
      actualVersion: state.version,
    };
  }
  const claudeSkills = claudePluginSkillsSummary(
    stringOption(options.claudePluginSkillsRoot) ?? stringOption(state?.claudePluginSkillsRoot),
  );
  const disabledState = {
    version: CLAUDE_ADAPTER_STATE_VERSION,
    runtime: RUNTIME,
    integration: CLAUDE_INTEGRATION,
    enabled: false,
    disabledAt: new Date().toISOString(),
    claudeHome,
    backendUrl: normalizeBackendUrl(
      options.backendUrl
        ?? state?.backendUrl
        ?? DEFAULT_BACKEND_URL,
    ),
  };
  mkdirSync(dirname(statePath), { recursive: true });
  atomicWriteJson(statePath, disabledState);
  return {
    ok: true,
    action: "disable",
    claudeHome,
    memoraxCodeHome,
    statePath,
    state: disabledState,
    installed: false,
    enabled: false,
    integration: CLAUDE_INTEGRATION,
    changed: state?.enabled === true,
    claudeSkills,
  };
}

export function readClaudeAdapterStatus(options = {}) {
  const claudeHome = options.claudeHome ?? defaultClaudeHome();
  const memoraxCodeHome = options.memoraxCodeHome ?? defaultMemoraxCodeHome();
  const statePath = options.statePath ?? adapterStatePath(memoraxCodeHome, RUNTIME);
  const state = readAdapterState(statePath);
  const enabled = state?.unreadable !== true
    && state?.version === CLAUDE_ADAPTER_STATE_VERSION
    && state?.enabled === true
    && state?.integration === CLAUDE_INTEGRATION;
  const configuredBackendUrl = stringOption(state?.backendUrl)
    ? normalizeBackendUrl(state.backendUrl)
    : undefined;
  const expectedBackendUrl = stringOption(options.backendUrl)
    ? normalizeBackendUrl(options.backendUrl)
    : undefined;
  return {
    ok: true,
    action: "status",
    claudeHome,
    memoraxCodeHome,
    statePath,
    state,
    installed: enabled,
    enabled,
    integration: CLAUDE_INTEGRATION,
    memoryIntegration: CLAUDE_INTEGRATION,
    configuredBackendUrl,
    expectedBackendUrl,
    backendUrlMatches: !expectedBackendUrl
      || configuredBackendUrl === expectedBackendUrl
      || (!configuredBackendUrl && !enabled),
    claudeSkills: claudePluginSkillsSummary(
      stringOption(options.claudePluginSkillsRoot) ?? stringOption(state?.claudePluginSkillsRoot),
    ),
  };
}

function claudePluginSkillsSummary(rootPath) {
  const skills = CLAUDE_PLUGIN_SKILL_NAMES.map((name) => {
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

export function readClaudeWorkspaceStatus(options = {}) {
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

export function inspectClaudeHistory(options = {}) {
  const claudeHome = options.claudeHome ?? defaultClaudeHome();
  const memoraxCodeHome = options.memoraxCodeHome ?? defaultMemoraxCodeHome();
  const sessionsRoot = join(claudeHome, "projects");
  const nativeSessions = collectSessionFiles(sessionsRoot, claudeHome, options);
  const historyPath = join(claudeHome, "history.jsonl");
  return {
    ok: true,
    action: "inspect-history",
    claudeHome,
    memoraxCodeHome,
    readOnly: true,
    native: {
      sessionsRoot,
      sessionsRootExists: existsSync(sessionsRoot),
      historyPath,
      historyExists: existsSync(historyPath),
      sessionCount: nativeSessions.length,
      sessions: nativeSessions,
    },
    memoraxCode: {
      registryPath: adapterSessionRegistryPath(memoraxCodeHome, RUNTIME),
      workspaceStatePath: adapterWorkspaceStatePath(memoraxCodeHome, RUNTIME),
      registryExists: existsSync(adapterSessionRegistryPath(memoraxCodeHome, RUNTIME)),
      workspaceStateExists: existsSync(adapterWorkspaceStatePath(memoraxCodeHome, RUNTIME)),
    },
  };
}

export function readClaudeSessionRegistry(options = {}) {
  const memoraxCodeHome = options.memoraxCodeHome ?? defaultMemoraxCodeHome();
  const path = options.registryPath ?? adapterSessionRegistryPath(memoraxCodeHome, RUNTIME);
  const state = readAdapterState(path);
  const rawSessions = state?.sessions && typeof state.sessions === "object" && !Array.isArray(state.sessions)
    ? state.sessions
    : {};
  const sessions = {};
  for (const [key, value] of Object.entries(rawSessions)) {
    if (!value || typeof value !== "object") continue;
    const session = normalizeRegistrySession(key, value);
    if (session) sessions[key] = session;
  }
  return {
    ok: true,
    action: "session-registry",
    path,
    exists: existsSync(path),
    unreadable: Boolean(state?.unreadable),
    state: {
      version: 1,
      runtime: "claude-code",
      updatedAt: typeof state?.updatedAt === "string" ? state.updatedAt : undefined,
      sessions,
    },
  };
}

export function updateClaudeSessionRegistry(options = {}) {
  const memoraxCodeHome = options.memoraxCodeHome ?? defaultMemoraxCodeHome();
  const path = options.registryPath ?? adapterSessionRegistryPath(memoraxCodeHome, RUNTIME);
  const sessionId = stringOption(options.sessionId);
  if (!sessionId) return { ok: false, action: "mark-session", reason: "missing_session_id", message: "--session-id is required", path };
  return withJsonFileLock(path, () => {
    const registry = readClaudeSessionRegistry({ ...options, memoraxCodeHome, registryPath: path });
    if (registry.unreadable) {
      return { ok: false, action: "mark-session", reason: "unreadable_registry", message: "session registry is unreadable; inspect it before overwriting", path };
    }
    const existing = registry.state.sessions[sessionId];
    const now = new Date().toISOString();
    const session = {
      ...(existing ?? {}),
      key: sessionId,
      title: stringOption(options.title) ?? existing?.title,
      claudeSessionId: stringOption(options.claudeSessionId) ?? existing?.claudeSessionId ?? sessionId,
      transcriptPath: stringOption(options.transcriptPath) ?? existing?.transcriptPath,
      workspace: stringOption(options.workspace) ?? existing?.workspace,
    };
    const state = {
      version: 1,
      runtime: "claude-code",
      updatedAt: now,
      sessions: {
        ...registry.state.sessions,
        [sessionId]: session,
      },
    };
    atomicWriteJson(path, state);
    return { ok: true, action: "mark-session", path, session, changed: JSON.stringify(existing) !== JSON.stringify(session) };
  });
}

function seedExistingClaudeSessionsAsNative(options = {}) {
  const claudeHome = options.claudeHome ?? defaultClaudeHome();
  const memoraxCodeHome = options.memoraxCodeHome ?? defaultMemoraxCodeHome();
  const path = options.registryPath ?? adapterSessionRegistryPath(memoraxCodeHome, RUNTIME);
  const initialRegistry = readClaudeSessionRegistry({ ...options, memoraxCodeHome, registryPath: path });
  if (initialRegistry.unreadable) return unreadableClaudeRegistry(path);
  const history = inspectClaudeHistory({ ...options, claudeHome, memoraxCodeHome });
  if (options.dryRun) return seedClaudeSessions(path, claudeHome, initialRegistry, history, false);
  return withJsonFileLock(path, () => {
    const registry = readClaudeSessionRegistry({ ...options, memoraxCodeHome, registryPath: path });
    if (registry.unreadable) return unreadableClaudeRegistry(path);
    return seedClaudeSessions(path, claudeHome, registry, history, true);
  });
}

function seedClaudeSessions(path, claudeHome, registry, history, write) {
  const existingSessions = registry.state.sessions;
  const sessions = { ...existingSessions };
  const now = new Date().toISOString();
  let seeded = 0;
  for (const item of history.native.sessions) {
    if (findExistingRegistrySessionKey(sessions, item)) continue;
    const transcriptPath = join(claudeHome, item.relativePath);
    sessions[item.id] = {
      key: item.id,
      claudeSessionId: item.id,
      transcriptPath,
    };
    seeded += 1;
  }
  if (write && seeded > 0) {
    atomicWriteJson(path, {
      version: 1,
      runtime: "claude-code",
      updatedAt: now,
      sessions,
    });
  }
  return { ok: true, action: "seed-native-sessions", path, inspected: history.native.sessionCount, seeded };
}

function unreadableClaudeRegistry(path) {
  return {
    ok: false,
    action: "seed-native-sessions",
    reason: "unreadable_registry",
    message: "session registry is unreadable; inspect it before seeding native Claude sessions",
    path,
  };
}

function findExistingRegistrySessionKey(sessions, item) {
  for (const [key, session] of Object.entries(sessions ?? {})) {
    if (key === item.id) return key;
    if (session?.claudeSessionId === item.id) return key;
    if (session?.transcriptPath && item.relativePath && String(session.transcriptPath).endsWith(item.relativePath)) return key;
  }
  return undefined;
}

export function readMergedClaudeSessions(options = {}) {
  const history = inspectClaudeHistory(options);
  const registry = readClaudeSessionRegistry(options);
  const workspaceStatus = readClaudeWorkspaceStatus(options);
  if (registry.unreadable) {
    return {
      ok: false,
      action: "sessions",
      reason: "unreadable_registry",
      message: "session registry is unreadable; sessions are not merged to avoid hiding or rewriting adapter state",
      claudeHome: history.claudeHome,
      memoraxCodeHome: history.memoraxCodeHome,
      registryPath: registry.path,
      nativeSessionCount: history.native.sessionCount,
      sessionCount: 0,
      sessions: [],
    };
  }
  const workspaceByKey = workspaceRecordMap(workspaceStatus.state);
  const registeredByClaudeId = new Map();
  for (const session of Object.values(registry.state.sessions)) {
    if (session.claudeSessionId) registeredByClaudeId.set(session.claudeSessionId, session);
  }
  const native = history.native.sessions.map((item) => {
    const registered = registeredByClaudeId.get(item.id);
    const workspace = findWorkspaceRecord(workspaceByKey, registered?.key, item.id, registered?.transcriptPath, item.relativePath);
    return {
      key: registered?.key ?? item.id,
      title: registered?.title,
      claudeSessionId: item.id,
      relativePath: item.relativePath,
      pathHash: item.pathHash,
      sizeBytes: item.sizeBytes,
      modifiedAt: item.modifiedAt,
      workspace: registered?.workspace ?? workspace?.cwd,
      transcriptPath: registered?.transcriptPath ?? workspace?.transcriptPath,
      observedAt: workspace?.capturedAt,
    };
  });
  const sessions = native.sort((a, b) => String(b.modifiedAt ?? "").localeCompare(String(a.modifiedAt ?? "")));
  return {
    ok: true,
    action: "sessions",
    claudeHome: history.claudeHome,
    memoraxCodeHome: history.memoraxCodeHome,
    registryPath: registry.path,
    sessionCount: sessions.length,
    sessions,
  };
}

function collectSessionFiles(root, claudeHome, options = {}) {
  const requestedMaxFiles = Number(options.maxFiles);
  const requestedMaxDepth = Number(options.maxDepth);
  const maxFiles = Number.isFinite(requestedMaxFiles) ? Math.max(0, Math.floor(requestedMaxFiles)) : 500;
  const maxDepth = Number.isFinite(requestedMaxDepth) ? Math.max(0, Math.floor(requestedMaxDepth)) : 8;
  const files = [];
  walkSessionFiles(root, 0, maxDepth, files, maxFiles);
  return files.map((path) => sessionFileSummary(path, claudeHome)).filter(Boolean);
}

function walkSessionFiles(path, depth, maxDepth, files, maxFiles) {
  if (files.length >= maxFiles || depth > maxDepth || !existsSync(path)) return;
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) return;
  if (stat.isFile()) {
    if (/\.(jsonl|json)$/i.test(path)) files.push(path);
    return;
  }
  if (!stat.isDirectory()) return;
  let entries = [];
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    return;
  }
  entries
    .sort((a, b) => a.name.localeCompare(b.name))
    .forEach((entry) => walkSessionFiles(join(path, entry.name), depth + 1, maxDepth, files, maxFiles));
}

function sessionFileSummary(path, claudeHome) {
  try {
    const stat = statSync(path);
    const relativePath = relative(claudeHome, path);
    const id = basename(path).replace(/\.(jsonl|json)$/i, "");
    return {
      id,
      kind: "claude-session-file",
      relativePath,
      pathHash: sha256(relativePath).slice(0, 16),
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    };
  } catch {
    return undefined;
  }
}

function normalizeRegistrySession(key, value) {
  return {
    key,
    title: stringOption(value.title),
    claudeSessionId: stringOption(value.claudeSessionId),
    transcriptPath: stringOption(value.transcriptPath),
    workspace: stringOption(value.workspace),
  };
}

function workspaceRecordMap(state) {
  const raw = state?.sessions && typeof state.sessions === "object" && !Array.isArray(state.sessions)
    ? state.sessions
    : {};
  const records = new Map();
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    records.set(key, value);
  }
  return records;
}

function findWorkspaceRecord(records, ...keys) {
  for (const key of workspaceLookupKeys(keys)) {
    const record = records.get(key);
    if (record) return record;
  }
  return undefined;
}

function workspaceLookupKeys(keys) {
  const result = new Set();
  for (const key of keys) {
    const value = stringOption(key);
    if (!value) continue;
    result.add(value);
    const base = basename(value).replace(/\.[^.]+$/, "");
    result.add(base);
    if (value.startsWith("claude_")) result.add(value.slice("claude_".length));
    else result.add(`claude_${value}`);
    if (base.startsWith("claude_")) result.add(base.slice("claude_".length));
    else result.add(`claude_${base}`);
  }
  return result;
}
