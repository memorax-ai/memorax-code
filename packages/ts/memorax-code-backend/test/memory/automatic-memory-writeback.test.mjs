import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, test } from "node:test";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAutomaticMemoryWritebackRuntime } from "../../dist/memory/automatic-writeback.js";

const writebackHome = await mkdtemp(join(tmpdir(), "memorax-writeback-suite-"));
after(() => rm(writebackHome, { recursive: true, force: true }));

const WRITEBACK_ENV = {
  MEMORAX_CODE_HOME: writebackHome,
  MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
  MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
  MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
  MEMORAX_CODE_MEMORAX_API_KEY: "secret",
  MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
};

const REPOSITORY_SCOPE = {
  schemaVersion: "workspace-memory-scope.v1",
  baseUserId: "user-1",
  effectiveUserId: "user-1@automatic-memory-tests",
  repositoryKey: "automatic-memory-tests-key",
  repositorySlug: "automatic-memory-tests",
  repositoryName: "automatic-memory-tests",
  identitySource: "workspace-directory",
  scopeKind: "local-directory",
  boundWorkspaceRoot: "/automatic-memory-tests",
};

test("automatic memory writeback accepts and redacts a normalized completed turn", async () => {
  const requests = [];
  const runtime = createAutomaticMemoryWritebackRuntime();
  const token = ["ghp", "S".repeat(36)].join("_");
  const crossingToken = ["ghp", "C".repeat(36)].join("_");
  const password = "private-assistant-password";
  const userPrefix = `Remember the deployment token ${token}. Keep `;
  const maxMessageChars = userPrefix.length + 8;
  try {
    assert.deepEqual(runtime.enqueue({
      client: "codex",
      sessionKey: "session-automatic-normalized",
      userText: `${userPrefix}${crossingToken}${"x".repeat(1_000_001)}`,
      assistantText: `Use the credential store; password=${password}`,
      userTimestamp: 1788000000000,
      repositoryScope: REPOSITORY_SCOPE,
      env: {
        ...WRITEBACK_ENV,
        MEMORAX_CODE_MEMORY_WRITEBACK_MAX_MESSAGE_CHARS: String(maxMessageChars),
      },
      fetchImpl: memoraxFetch(requests),
      memoryObservabilitySource: "codex_hook_writeback",
    }), { accepted: true });

    await waitFor(() => requests.length === 1, "automatic writeback did not call MemoraX add");

    assert.equal(requests[0].url, "http://memorax.test/v1/memories/add");
    assert.deepEqual(requests[0].body.messages.map(({ role, content }) => ({ role, content })), [
      { role: "user", content: "Remember the deployment token [REDACTED:API_KEY]. Keep" },
      { role: "assistant", content: "Use the credential store; password=[REDACTED:CREDENTIAL]" },
    ]);
    assert.equal(JSON.stringify(requests[0]).includes(token), false);
    assert.equal(JSON.stringify(requests[0]).includes("ghp_C"), false);
    assert.equal(JSON.stringify(requests[0]).includes(password), false);
    assert.equal(requests[0].body.user_id, "user-1@automatic-memory-tests");
    assert.equal(requests[0].body.messages[0].timestamp, 1788000000000);
    assert.deepEqual(requests[0].body.metadata.memorax_code_timestamp_sources, ["native", "observed"]);
    assert.match(
      requests[0].body.metadata.idempotency_key,
      /^automatic:codex:[a-f0-9]{16}:session-automatic-normalized:/,
    );
  } finally {
    runtime.close();
  }
});

test("automatic memory writeback removes natural leading memory impact before limiting and dedupe", async () => {
  const requests = [];
  const diagnostics = [];
  const runtime = createAutomaticMemoryWritebackRuntime({
    diagnosticLogger: (message, fields) => diagnostics.push({ message, fields }),
  });
  const answer = "Ship the validated change.";
  const impact = (paragraph) => `${paragraph}\n\n${answer}`;
  const options = {
    client: "codex",
    sessionKey: "session-memory-impact",
    userText: "Implement the memory impact summary.",
    repositoryScope: REPOSITORY_SCOPE,
    env: {
      ...WRITEBACK_ENV,
      MEMORAX_CODE_MEMORY_WRITEBACK_MAX_MESSAGE_CHARS: String(answer.length + 10),
    },
    fetchImpl: memoraxFetch(requests),
  };
  try {
    assert.deepEqual(runtime.enqueue({
      ...options,
      assistantText: impact("This time, I used MemoraX Code Memory to avoid a rejected implementation path."),
    }), { accepted: true });

    await waitFor(() => requests.length === 1, "automatic writeback did not remove memory impact");

    assert.equal(requests[0].body.messages[1].content, answer);
    assert.equal(JSON.stringify(requests[0]).includes("MemoraX Code"), false);

    assert.deepEqual(runtime.enqueue({
      ...options,
      assistantText: impact("这次我参考了 MemoraX Code 的 Memory，定位了需要修改的模块。"),
    }), { accepted: true });

    assert.deepEqual(runtime.enqueue({
      ...options,
      assistantText: impact("MemoraX Code Memory helped me apply the required validation sequence."),
    }), { accepted: true });
    assert.deepEqual(runtime.enqueue({
      ...options,
      client: "claude-code",
      sessionKey: "session-memory-impact-claude",
      assistantText: impact("Memory from MemoraX Code helped me follow the requested report structure."),
    }), { accepted: true });
    await runtime.drain();

    assert.equal(requests.length, 2);
    assert.deepEqual(requests.map(({ body }) => body.messages[1].content), [answer, answer]);
    assert.equal(
      diagnostics.filter(({ message }) => message === "memory.automatic_writeback.impact_stripped").length,
      4,
    );
    assert.equal(
      diagnostics.every(({ message, fields }) => (
        message !== "memory.automatic_writeback.impact_stripped" || fields.removedParagraphs === 1
      )),
      true,
    );
  } finally {
    runtime.close();
  }
});

test("automatic memory writeback preserves first paragraphs that do not match the natural mention contract", async () => {
  const requests = [];
  const diagnostics = [];
  const runtime = createAutomaticMemoryWritebackRuntime({
    diagnosticLogger: (message, fields) => diagnostics.push({ message, fields }),
  });
  const assistantTexts = [
    "MemoraX Code provides Coding Memory for prior engineering knowledge.\n\nThis is ordinary product documentation.",
    "# This time I used MemoraX Code Memory\n\nA heading must remain part of the answer.",
    "This time, I used MemoraX Code Memory to guide the task.\nThere is no blank line before the result.",
    "Keep this result.\n\nThis time, I used MemoraX Code Memory later in the answer.",
    `I used MemoraX Code Memory to ${"x".repeat(600)}\n\nKeep an overlong first paragraph.`,
    "This time, I used MemoraX Code to guide the task.\n\nThe generic Memory label is missing.",
    "This time, I used MemoraX Code to inspect the Memory API.\n\nThe product discussion must remain intact.",
  ];
  try {
    for (const [index, assistantText] of assistantTexts.entries()) {
      assert.deepEqual(runtime.enqueue({
        client: "codex",
        sessionKey: `session-memory-impact-preserved-${index}`,
        userText: `Preserve ordinary first paragraph ${index}.`,
        assistantText,
        repositoryScope: REPOSITORY_SCOPE,
        env: WRITEBACK_ENV,
        fetchImpl: memoraxFetch(requests),
      }), { accepted: true });
    }

    await runtime.drain();

    assert.equal(requests.length, assistantTexts.length);
    assert.deepEqual(
      requests.map(({ body }) => body.messages[1].content).sort(),
      assistantTexts.toSorted(),
    );
    assert.equal(
      diagnostics.some(({ message }) => message === "memory.automatic_writeback.impact_stripped"),
      false,
    );
  } finally {
    runtime.close();
  }
});

test("automatic memory writeback removes natural memory impact for every supported client", async () => {
  const requests = [];
  const diagnostics = [];
  const runtime = createAutomaticMemoryWritebackRuntime({
    diagnosticLogger: (message, fields) => diagnostics.push({ message, fields }),
  });
  const answer = "Client-independent output.";
  const assistantText = [
    "I used MemoraX Code Memory to guide the implementation.",
    "",
    answer,
  ].join("\n");
  const clients = ["codex", "claude-code", "dsh", "opencode", "codebuddy", "workbuddy", "trae"];
  try {
    for (const client of clients) {
      assert.deepEqual(runtime.enqueue({
        client,
        sessionKey: `session-memory-impact-${client}`,
        userText: `Apply useful memory in ${client}.`,
        assistantText,
        repositoryScope: REPOSITORY_SCOPE,
        env: WRITEBACK_ENV,
        fetchImpl: memoraxFetch(requests),
      }), { accepted: true });
    }

    await runtime.drain();

    assert.equal(requests.length, clients.length);
    assert.deepEqual(requests.map(({ body }) => body.messages[1].content), clients.map(() => answer));
    assert.equal(
      diagnostics.filter(({ message }) => message === "memory.automatic_writeback.impact_stripped").length,
      clients.length,
    );
  } finally {
    runtime.close();
  }
});

test("automatic memory writeback reports synchronous rejection without taking ownership", () => {
  const runtime = createAutomaticMemoryWritebackRuntime();
  try {
    assert.deepEqual(runtime.enqueue({
      client: "codex",
      sessionKey: "session-automatic-disabled",
      userText: "Keep this turn available for a later retry.",
      assistantText: "Disabled writeback must not consume turn metadata.",
      repositoryScope: REPOSITORY_SCOPE,
      env: {
        ...WRITEBACK_ENV,
        MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "false",
      },
    }), { accepted: false, reason: "disabled" });

    runtime.drain();
    assert.deepEqual(runtime.enqueue({
      client: "codex",
      sessionKey: "session-automatic-closed",
      userText: "Do not accept work after drain begins.",
      assistantText: "The caller must retain this turn metadata.",
      repositoryScope: REPOSITORY_SCOPE,
      env: WRITEBACK_ENV,
    }), { accepted: false, reason: "runtime_closed" });
  } finally {
    runtime.close();
  }
});

test("automatic memory runtimes own dedupe state independently", async () => {
  const requests = [];
  const first = createAutomaticMemoryWritebackRuntime();
  const second = createAutomaticMemoryWritebackRuntime();
  const options = {
    client: "codex",
    sessionKey: "session-runtime-dedupe",
    userText: "Remember one runtime-scoped turn.",
    assistantText: "This turn should be sent once per runtime.",
    repositoryScope: REPOSITORY_SCOPE,
    env: WRITEBACK_ENV,
    fetchImpl: memoraxFetch(requests),
  };
  try {
    first.enqueue(options);
    first.enqueue(options);
    second.enqueue(options);
    await waitFor(() => requests.length === 2, "runtime-scoped dedupe did not settle");
    assert.equal(requests.length, 2);
  } finally {
    first.close();
    second.close();
  }
});

test("automatic memory writeback namespaces single-turn dedupe by client", async () => {
  const requests = [];
  const runtime = createAutomaticMemoryWritebackRuntime();
  const options = {
    sessionKey: "shared-client-session",
    userText: "Remember the same client-neutral prompt.",
    assistantText: "Store the same client-neutral answer.",
    repositoryScope: REPOSITORY_SCOPE,
    env: WRITEBACK_ENV,
    fetchImpl: memoraxFetch(requests),
  };
  try {
    runtime.enqueue({ ...options, client: "codex" });
    runtime.enqueue({ ...options, client: "claude-code" });

    await waitFor(() => requests.length === 2, "client-scoped automatic writebacks did not settle");

    const idempotencyKeys = requests.map((request) => request.body.metadata.idempotency_key);
    assert.notEqual(idempotencyKeys[0], idempotencyKeys[1]);
    assert.equal(idempotencyKeys.some((key) => key.startsWith("automatic:codex:")), true);
    assert.equal(idempotencyKeys.some((key) => key.startsWith("automatic:claude-code:")), true);
    assert.deepEqual(
      requests.map((request) => request.body.session_id),
      ["shared-client-session", "shared-client-session"],
    );
  } finally {
    runtime.close();
  }
});

test("automatic memory writeback retries a retryable provider failure", async (t) => {
  for (const [name, firstResponse] of [
    ["HTTP 503", () => new Response("", { status: 503, headers: { "retry-after": "0" } })],
    ["response body transport failure", () => new Response(new ReadableStream({
      pull(controller) { controller.error(new TypeError("response body interrupted")); },
    }))],
    ["response body abort", () => new Response(new ReadableStream({
      pull(controller) { controller.error(new DOMException("response body aborted", "AbortError")); },
    }))],
  ]) {
    await t.test(name, async (t) => {
      const home = await mkdtemp(join(tmpdir(), "memorax-writeback-retry-diagnostics-"));
      t.after(() => rm(home, { recursive: true, force: true }));
      const requests = [];
      const events = [];
      const runtime = createAutomaticMemoryWritebackRuntime({ memoraxCodeHome: home });
      const fetchImpl = async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(init.body) });
        return requests.length === 1
          ? firstResponse()
          : memoraxSuccessResponse("automatic-memory-retry");
      };
      try {
        runtime.enqueue({
          client: "claude-code",
          sessionKey: "session-automatic-retry",
          userText: "Retry this automatic turn.",
          assistantText: "The retry succeeded.",
          repositoryScope: REPOSITORY_SCOPE,
          env: WRITEBACK_ENV,
          fetchImpl,
          memoryObservability: { recordEvent: (event) => events.push(event) },
          memoryObservabilitySource: "claude_hook_writeback",
        });

        await waitFor(() => events.length >= 1, "first provider response did not settle");
        assert.equal(events[0].ok, false);
        await waitFor(() => requests.length === 2 && events.length === 2, "automatic writeback retry did not settle");
        await runtime.drain();
        assert.deepEqual(await readDiagnostics(home), [], "a successful retry is not a default failure");
        assert.deepEqual(events.map((event) => event.ok), [false, true]);
        assert.deepEqual(events.map((event) => event.request.attempt), [1, 2]);
        assert.equal(events.every((event) => event.source === "claude_hook_writeback"), true);
        assert.equal(requests[0].body.metadata.idempotency_key, requests[1].body.metadata.idempotency_key);
        assert.deepEqual(requests[0].body, requests[1].body, "retries must not restamp fallback observations");
        assert.deepEqual(requests[0].body.metadata.memorax_code_timestamp_sources, ["observed", "observed"]);
      } finally {
        runtime.close();
      }
    });
  }
});

for (const { name, status, attempts, buffered } of [
  { name: "non-retryable failure", status: 400, attempts: 1, buffered: false },
  { name: "buffered retry exhaustion", status: 503, attempts: 2, buffered: true },
]) {
  test(`automatic memory writeback permits the same turn after ${name}`, { timeout: 2000 }, async () => {
    const requests = [];
    const outcomes = [];
    let finishFailure;
    const failureSettled = new Promise((resolve) => {
      finishFailure = resolve;
    });
    let failRequests = true;
    const runtime = createAutomaticMemoryWritebackRuntime({
      diagnosticLogger(message, fields) {
        if (message !== "memory.automatic_writeback" || typeof fields.accepted !== "boolean") return;
        outcomes.push(fields);
        if (!fields.accepted && !fields.retrying) finishFailure();
      },
    });
    const options = {
      client: "codex",
      sessionKey: `session-failed-replay-${status}`,
      userText: "Retry the same completed turn after the failed dispatch settles.",
      assistantText: "Preserve this turn until MemoraX accepts it.",
      repositoryScope: REPOSITORY_SCOPE,
      env: {
        ...WRITEBACK_ENV,
        MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: String(buffered),
        MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_TURNS: "1",
      },
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(init.body) });
        return failRequests
          ? new Response("", { status, headers: { "retry-after": "0" } })
          : memoraxSuccessResponse("failed-turn-replay");
      },
    };
    try {
      assert.deepEqual(runtime.enqueue(options), { accepted: true });
      await failureSettled;
      assert.equal(requests.length, attempts);
      assert.deepEqual(outcomes.map(({ accepted, attempt, retrying, httpStatus }) => ({
        accepted, attempt, retrying, httpStatus,
      })), Array.from({ length: attempts }, (_, index) => ({
        accepted: false,
        attempt: index + 1,
        retrying: index + 1 < attempts,
        httpStatus: status,
      })));

      failRequests = false;
      assert.deepEqual(runtime.enqueue(options), { accepted: true });
      await runtime.drain();

      assert.equal(requests.length, attempts + 1, "failed turn reservations must permit a new dispatch");
      assert.equal(outcomes.length, attempts + 1);
      assert.equal(outcomes.at(-1).accepted, true);
      assert.equal(outcomes.at(-1).attempt, 1);
      assert.equal(outcomes.at(-1).retrying, false);
      assert.equal(new Set(requests.map(({ body }) => body.metadata.idempotency_key)).size, 1);
      assert.deepEqual(requests.at(-1).body.messages.map(({ content }) => content), [
        options.userText,
        options.assistantText,
      ]);
    } finally {
      runtime.close();
    }
  });
}

test("automatic memory writeback buffers normalized turns until the turn limit", async () => {
  const requests = [];
  const runtime = createAutomaticMemoryWritebackRuntime();
  const env = {
    ...WRITEBACK_ENV,
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "true",
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_TURNS: "2",
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_AGE_MS: "60000",
  };
  try {
    for (const [userText, assistantText, userTimestamp, assistantTimestamp] of [
      ["First buffered prompt.", "First buffered answer.", 1788000000000, 1788000300000],
      ["Second buffered prompt.", "Second buffered answer.", 1788000900000, 1788001200000],
    ]) {
      runtime.enqueue({
        client: "codex",
        sessionKey: "session-automatic-buffer",
        userText,
        assistantText,
        userTimestamp,
        assistantTimestamp,
        repositoryScope: REPOSITORY_SCOPE,
        env,
        fetchImpl: memoraxFetch(requests),
      });
    }

    await waitFor(() => requests.length === 1, "automatic writeback buffer did not flush");
    assert.deepEqual(requests[0].body.messages.map((message) => message.content), [
      "First buffered prompt.",
      "First buffered answer.",
      "Second buffered prompt.",
      "Second buffered answer.",
    ]);
    assert.deepEqual(requests[0].body.messages.map((message) => message.timestamp), [
      1788000000000, 1788000300000, 1788000900000, 1788001200000,
    ]);
    assert.deepEqual(requests[0].body.metadata.memorax_code_timestamp_sources, ["native", "native", "native", "native"]);
  } finally {
    runtime.close();
  }
});

test("automatic memory writeback never merges clients with the same repository and session", async () => {
  const requests = [];
  const runtime = createAutomaticMemoryWritebackRuntime();
  const env = {
    ...WRITEBACK_ENV,
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "true",
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_TURNS: "2",
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_AGE_MS: "60000",
  };
  const enqueue = (client, suffix) => runtime.enqueue({
    client,
    sessionKey: "shared-buffer-session",
    userText: `${client} prompt ${suffix}.`,
    assistantText: `${client} answer ${suffix}.`,
    repositoryScope: REPOSITORY_SCOPE,
    env,
    fetchImpl: memoraxFetch(requests),
  });
  try {
    enqueue("codebuddy", "one");
    enqueue("workbuddy", "one");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(requests.length, 0);

    enqueue("codebuddy", "two");
    enqueue("workbuddy", "two");
    await waitFor(() => requests.length === 2, "client-scoped writeback buffers did not flush");

    assert.deepEqual(requests.map((request) => request.body.messages.map((message) => message.content)), [
      ["codebuddy prompt one.", "codebuddy answer one.", "codebuddy prompt two.", "codebuddy answer two."],
      [
        "workbuddy prompt one.",
        "workbuddy answer one.",
        "workbuddy prompt two.",
        "workbuddy answer two.",
      ],
    ]);
    assert.notEqual(
      requests[0].body.metadata.idempotency_key,
      requests[1].body.metadata.idempotency_key,
    );
    assert.deepEqual(
      requests.map((request) => request.body.session_id),
      ["shared-buffer-session", "shared-buffer-session"],
    );
  } finally {
    runtime.close();
  }
});

test("automatic memory writeback validates a normalized long decimal before chunking", async () => {
  const requests = [];
  const runtime = createAutomaticMemoryWritebackRuntime();
  try {
    runtime.enqueue({
      client: "codex",
      sessionKey: "session-automatic-chunk",
      userText: "Summarize",
      assistantText: "123456789.6059746146202087",
      userTimestamp: 1788000300000,
      assistantTimestamp: 1788000300000,
      repositoryScope: REPOSITORY_SCOPE,
      env: {
        ...WRITEBACK_ENV,
        MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "true",
        MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_TURNS: "1",
        MEMORAX_CODE_MEMORY_WRITEBACK_CHUNK_MAX_CHARS: "10",
        MEMORAX_CODE_MEMORY_WRITEBACK_CHUNK_OVERLAP_RATIO: "0.2",
      },
      fetchImpl: memoraxFetch(requests),
    });

    await waitFor(() => requests.length === 3, "automatic writeback chunks were not sent");
    assert.deepEqual(requests.map((request) => request.body.chunk.index), [0, 1, 2]);
    assert.deepEqual(requests.map((request) => request.body.chunk.count), [3, 3, 3]);
    assert.deepEqual(requests.map((request) => request.body.messages.map((message) => message.content)), [
      ["Summarize", "123456789."],
      ["9.60597461"],
      ["6146202087"],
    ]);
    assert.deepEqual(requests.map((request) => request.body.messages.map((message) => message.timestamp)), [
      [1788000300000, 1788000300000], [1788000300000], [1788000300000],
    ]);
    assert.deepEqual(requests.map((request) => request.body.metadata.memorax_code_timestamp_sources), [
      ["native", "native"], ["native"], ["native"],
    ]);
  } finally {
    runtime.close();
  }
});

test("automatic memory writeback preserves fragment whitespace and timing through buffering and retry", async () => {
  const requests = [];
  const runtime = createAutomaticMemoryWritebackRuntime();
  const texts = {
    user: ["User prefix  \r\n ", " \t \n".repeat(4), "  user suffix."].join(""),
    assistant: ["Assistant text \n", "\t \r\n".repeat(4), " final answer."].join(""),
  };
  const timestamp = 1788000400000;
  try {
    assert.deepEqual(runtime.enqueue({
      client: "codex",
      sessionKey: "session-fragment-whitespace",
      userText: ` \t${texts.user}\n `,
      assistantText: `\n${texts.assistant}\t `,
      userTimestamp: timestamp,
      assistantTimestamp: timestamp,
      assistantTimestampSource: "observed",
      repositoryScope: REPOSITORY_SCOPE,
      env: {
        ...WRITEBACK_ENV,
        MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "true",
        MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_TURNS: "1",
        MEMORAX_CODE_MEMORY_WRITEBACK_CHUNK_MAX_CHARS: "16",
        MEMORAX_CODE_MEMORY_WRITEBACK_CHUNK_OVERLAP_RATIO: "0",
      },
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(init.body) });
        return requests.length === 1
          ? new Response("", { status: 503, headers: { "retry-after": "0" } })
          : memoraxSuccessResponse("fragment-whitespace");
      },
    }), { accepted: true });
    await runtime.drain();

    assert.equal(requests.length, 6, "five logical parts plus one failed attempt must be sent");
    assert.deepEqual(requests[0].body, requests[1].body);
    const parts = requests.slice(1).map((request) => request.body);
    assert.deepEqual(parts.map((part) => part.chunk.index), [0, 1, 2, 3, 4]);
    assert.equal(parts.every((part) => part.chunk.count === 5), true);
    for (const role of ["user", "assistant"]) {
      const messages = parts.flatMap((part) => part.messages).filter((message) => message.role === role);
      assert.equal(messages.map((message) => message.content).join(""), texts[role]);
      assert.equal(messages.some((message) => message.content.length > 0 && !message.content.trim()), true);
    }
    for (const part of parts) {
      assert.equal(part.messages.every((message) => message.content.length <= 16 && message.timestamp === timestamp), true);
      assert.deepEqual(part.metadata.memorax_code_timestamp_sources, part.messages.map((message) => (
        message.role === "user" ? "native" : "observed"
      )));
    }
  } finally {
    runtime.close();
  }
});

test("automatic memory writeback deduplicates a successful replay within one runtime", async () => {
  const requests = [];
  const runtime = createAutomaticMemoryWritebackRuntime();
  const options = {
    client: "codex",
    sessionKey: "session-automatic-replay",
    userText: "Remember one replay-sensitive turn.",
    assistantText: "Store it only once.",
    repositoryScope: REPOSITORY_SCOPE,
    env: WRITEBACK_ENV,
    fetchImpl: memoraxFetch(requests),
  };
  try {
    assert.deepEqual(runtime.enqueue(options), { accepted: true });
    await waitFor(() => requests.length === 1, "first automatic writeback was not sent");
    assert.deepEqual(runtime.enqueue(options), { accepted: true });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(requests.length, 1);
  } finally {
    runtime.close();
  }
});

test("draining an automatic memory runtime flushes buffered turns and waits for provider settlement", async (t) => {
  const requests = [];
  let notifyFetchStarted;
  let resolveFetch;
  const fetchStarted = new Promise((resolve) => {
    notifyFetchStarted = resolve;
  });
  const runtime = createAutomaticMemoryWritebackRuntime();
  t.after(() => {
    resolveFetch?.(memoraxSuccessResponse("automatic-memory-drain-cleanup"));
    runtime.close();
  });
  runtime.enqueue({
    client: "codex",
    sessionKey: "session-runtime-drain",
    userText: "Flush this buffered turn during shutdown.",
    assistantText: "The drain must wait until MemoraX settles.",
    repositoryScope: REPOSITORY_SCOPE,
    env: {
      ...WRITEBACK_ENV,
      MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "true",
      MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_TURNS: "8",
      MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_AGE_MS: "60000",
    },
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      notifyFetchStarted();
      return await new Promise((resolve) => {
        resolveFetch = resolve;
      });
    },
  });

  const draining = runtime.drain();
  await fetchStarted;
  let settled = false;
  void draining.then(() => {
    settled = true;
  });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].body.messages.map((message) => message.content), [
    "Flush this buffered turn during shutdown.",
    "The drain must wait until MemoraX settles.",
  ]);

  resolveFetch(memoraxSuccessResponse("automatic-memory-drain"));
  await draining;
  assert.equal(settled, true);

  assert.deepEqual(runtime.enqueue({
    client: "codex",
    sessionKey: "session-runtime-drain-late",
    userText: "Do not accept work after drain begins.",
    assistantText: "This request must remain local.",
    repositoryScope: REPOSITORY_SCOPE,
    env: WRITEBACK_ENV,
    fetchImpl: memoraxFetch(requests),
  }), { accepted: false, reason: "runtime_closed" });
  assert.equal(requests.length, 1);
});

test("closing an automatic memory runtime cancels its buffered flush", async () => {
  const requests = [];
  const runtime = createAutomaticMemoryWritebackRuntime();
  runtime.enqueue({
    client: "codex",
    sessionKey: "session-runtime-close",
    userText: "Buffer this turn until the runtime closes.",
    assistantText: "Closing must discard the in-memory buffer.",
    repositoryScope: REPOSITORY_SCOPE,
    env: {
      ...WRITEBACK_ENV,
      MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "true",
      MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_TURNS: "8",
      MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_AGE_MS: "20",
    },
    fetchImpl: memoraxFetch(requests),
  });
  runtime.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(requests.length, 0);
});

function memoraxFetch(requests) {
  return async (url, init) => {
    requests.push({
      url: String(url),
      body: JSON.parse(init.body),
    });
    return memoraxSuccessResponse("automatic-memory-add");
  };
}

function memoraxSuccessResponse(taskId) {
  return new Response(JSON.stringify({
    success: true,
    data: { task_id: taskId, status: "queued" },
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function waitFor(predicate, message) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}


test("automatic writeback records only terminal failures without Debug or a diagnostic logger", async (t) => {
  for (const scenario of [
    { name: "authentication", status: 401, attempts: 1, code: "MEMORAX_HTTP_ERROR" },
    { name: "buffered retry exhaustion", status: 503, attempts: 2, code: "MEMORAX_HTTP_ERROR", buffered: true },
    { name: "DNS failure", attempts: 2, code: "MEMORAX_TRANSPORT_ERROR", systemCode: "ENOTFOUND" },
  ]) {
    await t.test(scenario.name, async (t) => {
      const home = await mkdtemp(join(tmpdir(), "memorax-writeback-failure-"));
      t.after(() => rm(home, { recursive: true, force: true }));
      const runtime = createAutomaticMemoryWritebackRuntime({ memoraxCodeHome: home });
      t.after(() => runtime.close());
      let attempts = 0;
      assert.deepEqual(runtime.enqueue({
        client: "workbuddy", sessionKey: "private-session-identity",
        userText: "Private question marker", assistantText: "Private answer marker",
        repositoryScope: REPOSITORY_SCOPE,
        env: { ...WRITEBACK_ENV, MEMORAX_CODE_DEBUG: "false",
          MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: String(Boolean(scenario.buffered)),
          MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_TURNS: "1" },
        fetchImpl: async () => {
          attempts += 1;
          if (scenario.systemCode) throw new TypeError("private transport text", {
            cause: Object.assign(new Error("private hostname"), { code: scenario.systemCode }),
          });
          return new Response("private response text", { status: scenario.status, headers: { "retry-after": "0" } });
        },
      }), { accepted: true });
      await runtime.drain();
      assert.equal(attempts, scenario.attempts);
      const records = await readDiagnostics(home);
      assert.equal(records.length, 1);
      const [record] = records;
      assert.equal(record.source, "automatic-writeback");
      assert.equal(record.operation, "memory.writeback");
      assert.equal(record.client, "workbuddy");
      assert.equal(record.stage, "request");
      assert.equal(record.errorCode, scenario.code);
      assert.equal(record.httpStatus, scenario.status);
      assert.equal(record.systemCode, scenario.systemCode);
      assert.match(record.sessionHash, /^[a-f0-9]{24}$/);
      assert.match(record.impact, /acceptance.*could not be confirmed/);
      assert.ok(record.userAction);
      assert.equal(/private|Private|secret|user-1|memorax.test/.test(JSON.stringify(records)), false);
    });
  }
});

test("automatic writeback keeps disabled, empty, buffered and duplicate completions quiet", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "memorax-writeback-quiet-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const runtime = createAutomaticMemoryWritebackRuntime({ memoraxCodeHome: home });
  t.after(() => runtime.close());
  const requests = [];
  const options = { client: "codex", sessionKey: "quiet-session", userText: "Remember the result.",
    assistantText: "The result is ready.", repositoryScope: REPOSITORY_SCOPE,
    env: { ...WRITEBACK_ENV, MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "true" },
    fetchImpl: memoraxFetch(requests) };
  assert.deepEqual(runtime.enqueue({ ...options, env: { ...options.env, MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "false" } }),
    { accepted: false, reason: "disabled" });
  assert.deepEqual(runtime.enqueue({ ...options, assistantText: "" }), { accepted: false, reason: "assistant_text_empty" });
  assert.deepEqual(runtime.enqueue(options), { accepted: true });
  assert.deepEqual(runtime.enqueue(options), { accepted: true });
  assert.equal(requests.length, 0);
  assert.deepEqual(await readDiagnostics(home), []);
  await runtime.drain();
  assert.equal(requests.length, 1);
  assert.deepEqual(await readDiagnostics(home), []);
});

test("unavailable diagnostic storage preserves terminal retry and duplicate-release behavior", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "memorax-writeback-no-diagnostics-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, "runtime"));
  await writeFile(join(home, "runtime", "diagnostics"), "occupied");
  let requests = 0;
  let fail = true;
  let finishFailure;
  const failureSettled = new Promise((resolve) => { finishFailure = resolve; });
  const runtime = createAutomaticMemoryWritebackRuntime({ memoraxCodeHome: home,
    diagnosticLogger(message, fields) {
      if (message === "memory.automatic_writeback" && fields.accepted === false && !fields.retrying) finishFailure();
    } });
  t.after(() => runtime.close());
  const options = { client: "codex", sessionKey: "failed-session", userText: "Remember it.", assistantText: "Done.",
    repositoryScope: REPOSITORY_SCOPE, env: WRITEBACK_ENV,
    fetchImpl: async () => { requests += 1; return fail
      ? new Response("", { status: 401 }) : memoraxSuccessResponse("accepted"); } };
  assert.deepEqual(runtime.enqueue(options), { accepted: true });
  await failureSettled;
  fail = false;
  assert.deepEqual(runtime.enqueue(options), { accepted: true });
  await runtime.drain();
  assert.equal(requests, 2);
  assert.equal(await readFile(join(home, "runtime", "diagnostics"), "utf8"), "occupied");
});

async function readDiagnostics(home) {
  const directory = join(home, "runtime", "diagnostics");
  const names = await readdir(directory).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  return await Promise.all(names.filter((name) => name.endsWith(".json"))
    .map(async (name) => JSON.parse(await readFile(join(directory, name), "utf8"))));
}

test("automatic work dialogue uses chat routing without code chunks and freezes buffered routes", async () => {
  const requests = [];
  const runtime = createAutomaticMemoryWritebackRuntime();
  const base = {
    client: "workbuddy", sessionKey: "work-routing", repositoryScope: REPOSITORY_SCOPE,
    userText: "What is the expense approval threshold?", assistantText: "I will check the policy.",
    fetchImpl: memoraxFetch(requests),
    env: { ...WRITEBACK_ENV, MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "true",
      MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_TURNS: "10", MEMORAX_CODE_MEMORY_WRITEBACK_CHUNK_MAX_CHARS: "10" },
  };
  try {
    assert.deepEqual(runtime.enqueue(base), { accepted: true });
    // The same text under a different route must neither merge nor deduplicate.
    assert.deepEqual(runtime.enqueue({ ...base, env: { ...base.env, MEMORAX_CODE_MEMORAX_ADD_CONTENT_TYPE: "code" } }), { accepted: true });
    await runtime.drain();
    const dialogue = requests.filter(({ body }) => body.content_type === "dialogue");
    const code = requests.filter(({ body }) => body.content_type === "code");
    assert.equal(dialogue.length, 1);
    assert.ok(code.length > 0);
    assert.equal(dialogue[0].body.mode, "default");
    assert.equal(dialogue[0].body.chunk, undefined);
    assert.deepEqual(dialogue[0].body.messages.map(({ content }) => content), [base.userText, base.assistantText]);
    assert.ok(code.every(({ body }) => body.mode === "default"));
  } finally { runtime.close(); }
});

test("automatic routing honors dialogue configuration for coding clients and rejects document configuration", async () => {
  const requests = [];
  const runtime = createAutomaticMemoryWritebackRuntime();
  const base = { client: "codex", sessionKey: "configured-work", repositoryScope: REPOSITORY_SCOPE,
    userText: "Discuss expense approval.", assistantText: "Approval is pending.", fetchImpl: memoraxFetch(requests) };
  try {
    assert.deepEqual(runtime.enqueue({ ...base, env: { ...WRITEBACK_ENV, MEMORAX_CODE_MEMORAX_ADD_CONTENT_TYPE: "dialogue" } }), { accepted: true });
    assert.deepEqual(runtime.enqueue({ ...base, env: { ...WRITEBACK_ENV, MEMORAX_CODE_MEMORAX_ADD_CONTENT_TYPE: "document" } }), { accepted: false, reason: "decision_error" });
    await runtime.drain();
    assert.equal(requests[0].body.content_type, "dialogue");
    assert.equal(requests.length, 1);
  } finally { runtime.close(); }
});


test("automatic code writes preserve legacy deduplication keys in immediate and buffered dispatch", async () => {
  const hash = (value) => createHash("sha256").update(value).digest("hex").slice(0, 16);
  for (const buffered of [false, true]) {
    const requests = [];
    const runtime = createAutomaticMemoryWritebackRuntime();
    try {
      const options = { client: "codex", sessionKey: "legacy-code", repositoryScope: REPOSITORY_SCOPE,
        userText: "Fix the parser", assistantText: "The parser is fixed", fetchImpl: memoraxFetch(requests),
        env: { ...WRITEBACK_ENV, MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: String(buffered) } };
      assert.deepEqual(runtime.enqueue(options), { accepted: true });
      assert.deepEqual(runtime.enqueue(options), { accepted: true });
      await runtime.drain();
      assert.equal(requests.length, 1);
      const prefix = `${buffered ? "automatic-buffer:v1" : "automatic"}:codex:${hash(REPOSITORY_SCOPE.effectiveUserId)}:legacy-code:`;
      const digest = buffered ? hash("user:Fix the parser\nassistant:The parser is fixed") : `${hash(options.userText)}:${hash(options.assistantText)}`;
      assert.equal(requests[0].body.metadata.idempotency_key, prefix + digest);
      assert.equal(requests[0].body.content_type, "code");
      assert.equal(requests[0].body.mode, "default");
    } finally { runtime.close(); }
  }
});
