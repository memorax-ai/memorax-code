#!/usr/bin/env node
import { appendFile } from "node:fs/promises";
import { readStdinJson } from "../../memorax-code-adapter-common/src/config-utils.mjs";
import { isRepoMemoryJobWorker } from "../../memorax-code-adapter-common/src/repo-memory/repo-memory-job-context.mjs";

if (isRepoMemoryJobWorker()) process.exit(0);

try {
  const input = await readStdinJson();
  const sessionId = stringValue(input.session_id) ?? stringValue(input.sessionId);
  const envFile = stringValue(process.env.CLAUDE_ENV_FILE);
  if (sessionId && envFile) {
    // This Hook's environment cannot reach later shell commands; Claude's env
    // file carries their explicit trace-session binding across that boundary.
    await appendFile(envFile, [
      "export MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT='claude'",
      `export MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID=${shellSingleQuote(sessionId)}`,
      "",
    ].join("\n"), "utf8");
  }
} catch (error) {
  if (process.env.MEMORAX_CODE_CLAUDE_HOOK_DEBUG === "1") {
    console.error(error instanceof Error ? error.message : String(error));
  }
}

process.exit(0);

function shellSingleQuote(value) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
