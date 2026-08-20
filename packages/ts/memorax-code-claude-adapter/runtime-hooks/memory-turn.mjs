#!/usr/bin/env node
import { resolveBackendConnection } from "../../memorax-code-adapter-common/src/backend-connection.mjs";
import { readStdinJson } from "../../memorax-code-adapter-common/src/config-utils.mjs";
import { scheduleMissingRepoMemoryBuild } from "../../memorax-code-adapter-common/src/repo-memory/repo-memory-auto-build.mjs";
import { isRepoMemoryJobWorker } from "../../memorax-code-adapter-common/src/repo-memory/repo-memory-job-context.mjs";

const RETRIEVAL_BACKEND_TIMEOUT_MS = 12_000;
const DEFAULT_BACKEND_TIMEOUT_MS = 5_000;

if (isRepoMemoryJobWorker()) process.exit(0);

try {
  const input = await readStdinJson();
  const event = stringValue(input.hook_event_name) ?? stringValue(input.hookEventName);
  const sessionId = stringValue(input.session_id) ?? stringValue(input.sessionId);
  const promptId = stringValue(input.prompt_id) ?? stringValue(input.promptId);
  const transcriptPath = stringValue(input.transcript_path) ?? stringValue(input.transcriptPath);
  if (!sessionId || !promptId || !transcriptPath) process.exit(0);

  if (event === "UserPromptSubmit") {
    const prompt = stringValue(input.prompt);
    if (!prompt) process.exit(0);
    const response = await postMemoryService("/memory/turn-start", {
      version: 1,
      client: "claude-code",
      sessionId,
      promptId,
      transcriptPath,
      prompt,
      cwd: stringValue(input.cwd),
      workspaceKind: stringValue(input.workspace_kind) ?? stringValue(input.workspaceKind),
    });
    scheduleMissingRepoMemoryBuild(stringValue(response?.repoMemoryWorktree), {
      debugEnv: "MEMORAX_CODE_CLAUDE_HOOK_DEBUG",
      pluginRoot: process.env.CLAUDE_PLUGIN_ROOT,
    });
    const additionalContext = stringValue(response?.additionalContext);
    const systemMessage = stringValue(response?.userNotice);
    if (additionalContext || systemMessage) {
      process.stdout.write(`${JSON.stringify({
        ...(systemMessage ? { systemMessage } : {}),
        ...(additionalContext ? { hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext,
        } } : {}),
      })}\n`);
    }
  } else if (event === "Stop") {
    const lastAssistantMessage = stringValue(input.last_assistant_message) ?? stringValue(input.lastAssistantMessage);
    if (!lastAssistantMessage) process.exit(0);
    await postMemoryService("/memory/writeback", {
      version: 1,
      client: "claude-code",
      sessionId,
      promptId,
      transcriptPath,
      lastAssistantMessage,
      cwd: stringValue(input.cwd),
      workspaceKind: stringValue(input.workspace_kind) ?? stringValue(input.workspaceKind),
    });
  }
} catch (error) {
  if (process.env.MEMORAX_CODE_CLAUDE_HOOK_DEBUG === "1") {
    console.error(error instanceof Error ? error.message : String(error));
  }
}

process.exit(0);

async function postMemoryService(path, body) {
  const connection = resolveBackendConnection();
  const timeoutMs = parsePositiveInt(
    process.env.MEMORAX_CODE_CLAUDE_MEMORY_HOOK_TIMEOUT_MS,
    path === "/memory/turn-start" ? RETRIEVAL_BACKEND_TIMEOUT_MS : DEFAULT_BACKEND_TIMEOUT_MS,
  );
  const headers = { "content-type": "application/json", connection: "close" };
  if (connection.token) headers["x-memorax-code-backend-token"] = connection.token;
  const response = await fetch(new URL(path, connection.url), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) {
    await response.arrayBuffer().catch(() => undefined);
    return undefined;
  }
  return await response.json().catch(() => undefined);
}

function parsePositiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
