import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve, win32 } from "node:path";

const REQUIRED_EVENTS = ["SessionStart", "Stop"];
const PORTABLE_COMMAND = 'node "${CODEBUDDY_PLUGIN_ROOT}/hooks/runtime-hook.mjs" turn';

export function codeBuddyHookCommand(pluginRoot, platform = process.platform) {
  if (platform !== "win32") return PORTABLE_COMMAND;
  // WorkBuddy may expose a POSIX-style CODEBUDDY_PLUGIN_ROOT to a native Windows
  // shell. Use the installed native path instead of relying on that variable.
  return `node "${win32.join(pluginRoot, "hooks", "runtime-hook.mjs").replaceAll("\\", "/")}" turn`;
}

export function codeBuddyUserPromptHookCommand(pluginRoot, platform = process.platform) {
  const path = platform === "win32"
    ? win32.resolve(pluginRoot, "hooks", "runtime-hook.mjs").replaceAll("\\", "/")
    : resolve(pluginRoot, "hooks", "runtime-hook.mjs");
  const quoted = platform === "win32" ? `"${path}"` : `'${path.replaceAll("'", "'\\''")}'`;
  return `node ${quoted} managed-user-prompt`;
}

export function hasManagedCodeBuddyUserPromptHook(settings) {
  return userPromptGroups(settings).some((group) => (
    Array.isArray(group?.hooks) && group.hooks.some(isManagedUserPromptHook)
  ));
}

export function updateCodeBuddyUserPromptHook(settings, command) {
  const groups = userPromptGroups(settings);
  if (settings.hooks === undefined && !command) return;
  settings.hooks ??= {};
  const filtered = groups.flatMap((group) => {
    if (!Array.isArray(group?.hooks)) return [group];
    const hooks = group.hooks.filter((hook) => !isManagedUserPromptHook(hook));
    if (hooks.length === group.hooks.length) return [group];
    return hooks.length > 0 ? [{ ...group, hooks }] : [];
  });
  if (command) filtered.push({ hooks: [{ type: "command", command, timeout: 20 }] });
  if (filtered.length > 0) settings.hooks.UserPromptSubmit = filtered;
  else delete settings.hooks.UserPromptSubmit;
}

export function codeBuddyUserPromptHookConfigured(settings, command, enabled) {
  try {
    const managed = userPromptGroups(settings)
      .flatMap((group) => Array.isArray(group?.hooks) ? group.hooks : [])
      .filter(isManagedUserPromptHook);
    return enabled
      ? managed.length === 1 && managed[0].command === command
      : managed.length === 0;
  } catch {
    return false;
  }
}

export async function materializeCodeBuddyHookManifest(pluginRoot, platform = process.platform) {
  const path = join(pluginRoot, "hooks", "hooks.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  await writeFile(path, `${JSON.stringify(configureCodeBuddyHookManifest(manifest, pluginRoot, platform), null, 2)}\n`, "utf8");
}

export function configureCodeBuddyHookManifest(manifest, pluginRoot, platform = process.platform) {
  // Global prompt Hooks load before WorkBuddy's asynchronous plugin discovery.
  // Keep only one prompt path when refreshing an existing plugin cache.
  delete manifest.hooks.UserPromptSubmit;
  const command = codeBuddyHookCommand(pluginRoot, platform);
  for (const event of REQUIRED_EVENTS) {
    const hooks = commandHooks(manifest, event);
    if (hooks.length === 0) throw new Error(`CodeBuddy Hook manifest is missing ${event}`);
    for (const hook of hooks) hook.command = command;
  }
  return manifest;
}

export async function codeBuddyHookManifestConfigured(pluginRoot, platform = process.platform) {
  try {
    await stat(join(pluginRoot, "hooks", "runtime-hook.mjs"));
    const manifest = JSON.parse(await readFile(join(pluginRoot, "hooks", "hooks.json"), "utf8"));
    const expected = codeBuddyHookCommand(pluginRoot, platform);
    return manifest.hooks?.UserPromptSubmit === undefined && REQUIRED_EVENTS.every((event) => {
      const hooks = commandHooks(manifest, event);
      return hooks.length > 0 && hooks.every((hook) => hook.command === expected);
    });
  } catch {
    return false;
  }
}

function userPromptGroups(settings) {
  if (settings.hooks === undefined) return [];
  if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) {
    throw new Error("invalid CodeBuddy global Hook settings");
  }
  const groups = settings.hooks.UserPromptSubmit;
  if (groups !== undefined && !Array.isArray(groups)) {
    throw new Error("invalid CodeBuddy UserPromptSubmit Hook settings");
  }
  return groups ?? [];
}

function isManagedUserPromptHook(hook) {
  return hook?.type === "command" && typeof hook.command === "string"
    && hook.command.replaceAll("\\", "/").includes("/memorax-code-codebuddy-adapter/hooks/runtime-hook.mjs")
    && /\smanaged-user-prompt\s*$/.test(hook.command);
}

function commandHooks(manifest, event) {
  const matchers = manifest?.hooks?.[event];
  if (!Array.isArray(matchers)) return [];
  return matchers.flatMap((matcher) => (
    Array.isArray(matcher?.hooks)
      ? matcher.hooks.filter((hook) => hook?.type === "command" && typeof hook.command === "string")
      : []
  ));
}
