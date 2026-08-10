import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createMemoryWritebackBufferRuntime } from "../../dist/memory/writeback-buffer.js";

const writebackBuffer = createMemoryWritebackBufferRuntime();

function enqueueMemoryWritebackBuffer(decision, options, deps) {
  writebackBuffer.enqueue(decision, options, deps);
}

after(() => writebackBuffer.close());

const REPOSITORY_SCOPE = {
  schemaVersion: "workspace-memory-scope.v1",
  baseUserId: "user-1",
  effectiveUserId: "user-1@test-repo",
  repositoryKey: "test-repository-key",
  repositorySlug: "test-repo",
  repositoryName: "test-repo",
  identitySource: "workspace-directory",
  scopeKind: "local-directory",
  boundWorkspaceRoot: "/test-repo",
};
const OTHER_REPOSITORY_SCOPE = {
  ...REPOSITORY_SCOPE,
  effectiveUserId: "user-1@other-repo",
  repositoryKey: "other-repository-key",
  repositorySlug: "other-repo",
  repositoryName: "other-repo",
  boundWorkspaceRoot: "/other-repo",
};
const DEGRADED_GIT_SCOPE = {
  ...REPOSITORY_SCOPE,
  fallbackReason: "git_metadata_invalid",
};
const REPAIRED_GIT_SCOPE = {
  ...REPOSITORY_SCOPE,
  repositoryKey: "repaired-git-repository-key",
  identitySource: "origin-remote",
  scopeKind: "git-repository",
};

test("memory writeback buffer aggregates trace turns by session at the turn limit", () => {
  const flushes = [];
  const reserved = [];
  const options = {
    repositoryScope: REPOSITORY_SCOPE,
    env: {
      MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_TURNS: "2",
      MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_AGE_MS: "100000",
      MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_CHARS: "1000",
    },
  };
  const deps = {
    debug() {},
    flush(decision, flushOptions) {
      flushes.push({ decision, flushOptions });
    },
    hasPendingWriteback() {
      return false;
    },
    reservePendingWritebacks(idempotencyKeys) {
      reserved.push([...idempotencyKeys]);
    },
    hashText(text) {
      return `hash(${text})`;
    },
  };

  enqueueMemoryWritebackBuffer({
    client: "codex",
    sessionKey: "session-buffer",
    idempotencyKey: "turn-1",
    messages: [
      { role: "user", content: "first user" },
      { role: "assistant", content: "first assistant" },
    ],
  }, {
    ...options,
    traceContext: codexTraceContext("session-buffer", "turn-1", "request-1", "native-1", "2026-07-15T01:00:00.000Z"),
  }, deps);
  enqueueMemoryWritebackBuffer({
    client: "codex",
    sessionKey: "session-buffer",
    idempotencyKey: "turn-2",
    messages: [
      { role: "user", content: "second user" },
      { role: "assistant", content: "second assistant" },
    ],
  }, {
    ...options,
    traceContext: codexTraceContext("session-buffer", "turn-2", "request-2", "native-2", "2026-07-15T01:01:00.000Z"),
  }, deps);

  assert.equal(flushes.length, 1);
  assert.equal(flushes[0].decision.sessionKey, "session-buffer");
  assert.equal(flushes[0].decision.flushReason, "turn_limit");
  assert.equal(flushes[0].decision.turnCount, 2);
  assert.deepEqual(flushes[0].decision.messages.map((message) => message.content), [
    "first user",
    "first assistant",
    "second user",
    "second assistant",
  ]);
  assert.deepEqual(flushes[0].decision.dedupeKeys.slice(1), ["turn-1", "turn-2"]);
  assert.match(
    flushes[0].decision.idempotencyKey,
    /^automatic-buffer:v1:codex:hash\(user-1@test-repo\):session-buffer:/,
  );
  assert.deepEqual(reserved, [flushes[0].decision.dedupeKeys]);
  assert.equal(flushes[0].flushOptions.sessionKey, "session-buffer");
  assert.equal(flushes[0].flushOptions.env, options.env);
  assert.equal(flushes[0].flushOptions.traceContext.sessionId, "session-buffer");
  assert.equal(flushes[0].flushOptions.traceContext.turnId, undefined);
  assert.equal(flushes[0].flushOptions.traceContext.requestId, undefined);
  assert.equal(flushes[0].flushOptions.traceContext.nativeRequestId, undefined);
  assert.deepEqual(flushes[0].flushOptions.relatedTurns, [
    {
      turnId: "turn-1",
      requestId: "request-1",
      nativeRequestId: "native-1",
      contextOrigin: "codex-hook-body",
      capturedAt: "2026-07-15T01:00:00.000Z",
    },
    {
      turnId: "turn-2",
      requestId: "request-2",
      nativeRequestId: "native-2",
      contextOrigin: "codex-hook-body",
      capturedAt: "2026-07-15T01:01:00.000Z",
    },
  ]);
});

test("memory writeback buffer never merges workspace scopes", () => {
  const flushes = [];
  const deps = {
    debug() {},
    flush(decision, flushOptions) {
      flushes.push({ decision, flushOptions });
    },
    hasPendingWriteback() {
      return false;
    },
    reservePendingWritebacks() {},
    hashText(text) {
      return `hash(${text})`;
    },
  };
  const env = {
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_TURNS: "2",
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_AGE_MS: "100000",
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_CHARS: "1000",
  };
  const enqueue = (repositoryScope, idempotencyKey, content) => enqueueMemoryWritebackBuffer({
    client: "codex",
    sessionKey: "shared-session",
    idempotencyKey,
    messages: [{ role: "user", content }],
  }, { env, repositoryScope }, deps);

  enqueue(REPOSITORY_SCOPE, "repo-a-turn-1", "repo A first");
  enqueue(OTHER_REPOSITORY_SCOPE, "repo-b-turn-1", "repo B first");
  assert.equal(flushes.length, 0);
  enqueue(REPOSITORY_SCOPE, "repo-a-turn-2", "repo A second");
  enqueue(OTHER_REPOSITORY_SCOPE, "repo-b-turn-2", "repo B second");

  assert.equal(flushes.length, 2);
  assert.deepEqual(flushes[0].decision.messages.map((message) => message.content), ["repo A first", "repo A second"]);
  assert.equal(flushes[0].flushOptions.repositoryScope.effectiveUserId, "user-1@test-repo");
  assert.deepEqual(flushes[1].decision.messages.map((message) => message.content), ["repo B first", "repo B second"]);
  assert.equal(flushes[1].flushOptions.repositoryScope.effectiveUserId, "user-1@other-repo");
  assert.notEqual(flushes[0].decision.idempotencyKey, flushes[1].decision.idempotencyKey);
});

test("memory writeback buffer discards degraded turns when the same session upgrades to Git scope", () => {
  const runtime = createMemoryWritebackBufferRuntime();
  const flushes = [];
  const debugEvents = [];
  const deps = createDeps(flushes, { debugEvents });
  const env = bufferEnv({ maxTurns: 2, maxAgeMs: 100_000 });
  const enqueue = (repositoryScope, idempotencyKey, content) => runtime.enqueue({
    client: "codex",
    sessionKey: "repair-session",
    idempotencyKey,
    messages: [{ role: "user", content }],
  }, { env, repositoryScope }, deps);
  try {
    enqueue(DEGRADED_GIT_SCOPE, "fallback-turn", "fallback content");
    enqueue(REPAIRED_GIT_SCOPE, "git-turn-1", "Git content first");

    assert.equal(flushes.length, 0);
    assert.equal(debugEvents.some((fields) => fields.skipReason === "buffer_scope_upgraded"), true);

    enqueue(REPAIRED_GIT_SCOPE, "git-turn-2", "Git content second");

    assert.equal(flushes.length, 1);
    assert.deepEqual(flushes[0].decision.messages.map((message) => message.content), [
      "Git content first",
      "Git content second",
    ]);
    assert.strictEqual(flushes[0].flushOptions.repositoryScope, REPAIRED_GIT_SCOPE);
  } finally {
    runtime.close();
  }
});

test("memory writeback buffer cancels the degraded idle timer when session scope upgrades", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  const runtime = createMemoryWritebackBufferRuntime();
  const flushes = [];
  const debugEvents = [];
  const deps = createDeps(flushes, { debugEvents });
  const env = bufferEnv({ maxAgeMs: 100 });
  try {
    runtime.enqueue({
      client: "codex",
      sessionKey: "interrupted-repair-session",
      idempotencyKey: "fallback-turn",
      messages: [{ role: "user", content: "fallback content" }],
    }, { env, repositoryScope: DEGRADED_GIT_SCOPE }, deps);

    assert.equal(runtime.discardForScopeUpgrade({
      client: "codex",
      sessionKey: "interrupted-repair-session",
      currentScope: REPAIRED_GIT_SCOPE,
    }), 1);
    t.mock.timers.tick(100);

    assert.equal(flushes.length, 0);
    assert.equal(runtime.flushAll("shutdown"), 0);
    assert.equal(debugEvents.some((fields) => (
      fields.skipReason === "buffer_scope_upgraded"
      && fields.discardedTurnCount === 1
    )), true);
  } finally {
    runtime.close();
  }
});

test("memory writeback buffer never merges sessions", () => {
  const flushes = [];
  const deps = createDeps(flushes);
  const env = bufferEnv({ maxTurns: 2 });
  const enqueue = (sessionKey, idempotencyKey, content) => enqueueMemoryWritebackBuffer({
    client: "codex",
    sessionKey,
    idempotencyKey,
    messages: [{ role: "user", content }],
  }, { env, repositoryScope: REPOSITORY_SCOPE }, deps);

  enqueue("session-a", "session-a-turn-1", "session A first");
  enqueue("session-b", "session-b-turn-1", "session B first");
  assert.equal(flushes.length, 0);
  enqueue("session-a", "session-a-turn-2", "session A second");
  enqueue("session-b", "session-b-turn-2", "session B second");

  assert.equal(flushes.length, 2);
  assert.deepEqual(flushes[0].decision.messages.map((message) => message.content), ["session A first", "session A second"]);
  assert.deepEqual(flushes[1].decision.messages.map((message) => message.content), ["session B first", "session B second"]);
});

test("memory writeback buffer never merges clients", () => {
  const runtime = createMemoryWritebackBufferRuntime();
  const flushes = [];
  const deps = createDeps(flushes);
  const env = bufferEnv({ maxTurns: 2 });
  const enqueue = (client, idempotencyKey, content) => runtime.enqueue({
    client,
    sessionKey: "shared-client-session",
    idempotencyKey,
    messages: [{ role: "user", content }],
  }, { env, repositoryScope: REPOSITORY_SCOPE }, deps);
  try {
    enqueue("codex", "codex-turn-1", "Codex first");
    enqueue("claude-code", "claude-turn-1", "Claude first");
    assert.equal(flushes.length, 0);

    enqueue("codex", "codex-turn-2", "Codex second");
    enqueue("claude-code", "claude-turn-2", "Claude second");

    assert.equal(flushes.length, 2);
    assert.deepEqual(flushes[0].decision.messages.map((message) => message.content), [
      "Codex first",
      "Codex second",
    ]);
    assert.deepEqual(flushes[1].decision.messages.map((message) => message.content), [
      "Claude first",
      "Claude second",
    ]);
    assert.match(flushes[0].decision.idempotencyKey, /^automatic-buffer:v1:codex:/);
    assert.match(flushes[1].decision.idempotencyKey, /^automatic-buffer:v1:claude-code:/);
  } finally {
    runtime.close();
  }
});

test("memory writeback buffer flushes every pending session during drain", () => {
  const runtime = createMemoryWritebackBufferRuntime();
  const flushes = [];
  const deps = createDeps(flushes);
  const env = bufferEnv({ maxTurns: 8, maxAgeMs: 100_000 });
  try {
    for (const sessionKey of ["session-drain-a", "session-drain-b"]) {
      runtime.enqueue({
        client: "codex",
        sessionKey,
        idempotencyKey: `${sessionKey}-turn`,
        messages: [{ role: "user", content: `${sessionKey} content` }],
      }, { env, repositoryScope: REPOSITORY_SCOPE }, deps);
    }

    assert.equal(flushes.length, 0);
    assert.equal(runtime.flushAll("shutdown"), 2);
    assert.deepEqual(
      flushes.map(({ decision }) => [decision.sessionKey, decision.flushReason]),
      [
        ["session-drain-a", "shutdown"],
        ["session-drain-b", "shutdown"],
      ],
    );
    assert.equal(runtime.flushAll("shutdown"), 0);
  } finally {
    runtime.close();
  }
});

test("memory writeback buffer resets the idle deadline after each new turn", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  const flushes = [];
  const deps = createDeps(flushes);
  const env = bufferEnv({ maxAgeMs: 100 });

  enqueueTurn("session-idle-reset", "turn-idle-1", "first", env, deps);
  t.mock.timers.tick(60);
  enqueueTurn("session-idle-reset", "turn-idle-2", "second", env, deps);
  t.mock.timers.tick(40);
  assert.equal(flushes.length, 0);
  t.mock.timers.tick(59);
  assert.equal(flushes.length, 0);
  t.mock.timers.tick(1);

  assert.equal(flushes.length, 1);
  assert.equal(flushes[0].decision.flushReason, "idle_limit");
  assert.equal(flushes[0].decision.turnCount, 2);
});

test("memory writeback buffer duplicate turns do not reset the idle deadline", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 2_000 });
  const flushes = [];
  const debugEvents = [];
  const deps = createDeps(flushes, { debugEvents });
  const env = bufferEnv({ maxAgeMs: 100 });

  enqueueTurn("session-duplicate-idle", "turn-duplicate", "original", env, deps);
  t.mock.timers.tick(60);
  enqueueTurn("session-duplicate-idle", "turn-duplicate", "original", env, deps);
  t.mock.timers.tick(39);
  assert.equal(flushes.length, 0);
  t.mock.timers.tick(1);

  assert.equal(flushes.length, 1);
  assert.equal(flushes[0].decision.flushReason, "idle_limit");
  assert.equal(flushes[0].decision.turnCount, 1);
  assert.equal(debugEvents.some((fields) => fields.skipReason === "buffer_duplicate_turn"), true);
});

test("memory writeback buffer checks duplicates before char rollover", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 3_000 });
  const flushes = [];
  const deps = createDeps(flushes);
  const env = bufferEnv({ maxAgeMs: 100, maxChars: 10 });

  enqueueTurn("session-duplicate-char", "turn-duplicate-char", "12345678", env, deps);
  enqueueTurn("session-duplicate-char", "turn-duplicate-char", "this duplicate is oversized", env, deps);
  assert.equal(flushes.length, 0);
  t.mock.timers.tick(100);

  assert.equal(flushes.length, 1);
  assert.equal(flushes[0].decision.flushReason, "idle_limit");
  assert.deepEqual(flushes[0].decision.messages.map((message) => message.content), ["12345678"]);
});

test("memory writeback buffer keeps complete turns across char rollover", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 4_000 });
  const flushes = [];
  const deps = createDeps(flushes);
  const env = bufferEnv({ maxAgeMs: 100, maxChars: 10 });

  enqueueTurn("session-char-rollover", "turn-char-1", "12345678", env, deps);
  enqueueTurn("session-char-rollover", "turn-char-2", "abcdefgh", env, deps);

  assert.equal(flushes.length, 1);
  assert.equal(flushes[0].decision.flushReason, "char_limit");
  assert.deepEqual(flushes[0].decision.messages.map((message) => message.content), ["12345678"]);
  t.mock.timers.tick(100);
  assert.equal(flushes.length, 2);
  assert.equal(flushes[1].decision.flushReason, "idle_limit");
  assert.deepEqual(flushes[1].decision.messages.map((message) => message.content), ["abcdefgh"]);
});

test("stale idle callbacks cannot flush a newer buffer with the same key", () => {
  const flushes = [];
  const callbacks = [];
  let now = 5_000;
  const deps = createDeps(flushes, {
    clock: {
      now: () => now,
      setTimeout(callback) {
        callbacks.push(callback);
        return { unref() {} };
      },
      clearTimeout() {},
    },
  });
  const env = bufferEnv({ maxTurns: 2, maxAgeMs: 100 });

  enqueueTurn("session-stale-timer", "turn-old-1", "old first", env, deps);
  now += 1;
  enqueueTurn("session-stale-timer", "turn-old-2", "old second", env, deps);
  assert.equal(flushes.length, 1);

  now += 1;
  enqueueTurn("session-stale-timer", "turn-new-1", "new first", env, deps);
  assert.equal(callbacks.length, 2);
  callbacks[0]();
  assert.equal(flushes.length, 1);

  now += 1;
  enqueueTurn("session-stale-timer", "turn-new-2", "new second", env, deps);
  assert.equal(flushes.length, 2);
  assert.deepEqual(flushes[1].decision.messages.map((message) => message.content), ["new first", "new second"]);
});

function enqueueTurn(sessionKey, idempotencyKey, content, env, deps) {
  enqueueMemoryWritebackBuffer({
    client: "codex",
    sessionKey,
    idempotencyKey,
    messages: [{ role: "user", content }],
  }, { env, repositoryScope: REPOSITORY_SCOPE }, deps);
}

function bufferEnv({ maxTurns = 8, maxAgeMs = 100_000, maxChars = 1_000 } = {}) {
  return {
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_TURNS: String(maxTurns),
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_AGE_MS: String(maxAgeMs),
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_CHARS: String(maxChars),
  };
}

function createDeps(flushes, { debugEvents = [], clock } = {}) {
  return {
    debug(_message, fields = {}) {
      debugEvents.push(fields);
    },
    flush(decision, flushOptions) {
      flushes.push({ decision, flushOptions });
    },
    hasPendingWriteback() {
      return false;
    },
    reservePendingWritebacks() {},
    hashText(text) {
      return `hash(${text})`;
    },
    ...(clock ? { clock } : {}),
  };
}

function codexTraceContext(sessionId, turnId, requestId, nativeRequestId, capturedAt) {
  return {
    schemaVersion: "1",
    client: "codex",
    sessionId,
    turnId,
    requestId,
    nativeRequestId,
    contextOrigin: "codex-hook-body",
    capturedAt,
  };
}
