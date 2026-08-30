#!/usr/bin/env node
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readClientHookPluginRoot } from "../../memorax-code-adapter-common/src/config-utils.mjs";
import {
  runEnsureBackendHook,
  stringValue,
} from "../../memorax-code-adapter-common/src/hooks/ensure-backend-runner.mjs";

const DEBUG = process.env.MEMORAX_CODE_CLAUDE_HOOK_DEBUG === "1";

try {
  await runEnsureBackendHook({
    ensureBackendValue: process.env.MEMORAX_CODE_CLAUDE_ENSURE_BACKEND
      ?? process.env.MEMORAX_CODE_CLAUDE_HOOK_ENSURE_BACKEND,
    healthTimeoutValue: process.env.MEMORAX_CODE_CLAUDE_ENSURE_TIMEOUT_MS,
    startTimeoutValue: process.env.MEMORAX_CODE_CLAUDE_START_TIMEOUT_MS,
    memoraxCodeCommand: stringValue(process.env.MEMORAX_CODE_CLAUDE_LIFECYCLE_COMMAND)
      ?? stringValue(process.env.MEMORAX_CODE_COMMAND),
    pluginRoot: pluginRoot(),
    resolveHomes: hookHomes,
    buildStartArgs: startArgs,
    debug,
  });
} catch (error) {
  debug(error instanceof Error ? error.message : String(error));
}

process.exit(0);

function pluginRoot() {
  return stringValue(process.env.CLAUDE_PLUGIN_ROOT)
    ?? stringValue(process.env.PLUGIN_ROOT)
    ?? readClientHookPluginRoot()
    ?? dirname(dirname(fileURLToPath(import.meta.url)));
}

function hookHomes(input = {}) {
  const memoraxCodeHome = stringValue(process.env.MEMORAX_CODE_HOME) ?? join(homedir(), ".memorax-code");
  const claudeHome = stringValue(process.env.CLAUDE_CONFIG_DIR)
    ?? stringValue(input.claude_home)
    ?? stringValue(input.claudeHome)
    ?? join(homedir(), ".claude");
  return { memoraxCodeHome, claudeHome };
}

function startArgs(homes, recoveryArguments) {
  return [
    "start",
    "--home",
    homes.memoraxCodeHome,
    "--claude-home",
    homes.claudeHome,
    ...recoveryArguments,
  ];
}

function debug(message) {
  if (DEBUG) console.error(message);
}
