import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  isMemorySkillReminderDue,
  memorySkillReminderContext,
  personalMemoryReminderContext,
} from "../../memorax-code-adapter-common/src/hooks/memory-skill-reminder-policy.mjs";
import { createDshUserMessage } from "../src/dsh-message.mjs";
import { loadDshPersonalContext } from "../src/personal-context.mjs";
import {
  isMemoryEligibleSession,
  registerMemoraxCodePlugin,
} from "../src/plugin.mjs";

const MEMORY_REMINDER_CONTEXT = memorySkillReminderContext("/memorax-code");
const PERSONAL_MEMORY_REMINDER_CONTEXT = personalMemoryReminderContext("/memorax-code");

test("retrieves once and writes the exact durable top-level DSH Turn", async () => {
  const deferred = [];
  const calls = [];
  const personalContextCalls = [];
  const scheduledRepos = [];
  const reminders = [];
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
        repoMemoryWorktree: "/workspace/authorized-project",
      };
    },
    async recordSkillReminder(command) {
      calls.push("backend:skill-reminder");
      reminders.push(command);
      return { ok: true };
    },
    async writebackTurn(command) {
      calls.push("backend:writeback");
      writebacks.push(command);
      return { ok: true, scheduled: true };
    },
  };
  registerMemoraxCodePlugin(ctx, pluginDependencies({
    backendClient,
    createUserMessage: createDshUserMessage,
    defer: (callback) => deferred.push(callback),
    loadPersonalContext: async (input) => {
      personalContextCalls.push(input);
      return {
        ...(input.includeProfile ? { profileContext: "Active user profile" } : {}),
        ...(input.includeProcedure ? { procedureContext: "Active procedure memory" } : {}),
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
    form: "notice",
    summary: "MemoraX Code",
  });
  assertContext(decision, "Relevant shared memory", MEMORY_REMINDER_CONTEXT,
    PERSONAL_MEMORY_REMINDER_CONTEXT, "Active user profile", "Active procedure memory");
  assert.deepEqual(reminders, [{
    version: 1,
    client: "dsh",
    sessionId: "session-1",
    turn: 1,
    cwd: "/workspace/project",
    content: [
      MEMORY_REMINDER_CONTEXT,
      PERSONAL_MEMORY_REMINDER_CONTEXT,
      "Active user profile",
      "Active procedure memory",
    ].join("\n\n"),
    triggers: ["cadence"],
  }]);
  assert.deepEqual(personalContextCalls, [{
    cwd: "/workspace/authorized-project",
    includeProfile: true,
    includeProcedure: true,
  }]);
  assert.deepEqual(scheduledRepos, ["/workspace/authorized-project"]);
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
  assert.equal(isMemoryEligibleSession(topLevelSession({ origin: "unknown" })), false);
  assert.equal(personalContextCalls.length, 1, "subagent sessions do not read local personal context");

  const fork = topLevelSession({
    id: "fork-1",
    parentSession: session.id,
    seedLength: 10,
    delegationDepth: 0,
    events: [
      event("turn/start", 0, { turn: 1 }),
      ...Array.from({ length: 9 }, (_, index) => event("seed/history", index + 1, {})),
    ],
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
  assertContext(forkDecision, "Relevant shared memory", MEMORY_REMINDER_CONTEXT,
    PERSONAL_MEMORY_REMINDER_CONTEXT, "Active user profile", "Active procedure memory");

  for (let turn = 3; turn <= 6; turn += 1) {
    const beforeCadence = await runTurnStartStep(ctx, fork, turn, fork.events.length);
    assert.doesNotMatch(beforeCadence.messages.at(-1).content[0].text, /MemoraX Code reminder:/);
  }
  const nextCadence = await runTurnStartStep(ctx, fork, 7, fork.events.length);
  assertContext(nextCadence, "Relevant shared memory", MEMORY_REMINDER_CONTEXT, "Active procedure memory");
});

test("anchors Procedure Memory cadence to the first observed Turn without repeating User Profile", async () => {
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

  const turnFive = await runTurnStartStep(ctx, session, 5, 0);
  assertContext(turnFive, MEMORY_REMINDER_CONTEXT, PERSONAL_MEMORY_REMINDER_CONTEXT,
    "User Profile", "Procedure Memory");

  for (let turn = 6; turn <= 9; turn += 1) {
    const beforeCadence = await runTurnStartStep(ctx, session, turn, turn * 10);
    assert.equal(beforeCadence.messages.length, 1);
  }

  const turnTen = await runTurnStartStep(ctx, session, 10, 100);
  assertContext(turnTen, MEMORY_REMINDER_CONTEXT, "Procedure Memory");
  const duplicateTurnTen = await ctx.waterfall("agent/pre-step", preStep(session, 10, 1), enterDecision());
  assert.equal(duplicateTurnTen.messages.length, 1);

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

test("restores User Profile after compaction and combines it with a cadence reminder", async () => {
  const personalContextCalls = [];
  const reminders = [];
  const session = topLevelSession();
  const ctx = mockContext({
    flush: async () => true,
    readFrom: async () => undefined,
  });
  registerMemoraxCodePlugin(ctx, pluginDependencies({
    backendClient: reminderBackend(reminders, "/workspace/authorized-project"),
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
  assertContext(restored, PERSONAL_MEMORY_REMINDER_CONTEXT, "User Profile 2");

  for (let turn = 2; turn <= 5; turn += 1) {
    await runTurnStartStep(ctx, session, turn, turn * 10);
  }
  ctx.emit("session/event", session, event("compaction/end", 55, {}));
  const combined = await runTurnStartStep(ctx, session, 6, 60);
  assertContext(combined, MEMORY_REMINDER_CONTEXT, PERSONAL_MEMORY_REMINDER_CONTEXT,
    "User Profile 3", "Procedure Memory");

  ctx.emit("session/event", session, event("compaction/end", 61, { error: "failed" }));
  const afterFailure = await ctx.waterfall("agent/pre-step", preStep(session, 1, 3), enterDecision());
  assert.equal(afterFailure.messages.length, 1);
  assert.deepEqual(personalContextCalls.map(({ includeProfile, includeProcedure }) => [
    includeProfile,
    includeProcedure,
  ]), [[true, true], [true, false], [true, true]]);
  assert.equal(personalContextCalls.every(({ cwd }) => cwd === "/workspace/authorized-project"), true);
  assert.deepEqual(reminders.map((reminder) => reminder.triggers), [
    ["cadence"],
    ["post_compaction"],
    ["cadence", "post_compaction"],
  ]);
});

test("restores a pending post-compaction reminder from the native session log", async () => {
  const reminders = [];
  const priorReminder = {
    id: "prior-reminder",
    role: "user",
    content: [{
      type: "text",
      text: [MEMORY_REMINDER_CONTEXT, PERSONAL_MEMORY_REMINDER_CONTEXT, "Earlier User Profile"].join("\n\n"),
    }],
    source: {
      kind: "plugin",
      plugin: "memorax-code-dsh",
      form: "notice",
      summary: "MemoraX Code",
    },
  };
  const session = topLevelSession({
    events: [
      event("turn/start", 0, { turn: 1 }),
      event("user/message", 1, priorReminder),
      event("compaction/end", 2, { compactionId: "compact-1", turn: 1 }),
      event("session/end-seed", 3, {}),
    ],
  });
  const ctx = mockContext({
    flush: async () => true,
    readFrom: async () => undefined,
  });
  registerMemoraxCodePlugin(ctx, pluginDependencies({
    backendClient: reminderBackend(reminders),
    loadPersonalContext: async () => ({ profileContext: "Restored User Profile" }),
  }));

  const restored = await runTurnStartStep(ctx, session, 2, 4);
  assertContext(restored, PERSONAL_MEMORY_REMINDER_CONTEXT, "Restored User Profile");
  assert.deepEqual(reminders.map((reminder) => reminder.triggers), [["post_compaction"]]);
});

test("commits and traces a reminder only after DSH accepts its user message", async () => {
  const reminders = [];
  let personalContextLoads = 0;
  const runtime = {
    acceptMessages: false,
    flush: async () => false,
    readFrom: async () => undefined,
  };
  const session = topLevelSession();
  const ctx = mockContext(runtime);
  registerMemoraxCodePlugin(ctx, pluginDependencies({
    backendClient: reminderBackend(reminders),
    loadPersonalContext: async () => {
      personalContextLoads += 1;
      return { profileContext: "User Profile", procedureContext: "Procedure Memory" };
    },
  }));

  const cancelled = await runTurnStartStep(ctx, session, 1, 0);
  assert.match(cancelled.messages.at(-1).content[0].text, /MemoraX Code reminder:/);
  assert.deepEqual(reminders, []);
  ctx.emit("session/event", session, event("turn/end", 1, {
    turn: 1,
    reason: { kind: "aborted", reason: "cancelled" },
  }));

  runtime.acceptMessages = true;
  const retried = await runTurnStartStep(ctx, session, 2, 2);
  assertContext(retried, MEMORY_REMINDER_CONTEXT, PERSONAL_MEMORY_REMINDER_CONTEXT,
    "User Profile", "Procedure Memory");
  assert.equal(personalContextLoads, 2);
  assert.deepEqual(reminders.map((reminder) => reminder.triggers), [["cadence"]]);
});

test("does not read local personal context when Backend retrieval fails", async () => {
  const scheduledRepos = [];
  let personalContextLoads = 0;
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
    loadPersonalContext: async () => {
      personalContextLoads += 1;
      return {
        profileContext: "User Profile",
        procedureContext: "Procedure Memory",
      };
    },
    scheduleRepoMemoryBuild: (repo) => scheduledRepos.push(repo),
  }));

  const decision = await runTurnStartStep(ctx, session, 1, 0);
  assertContext(decision, MEMORY_REMINDER_CONTEXT);
  assert.equal(personalContextLoads, 0);
  assert.deepEqual(scheduledRepos, []);
});

test("loads personal context only after Backend authorizes a repository worktree", async () => {
  const personalContextCalls = [];
  const scheduledRepos = [];
  let turnStarts = 0;
  const session = topLevelSession();
  const ctx = mockContext({
    flush: async () => true,
    readFrom: async () => undefined,
  });
  registerMemoraxCodePlugin(ctx, pluginDependencies({
    backendClient: {
      async recordTurnStart() {
        turnStarts += 1;
        return turnStarts === 1
          ? { ok: true }
          : { ok: true, repoMemoryWorktree: "/workspace/authorized-project" };
      },
      async writebackTurn() {},
    },
    loadPersonalContext: async (input) => {
      personalContextCalls.push(input);
      return { profileContext: "User Profile", procedureContext: "Procedure Memory" };
    },
    scheduleRepoMemoryBuild: (repo) => scheduledRepos.push(repo),
  }));

  const unauthorized = await runTurnStartStep(ctx, session, 1, 0);
  assertContext(unauthorized, MEMORY_REMINDER_CONTEXT);
  assert.deepEqual(personalContextCalls, []);
  assert.deepEqual(scheduledRepos, []);

  const authorized = await runTurnStartStep(ctx, session, 2, 10);
  assertContext(authorized, "User Profile", "Procedure Memory");
  assert.deepEqual(personalContextCalls, [{
    cwd: "/workspace/authorized-project",
    includeProfile: true,
    includeProcedure: true,
  }]);
  assert.deepEqual(scheduledRepos, ["/workspace/authorized-project"]);
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
          ? {
              ok: true,
              additionalContext: "Relevant shared memory",
              repoMemoryWorktree: "/workspace/project",
            }
          : { ok: true, repoMemoryWorktree: "/workspace/project" };
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
  assertContext(decision, "Relevant shared memory", MEMORY_REMINDER_CONTEXT);
  const sameTurn = await ctx.waterfall("agent/pre-step", preStep(session, 1, 2), enterDecision());
  assert.equal(sameTurn.messages.length, 1);
  assert.equal(personalContextAttempts, 1);

  const retry = await runTurnStartStep(ctx, session, 2, 10);
  assertContext(retry, "User Profile", "Procedure Memory");
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
  assert.equal(personalContextAttempts, 0);

  const followerController = new AbortController();
  const follower = ctx.waterfall("agent/pre-step", {
    ...preStep(session, 1, 1),
    signal: followerController.signal,
  }, enterDecision());
  await new Promise((resolve) => setImmediate(resolve));
  followerController.abort(new Error("duplicate step cancelled"));
  const cancelledFollower = await follower;
  assert.equal(cancelledFollower.messages.length, 1);

  enabled = false;
  retrieval.resolve({ ok: true, repoMemoryWorktree: "/workspace/project" });
  const disabled = await pending;
  assert.equal(disabled.messages.length, 1);
  assert.equal(personalContextAttempts, 0);

  enabled = true;
  const retried = await ctx.waterfall("agent/pre-step", preStep(session, 1, 2), enterDecision());
  assertContext(retried, "User Profile", "Procedure Memory");
  assert.equal(personalContextAttempts, 1);
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
    createUserMessage: createDshUserMessage,
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
    createUserMessage: createDshUserMessage,
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
    createUserMessage: createDshUserMessage,
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

test("aborts in-flight retrieval during Cordis disposal", async () => {
  const started = Promise.withResolvers();
  const ctx = mockContext({
    flush: async () => true,
    readFrom: async () => undefined,
  });
  registerMemoraxCodePlugin(ctx, pluginDependencies({
    backendClient: {
      async recordTurnStart(_command, { signal }) {
        started.resolve(signal);
        await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      async writebackTurn() {},
    },
    createUserMessage: createDshUserMessage,
  }));

  const session = topLevelSession();
  ctx.emit("session/event", session, event("turn/start", 0, { turn: 1 }));
  const retrieving = ctx.waterfall("agent/pre-step", {
    agent: { id: session.id, session },
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }, async () => ({
    kind: "enter",
    messages: [{
      id: "user-1",
      role: "user",
      content: [{ type: "text", text: "recall" }],
      source: { kind: "user" },
    }],
  }));

  const retrievalSignal = await started.promise;
  await ctx.dispose();
  assert.equal(retrievalSignal.aborted, true);
  assert.equal((await retrieving).messages.length, 1);
});

function pluginDependencies(overrides = {}) {
  return {
    assertEnabled: () => undefined,
    backendClient: {
      async recordTurnStart() {
        return { ok: true, repoMemoryWorktree: "/workspace/project" };
      },
      async writebackTurn() { return { ok: true, scheduled: true }; },
    },
    createUserMessage: (input) => ({
      id: "memorax-context",
      role: "user",
      ...structuredClone(input),
    }),
    intervalTurns: 5,
    isReminderDue: isMemorySkillReminderDue,
    loadPersonalContext: async () => ({}),
    memoryReminderContext: MEMORY_REMINDER_CONTEXT,
    personalMemoryReminderContext: PERSONAL_MEMORY_REMINDER_CONTEXT,
    ...overrides,
  };
}

function reminderBackend(reminders, repoMemoryWorktree = "/workspace/project") {
  return {
    async recordTurnStart() { return { ok: true, repoMemoryWorktree }; },
    async recordSkillReminder(command) { reminders.push(command); },
    async writebackTurn() {},
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

function assertContext(decision, ...parts) {
  assert.equal(decision.messages.at(-1).content[0].text, parts.join("\n\n"));
}

function topLevelSession(overrides = {}) {
  const { events = [], ...headerOverrides } = overrides;
  const id = headerOverrides.id ?? "session-1";
  return {
    id,
    events,
    header: {
      version: 0,
      id,
      createdAt: 1,
      cwd: "/workspace/project",
      ...headerOverrides,
    },
  };
}

function event(type, seq, data) {
  return { type, seq, time: seq + 1, data };
}

function mockContext(runtime) {
  const handlers = new Map();
  const disposers = [];
  const context = {
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
      if (name === "session/event") {
        const [session, sessionEvent] = args;
        if (Array.isArray(session?.events) && !session.events.includes(sessionEvent)) {
          session.events.push(sessionEvent);
        }
      }
      for (const callback of handlers.get(name) ?? []) callback(...args);
    },
    async waterfall(name, payload, next) {
      const [callback] = handlers.get(name) ?? [];
      assert.ok(callback, `missing ${name} listener`);
      const decision = await callback(payload, next);
      if (runtime.acceptMessages !== false && decision?.kind === "enter") {
        for (const message of decision.messages ?? []) {
          if (message?.source?.kind !== "plugin" || message.source.plugin !== "memorax-code-dsh") continue;
          const session = payload.agent?.session;
          const seq = Array.isArray(session?.events) ? session.events.length : 0;
          context.emit("session/event", session, event("user/message", seq, message));
        }
      }
      return decision;
    },
    async dispose() {
      for (const dispose of disposers.reverse()) await dispose();
    },
  };
  return context;
}
