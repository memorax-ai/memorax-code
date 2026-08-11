import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import {
  atomicWriteJson,
  atomicWriteText,
  readAdapterState,
  stringOption,
} from "../../memorax-code-adapter-common/src/config-utils.mjs";
import { DEFAULT_BACKEND_URL as BACKEND_DEFAULT } from "../../memorax-code-adapter-common/src/backend-connection.mjs";
import {
  adapterStatePath,
  defaultMemoraxCodeHome,
  defaultOpenCodeConfigDir,
  openCodePluginPath,
  openCodeSkillPath,
} from "./adapter-paths.mjs";

const STATE_VERSION = 1;
const MANAGED_LOADER_HEADER = "// Managed by MemoraX Code. Do not edit.";
const ADAPTER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function ensureOpenCodePluginInstalled(options = {}) {
  const paths = resolvePaths(options);
  const previousState = readAdapterState(paths.statePath);
  const stateProblem = validateState(previousState, paths.statePath);
  if (stateProblem) return { ...stateProblem, action: "opencode-plugin-install" };
  const sourceProblem = validateSources(paths);
  if (sourceProblem) return { ...sourceProblem, action: "opencode-plugin-install" };

  const pluginIsManaged = previousState?.pluginPath === paths.pluginPath;
  const skillIsManaged = previousState?.skillPath === paths.skillPath;
  if (existsSync(paths.pluginPath) && !pluginIsManaged) {
    return conflict("plugin_conflict", paths, paths.pluginPath);
  }
  if (existsSync(paths.skillPath) && !skillIsManaged) {
    return conflict("skill_conflict", paths, paths.skillPath);
  }

  const backendUrl = normalizeBackendUrl(
    options.backendUrl ?? previousState?.backendUrl ?? BACKEND_DEFAULT,
  );
  const pluginSourceSha256 = fileSha256(paths.pluginSourcePath);
  const loader = createManagedLoader(paths, pluginSourceSha256);
  const artifactsCurrent = pluginIsManaged
    && skillIsManaged
    && fileContentsEqual(paths.pluginPath, loader)
    && directoriesEqual(paths.skillSourcePath, paths.skillPath);
  const current = artifactsCurrent
    && previousState?.enabled === true
    && normalizeOptionalBackendUrl(previousState.backendUrl) === backendUrl;

  if (!artifactsCurrent) {
    materializeSkill(paths.skillSourcePath, paths.skillPath);
    atomicWriteText(paths.pluginPath, loader);
  }

  const now = new Date().toISOString();
  const state = {
    version: STATE_VERSION,
    runtime: "opencode",
    integration: "plugin",
    enabled: true,
    backendUrl,
    openCodeConfigDir: paths.openCodeConfigDir,
    pluginPath: paths.pluginPath,
    pluginSourcePath: paths.pluginSourcePath,
    pluginSourceSha256,
    skillPath: paths.skillPath,
    skillSourcePath: paths.skillSourcePath,
    ...(paths.cliBinDir ? { cliBinDir: paths.cliBinDir } : {}),
    installedAt: stringOption(previousState?.installedAt) ?? now,
    updatedAt: now,
  };
  atomicWriteJson(paths.statePath, state);
  removePreviousInstallation(previousState, paths);

  return {
    ok: true,
    action: "opencode-plugin-install",
    installed: true,
    enabled: true,
    managed: true,
    integration: "plugin",
    configuredBackendUrl: backendUrl,
    expectedBackendUrl: backendUrl,
    backendUrlMatches: true,
    opencodeSkills: skillSummary(paths.skillPath, true),
    changed: !current,
    restartRequired: !artifactsCurrent,
    statePath: paths.statePath,
    pluginPath: paths.pluginPath,
    skillPath: paths.skillPath,
    state,
  };
}

export function readOpenCodePluginStatus(options = {}) {
  const paths = resolvePaths(options);
  const state = readAdapterState(paths.statePath);
  const stateProblem = validateState(state, paths.statePath);
  if (stateProblem) return { ...stateProblem, action: "opencode-plugin-status", installed: false, enabled: false };
  if (!state) {
    return {
      ok: true,
      action: "opencode-plugin-status",
      installed: false,
      enabled: false,
      managed: false,
      integration: "plugin",
      configuredBackendUrl: undefined,
      expectedBackendUrl: normalizeOptionalBackendUrl(options.backendUrl),
      backendUrlMatches: true,
      opencodeSkills: skillSummary(paths.skillPath, false),
      statePath: paths.statePath,
      pluginPath: paths.pluginPath,
      skillPath: paths.skillPath,
      skipped: true,
      reason: "not_managed",
    };
  }

  const configuredPaths = resolvePaths({
    ...options,
    openCodeConfigDir: state.openCodeConfigDir,
    pluginSourcePath: options.pluginSourcePath ?? state.pluginSourcePath,
    skillSourcePath: options.skillSourcePath ?? state.skillSourcePath,
    cliBinDir: options.cliBinDir ?? state.cliBinDir,
  });
  if (state.pluginPath !== configuredPaths.pluginPath || state.skillPath !== configuredPaths.skillPath) {
    return {
      ok: false,
      action: "opencode-plugin-status",
      installed: false,
      enabled: false,
      managed: true,
      reason: "state_paths_invalid",
      statePath: paths.statePath,
    };
  }

  const pluginExists = existsSync(configuredPaths.pluginPath);
  const skillExists = existsSync(join(configuredPaths.skillPath, "SKILL.md"));
  const sourcesReady = !validateSources(configuredPaths);
  const pluginSourceSha256 = sourcesReady ? fileSha256(configuredPaths.pluginSourcePath) : undefined;
  const pluginCurrent = sourcesReady && fileContentsEqual(
    configuredPaths.pluginPath,
    createManagedLoader(configuredPaths, pluginSourceSha256),
  );
  const skillCurrent = sourcesReady
    && directoriesEqual(configuredPaths.skillSourcePath, configuredPaths.skillPath);
  const installed = pluginExists && skillExists;
  const enabled = state.enabled === true && installed && pluginCurrent && skillCurrent;
  const configuredBackendUrl = normalizeOptionalBackendUrl(state.backendUrl);
  const expectedBackendUrl = normalizeOptionalBackendUrl(options.backendUrl);
  const backendUrlMatches = !expectedBackendUrl || configuredBackendUrl === expectedBackendUrl;
  return {
    ok: true,
    action: "opencode-plugin-status",
    installed,
    enabled,
    managed: true,
    integration: "plugin",
    current: pluginCurrent && skillCurrent,
    pluginExists,
    pluginCurrent,
    skillExists,
    skillCurrent,
    configuredBackendUrl,
    expectedBackendUrl,
    backendUrlMatches,
    opencodeSkills: skillSummary(configuredPaths.skillPath, skillCurrent),
    statePath: paths.statePath,
    pluginPath: configuredPaths.pluginPath,
    skillPath: configuredPaths.skillPath,
    state,
    ...(!backendUrlMatches
      ? { reason: "backend_url_mismatch" }
      : !enabled
        ? { reason: statusReason({ sourcesReady, pluginExists, pluginCurrent, skillExists, skillCurrent }) }
        : {}),
  };
}

export function disableOpenCodePlugin(options = {}) {
  const paths = resolvePaths(options);
  const state = readAdapterState(paths.statePath);
  const stateProblem = validateState(state, paths.statePath);
  if (stateProblem) return { ...stateProblem, action: "opencode-plugin-disable" };
  if (!state) {
    return {
      ok: true,
      action: "opencode-plugin-disable",
      installed: false,
      enabled: false,
      managed: false,
      integration: "plugin",
      skipped: true,
      reason: "not_managed",
      statePath: paths.statePath,
    };
  }

  const nextState = {
    ...state,
    enabled: false,
    disabledAt: new Date().toISOString(),
  };
  atomicWriteJson(paths.statePath, nextState);
  return {
    ok: true,
    action: "opencode-plugin-disable",
    installed: existsSync(state.pluginPath) && existsSync(join(state.skillPath, "SKILL.md")),
    enabled: false,
    managed: true,
    integration: "plugin",
    changed: state.enabled === true,
    statePath: paths.statePath,
    state: nextState,
  };
}

export function removeOpenCodePluginInstallation(options = {}) {
  const paths = resolvePaths(options);
  const state = readAdapterState(paths.statePath);
  const stateProblem = validateState(state, paths.statePath);
  if (stateProblem) return { ...stateProblem, action: "opencode-plugin-remove" };
  if (!state) {
    return {
      ok: true,
      action: "opencode-plugin-remove",
      skipped: true,
      reason: "not_managed",
      statePath: paths.statePath,
    };
  }

  const openCodeConfigDir = resolve(state.openCodeConfigDir);
  const pluginPath = openCodePluginPath(openCodeConfigDir);
  const skillPath = openCodeSkillPath(openCodeConfigDir);
  if (state.pluginPath !== pluginPath || state.skillPath !== skillPath) {
    return {
      ok: false,
      action: "opencode-plugin-remove",
      reason: "state_paths_invalid",
      statePath: paths.statePath,
    };
  }
  if (existsSync(pluginPath) && !isManagedLoader(pluginPath)) {
    return {
      ok: false,
      action: "opencode-plugin-remove",
      reason: "plugin_not_managed",
      statePath: paths.statePath,
      pluginPath,
    };
  }

  rmSync(pluginPath, { force: true });
  rmSync(skillPath, { recursive: true, force: true });
  rmSync(paths.statePath, { force: true });
  return {
    ok: true,
    action: "opencode-plugin-remove",
    installed: false,
    enabled: false,
    managed: false,
    integration: "plugin",
    statePath: paths.statePath,
    pluginPath,
    skillPath,
  };
}

export function defaultOpenCodePluginSourcePath() {
  return join(ADAPTER_ROOT, "src", "plugin.mjs");
}

export function defaultOpenCodeSkillSourcePath() {
  const packagedSkill = join(ADAPTER_ROOT, "skills", "memorax-code");
  return existsSync(join(packagedSkill, "SKILL.md"))
    ? packagedSkill
    : resolve(ADAPTER_ROOT, "..", "memorax-code-codex-adapter", "skills", "memorax-code");
}

export function defaultOpenCodeCliBinDir(adapterRoot = ADAPTER_ROOT) {
  const packageRoot = resolve(adapterRoot, "..", "..");
  const candidates = [
    resolve(packageRoot, "..", "..", ".bin"),
    resolve(packageRoot, "..", "..", ".."),
    resolve(packageRoot, "..", "..", "..", "..", "bin"),
    join(packageRoot, "bin"),
  ];
  return candidates.find(hasMemoraxCliCommand);
}

function resolvePaths(options) {
  const memoraxCodeHome = resolve(options.memoraxCodeHome ?? defaultMemoraxCodeHome());
  const openCodeConfigDir = resolve(options.openCodeConfigDir ?? defaultOpenCodeConfigDir());
  return {
    memoraxCodeHome,
    openCodeConfigDir,
    statePath: resolve(options.statePath ?? adapterStatePath(memoraxCodeHome)),
    pluginPath: openCodePluginPath(openCodeConfigDir),
    skillPath: openCodeSkillPath(openCodeConfigDir),
    pluginSourcePath: resolve(options.pluginSourcePath ?? defaultOpenCodePluginSourcePath()),
    skillSourcePath: resolve(options.skillSourcePath ?? defaultOpenCodeSkillSourcePath()),
    cliBinDir: stringOption(options.cliBinDir)
      ? resolve(options.cliBinDir)
      : defaultOpenCodeCliBinDir(),
  };
}

function validateState(state, statePath) {
  if (state?.unreadable) {
    return { ok: false, reason: "state_unreadable", statePath };
  }
  if (state && state.version !== STATE_VERSION) {
    return {
      ok: false,
      reason: "state_version_unsupported",
      statePath,
      expectedVersion: STATE_VERSION,
      actualVersion: state.version,
    };
  }
  if (state) {
    const openCodeConfigDir = stringOption(state.openCodeConfigDir);
    const pluginPath = stringOption(state.pluginPath);
    const skillPath = stringOption(state.skillPath);
    if (state.runtime !== "opencode"
      || state.integration !== "plugin"
      || !openCodeConfigDir
      || !pluginPath
      || !skillPath) {
      return { ok: false, reason: "state_invalid", statePath };
    }
    const resolvedConfigDir = resolve(openCodeConfigDir);
    if (openCodeConfigDir !== resolvedConfigDir
      || pluginPath !== openCodePluginPath(resolvedConfigDir)
      || skillPath !== openCodeSkillPath(resolvedConfigDir)) {
      return { ok: false, reason: "state_paths_invalid", statePath };
    }
  }
  return undefined;
}

function validateSources(paths) {
  if (!existsSync(paths.pluginSourcePath)) {
    return { ok: false, reason: "plugin_source_missing", sourcePath: paths.pluginSourcePath };
  }
  if (!existsSync(join(paths.skillSourcePath, "SKILL.md"))) {
    return { ok: false, reason: "skill_source_missing", sourcePath: paths.skillSourcePath };
  }
  return undefined;
}

function conflict(reason, paths, conflictPath) {
  return {
    ok: false,
    action: "opencode-plugin-install",
    reason,
    conflictPath,
    statePath: paths.statePath,
    pluginPath: paths.pluginPath,
    skillPath: paths.skillPath,
  };
}

function createManagedLoader(paths, pluginSourceSha256) {
  const pluginUrl = pathToFileURL(paths.pluginSourcePath).href;
  const pluginOptions = {
    memoraxCodeHome: paths.memoraxCodeHome,
    statePath: paths.statePath,
    ...(paths.cliBinDir ? { cliBinDir: paths.cliBinDir } : {}),
  };
  return [
    MANAGED_LOADER_HEADER,
    `// Plugin source SHA-256: ${pluginSourceSha256}`,
    `import { createMemoraxOpenCodePlugin } from ${JSON.stringify(pluginUrl)};`,
    "",
    `export const MemoraxOpenCodePlugin = createMemoraxOpenCodePlugin(${JSON.stringify(pluginOptions)});`,
    "",
  ].join("\n");
}

function materializeSkill(sourcePath, targetPath) {
  mkdirSync(dirname(targetPath), { recursive: true });
  const stagePath = `${targetPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    cpSync(sourcePath, stagePath, { recursive: true });
    rmSync(targetPath, { recursive: true, force: true });
    renameSync(stagePath, targetPath);
  } finally {
    rmSync(stagePath, { recursive: true, force: true });
  }
}

function removePreviousInstallation(previousState, paths) {
  if (!previousState) return;
  if (previousState.pluginPath !== paths.pluginPath && isManagedLoader(previousState.pluginPath)) {
    rmSync(previousState.pluginPath, { force: true });
  }
  if (previousState.skillPath !== paths.skillPath) {
    rmSync(previousState.skillPath, { recursive: true, force: true });
  }
}

function isManagedLoader(path) {
  if (!path || !existsSync(path)) return false;
  try {
    return readFileSync(path, "utf8").startsWith(`${MANAGED_LOADER_HEADER}\n`);
  } catch {
    return false;
  }
}

function fileContentsEqual(path, expected) {
  try {
    return readFileSync(path, "utf8") === expected;
  } catch {
    return false;
  }
}

function fileSha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function hasMemoraxCliCommand(directory) {
  return ["memorax-cli", "memorax-cli.cmd", "memorax-cli.exe"]
    .some((name) => existsSync(join(directory, name)));
}

function directoriesEqual(sourceRoot, targetRoot) {
  if (!existsSync(sourceRoot) || !existsSync(targetRoot)) return false;
  const sourceEntries = collectDirectoryEntries(sourceRoot);
  const targetEntries = collectDirectoryEntries(targetRoot);
  if (sourceEntries.length !== targetEntries.length) return false;
  return sourceEntries.every((source, index) => {
    const target = targetEntries[index];
    return source.path === target.path
      && source.kind === target.kind
      && source.content === target.content;
  });
}

function collectDirectoryEntries(root) {
  const entries = [];
  visit(root);
  return entries.sort((left, right) => left.path.localeCompare(right.path));

  function visit(path) {
    for (const name of readdirSync(path)) {
      const absolutePath = join(path, name);
      const entryPath = relative(root, absolutePath);
      const stat = lstatSync(absolutePath);
      if (stat.isDirectory()) {
        entries.push({ path: entryPath, kind: "directory", content: "" });
        visit(absolutePath);
      } else if (stat.isSymbolicLink()) {
        entries.push({ path: entryPath, kind: "symlink", content: readlinkSync(absolutePath) });
      } else {
        entries.push({ path: entryPath, kind: "file", content: readFileSync(absolutePath).toString("base64") });
      }
    }
  }
}

function statusReason({ sourcesReady, pluginExists, pluginCurrent, skillExists, skillCurrent }) {
  if (!sourcesReady) return "source_missing";
  if (!pluginExists) return "plugin_missing";
  if (!pluginCurrent) return "plugin_stale";
  if (!skillExists) return "skill_missing";
  if (!skillCurrent) return "skill_stale";
  return "not_enabled";
}

function normalizeBackendUrl(value) {
  return String(value).replace(/\/+$/, "");
}

function normalizeOptionalBackendUrl(value) {
  return stringOption(value) ? normalizeBackendUrl(value) : undefined;
}

function skillSummary(skillPath, ok) {
  return {
    ok,
    status: ok ? "installed" : "missing",
    sourceKind: "canonical",
    path: skillPath,
  };
}
