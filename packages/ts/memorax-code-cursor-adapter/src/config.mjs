import { createHash, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import {
  atomicWriteJson,
  atomicWriteText,
  readAdapterState,
  readJsonFile,
  stringOption,
  withJsonFileLock,
  withJsonFileLockAsync,
} from "../../memorax-code-adapter-common/src/config-utils.mjs";
import { withWindowsDirectoryRetry } from "../../memorax-code-adapter-common/src/windows-directory-retry.mjs";
import { attachDeploymentFailure, deploymentFailure } from "../../memorax-code-adapter-common/src/deployment-failure.mjs";
import {
  defaultMemoraxCodeHome,
  defaultCursorHome,
  cursorAdapterRoot,
  cursorAdapterStatePath,
  cursorHooksPath,
  cursorRepoMemoryAgentPath,
  cursorRuntimeRoot,
  cursorSkillPath,
} from "./adapter-paths.mjs";
import {
  readCursorRuntimeObservation,
  cursorRuntimeObservationPath,
} from "./runtime-observation.mjs";
import { cursorDatabasePath } from "./native-database-path.mjs";
import { DEFAULT_ENSURE_BACKEND_START_TIMEOUT_MS } from "../../memorax-code-adapter-common/src/hooks/ensure-backend-runner.mjs";

const ADAPTER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_VERSION = 1;
const HOOK_MARKER = "--memorax-code-cursor-hook-v1";
// Reserve a minute beyond recovery for health, event delivery and local context.
const HOOK_TIMEOUT_SECONDS = Math.ceil(DEFAULT_ENSURE_BACKEND_START_TIMEOUT_MS / 1000) + 60;
const REQUIRED_EVENTS = ["sessionStart", "beforeSubmitPrompt", "preCompact", "afterAgentResponse", "stop"];
const SKILL_PACKAGE_METADATA = ".memorax-code-package.json";
const REPO_MEMORY_AGENT_MARKER = "<!-- memorax-code-cursor-repo-memory-agent-v1 -->";
const CURSOR_AGENT_PLUGIN_MANIFEST = JSON.stringify({
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  name: "memorax-code",
  description: "Persistent coding memory for Cursor.",
}, null, 2) + "\n";

export async function enableCursorAdapter(options = {}) {
  const paths = resolvePaths(options);
  return await withCursorLifecycleLock(paths, () => enableCursorAdapterUnlocked(paths, options));
}

async function enableCursorAdapterUnlocked(paths, options) {
  const previousState = readAdapterState(paths.statePath);
  const stateProblem = validateState(previousState, paths);
  if (stateProblem) return { ...stateProblem, action: "enable" };
  const sourceProblem = validateSources(paths);
  if (sourceProblem) return { ...sourceProblem, action: "enable" };
  if (existsSync(paths.skillPath) && previousState?.skillPath !== paths.skillPath) {
    return conflict("skill_conflict", paths, paths.skillPath);
  }
  if (pathEntryExists(dirname(paths.repoMemoryAgentPath))
    && !regularDirectory(dirname(paths.repoMemoryAgentPath))) {
    return conflict("agent_conflict", paths, dirname(paths.repoMemoryAgentPath), "runtime-stage");
  }
  if (pathEntryExists(paths.repoMemoryAgentPath)
    && (previousState?.repoMemoryAgentPath !== paths.repoMemoryAgentPath
      || !managedRepoMemoryAgent(paths.repoMemoryAgentPath))) {
    return conflict("agent_conflict", paths, paths.repoMemoryAgentPath, "runtime-stage");
  }

  let hookManifest;
  try {
    hookManifest = readHookManifest(paths.hooksPath);
  } catch (error) {
    return failure("hooks_invalid", paths, error, "status", "hooks-read");
  }

  const previousGenerationPath = previousState?.runtimePath
    ? dirname(dirname(previousState.runtimePath)) : undefined;
  // Never promote altered recovery metadata into a new trusted generation.
  // Pre-agent layouts retain their migration path; unpublished installs can resume.
  if (previousState?.repoMemoryAgentDigest && pathEntryExists(previousGenerationPath)
    && !runtimeGenerationCurrent(previousGenerationPath, previousState.runtimeDigest)) {
    return failure("install_failed", paths,
      attachDeploymentFailure(new Error("Cursor runtime generation is invalid"), "runtime-stage", { failureReason: "invalid_record" }),
      "enable", "runtime-stage");
  }
  const memoraxCodeCommand = stringOption(options.memoraxCodeCommand) ?? defaultMemoraxCodeCommand();
  const previousMetadata = previousState?.runtimePath
    ? readJsonFile(join(dirname(dirname(previousState.runtimePath)), ".memorax-code-package.json"))?.value
    : undefined;
  // Preserve only an explicit override. Default native directories are resolved
  // by each Hook's environment, not frozen from the installer's environment.
  const configuredDatabasePath = process.env.MEMORAX_CODE_CURSOR_DATABASE_PATH ?? previousMetadata?.databasePath;
  const databasePath = configuredDatabasePath === undefined ? undefined : cursorDatabasePath({
    env: { MEMORAX_CODE_CURSOR_DATABASE_PATH: configuredDatabasePath },
    platform: options.platform ?? process.platform,
  });
  if (configuredDatabasePath !== undefined && !databasePath) {
    return failure("database_path_invalid", paths,
      new Error("MEMORAX_CODE_CURSOR_DATABASE_PATH must be an absolute path without control characters"), "enable", "runtime-stage");
  }
  // Hook recovery forwards npm through MEMORAX_CODE_NPM_EXEC_PATH. A direct
  // lifecycle command may have neither variable, so retain a still-valid entrypoint.
  const npmExecPath = absoluteRegularFile(options.npmExecPath
    ?? process.env.MEMORAX_CODE_NPM_EXEC_PATH
    ?? process.env.npm_execpath
    ?? previousMetadata?.npmExecPath);
  const runtimeMetadata = {
    version: 1,
    ...(memoraxCodeCommand ? { memoraxCodeCommand } : {}),
    ...(npmExecPath ? { npmExecPath } : {}),
    memoraxCodeHome: paths.memoraxCodeHome,
    cursorHome: paths.cursorHome,
    ...(databasePath ? { databasePath } : {}),
  };
  let runtimeDigest;
  try { runtimeDigest = runtimeSourceDigest(paths, runtimeMetadata); }
  catch (error) { throw attachDeploymentFailure(error, "runtime-stage"); }
  const generationPath = join(paths.runtimeRoot, runtimeDigest);
  const runtimePath = join(generationPath, "hooks", "runtime-hook.mjs");
  const hookCommand = cursorHookCommand(
    runtimePath,
    options.platform ?? process.platform,
    absoluteRegularFile(options.nodePath) ?? process.execPath,
    options.powershellPath ?? defaultWindowsPowerShellPath(),
  );
  let skillDigest;
  try { skillDigest = skillDirectoryDigest(paths.skillSourcePath); }
  catch (error) { throw attachDeploymentFailure(error, "skill-stage"); }
  const skillCurrent = directoryDigestIfPresent(paths.skillPath, SKILL_PACKAGE_METADATA) === skillDigest
    && skillPackageMetadataCurrent(paths.skillPath, memoraxCodeCommand, paths.memoraxCodeHome);
  const repoMemoryAgentDigest = fileDigestIfPresent(paths.repoMemoryAgentSourcePath);
  const agentCurrent = managedRepoMemoryAgent(paths.repoMemoryAgentPath)
    && fileDigestIfPresent(paths.repoMemoryAgentPath) === repoMemoryAgentDigest;
  const current = previousState?.runtimeDigest === runtimeDigest
    && previousState?.skillDigest === skillDigest
    && previousState?.repoMemoryAgentDigest === repoMemoryAgentDigest
    && previousState?.enabled === true
    && runtimeGenerationCurrent(generationPath, runtimeDigest)
    && skillCurrent
    && agentCurrent
    && hooksConfigured(hookManifest, hookCommand);
  const now = new Date().toISOString();
  const state = {
    version: STATE_VERSION,
    runtime: "cursor",
    integration: "hooks",
    enabled: true,
    cursorHome: paths.cursorHome,
    hooksPath: paths.hooksPath,
    skillPath: paths.skillPath,
    skillDigest,
    repoMemoryAgentPath: paths.repoMemoryAgentPath,
    repoMemoryAgentDigest,
    runtimeRoot: paths.runtimeRoot,
    runtimePath,
    runtimeDigest,
    hookCommand,
    installedAt: stringOption(previousState?.installedAt) ?? now,
    updatedAt: now,
  };

  let stage = "state-write";
  try {
    // Claim partial artifacts before publishing them so an interrupted install
    // can resume without treating its own Skill or agent as user-owned content.
    atomicWriteJson(paths.statePath, { ...state, enabled: false, installPending: true });
    stage = "runtime-stage";
    materializeRuntimeGeneration(paths, generationPath, runtimeDigest, runtimeMetadata);
    if (!skillCurrent) {
      stage = "skill-stage";
      materializeDirectory(paths.skillSourcePath, paths.skillPath, memoraxCodeCommand, paths.memoraxCodeHome);
    }
    if (!agentCurrent) {
      stage = "runtime-stage";
      atomicWriteText(paths.repoMemoryAgentPath, readFileSync(paths.repoMemoryAgentSourcePath, "utf8"));
    }
    stage = "hooks-write";
    updateManagedHooks(paths.hooksPath, hookCommand, true);
    stage = "state-write";
    atomicWriteJson(paths.statePath, state);
  } catch (error) {
    return failure("install_failed", paths, error, "enable", stage);
  }

  return await readCursorAdapterStatusUnlocked(paths, { ...options, changed: !current });
}

export async function disableCursorAdapter(options = {}) {
  const paths = resolvePaths(options);
  return await withCursorLifecycleLock(paths, () => disableCursorAdapterUnlocked(paths));
}

function disableCursorAdapterUnlocked(paths) {
  const state = readAdapterState(paths.statePath);
  const stateProblem = validateState(state, paths);
  if (stateProblem) return { ...stateProblem, action: "disable" };
  if (!state) {
    return {
      ok: true,
      action: "disable",
      runtime: "cursor",
      integration: "hooks",
      installed: false,
      enabled: false,
      managed: false,
      skipped: true,
      reason: "not_managed",
      cursorHome: paths.cursorHome,
      statePath: paths.statePath,
    };
  }
  let stage = "hooks-write";
  try {
    updateManagedHooks(paths.hooksPath, undefined, false);
    const disabledState = {
      ...state,
      enabled: false,
      disabledAt: new Date().toISOString(),
    };
    delete disabledState.installPending;
    stage = "state-write";
    atomicWriteJson(paths.statePath, disabledState);
  } catch (error) {
    return failure("disable_failed", paths, error, "status", stage);
  }
  return {
    ok: true,
    action: "disable",
    runtime: "cursor",
    integration: "hooks",
    installed: existsSync(state.runtimePath) && existsSync(join(state.skillPath, "SKILL.md"))
      && managedRepoMemoryAgent(state.repoMemoryAgentPath),
    enabled: false,
    managed: true,
    changed: state.enabled === true,
    cursorHome: paths.cursorHome,
    statePath: paths.statePath,
  };
}

export async function readCursorAdapterStatus(options = {}) {
  const paths = resolvePaths(options);
  return await readCursorAdapterStatusUnlocked(paths, options);
}

async function readCursorAdapterStatusUnlocked(paths, options) {
  const state = readAdapterState(paths.statePath);
  const stateProblem = validateState(state, paths);
  if (stateProblem) return { ...stateProblem, action: "status" };
  if (!state) {
    return {
      ok: true,
      action: "status",
      runtime: "cursor",
      integration: "hooks",
      installed: false,
      enabled: false,
      managed: false,
      skipped: true,
      reason: "not_managed",
      cursorHome: paths.cursorHome,
      statePath: paths.statePath,
      cursorHooks: { ok: false, configured: false, runtimeObserved: false, status: "missing" },
      cursorSkills: skillSummary(paths.skillPath, false),
      cursorAgents: agentSummary(paths.repoMemoryAgentPath, false),
    };
  }
  let manifest;
  try {
    manifest = readHookManifest(paths.hooksPath);
  } catch {
    manifest = undefined;
  }
  const generationPath = join(state.runtimeRoot, state.runtimeDigest);
  const runtimeCurrent = state.runtimePath === join(generationPath, "hooks", "runtime-hook.mjs")
    && runtimeGenerationCurrent(generationPath, state.runtimeDigest);
  const memoraxCodeCommand = stringOption(options.memoraxCodeCommand) ?? defaultMemoraxCodeCommand();
  const skillCurrent = existsSync(join(state.skillPath, "SKILL.md"))
    && directoryDigestIfPresent(state.skillPath, SKILL_PACKAGE_METADATA) === state.skillDigest
    && skillPackageMetadataCurrent(state.skillPath, memoraxCodeCommand, paths.memoraxCodeHome);
  const agentCurrent = managedRepoMemoryAgent(state.repoMemoryAgentPath)
    && fileDigestIfPresent(state.repoMemoryAgentPath) === state.repoMemoryAgentDigest
    && fileDigestIfPresent(join(dirname(dirname(state.runtimePath)), "agents", "memorax-repo-memory.md"))
      === state.repoMemoryAgentDigest;
  const configured = Boolean(manifest && hooksConfigured(manifest, state.hookCommand));
  const observation = await readCursorRuntimeObservation(paths.memoraxCodeHome);
  const runtimeObserved = observation?.runtimeDigest === state.runtimeDigest
    && comparablePath(observation.cursorHome, options.platform ?? process.platform)
      === comparablePath(paths.cursorHome, options.platform ?? process.platform);
  const installed = runtimeCurrent && skillCurrent && agentCurrent;
  const enabled = state.enabled === true && installed && configured;
  const installPending = state.installPending === true;
  return {
    ok: true,
    action: "status",
    runtime: "cursor",
    integration: "hooks",
    installed,
    enabled,
    managed: true,
    current: installed && configured,
    changed: options.changed,
    cursorHome: paths.cursorHome,
    statePath: paths.statePath,
    installPath: dirname(state.runtimePath),
    skillPath: state.skillPath,
    repoMemoryAgentPath: paths.repoMemoryAgentPath,
    cursorHooks: {
      ok: configured,
      configured,
      runtimeObserved,
      status: configured ? (runtimeObserved ? "observed" : "unverified") : "invalid",
      observationPath: cursorRuntimeObservationPath(paths.memoraxCodeHome),
    },
    cursorSkills: skillSummary(state.skillPath, skillCurrent),
    cursorAgents: agentSummary(paths.repoMemoryAgentPath, agentCurrent),
    ...(!enabled ? {
      reason: installPending
        ? "install_incomplete"
        : !installed ? "artifacts_missing" : "hooks_not_configured",
    } : {}),
  };
}

export async function removeCursorAdapterInstallation(options = {}) {
  const paths = resolvePaths(options);
  return await withCursorLifecycleLock(paths, () => removeCursorAdapterInstallationUnlocked(paths));
}

async function removeCursorAdapterInstallationUnlocked(paths) {
  const state = readAdapterState(paths.statePath);
  const stateProblem = validateState(state, paths);
  if (stateProblem) return { ...stateProblem, action: "cursor-adapter-remove" };
  if (!state) {
    return {
      ok: true,
      action: "cursor-adapter-remove",
      skipped: true,
      reason: "not_managed",
      removed: false,
      statePath: paths.statePath,
    };
  }
  const disabled = disableCursorAdapterUnlocked(paths);
  if (disabled.ok === false) return { ...disabled, action: "cursor-adapter-remove" };
  const removeAgent = state.repoMemoryAgentPath === paths.repoMemoryAgentPath
    && managedRepoMemoryAgent(paths.repoMemoryAgentPath);
  const preserveAgent = pathEntryExists(paths.repoMemoryAgentPath) && !removeAgent;
  let stage = "skill-remove";
  try {
    rmSync(state.skillPath, { recursive: true, force: true });
    stage = "plugin-remove";
    if (removeAgent) {
      rmSync(paths.repoMemoryAgentPath, { force: true });
    }
    rmSync(cursorAdapterRoot(paths.memoraxCodeHome), { recursive: true, force: true });
  } catch (error) {
    return failure("remove_failed", paths, error, "cursor-adapter-remove", stage);
  }
  return {
    ok: true,
    action: "cursor-adapter-remove",
    runtime: "cursor",
    integration: "hooks",
    installed: false,
    enabled: false,
    managed: false,
    removed: true,
    cursorHome: paths.cursorHome,
    statePath: paths.statePath,
    ...(preserveAgent ? { preservedAgentPath: paths.repoMemoryAgentPath } : {}),
  };
}

export function cursorHookCommand(
  runtimePath,
  platform = process.platform,
  nodePath = process.execPath,
  powershellPath = defaultWindowsPowerShellPath(),
) {
  if (platform !== "win32") {
    return `${posixShellLiteral(nodePath)} ${posixShellLiteral(runtimePath)} ${HOOK_MARKER}`;
  }
  // Encoding keeps quoted paths out of the outer shell command string.
  // Forward the Hook payload through stdin without embedding it in the command.
  const script = [
    "$ErrorActionPreference='Stop'",
    "$utf8=[Text.UTF8Encoding]::new($false)",
    "[Console]::InputEncoding=$utf8",
    "[Console]::OutputEncoding=$utf8",
    "$payload=[Console]::In.ReadToEnd()",
    "$start=[Diagnostics.ProcessStartInfo]::new()",
    `$start.FileName=${powershellLiteral(nodePath)}`,
    `$start.Arguments=${powershellLiteral(`"${runtimePath}" "${HOOK_MARKER}"`)}`,
    "$start.UseShellExecute=$false",
    "$start.CreateNoWindow=$true",
    "$start.RedirectStandardInput=$true",
    "$start.RedirectStandardOutput=$true",
    "$start.RedirectStandardError=$true",
    "$start.StandardOutputEncoding=$utf8",
    "$start.StandardErrorEncoding=$utf8",
    "$process=[Diagnostics.Process]::new()",
    "$process.StartInfo=$start",
    "[void]$process.Start()",
    "$stdout=$process.StandardOutput.ReadToEndAsync()",
    "$stderr=$process.StandardError.ReadToEndAsync()",
    "$process.StandardInput.Write($payload)",
    "$process.StandardInput.Close()",
    "$process.WaitForExit()",
    "[Console]::Out.Write($stdout.GetAwaiter().GetResult())",
    "[Console]::Error.Write($stderr.GetAwaiter().GetResult())",
    "exit $process.ExitCode",
  ].join(";");
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return `${windowsExecutableToken(powershellPath)} -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
}

export function defaultWindowsPowerShellPath(env = process.env) {
  const systemRoot = stringOption(env.SystemRoot)
    ?? stringOption(env.SYSTEMROOT)
    ?? stringOption(env.WINDIR)
    ?? "C:\\Windows";
  return win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export function defaultCursorSkillSourcePath(adapterRoot = ADAPTER_ROOT) {
  const packaged = join(adapterRoot, "skills", "memorax-code");
  return existsSync(join(packaged, "SKILL.md"))
    ? packaged
    : resolve(adapterRoot, "..", "memorax-code-codex-adapter", "skills", "memorax-code");
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
  const statePath = resolve(options.statePath ?? cursorAdapterStatePath(memoraxCodeHome));
  const state = readAdapterState(statePath);
  // Reuse an installed root when a later lifecycle command omits its override.
  // Every operation still validates the full record before touching artifacts.
  const recordedHome = state?.version === STATE_VERSION && state.runtime === "cursor"
    && state.integration === "hooks" && typeof state.cursorHome === "string"
    && isAbsolute(state.cursorHome) ? state.cursorHome : undefined;
  const cursorHome = resolve(stringOption(options.cursorHome) ?? stringOption(process.env.CURSOR_HOME)
    ?? recordedHome ?? defaultCursorHome());
  return {
    memoraxCodeHome,
    cursorHome,
    // Uninstall removes the adapter directory; its lifecycle lock must survive.
    lifecycleLockTarget: resolve(
      options.lifecycleLockTarget ?? join(memoraxCodeHome, "adapters", "cursor-lifecycle"),
    ),
    statePath,
    hooksPath: resolve(options.hooksPath ?? cursorHooksPath(cursorHome)),
    skillPath: resolve(options.skillPath ?? cursorSkillPath(cursorHome)),
    repoMemoryAgentPath: resolve(options.repoMemoryAgentPath ?? cursorRepoMemoryAgentPath(cursorHome)),
    runtimeRoot: resolve(options.runtimeRoot ?? cursorRuntimeRoot(memoraxCodeHome)),
    runtimeHookSourcePath: resolve(options.runtimeHookSourcePath ?? join(ADAPTER_ROOT, "hooks", "runtime-hook.mjs")),
    repoMemoryJobSourcePath: resolve(options.repoMemoryJobSourcePath ?? join(ADAPTER_ROOT, "hooks", "repo-memory-job.mjs")),
    repoMemoryAgentSourcePath: resolve(options.repoMemoryAgentSourcePath ?? join(ADAPTER_ROOT, "agents", "memorax-repo-memory.md")),
    nativeRepoMemorySourcePath: resolve(options.nativeRepoMemorySourcePath ?? join(ADAPTER_ROOT, "src", "native-repo-memory.mjs")),
    runtimeObservationSourcePath: resolve(options.runtimeObservationSourcePath ?? join(ADAPTER_ROOT, "src", "runtime-observation.mjs")),
    nativeDatabasePathSourcePath: resolve(options.nativeDatabasePathSourcePath ?? join(ADAPTER_ROOT, "src", "native-database-path.mjs")),
    commonSourcePath: resolve(options.commonSourcePath ?? join(ADAPTER_ROOT, "..", "memorax-code-adapter-common", "src")),
    skillSourcePath: resolve(options.skillSourcePath ?? defaultCursorSkillSourcePath()),
  };
}

async function withCursorLifecycleLock(paths, operation) {
  let entered = false;
  try {
    return await withJsonFileLockAsync(paths.lifecycleLockTarget, () => {
      entered = true;
      return operation();
    });
  } catch (error) {
    const stage = !entered || error?.code === "JSON_FILE_LOCK_RELEASE_FAILED" ? "lock" : "deploy";
    throw attachDeploymentFailure(error, stage);
  }
}

function validateState(state, paths) {
  if (!state) return undefined;
  if (state.unreadable === true) return { ok: false, reason: "state_invalid", statePath: paths.statePath, failure: deploymentFailure(undefined, "state-read", { failureReason: "invalid_record" }) };
  if (state.version !== STATE_VERSION || state.runtime !== "cursor" || state.integration !== "hooks") {
    return { ok: false, reason: "state_invalid", statePath: paths.statePath, failure: deploymentFailure(undefined, "state-read", { failureReason: "invalid_record" }) };
  }
  const expected = {
    cursorHome: paths.cursorHome,
    hooksPath: paths.hooksPath,
    skillPath: paths.skillPath,
    runtimeRoot: paths.runtimeRoot,
  };
  if (Object.entries(expected).some(([key, value]) => state[key] !== value)
    || (state.repoMemoryAgentPath !== undefined && state.repoMemoryAgentPath !== paths.repoMemoryAgentPath)
    || (state.repoMemoryAgentDigest !== undefined && !/^[a-f0-9]{64}$/.test(String(state.repoMemoryAgentDigest)))
    || ((state.repoMemoryAgentPath === undefined) !== (state.repoMemoryAgentDigest === undefined))
    || !containedPath(paths.memoraxCodeHome, state.runtimeRoot)
    || !containedPath(state.runtimeRoot, state.runtimePath)
    || !/^[a-f0-9]{64}$/.test(String(state.runtimeDigest ?? ""))
    || !/^[a-f0-9]{64}$/.test(String(state.skillDigest ?? ""))
    || typeof state.hookCommand !== "string"
    || !managedHookCommand(state.hookCommand)) {
    return { ok: false, reason: "state_paths_invalid", statePath: paths.statePath, failure: deploymentFailure(undefined, "state-read", { failureReason: "invalid_record" }) };
  }
  return undefined;
}

function validateSources(paths) {
  for (const [name, path] of [
    ["runtime_hook", paths.runtimeHookSourcePath],
    ["repo_memory_job", paths.repoMemoryJobSourcePath],
    ["repo_memory_agent", paths.repoMemoryAgentSourcePath],
    ["native_repo_memory", paths.nativeRepoMemorySourcePath],
    ["runtime_observation", paths.runtimeObservationSourcePath],
    ["native_database_path", paths.nativeDatabasePathSourcePath],
  ]) {
    if (!regularFile(path)) return { ok: false, reason: `${name}_missing`, sourcePath: path, failure: deploymentFailure(undefined, "runtime-stage", { failureReason: "missing_source" }) };
  }
  if (!managedRepoMemoryAgent(paths.repoMemoryAgentSourcePath)) {
    return { ok: false, reason: "agent_source_invalid", sourcePath: paths.repoMemoryAgentSourcePath,
      failure: deploymentFailure(undefined, "runtime-stage", { failureReason: "invalid_record" }) };
  }
  for (const [name, path] of [["common_runtime", paths.commonSourcePath], ["skill", paths.skillSourcePath]]) {
    if (!regularDirectory(path)) return { ok: false, reason: `${name}_missing`, sourcePath: path, failure: deploymentFailure(undefined, name === "skill" ? "skill-stage" : "runtime-stage", { failureReason: "missing_source" }) };
  }
  if (!regularFile(join(paths.skillSourcePath, "SKILL.md"))) {
    return { ok: false, reason: "skill_missing", sourcePath: paths.skillSourcePath, failure: deploymentFailure(undefined, "skill-stage", { failureReason: "missing_source" }) };
  }
  return undefined;
}

function materializeRuntimeGeneration(paths, generationPath, runtimeDigest, runtimeMetadata) {
  if (pathEntryExists(generationPath)) {
    if (!runtimeGenerationCurrent(generationPath, runtimeDigest)) {
      throw attachDeploymentFailure(new Error("Cursor runtime generation is invalid"), "runtime-stage", { failureReason: "invalid_record" });
    }
    return;
  }
  const temporaryPath = join(paths.runtimeRoot, `.staging-${process.pid}-${randomUUID()}`);
  let stage = "runtime-stage";
  try {
    mkdirSync(paths.runtimeRoot, { recursive: true, mode: 0o700 });
    mkdirSync(join(temporaryPath, "hooks"), { recursive: true, mode: 0o700 });
    mkdirSync(join(temporaryPath, "src"), { recursive: true, mode: 0o700 });
    mkdirSync(join(temporaryPath, "skills"), { recursive: true, mode: 0o700 });
    mkdirSync(join(temporaryPath, "agents"), { recursive: true, mode: 0o700 });
    cpSync(paths.runtimeHookSourcePath, join(temporaryPath, "hooks", "runtime-hook.mjs"));
    cpSync(paths.repoMemoryJobSourcePath, join(temporaryPath, "hooks", "repo-memory-job.mjs"));
    cpSync(paths.repoMemoryAgentSourcePath, join(temporaryPath, "agents", "memorax-repo-memory.md"));
    cpSync(paths.nativeRepoMemorySourcePath, join(temporaryPath, "src", "native-repo-memory.mjs"));
    cpSync(paths.runtimeObservationSourcePath, join(temporaryPath, "src", "runtime-observation.mjs"));
    cpSync(paths.nativeDatabasePathSourcePath, join(temporaryPath, "src", "native-database-path.mjs"));
    cpSync(paths.commonSourcePath, join(temporaryPath, "memorax-code-adapter-common", "src"), { recursive: true });
    cpSync(paths.skillSourcePath, join(temporaryPath, "skills", "memorax-code"), { recursive: true });
    atomicWriteText(join(temporaryPath, "plugin.json"), CURSOR_AGENT_PLUGIN_MANIFEST);
    atomicWriteJson(join(temporaryPath, "generation.json"), { version: 1, runtimeDigest });
    atomicWriteJson(join(temporaryPath, ".memorax-code-package.json"), {
      ...runtimeMetadata,
      runtimeDigest,
    });
    stage = "runtime-publish";
    withWindowsDirectoryRetry(() => renameSync(temporaryPath, generationPath));
  } catch (error) {
    let cleanupError;
    try {
      withWindowsDirectoryRetry(() => rmSync(temporaryPath, { recursive: true, force: true }));
    } catch (failure) {
      cleanupError = failure;
      // Preserve the publication failure if Windows also blocks stage cleanup.
    }
    if (!existsSync(generationPath)) {
      error.stage = stage;
      throw attachDeploymentFailure(error, stage, { cleanupError });
    }
  }
}

function updateManagedHooks(path, command, enabled) {
  withJsonFileLock(path, () => {
    const manifest = readHookManifest(path);
    for (const event of REQUIRED_EVENTS) {
      const existing = Array.isArray(manifest.hooks[event]) ? manifest.hooks[event] : [];
      const filtered = existing.filter((hook) => !isManagedHook(hook));
      if (enabled) {
        filtered.push({ type: "command", command, timeout: HOOK_TIMEOUT_SECONDS });
      }
      if (filtered.length > 0) manifest.hooks[event] = filtered;
      else delete manifest.hooks[event];
    }
    atomicWriteJson(path, manifest);
  });
}

function readHookManifest(path) {
  if (!existsSync(path)) return { version: 1, hooks: {} };
  let text;
  try { text = readFileSync(path, "utf8"); }
  catch (error) { throw attachDeploymentFailure(error, "hooks-read"); }
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (error) { throw attachDeploymentFailure(error, "config-parse", { failureReason: "invalid_configuration" }); }
  if (!isRecord(parsed) || (parsed.version !== undefined && parsed.version !== 1)
    || (parsed.hooks !== undefined && !isRecord(parsed.hooks))) {
    throw attachDeploymentFailure(new Error(`invalid Cursor Hook manifest: ${path}`), "config-parse", { failureReason: "invalid_configuration" });
  }
  const manifest = { ...parsed, version: 1, hooks: { ...(parsed.hooks ?? {}) } };
  for (const event of REQUIRED_EVENTS) {
    if (manifest.hooks[event] !== undefined && !Array.isArray(manifest.hooks[event])) {
      throw attachDeploymentFailure(new Error(`invalid Cursor Hook event: ${event}`), "config-parse", { failureReason: "invalid_configuration" });
    }
  }
  return manifest;
}

function hooksConfigured(manifest, expectedCommand) {
  return REQUIRED_EVENTS.every((event) => {
    const managed = (manifest.hooks[event] ?? []).filter(isManagedHook);
    return managed.length === 1 && managed[0].type === "command" && managed[0].command === expectedCommand
      && managed[0].timeout === HOOK_TIMEOUT_SECONDS;
  });
}

function isManagedHook(hook) {
  return isRecord(hook) && (hook.type === undefined || hook.type === "command")
    && typeof hook.command === "string" && managedHookCommand(hook.command);
}

function managedHookCommand(command) {
  if (command.includes(HOOK_MARKER)) return true;
  const encoded = /(?:^|\s)-EncodedCommand\s+([A-Za-z0-9+/]+={0,2})\s*$/.exec(command)?.[1];
  if (!encoded || encoded.length % 4 !== 0) return false;
  try {
    return Buffer.from(encoded, "base64").toString("utf16le").includes(HOOK_MARKER);
  } catch {
    return false;
  }
}

function powershellLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function posixShellLiteral(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function windowsExecutableToken(path) {
  const normalized = String(path).replaceAll("\\", "/");
  return /^[A-Za-z]:\/[^\s"]+$/.test(normalized) ? normalized : "powershell.exe";
}

function materializeDirectory(source, destination, memoraxCodeCommand, memoraxCodeHome) {
  const temporaryPath = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  let stage = "skill-stage";
  try {
    mkdirSync(dirname(destination), { recursive: true });
    withWindowsDirectoryRetry(() => rmSync(temporaryPath, { recursive: true, force: true }));
    cpSync(source, temporaryPath, { recursive: true });
    atomicWriteJson(
      join(temporaryPath, SKILL_PACKAGE_METADATA),
      skillPackageMetadata(memoraxCodeCommand, memoraxCodeHome),
    );
    stage = "skill-remove";
    withWindowsDirectoryRetry(() => rmSync(destination, { recursive: true, force: true }));
    stage = "skill-publish";
    withWindowsDirectoryRetry(() => renameSync(temporaryPath, destination));
  } catch (error) {
    let cleanupError;
    try {
      withWindowsDirectoryRetry(() => rmSync(temporaryPath, { recursive: true, force: true }));
    } catch (failure) {
      cleanupError = failure;
      // Preserve the installation failure; a later attempt can repair the Skill.
    }
    error.stage = stage;
    throw attachDeploymentFailure(error, stage, { cleanupError });
  }
}

function runtimeGenerationCurrent(generationPath, runtimeDigest) {
  try {
    if (!regularDirectory(generationPath) || !regularDirectory(dirname(generationPath))) return false;
    const generationRecordPath = join(generationPath, "generation.json");
    const metadataPath = join(generationPath, ".memorax-code-package.json");
    const pluginManifestPath = join(generationPath, "plugin.json");
    const paths = {
      runtimeHookSourcePath: join(generationPath, "hooks", "runtime-hook.mjs"),
      repoMemoryJobSourcePath: join(generationPath, "hooks", "repo-memory-job.mjs"),
      repoMemoryAgentSourcePath: join(generationPath, "agents", "memorax-repo-memory.md"),
      nativeRepoMemorySourcePath: join(generationPath, "src", "native-repo-memory.mjs"),
      runtimeObservationSourcePath: join(generationPath, "src", "runtime-observation.mjs"),
      nativeDatabasePathSourcePath: join(generationPath, "src", "native-database-path.mjs"),
      commonSourcePath: join(generationPath, "memorax-code-adapter-common", "src"),
      skillSourcePath: join(generationPath, "skills", "memorax-code"),
    };
    const fixedPaths = new Set([...Object.values(paths), generationRecordPath, metadataPath, pluginManifestPath]);
    // Traversal rejects symlinks and special files before any deployed content is read.
    if (regularFiles(generationPath).some(path => !fixedPaths.has(path)
      && !containedPath(paths.commonSourcePath, path) && !containedPath(paths.skillSourcePath, path))) return false;
    const generation = readJsonFile(generationRecordPath)?.value;
    const metadata = readJsonFile(metadataPath)?.value;
    if (generation?.version !== 1 || generation.runtimeDigest !== runtimeDigest
      || metadata?.version !== 1 || metadata.runtimeDigest !== runtimeDigest) return false;
    const { runtimeDigest: _runtimeDigest, ...runtimeMetadata } = metadata;
    return runtimeSourceDigest(paths, runtimeMetadata, readFileSync(pluginManifestPath)) === runtimeDigest;
  } catch {
    return false;
  }
}

function runtimeSourceDigest(paths, runtimeMetadata, pluginManifest = CURSOR_AGENT_PLUGIN_MANIFEST) {
  const hash = createHash("sha256");
  hashFile(hash, paths.runtimeHookSourcePath, "hooks/runtime-hook.mjs");
  hashFile(hash, paths.repoMemoryJobSourcePath, "hooks/repo-memory-job.mjs");
  hashFile(hash, paths.repoMemoryAgentSourcePath, "agents/memorax-repo-memory.md");
  hashFile(hash, paths.nativeRepoMemorySourcePath, "src/native-repo-memory.mjs");
  hashFile(hash, paths.runtimeObservationSourcePath, "src/runtime-observation.mjs");
  hashFile(hash, paths.nativeDatabasePathSourcePath, "src/native-database-path.mjs");
  hashDirectory(hash, paths.commonSourcePath, "memorax-code-adapter-common/src");
  hashDirectory(hash, paths.skillSourcePath, "skills/memorax-code");
  hash.update("plugin.json\0");
  hash.update(pluginManifest);
  hash.update("\0");
  // Recovery paths can change without source changes. Include the metadata
  // in the identity so existing runtime generations remain immutable.
  hash.update(".memorax-code-package.json\0");
  hash.update(JSON.stringify(runtimeMetadata));
  hash.update("\0");
  return hash.digest("hex");
}

function skillDirectoryDigest(path) {
  const hash = createHash("sha256");
  hashDirectory(hash, path, "", SKILL_PACKAGE_METADATA);
  return hash.digest("hex");
}

function directoryDigestIfPresent(path, ignoredPath) {
  try {
    const hash = createHash("sha256");
    hashDirectory(hash, path, "", ignoredPath);
    return hash.digest("hex");
  } catch {
    return undefined;
  }
}

function hashDirectory(hash, root, prefix, ignoredPath) {
  for (const file of regularFiles(root)) {
    const label = join(prefix, relative(root, file)).replaceAll("\\", "/");
    if (label === ignoredPath) continue;
    hashFile(hash, file, label);
  }
}

function skillPackageMetadataCurrent(skillPath, memoraxCodeCommand, memoraxCodeHome) {
  try {
    return readFileSync(join(skillPath, SKILL_PACKAGE_METADATA), "utf8")
      === `${JSON.stringify(skillPackageMetadata(memoraxCodeCommand, memoraxCodeHome), null, 2)}\n`;
  } catch {
    return false;
  }
}

function skillPackageMetadata(memoraxCodeCommand, memoraxCodeHome) {
  return {
    version: 1,
    memoraxCodeHome,
    ...(memoraxCodeCommand ? { memoraxCodeCommand } : {}),
  };
}

function hashFile(hash, path, label) {
  hash.update(label);
  hash.update("\0");
  hash.update(readFileSync(path));
  hash.update("\0");
}

function regularFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) throw new Error(`managed source contains a symbolic link: ${path}`);
    if (metadata.isDirectory()) files.push(...regularFiles(path));
    else if (metadata.isFile()) files.push(path);
    else throw new Error(`managed source contains a non-regular entry: ${path}`);
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function skillSummary(path, ok) {
  return { ok, status: ok ? "installed" : "missing", managed: ok, memoraxCode: ok, path: join(path, "SKILL.md") };
}

function agentSummary(path, ok) {
  return { ok, status: ok ? "installed" : "missing", managed: ok, repoMemory: ok, path };
}

function managedRepoMemoryAgent(path) {
  try { return regularDirectory(dirname(path)) && regularFile(path)
    && readFileSync(path, "utf8").split(/\r?\n/).includes(REPO_MEMORY_AGENT_MARKER); }
  catch { return false; }
}

function fileDigestIfPresent(path) {
  try { return regularFile(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : undefined; }
  catch { return undefined; }
}

function pathEntryExists(path) {
  try { lstatSync(path); return true; }
  catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return false; throw error; }
}

function failure(reason, paths, error, action = "status", stage = "deploy") {
  return {
    ok: false,
    action,
    runtime: "cursor",
    integration: "hooks",
    installed: false,
    enabled: false,
    managed: existsSync(paths.statePath),
    reason,
    error: error instanceof Error ? error.message : String(error),
    ...(typeof error?.code === "string" ? { errorCode: error.code } : {}),
    ...(typeof error?.stage === "string" ? { stage: error.stage } : {}),
    failure: deploymentFailure(error, stage),
    cursorHome: paths.cursorHome,
    statePath: paths.statePath,
  };
}

function conflict(reason, paths, conflictPath, stage = "skill-stage") {
  return {
    ...failure(reason, paths, new Error(`unmanaged Cursor artifact exists: ${conflictPath}`), "enable"),
    conflictPath,
    failure: deploymentFailure(undefined, stage, { failureReason: "conflict" }),
  };
}

function regularFile(path) {
  try { return statSync(path).isFile() && !lstatSync(path).isSymbolicLink(); } catch { return false; }
}

function regularDirectory(path) {
  try { return statSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(); } catch { return false; }
}

function absoluteRegularFile(value) {
  const path = stringOption(value);
  return path && isAbsolute(path) && regularFile(path) ? path : undefined;
}

function containedPath(boundary, path) {
  if (typeof path !== "string") return false;
  const child = relative(resolve(boundary), resolve(path));
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function comparablePath(value, platform) {
  const normalized = String(value ?? "").replaceAll("\\", "/").replace(/\/+$/, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
