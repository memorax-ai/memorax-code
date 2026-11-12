#!/usr/bin/env node
import { postBackendCommand } from "../../memorax-code-adapter-common/src/backend-command.mjs";
import { resolveBackendConnection } from "../../memorax-code-adapter-common/src/backend-connection.mjs";
import { readStdinJson } from "../../memorax-code-adapter-common/src/config-utils.mjs";
import { isRepoMemoryJobWorker } from "../../memorax-code-adapter-common/src/repo-memory/repo-memory-job-context.mjs";
import { resolveCodexWorkspaceKind } from "../src/workspace-kind.mjs";

if (isRepoMemoryJobWorker()) process.exit(0);

try {
  const input = await readStdinJson();
  const sessionId = stringValue(input.session_id) ?? stringValue(input.sessionId);
  const lastAssistantMessage = stringValue(input.last_assistant_message) ?? stringValue(input.lastAssistantMessage);
  const transcriptPath = stringValue(input.transcript_path) ?? stringValue(input.transcriptPath);
  if (!sessionId || !lastAssistantMessage) process.exit(0);

  await postBackend("/memory/writeback", {
    version: 1,
    client: "codex",
    sessionId,
    turnId: stringValue(input.turn_id) ?? stringValue(input.turnId),
    lastAssistantMessage,
    cwd: stringValue(input.cwd),
    workspaceKind: resolveCodexWorkspaceKind(input),
    transcriptPath,
  });
} catch {
  // Hooks must not block Codex turns when the local Backend is unavailable.
}

process.exit(0);

async function postBackend(path, body) {
  const connection = resolveBackendConnection();
  const timeoutMs = parsePositiveInt(process.env.MEMORAX_CODE_CODEX_MEMORY_HOOK_TIMEOUT_MS, 5000);
  await postBackendCommand({
    connection,
    path,
    body,
    timeoutMs,
  });
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
