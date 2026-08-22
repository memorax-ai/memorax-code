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

test("survives an initial Patchouli activation failure and mounts when the service leaves", async () => {
  const ctx = modeContext();
  ctx.setService("patchouli", {
    register() { throw new Error("provider id already registered"); },
  }, false);

  assert.doesNotThrow(() => registerMemoraxCodePlugin(ctx, backendDependencies()));
  assert.equal(ctx.listenerCount("agent/pre-step"), 0);
  assert.equal(ctx.listenerCount("session/event"), 0);
  assert.deepEqual(ctx.errors, [
    "memorax-code DSH integration switch failed: provider id already registered",
  ]);

  ctx.setService("patchouli", undefined);
  await settle();
  assert.equal(ctx.listenerCount("agent/pre-step"), 1);
  assert.equal(ctx.listenerCount("session/event"), 1);
  await ctx.dispose();
});

test("native mode completes a turn that started while Patchouli was active", async () => {
  const writebacks = [];
  const header = sessionHeader();
  const start = event("turn/start", 10, { turn: 3 });
  const user = {
    id: "user-3",
    role: "user",
    content: [{ type: "text", text: "Continue after the provider leaves." }],
    source: { kind: "user" },
  };
  const session = {
    id: header.id,
    header,
    events: [start, event("user/message", 11, user)],
  };
  const ctx = modeContext({
    readFrom: async () => ({ meta: header, events: session.events }),
  });
  const patchouli = patchouliService(ctx);
  ctx.setService("patchouli", patchouli, false);
  registerMemoraxCodePlugin(ctx, {
    ...backendDependencies(),
    backendClient: {
      async recordTurnStart() { return { ok: true }; },
      async writebackTurn(command) {
        writebacks.push(command);
        return { ok: true };
      },
    },
  });

  await patchouli.plugin.retrieve({
    meta: callMeta("agent/pre-step", { turn: 3, step: 1 }),
    data: {
      agent: { id: header.id, status: "running", options: {} },
      session: { header, events: session.events },
      turn: 3,
      step: 1,
      messages: [user],
    },
  }, {});

  ctx.setService("patchouli", undefined);
  await settle();
  const end = event("turn/end", 12, { turn: 3, reason: { kind: "completed" } });
  session.events.push(end);
  await ctx.emit("session/event", session, end);
  await settle();

  assert.equal(writebacks.length, 1);
  assert.equal(writebacks[0].startSeq, 10);
  assert.equal(writebacks[0].endSeq, 12);
  assert.deepEqual(writebacks[0].events.map(({ seq }) => seq), [10, 11, 12]);
  await ctx.dispose();
});

test("Patchouli mode preserves Repo Memory, personal context, and reminder tracing", async () => {
  const scheduled = [];
  const reminders = [];
  const header = sessionHeader();
  const start = event("turn/start", 20, { turn: 4 });
  const user = {
    id: "user-4",
    role: "user",
    content: [{ type: "text", text: "Use all available memory." }],
    source: { kind: "user" },
  };
  const ctx = modeContext();
  const patchouli = patchouliService(ctx);
  ctx.setService("patchouli", patchouli, false);
  registerMemoraxCodePlugin(ctx, {
    ...backendDependencies(),
    backendClient: {
      async recordTurnStart() {
        return {
          ok: true,
          additionalContext: "Backend recall",
          repoMemoryWorktree: "/workspace/verified",
        };
      },
      async recordSkillReminder(command) {
        reminders.push(command);
        return { ok: true };
      },
      async writebackTurn() { return { ok: true }; },
    },
    isReminderDue: () => true,
    loadPersonalContext: async ({ cwd, includeProfile, includeProcedure }) => {
      assert.equal(cwd, "/workspace/verified");
      assert.equal(includeProfile, true);
      assert.equal(includeProcedure, true);
      return {
        profileContext: "User Profile",
        procedureContext: "Procedure Memory",
      };
    },
    scheduleRepoMemoryBuild: worktree => scheduled.push(worktree),
  });

  const request = {
    meta: callMeta("agent/pre-step", { turn: 4, step: 1 }),
    data: {
      agent: { id: header.id, status: "running", options: {} },
      session: { header, events: [start] },
      turn: 4,
      step: 1,
      messages: [user],
    },
  };
  const result = await patchouli.plugin.retrieve(request, {});
  assert.deepEqual(scheduled, ["/workspace/verified"]);
  assert.deepEqual(result, {
    text: [
      "Backend recall",
      "Use the memorax-code skill.",
      "Review personal memory.",
      "User Profile",
      "Procedure Memory",
    ].join("\n\n"),
  });

  const accepted = event("user/message", 21, {
    role: "user",
    source: { kind: "plugin", plugin: "dsh-patchouli-agent-loop" },
    content: [{
      type: "text",
      text: JSON.stringify({
        kind: "patchouli-memory-results",
        point: "agent/pre-step",
        results: [{ pluginId: PATCHOULI_PROVIDER_ID, data: result }],
      }),
    }],
  });
  assert.equal(await patchouli.plugin.retrieve({
    ...request,
    meta: callMeta("agent/pre-step", { turn: 4, step: 2 }),
    data: {
      ...request.data,
      session: { header, events: [start, accepted] },
      step: 2,
    },
  }, {}), null);
  await settle();

  assert.equal(reminders.length, 1);
  assert.equal(reminders[0].sessionId, header.id);
  assert.equal(reminders[0].turn, 4);
  assert.deepEqual(reminders[0].triggers, ["cadence"]);
  await ctx.dispose();
});

function backendDependencies() {
  return {
    assertEnabled() {},
    backendClient: {
      async recordTurnStart() { return { ok: true }; },
      async writebackTurn() { return { ok: true }; },
    },
    createUserMessage: createDshUserMessage,
    intervalTurns: 20,
    isReminderDue: () => false,
    loadPersonalContext: async () => ({}),
    memoryReminderContext: "Use the memorax-code skill.",
    personalMemoryReminderContext: "Review personal memory.",
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

function modeContext(options = {}) {
  const handlers = new Map();
  const services = new Map();
  const disposers = [];
  const errors = [];
  const context = {
    errors,
    logger: { warn() {}, error(message) { errors.push(message); } },
    sessions: { flush: options.flush ?? (async () => true) },
    sessionPersistence: { readFrom: options.readFrom ?? (async () => undefined) },
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
    async emit(name, ...args) {
      for (const callback of [...handlers.get(name) ?? []]) {
        await callback(...args);
      }
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
