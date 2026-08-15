import assert from "node:assert/strict";
import test from "node:test";

import {
  isOwnRecallMessage,
  registerMemoraxCodePlugin,
} from "../src/plugin.mjs";

test("retrieves once and writes the exact durable top-level DSH Turn", async () => {
  const deferred = [];
  const calls = [];
  const turnStarts = [];
  const writebacks = [];
  let persisted;
  const ctx = mockContext({
    flush: async () => {
      calls.push("flush");
      return true;
    },
    readFrom: async (_sessionId, fromSeq) => {
      calls.push(`read:${fromSeq}`);
      return persisted;
    },
  });
  const backendClient = {
    async recordTurnStart(command) {
      calls.push("backend:turn-start");
      turnStarts.push(command);
      return { ok: true, additionalContext: "Relevant shared memory" };
    },
    async writebackTurn(command) {
      calls.push("backend:writeback");
      writebacks.push(command);
      return { ok: true, scheduled: true };
    },
  };
  registerMemoraxCodePlugin(ctx, {
    backendClient,
    createUserMessage: (input) => ({ id: "recall-1", role: "user", ...structuredClone(input) }),
    defer: (callback) => deferred.push(callback),
  });

  const session = topLevelSession();
  ctx.emit("session/event", session, event("turn/start", 4, { turn: 1 }));
  const directUser = {
    id: "user-1",
    role: "user",
    content: [{ type: "text", text: "How should the adapter work?" }],
    source: { kind: "user" },
  };
  const downstreamContext = {
    id: "context-1",
    role: "user",
    content: [{ type: "text", text: "workspace context" }],
    source: { kind: "plugin", plugin: "workspace" },
  };
  const next = async () => {
    calls.push("next");
    return { kind: "enter", messages: [directUser, downstreamContext] };
  };
  const decision = await ctx.waterfall("agent/pre-step", {
    agent: { id: session.id, session },
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, next);

  assert.deepEqual(calls.slice(0, 2), ["next", "backend:turn-start"]);
  assert.equal(decision.messages.length, 3);
  assert.equal(isOwnRecallMessage(decision.messages[2]), true);
  assert.equal(decision.messages[2].source.plugin, "memorax-code-dsh");
  assert.deepEqual(turnStarts, [{
    version: 1,
    client: "dsh",
    sessionId: "session-1",
    turn: 1,
    startSeq: 4,
    cwd: "/workspace/project",
    prompt: "How should the adapter work?",
  }]);

  await ctx.waterfall("agent/pre-step", {
    agent: { id: session.id, session },
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, next);
  assert.equal(turnStarts.length, 1, "retrieval is attempted at most once per Turn");

  const recall = decision.messages[2];
  persisted = {
    meta: session.header,
    events: [
      event("turn/start", 4, { turn: 1 }),
      event("step/start", 5, { turn: 1, step: 1 }),
      event("user/message", 6, directUser),
      event("user/message", 7, recall),
      event("assistant/message", 8, {
        turn: 1,
        step: 1,
        message: {
          id: "assistant-1",
          role: "assistant",
          content: [{ type: "text", text: "Use the native event log." }],
          source: { kind: "model", provider: "test", model: "test" },
        },
      }),
      event("step/end", 9, { turn: 1, step: 1 }),
      event("turn/end", 10, { turn: 1, reason: { kind: "completed" } }),
      event("turn/start", 11, { turn: 2 }),
    ],
  };
  ctx.emit("session/event", session, persisted.events[6]);
  assert.equal(calls.includes("flush"), false, "flush waits until session/event publication completes");
  assert.equal(deferred.length, 1);
  await deferred.shift()();

  assert.deepEqual(calls.slice(-3), ["flush", "read:4", "backend:writeback"]);
  assert.equal(writebacks.length, 1);
  assert.deepEqual(writebacks[0].events.map(({ seq }) => seq), [4, 5, 6, 7, 8, 9, 10]);
  assert.equal(
    isOwnRecallMessage(writebacks[0].events.find(({ seq }) => seq === 7).data),
    true,
    "the authority interval stays contiguous; Backend materialization excludes this recall",
  );
  assert.equal(writebacks[0].sessionHeader.id, session.id);

  const child = topLevelSession({
    id: "child-1",
    parentSession: session.id,
    origin: "subagent",
    delegationDepth: 1,
  });
  ctx.emit("session/event", child, event("turn/start", 0, { turn: 1 }));
  const childDecision = await ctx.waterfall("agent/pre-step", {
    agent: { id: child.id, session: child },
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, async () => ({ kind: "enter", messages: [directUser] }));
  assert.equal(childDecision.messages.length, 1);
  assert.equal(turnStarts.length, 1, "subagent sessions do not retrieve");

  const fork = topLevelSession({
    id: "fork-1",
    parentSession: session.id,
    seedLength: 10,
    delegationDepth: 0,
  });
  ctx.emit("session/event", fork, event("turn/start", 11, { turn: 2 }));
  const forkDecision = await ctx.waterfall("agent/pre-step", {
    agent: { id: fork.id, session: fork },
    turn: 2,
    step: 1,
    signal: new AbortController().signal,
  }, async () => ({ kind: "enter", messages: [directUser] }));
  assert.equal(forkDecision.messages.length, 2);
  assert.equal(turnStarts.length, 2, "an ordinary user fork remains memory eligible");
  assert.equal(turnStarts[1].sessionId, fork.id);
});

test("fails closed when durable readFrom returns a gapped Turn", async () => {
  const deferred = [];
  let writebacks = 0;
  const session = topLevelSession();
  const ctx = mockContext({
    flush: async () => true,
    readFrom: async () => ({
      meta: session.header,
      events: [
        event("turn/start", 0, { turn: 1 }),
        event("user/message", 2, {
          id: "user-1",
          role: "user",
          content: [{ type: "text", text: "gap" }],
          source: { kind: "user" },
        }),
        event("turn/end", 3, { turn: 1, reason: { kind: "completed" } }),
      ],
    }),
  });
  registerMemoraxCodePlugin(ctx, {
    backendClient: {
      async recordTurnStart() { return { ok: true }; },
      async writebackTurn() { writebacks += 1; },
    },
    createUserMessage: (input) => ({ id: "recall", role: "user", ...input }),
    defer: (callback) => deferred.push(callback),
  });

  ctx.emit("session/event", session, event("turn/start", 0, { turn: 1 }));
  ctx.emit("session/event", session, event("turn/end", 3, {
    turn: 1,
    reason: { kind: "completed" },
  }));
  await deferred.shift()();
  assert.equal(writebacks, 0);
});

test("serializes same-session writeback and continues after one failure", async () => {
  const deferred = [];
  const order = [];
  const firstWrite = Promise.withResolvers();
  const session = topLevelSession();
  const intervals = new Map([
    [0, [
      event("turn/start", 0, { turn: 1 }),
      event("turn/end", 1, { turn: 1, reason: { kind: "completed" } }),
    ]],
    [2, [
      event("turn/start", 2, { turn: 2 }),
      event("turn/end", 3, { turn: 2, reason: { kind: "completed" } }),
    ]],
  ]);
  const ctx = mockContext({
    flush: async () => {
      order.push("flush");
      return true;
    },
    readFrom: async (_id, startSeq) => {
      order.push(`read:${startSeq}`);
      return { meta: session.header, events: intervals.get(startSeq) };
    },
  });
  registerMemoraxCodePlugin(ctx, {
    backendClient: {
      async recordTurnStart() { return { ok: true }; },
      async writebackTurn(command) {
        order.push(`write:${command.turn}`);
        if (command.turn === 1) {
          await firstWrite.promise;
          throw new Error("first write failed");
        }
      },
    },
    createUserMessage: (input) => ({ id: "recall", role: "user", ...input }),
    defer: (callback) => deferred.push(callback),
  });

  ctx.emit("session/event", session, intervals.get(0)[0]);
  ctx.emit("session/event", session, intervals.get(0)[1]);
  ctx.emit("session/event", session, intervals.get(2)[0]);
  ctx.emit("session/event", session, intervals.get(2)[1]);
  assert.equal(deferred.length, 2);
  const first = deferred[0]();
  const second = deferred[1]();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["flush", "read:0", "write:1"]);

  firstWrite.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, [
    "flush", "read:0", "write:1",
    "flush", "read:2", "write:2",
  ]);
});

test("drains an accepted Turn writeback during Cordis disposal", async () => {
  const deferred = [];
  const write = Promise.withResolvers();
  const session = topLevelSession();
  const events = [
    event("turn/start", 0, { turn: 1 }),
    event("turn/end", 1, { turn: 1, reason: { kind: "completed" } }),
  ];
  const ctx = mockContext({
    flush: async () => true,
    readFrom: async () => ({ meta: session.header, events }),
  });
  registerMemoraxCodePlugin(ctx, {
    backendClient: {
      async recordTurnStart() { return { ok: true }; },
      async writebackTurn() { await write.promise; },
    },
    createUserMessage: (input) => ({ id: "recall", role: "user", ...input }),
    defer: (callback) => deferred.push(callback),
    drainTimeoutMs: 1_000,
  });

  ctx.emit("session/event", session, events[0]);
  ctx.emit("session/event", session, events[1]);
  const disposing = ctx.dispose();
  let disposed = false;
  void disposing.then(() => { disposed = true; });
  const scheduled = deferred.shift()();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disposed, false);

  write.resolve();
  await Promise.all([scheduled, disposing]);
  assert.equal(disposed, true);
});

function topLevelSession(overrides = {}) {
  const id = overrides.id ?? "session-1";
  return {
    id,
    header: {
      version: 0,
      id,
      createdAt: 1,
      cwd: "/workspace/project",
      ...overrides,
    },
  };
}

function event(type, seq, data) {
  return { type, seq, time: seq + 1, data };
}

function mockContext(runtime) {
  const handlers = new Map();
  const disposers = [];
  return {
    logger: { warn() {} },
    sessions: { flush: runtime.flush },
    sessionPersistence: { readFrom: runtime.readFrom },
    on(name, callback) {
      const registered = handlers.get(name) ?? [];
      registered.push(callback);
      handlers.set(name, registered);
      return () => {};
    },
    effect(start) {
      const dispose = start();
      if (typeof dispose === "function") disposers.push(dispose);
    },
    emit(name, ...args) {
      for (const callback of handlers.get(name) ?? []) callback(...args);
    },
    waterfall(name, payload, next) {
      const [callback] = handlers.get(name) ?? [];
      assert.ok(callback, `missing ${name} listener`);
      return callback(payload, next);
    },
    async dispose() {
      for (const dispose of disposers.reverse()) await dispose();
    },
  };
}
