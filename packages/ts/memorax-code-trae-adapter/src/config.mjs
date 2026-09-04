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
  readAdapterState,
  readJsonFile,
  stringOption,
  withJsonFileLock,
  withJsonFileLockAsync,
} from "../../memorax-code-adapter-common/src/config-utils.mjs";
import {
  defaultMemoraxCodeHome,
  defaultTraeHome,
  traeAdapterRoot,
  traeAdapterStatePath,
  traeHooksPath,
  traeRuntimeRoot,
  traeSkillPath,
} from "./adapter-paths.mjs";
import {
  readTraeRuntimeObservation,
  traeRuntimeObservationPath,
} from "./runtime-observation.mjs";

const ADAPTER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STATE_VERSION = 1;
const HOOK_MARKER = "--memorax-code-trae-hook-v1";
const REQUIRED_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop"];
const SKILL_PACKAGE_METADATA = ".memorax-code-package.json";

export async function enableTraeAdapter(options = {}) {
  const paths = resolvePaths(options);
  return await withTraeLifecycleLock(paths, () => enableTraeAdapterUnlocked(paths, options));
}

async function enableTraeAdapterUnlocked(paths, options) {
  const previousState = readAdapterState(paths.statePath);
  const stateProblem = validateState(previousState, paths);
  if (stateProblem) return { ...stateProblem, action: "enable" };
  const sourceProblem = validateSources(paths);
  if (sourceProblem) return { ...sourceProblem, action: "enable" };
  if (existsSync(paths.skillPath) && previousState?.skillPath !== paths.skillPath) {
    return conflict("skill_conflict", paths, paths.skillPath);
  }

  let hookManifest;
  try {
    hookManifest = readHookManifest(paths.hooksPath);
  } catch (error) {
    return failure("hooks_invalid", paths, error);
  }

  const runtimeDigest = runtimeSourceDigest(paths);
  const generationPath = join(paths.runtimeRoot, runtimeDigest);
  const runtimePath = join(generationPath, "hooks", "runtime-hook.mjs");
  const hookCommand = traeHookCommand(
    runtimePath,
    options.platform ?? process.platform,
    absoluteRegularFile(options.nodePath) ?? process.execPath,
    options.powershellPath ?? defaultWindowsPowerShellPath(),
  );
  const memoraxCodeCommand = stringOption(options.memoraxCodeCommand) ?? defaultMemoraxCodeCommand();
  const skillDigest = skillDirectoryDigest(paths.skillSourcePath);
  const skillCurrent = directoryDigestIfPresent(paths.skillPath, SKILL_PACKAGE_METADATA) === skillDigest
    && skillPackageMetadataCurrent(paths.skillPath, memoraxCodeCommand);
  const current = previousState?.runtimeDigest === runtimeDigest
    && previousState?.skillDigest === skillDigest
    && previousState?.enabled === true
    && existsSync(runtimePath)
    && skillCurrent
    && hooksConfigured(hookManifest, hookCommand);
  const now = new Date().toISOString();
  const state = {
    version: STATE_VERSION,
    runtime: "trae",
    integration: "hooks",
    enabled: true,
    traeHome: paths.traeHome,
    hooksPath: paths.hooksPath,
    skillPath: paths.skillPath,
    skillDigest,
    runtimeRoot: paths.runtimeRoot,
    runtimePath,
    runtimeDigest,
    hookCommand,
    installedAt: stringOption(previousState?.installedAt) ?? now,
    updatedAt: now,
  };

  try {
    atomicWriteJson(paths.statePath, { ...state, enabled: false, installPending: true });
    materializeRuntimeGeneration(paths, generationPath, runtimeDigest, options);
    if (!skillCurrent) {
      materializeDirectory(paths.skillSourcePath, paths.skillPath, memoraxCodeCommand);
    }
    updateManagedHooks(paths.hooksPath, hookCommand, true);
    atomicWriteJson(paths.statePath, state);
  } catch (error) {
    return failure("install_failed", paths, error);
  }

  return await readTraeAdapterStatusUnlocked(paths, { ...options, changed: !current });
}

export async function disableTraeAdapter(options = {}) {
  const paths = resolvePaths(options);
  return await withTraeLifecycleLock(paths, () => disableTraeAdapterUnlocked(paths));
}

function disableTraeAdapterUnlocked(paths) {
  const state = readAdapterState(paths.statePath);
  const stateProblem = validateState(state, paths);
  if (stateProblem) return { ...stateProblem, action: "disable" };
  if (!state) {
    return {
      ok: true,
      action: "disable",
      runtime: "trae",
      integration: "hooks",
      installed: false,
      enabled: false,
      managed: false,
      skipped: true,
      reason: "not_managed",
      traeHome: paths.traeHome,
      statePath: paths.statePath,
    };
  }
  try {
    updateManagedHooks(paths.hooksPath, undefined, false);
    const disabledState = {
      ...state,
      enabled: false,
      disabledAt: new Date().toISOString(),
    };
    delete disabledState.installPending;
    atomicWriteJson(paths.statePath, disabledState);
  } catch (error) {
    return failure("disable_failed", paths, error);
  }
  return {
    ok: true,
    action: "disable",
    runtime: "trae",
    integration: "hooks",
    installed: existsSync(state.runtimePath) && existsSync(join(state.skillPath, "SKILL.md")),
    enabled: false,
    managed: true,
    changed: state.enabled === true,
    traeHome: paths.traeHome,
    statePath: paths.statePath,
  };
}

export async function readTraeAdapterStatus(options = {}) {
  const paths = resolvePaths(options);
  return await readTraeAdapterStatusUnlocked(paths, options);
}

async function readTraeAdapterStatusUnlocked(paths, options) {
  const state = readAdapterState(paths.statePath);
  const stateProblem = validateState(state, paths);
  if (stateProblem) return { ...stateProblem, action: "status" };
  if (!state) {
    return {
      ok: true,
      action: "status",
      runtime: "trae",
      integration: "hooks",
      installed: false,
      enabled: false,
      managed: false,
      skipped: true,
      reason: "not_managed",
      traeHome: paths.traeHome,
      statePath: paths.statePath,
      traeHooks: { ok: false, configured: false, runtimeObserved: false, status: "missing" },
      traeSkills: skillSummary(paths.skillPath, false),
    };
  }
  let manifest;
  try {
    manifest = readHookManifest(paths.hooksPath);
  } catch {
    manifest = undefined;
  }
  const runtimeCurrent = existsSync(state.runtimePath)
    && state.runtimePath === join(state.runtimeRoot, state.runtimeDigest, "hooks", "runtime-hook.mjs");
  const memoraxCodeCommand = stringOption(options.memoraxCodeCommand) ?? defaultMemoraxCodeCommand();
  const skillCurrent = existsSync(join(state.skillPath, "SKILL.md"))
    && directoryDigestIfPresent(state.skillPath, SKILL_PACKAGE_METADATA) === state.skillDigest
    && skillPackageMetadataCurrent(state.skillPath, memoraxCodeCommand);
  const configured = Boolean(manifest && hooksConfigured(manifest, state.hookCommand));
  const observation = await readTraeRuntimeObservation(paths.memoraxCodeHome);
  const runtimeObserved = observation?.runtimeDigest === state.runtimeDigest
    && comparablePath(observation.traeHome, options.platform ?? process.platform)
      === comparablePath(paths.traeHome, options.platform ?? process.platform);
  const installed = runtimeCurrent && skillCurrent;
  const enabled = state.enabled === true && installed && configured;
  const installPending = state.installPending === true;
  return {
    ok: true,
    action: "status",
    runtime: "trae",
    integration: "hooks",
    installed,
    enabled,
    managed: true,
    current: installed && configured,
    changed: options.changed,
    traeHome: paths.traeHome,
    statePath: paths.statePath,
    installPath: dirname(state.runtimePath),
    skillPath: state.skillPath,
    traeHooks: {
      ok: configured,
      configured,
      runtimeObserved,
      status: configured ? (runtimeObserved ? "observed" : "unverified") : "invalid",
      observationPath: traeRuntimeObservationPath(paths.memoraxCodeHome),
    },
    traeSkills: skillSummary(state.skillPath, skillCurrent),
    globalHooksActivationRequired: configured && !runtimeObserved,
    ...(!enabled ? {
      reason: installPending
        ? "install_incomplete"
        : !installed ? "artifacts_missing" : "hooks_not_configured",
    } : {}),
  };
}

export async function removeTraeAdapterInstallation(options = {}) {
  const paths = resolvePaths(options);
  return await withTraeLifecycleLock(paths, () => removeTraeAdapterInstallationUnlocked(paths));
}

async function removeTraeAdapterInstallationUnlocked(paths) {
  const state = readAdapterState(paths.statePath);
  const stateProblem = validateState(state, paths);
  if (stateProblem) return { ...stateProblem, action: "trae-adapter-remove" };
  if (!state) {
    return {
      ok: true,
      action: "trae-adapter-remove",
      skipped: true,
      reason: "not_managed",
      removed: false,
      statePath: paths.statePath,
    };
  }
  const disabled = disableTraeAdapterUnlocked(paths);
  if (disabled.ok === false) return { ...disabled, action: "trae-adapter-remove" };
  try {
    rmSync(state.skillPath, { recursive: true, force: true });
    rmSync(traeAdapterRoot(paths.memoraxCodeHome), { recursive: true, force: true });
  } catch (error) {
    return failure("remove_failed", paths, error, "trae-adapter-remove");
  }
  return {
    ok: true,
    action: "trae-adapter-remove",
    runtime: "trae",
    integration: "hooks",
    installed: false,
    enabled: false,
    managed: false,
    removed: true,
    traeHome: paths.traeHome,
    statePath: paths.statePath,
  };
}

export function traeHookCommand(
  runtimePath,
  platform = process.platform,
  nodePath = process.execPath,
  powershellPath = defaultWindowsPowerShellPath(),
) {
  if (platform !== "win32") {
    return `${posixShellLiteral(nodePath)} ${posixShellLiteral(runtimePath)} ${HOOK_MARKER}`;
  }
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

export function defaultTraeSkillSourcePath(adapterRoot = ADAPTER_ROOT) {
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
  const traeHome = resolve(options.traeHome ?? defaultTraeHome());
  return {
    memoraxCodeHome,
    traeHome,
    lifecycleLockTarget: resolve(
      options.lifecycleLockTarget ?? join(memoraxCodeHome, "adapters", "trae-lifecycle"),
    ),
    statePath: resolve(options.statePath ?? traeAdapterStatePath(memoraxCodeHome)),
    hooksPath: resolve(options.hooksPath ?? traeHooksPath(traeHome)),
    skillPath: resolve(options.skillPath ?? traeSkillPath(traeHome)),
    runtimeRoot: resolve(options.runtimeRoot ?? traeRuntimeRoot(memoraxCodeHome)),
    runtimeHookSourcePath: resolve(options.runtimeHookSourcePath ?? join(ADAPTER_ROOT, "hooks", "runtime-hook.mjs")),
    runtimeObservationSourcePath: resolve(options.runtimeObservationSourcePath ?? join(ADAPTER_ROOT, "src", "runtime-observation.mjs")),
    commonSourcePath: resolve(options.commonSourcePath ?? join(ADAPTER_ROOT, "..", "memorax-code-adapter-common", "src")),
    skillSourcePath: resolve(options.skillSourcePath ?? defaultTraeSkillSourcePath()),
  };
}

function withTraeLifecycleLock(paths, operation) {
  return withJsonFileLockAsync(paths.lifecycleLockTarget, operation);
}

function validateState(state, paths) {
  if (!state) return undefined;
  if (state.unreadable === true) return { ok: false, reason: "state_invalid", statePath: paths.statePath };
  if (state.version !== STATE_VERSION || state.runtime !== "trae" || state.integration !== "hooks") {
    return { ok: false, reason: "state_invalid", statePath: paths.statePath };
  }
  const expected = {
    traeHome: paths.traeHome,
    hooksPath: paths.hooksPath,
    skillPath: paths.skillPath,
    runtimeRoot: paths.runtimeRoot,
  };
  if (Object.entries(expected).some(([key, value]) => state[key] !== value)
    || !containedPath(paths.memoraxCodeHome, state.runtimeRoot)
    || !containedPath(state.runtimeRoot, state.runtimePath)
    || !/^[a-f0-9]{64}$/.test(String(state.runtimeDigest ?? ""))
    || !/^[a-f0-9]{64}$/.test(String(state.skillDigest ?? ""))
    || typeof state.hookCommand !== "string"
    || !managedHookCommand(state.hookCommand)) {
    return { ok: false, reason: "state_paths_invalid", statePath: paths.statePath };
  }
  return undefined;
}

function validateSources(paths) {
  for (const [name, path] of [
    ["runtime_hook", paths.runtimeHookSourcePath],
    ["runtime_observation", paths.runtimeObservationSourcePath],
  ]) {
    if (!regularFile(path)) return { ok: false, reason: `${name}_missing`, sourcePath: path };
  }
  for (const [name, path] of [["common_runtime", paths.commonSourcePath], ["skill", paths.skillSourcePath]]) {
    if (!regularDirectory(path)) return { ok: false, reason: `${name}_missing`, sourcePath: path };
  }
  if (!regularFile(join(paths.skillSourcePath, "SKILL.md"))) {
    return { ok: false, reason: "skill_missing", sourcePath: paths.skillSourcePath };
  }
  return undefined;
}

function materializeRuntimeGeneration(paths, generationPath, runtimeDigest, options) {
  if (existsSync(generationPath)) {
    const record = readJsonFile(join(generationPath, "generation.json"));
    if (record?.unreadable || record?.value?.runtimeDigest !== runtimeDigest
      || !regularFile(join(generationPath, "hooks", "runtime-hook.mjs"))) {
      throw new Error("Trae runtime generation is invalid");
    }
    return;
  }
  mkdirSync(paths.runtimeRoot, { recursive: true, mode: 0o700 });
  const temporaryPath = join(paths.runtimeRoot, `.staging-${process.pid}-${randomUUID()}`);
  try {
    mkdirSync(join(temporaryPath, "hooks"), { recursive: true, mode: 0o700 });
    mkdirSync(join(temporaryPath, "src"), { recursive: true, mode: 0o700 });
    cpSync(paths.runtimeHookSourcePath, join(temporaryPath, "hooks", "runtime-hook.mjs"));
    cpSync(paths.runtimeObservationSourcePath, join(temporaryPath, "src", "runtime-observation.mjs"));
    cpSync(paths.commonSourcePath, join(temporaryPath, "memorax-code-adapter-common", "src"), { recursive: true });
    atomicWriteJson(join(temporaryPath, "generation.json"), { version: 1, runtimeDigest });
    const memoraxCodeCommand = stringOption(options.memoraxCodeCommand) ?? defaultMemoraxCodeCommand();
    const npmExecPath = absoluteRegularFile(options.npmExecPath ?? process.env.npm_execpath);
    atomicWriteJson(join(temporaryPath, ".memorax-code-package.json"), {
      version: 1,
      ...(memoraxCodeCommand ? { memoraxCodeCommand } : {}),
      ...(npmExecPath ? { npmExecPath } : {}),
      memoraxCodeHome: paths.memoraxCodeHome,
      traeHome: paths.traeHome,
      runtimeDigest,
    });
    renameSync(temporaryPath, generationPath);
  } catch (error) {
    rmSync(temporaryPath, { recursive: true, force: true });
    if (!existsSync(generationPath)) throw error;
  }
}

function updateManagedHooks(path, command, enabled) {
  withJsonFileLock(path, () => {
    const manifest = readHookManifest(path);
    for (const event of REQUIRED_EVENTS) {
      const existing = Array.isArray(manifest.hooks[event]) ? manifest.hooks[event] : [];
      const filtered = existing.flatMap((group) => filterManagedGroup(group));
      if (enabled) {
        filtered.push({ hooks: [{ type: "command", command, timeout: event === "SessionStart" ? 35 : 15 }] });
      }
      if (filtered.length > 0) manifest.hooks[event] = filtered;
      else delete manifest.hooks[event];
    }
    atomicWriteJson(path, manifest);
  });
}

function filterManagedGroup(group) {
  if (!isRecord(group) || !Array.isArray(group.hooks)) return [group];
  const hooks = group.hooks.filter((hook) => !isManagedHook(hook));
  return hooks.length > 0 ? [{ ...group, hooks }] : [];
}

function readHookManifest(path) {
  if (!existsSync(path)) return { hooks: {} };
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(parsed) || (parsed.hooks !== undefined && !isRecord(parsed.hooks))) {
    throw new Error(`invalid Trae Hook manifest: ${path}`);
  }
  const manifest = { ...parsed, hooks: { ...(parsed.hooks ?? {}) } };
  for (const event of REQUIRED_EVENTS) {
    if (manifest.hooks[event] !== undefined && !Array.isArray(manifest.hooks[event])) {
      throw new Error(`invalid Trae Hook event: ${event}`);
    }
  }
  return manifest;
}

function hooksConfigured(manifest, expectedCommand) {
  return REQUIRED_EVENTS.every((event) => {
    const managed = (manifest.hooks[event] ?? [])
      .flatMap((group) => Array.isArray(group?.hooks) ? group.hooks : [])
      .filter(isManagedHook);
    return managed.length === 1 && managed[0].type === "command" && managed[0].command === expectedCommand;
  });
}

function isManagedHook(hook) {
  return isRecord(hook) && hook.type === "command"
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

function materializeDirectory(source, destination, memoraxCodeCommand) {
  mkdirSync(dirname(destination), { recursive: true });
  const temporaryPath = `${destination}.tmp-${process.pid}-${randomUUID()}`;
  rmSync(temporaryPath, { recursive: true, force: true });
  try {
    cpSync(source, temporaryPath, { recursive: true });
    atomicWriteJson(
      join(temporaryPath, SKILL_PACKAGE_METADATA),
      skillPackageMetadata(memoraxCodeCommand),
    );
    rmSync(destination, { recursive: true, force: true });
    renameSync(temporaryPath, destination);
  } catch (error) {
    rmSync(temporaryPath, { recursive: true, force: true });
    throw error;
  }
}

function runtimeSourceDigest(paths) {
  const hash = createHash("sha256");
  hashFile(hash, paths.runtimeHookSourcePath, "hooks/runtime-hook.mjs");
  hashFile(hash, paths.runtimeObservationSourcePath, "src/runtime-observation.mjs");
  hashDirectory(hash, paths.commonSourcePath, "memorax-code-adapter-common/src");
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

function skillPackageMetadataCurrent(skillPath, memoraxCodeCommand) {
  try {
    return readFileSync(join(skillPath, SKILL_PACKAGE_METADATA), "utf8")
      === `${JSON.stringify(skillPackageMetadata(memoraxCodeCommand), null, 2)}\n`;
  } catch {
    return false;
  }
}

function skillPackageMetadata(memoraxCodeCommand) {
  return {
    version: 1,
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

function failure(reason, paths, error, action = "status") {
  return {
    ok: false,
    action,
    runtime: "trae",
    integration: "hooks",
    installed: false,
    enabled: false,
    managed: existsSync(paths.statePath),
    reason,
    error: error instanceof Error ? error.message : String(error),
    traeHome: paths.traeHome,
    statePath: paths.statePath,
  };
}

function conflict(reason, paths, conflictPath) {
  return { ...failure(reason, paths, new Error(`unmanaged Trae artifact exists: ${conflictPath}`), "enable"), conflictPath };
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
