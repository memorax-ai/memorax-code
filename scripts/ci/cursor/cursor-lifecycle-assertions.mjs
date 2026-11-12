import { lstat, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

const events = ["sessionStart", "beforeSubmitPrompt", "preCompact", "afterAgentResponse", "stop"];
const marker = "--memorax-code-cursor-hook-v1";
const skillMetadata = ".memorax-code-package.json";

export function snapshotCursorHooks(manifest) {
  check(record(manifest) && (manifest.version === undefined || manifest.version === 1)
    && (manifest.hooks === undefined || record(manifest.hooks)), "HOOK_MANIFEST_INVALID");
  const snapshot = structuredClone(manifest);
  snapshot.version = 1;
  if (snapshot.hooks !== undefined) {
    for (const event of events) {
      if (snapshot.hooks[event] === undefined) continue;
      check(Array.isArray(snapshot.hooks[event]), "HOOK_MANIFEST_INVALID");
      snapshot.hooks[event] = snapshot.hooks[event].filter((hook) => !ownedHook(hook));
      if (!snapshot.hooks[event].length) delete snapshot.hooks[event];
    }
    if (!Object.keys(snapshot.hooks).length) delete snapshot.hooks;
  }
  return snapshot;
}

export function assertCursorHooks(manifest, expected) {
  check(isDeepStrictEqual(snapshotCursorHooks(manifest), expected), "UNRELATED_HOOKS_CHANGED");
}

export async function verifyCursorLifecycleIntegration({ packageRoot, cursorHome, stateHome, adapter }) {
  packageRoot = resolve(packageRoot); cursorHome = resolve(cursorHome); stateHome = resolve(stateHome);
  check(adapter?.ok === true && adapter.runtime === "cursor" && adapter.integration === "hooks"
    && adapter.installed === true && adapter.enabled === true && adapter.managed === true && adapter.current === true
    && adapter.cursorHooks?.ok === true && adapter.cursorHooks.configured === true
    && adapter.cursorSkills?.ok === true && adapter.cursorAgents?.ok === true, "ADAPTER_NOT_READY");
  const statePath = join(stateHome, "adapters", "cursor", "state.json");
  const hooksPath = join(cursorHome, "hooks.json"), skillPath = join(cursorHome, "skills", "memorax-code");
  const repoMemoryAgentPath = join(cursorHome, "agents", "memorax-repo-memory.md");
  const runtimeRoot = join(stateHome, "adapters", "cursor", "runtime", "generations");
  const state = await json(statePath, "STATE_INVALID");
  check(state.version === 1 && state.runtime === "cursor" && state.integration === "hooks"
    && state.enabled === true && state.installPending !== true && state.cursorHome === cursorHome
    && state.hooksPath === hooksPath && state.skillPath === skillPath && state.repoMemoryAgentPath === repoMemoryAgentPath
    && state.runtimeRoot === runtimeRoot && typeof state.runtimeDigest === "string" && /^[a-f0-9]{64}$/.test(state.runtimeDigest)
    && ownedHook({ command: state.hookCommand }), "STATE_INVALID");
  const generation = join(runtimeRoot, state.runtimeDigest);
  check(state.runtimePath === join(generation, "hooks", "runtime-hook.mjs"), "STATE_INVALID");
  check(adapter.cursorHome === cursorHome && adapter.statePath === statePath
    && adapter.installPath === dirname(state.runtimePath) && adapter.skillPath === skillPath
    && adapter.repoMemoryAgentPath === repoMemoryAgentPath && adapter.cursorSkills.path === join(skillPath, "SKILL.md")
    && adapter.cursorAgents.path === repoMemoryAgentPath, "PATH_MISMATCH");
  const manifest = await json(hooksPath, "HOOK_MANIFEST_INVALID");
  snapshotCursorHooks(manifest);
  for (const event of events) {
    const managed = (manifest.hooks?.[event] ?? []).filter(ownedHook);
    check(managed.length === 1 && managed[0].type === "command"
      && managed[0].command === state.hookCommand && managed[0].timeout === 150, "HOOKS_MISMATCH");
  }

  const source = join(packageRoot, "lib", "memorax-code-cursor-adapter");
  for (const path of ["hooks/runtime-hook.mjs", "hooks/repo-memory-job.mjs", "src/native-repo-memory.mjs",
    "src/runtime-observation.mjs", "src/native-database-path.mjs", "agents/memorax-repo-memory.md"]) {
    check((await bytes(join(generation, path))).equals(await bytes(join(source, path))), "ASSET_MISMATCH");
  }
  check(isDeepStrictEqual(await tree(join(generation, "memorax-code-adapter-common", "src")),
    await tree(join(packageRoot, "lib", "memorax-code-adapter-common", "src"))), "ASSET_MISMATCH");
  const skill = await tree(join(packageRoot, "lib", "memorax-code-codex-adapter", "skills", "memorax-code"), true);
  for (const path of [skillPath, join(generation, "skills", "memorax-code")]) {
    check(isDeepStrictEqual(await tree(path, true), skill), "ASSET_MISMATCH");
  }
  check((await bytes(repoMemoryAgentPath)).equals(await bytes(join(source, "agents", "memorax-repo-memory.md"))), "ASSET_MISMATCH");
}

export async function assertCursorLifecycleIntegrationAbsent({ cursorHome, stateHome }) {
  let hooksExist = false;
  try { await lstat(join(cursorHome, "hooks.json")); hooksExist = true; }
  catch (error) { if (error.code !== "ENOENT") check(false, "HOOK_MANIFEST_INVALID"); }
  if (hooksExist) {
    const manifest = await json(join(cursorHome, "hooks.json"), "HOOK_MANIFEST_INVALID");
    snapshotCursorHooks(manifest);
    check(events.every((event) => !(manifest.hooks?.[event] ?? []).some(ownedHook)), "INTEGRATION_REMAINS");
  }
  for (const path of [join(cursorHome, "skills", "memorax-code"), join(cursorHome, "agents", "memorax-repo-memory.md"),
    join(stateHome, "adapters", "cursor")]) {
    try { await lstat(path); }
    catch (error) { if (error.code === "ENOENT") continue; }
    check(false, "INTEGRATION_REMAINS");
  }
}

function ownedHook(hook) {
  if (!record(hook) || (hook.type !== undefined && hook.type !== "command") || typeof hook.command !== "string") return false;
  if (hook.command.includes(marker)) return true;
  const encoded = /(?:^|\s)-EncodedCommand\s+([A-Za-z0-9+/]+={0,2})\s*$/.exec(hook.command)?.[1];
  return Boolean(encoded && encoded.length % 4 === 0 && Buffer.from(encoded, "base64").toString("utf16le").includes(marker));
}
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function check(condition, suffix) {
  const testCode = `CURSOR_LIFECYCLE_${suffix}`;
  if (!condition) throw Object.assign(new Error(testCode), { testCode });
}
async function json(path, code) {
  try {
    const value = JSON.parse((await bytes(path)).toString("utf8"));
    check(record(value), code);
    return value;
  } catch { check(false, code); }
}
async function bytes(path) {
  try {
    check((await lstat(path)).isFile(), "ASSET_INVALID");
    return await readFile(path);
  } catch { check(false, "ASSET_INVALID"); }
}
async function tree(root, ignoreMetadata = false) {
  const entries = new Map();
  async function visit(path, prefix = "") {
    check((await lstat(path)).isDirectory(), "ASSET_INVALID");
    for (const name of (await readdir(path)).sort()) {
      const child = join(path, name), label = prefix + name, info = await lstat(child);
      if (info.isDirectory()) { entries.set(label + "/", null); await visit(child, label + "/"); }
      else {
        check(info.isFile(), "ASSET_INVALID");
        if (!(ignoreMetadata && label === skillMetadata)) entries.set(label, await readFile(child));
      }
    }
  }
  try { await visit(root); } catch { check(false, "ASSET_INVALID"); }
  return entries;
}
