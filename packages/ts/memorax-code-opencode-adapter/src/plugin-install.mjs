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
  openCodeRepoMemoryHelperPath,
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

  const pluginExists = existsSync(paths.pluginPath);
  const pluginIsManaged = previousState?.pluginPath === paths.pluginPath
    && (!pluginExists || isManagedLoader(paths.pluginPath));
  const skillIsManaged = previousState?.skillPath === paths.skillPath;
  const repoMemoryHelperExists = existsSync(paths.repoMemoryHelperPath);
  const repoMemoryHelperIsManaged = previousState?.repoMemoryHelperPath
    === paths.repoMemoryHelperPath
    && (!repoMemoryHelperExists || isManagedLoader(paths.repoMemoryHelperPath));
  if (pluginExists && !pluginIsManaged) {
    return conflict("plugin_conflict", paths, paths.pluginPath);
  }
  if (existsSync(paths.skillPath) && !skillIsManaged) {
    return conflict("skill_conflict", paths, paths.skillPath);
  }
  if (repoMemoryHelperExists && !repoMemoryHelperIsManaged) {
    return conflict("repo_memory_helper_conflict", paths, paths.repoMemoryHelperPath);
  }

  const backendUrl = normalizeBackendUrl(
    options.backendUrl ?? previousState?.backendUrl ?? BACKEND_DEFAULT,
  );
  const pluginSourceSha256 = fileSha256(paths.pluginSourcePath);
  const repoMemoryHelperSourceSha256 = fileSha256(paths.repoMemoryHelperSourcePath);
  const loader = createManagedLoader(paths, pluginSourceSha256);
  const repoMemoryHelperLoader = createManagedRepoMemoryHelperLoader(
    paths,
    repoMemoryHelperSourceSha256,
  );
  const pluginCurrent = pluginIsManaged && fileContentsEqual(paths.pluginPath, loader);
  const skillCurrent = skillIsManaged && directoriesEqual(paths.skillSourcePath, paths.skillPath);
  const repoMemoryHelperCurrent = repoMemoryHelperIsManaged
    && fileContentsEqual(paths.repoMemoryHelperPath, repoMemoryHelperLoader);
  const artifactsCurrent = pluginCurrent && skillCurrent && repoMemoryHelperCurrent;
  const current = artifactsCurrent
    && previousState?.enabled === true
    && normalizeOptionalBackendUrl(previousState.backendUrl) === backendUrl;

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
    repoMemoryHelperPath: paths.repoMemoryHelperPath,
    repoMemoryHelperSourcePath: paths.repoMemoryHelperSourcePath,
    repoMemoryHelperSourceSha256,
    ...(paths.cliBinDir ? { cliBinDir: paths.cliBinDir } : {}),
    installedAt: stringOption(previousState?.installedAt) ?? now,
    updatedAt: now,
  };
  const pluginExisted = existsSync(paths.pluginPath);
  const skillExisted = existsSync(paths.skillPath);
  const repoMemoryHelperExisted = existsSync(paths.repoMemoryHelperPath);
  try {
    if (!skillCurrent) materializeSkill(paths.skillSourcePath, paths.skillPath);
    if (!pluginCurrent) atomicWriteText(paths.pluginPath, loader);
    if (!repoMemoryHelperCurrent) {
      atomicWriteText(paths.repoMemoryHelperPath, repoMemoryHelperLoader);
    }
    atomicWriteJson(paths.statePath, state);
  } catch (error) {
    removeNewArtifact(paths.pluginPath, pluginExisted);
    removeNewArtifact(paths.skillPath, skillExisted, true);
    removeNewArtifact(paths.repoMemoryHelperPath, repoMemoryHelperExisted);
    throw error;
  }
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
    restartRequired: !pluginCurrent || !skillCurrent || previousState?.enabled !== true,
    statePath: paths.statePath,
    pluginPath: paths.pluginPath,
    skillPath: paths.skillPath,
    repoMemoryHelperPath: paths.repoMemoryHelperPath,
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
      repoMemoryHelperPath: paths.repoMemoryHelperPath,
      skipped: true,
      reason: "not_managed",
    };
  }

  const configuredPaths = resolvePaths({
    ...options,
    openCodeConfigDir: state.openCodeConfigDir,
    pluginSourcePath: options.pluginSourcePath ?? state.pluginSourcePath,
    skillSourcePath: options.skillSourcePath ?? state.skillSourcePath,
    repoMemoryHelperSourcePath: options.repoMemoryHelperSourcePath
      ?? state.repoMemoryHelperSourcePath,
    cliBinDir: options.cliBinDir ?? state.cliBinDir,
  });
  if (state.pluginPath !== configuredPaths.pluginPath
    || state.skillPath !== configuredPaths.skillPath
    || (state.repoMemoryHelperPath
      && state.repoMemoryHelperPath !== configuredPaths.repoMemoryHelperPath)) {
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
  const repoMemoryHelperExists = existsSync(configuredPaths.repoMemoryHelperPath);
  const repoMemoryHelperRecorded = state.repoMemoryHelperPath
    === configuredPaths.repoMemoryHelperPath;
  const sourcesReady = !validateSources(configuredPaths);
  const pluginSourceSha256 = sourcesReady ? fileSha256(configuredPaths.pluginSourcePath) : undefined;
  const repoMemoryHelperSourceSha256 = sourcesReady
    ? fileSha256(configuredPaths.repoMemoryHelperSourcePath)
    : undefined;
  const pluginCurrent = sourcesReady && fileContentsEqual(
    configuredPaths.pluginPath,
    createManagedLoader(configuredPaths, pluginSourceSha256),
  );
  const skillCurrent = sourcesReady
    && directoriesEqual(configuredPaths.skillSourcePath, configuredPaths.skillPath);
  const repoMemoryHelperCurrent = repoMemoryHelperRecorded
    && sourcesReady
    && fileContentsEqual(
      configuredPaths.repoMemoryHelperPath,
      createManagedRepoMemoryHelperLoader(configuredPaths, repoMemoryHelperSourceSha256),
    );
  const installed = pluginExists && skillExists && repoMemoryHelperExists;
  const enabled = state.enabled === true
    && installed
    && pluginCurrent
    && skillCurrent
    && repoMemoryHelperCurrent;
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
    current: pluginCurrent && skillCurrent && repoMemoryHelperCurrent,
    pluginExists,
    pluginCurrent,
    skillExists,
    skillCurrent,
    repoMemoryHelperExists,
    repoMemoryHelperCurrent,
    configuredBackendUrl,
    expectedBackendUrl,
    backendUrlMatches,
    opencodeSkills: skillSummary(configuredPaths.skillPath, skillCurrent),
    statePath: paths.statePath,
    pluginPath: configuredPaths.pluginPath,
    skillPath: configuredPaths.skillPath,
    repoMemoryHelperPath: configuredPaths.repoMemoryHelperPath,
    state,
    ...(!backendUrlMatches
      ? { reason: "backend_url_mismatch" }
      : !enabled
        ? { reason: statusReason({
          sourcesReady,
          pluginExists,
          pluginCurrent,
          skillExists,
          skillCurrent,
          repoMemoryHelperExists,
          repoMemoryHelperRecorded,
          repoMemoryHelperCurrent,
        }) }
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
  const repoMemoryHelperPath = stringOption(state.repoMemoryHelperPath);
  return {
    ok: true,
    action: "opencode-plugin-disable",
    installed: existsSync(state.pluginPath)
      && existsSync(join(state.skillPath, "SKILL.md"))
      && Boolean(repoMemoryHelperPath && existsSync(repoMemoryHelperPath)),
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
  const repoMemoryHelperPath = openCodeRepoMemoryHelperPath(openCodeConfigDir);
  const recordedRepoMemoryHelperPath = stringOption(state.repoMemoryHelperPath);
  if (state.pluginPath !== pluginPath
    || state.skillPath !== skillPath
    || (recordedRepoMemoryHelperPath
      && recordedRepoMemoryHelperPath !== repoMemoryHelperPath)) {
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
  if (recordedRepoMemoryHelperPath
    && existsSync(repoMemoryHelperPath)
    && !isManagedLoader(repoMemoryHelperPath)) {
    return {
      ok: false,
      action: "opencode-plugin-remove",
      reason: "repo_memory_helper_not_managed",
      statePath: paths.statePath,
      repoMemoryHelperPath,
    };
  }

  rmSync(pluginPath, { force: true });
  rmSync(skillPath, { recursive: true, force: true });
  if (recordedRepoMemoryHelperPath) rmSync(repoMemoryHelperPath, { force: true });
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
    repoMemoryHelperPath,
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

export function defaultOpenCodeRepoMemoryHelperSourcePath() {
  return join(ADAPTER_ROOT, "hooks", "repo-memory-job.mjs");
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

export function defaultMemoraxCodeCommand(adapterRoot = ADAPTER_ROOT) {
  const packageRoot = resolve(adapterRoot, "..", "..");
  return [
    join(packageRoot, "bin", "memorax-code.mjs"),
    join(packageRoot, "npm", "memorax-code", "bin", "memorax-code.mjs"),
  ].find((path) => existsSync(path));
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
    repoMemoryHelperPath: openCodeRepoMemoryHelperPath(openCodeConfigDir),
    pluginSourcePath: resolve(options.pluginSourcePath ?? defaultOpenCodePluginSourcePath()),
    skillSourcePath: resolve(options.skillSourcePath ?? defaultOpenCodeSkillSourcePath()),
    repoMemoryHelperSourcePath: resolve(
      options.repoMemoryHelperSourcePath ?? defaultOpenCodeRepoMemoryHelperSourcePath(),
    ),
    cliBinDir: stringOption(options.cliBinDir)
      ? resolve(options.cliBinDir)
      : defaultOpenCodeCliBinDir(),
    nodePath: stringOption(options.nodePath)
      ? resolve(options.nodePath)
      : process.execPath,
    memoraxCodeCommand: stringOption(options.memoraxCodeCommand)
      ? resolve(options.memoraxCodeCommand)
      : defaultMemoraxCodeCommand(),
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
    const repoMemoryHelperPath = stringOption(state.repoMemoryHelperPath);
    const repoMemoryHelperSourcePath = stringOption(state.repoMemoryHelperSourcePath);
    const repoMemoryHelperSourceSha256 = stringOption(state.repoMemoryHelperSourceSha256);
    const hasRepoMemoryHelperState = [
      "repoMemoryHelperPath",
      "repoMemoryHelperSourcePath",
      "repoMemoryHelperSourceSha256",
    ].some((field) => Object.hasOwn(state, field));
    if (state.runtime !== "opencode"
      || state.integration !== "plugin"
      || !openCodeConfigDir
      || !pluginPath
      || !skillPath
      || (hasRepoMemoryHelperState && (
        !repoMemoryHelperPath
        || !repoMemoryHelperSourcePath
        || !/^[a-f0-9]{64}$/.test(repoMemoryHelperSourceSha256 ?? "")
      ))) {
      return { ok: false, reason: "state_invalid", statePath };
    }
    const resolvedConfigDir = resolve(openCodeConfigDir);
    if (openCodeConfigDir !== resolvedConfigDir
      || pluginPath !== openCodePluginPath(resolvedConfigDir)
      || skillPath !== openCodeSkillPath(resolvedConfigDir)
      || (repoMemoryHelperPath
        && repoMemoryHelperPath !== openCodeRepoMemoryHelperPath(resolvedConfigDir))) {
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
  if (!existsSync(paths.repoMemoryHelperSourcePath)) {
    return {
      ok: false,
      reason: "repo_memory_helper_source_missing",
      sourcePath: paths.repoMemoryHelperSourcePath,
    };
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
    repoMemoryHelperPath: paths.repoMemoryHelperPath,
  };
}

function createManagedLoader(paths, pluginSourceSha256) {
  const pluginUrl = pathToFileURL(paths.pluginSourcePath).href;
  const pluginOptions = {
    memoraxCodeHome: paths.memoraxCodeHome,
    statePath: paths.statePath,
    openCodeConfigDir: paths.openCodeConfigDir,
    ...(paths.memoraxCodeCommand ? { memoraxCodeCommand: paths.memoraxCodeCommand } : {}),
    nodePath: paths.nodePath,
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

function createManagedRepoMemoryHelperLoader(paths, sourceSha256) {
  const helperUrl = pathToFileURL(paths.repoMemoryHelperSourcePath).href;
  return [
    MANAGED_LOADER_HEADER,
    `// Repo Memory helper source SHA-256: ${sourceSha256}`,
    `import ${JSON.stringify(helperUrl)};`,
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
  if (previousState.repoMemoryHelperPath !== paths.repoMemoryHelperPath
    && isManagedLoader(previousState.repoMemoryHelperPath)) {
    rmSync(previousState.repoMemoryHelperPath, { force: true });
  }
}

function removeNewArtifact(path, existed, recursive = false) {
  if (existed) return;
  try {
    rmSync(path, { recursive, force: true });
  } catch {
    // Preserve the original installation failure.
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

function statusReason({
  sourcesReady,
  pluginExists,
  pluginCurrent,
  skillExists,
  skillCurrent,
  repoMemoryHelperExists,
  repoMemoryHelperRecorded,
  repoMemoryHelperCurrent,
}) {
  if (!sourcesReady) return "source_missing";
  if (!pluginExists) return "plugin_missing";
  if (!pluginCurrent) return "plugin_stale";
  if (!skillExists) return "skill_missing";
  if (!skillCurrent) return "skill_stale";
  if (!repoMemoryHelperExists) return "repo_memory_helper_missing";
  if (!repoMemoryHelperRecorded) return "repo_memory_helper_unmanaged";
  if (!repoMemoryHelperCurrent) return "repo_memory_helper_stale";
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
