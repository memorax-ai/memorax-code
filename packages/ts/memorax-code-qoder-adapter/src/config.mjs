import { createHash, randomUUID } from "node:crypto";
import {
  cpSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readJsonFile, stringOption, withJsonFileLock, withJsonFileLockAsync,
} from "../../memorax-code-adapter-common/src/config-utils.mjs";
import { writePrivateJsonRecord } from "../../memorax-code-adapter-common/src/runtime-record.mjs";
import { attachDeploymentFailure, deploymentFailure } from "../../memorax-code-adapter-common/src/deployment-failure.mjs";
import { withWindowsDirectoryRetry } from "../../memorax-code-adapter-common/src/windows-directory-retry.mjs";
import {
  defaultMemoraxCodeHome, defaultQoderHome, qoderAdapterRoot, qoderAdapterStatePath,
  qoderRuntimeRoot, qoderSettingsPath, qoderSkillPath,
} from "./adapter-paths.mjs";
import { qoderRuntimeObservationPath, readQoderRuntimeObservation } from "./runtime-observation.mjs";

const ADAPTER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OWNER = "memorax-code-qoder-adapter";
const HOOK_MARKER = "--memorax-code-qoder-hook-v1";
const EVENTS = ["SessionStart", "UserPromptSubmit", "QueryEnd", "PreToolUse"];
const PACKAGE_METADATA = ".memorax-code-package.json";
const AGENT_FILE = "agents/memorax-repo-memory.md";
const RUNTIME_FILES = ["hooks/runtime-hook.mjs", "hooks/repo-memory-job.mjs", "src/native-repo-memory.mjs",
  "src/repo-memory-events.mjs", "src/runtime-observation.mjs", "src/memory-cli-context.mjs", AGENT_FILE];

export async function enableQoderAdapter(options = {}) {
  const paths = resolvePaths(options);
  return await withLifecycleLock(paths, async () => {
    const previous = readState(paths);
    const problem = validateState(previous, paths) ?? skillConflict(previous, paths) ?? agentConflict(previous, paths);
    if (problem) return { ...problem, action: "enable" };
    let stage = "hooks-read";
    try {
      const manifest = readSettings(paths.hooksPath);
      stage = "runtime-stage";
      const previousMetadata = previous && readJsonFile(join(dirname(dirname(previous.runtimePath)), PACKAGE_METADATA))?.value;
      const memoraxCodeCommand = stringOption(options.memoraxCodeCommand) ?? defaultMemoraxCodeCommand(paths.adapterRoot);
      const npmExecPath = absoluteRegularFile(options.npmExecPath ?? process.env.MEMORAX_CODE_NPM_EXEC_PATH
        ?? process.env.npm_execpath ?? previousMetadata?.npmExecPath);
      const metadata = {
        version: 1, memoraxCodeHome: paths.memoraxCodeHome, qoderHome: paths.qoderHome,
        ...(memoraxCodeCommand ? { memoraxCodeCommand } : {}),
        ...(npmExecPath ? { npmExecPath } : {}),
      };
      const runtimeDigest = runtimeSourceDigest(paths, metadata);
      const generation = join(paths.runtimeRoot, runtimeDigest);
      const runtimePath = join(generation, "hooks", "runtime-hook.mjs");
      const hook = qoderHookCommand(runtimePath, absoluteRegularFile(options.nodePath) ?? process.execPath);
      stage = "skill-stage";
      if (!regularFile(join(paths.skillSourcePath, "SKILL.md"))) throw new Error("Qoder shared Skill source is missing");
      const skillDigest = directoryDigest(paths.skillSourcePath, PACKAGE_METADATA);
      const agentDigest = fileDigest(join(paths.adapterRoot, AGENT_FILE));
      const skillMetadata = {
        ...metadata, owner: OWNER, skillDigest,
      };
      delete skillMetadata.npmExecPath;
      const skillCurrent = sameJson(readJsonFile(join(paths.skillPath, PACKAGE_METADATA))?.value, skillMetadata)
        && directoryDigestIfPresent(paths.skillPath) === skillDigest;
      const agentCurrent = fileDigest(paths.agentPath) === agentDigest;
      const current = previous?.enabled === true && previous.runtimeDigest === runtimeDigest
        && previous.skillDigest === skillDigest && regularFile(runtimePath)
        && skillCurrent && agentCurrent && hooksConfigured(manifest, hook);
      const now = new Date().toISOString();
      const state = {
        version: 1, runtime: "qoder", integration: "hooks", enabled: true,
        qoderHome: paths.qoderHome, hooksPath: paths.hooksPath, skillPath: paths.skillPath,
        skillDigest, agentPath: paths.agentPath, agentDigest,
        runtimeRoot: paths.runtimeRoot, runtimePath, runtimeDigest, hook,
        installedAt: previous?.installedAt ?? now, updatedAt: now,
      };
      stage = "state-write";
      // Record both Skill identities until publication completes, so an interrupted
      // upgrade can recover without adopting an unrelated or user-edited Skill.
      writeRecord(paths.statePath, {
        ...state, enabled: false, installPending: true,
        skillDigest: readJsonFile(join(paths.skillPath, PACKAGE_METADATA))?.value?.skillDigest
          ?? previous?.skillDigest ?? skillDigest,
        pendingSkillDigest: skillDigest,
        agentDigest: fileDigest(paths.agentPath) ?? previous?.agentDigest ?? agentDigest,
        pendingAgentDigest: agentDigest,
      });
      stage = "runtime-stage";
      materializeRuntime(paths, generation, runtimeDigest, metadata);
      if (!skillCurrent) {
        stage = "skill-stage";
        materializeSkill(paths, skillMetadata);
      }
      if (!agentCurrent) {
        stage = "plugin-stage";
        materializeAgent(paths, agentDigest);
      }
      stage = "hooks-write";
      updateManagedHooks(paths.hooksPath, hook);
      stage = "state-write";
      writeRecord(paths.statePath, state);
      return await status(paths, { changed: !current });
    } catch (error) {
      return failure("install_failed", paths, error, "enable", stage);
    }
  });
}

export async function disableQoderAdapter(options = {}) {
  const paths = resolvePaths(options);
  return await withLifecycleLock(paths, () => disable(paths));
}

function disable(paths) {
  const state = readState(paths);
  const problem = validateState(state, paths);
  if (problem) return { ...problem, action: "disable" };
  if (!state) return absent(paths, "disable");
  let stage = "state-write";
  try {
    // Disable authority before editing native settings. A Hook already loaded by
    // Qoder must not restart the Backend after lifecycle disablement.
    const disabled = { ...state, enabled: false, disabledAt: new Date().toISOString() };
    delete disabled.installPending;
    writeRecord(paths.statePath, disabled);
    stage = "hooks-write";
    updateManagedHooks(paths.hooksPath);
    return {
      ...base(paths, "disable"), ok: true, installed: regularFile(state.runtimePath)
        && regularFile(join(paths.skillPath, "SKILL.md")),
      enabled: false, managed: true, changed: state.enabled === true,
    };
  } catch (error) {
    return failure("disable_failed", paths, error, "disable", stage);
  }
}

export async function removeQoderAdapter(options = {}) {
  const paths = resolvePaths(options);
  return await withLifecycleLock(paths, () => {
    const state = readState(paths);
    const problem = validateState(state, paths);
    if (problem) return { ...problem, action: "qoder-adapter-remove" };
    if (!state) return { ...absent(paths, "qoder-adapter-remove"), removed: false };
    const disabled = disable(paths);
    if (!disabled.ok) return { ...disabled, action: "qoder-adapter-remove" };
    const conflict = skillConflict(state, paths) ?? agentConflict(state, paths);
    if (conflict) return { ...conflict, action: "qoder-adapter-remove" };
    let stage = "skill-remove";
    try {
      withWindowsDirectoryRetry(() => rmSync(paths.skillPath, { recursive: true, force: true }));
      withWindowsDirectoryRetry(() => rmSync(paths.agentPath, { force: true }));
      stage = "plugin-remove";
      withWindowsDirectoryRetry(() => rmSync(qoderAdapterRoot(paths.memoraxCodeHome), { recursive: true, force: true }));
      return { ...base(paths, "qoder-adapter-remove"), ok: true, installed: false, enabled: false, managed: false, removed: true };
    } catch (error) {
      return failure("remove_failed", paths, error, "qoder-adapter-remove", stage);
    }
  });
}

export async function readQoderAdapterStatus(options = {}) {
  return await status(resolvePaths(options));
}

async function status(paths, extra = {}) {
  const state = readState(paths);
  const problem = validateState(state, paths);
  if (problem) return { ...problem, action: "status" };
  if (!state) return {
    ...absent(paths, "status"),
    qoderHooks: { ok: false, configured: false, runtimeObserved: false, status: "missing" },
    qoderSkills: { ok: false, managed: false, status: "missing", path: paths.skillPath },
  };
  let configured = false;
  try { configured = hooksConfigured(readSettings(paths.hooksPath), state.hook); } catch { /* Report invalid settings without changing them. */ }
  const runtimeMetadata = readCurrentRuntimeMetadata(paths, state);
  const runtimeCurrent = runtimeMetadata !== undefined;
  const skillMetadata = readJsonFile(join(paths.skillPath, PACKAGE_METADATA))?.value;
  const skillCurrent = !skillConflict(state, paths)
    && directoryDigestIfPresent(paths.skillPath) === state.skillDigest
    && stringOption(runtimeMetadata?.memoraxCodeCommand) !== undefined
    && skillMetadata?.memoraxCodeCommand === runtimeMetadata.memoraxCodeCommand;
  const observation = await readQoderRuntimeObservation(paths.memoraxCodeHome);
  const runtimeObserved = observation?.runtimeDigest === state.runtimeDigest && observation?.qoderHome === paths.qoderHome;
  const agentCurrent = digestValue(state.agentDigest) && fileDigest(paths.agentPath) === state.agentDigest
    && fileDigest(join(dirname(dirname(state.runtimePath)), AGENT_FILE)) === state.agentDigest;
  const installed = runtimeCurrent && skillCurrent && agentCurrent;
  const enabled = state.enabled === true && !state.installPending && installed && configured;
  return {
    ...base(paths, "status"), ok: true, installed, enabled, managed: true,
    current: installed && configured, ...extra,
    runtimePath: state.runtimePath, runtimeDigest: state.runtimeDigest,
    qoderHooks: { ok: configured, configured, runtimeObserved, status: configured ? (runtimeObserved ? "observed" : "unverified") : "invalid", observationPath: qoderRuntimeObservationPath(paths.memoraxCodeHome) },
    qoderSkills: { ok: skillCurrent, managed: skillCurrent, status: skillCurrent ? "installed" : "invalid", path: join(paths.skillPath, "SKILL.md") },
    qoderRepoMemoryAgent: { ok: agentCurrent, status: agentCurrent ? "installed" : "invalid", path: paths.agentPath },
    ...(!enabled ? { reason: state.installPending ? "install_incomplete" : !state.enabled ? "disabled" : !installed ? "artifacts_missing" : "hooks_not_configured" } : {}),
  };
}

// Native command + args avoids shell interpolation of runtime and Node paths.
export function qoderHookCommand(runtimePath, nodePath = process.execPath) {
  return { type: "command", command: nodePath, args: [runtimePath, HOOK_MARKER] };
}

export function defaultQoderSkillSourcePath(adapterRoot = ADAPTER_ROOT) {
  const packaged = join(adapterRoot, "skills", "memorax-code");
  return regularFile(join(packaged, "SKILL.md")) ? packaged
    : resolve(adapterRoot, "..", "memorax-code-codex-adapter", "skills", "memorax-code");
}

export function defaultMemoraxCodeCommand(adapterRoot = ADAPTER_ROOT) {
  const packageRoot = resolve(adapterRoot, "..", "..");
  return [join(packageRoot, "bin", "memorax-code.mjs"), join(packageRoot, "npm", "memorax-code", "bin", "memorax-code.mjs")].find(regularFile);
}

function resolvePaths(options) {
  const memoraxCodeHome = resolve(options.memoraxCodeHome ?? defaultMemoraxCodeHome());
  const qoderHome = resolve(options.qoderHome ?? defaultQoderHome());
  const adapterRoot = resolve(options.adapterRoot ?? ADAPTER_ROOT);
  return {
    adapterRoot, memoraxCodeHome, qoderHome,
    statePath: qoderAdapterStatePath(memoraxCodeHome), hooksPath: qoderSettingsPath(qoderHome),
    skillPath: qoderSkillPath(qoderHome), runtimeRoot: qoderRuntimeRoot(memoraxCodeHome),
    agentPath: join(qoderHome, AGENT_FILE),
    lifecycleLock: join(memoraxCodeHome, "adapters", "qoder-lifecycle"),
    commonSourcePath: resolve(options.commonSourcePath ?? join(adapterRoot, "..", "memorax-code-adapter-common", "src")),
    skillSourcePath: resolve(options.skillSourcePath ?? defaultQoderSkillSourcePath(adapterRoot)),
  };
}

async function withLifecycleLock(paths, operation) {
  try { return await withJsonFileLockAsync(paths.lifecycleLock, operation); }
  catch (error) { throw attachDeploymentFailure(error, "lock"); }
}

function readState(paths) {
  const record = readJsonFile(paths.statePath);
  return record?.unreadable ? { unreadable: true } : record ? record.value : undefined;
}

function validateState(state, paths) {
  if (state === undefined) return undefined;
  if (!isRecord(state) || state.version !== 1 || state.runtime !== "qoder" || state.integration !== "hooks"
    || typeof state.enabled !== "boolean" || state.qoderHome !== paths.qoderHome
    || state.hooksPath !== paths.hooksPath || state.skillPath !== paths.skillPath
    || state.runtimeRoot !== paths.runtimeRoot || !digestValue(state.runtimeDigest) || !digestValue(state.skillDigest)
    || (state.pendingSkillDigest !== undefined && !digestValue(state.pendingSkillDigest))
    || (state.agentPath !== undefined && state.agentPath !== paths.agentPath)
    || (state.agentDigest !== undefined && !digestValue(state.agentDigest))
    || (state.pendingAgentDigest !== undefined && !digestValue(state.pendingAgentDigest))
    || state.runtimePath !== join(paths.runtimeRoot, state.runtimeDigest, "hooks", "runtime-hook.mjs")
    || !managedHook(state.hook) || state.hook.args[0] !== state.runtimePath
    || !isAbsolute(state.hook.command)) {
    return failure("state_invalid", paths, new Error("Qoder adapter state does not match its installation scope"), "status", "state-read");
  }
  return undefined;
}

function skillConflict(state, paths) {
  if (!entryExists(paths.skillPath)) return undefined;
  const metadata = readJsonFile(join(paths.skillPath, PACKAGE_METADATA))?.value;
  const owned = state && regularDirectory(paths.skillPath) && metadata?.version === 1
    && metadata.owner === OWNER && metadata.qoderHome === paths.qoderHome
    && metadata.memoraxCodeHome === paths.memoraxCodeHome
    && [state.skillDigest, state.pendingSkillDigest].includes(metadata.skillDigest)
    && directoryDigestIfPresent(paths.skillPath) === metadata.skillDigest;
  return owned ? undefined : failure("skill_conflict", paths,
    new Error("Qoder memorax-code Skill is unmanaged or has user changes"), "enable", "skill-stage");
}

function agentConflict(state, paths) {
  if (!entryExists(paths.agentPath)) return undefined;
  const digest = fileDigest(paths.agentPath);
  return digest && state && [state.agentDigest, state.pendingAgentDigest].includes(digest) ? undefined
    : failure("agent_conflict", paths, new Error("Qoder Repo Memory agent is unmanaged or has user changes"), "enable", "plugin-stage");
}

function readSettings(path) {
  if (!entryExists(path)) return { hooks: {} };
  if (!regularFile(path)) throw new Error("Qoder settings must be a regular file");
  let value;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw attachDeploymentFailure(new Error("Invalid Qoder settings JSON"), "config-parse", { failureReason: "invalid_configuration" }); }
  if (!isRecord(value) || (value.hooks !== undefined && !isRecord(value.hooks))) throw new Error("Invalid Qoder settings");
  const manifest = { ...value, hooks: { ...(value.hooks ?? {}) } };
  for (const event of EVENTS) {
    if (manifest.hooks[event] !== undefined && !Array.isArray(manifest.hooks[event])) throw new Error(`Invalid Qoder ${event} Hooks`);
  }
  return manifest;
}

function updateManagedHooks(path, hook) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  withJsonFileLock(path, () => {
    const manifest = readSettings(path);
    for (const event of EVENTS) {
      const groups = (manifest.hooks[event] ?? []).flatMap((group) => {
        if (!isRecord(group) || !Array.isArray(group.hooks)) return [group];
        const hooks = group.hooks.filter((entry) => !managedHook(entry));
        return hooks.length ? [{ ...group, hooks }] : [];
      });
      if (hook) groups.push(hookGroup(event, hook));
      if (groups.length) manifest.hooks[event] = groups;
      else delete manifest.hooks[event];
    }
    writeRecord(path, manifest);
  }, { ensurePrivateDirectory: false });
}

function hookGroup(event, hook) {
  return {
    ...(event === "PreToolUse" ? { matcher: "Bash" } : {}),
    // Submit prepares a fixed local snapshot before returning a delegation.
    // Deferred human notifications need two bounded Backend requests at QueryEnd.
    hooks: [{ ...hook, timeout: event === "SessionStart" ? 120 : event === "UserPromptSubmit" ? 150 : event === "QueryEnd" ? 40 : 5 }],
  };
}

function hooksConfigured(manifest, hook) {
  return EVENTS.every((event) => {
    const expected = hookGroup(event, hook);
    const managed = (manifest.hooks[event] ?? []).flatMap((group) => (Array.isArray(group?.hooks) ? group.hooks : [])
      .filter(managedHook).map((entry) => ({ matcher: group.matcher, hook: entry })));
    return managed.length === 1 && managed[0].matcher === expected.matcher
      && sameJson(managed[0].hook, expected.hooks[0]);
  });
}

function readCurrentRuntimeMetadata(paths, state) {
  try {
    const generation = dirname(dirname(state.runtimePath));
    const metadata = readJsonFile(join(generation, PACKAGE_METADATA))?.value;
    if (!isRecord(metadata) || metadata.version !== 1 || metadata.runtimeDigest !== state.runtimeDigest
      || metadata.memoraxCodeHome !== paths.memoraxCodeHome || metadata.qoderHome !== paths.qoderHome
      || readJsonFile(join(generation, "generation.json"))?.value?.runtimeDigest !== state.runtimeDigest) return undefined;
    const sourceMetadata = { ...metadata };
    delete sourceMetadata.runtimeDigest;
    return runtimeSourceDigest({ ...paths, adapterRoot: generation,
      commonSourcePath: join(generation, "memorax-code-adapter-common", "src") }, sourceMetadata) === state.runtimeDigest
      ? metadata : undefined;
  } catch { return undefined; }
}

function managedHook(value) {
  return isRecord(value) && value.type === "command" && typeof value.command === "string"
    && Array.isArray(value.args) && value.args.includes(HOOK_MARKER);
}

function materializeRuntime(paths, generation, runtimeDigest, metadata) {
  if (entryExists(generation)) {
    const installedPaths = { ...paths, adapterRoot: generation, commonSourcePath: join(generation, "memorax-code-adapter-common", "src") };
    if (!regularDirectory(generation)
      || readJsonFile(join(generation, "generation.json"))?.value?.runtimeDigest !== runtimeDigest
      || runtimeSourceDigest(installedPaths, metadata) !== runtimeDigest
      || !sameJson(readJsonFile(join(generation, PACKAGE_METADATA))?.value, { ...metadata, runtimeDigest })) {
      throw new Error("Qoder runtime generation is invalid");
    }
    return;
  }
  const temporary = join(paths.runtimeRoot, `.staging-${process.pid}-${randomUUID()}`);
  try {
    mkdirSync(temporary, { recursive: true, mode: 0o700 });
    for (const file of RUNTIME_FILES) {
      mkdirSync(dirname(join(temporary, file)), { recursive: true, mode: 0o700 });
      cpSync(join(paths.adapterRoot, file), join(temporary, file));
    }
    cpSync(paths.commonSourcePath, join(temporary, "memorax-code-adapter-common", "src"), { recursive: true });
    const stagedPaths = { ...paths, adapterRoot: temporary, commonSourcePath: join(temporary, "memorax-code-adapter-common", "src") };
    if (runtimeSourceDigest(stagedPaths, metadata) !== runtimeDigest) throw new Error("Qoder runtime sources changed during staging");
    writeRecord(join(temporary, "generation.json"), { version: 1, runtimeDigest });
    writeRecord(join(temporary, PACKAGE_METADATA), { ...metadata, runtimeDigest });
    withWindowsDirectoryRetry(() => renameSync(temporary, generation));
  } finally {
    withWindowsDirectoryRetry(() => rmSync(temporary, { recursive: true, force: true }));
  }
}

function materializeSkill(paths, metadata) {
  const temporary = `${paths.skillPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    mkdirSync(dirname(paths.skillPath), { recursive: true, mode: 0o700 });
    cpSync(paths.skillSourcePath, temporary, { recursive: true });
    writeRecord(join(temporary, PACKAGE_METADATA), metadata);
    if (directoryDigestIfPresent(temporary) !== metadata.skillDigest) throw new Error("Qoder Skill sources changed during staging");
    if (skillConflict(readState(paths), paths)) throw new Error("Qoder Skill changed before publication");
    withWindowsDirectoryRetry(() => rmSync(paths.skillPath, { recursive: true, force: true }));
    withWindowsDirectoryRetry(() => renameSync(temporary, paths.skillPath));
  } finally {
    withWindowsDirectoryRetry(() => rmSync(temporary, { recursive: true, force: true }));
  }
}

function materializeAgent(paths, digest) {
  const temporary = `${paths.agentPath}.tmp-${process.pid}-${randomUUID()}`;
  try {
    mkdirSync(dirname(paths.agentPath), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, readFileSync(join(paths.adapterRoot, AGENT_FILE)), { mode: 0o600, flag: "wx" });
    if (fileDigest(temporary) !== digest || agentConflict(readState(paths), paths)) throw new Error("Qoder Repo Memory agent changed before publication");
    withWindowsDirectoryRetry(() => renameSync(temporary, paths.agentPath));
  } finally {
    rmSync(temporary, { force: true });
  }
}

function fileDigest(path) {
  return regularFile(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : undefined;
}

function runtimeSourceDigest(paths, metadata) {
  const hash = createHash("sha256");
  for (const file of RUNTIME_FILES) hashFile(hash, join(paths.adapterRoot, file), file);
  hashDirectory(hash, paths.commonSourcePath, "memorax-code-adapter-common/src");
  hash.update(`${PACKAGE_METADATA}\0${JSON.stringify(metadata)}\0`);
  return hash.digest("hex");
}

function directoryDigest(path, ignoredPath) {
  const hash = createHash("sha256");
  hashDirectory(hash, path, "", ignoredPath);
  return hash.digest("hex");
}

function directoryDigestIfPresent(path) {
  try { return directoryDigest(path, PACKAGE_METADATA); } catch { return undefined; }
}

function hashDirectory(hash, root, prefix, ignoredPath) {
  if (!regularDirectory(root)) throw new Error("Managed source must be a regular directory");
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name);
      const label = join(prefix, relative(root, path)).replaceAll("\\", "/");
      if (label === ignoredPath) continue;
      if (entry.isDirectory()) visit(path);
      else hashFile(hash, path, label);
    }
  };
  visit(root);
}

function hashFile(hash, path, label) {
  if (!regularFile(path)) throw new Error("Managed source must contain only regular files and directories");
  hash.update(`${label}\0`); hash.update(readFileSync(path)); hash.update("\0");
}

function writeRecord(path, value) {
  writePrivateJsonRecord(path, value, { durableBoundary: dirname(path) });
}

function base(paths, action) {
  return { action, runtime: "qoder", integration: "hooks", qoderHome: paths.qoderHome,
    statePath: paths.statePath, hooksPath: paths.hooksPath, skillPath: paths.skillPath };
}

function absent(paths, action) {
  return { ...base(paths, action), ok: true, installed: false, enabled: false, managed: false, skipped: true, reason: "not_managed" };
}

function failure(reason, paths, error, action, stage) {
  return { ...base(paths, action), ok: false, installed: false, enabled: false,
    managed: entryExists(paths.statePath), reason, error: error.message,
    failure: deploymentFailure(error, stage) };
}

function entryExists(path) {
  try { lstatSync(path); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; }
}

function regularFile(path) {
  try { return lstatSync(path).isFile(); } catch { return false; }
}

function regularDirectory(path) {
  try { return lstatSync(path).isDirectory(); } catch { return false; }
}

function absoluteRegularFile(value) {
  const path = stringOption(value);
  // Node executables are commonly symlinks; using an explicit absolute executable
  // does not grant ownership of its target to this adapter.
  try { return path && isAbsolute(path) && statSync(path).isFile() ? path : undefined; } catch { return undefined; }
}

function digestValue(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
