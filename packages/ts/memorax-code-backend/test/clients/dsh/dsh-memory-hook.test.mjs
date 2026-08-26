import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createBackendState } from "../../../dist/app/state.js";
import { createBackendServer } from "../../../dist/server.js";
import { listen } from "../../support/helpers.mjs";
import { createHttpBackendClient } from "../../../../memorax-code-dsh-adapter/src/http-client.mjs";
import {
  memoraxAddFetch,
  waitFor,
  waitForFile,
  withEnv,
} from "../codex/support/memory-hook-fixtures.mjs";
import { dshTurnInterval } from "./support/dsh-session-fixtures.mjs";

const TEST_WORKSPACE = fileURLToPath(new URL("../../..", import.meta.url));
const TEST_REPO_ROOT = resolve(TEST_WORKSPACE, "../../..");

test("Backend runs DSH Search, normalized Trace, and Add from one native Turn interval", async () => {
  const sessionHome = await mkdtemp(join(tmpdir(), "memorax-code-dsh-hook-"));
  const interval = dshTurnInterval({
    sessionId: "session-dsh-http",
    cwd: TEST_WORKSPACE,
    turn: 3,
    startSeq: 40,
  });
  const requests = [];
  const fetchImpl = async (url, init) => {
    const request = { url: String(url), body: JSON.parse(init.body) };
    requests.push(request);
    const searching = request.url.endsWith("/v1/memories/search");
    return new Response(JSON.stringify(searching ? {
      success: true,
      data: {
        task_id: "dsh-search",
        status: "completed",
        data: [{
          id: "memory-1",
          memory: "Use DSH's durable Session Event Log.",
          score: 0.95,
          metadata: { memory_type: "core" },
        }],
      },
    } : {
      success: true,
      data: { task_id: "dsh-add", status: "queued" },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const restoreEnv = withEnv({
    MEMORAX_CODE_HOME: sessionHome,
    MEMORAX_CODE_CODEX_TRACE_ENABLED: "false",
    MEMORAX_CODE_CLAUDE_TRACE_ENABLED: "false",
    MEMORAX_CODE_DSH_TRACE_ENABLED: "true",
    MEMORAX_CODE_OPENCODE_TRACE_ENABLED: "false",
    MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "true",
    MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
    MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
    MEMORAX_CODE_MEMORAX_API_KEY: "secret",
    MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const state = createBackendState("127.0.0.1", {
    sessionHome,
    authToken: "backend-token",
  });
  const server = createBackendServer(state);
  const url = await listen(server);
  const backendClient = createHttpBackendClient({
    env: {},
    fetchImpl: originalFetch,
    resolveConnection: () => ({ url, token: "backend-token" }),
  });
  const turnStart = {
    version: 1,
    client: "dsh",
    sessionId: interval.sessionId,
    turn: interval.turn,
    startSeq: interval.startSeq,
    cwd: interval.cwd,
    prompt: "Implement the DSH adapter.",
  };
  try {
    const startBody = await backendClient.recordTurnStart(turnStart);
    assert.equal(startBody.ok, true);
    assert.equal(startBody.repoMemoryWorktree, TEST_REPO_ROOT);
    assert.match(startBody.additionalContext, /durable Session Event Log/);

    const mismatched = structuredClone(interval);
    mismatched.sessionHeader.cwd = resolve(TEST_WORKSPACE, "other");
    const rejectedWriteback = await backendClient.writebackTurn({
      version: 1,
      client: "dsh",
      ...mismatched,
    });
    assert.deepEqual(rejectedWriteback, {
      ok: true,
      scheduled: false,
      reason: "workspace_identity_mismatch",
    });

    const shiftedInterval = dshTurnInterval({
      sessionId: interval.sessionId,
      cwd: interval.cwd,
      turn: interval.turn,
      startSeq: interval.startSeq + 1,
    });
    const mismatchedMetadata = await backendClient.writebackTurn({
      version: 1,
      client: "dsh",
      ...shiftedInterval,
    });
    assert.deepEqual(mismatchedMetadata, {
      ok: true,
      scheduled: false,
      reason: "turn_metadata_mismatch",
    });

    const writeback = await backendClient.writebackTurn({
      version: 1,
      client: "dsh",
      ...interval,
    });
    assert.deepEqual(writeback, { ok: true, scheduled: true });
    await waitFor(() => requests.length === 2, "DSH writeback did not call MemoraX Add");
    assert.deepEqual(requests.map((request) => new URL(request.url).pathname), [
      "/v1/memories/search",
      "/v1/memories/add",
    ]);
    assert.deepEqual(requests[1].body.messages.map(({ role, content }) => ({ role, content })), [
      { role: "user", content: "Implement the DSH adapter." },
      { role: "assistant", content: "I will inspect.\n\nThe adapter is ready." },
    ]);
    assert.equal(JSON.stringify(requests[1].body).includes("recalled memory"), false);
    assert.equal(JSON.stringify(requests[1].body).includes("private tool result"), false);

    const traceEventsPath = join(
      sessionHome,
      "debug",
      "traces",
      "dsh",
      "sessions",
      interval.sessionId,
      "events.jsonl",
    );
    await waitForFile(
      traceEventsPath,
      /"type":"memory_writeback"/,
      "DSH writeback did not reach its trace",
    );
    const traceText = await readFile(traceEventsPath, "utf8");
    const traceEvents = traceText.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(traceEvents.map((event) => event.type), [
      "turn_start",
      "memory_retrieve",
      "turn_end",
      "turn_materialized",
      "memory_writeback",
    ]);
    assert.equal(traceEvents.every((event) => event.trace.client === "dsh"), true);
    assert.equal(traceEvents.every((event) => event.trace.turn_id === String(interval.turn)), true);
    assert.equal(traceEvents[0].trace.context_origin, "dsh-cordis-turn-start");
    assert.equal(traceEvents[1].source, "dsh_native_retrieval");
    assert.equal(traceEvents[1].trace.context_origin, "dsh-cordis-turn-start");
    assert.equal(traceEvents[3].trace.context_origin, "dsh-session-event-log");
    assert.equal(traceEvents[3].request.prompt, "Implement the DSH adapter.");
    assert.equal(traceEvents[3].response.assistantMessage, "I will inspect.\n\nThe adapter is ready.");
    assert.equal(traceEvents[4].source, "dsh_native_writeback");
    assert.equal(traceEvents[4].trace.context_origin, "dsh-session-event-log");
    assert.equal(traceText.includes("private tool result"), false);

    const currentTurn = JSON.parse(await readFile(join(
      sessionHome,
      "debug",
      "traces",
      "dsh",
      ".current-turn.json",
    ), "utf8"));
    assert.equal(currentTurn.turn_state, "completed");
    assert.equal(currentTurn.trace.client, "dsh");
    assert.equal(currentTurn.trace.turn_id, String(interval.turn));
  } finally {
    await server.shutdown();
    globalThis.fetch = originalFetch;
    restoreEnv();
    await rm(sessionHome, { recursive: true, force: true });
  }
});

test("Backend recovers DSH turn metadata and writeback across a restart", async () => {
  const sessionHome = await mkdtemp(join(tmpdir(), "memorax-code-dsh-recovery-"));
  const interval = dshTurnInterval({
    sessionId: "session-dsh-recovered",
    cwd: TEST_WORKSPACE,
    turn: 2,
    startSeq: 20,
  });
  const { fetchImpl, requests } = memoraxAddFetch();
  const restoreEnv = withEnv({
    MEMORAX_CODE_HOME: sessionHome,
    MEMORAX_CODE_CODEX_TRACE_ENABLED: "false",
    MEMORAX_CODE_CLAUDE_TRACE_ENABLED: "false",
    MEMORAX_CODE_DSH_TRACE_ENABLED: "true",
    MEMORAX_CODE_OPENCODE_TRACE_ENABLED: "false",
    MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
    MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
    MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
    MEMORAX_CODE_MEMORAX_API_KEY: "secret",
    MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  let firstServer;
  let secondServer;
  try {
    firstServer = createBackendServer(createBackendState("127.0.0.1", { sessionHome }));
    const firstUrl = await listen(firstServer);
    const turnStart = await originalFetch(`${firstUrl}/memory/turn-start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        client: "dsh",
        sessionId: interval.sessionId,
        turn: interval.turn,
        startSeq: interval.startSeq,
        cwd: interval.cwd,
        prompt: "Start before the Backend restarts.",
      }),
    });
    assert.equal(turnStart.status, 200);
    assert.equal((await turnStart.json()).ok, true);
    await firstServer.shutdown();

    secondServer = createBackendServer(createBackendState("127.0.0.1", { sessionHome }));
    const secondUrl = await listen(secondServer);
    const writeback = await originalFetch(`${secondUrl}/memory/writeback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, client: "dsh", ...interval }),
    });
    assert.equal(writeback.status, 200);
    assert.deepEqual(await writeback.json(), { ok: true, scheduled: true });
    await waitFor(
      () => requests.some((request) => request.url.endsWith("/v1/memories/add")),
      "recovered DSH writeback did not call MemoraX add",
    );

    const traceEventsPath = join(
      sessionHome,
      "debug",
      "traces",
      "dsh",
      "sessions",
      interval.sessionId,
      "events.jsonl",
    );
    await waitForFile(
      traceEventsPath,
      /"type":"memory_writeback"/,
      "recovered DSH writeback did not reach its trace",
    );
    const traceEvents = (await readFile(traceEventsPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(traceEvents.map((event) => event.type), [
      "turn_start",
      "turn_end",
      "turn_materialized",
      "memory_writeback",
    ]);
    assert.equal(traceEvents[0].trace.context_origin, "dsh-cordis-turn-start");
    assert.equal(traceEvents[1].trace.context_origin, "dsh-session-event-log");
    assert.equal(traceEvents[2].request.prompt, "Implement the DSH adapter.");
    const currentTurn = JSON.parse(await readFile(join(
      sessionHome,
      "debug",
      "traces",
      "dsh",
      ".current-turn.json",
    ), "utf8"));
    assert.equal(currentTurn.turn_state, "completed");
  } finally {
    await secondServer?.shutdown();
    await firstServer?.shutdown();
    globalThis.fetch = originalFetch;
    restoreEnv();
    await rm(sessionHome, { recursive: true, force: true });
  }
});

test("Backend closes an interrupted DSH Trace without requiring Turn content or scheduling Add", async () => {
  const sessionHome = await mkdtemp(join(tmpdir(), "memorax-code-dsh-interrupted-trace-"));
  const interval = dshTurnInterval({
    sessionId: "session-dsh-interrupted",
    cwd: TEST_WORKSPACE,
    turn: 4,
    startSeq: 60,
  });
  interval.events[1].data.source = { kind: "plugin", plugin: "memorax-code", form: "recall" };
  interval.events.at(-1).data.reason = { kind: "interrupted" };
  const requests = [];
  const restoreEnv = withEnv({
    MEMORAX_CODE_HOME: sessionHome,
    MEMORAX_CODE_CODEX_TRACE_ENABLED: "false",
    MEMORAX_CODE_CLAUDE_TRACE_ENABLED: "false",
    MEMORAX_CODE_DSH_TRACE_ENABLED: "true",
    MEMORAX_CODE_OPENCODE_TRACE_ENABLED: "false",
    MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
    MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
    MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
    MEMORAX_CODE_MEMORAX_API_KEY: "secret",
    MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    requests.push(args);
    throw new Error("interrupted DSH Turn must not call MemoraX");
  };
  const server = createBackendServer(createBackendState("127.0.0.1", { sessionHome }));
  const url = await listen(server);
  try {
    const turnStart = await originalFetch(`${url}/memory/turn-start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        client: "dsh",
        sessionId: interval.sessionId,
        turn: interval.turn,
        startSeq: interval.startSeq,
        cwd: interval.cwd,
        prompt: "This live prompt is not Event Log authority.",
      }),
    });
    assert.equal(turnStart.status, 200);

    const writeback = await originalFetch(`${url}/memory/writeback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, client: "dsh", ...interval }),
    });
    assert.equal(writeback.status, 200);
    assert.deepEqual(await writeback.json(), {
      ok: true,
      scheduled: false,
      reason: "turn_not_completed",
    });
    assert.equal(requests.length, 0);

    const traceEventsPath = join(
      sessionHome,
      "debug",
      "traces",
      "dsh",
      "sessions",
      interval.sessionId,
      "events.jsonl",
    );
    const traceText = await readFile(traceEventsPath, "utf8");
    const traceEvents = traceText.trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(traceEvents.map((event) => event.type), ["turn_start", "turn_end"]);
    assert.equal(traceEvents[1].outcome, "interrupted");
    assert.equal(traceEvents[1].request.native_outcome, "interrupted");
    assert.equal(traceEvents[1].trace.context_origin, "dsh-session-event-log");
    assert.equal(traceText.includes("This live prompt is not Event Log authority."), false);
    assert.equal(traceText.includes("private tool result"), false);

    const currentTurn = JSON.parse(await readFile(join(
      sessionHome,
      "debug",
      "traces",
      "dsh",
      ".current-turn.json",
    ), "utf8"));
    assert.equal(currentTurn.turn_state, "interrupted");
  } finally {
    await server.shutdown();
    globalThis.fetch = originalFetch;
    restoreEnv();
    await rm(sessionHome, { recursive: true, force: true });
  }
});
