import assert from "node:assert/strict";
import test from "node:test";

import { createDshUserMessage } from "../src/dsh-message.mjs";
import { registerMemoraxCodePlugin } from "../src/plugin.mjs";
import { PATCHOULI_PROVIDER_ID } from "../src/patchouli-provider.mjs";

test("switches exclusively between native hooks and the Patchouli provider", async () => {
  const ctx = modeContext();
  const dependencies = backendDependencies();
  registerMemoraxCodePlugin(ctx, dependencies);

  assert.equal(ctx.listenerCount("agent/pre-step"), 1);
  assert.equal(ctx.listenerCount("session/event"), 1);

  const patchouli = patchouliService(ctx);
  ctx.setService("patchouli", patchouli);
  await settle();

  assert.equal(ctx.listenerCount("agent/pre-step"), 0);
  assert.equal(ctx.listenerCount("session/event"), 0);
  assert.equal(patchouli.plugin?.id, PATCHOULI_PROVIDER_ID);
  assert.deepEqual(patchouli.nativeListenerCountsAtRegistration, [0, 0]);

  ctx.setService("patchouli", undefined);
  await settle();

  assert.equal(patchouli.plugin, undefined);
  assert.deepEqual(patchouli.nativeListenerCountsAtUnregistration, [0, 0]);
  assert.equal(ctx.listenerCount("agent/pre-step"), 1);
  assert.equal(ctx.listenerCount("session/event"), 1);

  await ctx.dispose();
  assert.equal(ctx.listenerCount("agent/pre-step"), 0);
  ctx.setService("patchouli", patchouli);
  await settle();
  assert.equal(patchouli.plugin, undefined, "plugin disposal must not restart an integration");
});

test("maps official agent-loop calls to the existing MemoraX Backend protocol", async () => {
  const turnStarts = [];
  const writebacks = [];
  const ctx = modeContext();
  const patchouli = patchouliService(ctx);
  ctx.setService("patchouli", patchouli, false);
  registerMemoraxCodePlugin(ctx, {
    ...backendDependencies(),
    backendClient: {
      async recordTurnStart(command) {
        turnStarts.push(command);
        return { ok: true, additionalContext: "Relevant MemoraX context" };
      },
      async writebackTurn(command) {
        writebacks.push(command);
        return { ok: true, scheduled: true };
      },
    },
  });

  const provider = patchouli.plugin;
  assert.ok(provider);
  assert.equal(provider.filter({
    operation: "retrieve",
    meta: callMeta("agent/pre-step", { turn: 1, step: 1 }),
  }), true);
  assert.equal(provider.filter({
    operation: "retrieve",
    meta: callMeta("tool/memory-retrieve"),
  }), false);

  const user = {
    id: "user-1",
    role: "user",
    content: [{ type: "text", text: "How should this work?" }],
    source: { kind: "user" },
  };
  const header = sessionHeader();
  const start = event("turn/start", 4, { turn: 1 });
  const retrieval = {
    meta: callMeta("agent/pre-step", { turn: 1, step: 1 }),
    data: {
      agent: { id: header.id, status: "running", options: {} },
      session: { header, events: [start] },
      turn: 1,
      step: 1,
      messages: [user],
    },
  };
  assert.deepEqual(await provider.retrieve(retrieval, {}), {
    text: "Relevant MemoraX context",
  });
  assert.equal(await provider.retrieve(retrieval, {}), null);
  assert.deepEqual(turnStarts, [{
    version: 1,
    client: "dsh",
    sessionId: "session-1",
    turn: 1,
    startSeq: 4,
    cwd: "/workspace/project",
    prompt: "How should this work?",
  }]);

  const end = event("turn/end", 6, { turn: 1, reason: { kind: "completed" } });
  const events = [
    start,
    event("user/message", 5, user),
    end,
  ];
  assert.deepEqual(await provider.update({
    meta: callMeta("session/turn-end", { turn: 1, outcome: "completed" }),
    data: {
      agent: { id: header.id, status: "running", options: {} },
      session: { header, events },
      event: end,
      events,
    },
  }, {}), { ok: true, scheduled: true });
  assert.equal(writebacks.length, 1);
  assert.deepEqual(writebacks[0].events.map(({ seq }) => seq), [4, 5, 6]);
  assert.equal(writebacks[0].sessionHeader.id, header.id);

  await assert.rejects(provider.retrieve({
    ...retrieval,
    data: {
      ...retrieval.data,
      session: {
        ...retrieval.data.session,
        header: sessionHeader({ origin: "subagent", delegationDepth: 1 }),
      },
    },
  }, {}), /not eligible/);

  await ctx.dispose();
});

test("drains a Patchouli writeback before restoring native hooks", async () => {
  const writeback = Promise.withResolvers();
  const ctx = modeContext();
  const patchouli = patchouliService(ctx);
  ctx.setService("patchouli", patchouli, false);
  registerMemoraxCodePlugin(ctx, {
    ...backendDependencies(),
    backendClient: {
      async recordTurnStart() { return { ok: true }; },
      async writebackTurn() { return await writeback.promise; },
    },
  });

  const header = sessionHeader();
  const events = [
    event("turn/start", 0, { turn: 1 }),
    event("turn/end", 1, { turn: 1, reason: { kind: "completed" } }),
  ];
  const updating = patchouli.plugin.update({
    meta: callMeta("session/turn-end", { turn: 1, outcome: "completed" }),
    data: {
      session: { header, events },
      event: events[1],
      events,
    },
  }, {});
  await settle();

  ctx.setService("patchouli", undefined);
  await settle();
  assert.equal(ctx.listenerCount("agent/pre-step"), 0);
  assert.equal(ctx.listenerCount("session/event"), 0);

  writeback.resolve({ ok: true });
  await updating;
  await settle();
  assert.equal(ctx.listenerCount("agent/pre-step"), 1);
  assert.equal(ctx.listenerCount("session/event"), 1);

  await ctx.dispose();
});

test("reports Patchouli activation failure without overlapping native fallback", async () => {
  const ctx = modeContext();
  registerMemoraxCodePlugin(ctx, backendDependencies());
  ctx.setService("patchouli", {
    register() { throw new Error("provider id already registered"); },
  });
  await settle();

  assert.equal(ctx.listenerCount("agent/pre-step"), 0);
  assert.equal(ctx.listenerCount("session/event"), 0);
  assert.deepEqual(ctx.errors, [
    "memorax-code DSH integration switch failed: provider id already registered",
  ]);

  ctx.setService("patchouli", undefined);
  await settle();
  assert.equal(ctx.listenerCount("agent/pre-step"), 1);
  await ctx.dispose();
});

function backendDependencies() {
  return {
    backendClient: {
      async recordTurnStart() { return { ok: true }; },
      async writebackTurn() { return { ok: true }; },
    },
    createUserMessage: createDshUserMessage,
  };
}

function callMeta(point, attributes = {}) {
  return {
    source: { type: "agent-loop", id: "dsh-patchouli-agent-loop" },
    scope: "/workspace/project",
    attributes: {
      point,
      sessionId: "session-1",
      workspaceRoot: "/workspace/project",
      ...attributes,
    },
  };
}

function sessionHeader(overrides = {}) {
  return {
    version: 0,
    id: "session-1",
    createdAt: 1,
    cwd: "/workspace/project",
    ...overrides,
  };
}

function event(type, seq, data) {
  return { type, seq, time: seq + 1, data };
}

function patchouliService(ctx) {
  return {
    plugin: undefined,
    nativeListenerCountsAtRegistration: undefined,
    nativeListenerCountsAtUnregistration: undefined,
    register(plugin) {
      this.nativeListenerCountsAtRegistration = [
        ctx.listenerCount("agent/pre-step"),
        ctx.listenerCount("session/event"),
      ];
      this.plugin = plugin;
      return () => {
        this.nativeListenerCountsAtUnregistration = [
          ctx.listenerCount("agent/pre-step"),
          ctx.listenerCount("session/event"),
        ];
        this.plugin = undefined;
      };
    },
  };
}

function modeContext() {
  const handlers = new Map();
  const services = new Map();
  const disposers = [];
  const errors = [];
  const context = {
    errors,
    logger: { warn() {}, error(message) { errors.push(message); } },
    sessions: { async flush() { return true; } },
    sessionPersistence: { async readFrom() { return undefined; } },
    get(name) {
      return services.get(name);
    },
    on(name, callback) {
      const registered = handlers.get(name) ?? [];
      registered.push(callback);
      handlers.set(name, registered);
      return () => {
        const index = registered.indexOf(callback);
        if (index >= 0) registered.splice(index, 1);
      };
    },
    effect(start) {
      const dispose = start();
      if (typeof dispose === "function") disposers.push(dispose);
      return dispose;
    },
    listenerCount(name) {
      return handlers.get(name)?.length ?? 0;
    },
    setService(name, value, emit = true) {
      if (value === undefined) services.delete(name);
      else services.set(name, value);
      if (emit) {
        for (const callback of [...handlers.get("internal/service") ?? []]) {
          callback(name, value);
        }
      }
    },
    async dispose() {
      for (const dispose of disposers.reverse()) await dispose();
    },
  };
  return context;
}

async function settle() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}
