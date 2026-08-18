#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const commonCandidates = [
  join(MODULE_DIR, "..", "memorax-code-adapter-common", "src"),
  join(MODULE_DIR, "..", "..", "memorax-code-adapter-common", "src"),
];
const commonRoot = commonCandidates.find((candidate) => (
  existsSync(join(candidate, "config-utils.mjs"))
));
if (!commonRoot) {
  throw new Error("MemoraX Code Hermes hook cannot locate memorax-code-adapter-common/src");
}
const {
  readStdinJson,
  stringOption,
} = await import(pathToFileURL(join(commonRoot, "config-utils.mjs")).href);
const { resolveBackendConnection } = await import(
  pathToFileURL(join(commonRoot, "backend-connection.mjs")).href
);

const REQUEST_TIMEOUT_MS = 10_000;
const COMMAND_VERSION = 1;

/**
 * Dispatch one Hermes shell-hook payload to the MemoraX Code Backend.
 *
 * - ``pre_llm_call``   -> POST /memory/turn-start; stdout carries
 *   ``{"context": "..."}`` when the Backend returns additional context.
 * - ``on_session_end`` -> POST /memory/writeback; no stdout.
 *
 * Every failure fails open: the hook contributes nothing and exits 0 so a
 * Backend outage never disturbs Hermes turns.
 */
export async function runHermesHook(payload, options = {}) {
  const event = stringOption(payload?.hook_event_name);
  if (event !== "pre_llm_call" && event !== "on_session_end") return undefined;
  const extra = payload?.extra && typeof payload.extra === "object" && !Array.isArray(payload.extra)
    ? payload.extra
    : {};
  const sessionId = stringOption(payload?.session_id);
  const cwd = stringOption(payload?.cwd);
  const turnId = stringOption(extra.turn_id);
  if (!sessionId || !cwd || !turnId) return undefined;

  let connection;
  try {
    connection = resolveBackendConnection({ env: process.env });
  } catch (error) {
    options.diagnostic?.("hermes_hook.connection_unavailable", {
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }

  const body = event === "pre_llm_call"
    ? turnStartBody(sessionId, cwd, turnId, extra)
    : writebackBody(sessionId, cwd, turnId, extra);
  if (body === undefined) return undefined;

  const pathname = event === "pre_llm_call" ? "/memory/turn-start" : "/memory/writeback";
  const response = await postJson(connection, pathname, body, options);
  if (!response) return undefined;
  if (event === "pre_llm_call"
    && response.ok === true
    && typeof response.additionalContext === "string"
    && response.additionalContext.trim()) {
    return { context: response.additionalContext };
  }
  return undefined;
}

function turnStartBody(sessionId, cwd, turnId, extra) {
  const prompt = stringOption(extra.user_message);
  if (!prompt) return undefined;
  return {
    version: COMMAND_VERSION,
    client: "hermes",
    sessionId,
    cwd,
    turnId,
    prompt,
    ...(stringOption(extra.model) ? { model: stringOption(extra.model) } : {}),
    ...(stringOption(extra.platform) ? { platform: stringOption(extra.platform) } : {}),
    ...(stringOption(extra.parent_session_id)
      ? { parentSessionId: stringOption(extra.parent_session_id) }
      : {}),
  };
}

function writebackBody(sessionId, cwd, turnId, extra) {
  return {
    version: COMMAND_VERSION,
    client: "hermes",
    sessionId,
    cwd,
    turnId,
    completed: extra.completed === true,
    interrupted: extra.interrupted === true,
    failed: extra.failed === true,
    ...(stringOption(extra.turn_exit_reason)
      ? { turnExitReason: stringOption(extra.turn_exit_reason) }
      : {}),
    ...(stringOption(extra.model) ? { model: stringOption(extra.model) } : {}),
    ...(stringOption(extra.platform) ? { platform: stringOption(extra.platform) } : {}),
  };
}

async function postJson(connection, pathname, body, options) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") return undefined;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const headers = { "content-type": "application/json" };
  if (connection.token) headers.authorization = `Bearer ${connection.token}`;
  try {
    const response = await fetchImpl(`${connection.url}${pathname}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (response.status !== 200) return undefined;
    const value = await response.json();
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch (error) {
    options.diagnostic?.("hermes_hook.request_failed", {
      pathname,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}

const isMain = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (isMain) {
  try {
    const payload = await readStdinJson();
    const output = await runHermesHook(payload, {
      diagnostic(label, fields) {
        process.stderr.write(`${label} ${JSON.stringify(fields)}\n`);
      },
    });
    if (output && typeof output.context === "string") {
      process.stdout.write(`${JSON.stringify({ context: output.context })}\n`);
    }
  } catch (error) {
    process.stderr.write(`hermes_hook.failed ${error instanceof Error ? error.message : String(error)}\n`);
  }
  process.exit(0);
}

// generation bump
