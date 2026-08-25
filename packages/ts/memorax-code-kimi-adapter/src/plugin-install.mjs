import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  atomicWriteJson,
  atomicWriteText,
  readAdapterState,
  stringOption,
} from "../../memorax-code-adapter-common/src/config-utils.mjs";
import { ensurePrivateConfigDirectory } from "../../memorax-code-adapter-common/src/memorax-code-config-file.mjs";
import {
  adapterRuntimePath,
  adapterStatePath,
  defaultKimiHome,
  defaultMemoraxCodeHome,
  kimiConfigPath,
  kimiSkillPath,
} from "./adapter-paths.mjs";

const STATE_VERSION = 1;
const MANAGED_MARKER = "# MemoraX Code Kimi Adapter";
const EVENTS = Object.freeze([
  ["UserPromptSubmit", 25],
  ["TurnStarted", 10],
  ["SessionHeartbeat", 10],
  ["SessionEnd", 10],
  ["Interrupt", 10],
  ["PostCompact", 10],
]);
const ADAPTER_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function ensureKimiHooksInstalled(options = {}) {
  const paths = resolvePaths(options);
  const available = kimiAvailable(options.kimiCommand ?? process.env.MEMORAX_CODE_KIMI_COMMAND ?? "kimi");
  if (!available && options.allowUnavailable !== true) {
    return {
      ok: true,
      action: "kimi-hook-install",
      installed: false,
      enabled: false,
      skipped: true,
      reason: "client_not_detected",
      message: "Kimi Code runtime is not available; its managed integration was left unchanged.",
      kimiHome: paths.kimiHome,
      configPath: paths.configPath,
    };
  }
  if (!existsSync(join(paths.skillSourcePath, "SKILL.md"))) {
    return {
      ok: false,
      action: "kimi-hook-install",
      reason: "skill_source_missing",
      skillSourcePath: paths.skillSourcePath,
      statePath: paths.statePath,
    };
  }
  const previous = readAdapterState(paths.statePath);
  const skillManaged = previous?.skillPath === paths.skillPath;
  if (pathPresent(paths.skillPath) && !skillManaged) {
    return {
      ok: false,
      action: "kimi-hook-install",
      reason: "skill_conflict",
      conflictPath: paths.skillPath,
      statePath: paths.statePath,
    };
  }
  const skillSourceSha256 = directoryDigest(paths.skillSourcePath);
  const skillCurrent = skillManaged
    && safeDirectoryDigest(paths.skillPath) === skillSourceSha256;
  const runtime = materializeRuntime(paths);
  if (!skillCurrent) materializeSkill(paths.skillSourcePath, paths.skillPath);
  const command = `${shellQuote(options.nodeCommand ?? process.execPath)} ${shellQuote(join(runtime, "memorax-code-kimi-adapter", "src", "hook-runtime.mjs"))}`;
  const currentText = readConfig(paths.configPath);
  const nextText = reconcileHooks(currentText, command, true);
  if (nextText !== currentText) atomicWriteText(paths.configPath, nextText);
  const now = new Date().toISOString();
  const state = {
    version: STATE_VERSION,
    runtime: "kimi",
    integration: "hooks",
    enabled: true,
    kimiHome: paths.kimiHome,
    configPath: paths.configPath,
    runtimePath: runtime,
    hookCommand: command,
    skillPath: paths.skillPath,
    skillSourcePath: paths.skillSourcePath,
    skillSourceSha256,
    installedAt: stringOption(previous?.installedAt) ?? now,
    updatedAt: now,
  };
  atomicWriteJson(paths.statePath, state);
  return {
    ok: true,
    action: "kimi-hook-install",
    installed: true,
    enabled: true,
    managed: true,
    changed: nextText !== currentText
      || previous?.hookCommand !== command
      || previous?.enabled !== true
      || !skillCurrent,
    restartRequired: nextText !== currentText || !skillCurrent || previous?.enabled !== true,
    statePath: paths.statePath,
    configPath: paths.configPath,
    runtimePath: runtime,
    hookCommand: command,
    skillPath: paths.skillPath,
    state,
  };
}

export function readKimiHooksStatus(options = {}) {
  const paths = resolvePaths(options);
  const state = readAdapterState(paths.statePath);
  if (!state) {
    return {
      ok: true,
      action: "kimi-hook-status",
      installed: false,
      enabled: false,
      managed: false,
      skipped: true,
      reason: "not_managed",
      statePath: paths.statePath,
      configPath: paths.configPath,
    };
  }
  if (state.version !== STATE_VERSION || state.configPath !== paths.configPath) {
    return { ok: false, action: "kimi-hook-status", installed: false, enabled: false, managed: true, reason: "state_invalid", statePath: paths.statePath };
  }
  if (state.skillPath && state.skillPath !== paths.skillPath) {
    return { ok: false, action: "kimi-hook-status", installed: false, enabled: false, managed: true, reason: "state_paths_invalid", statePath: paths.statePath };
  }
  const config = readConfig(paths.configPath);
  const configured = typeof state.hookCommand === "string"
    && EVENTS.every(([event]) => config.includes(`event = "${event}"`) && config.includes(`command = "${state.hookCommand}"`));
  const skillExists = existsSync(join(paths.skillPath, "SKILL.md"));
  const sourceReady = existsSync(join(paths.skillSourcePath, "SKILL.md"));
  const sourceSha256 = sourceReady ? directoryDigest(paths.skillSourcePath) : undefined;
  const skillCurrent = skillExists
    && sourceSha256 !== undefined
    && state.skillSourceSha256 === sourceSha256
    && safeDirectoryDigest(paths.skillPath) === sourceSha256;
  const installed = existsSync(state.runtimePath) && existsSync(state.configPath) && skillExists;
  const enabled = state.enabled === true && installed && configured && skillCurrent;
  return {
    ok: true,
    action: "kimi-hook-status",
    installed,
    enabled,
    managed: true,
    configured,
    skillExists,
    skillCurrent,
    skillPath: paths.skillPath,
    statePath: paths.statePath,
    configPath: paths.configPath,
    runtimePath: state.runtimePath,
    hookCommand: state.hookCommand,
    state,
    ...(!enabled ? { reason: !installed ? "runtime_missing" : !skillCurrent ? "skill_stale" : "hooks_not_current" } : {}),
  };
}

export function disableKimiHooks(options = {}) {
  const paths = resolvePaths(options);
  const state = readAdapterState(paths.statePath);
  if (!state) return { ok: true, action: "kimi-hook-disable", skipped: true, reason: "not_managed" };
  const current = readConfig(paths.configPath);
  const next = reconcileHooks(current, state.hookCommand, false);
  if (next !== current) atomicWriteText(paths.configPath, next);
  atomicWriteJson(paths.statePath, { ...state, enabled: false, updatedAt: new Date().toISOString() });
  return { ok: true, action: "kimi-hook-disable", installed: true, enabled: false, managed: true, changed: next !== current, statePath: paths.statePath, configPath: paths.configPath };
}

export function removeKimiHooksInstallation(options = {}) {
  const paths = resolvePaths(options);
  const state = readAdapterState(paths.statePath);
  if (!state) return { ok: true, action: "kimi-hook-remove", skipped: true, reason: "not_managed", removed: false };
  if (state.configPath !== paths.configPath || state.runtimePath !== paths.runtimePath
    || (state.skillPath && state.skillPath !== paths.skillPath)) {
    return { ok: false, action: "kimi-hook-remove", reason: "state_paths_invalid", statePath: paths.statePath };
  }
  if (pathPresent(paths.skillPath)
    && (!state.skillPath || !state.skillSourceSha256
      || safeDirectoryDigest(paths.skillPath) !== state.skillSourceSha256)) {
    return {
      ok: false,
      action: "kimi-hook-remove",
      reason: "skill_not_managed",
      statePath: paths.statePath,
      skillPath: paths.skillPath,
    };
  }
  const current = readConfig(paths.configPath);
  const next = reconcileHooks(current, state.hookCommand, false);
  if (next !== current) atomicWriteText(paths.configPath, next);
  rmSync(paths.statePath, { force: true });
  rmSync(paths.skillPath, { recursive: true, force: true });
  if (state.runtimePath === paths.runtimePath) rmSync(paths.runtimePath, { recursive: true, force: true });
  return {
    ok: true,
    action: "kimi-hook-remove",
    removed: true,
    statePath: paths.statePath,
    configPath: paths.configPath,
    skillPath: paths.skillPath,
  };
}

function resolvePaths(options) {
  const kimiHome = resolve(options.kimiHome ?? defaultKimiHome());
  const memoraxCodeHome = resolve(options.memoraxCodeHome ?? defaultMemoraxCodeHome());
  const sourceRoot = resolve(options.sourceRoot ?? ADAPTER_ROOT);
  return {
    kimiHome,
    memoraxCodeHome,
    configPath: options.configPath ?? kimiConfigPath(kimiHome),
    skillPath: resolve(options.skillPath ?? kimiSkillPath(kimiHome)),
    statePath: options.statePath ?? adapterStatePath(memoraxCodeHome),
    runtimePath: options.runtimePath ?? adapterRuntimePath(memoraxCodeHome),
    sourceRoot,
    commonSourceRoot: resolve(options.commonSourceRoot ?? join(ADAPTER_ROOT, "..", "memorax-code-adapter-common")),
    skillSourcePath: resolve(options.skillSourcePath ?? defaultSkillSourcePath(sourceRoot)),
  };
}

function defaultSkillSourcePath(adapterRoot) {
  const packaged = join(adapterRoot, "skills", "memorax-code");
  return existsSync(join(packaged, "SKILL.md"))
    ? packaged
    : resolve(adapterRoot, "..", "memorax-code-codex-adapter", "skills", "memorax-code");
}

function materializeRuntime(paths) {
  ensurePrivateConfigDirectory(paths.configPath);
  mkdirSync(dirname(paths.runtimePath), { recursive: true, mode: 0o700 });
  const temporary = `${paths.runtimePath}.tmp-${process.pid}`;
  rmSync(temporary, { recursive: true, force: true });
  mkdirSync(temporary, { recursive: true, mode: 0o700 });
  mkdirSync(join(temporary, "memorax-code-kimi-adapter"), { recursive: true, mode: 0o700 });
  mkdirSync(join(temporary, "memorax-code-adapter-common"), { recursive: true, mode: 0o700 });
  cpSync(join(paths.sourceRoot, "src"), join(temporary, "memorax-code-kimi-adapter", "src"), { recursive: true });
  cpSync(join(paths.commonSourceRoot, "src"), join(temporary, "memorax-code-adapter-common", "src"), { recursive: true });
  rmSync(paths.runtimePath, { recursive: true, force: true });
  writeFileSync(join(temporary, "runtime.sha256"), runtimeDigest(temporary), { mode: 0o600 });
  requireRename(temporary, paths.runtimePath);
  return paths.runtimePath;
}

function materializeSkill(sourcePath, targetPath) {
  mkdirSync(dirname(targetPath), { recursive: true, mode: 0o700 });
  const temporary = `${targetPath}.tmp-${process.pid}`;
  rmSync(temporary, { recursive: true, force: true });
  try {
    cpSync(sourcePath, temporary, { recursive: true });
    rmSync(targetPath, { recursive: true, force: true });
    renameSync(temporary, targetPath);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function runtimeDigest(root) {
  const hash = createHash("sha256");
  for (const path of [
    join(root, "memorax-code-kimi-adapter", "src", "hook-runtime.mjs"),
    join(root, "memorax-code-kimi-adapter", "src", "prompt-correlation.mjs"),
  ]) hash.update(readFileSync(path));
  return hash.digest("hex");
}

function directoryDigest(root) {
  const hash = createHash("sha256");
  visit(root);
  return hash.digest("hex");

  function visit(directory) {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relativePath = relative(root, path);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) throw new Error(`skill tree contains a symbolic link: ${relativePath}`);
      if (metadata.isDirectory()) {
        hash.update(`d:${relativePath}\n`);
        visit(path);
      } else if (metadata.isFile()) {
        hash.update(`f:${relativePath}\n`);
        hash.update(readFileSync(path));
      } else {
        throw new Error(`skill tree contains an unsupported entry: ${relativePath}`);
      }
    }
  }
}

function safeDirectoryDigest(root) {
  try {
    return directoryDigest(root);
  } catch {
    return undefined;
  }
}

function pathPresent(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    return error?.code !== "ENOENT";
  }
}

function reconcileHooks(text, hookCommand, enabled) {
  const lines = String(text ?? "").split(/(?<=\n)/);
  const retained = [];
  for (let index = 0; index < lines.length;) {
    if (lines[index].trim() !== "[[hooks]]") {
      retained.push(lines[index++]);
      continue;
    }
    let end = index + 1;
    while (end < lines.length && lines[end].trim() !== "[[hooks]]") end += 1;
    const block = lines.slice(index, end);
    const marked = retained.at(-1)?.trim() === MANAGED_MARKER;
    if (isManagedBlock(block) || marked) {
      if (marked) retained.pop();
    } else retained.push(...block);
    index = end;
  }
  if (!enabled) return retained.join("").replace(/\n{3,}$/u, "\n\n");
  const suffix = EVENTS.map(([event, timeout]) => [
    `${MANAGED_MARKER}\n`,
    "[[hooks]]\n",
    `event = "${event}"\n`,
    `command = ${tomlString(hookCommand)}\n`,
    `timeout = ${timeout}\n`,
  ].join("")).join("");
  const base = retained.join("").replace(/\s*$/u, "");
  return `${base}\n\n${suffix}`;
}

function isManagedBlock(block) {
  const text = block.join("");
  return text.includes("memorax-code-kimi-adapter") && text.includes("hook-runtime.mjs");
}

function readConfig(path) {
  try { return readFileSync(path, "utf8"); } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

function kimiAvailable(command) {
  const result = spawnSync(command, ["--version"], { encoding: "utf8", stdio: "ignore" });
  return result.status === 0;
}

function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }
function tomlString(value) { return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`; }
function requireRename(source, target) { renameSync(source, target); }
