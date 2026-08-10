import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createBackendState } from "../dist/app/state.js";
import { retrieveAutomaticMemoryContext } from "../dist/memory/automatic-retrieval.js";
import { memoraxConfigFromEnv } from "../dist/provider/memorax/config.js";
import { createBackendServer } from "../dist/server.js";
import { listen } from "./helpers.mjs";

const TEST_WORKSPACE = process.cwd();
const TEST_MEMORAX_CODE_HOME = await mkdtemp(join(tmpdir(), "memorax-code-automatic-memory-scope-"));

function automaticMemoryRetrieval(query, options = {}) {
  const env = { MEMORAX_CODE_HOME: TEST_MEMORAX_CODE_HOME, ...(options.env ?? {}) };
  return retrieveAutomaticMemoryContext({
    ...options,
    env,
    query,
    repositoryMemory: options.repositoryMemory ?? configuredRepositoryMemory(env),
    sessionKey: options.sessionKey ?? "claude-hook-session",
  });
}

const BASE_ENV = {
  MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "true",
  MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
  MEMORAX_CODE_MEMORAX_API_KEY: "secret",
  MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
  MEMORAX_CODE_MEMORAX_STARTUP_TIMEOUT_MS: "1000",
};

test("automatic memory retrieval is disabled unless explicitly enabled", async () => {
  const { fetchImpl, requests } = memoraxFetch("Disabled retrieval should not call MemoraX.");
  const result = await automaticMemoryRetrieval("fix the benchmark issue", {
    env: {
      MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
      MEMORAX_CODE_MEMORAX_API_KEY: "secret",
      MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
    },
    fetchImpl,
  });

  assert.equal(result.retrieved, false);
  assert.equal(result.skipReason, "disabled");
  assert.equal(requests.length, 0);
});

test("automatic memory retrieval returns Hook context and emits observability", async () => {
  const { fetchImpl, requests } = memoraxFetch("Hook retrieval observability memory.");
  const events = [];
  const traceContext = {
    schemaVersion: "1",
    client: "claude",
    sessionId: "claude-hook-session",
    turnId: "claude-hook-prompt",
    transcriptPath: "/tmp/claude-transcript.jsonl",
    contextOrigin: "claude-hook-body",
    capturedAt: "2026-07-24T00:00:00.000Z",
  };
  const result = await automaticMemoryRetrieval("Find relevant memory.", {
    env: BASE_ENV,
    fetchImpl,
    memoryObservabilitySource: "claude_hook_retrieval",
    traceContext,
    memoryObservability: {
      recordEvent(event) {
        events.push(event);
      },
    },
  });

  assert.equal(result.retrieved, true);
  assert.match(result.context, /Hidden MemoraX Code external memory context/);
  assert.match(result.context, /Hook retrieval observability memory/);
  assert.equal(requests[0].body.query, "Find relevant memory.");
  assert.equal(events.length, 1);
  assert.equal(events[0].source, "claude_hook_retrieval");
  assert.equal(events[0].operation, "retrieve");
  assert.equal(events[0].ok, true);
  assert.equal(events[0].request.payload.query, "Find relevant memory.");
  assert.equal(events[0].traceContext, traceContext);
});

test("automatic memory retrieval keeps Hook output below the Claude context limit", async () => {
  const { fetchImpl } = memoraxFetch("x".repeat(20_000));
  const result = await automaticMemoryRetrieval("Retrieve bounded Hook context.", {
    env: {
      ...BASE_ENV,
      MEMORAX_CODE_MEMORAX_MAX_CONTEXT_CHARS: "200000",
      MEMORAX_CODE_MEMORAX_MAX_ITEM_CHARS: "50000",
    },
    fetchImpl,
  });

  assert.equal(result.retrieved, true);
  assert.equal(result.blockChars, 9_003);
  assert.ok(result.context.length < 10_000, `Hook context had ${result.context.length} characters`);
  assert.ok(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: result.context,
    },
  }).length < 10_000);
});

test("automatic memory retrieval skips MemoraX Code control commands", async () => {
  const { fetchImpl, requests } = memoraxFetch("Control command should not retrieve.");
  for (const query of [
    ":debug context",
    "：debug context",
    "memorax-cli search query",
    "memorax-code status",
  ]) {
    const result = await automaticMemoryRetrieval(query, { env: BASE_ENV, fetchImpl });
    assert.equal(result.retrieved, false);
    assert.equal(result.skipReason, "control_command");
  }
  assert.equal(requests.length, 0);
});

test("automatic memory retrieval fails open when MemoraX config is missing", async () => {
  const { fetchImpl, requests } = memoraxFetch("Missing config should not retrieve.");
  const result = await automaticMemoryRetrieval("fix the benchmark issue", {
    env: BASE_ENV,
    fetchImpl,
    repositoryMemory: {
      ok: false,
      reason: "config_missing",
      error: "MEMORAX_CODE_MEMORAX_API_KEY is required",
    },
  });

  assert.equal(result.retrieved, false);
  assert.equal(result.skipReason, "config_missing");
  assert.match(result.error, /MEMORAX_CODE_MEMORAX_API_KEY/);
  assert.equal(requests.length, 0);
});

test("automatic memory retrieval fails open when MemoraX retrieve times out", async () => {
  let aborted = false;
  const fetchImpl = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => {
      aborted = true;
      reject(new DOMException("The operation was aborted.", "AbortError"));
    }, { once: true });
  });

  const result = await automaticMemoryRetrieval("fix the benchmark issue", {
    env: {
      ...BASE_ENV,
      MEMORAX_CODE_MEMORAX_TIMEOUT_MS: "5000",
      MEMORAX_CODE_MEMORAX_STARTUP_TIMEOUT_MS: "100",
    },
    fetchImpl,
  });

  assert.equal(result.retrieved, false);
  assert.equal(result.skipReason, "retrieve_failed");
  assert.match(result.error, /aborted/i);
  assert.equal(aborted, true);
});

test("Claude Hook route retrieves automatic memory once", async () => {
  let memoraxBody;
  const memoraxPaths = [];
  const memorax = createServer(async (req, res) => {
    memoraxPaths.push(req.url);
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    memoraxBody = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      success: true,
      data: {
        task_id: "claude-automatic-memory-task",
        status: "completed",
        data: [{
          id: "memory-1",
          memory: "Claude Hook can recall prior context.",
          score: 0.9,
          metadata: { memory_type: "core" },
        }],
      },
    }));
  });
  const memoraxUrl = await listen(memorax);
  const sessionHome = await mkdtemp(join(tmpdir(), "memorax-code-claude-hook-memory-"));
  const restoreEnv = withEnv({
    MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "true",
    MEMORAX_CODE_MEMORAX_ENDPOINT: memoraxUrl,
    MEMORAX_CODE_MEMORAX_API_KEY: "secret",
    MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
    MEMORAX_CODE_MEMORAX_STARTUP_TIMEOUT_MS: "1000",
  });
  const state = createBackendState("127.0.0.1", {
    sessionHome,
  });
  const backend = createBackendServer(state);
  const backendUrl = await listen(backend);

  try {
    const turnStartResponse = await fetch(new URL("/memory/turn-start", backendUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        client: "claude-code",
        sessionId: "claude-automatic-memory-session",
        promptId: "claude-hook-prompt",
        transcriptPath: join(sessionHome, "claude-transcript.jsonl"),
        prompt: "Use remembered Claude context.",
        cwd: TEST_WORKSPACE,
        workspaceKind: "project",
      }),
    });
    const turnStart = await turnStartResponse.json();
    assert.equal(turnStartResponse.status, 200);
    assert.match(turnStart.additionalContext, /Claude Hook can recall prior context/);
    assert.equal(memoraxBody.query, "Use remembered Claude context.");
    assert.deepEqual(memoraxPaths, ["/v1/memories/search"]);
  } finally {
    restoreEnv();
    await new Promise((resolve) => backend.close(resolve));
    await new Promise((resolve) => memorax.close(resolve));
    await rm(sessionHome, { recursive: true, force: true });
  }
});

function memoraxFetch(memoryText) {
  const requests = [];
  return {
    requests,
    fetchImpl: async (url, init) => {
      requests.push({
        url: String(url),
        headers: init.headers,
        body: JSON.parse(init.body),
      });
      return new Response(JSON.stringify({
        success: true,
        data: {
          task_id: "task-1",
          status: "completed",
          data: [{
            id: "memory-1",
            memory: memoryText,
            score: 0.95,
            metadata: { memory_type: "core" },
          }],
        },
        meta: { request_id: "req-1" },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

function configuredRepositoryMemory(env) {
  const result = memoraxConfigFromEnv(env);
  assert.equal(result.ok, true, result.error);
  return {
    ok: true,
    memory: {
      config: result.config,
      scope: {
        schemaVersion: "workspace-memory-scope.v1",
        baseUserId: result.config.userId,
        effectiveUserId: `${result.config.userId}@test-repository`,
        repositoryKey: "workspace-directory:test-repository",
        repositorySlug: "test-repository",
        repositoryName: "Test Repository",
        identitySource: "workspace-directory",
        scopeKind: "local-directory",
        boundWorkspaceRoot: TEST_WORKSPACE,
      },
    },
  };
}

function withEnv(updates) {
  const previous = new Map(Object.keys(updates).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}
