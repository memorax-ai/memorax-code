#!/usr/bin/env node
import { runCaptureCwdHook } from "../../memorax-code-adapter-common/src/hooks/capture-cwd-hook.mjs";
import { markSupplementalReminderAfterCompact } from "../../memorax-code-adapter-common/src/hooks/memory-skill-reminder-hook.mjs";
import { isRepoMemoryJobWorker } from "../../memorax-code-adapter-common/src/repo-memory/repo-memory-job-context.mjs";

if (isRepoMemoryJobWorker()) process.exit(0);

const options = {
  adapterDir: "deepagents",
  debugEnv: "MEMORAX_CODE_DEEPAGENTS_HOOK_DEBUG",
  runtime: "deepagents",
  sessionIdField: "deepAgentsSessionId",
  sessionKeyPrefix: "deepagents",
};

const input = await runCaptureCwdHook(options);
markSupplementalReminderAfterCompact(options, input);
