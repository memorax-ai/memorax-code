import { isRepoMemoryJobWorker } from "../memorax-code-adapter-common/src/repo-memory/repo-memory-job-context.mjs";
import backendClient from "./backend-client.mjs";
import { createDshUserMessage } from "./dsh-message.mjs";
import { PLUGIN_NAME, registerMemoraxCodePlugin } from "./plugin.mjs";
import { registerBundledMemoraxSkill } from "./skill.mjs";

export const name = PLUGIN_NAME;
export const inject = ["agents", "sessions", "sessionPersistence", "skills"];

export function apply(ctx) {
  registerBundledMemoraxSkill(ctx);
  if (isRepoMemoryJobWorker()) return;
  registerMemoraxCodePlugin(ctx, { backendClient, createUserMessage: createDshUserMessage });
}
