#!/usr/bin/env node
import { readStdinJson } from "../../memorax-code-adapter-common/src/config-utils.mjs";
import { isRepoMemoryJobWorker } from "../../memorax-code-adapter-common/src/repo-memory/repo-memory-job-context.mjs";

if (isRepoMemoryJobWorker()) process.exit(0);

try {
  const input = await readStdinJson();
  const sessionId = stringValue(input.session_id) ?? stringValue(input.sessionId);
  if (!sessionId) process.exit(0);
  // dcode does not document a Claude-style env file that later shell commands
  // inherit. SessionStart context instead tells the model how to bind each
  // memorax-cli invocation to this native Session.
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: [
        "For every `memorax-cli` invocation in this session, explicitly set these variables in that command's environment:",
        "MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT='deepagents'",
        `MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID=${shellSingleQuote(sessionId)}`,
        "Do this for both `memorax-cli search` and `memorax-cli add`; do not reuse another session's value.",
      ].join(" "),
    },
  })}\n`);
} catch (error) {
  if (process.env.MEMORAX_CODE_DEEPAGENTS_HOOK_DEBUG === "1") {
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
