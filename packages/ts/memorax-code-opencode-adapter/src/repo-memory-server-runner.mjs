#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const OPENCODE_REPO_MEMORY_AGENT = "memorax-code-repo-memory";

export async function runOpenCodeRepoMemory(input, options = {}) {
  const env = options.env ?? process.env;
  const serverUrl = stringValue(input?.serverUrl)
    ?? stringValue(env.MEMORAX_CODE_OPENCODE_SERVER_URL);
  if (!serverUrl) {
    throw new Error(
      "OpenCode repo memory runner requires --server-url or MEMORAX_CODE_OPENCODE_SERVER_URL",
    );
  }
  const repo = stringValue(input?.repo);
  if (!repo) throw new Error("OpenCode repo memory runner requires --repo");
  const prompt = stringValue(input?.prompt);
  if (!prompt) throw new Error("OpenCode repo memory runner requires --prompt");

  const baseUrl = normalizedServerUrl(serverUrl);
  const directory = resolve(repo);
  const parentID = stringValue(input?.parentID)
    ?? stringValue(env.MEMORAX_CODE_MEMORY_CLI_SESSION_ID);
  const fetchImpl = options.fetchImpl ?? fetch;
  let sessionID;
  try {
    const session = await requestJson(fetchImpl, endpoint(baseUrl, "/session", directory), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...(parentID ? { parentID } : {}),
        title: "MemoraX Code Repo Memory",
      }),
    }, "session creation");
    sessionID = stringValue(session?.id);
    if (!sessionID) throw new Error("OpenCode session creation returned no session id");

    const message = await requestJson(
      fetchImpl,
      endpoint(baseUrl, `/session/${encodeURIComponent(sessionID)}/message`, directory),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent: OPENCODE_REPO_MEMORY_AGENT,
          parts: [{ type: "text", text: prompt }],
        }),
      },
      "blocking prompt",
    );
    const finalText = messageText(message);
    if (!finalText) throw new Error("OpenCode repo memory runner received no final text");
    return finalText;
  } finally {
    if (sessionID) {
      await bestEffortDelete(
        fetchImpl,
        endpoint(baseUrl, `/session/${encodeURIComponent(sessionID)}`, directory),
      );
    }
  }
}

function parseArgs(values) {
  const result = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--server-url") result.serverUrl = requiredValue(values, ++index, value);
    else if (value === "--repo") result.repo = requiredValue(values, ++index, value);
    else if (value === "--prompt") result.prompt = requiredValue(values, ++index, value);
    else if (value === "--parent-id") result.parentID = requiredValue(values, ++index, value);
    else throw new Error(`unknown argument: ${value}`);
  }
  return result;
}

function requiredValue(values, index, option) {
  const value = values[index];
  if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
  return value;
}

function normalizedServerUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
    return url;
  } catch {
    throw new Error("OpenCode repo memory runner requires a valid HTTP server URL");
  }
}

function endpoint(baseUrl, pathname, directory) {
  const url = new URL(pathname, baseUrl);
  url.searchParams.set("directory", directory);
  return url;
}

async function requestJson(fetchImpl, url, init, operation) {
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    throw new Error(`OpenCode ${operation} request failed: ${errorMessage(error)}`);
  }
  const body = await response.text();
  if (!response.ok) {
    const detail = responseDetail(body);
    throw new Error(
      `OpenCode ${operation} failed with HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  if (!body.trim()) throw new Error(`OpenCode ${operation} returned an empty response`);
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`OpenCode ${operation} returned invalid JSON`);
  }
}

async function bestEffortDelete(fetchImpl, url) {
  try {
    await fetchImpl(url, { method: "DELETE" });
  } catch {
    // Session cleanup must not replace the prompt result or its error.
  }
}

function messageText(message) {
  const payload = message?.data ?? message;
  if (!Array.isArray(payload?.parts)) return undefined;
  return payload.parts
    .flatMap((part) => part?.type === "text" && stringValue(part.text) ? [part.text.trim()] : [])
    .join("\n\n")
    .trim() || undefined;
}

function responseDetail(body) {
  if (!body.trim()) return undefined;
  try {
    const parsed = JSON.parse(body);
    return stringValue(parsed?.data?.message)
      ?? stringValue(parsed?.message)
      ?? stringValue(parsed?.error);
  } catch {
    return body.trim().slice(0, 300);
  }
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isDirectExecution() {
  return process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isDirectExecution()) {
  try {
    const finalText = await runOpenCodeRepoMemory(parseArgs(process.argv.slice(2)));
    process.stdout.write(`${finalText}\n`);
  } catch (error) {
    process.stderr.write(`${errorMessage(error)}\n`);
    process.exitCode = 1;
  }
}
