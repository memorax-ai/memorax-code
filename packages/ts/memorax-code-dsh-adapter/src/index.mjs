import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  isMemorySkillReminderDue,
  resolveMemorySkillReminderIntervalTurns,
} from "../memorax-code-adapter-common/src/hooks/memory-skill-reminder-policy.mjs";
import { scheduleMissingRepoMemoryBuild } from "../memorax-code-adapter-common/src/repo-memory/repo-memory-auto-build.mjs";
import { isRepoMemoryJobWorker } from "../memorax-code-adapter-common/src/repo-memory/repo-memory-job-context.mjs";
import backendClient from "./backend-client.mjs";
import { createDshUserMessage } from "./dsh-message.mjs";
import { loadDshPersonalContext } from "./personal-context.mjs";
import { PLUGIN_NAME, registerMemoraxCodePlugin } from "./plugin.mjs";
import { requireEnabledDshRuntime } from "./runtime-state.mjs";

export const name = PLUGIN_NAME;
export const inject = ["agents", "sessions", "sessionPersistence"];

const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function apply(ctx) {
  if (isRepoMemoryJobWorker()) return;
  const runtime = requireEnabledDshRuntime(pluginRoot);
  const runtimeEnv = {
    ...process.env,
    MEMORAX_CODE_HOME: runtime.memoraxCodeHome,
  };
  const intervalTurns = resolveMemorySkillReminderIntervalTurns({
    environmentValue: runtimeEnv.MEMORAX_CODE_MEMORY_SKILL_REMINDER_INTERVAL_TURNS,
    configText: readConfig(join(runtime.memoraxCodeHome, "config.toml")),
  });
  registerMemoraxCodePlugin(ctx, {
    assertEnabled: () => requireEnabledDshRuntime(pluginRoot),
    backendClient,
    createUserMessage: createDshUserMessage,
    intervalTurns,
    isReminderDue: isMemorySkillReminderDue,
    loadPersonalContext: (input, options) => loadDshPersonalContext(input, {
      ...options,
      env: runtimeEnv,
    }),
    scheduleRepoMemoryBuild: (repo) => scheduleMissingRepoMemoryBuild(repo, {
      pluginRoot,
      env: runtimeEnv,
      debugEnv: "MEMORAX_CODE_DSH_DEBUG",
    }),
  });
}

function readConfig(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}
