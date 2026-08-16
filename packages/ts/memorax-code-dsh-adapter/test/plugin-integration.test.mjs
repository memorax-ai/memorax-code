import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { isMemorySkillReminderDue } from "../../memorax-code-adapter-common/src/hooks/memory-skill-reminder-policy.mjs";
import { loadDshPersonalContext } from "../src/personal-context.mjs";
import { registerMemoraxCodePlugin } from "../src/plugin.mjs";

test("retrieves once and writes the exact durable top-level DSH Turn", async () => {
  const deferred = [];
  const calls = [];
  const personalContextCalls = [];
  const scheduledRepos = [];
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
      return {
        ok: true,
        additionalContext: "Relevant shared memory",
        repoMemoryWorktree: "/workspace/project",
      };
    },
    async writebackTurn(command) {
      calls.push("backend:writeback");
      writebacks.push(command);
      return { ok: true, scheduled: true };
    },
  };
  registerMemoraxCodePlugin(ctx, pluginDependencies({
    backendClient,
    createUserMessage: (input) => ({ id: "context-1", role: "user", ...structuredClone(input) }),
    defer: (callback) => deferred.push(callback),
    loadPersonalContext: async (input) => {
      personalContextCalls.push(input);
      return {
        profileContext: "Active user profile",
        procedureContext: "Active procedure memory",
      };
    },
    scheduleRepoMemoryBuild: (repo) => scheduledRepos.push(repo),
  }));

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
  assert.deepEqual(decision.messages[2].source, {
    kind: "plugin",
    plugin: "memorax-code-dsh",
    form: "context",
  });
  assert.equal(decision.messages[2].content[0].text, [
    "Relevant shared memory",
    "Active user profile",
    "Active procedure memory",
  ].join("\n\n"));
  assert.deepEqual(personalContextCalls, [{
    cwd: "/workspace/project",
    includeProfile: true,
    includeProcedure: true,
  }]);
  assert.deepEqual(scheduledRepos, ["/workspace/project"]);
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
  assert.equal(writebacks[0].events.find(({ seq }) => seq === 7).data.source.plugin, "memorax-code-dsh");
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
  assert.equal(personalContextCalls.length, 1, "subagent sessions do not read local personal context");

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
  assert.equal(personalContextCalls.length, 2, "an ordinary user fork gets first-observation context");
});

test("injects Procedure Memory on the native Turn cadence without repeating User Profile", async () => {
  const personalContextCalls = [];
  const session = topLevelSession();
  const ctx = mockContext({
    flush: async () => true,
    readFrom: async () => undefined,
  });
  registerMemoraxCodePlugin(ctx, pluginDependencies({
    loadPersonalContext: async (input) => {
      personalContextCalls.push(input);
      return {
        ...(input.includeProfile ? { profileContext: "User Profile" } : {}),
        ...(input.includeProcedure ? { procedureContext: "Procedure Memory" } : {}),
      };
    },
  }));

  const turnOne = await runTurnStartStep(ctx, session, 1, 0);
  assert.equal(turnOne.messages.at(-1).content[0].text, "User Profile\n\nProcedure Memory");

  const turnTwo = await runTurnStartStep(ctx, session, 2, 10);
  assert.equal(turnTwo.messages.length, 1);

  const turnSix = await runTurnStartStep(ctx, session, 6, 20);
  assert.equal(turnSix.messages.at(-1).content[0].text, "Procedure Memory");
  const duplicateTurnSix = await ctx.waterfall("agent/pre-step", preStep(session, 6, 1), enterDecision());
  assert.equal(duplicateTurnSix.messages.length, 1);

  assert.deepEqual(personalContextCalls, [
    {
      cwd: "/workspace/project",
      includeProfile: true,
      includeProcedure: true,
    },
    {
      cwd: "/workspace/project",
      includeProfile: false,
      includeProcedure: true,
    },
  ]);
});

test("restores only User Profile after successful compaction", async () => {
  const personalContextCalls = [];
  const session = topLevelSession();
  const ctx = mockContext({
    flush: async () => true,
    readFrom: async () => undefined,
  });
  registerMemoraxCodePlugin(ctx, pluginDependencies({
    loadPersonalContext: async (input) => {
      personalContextCalls.push(input);
      return {
        ...(input.includeProfile ? { profileContext: `User Profile ${personalContextCalls.length}` } : {}),
        ...(input.includeProcedure ? { procedureContext: "Procedure Memory" } : {}),
      };
    },
  }));

  await runTurnStartStep(ctx, session, 1, 0);
  ctx.emit("session/event", session, event("compaction/end", 4, {}));
  const restored = await ctx.waterfall("agent/pre-step", preStep(session, 1, 2), enterDecision());
  assert.equal(restored.messages.at(-1).content[0].text, "User Profile 2");

  ctx.emit("session/event", session, event("compaction/end", 5, { error: "failed" }));
  const afterFailure = await ctx.waterfall("agent/pre-step", preStep(session, 1, 3), enterDecision());
  assert.equal(afterFailure.messages.length, 1);
  assert.deepEqual(personalContextCalls, [
    {
      cwd: "/workspace/project",
      includeProfile: true,
      includeProcedure: true,
    },
    {
      cwd: "/workspace/project",
      includeProfile: true,
      includeProcedure: false,
    },
  ]);
});

test("keeps local personal context when Backend retrieval fails", async () => {
  const scheduledRepos = [];
  const session = topLevelSession();
  const ctx = mockContext({
    flush: async () => true,
    readFrom: async () => undefined,
  });
  registerMemoraxCodePlugin(ctx, pluginDependencies({
    backendClient: {
      async recordTurnStart() { throw new Error("Backend unavailable"); },
      async writebackTurn() {},
    },
    loadPersonalContext: async () => ({
      profileContext: "User Profile",
      procedureContext: "Procedure Memory",
    }),
    scheduleRepoMemoryBuild: (repo) => scheduledRepos.push(repo),
  }));

  const decision = await runTurnStartStep(ctx, session, 1, 0);
  assert.equal(decision.messages.at(-1).content[0].text, "User Profile\n\nProcedure Memory");
  assert.deepEqual(scheduledRepos, []);
});

test("keeps Backend recall when local context fails and retries it on the next Turn", async () => {
  let personalContextAttempts = 0;
  let retrievals = 0;
  const session = topLevelSession();
  const ctx = mockContext({
    flush: async () => true,
    readFrom: async () => undefined,
  });
  registerMemoraxCodePlugin(ctx, pluginDependencies({
    backendClient: {
      async recordTurnStart() {
        retrievals += 1;
        return retrievals === 1
          ? { ok: true, additionalContext: "Relevant shared memory" }
          : { ok: true };
      },
      async writebackTurn() {},
    },
    loadPersonalContext: async () => {
      personalContextAttempts += 1;
      if (personalContextAttempts === 1) throw new Error("local read failed");
      return {
        profileContext: "User Profile",
        procedureContext: "Procedure Memory",
      };
    },
  }));

  const decision = await runTurnStartStep(ctx, session, 1, 0);
  assert.equal(decision.messages.at(-1).content[0].text, "Relevant shared memory");
  const sameTurn = await ctx.waterfall("agent/pre-step", preStep(session, 1, 2), enterDecision());
  assert.equal(sameTurn.messages.length, 1);
  assert.equal(personalContextAttempts, 1);

  const retry = await runTurnStartStep(ctx, session, 2, 10);
  assert.equal(retry.messages.at(-1).content[0].text, "User Profile\n\nProcedure Memory");
  assert.equal(personalContextAttempts, 2);
});

test("does not consume personal context when runtime authority is removed mid-step", async () => {
  const retrieval = Promise.withResolvers();
  let enabled = true;
  let personalContextAttempts = 0;
  const session = topLevelSession();
  const ctx = mockContext({
    flush: async () => true,
    readFrom: async () => undefined,
  });
  registerMemoraxCodePlugin(ctx, pluginDependencies({
    assertEnabled: () => {
      if (!enabled) throw new Error("integration disabled");
    },
    backendClient: {
      async recordTurnStart() { return await retrieval.promise; },
      async writebackTurn() {},
    },
    loadPersonalContext: async () => {
      personalContextAttempts += 1;
      return {
        profileContext: "User Profile",
        procedureContext: "Procedure Memory",
      };
    },
  }));

  ctx.emit("session/event", session, event("turn/start", 0, { turn: 1 }));
  const pending = ctx.waterfall("agent/pre-step", preStep(session, 1, 1), enterDecision());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(personalContextAttempts, 1);

  enabled = false;
  retrieval.resolve({ ok: true });
  const disabled = await pending;
  assert.equal(disabled.messages.length, 1);

  enabled = true;
  const retried = await ctx.waterfall("agent/pre-step", preStep(session, 1, 2), enterDecision());
  assert.equal(retried.messages.at(-1).content[0].text, "User Profile\n\nProcedure Memory");
  assert.equal(personalContextAttempts, 2);
});

test("starts at most one personal-context worker for a Turn and compaction generation", async () => {
  const personalContext = Promise.withResolvers();
  let personalContextAttempts = 0;
  const session = topLevelSession();
  const ctx = mockContext({
    flush: async () => true,
    readFrom: async () => undefined,
  });
  registerMemoraxCodePlugin(ctx, pluginDependencies({
    loadPersonalContext: async () => {
      personalContextAttempts += 1;
      return await personalContext.promise;
    },
  }));

  ctx.emit("session/event", session, event("turn/start", 0, { turn: 1 }));
  const first = ctx.waterfall("agent/pre-step", preStep(session, 1, 1), enterDecision());
  const duplicate = ctx.waterfall("agent/pre-step", preStep(session, 1, 1), enterDecision());
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(personalContextAttempts, 1);

  personalContext.resolve({ profileContext: "User Profile" });
  const decisions = await Promise.all([first, duplicate]);
  assert.deepEqual(decisions.map((decision) => decision.messages.length).sort(), [1, 2]);
});

test("loads personal context through a bounded worker process", async () => {
  const profileContext = "偏".repeat(4_000);
  const procedureContext = "程".repeat(4_000);
  const invocation = {};
  const env = { MEMORAX_CODE_HOME: "/memorax-home" };
  const spawnImpl = (executable, args, options) => {
    Object.assign(invocation, { executable, args, options });
    const child = new EventEmitter();
    child.exitCode = null;
    child.killed = false;
    child.kill = () => { child.killed = true; };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    const chunks = [];
    child.stdin.on("data", (chunk) => chunks.push(chunk));
    child.stdin.once("finish", () => {
      invocation.input = Buffer.concat(chunks).toString("utf8");
      const workerOutput = Buffer.from(`${JSON.stringify({ profileContext, procedureContext })}\n`);
      const splitAt = workerOutput.indexOf(Buffer.from("偏")) + 1;
      child.stdout.write(workerOutput.subarray(0, splitAt));
      child.stdout.end(workerOutput.subarray(splitAt));
      queueMicrotask(() => child.emit("close", 0, null));
    });
    return child;
  };

  const result = await loadDshPersonalContext({
    cwd: "/workspace/project",
    includeProfile: true,
    includeProcedure: true,
  }, {
    env,
    nodePath: "/node",
    spawnImpl,
    timeoutMs: 1_000,
    workerPath: "/worker.mjs",
  });

  assert.deepEqual(result, { profileContext, procedureContext });
  assert.deepEqual(invocation, {
    executable: "/node",
    args: ["/worker.mjs"],
    options: {
      env,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    },
    input: `${JSON.stringify({
      cwd: "/workspace/project",
      includeProfile: true,
      includeProcedure: true,
    })}\n`,
  });
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
  registerMemoraxCodePlugin(ctx, pluginDependencies({
    backendClient: {
      async recordTurnStart() { return { ok: true }; },
      async writebackTurn() { writebacks += 1; },
    },
    createUserMessage: (input) => ({ id: "recall", role: "user", ...input }),
    defer: (callback) => deferred.push(callback),
  }));

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
  registerMemoraxCodePlugin(ctx, pluginDependencies({
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
  }));

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
  registerMemoraxCodePlugin(ctx, pluginDependencies({
    backendClient: {
      async recordTurnStart() { return { ok: true }; },
      async writebackTurn() { await write.promise; },
    },
    createUserMessage: (input) => ({ id: "recall", role: "user", ...input }),
    defer: (callback) => deferred.push(callback),
    drainTimeoutMs: 1_000,
  }));

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

function pluginDependencies(overrides = {}) {
  return {
    assertEnabled: () => undefined,
    backendClient: {
      async recordTurnStart() { return { ok: true }; },
      async writebackTurn() { return { ok: true, scheduled: true }; },
    },
    createUserMessage: (input) => ({ id: "memorax-context", role: "user", ...structuredClone(input) }),
    intervalTurns: 5,
    isReminderDue: isMemorySkillReminderDue,
    loadPersonalContext: async () => ({}),
    ...overrides,
  };
}

async function runTurnStartStep(ctx, session, turn, seq) {
  ctx.emit("session/event", session, event("turn/start", seq, { turn }));
  return await ctx.waterfall("agent/pre-step", preStep(session, turn, 1), enterDecision());
}

function preStep(session, turn, step) {
  return {
    agent: { id: session.id, session },
    turn,
    step,
    signal: new AbortController().signal,
  };
}

function enterDecision(text = "How should the adapter work?") {
  return async () => ({
    kind: "enter",
    messages: [{
      id: "user",
      role: "user",
      content: [{ type: "text", text }],
      source: { kind: "user" },
    }],
  });
}

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
