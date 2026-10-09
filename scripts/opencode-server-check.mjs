#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  check, createNativeHarness, describeSafeError, fixtureModel, processAlive, stopNativeProcessTree, waitFor,
} from "./opencode-native-support.mjs";

const report = {
  status: "FAIL", suite: "native_opencode_server_lifecycle", platform: process.platform,
  model: "controlled local Chat Completions fixture", paidModelRequests: 0,
  scope: "Installed Repo Memory runner with real native server sessions, tools, and owned-server cleanup",
  excludes: ["Repo Memory artifact semantics", "desktop application UI", "compaction"],
  cases: [],
};
let harness, server, current;
let stage = "prerequisites";
const ownedChildren = [];
let ownedCleanup;

try {
  check(process.argv.length === 4, "EXPECTED_INSTALLED_PACKAGE_ROOT_AND_OPENCODE_CLI_PATH");
  harness = await createNativeHarness({ packageRoot: resolve(process.argv[2]),
    openCodeCommand: resolve(process.argv[3]), label: "server" });
  harness.setBeforeClose(closeOwnedChildren);
  const { runOpenCodeRepoMemory, OPENCODE_REPO_MEMORY_AGENT } = await import(pathToFileURL(join(harness.packageRoot,
    "lib", "memorax-code-opencode-adapter", "src", "repo-memory-server-runner.mjs")));
  stage = "installed plugin setup";
  await harness.setup();
  report.openCodeVersion = harness.openCodeVersion;
  harness.setModelHandler((body, response) => {
    check(body.model === fixtureModel, "SERVER_MODEL_SUBSTITUTION");
    if (!(body.tools?.length > 0)) return { text: "Isolated server fixture" };
    check(current && JSON.stringify(body.messages).includes(current.prompt), "SERVER_MODEL_PROMPT_MISMATCH");
    check(++current.modelRequests <= 2, "SERVER_MODEL_REQUEST_LIMIT_EXCEEDED");
    if (current.id === "native-prompt-error") {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { type: "invalid_request_error", message: "Controlled local model failure" } }));
      return;
    }
    if (current.modelRequests === 1) {
      check(body.tools.some((tool) => tool.function?.name === "write"), "SERVER_NATIVE_WRITE_TOOL_MISSING");
      return { toolCalls: [{ id: current.callId, name: "write",
        arguments: { filePath: current.markerPath, content: current.marker } }] };
    }
    check(body.messages.some((message) => message.role === "tool" && message.tool_call_id === current.callId),
      "SERVER_NATIVE_TOOL_RESULT_MISSING");
    return { text: current.finalText };
  });
  stage = "native server startup";
  server = await harness.startOpenCodeServer();
  stage = "native parent session creation";
  const parent = await server.request("/session", { method: "POST", body: { title: "Native server fixture parent" } });
  for (const id of ["server-reuse", "http-error-no-fallback", "native-prompt-error", "transport-fallback"]) {
    stage = id;
    const result = { id, status: "FAIL" };
    report.cases.push(result);
    current = { id, modelRequests: 0, requests: [], spawns: [], messages: [],
      prompt: `Run the isolated native OpenCode server fixture ${id}.`,
      markerPath: join(harness.workspace, `${id}.txt`), marker: `MEMORAX_SERVER_${id}`,
      finalText: `Native OpenCode server fixture ${id} finished.`, callId: `server-${id}` };
    const state = current;
    check(!await exists(state.markerPath), "SERVER_MARKER_EXISTS_BEFORE_EXECUTION");
    const env = { ...harness.env, MEMORAX_CODE_OPENCODE_SERVER_URL: server.url };
    if (id === "http-error-no-fallback") env.OPENCODE_SERVER_PASSWORD = "deliberately-invalid-local-fixture";
    if (id === "transport-fallback") await server.close();
    let output, failure;
    try {
      output = await runOpenCodeRepoMemory({ serverUrl: server.url, repo: harness.workspace,
        parentID: parent.id, prompt: state.prompt }, {
        env,
        spawnImpl(command, args, options) {
          // Observe the production runner's actual native child; do not substitute a fixture process.
          check(!ownedCleanup, "SERVER_CHECK_IS_CLOSING");
          const child = spawn(command, args, options);
          state.spawns.push({ child, command, args, options });
          ownedChildren.push(child);
          return child;
        },
        fetchImpl: async (url, init) => {
          const entry = { method: init.method, url: new URL(url), body: init.body ? JSON.parse(init.body) : undefined };
          state.requests.push(entry);
          let response;
          try {
            response = await fetch(url, { ...init, signal: init.signal
              ? AbortSignal.any([init.signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000) });
          } catch (error) { entry.transportFailure = true; throw error; }
          entry.status = response.status;
          if (init.method === "DELETE") await response.clone().arrayBuffer();
          if (response.ok && init.method === "POST") {
            const payload = await response.clone().json();
            if (entry.url.pathname === "/session") state.session = payload;
            else if (entry.url.pathname.endsWith("/message")) {
              state.terminal = payload;
              const messages = await fetch(url, { headers: init.headers, signal: AbortSignal.timeout(10_000) });
              check(messages.ok, "SERVER_NATIVE_MESSAGES_UNAVAILABLE");
              state.messages = await messages.json();
            }
          }
          return response;
        },
      });
    } catch (error) { failure = error; }
    if (id === "http-error-no-fallback") {
      check(failure && /session creation failed with HTTP 401/.test(failure.message), "NATIVE_HTTP_ERROR_NOT_PRESERVED");
      check(state.requests.length === 1 && state.requests[0].status === 401, "NATIVE_HTTP_ERROR_REQUEST_MISMATCH");
      check(state.spawns.length === 0 && state.modelRequests === 0, "HTTP_FAILURE_STARTED_FALLBACK_OR_MODEL");
      check(!await exists(state.markerPath), "HTTP_ERROR_PRODUCED_FILE_EFFECT");
      Object.assign(result, { status: "PASS", nativeHttpStatus: 401, fallbackServersStarted: 0, modelRequests: 0 });
      continue;
    }
    check(state.session?.parentID === parent.id, "NATIVE_BACKGROUND_SESSION_PARENT_MISMATCH");
    const promptRequest = state.requests.find((entry) => entry.method === "POST" && entry.url.pathname.endsWith("/message"));
    check(promptRequest?.body.agent === OPENCODE_REPO_MEMORY_AGENT, "MANAGED_REPO_MEMORY_AGENT_NOT_SELECTED");
    check(state.requests.some((entry) => entry.method === "DELETE" && entry.status === 200
      && entry.url.pathname === `/session/${state.session.id}`), "NATIVE_BACKGROUND_SESSION_NOT_DELETED");
    const user = state.messages.find((message) => message.info?.role === "user"
      && (message.parts ?? []).some((part) => part.type === "text" && part.text === state.prompt));
    check(user && state.terminal?.info?.sessionID === state.session.id
      && state.terminal.info.parentID === user.info.id && Number.isFinite(state.terminal.info.time?.completed),
    "SERVER_NATIVE_SDK_LINEAGE_MISMATCH");
    if (id === "native-prompt-error") {
      check(failure?.message === "OpenCode blocking prompt returned an assistant error", "NATIVE_PROMPT_ERROR_NOT_PRESERVED");
      check(typeof state.terminal.info.error?.name === "string", "NATIVE_PROMPT_ERROR_RECORD_MISSING");
      check(state.spawns.length === 0, "NATIVE_PROMPT_ERROR_STARTED_FALLBACK");
      check(!await exists(state.markerPath), "NATIVE_PROMPT_ERROR_PRODUCED_FILE_EFFECT");
      Object.assign(result, { status: "PASS", nativeAssistantErrorObserved: true, nativeSessionDeleted: true,
        fallbackServersStarted: 0, modelRequests: state.modelRequests });
      continue;
    }
    check(!failure, "NATIVE_SERVER_RUNNER_FAILED");
    check(output === state.finalText && !state.terminal.info.error, "NATIVE_SERVER_FINAL_TEXT_MISMATCH");
    check(await readFile(state.markerPath, "utf8") === state.marker, "NATIVE_SERVER_FILE_EFFECT_MISMATCH");
    const tool = state.messages.flatMap((message) => message.parts ?? [])
      .find((part) => part.type === "tool" && part.callID === state.callId && part.tool === "write");
    check(tool?.state?.status === "completed", "SERVER_NATIVE_WRITE_TOOL_NOT_COMPLETED");
    if (id === "server-reuse") {
      check(state.spawns.length === 0 && server.process.exitCode === null, "REACHABLE_SERVER_NOT_REUSED");
      const health = await fetch(`${server.url}/global/health`, { headers: server.headers, signal: AbortSignal.timeout(5000) });
      await health.arrayBuffer();
      check(health.ok, "REUSED_SERVER_WAS_STOPPED");
      const deleted = await server.request(`/session/${state.session.id}`, { raw: true });
      await deleted.arrayBuffer();
      check(deleted.status === 404, "REUSED_SERVER_SESSION_REMAINS");
    } else {
      check(state.requests[0].transportFailure === true && state.spawns.length === 1, "INITIAL_TRANSPORT_FAILURE_DID_NOT_FALL_BACK_ONCE");
      const owned = state.spawns[0];
      check(owned.command === harness.openCodeCommand
        && JSON.stringify(owned.args) === JSON.stringify(["serve", "--hostname=127.0.0.1", "--port=0"]),
      "FALLBACK_NATIVE_SERVER_COMMAND_MISMATCH");
      check(owned.options.env.OPENCODE_DB === ":memory:" && owned.options.env.OPENCODE_SERVER_USERNAME === "memorax-code"
        && /^[A-Za-z0-9_-]{32}$/.test(owned.options.env.OPENCODE_SERVER_PASSWORD), "FALLBACK_SERVER_ISOLATION_MISMATCH");
      await waitFor(() => !processAlive(owned.child.pid), "OWNED_NATIVE_SERVER_REMAINS");
      const ownedUrl = promptRequest.url.origin;
      check(ownedUrl !== server.url && new URL(ownedUrl).hostname === "127.0.0.1", "FALLBACK_DID_NOT_USE_NEW_LOOPBACK_SERVER");
      const reachable = await fetch(`${ownedUrl}/global/health`, { signal: AbortSignal.timeout(1000) })
        .then(async (response) => { await response.arrayBuffer(); return true; }, () => false);
      check(!reachable, "OWNED_NATIVE_SERVER_PORT_REMAINS_OPEN");
      Object.assign(result, { initialTransportFailureObserved: true, ownedServerStopped: true,
        ownedServerLoopbackAuthenticated: true, inMemoryDatabaseRequested: true });
    }
    Object.assign(result, { status: "PASS", fallbackServersStarted: state.spawns.length,
      nativeSessionDeleted: true, nativeSessionAndParentLineageMatched: true,
      nativeWriteToolCompleted: true, targetWritten: true, modelRequests: state.modelRequests });
  }
  check(harness.memoryRequests.length === 0, "MANAGED_BACKGROUND_SESSION_WROTE_PERSONAL_MEMORY");
  check(harness.serverErrors.length === 0, "LOCAL_RECEIVER_REPORTED_ERRORS");
  report.managedSessionsExcludedFromPersonalWriteback = true;
  report.observedModelHttpRequests = harness.modelRequests.length;
  report.status = "PASS";
} catch (error) {
  report.stage = stage;
  report.error = error.nativeCode ?? "SERVER_CHECK_FAILED_PRIVATE_OUTPUT_SUPPRESSED";
  report.errorDetails = describeSafeError(error);
  report.nativeServerInitialization = await server?.diagnostics();
  report.receiverErrors = harness?.serverErrors ?? [];
  if (current) report.activeCase = { modelRequests: current.modelRequests, nativeServersStarted: current.spawns.length,
    observedHttpStatuses: current.requests.map((entry) => entry.status ?? "transport_failure") };
} finally {
  try {
    await harness?.close();
    report.cleanup = "PASS";
  } catch (error) {
    report.status = "FAIL";
    report.cleanup = error.nativeCode ?? "FAILED_PRIVATE_OUTPUT_SUPPRESSED";
    report.cleanupErrorDetails = describeSafeError(error);
  }
}
console.log(JSON.stringify(report, null, 2));
if (report.status !== "PASS") process.exitCode = 1;

async function exists(path) {
  try { await access(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
function closeOwnedChildren() {
  return ownedCleanup ??= (async () => {
    for (const child of ownedChildren) {
      if (child.pid && processAlive(child.pid)) await stopNativeProcessTree(child, harness.env);
    }
  })();
}
