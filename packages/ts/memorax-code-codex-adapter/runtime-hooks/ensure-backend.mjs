#!/usr/bin/env node
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readClientHookPluginRoot } from "../../memorax-code-adapter-common/src/config-utils.mjs";
import {
  runEnsureBackendHook,
  stringValue,
} from "../../memorax-code-adapter-common/src/hooks/ensure-backend-runner.mjs";

const DEBUG = process.env.MEMORAX_CODE_CODEX_HOOK_DEBUG === "1";

try {
  await runEnsureBackendHook({
    ensureBackendValue: process.env.MEMORAX_CODE_CODEX_ENSURE_BACKEND
      ?? process.env.MEMORAX_CODE_CODEX_HOOK_ENSURE_BACKEND,
    healthTimeoutValue: process.env.MEMORAX_CODE_CODEX_ENSURE_TIMEOUT_MS,
    startTimeoutValue: process.env.MEMORAX_CODE_CODEX_START_TIMEOUT_MS,
    memoraxCodeCommand: stringValue(process.env.MEMORAX_CODE_CODEX_LIFECYCLE_COMMAND)
      ?? stringValue(process.env.MEMORAX_CODE_COMMAND),
    pluginRoot: pluginRoot(),
    resolveHomes: hookHomes,
    buildStartArgs: startArgs,
    onHealthy: async ({ homes, backendUrl }) => {
      const reconciled = await reconcileAdapter(homes, backendUrl);
      if (!reconciled.ok) {
        debug(`Codex Hook adapter reconcile failed: ${reconciled.error ?? reconciled.reason ?? "unknown error"}`);
      }
    },
    debug,
  });
} catch (error) {
  debug(error instanceof Error ? error.message : String(error));
}
process.exit(0);

async function reconcileAdapter(homes, backendUrl) {
  try {
    const config = await import(new URL("../src/config.mjs", import.meta.url).href);
    const status = config.readCodexAdapterStatus({
      codexHome: homes.codexHome,
      memoraxCodeHome: homes.memoraxCodeHome,
      backendUrl,
      codexPluginSkillsRoot: join(pluginRoot(), "skills"),
    });
    if (status.enabled === true && status.codexSkills?.ok === true) return { ok: true, skipped: true };
    const result = config.enableCodexAdapter({
      codexHome: homes.codexHome,
      memoraxCodeHome: homes.memoraxCodeHome,
      backendUrl,
      codexPluginSkillsRoot: join(pluginRoot(), "skills"),
    });
    return result?.ok === false ? result : { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function pluginRoot() {
  return stringValue(process.env.PLUGIN_ROOT)
    ?? readClientHookPluginRoot()
    ?? dirname(dirname(fileURLToPath(import.meta.url)));
}

function hookHomes(input = {}) {
  const memoraxCodeHome = stringValue(process.env.MEMORAX_CODE_HOME) ?? join(homedir(), ".memorax-code");
  const codexHome = stringValue(process.env.CODEX_HOME)
    ?? stringValue(input.codex_home)
    ?? stringValue(input.codexHome)
    ?? join(homedir(), ".codex");
  return { memoraxCodeHome, codexHome };
}

function startArgs(homes, recoveryArguments) {
  return [
    "start",
    "--home", homes.memoraxCodeHome,
    "--codex-home", homes.codexHome,
    ...recoveryArguments,
  ];
}

function debug(message) {
  if (DEBUG) console.error(message);
}
