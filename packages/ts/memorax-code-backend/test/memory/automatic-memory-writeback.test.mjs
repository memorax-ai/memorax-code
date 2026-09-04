import assert from "node:assert/strict";
import { test } from "node:test";
import { createAutomaticMemoryWritebackRuntime } from "../../dist/memory/automatic-writeback.js";

const WRITEBACK_ENV = {
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

test("automatic memory writeback preserves natural memory mentions outside the first client rollout", async () => {
  const requests = [];
  const diagnostics = [];
  const runtime = createAutomaticMemoryWritebackRuntime({
    diagnosticLogger: (message, fields) => diagnostics.push({ message, fields }),
  });
  const assistantText = [
    "I used MemoraX Code Memory to guide the implementation.",
    "",
    "OpenCode output.",
  ].join("\n");
  try {
    assert.deepEqual(runtime.enqueue({
      client: "opencode",
      sessionKey: "session-memory-impact-unsupported",
      userText: "Keep the first rollout client-scoped.",
      assistantText,
      repositoryScope: REPOSITORY_SCOPE,
      env: WRITEBACK_ENV,
      fetchImpl: memoraxFetch(requests),
    }), { accepted: true });

    await runtime.drain();

    assert.equal(requests[0].body.messages[1].content, assistantText);
    assert.equal(
      diagnostics.some(({ message }) => message === "memory.automatic_writeback.impact_stripped"),
      false,
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

test("automatic memory writeback retries a retryable provider failure", async () => {
  const requests = [];
  const events = [];
  const runtime = createAutomaticMemoryWritebackRuntime();
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    if (requests.length === 1) {
      return new Response("", { status: 503, headers: { "retry-after": "0" } });
    }
    return memoraxSuccessResponse("automatic-memory-retry");
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

    await waitFor(() => requests.length === 2 && events.length === 2, "automatic writeback retry did not settle");
    assert.deepEqual(events.map((event) => event.ok), [false, true]);
    assert.deepEqual(events.map((event) => event.request.attempt), [1, 2]);
    assert.equal(events.every((event) => event.source === "claude_hook_writeback"), true);
    assert.equal(requests[0].body.metadata.idempotency_key, requests[1].body.metadata.idempotency_key);
  } finally {
    runtime.close();
  }
});

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
    for (const [userText, assistantText] of [
      ["First buffered prompt.", "First buffered answer."],
      ["Second buffered prompt.", "Second buffered answer."],
    ]) {
      runtime.enqueue({
        client: "codex",
        sessionKey: "session-automatic-buffer",
        userText,
        assistantText,
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
    enqueue("codex", "one");
    enqueue("claude-code", "one");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(requests.length, 0);

    enqueue("codex", "two");
    enqueue("claude-code", "two");
    await waitFor(() => requests.length === 2, "client-scoped writeback buffers did not flush");

    assert.deepEqual(requests.map((request) => request.body.messages.map((message) => message.content)), [
      ["codex prompt one.", "codex answer one.", "codex prompt two.", "codex answer two."],
      [
        "claude-code prompt one.",
        "claude-code answer one.",
        "claude-code prompt two.",
        "claude-code answer two.",
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

test("draining an automatic memory runtime flushes buffered turns and waits for provider settlement", async () => {
  const requests = [];
  let notifyFetchStarted;
  let resolveFetch;
  const fetchStarted = new Promise((resolve) => {
    notifyFetchStarted = resolve;
  });
  const runtime = createAutomaticMemoryWritebackRuntime();
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

  runtime.enqueue({
    client: "codex",
    sessionKey: "session-runtime-drain-late",
    userText: "Do not accept work after drain begins.",
    assistantText: "This request must remain local.",
    repositoryScope: REPOSITORY_SCOPE,
    env: WRITEBACK_ENV,
    fetchImpl: memoraxFetch(requests),
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(requests.length, 1);
  runtime.close();
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
