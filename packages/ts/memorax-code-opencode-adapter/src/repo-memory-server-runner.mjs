#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const OPENCODE_REPO_MEMORY_AGENT = "memorax-code-repo-memory";

const OWNED_SERVER_USERNAME = "memorax-code";
const DEFAULT_SERVER_START_TIMEOUT_MS = 20_000;
const DEFAULT_SERVER_STOP_TIMEOUT_MS = 5_000;
const MAX_SERVER_START_OUTPUT = 8_192;

class OpenCodeTransportError extends Error {
  constructor(operation, cause) {
    super(`OpenCode ${operation} request failed: ${errorMessage(cause)}`);
    this.name = "OpenCodeTransportError";
    this.operation = operation;
    this.cause = cause;
  }
}

export async function runOpenCodeRepoMemory(input, options = {}) {
  const env = options.env ?? process.env;
  const managedServerUrl = stringValue(env.MEMORAX_CODE_OPENCODE_SERVER_URL);
  const serverUrl = stringValue(input?.serverUrl) ?? managedServerUrl;
  const repo = stringValue(input?.repo);
  if (!repo) throw new Error("OpenCode repo memory runner requires --repo");
  const prompt = stringValue(input?.prompt);
  if (!prompt) throw new Error("OpenCode repo memory runner requires --prompt");

  const directory = resolve(repo);
  const parentID = stringValue(input?.parentID)
    ?? stringValue(env.MEMORAX_CODE_MEMORY_CLI_SESSION_ID);
  const fetchImpl = options.fetchImpl ?? fetch;
  let inheritedError;
  if (serverUrl) {
    const baseUrl = normalizedServerUrl(serverUrl);
    try {
      return await runOpenCodeRepoMemorySession({
        authorization: serverAuthorization(env, baseUrl, managedServerUrl),
        baseUrl,
        directory,
        fetchImpl,
        parentID,
        prompt,
      });
    } catch (error) {
      if (!isSessionCreationTransportError(error)) throw error;
      inheritedError = error;
    }
  } else {
    inheritedError = new Error(
      "OpenCode repo memory runner requires --server-url or MEMORAX_CODE_OPENCODE_SERVER_URL",
    );
  }

  const openCodeCommand = stringValue(env.MEMORAX_CODE_OPENCODE_COMMAND);
  if (!openCodeCommand) throw inheritedError;

  let ownedServer;
  try {
    ownedServer = await startOwnedOpenCodeServer({
      command: openCodeCommand,
      directory,
      env,
      options,
    });
  } catch (error) {
    throw new Error(
      `${errorMessage(inheritedError)}; managed OpenCode server fallback failed: ${errorMessage(error)}`,
    );
  }

  try {
    return await runOpenCodeRepoMemorySession({
      authorization: ownedServer.authorization,
      baseUrl: ownedServer.baseUrl,
      directory,
      fetchImpl,
      parentID,
      prompt,
      signal: ownedServer.signal,
    });
  } finally {
    await ownedServer.close();
  }
}

async function runOpenCodeRepoMemorySession(input) {
  let sessionID;
  try {
    const session = await requestJson(input.fetchImpl, endpoint(input.baseUrl, "/session", input.directory), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(input.authorization ? { authorization: input.authorization } : {}),
      },
      body: JSON.stringify({
        ...(input.parentID ? { parentID: input.parentID } : {}),
        title: "MemoraX Code Repo Memory",
        permission: [
          { permission: "edit", pattern: "*", action: "allow" },
          { permission: "bash", pattern: "*", action: "allow" },
          { permission: "webfetch", pattern: "*", action: "allow" },
          { permission: "doom_loop", pattern: "*", action: "allow" },
          { permission: "external_directory", pattern: "*", action: "allow" },
        ],
      }),
      ...(input.signal ? { signal: input.signal } : {}),
    }, "session creation");
    sessionID = stringValue(session?.id);
    if (!sessionID) throw new Error("OpenCode session creation returned no session id");

    const message = await requestJson(
      input.fetchImpl,
      endpoint(input.baseUrl, `/session/${encodeURIComponent(sessionID)}/message`, input.directory),
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(input.authorization ? { authorization: input.authorization } : {}),
        },
        body: JSON.stringify({
          agent: OPENCODE_REPO_MEMORY_AGENT,
          parts: [{ type: "text", text: input.prompt }],
        }),
        ...(input.signal ? { signal: input.signal } : {}),
      },
      "blocking prompt",
    );
    const finalText = messageText(message);
    if (!finalText) throw new Error("OpenCode repo memory runner received no final text");
    return finalText;
  } finally {
    if (sessionID) {
      await bestEffortDelete(
        input.fetchImpl,
        endpoint(input.baseUrl, `/session/${encodeURIComponent(sessionID)}`, input.directory),
        input.authorization,
      );
    }
  }
}

async function startOwnedOpenCodeServer(input) {
  const username = OWNED_SERVER_USERNAME;
  const password = randomBytes(24).toString("base64url");
  const spawnImpl = input.options.spawnImpl ?? spawn;
  const child = spawnImpl(input.command, [
    "serve",
    "--hostname=127.0.0.1",
    "--port=0",
  ], {
    cwd: input.directory,
    env: {
      ...input.env,
      OPENCODE_SERVER_USERNAME: username,
      OPENCODE_SERVER_PASSWORD: password,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const lifecycle = ownedServerLifecycle(child);
  let closePromise;
  const close = () => {
    closePromise ??= stopOwnedServer(
      child,
      positiveInteger(input.options.serverStopTimeoutMs, DEFAULT_SERVER_STOP_TIMEOUT_MS),
    ).finally(lifecycle.dispose);
    return closePromise;
  };
  try {
    const baseUrl = await waitForOwnedServer(
      child,
      positiveInteger(input.options.serverStartTimeoutMs, DEFAULT_SERVER_START_TIMEOUT_MS),
    );
    return {
      authorization: basicAuthorization(username, password),
      baseUrl,
      close,
      signal: lifecycle.signal,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

function waitForOwnedServer(child, timeoutMs) {
  return new Promise((resolveReady, rejectReady) => {
    let output = "";
    let settled = false;
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
      child.stdout?.off("data", onOutput);
      child.stderr?.off("data", onOutput);
      child.stdout?.resume();
      child.stderr?.resume();
      if (error) rejectReady(error);
      else resolveReady(value);
    };
    const onOutput = (chunk) => {
      output = `${output}${String(chunk)}`.slice(-MAX_SERVER_START_OUTPUT);
      const match = output.match(/opencode server listening on (https?:\/\/[^\s\u001b]+)/i);
      if (!match) return;
      let url;
      try {
        url = normalizedOwnedServerUrl(match[1]);
      } catch (error) {
        finish(error);
        return;
      }
      finish(undefined, url);
    };
    const onError = (error) => finish(error);
    const onExit = (code, signal) => finish(new Error(
      `OpenCode managed server exited before readiness${code === null ? "" : ` with code ${code}`}`
      + `${signal ? ` after ${signal}` : ""}${output.trim() ? `: ${output.trim().slice(-500)}` : ""}`,
    ));
    timer = setTimeout(() => finish(new Error(
      `timed out waiting for OpenCode managed server readiness after ${timeoutMs} ms`,
    )), timeoutMs);
    child.once("error", onError);
    child.once("exit", onExit);
    child.stdout?.on("data", onOutput);
    child.stderr?.on("data", onOutput);
  });
}

function normalizedOwnedServerUrl(value) {
  const url = normalizedServerUrl(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) {
    throw new Error("OpenCode managed server did not bind to the requested loopback address");
  }
  return url;
}

function ownedServerLifecycle(child) {
  const controller = new AbortController();
  const handlers = new Map();
  const onExit = (code, signal) => {
    if (controller.signal.aborted) return;
    controller.abort(new Error(
      `OpenCode managed server exited${code === null ? "" : ` with code ${code}`}`
      + `${signal ? ` after ${signal}` : ""}`,
    ));
  };
  child.once("exit", onExit);
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      controller.abort(new Error(`OpenCode managed server interrupted by ${signal}`));
      if (!childStopped(child)) child.kill(signal);
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return {
    signal: controller.signal,
    dispose() {
      child.off("exit", onExit);
      for (const [signal, handler] of handlers) process.off(signal, handler);
    },
  };
}

async function stopOwnedServer(child, timeoutMs) {
  if (childStopped(child)) return;
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  child.kill("SIGTERM");
  if (await settlesWithin(exited, timeoutMs) || childStopped(child)) return;
  child.kill("SIGKILL");
  if (await settlesWithin(exited, timeoutMs) || childStopped(child)) return;
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref?.();
}

async function settlesWithin(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise.then(() => true, () => true),
      new Promise((resolveTimeout) => {
        timer = setTimeout(() => resolveTimeout(false), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function childStopped(child) {
  return child.exitCode !== null || child.signalCode !== null;
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

function serverAuthorization(env, targetUrl, managedServerUrl) {
  const password = rawString(env.OPENCODE_SERVER_PASSWORD);
  if (!password || !managedServerUrl) return undefined;
  let managedUrl;
  try {
    managedUrl = normalizedServerUrl(managedServerUrl);
  } catch {
    return undefined;
  }
  if (targetUrl.origin !== managedUrl.origin) return undefined;
  const username = rawString(env.OPENCODE_SERVER_USERNAME) ?? "opencode";
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

async function requestJson(fetchImpl, url, init, operation) {
  let response;
  try {
    response = await fetchImpl(url, init);
  } catch (error) {
    throw new OpenCodeTransportError(operation, error);
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

function isSessionCreationTransportError(error) {
  return error instanceof OpenCodeTransportError && error.operation === "session creation";
}

function basicAuthorization(username, password) {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function bestEffortDelete(fetchImpl, url, authorization) {
  try {
    await fetchImpl(url, {
      method: "DELETE",
      headers: authorization ? { authorization } : {},
    });
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

function rawString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
