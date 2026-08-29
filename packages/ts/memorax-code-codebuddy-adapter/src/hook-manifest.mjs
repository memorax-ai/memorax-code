import { readFile, stat, writeFile } from "node:fs/promises";
import { join, win32 } from "node:path";

const REQUIRED_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop"];
const PORTABLE_COMMAND = 'node "${CODEBUDDY_PLUGIN_ROOT}/hooks/runtime-hook.mjs" turn';

export function codeBuddyHookCommand(pluginRoot, platform = process.platform) {
  if (platform !== "win32") return PORTABLE_COMMAND;
  return `node "${win32.join(pluginRoot, "hooks", "runtime-hook.mjs").replaceAll("\\", "/")}" turn`;
}

export async function materializeCodeBuddyHookManifest(pluginRoot, platform = process.platform) {
  if (platform !== "win32") return;
  const path = join(pluginRoot, "hooks", "hooks.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  const command = codeBuddyHookCommand(pluginRoot, platform);
  for (const event of REQUIRED_EVENTS) {
    const hooks = commandHooks(manifest, event);
    if (hooks.length === 0) throw new Error(`CodeBuddy Hook manifest is missing ${event}`);
    for (const hook of hooks) hook.command = command;
  }
  await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

export async function codeBuddyHookManifestConfigured(pluginRoot, platform = process.platform) {
  try {
    await stat(join(pluginRoot, "hooks", "runtime-hook.mjs"));
    const manifest = JSON.parse(await readFile(join(pluginRoot, "hooks", "hooks.json"), "utf8"));
    const expected = codeBuddyHookCommand(pluginRoot, platform);
    return REQUIRED_EVENTS.every((event) => {
      const hooks = commandHooks(manifest, event);
      return hooks.length > 0 && hooks.every((hook) => hook.command === expected);
    });
  } catch {
    return false;
  }
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
