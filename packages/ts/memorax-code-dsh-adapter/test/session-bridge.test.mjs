import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildTurnDiscardCommand,
  buildTurnId,
  buildTurnStartCommand,
  buildWritebackCommand,
  createSessionBridge,
  extractMessageText,
  isDirectUserMessage,
  turnEndCompleted,
} from "../src/session-bridge.mjs";

function textMessage(text) {
  return { content: [{ type: "text", text }], source: { kind: "user" } };
}

function assistantData(text) {
  return { turn: 0, step: 1, message: { content: [{ type: "text", text }], source: { kind: "model" } } };
}

function session(id, extra = {}) {
  return { id, header: { cwd: "/repo" }, firstLiveSeq: 3, ...extra };
}

test("extractMessageText joins text blocks and ignores non-text blocks", () => {
  assert.equal(extractMessageText({ content: [{ type: "text", text: "hello" }] }), "hello");
  assert.equal(extractMessageText({
    content: [
      { type: "text", text: "a" },
      { type: "reasoning", text: "skip me" },
      { type: "text", text: "b" },
    ],
  }), "a\nb");
  assert.equal(extractMessageText(undefined), "");
});

test("isDirectUserMessage detects the human source kind", () => {
  assert.equal(isDirectUserMessage({ source: { kind: "user" } }), true);
  assert.equal(isDirectUserMessage({ source: { kind: "plugin" } }), false);
  assert.equal(isDirectUserMessage(undefined), false);
});

test("buildTurnId combines session first live seq, incarnation, and turn number", () => {
  assert.equal(buildTurnId("session-1", 7, 1, 2), "dsh-7-2");
  assert.equal(buildTurnId("session-1", 7, 2, 2), "dsh-7-g2-2");
  assert.equal(buildTurnId("session-1", 7, 5, 2), "dsh-7-g5-2");
  assert.equal(buildTurnId("session-1", undefined, 1, "3"), "dsh-0-3");
});

test("a complete turn produces a turn-start and a writeback command", async () => {
  const calls = [];
  const bridge = createSessionBridge({
    dispatch: async (path, body) => {
      calls.push({ path, body });
      return { ok: true, body: {} };
    },
  });

  bridge.onSessionCreated(session("session-abc"));
  bridge.onSessionEvent(session("session-abc"), { type: "turn/start", data: { turn: 1 } });
  bridge.onSessionEvent(session("session-abc"), { type: "user/message", data: textMessage("fix the build") });
  bridge.onSessionEvent(session("session-abc"), { type: "assistant/message", data: assistantData("done") });
  bridge.onSessionEvent(session("session-abc"), { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    path: "/memory/turn-start",
    body: {
      version: 1,
      client: "dsh",
      sessionId: "session-abc",
      turnId: "dsh-3-1",
      prompt: "fix the build",
      cwd: "/repo",
    },
  });
  assert.deepEqual(calls[1], {
    path: "/memory/writeback",
    body: {
      version: 1,
      client: "dsh",
      sessionId: "session-abc",
      turnId: "dsh-3-1",
      userText: "fix the build",
      assistantText: "done",
      cwd: "/repo",
    },
  });
});

test("missing assistant message skips the turn writeback", async () => {
  const calls = [];
  const bridge = createSessionBridge({
    dispatch: async (path, body) => {
      calls.push({ path, body });
      return { ok: true, body: {} };
    },
  });

  bridge.onSessionCreated(session("session-skip"));
  bridge.onSessionEvent(session("session-skip"), { type: "turn/start", data: { turn: 0 } });
  bridge.onSessionEvent(session("session-skip"), { type: "user/message", data: textMessage("hello") });
  bridge.onSessionEvent(session("session-skip"), { type: "turn/end", data: { turn: 0, reason: { kind: "error" } } });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((call) => call.path), ["/memory/turn-start", "/memory/turn-discard"]);
  assert.deepEqual(calls[1].body, {
    version: 1,
    client: "dsh",
    sessionId: "session-skip",
    turnId: "dsh-3-0",
  });
});

test("turnEndCompleted only accepts a completed turn end reason", () => {
  assert.equal(turnEndCompleted({ reason: { kind: "completed" } }), true);
  assert.equal(turnEndCompleted({ reason: { kind: "error" } }), false);
  assert.equal(turnEndCompleted({ reason: { kind: "cancelled" } }), false);
  assert.equal(turnEndCompleted({ reason: { kind: "interrupted" } }), false);
  assert.equal(turnEndCompleted(undefined), true);
  assert.equal(turnEndCompleted({}), true);
});

test("an errored turn with partial assistant output does not write back", async () => {
  const calls = [];
  const bridge = createSessionBridge({
    dispatch: async (path, body) => {
      calls.push({ path, body });
      return { ok: true, body: {} };
    },
  });

  bridge.onSessionCreated(session("session-error"));
  bridge.onSessionEvent(session("session-error"), { type: "turn/start", data: { turn: 0 } });
  bridge.onSessionEvent(session("session-error"), { type: "user/message", data: textMessage("run the tests") });
  bridge.onSessionEvent(session("session-error"), { type: "assistant/message", data: assistantData("partial reply") });
  bridge.onSessionEvent(session("session-error"), { type: "turn/end", data: { turn: 0, reason: { kind: "error" } } });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.map((call) => call.path), ["/memory/turn-start", "/memory/turn-discard"]);
});

test("a cancelled turn with partial assistant output does not write back", async () => {
  const calls = [];
  const bridge = createSessionBridge({
    dispatch: async (path, body) => {
      calls.push({ path, body });
      return { ok: true, body: {} };
    },
  });

  bridge.onSessionCreated(session("session-cancel"));
  bridge.onSessionEvent(session("session-cancel"), { type: "turn/start", data: { turn: 0 } });
  bridge.onSessionEvent(session("session-cancel"), { type: "user/message", data: textMessage("run the tests") });
  bridge.onSessionEvent(session("session-cancel"), { type: "assistant/message", data: assistantData("partial reply") });
  bridge.onSessionEvent(session("session-cancel"), { type: "turn/end", data: { turn: 0, reason: { kind: "cancelled" } } });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.map((call) => call.path), ["/memory/turn-start", "/memory/turn-discard"]);
});

test("synthetic plugin messages do not start a turn", async () => {
  const calls = [];
  const bridge = createSessionBridge({
    dispatch: async (path, body) => {
      calls.push({ path, body });
      return { ok: true, body: {} };
    },
  });

  bridge.onSessionCreated(session("session-plugin"));
  bridge.onSessionEvent(session("session-plugin"), { type: "turn/start", data: { turn: 2 } });
  bridge.onSessionEvent(session("session-plugin"), {
    type: "user/message",
    data: { content: [{ type: "text", text: "injected" }], source: { kind: "plugin", plugin: "x" } },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 0);
});

test("additionalContext from turn-start is captured as pending context", async () => {
  const bridge = createSessionBridge({
    dispatch: async (path) => {
      assert.equal(path, "/memory/turn-start");
      return { ok: true, body: { additionalContext: "recalled memory" } };
    },
  });

  bridge.onSessionCreated(session("session-ctx"));
  bridge.onSessionEvent(session("session-ctx"), { type: "turn/start", data: { turn: 4 } });
  bridge.onSessionEvent(session("session-ctx"), { type: "user/message", data: textMessage("query") });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bridge.takePendingContext("session-ctx"), "recalled memory");
  assert.equal(bridge.takePendingContext("session-ctx"), undefined);
});

test("dispatch failures are swallowed without throwing", async () => {
  const errors = [];
  const bridge = createSessionBridge({
    dispatch: async () => {
      throw new Error("backend down");
    },
    debug: (message, detail) => errors.push({ message, detail }),
  });

  bridge.onSessionCreated(session("session-err"));
  bridge.onSessionEvent(session("session-err"), { type: "turn/start", data: { turn: 0 } });
  bridge.onSessionEvent(session("session-err"), { type: "user/message", data: textMessage("query") });
  bridge.onSessionEvent(session("session-err"), { type: "assistant/message", data: assistantData("reply") });
  bridge.onSessionEvent(session("session-err"), { type: "turn/end", data: { turn: 0, reason: { kind: "completed" } } });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 2);
  const messages = errors.map((entry) => entry.message).sort();
  assert.deepEqual(messages, ["turn-start dispatch failed", "writeback dispatch failed"]);
});

test("buildTurnStartCommand and buildWritebackCommand are pure", () => {
  assert.equal(buildTurnStartCommand({}), undefined);
  assert.equal(buildTurnStartCommand({ sessionId: "s", turn: 0 }), undefined);
  assert.equal(buildTurnStartCommand({ sessionId: "s", turn: 0, userText: "p" }).turnId, "dsh-0-0");
  assert.equal(buildWritebackCommand({ sessionId: "s" }, 1, "u", ""), undefined);
  assert.deepEqual(buildWritebackCommand({ sessionId: "s", cwd: "/w" }, 2, "u", "a"), {
    version: 1,
    client: "dsh",
    sessionId: "s",
    turnId: "dsh-0-2",
    userText: "u",
    assistantText: "a",
    cwd: "/w",
  });
});

test("replaying the same turn events does not duplicate a writeback", async () => {
  const calls = [];
  const bridge = createSessionBridge({
    dispatch: async (path, body) => {
      calls.push({ path, body });
      return { ok: true, body: {} };
    },
  });

  bridge.onSessionCreated(session("session-idem"));
  bridge.onSessionEvent(session("session-idem"), { type: "turn/start", data: { turn: 1 } });
  bridge.onSessionEvent(session("session-idem"), { type: "user/message", data: textMessage("once") });
  bridge.onSessionEvent(session("session-idem"), { type: "assistant/message", data: assistantData("reply") });
  bridge.onSessionEvent(session("session-idem"), { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
  bridge.onSessionEvent(session("session-idem"), { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });

  await new Promise((resolve) => setImmediate(resolve));
  const writebacks = calls.filter((call) => call.path === "/memory/writeback");
  assert.equal(writebacks.length, 1);
});

test("writeback is serialized behind a slow turn-start and is not lost", async () => {
  const calls = [];
  let releaseTurnStart;
  const turnStartGate = new Promise((resolve) => { releaseTurnStart = resolve; });
  const bridge = createSessionBridge({
    dispatch: async (path, body) => {
      if (path === "/memory/turn-start") {
        await turnStartGate;
      }
      calls.push({ path, body });
      return { ok: true, body: {} };
    },
  });

  bridge.onSessionCreated(session("session-slow"));
  bridge.onSessionEvent(session("session-slow"), { type: "turn/start", data: { turn: 2 } });
  bridge.onSessionEvent(session("session-slow"), { type: "user/message", data: textMessage("query") });
  bridge.onSessionEvent(session("session-slow"), { type: "assistant/message", data: assistantData("reply") });
  bridge.onSessionEvent(session("session-slow"), { type: "turn/end", data: { turn: 2, reason: { kind: "completed" } } });

  await flushMicrotasks();
  assert.deepEqual(calls.map((call) => call.path), []);

  releaseTurnStart();
  await flushMicrotasks();
  assert.deepEqual(calls.map((call) => call.path), ["/memory/turn-start", "/memory/writeback"]);
  assert.deepEqual(calls[1].body, {
    version: 1,
    client: "dsh",
    sessionId: "session-slow",
    turnId: "dsh-3-2",
    userText: "query",
    assistantText: "reply",
    cwd: "/repo",
  });
});

test("an interrupted turn sends a discard command instead of a writeback", async () => {
  const calls = [];
  const bridge = createSessionBridge({
    dispatch: async (path, body) => {
      calls.push({ path, body });
      return { ok: true, body: {} };
    },
  });

  bridge.onSessionCreated(session("session-discard"));
  bridge.onSessionEvent(session("session-discard"), { type: "turn/start", data: { turn: 1 } });
  bridge.onSessionEvent(session("session-discard"), { type: "user/message", data: textMessage("query") });
  bridge.onSessionEvent(session("session-discard"), { type: "assistant/message", data: assistantData("partial") });
  bridge.onSessionEvent(session("session-discard"), { type: "turn/end", data: { turn: 1, reason: { kind: "interrupted" } } });

  await flushMicrotasks();
  assert.deepEqual(calls.map((call) => call.path), ["/memory/turn-start", "/memory/turn-discard"]);
  assert.deepEqual(calls[1].body, {
    version: 1,
    client: "dsh",
    sessionId: "session-discard",
    turnId: "dsh-3-1",
  });
});

test("resolved failure envelopes still report through debug (defensive branch)", async () => {
  // The real forwarder (createBackendForwarder) NEVER resolves { ok: false }:
  // transport failures throw DshBackendError and successes resolve
  // { ok: true, status, body }. The throw path is covered by "dispatch
  // failures are swallowed without throwing" above. This test pins the
  // bridge's defensive branch so a future forwarder that starts resolving
  // failure envelopes instead of throwing still reports them instead of
  // treating them as successes.
  const errors = [];
  const bridge = createSessionBridge({
    dispatch: async (path) => {
      if (path === "/memory/turn-start") return { ok: false, status: 503 };
      return { ok: false, error: "backend timeout" };
    },
    debug: (message, detail) => errors.push({ message, detail }),
  });

  bridge.onSessionCreated(session("session-reject"));
  bridge.onSessionEvent(session("session-reject"), { type: "turn/start", data: { turn: 0 } });
  bridge.onSessionEvent(session("session-reject"), { type: "user/message", data: textMessage("query") });
  bridge.onSessionEvent(session("session-reject"), { type: "assistant/message", data: assistantData("reply") });
  bridge.onSessionEvent(session("session-reject"), { type: "turn/end", data: { turn: 0, reason: { kind: "completed" } } });

  await flushMicrotasks();
  assert.equal(errors.length, 2);
  assert.deepEqual(
    errors.map((entry) => entry.message).sort(),
    ["turn-start dispatch rejected", "writeback dispatch rejected"],
  );
  const turnStartFailure = errors.find((entry) => entry.message === "turn-start dispatch rejected");
  const writebackFailure = errors.find((entry) => entry.message === "writeback dispatch rejected");
  assert.equal(turnStartFailure.detail, "status 503");
  assert.equal(writebackFailure.detail, "backend timeout");
});

test("buildTurnDiscardCommand builds a minimal discard command", () => {
  assert.equal(buildTurnDiscardCommand({}, 0), undefined);
  assert.equal(buildTurnDiscardCommand({ sessionId: "s" }, undefined), undefined);
  assert.deepEqual(buildTurnDiscardCommand({ sessionId: "s", firstLiveSeq: 5 }, 3), {
    version: 1,
    client: "dsh",
    sessionId: "s",
    turnId: "dsh-5-3",
  });
});

test("a superseded turn-start response is dropped when a newer turn has started", async () => {
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const calls = [];
  const bridge = createSessionBridge({
    dispatch: async (path, body) => {
      calls.push({ path, body });
      if (path === "/memory/turn-start" && body.turnId === "dsh-3-1") {
        await firstGate;
        return { ok: true, body: { additionalContext: "stale context" } };
      }
      return { ok: true, body: {} };
    },
  });

  bridge.onSessionCreated(session("session-superseded"));
  bridge.onSessionEvent(session("session-superseded"), { type: "turn/start", data: { turn: 1 } });
  bridge.onSessionEvent(session("session-superseded"), { type: "user/message", data: textMessage("first") });
  bridge.onSessionEvent(session("session-superseded"), { type: "turn/start", data: { turn: 2 } });
  bridge.onSessionEvent(session("session-superseded"), { type: "user/message", data: textMessage("second") });

  await flushMicrotasks();
  releaseFirst();
  await flushMicrotasks();

  assert.equal(bridge.takePendingContext("session-superseded"), undefined);
});

test("a turn-start completion for a disposed session does not clobber a recreated session", async () => {
  const release = {};
  const bridge = createSessionBridge({
    dispatch: async (path, body) => {
      if (path === "/memory/turn-discard") return { ok: true, body: {} };
      assert.equal(path, "/memory/turn-start");
      await new Promise((resolve) => { release[body.prompt] = resolve; });
      return { ok: true, body: { additionalContext: `context for ${body.prompt}` } };
    },
  });

  bridge.onSessionCreated(session("session-recreated"));
  bridge.onSessionEvent(session("session-recreated"), { type: "turn/start", data: { turn: 1 } });
  bridge.onSessionEvent(session("session-recreated"), { type: "user/message", data: textMessage("stale") });
  await flushMicrotasks();
  bridge.onSessionDisposed(session("session-recreated"));

  bridge.onSessionCreated(session("session-recreated"));
  bridge.onSessionEvent(session("session-recreated"), { type: "turn/start", data: { turn: 2 } });
  bridge.onSessionEvent(session("session-recreated"), { type: "user/message", data: textMessage("fresh") });
  await flushMicrotasks();

  release.fresh();
  await flushMicrotasks();
  assert.equal(bridge.takePendingContext("session-recreated"), "context for fresh");

  release.stale();
  await flushMicrotasks();
  assert.equal(bridge.takePendingContext("session-recreated"), undefined);
});

test("a delayed turn/end for an older turn does not clear the newer turn state", async () => {
  const calls = [];
  const bridge = createSessionBridge({
    dispatch: async (path, body) => {
      calls.push({ path, body });
      return { ok: true, body: {} };
    },
  });

  bridge.onSessionCreated(session("session-stale-end"));
  bridge.onSessionEvent(session("session-stale-end"), { type: "turn/start", data: { turn: 1 } });
  bridge.onSessionEvent(session("session-stale-end"), { type: "user/message", data: textMessage("first") });
  bridge.onSessionEvent(session("session-stale-end"), { type: "turn/start", data: { turn: 2 } });
  bridge.onSessionEvent(session("session-stale-end"), { type: "user/message", data: textMessage("second") });
  bridge.onSessionEvent(session("session-stale-end"), { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
  bridge.onSessionEvent(session("session-stale-end"), { type: "assistant/message", data: assistantData("second reply") });
  bridge.onSessionEvent(session("session-stale-end"), { type: "turn/end", data: { turn: 2, reason: { kind: "completed" } } });

  await flushMicrotasks();
  const writebacks = calls.filter((call) => call.path === "/memory/writeback");
  assert.equal(writebacks.length, 1);
  assert.deepEqual(writebacks[0].body, {
    version: 1,
    client: "dsh",
    sessionId: "session-stale-end",
    turnId: "dsh-3-2",
    userText: "second",
    assistantText: "second reply",
    cwd: "/repo",
  });
});

test("a new turn start clears stale pending context from the previous turn", async () => {
  const bridge = createSessionBridge({
    dispatch: async (path, body) => {
      if (body.turnId === "dsh-3-1") return { ok: true, body: { additionalContext: "stale ctx" } };
      return { ok: true, body: {} };
    },
  });

  bridge.onSessionCreated(session("session-context-stale"));
  bridge.onSessionEvent(session("session-context-stale"), { type: "turn/start", data: { turn: 1 } });
  bridge.onSessionEvent(session("session-context-stale"), { type: "user/message", data: textMessage("first") });
  await flushMicrotasks();

  bridge.onSessionEvent(session("session-context-stale"), { type: "turn/start", data: { turn: 2 } });
  bridge.onSessionEvent(session("session-context-stale"), { type: "user/message", data: textMessage("second") });
  await flushMicrotasks();

  assert.equal(bridge.takePendingContext("session-context-stale"), undefined);
});

test("a superseded turn queues a turn-discard for the previous turn", async () => {
  const calls = [];
  const bridge = createSessionBridge({
    dispatch: async (path, body) => {
      calls.push({ path, body });
      return { ok: true, body: {} };
    },
  });

  bridge.onSessionCreated(session("session-supersede-discard"));
  bridge.onSessionEvent(session("session-supersede-discard"), { type: "turn/start", data: { turn: 1 } });
  bridge.onSessionEvent(session("session-supersede-discard"), { type: "user/message", data: textMessage("first") });
  bridge.onSessionEvent(session("session-supersede-discard"), { type: "turn/start", data: { turn: 2 } });
  bridge.onSessionEvent(session("session-supersede-discard"), { type: "user/message", data: textMessage("second") });

  await flushMicrotasks();
  assert.deepEqual(calls.map((call) => call.path), [
    "/memory/turn-start",
    "/memory/turn-discard",
    "/memory/turn-start",
  ]);
  assert.equal(calls[1].body.turnId, "dsh-3-1");
});

test("a completed turn with no assistant text discards its backend metadata", async () => {
  const calls = [];
  const bridge = createSessionBridge({
    dispatch: async (path, body) => {
      calls.push({ path, body });
      return { ok: true, body: {} };
    },
  });

  bridge.onSessionCreated(session("session-tool-only"));
  bridge.onSessionEvent(session("session-tool-only"), { type: "turn/start", data: { turn: 0 } });
  bridge.onSessionEvent(session("session-tool-only"), { type: "user/message", data: textMessage("run tools") });
  bridge.onSessionEvent(session("session-tool-only"), { type: "turn/end", data: { turn: 0, reason: { kind: "completed" } } });

  await flushMicrotasks();
  assert.deepEqual(calls.map((call) => call.path), ["/memory/turn-start", "/memory/turn-discard"]);
  assert.equal(calls[1].body.turnId, "dsh-3-0");
});

test("disposing a session mid-turn discards the active turn", async () => {
  const calls = [];
  const bridge = createSessionBridge({
    dispatch: async (path, body) => {
      calls.push({ path, body });
      return { ok: true, body: {} };
    },
  });

  bridge.onSessionCreated(session("session-dispose-mid-turn"));
  bridge.onSessionEvent(session("session-dispose-mid-turn"), { type: "turn/start", data: { turn: 1 } });
  bridge.onSessionEvent(session("session-dispose-mid-turn"), { type: "user/message", data: textMessage("query") });
  await flushMicrotasks();
  bridge.onSessionDisposed(session("session-dispose-mid-turn"));
  await flushMicrotasks();

  assert.deepEqual(calls.map((call) => call.path), ["/memory/turn-start", "/memory/turn-discard"]);
  assert.equal(calls[1].body.turnId, "dsh-3-1");
});

test("a malformed turn/start without a turn id is rejected while a turn is active", async () => {
  const calls = [];
  const bridge = createSessionBridge({
    dispatch: async (path, body) => {
      calls.push({ path, body });
      return { ok: true, body: {} };
    },
  });

  bridge.onSessionCreated(session("session-malformed-start"));
  bridge.onSessionEvent(session("session-malformed-start"), { type: "turn/start", data: { turn: 1 } });
  bridge.onSessionEvent(session("session-malformed-start"), { type: "user/message", data: textMessage("first") });
  bridge.onSessionEvent(session("session-malformed-start"), { type: "turn/start", data: {} });
  bridge.onSessionEvent(session("session-malformed-start"), { type: "assistant/message", data: assistantData("reply") });
  bridge.onSessionEvent(session("session-malformed-start"), { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });

  await flushMicrotasks();
  assert.deepEqual(calls.map((call) => call.path), ["/memory/turn-start", "/memory/writeback"]);
  assert.equal(calls[1].body.turnId, "dsh-3-1");
  assert.equal(calls[1].body.userText, "first");
  assert.equal(calls[1].body.assistantText, "reply");
});

test("a malformed turn/start with a non-integer turn id is rejected while a turn is active", async () => {
  const calls = [];
  const bridge = createSessionBridge({
    dispatch: async (path, body) => {
      calls.push({ path, body });
      return { ok: true, body: {} };
    },
  });

  bridge.onSessionCreated(session("session-malformed-turn-int"));
  bridge.onSessionEvent(session("session-malformed-turn-int"), { type: "turn/start", data: { turn: 0 } });
  bridge.onSessionEvent(session("session-malformed-turn-int"), { type: "user/message", data: textMessage("query") });
  bridge.onSessionEvent(session("session-malformed-turn-int"), { type: "turn/start", data: { turn: "nope" } });

  await flushMicrotasks();
  assert.deepEqual(calls.map((call) => call.path), ["/memory/turn-start"]);
});

test("a malformed turn/start is tolerated when no turn is active", async () => {
  const calls = [];
  const bridge = createSessionBridge({
    dispatch: async (path, body) => {
      calls.push({ path, body });
      return { ok: true, body: {} };
    },
  });

  bridge.onSessionCreated(session("session-malformed-start-idle"));
  bridge.onSessionEvent(session("session-malformed-start-idle"), { type: "turn/start", data: {} });
  bridge.onSessionEvent(session("session-malformed-start-idle"), { type: "turn/start", data: { turn: 3 } });
  bridge.onSessionEvent(session("session-malformed-start-idle"), { type: "user/message", data: textMessage("query") });

  await flushMicrotasks();
  assert.deepEqual(calls.map((call) => call.path), ["/memory/turn-start"]);
  assert.equal(calls[0].body.turnId, "dsh-3-3");
});

test("a turn/end without a turn id does not clobber the active turn", async () => {
  const calls = [];
  const bridge = createSessionBridge({
    dispatch: async (path, body) => {
      calls.push({ path, body });
      return { ok: true, body: {} };
    },
  });

  bridge.onSessionCreated(session("session-unlabeled-end"));
  bridge.onSessionEvent(session("session-unlabeled-end"), { type: "turn/start", data: { turn: 1 } });
  bridge.onSessionEvent(session("session-unlabeled-end"), { type: "user/message", data: textMessage("first") });
  bridge.onSessionEvent(session("session-unlabeled-end"), { type: "turn/start", data: { turn: 2 } });
  bridge.onSessionEvent(session("session-unlabeled-end"), { type: "user/message", data: textMessage("second") });
  bridge.onSessionEvent(session("session-unlabeled-end"), { type: "turn/end", data: { reason: { kind: "completed" } } });
  bridge.onSessionEvent(session("session-unlabeled-end"), { type: "assistant/message", data: assistantData("second reply") });
  bridge.onSessionEvent(session("session-unlabeled-end"), { type: "turn/end", data: { turn: 2, reason: { kind: "completed" } } });

  await flushMicrotasks();
  const writebacks = calls.filter((call) => call.path === "/memory/writeback");
  assert.equal(writebacks.length, 1);
  assert.deepEqual(writebacks[0].body, {
    version: 1,
    client: "dsh",
    sessionId: "session-unlabeled-end",
    turnId: "dsh-3-2",
    userText: "second",
    assistantText: "second reply",
    cwd: "/repo",
  });
  const discards = calls.filter((call) => call.path === "/memory/turn-discard");
  assert.equal(discards.length, 1);
  assert.equal(discards[0].body.turnId, "dsh-3-1");
});

test("waitForPendingContext resolves once the turn-start retrieval settles in time", async () => {
  const release = {};
  const bridge = createSessionBridge({
    dispatch: async (path, body) => {
      if (path === "/memory/turn-start") {
        await new Promise((resolve) => { release[body.prompt] = resolve; });
        return { ok: true, body: { additionalContext: `ctx:${body.prompt}` } };
      }
      return { ok: true, body: {} };
    },
  });

  bridge.onSessionCreated(session("session-wait-ctx"));
  bridge.onSessionEvent(session("session-wait-ctx"), { type: "turn/start", data: { turn: 1 } });
  bridge.onSessionEvent(session("session-wait-ctx"), { type: "user/message", data: textMessage("query") });

  const pending = bridge.waitForPendingContext("session-wait-ctx", 200);
  await flushMicrotasks();
  release.query();
  assert.equal(await pending, "ctx:query");
});

test("waitForPendingContext times out and returns undefined when retrieval is slow", async () => {
  const release = {};
  const bridge = createSessionBridge({
    dispatch: async (path, body) => {
      if (path === "/memory/turn-start") {
        await new Promise((resolve) => { release.resolve = resolve; });
        return { ok: true, body: { additionalContext: "late ctx" } };
      }
      return { ok: true, body: {} };
    },
  });

  bridge.onSessionCreated(session("session-slow-ctx"));
  bridge.onSessionEvent(session("session-slow-ctx"), { type: "turn/start", data: { turn: 1 } });
  bridge.onSessionEvent(session("session-slow-ctx"), { type: "user/message", data: textMessage("query") });

  assert.equal(await bridge.waitForPendingContext("session-slow-ctx", 20), undefined);
  release.resolve();
  await flushMicrotasks();
  assert.equal(bridge.takePendingContext("session-slow-ctx"), "late ctx");
});

test("re-creating a session without dispose retires the old incarnation", async () => {
  const release = {};
  const calls = [];
  const bridge = createSessionBridge({
    dispatch: async (path, body) => {
      calls.push({ path, body });
      if (path === "/memory/turn-start" && body.prompt === "stale") {
        await new Promise((resolve) => { release.stale = resolve; });
        return { ok: true, body: { additionalContext: "stale context" } };
      }
      return { ok: true, body: { additionalContext: `ctx:${body.prompt}` } };
    },
  });

  bridge.onSessionCreated(session("session-dirty-rebuild"));
  bridge.onSessionEvent(session("session-dirty-rebuild"), { type: "turn/start", data: { turn: 1 } });
  bridge.onSessionEvent(session("session-dirty-rebuild"), { type: "user/message", data: textMessage("stale") });
  await flushMicrotasks();

  // Same session id, no intervening session/disposed, but a DIFFERENT live
  // window (firstLiveSeq 9): only a distinguishable payload proves a rebuild.
  // An identical payload is indistinguishable from a redelivery of the same
  // incarnation and is covered by the next test.
  bridge.onSessionCreated(session("session-dirty-rebuild", { firstLiveSeq: 9 }));
  bridge.onSessionEvent(session("session-dirty-rebuild"), { type: "turn/start", data: { turn: 1 } });
  bridge.onSessionEvent(session("session-dirty-rebuild"), { type: "user/message", data: textMessage("fresh") });
  await flushMicrotasks();

  // The stale in-flight response must not leak into the new incarnation.
  release.stale();
  await flushMicrotasks();
  assert.equal(bridge.takePendingContext("session-dirty-rebuild"), "ctx:fresh");

  const paths = calls.map((call) => call.path);
  assert.equal(paths.filter((path) => path === "/memory/turn-discard").length, 1);
  const discard = calls.find((call) => call.path === "/memory/turn-discard");
  // Old incarnation turnId (gen 1, no suffix) is discarded; new incarnation
  // uses a distinct turnId (gen 2) so the two can never collide.
  assert.equal(discard.body.turnId, "dsh-3-1");
  const starts = calls.filter((call) => call.path === "/memory/turn-start");
  assert.deepEqual(starts.map((call) => call.body.turnId), ["dsh-3-1", "dsh-9-g2-1"]);
});

test("an identical session/created redelivery keeps the live incarnation", async () => {
  const calls = [];
  const bridge = createSessionBridge({
    dispatch: async (path, body) => {
      calls.push({ path, body });
      return { ok: true, body: {} };
    },
  });

  bridge.onSessionCreated(session("session-replayed"));
  bridge.onSessionEvent(session("session-replayed"), { type: "turn/start", data: { turn: 1 } });
  bridge.onSessionEvent(session("session-replayed"), { type: "user/message", data: textMessage("live") });
  await flushMicrotasks();

  // Same id, same firstLiveSeq, same cwd: indistinguishable from a replay of
  // the SAME live incarnation (reconnect, event redelivery, plugin reload).
  // Retiring the state here would discard the live turn on the Backend and
  // drop its writeback, so the redelivery must be ignored.
  bridge.onSessionCreated(session("session-replayed"));
  bridge.onSessionEvent(session("session-replayed"), { type: "user/message", data: textMessage("more") });
  bridge.onSessionEvent(session("session-replayed"), { type: "assistant/message", data: assistantData("reply") });
  bridge.onSessionEvent(session("session-replayed"), { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
  await flushMicrotasks();

  const starts = calls.filter((call) => call.path === "/memory/turn-start");
  assert.deepEqual(starts.map((call) => call.body.turnId), ["dsh-3-1"]);
  // The turn-start was already dispatched at the first message, so its
  // prompt stays "live"; text that arrived later rides on the writeback,
  // where the Backend accepts it via the delimiter prefix match.
  assert.equal(starts[0].body.prompt, "live");
  const writebacks = calls.filter((call) => call.path === "/memory/writeback");
  assert.equal(writebacks.length, 1);
  assert.equal(writebacks[0].body.userText, "live\n\nmore");
  assert.equal(calls.some((call) => call.path === "/memory/turn-discard"), false);
});

test("re-creating a session clears stale pending context from the previous incarnation", async () => {
  const bridge = createSessionBridge({
    dispatch: async (path, body) => {
      if (path === "/memory/turn-start") {
        return { ok: true, body: { additionalContext: `ctx:${body.prompt}` } };
      }
      return { ok: true, body: {} };
    },
  });

  bridge.onSessionCreated(session("session-stale-pending"));
  bridge.onSessionEvent(session("session-stale-pending"), { type: "turn/start", data: { turn: 1 } });
  bridge.onSessionEvent(session("session-stale-pending"), { type: "user/message", data: textMessage("old") });
  await flushMicrotasks();
  assert.equal(bridge.takePendingContext("session-stale-pending"), "ctx:old");

  bridge.onSessionCreated(session("session-stale-pending"));
  assert.equal(bridge.takePendingContext("session-stale-pending"), undefined);
});

test("a turn/start without a turn id does not reset a pending unstarted turn", async () => {
  const calls = [];
  const bridge = createSessionBridge({
    dispatch: async (path, body) => {
      calls.push({ path, body });
      return { ok: true, body: {} };
    },
  });

  bridge.onSessionCreated(session("session-pending-start"));
  bridge.onSessionEvent(session("session-pending-start"), { type: "turn/start", data: { turn: 4 } });
  // Second start arrives before any user/message: state.turn is set but the
  // turn has not dispatched. The guard must still ignore this start.
  bridge.onSessionEvent(session("session-pending-start"), { type: "turn/start", data: {} });
  bridge.onSessionEvent(session("session-pending-start"), { type: "user/message", data: textMessage("query") });
  bridge.onSessionEvent(session("session-pending-start"), { type: "assistant/message", data: assistantData("reply") });
  bridge.onSessionEvent(session("session-pending-start"), { type: "turn/end", data: { turn: 4, reason: { kind: "completed" } } });

  await flushMicrotasks();
  assert.deepEqual(calls.map((call) => call.path), ["/memory/turn-start", "/memory/writeback"]);
  assert.equal(calls[0].body.turnId, "dsh-3-4");
  assert.equal(calls[1].body.turnId, "dsh-3-4");
  assert.equal(calls[1].body.userText, "query");
});

test("a turn-start response with body.ok=false is treated as rejected (defensive branch)", async () => {
  const errors = [];
  const bridge = createSessionBridge({
    dispatch: async (path) => {
      if (path === "/memory/turn-start") {
        // HTTP 2xx with a body-level rejection. The CURRENT Backend never
        // sends this for turn-start: it answers { ok: true, ... } and
        // self-heals turnId conflicts server-side (see
        // dsh-memory-hook-runtime "turn_start_conflict_replaced"), and
        // non-2xx statuses make the real forwarder throw before the body is
        // inspected. This pins the bridge's contract-drift defense: if a
        // future Backend starts rejecting turn-start in a 2xx body, the
        // bridge must treat the turn as NOT started instead of proceeding to
        // a writeback the Backend would then skip.
        return { ok: true, status: 200, body: { ok: false, error: "conflicting_turn_start" } };
      }
      return { ok: true, body: {} };
    },
    debug: (message, detail) => errors.push({ message, detail }),
  });

  bridge.onSessionCreated(session("session-body-reject"));
  bridge.onSessionEvent(session("session-body-reject"), { type: "turn/start", data: { turn: 0 } });
  bridge.onSessionEvent(session("session-body-reject"), { type: "user/message", data: textMessage("query") });

  await flushMicrotasks();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, "turn-start dispatch rejected");
  assert.equal(errors[0].detail, "conflicting_turn_start");
  assert.equal(bridge.takePendingContext("session-body-reject"), undefined);
});

test("a writeback body-level skip reason is surfaced through debug", async () => {
  // The Backend accepts writeback with HTTP 200 and reports skipped
  // scheduling only in the body ({ ok: true, scheduled: false, reason }).
  // Reading the body is what makes turn_metadata_missing / prompt_mismatch
  // visible instead of silently dropped.
  const errors = [];
  const bridge = createSessionBridge({
    dispatch: async (path) => {
      if (path === "/memory/writeback") {
        return { ok: true, status: 200, body: { ok: true, scheduled: false, reason: "turn_metadata_missing" } };
      }
      return { ok: true, body: {} };
    },
    debug: (message, detail) => errors.push({ message, detail }),
  });

  bridge.onSessionCreated(session("session-skip"));
  bridge.onSessionEvent(session("session-skip"), { type: "turn/start", data: { turn: 0 } });
  bridge.onSessionEvent(session("session-skip"), { type: "user/message", data: textMessage("query") });
  bridge.onSessionEvent(session("session-skip"), { type: "assistant/message", data: assistantData("reply") });
  bridge.onSessionEvent(session("session-skip"), { type: "turn/end", data: { turn: 0, reason: { kind: "completed" } } });

  await flushMicrotasks();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, "writeback skipped by backend");
  assert.equal(errors[0].detail, "turn_metadata_missing");
});

test("a turn-discard response with discarded=false is surfaced through debug", async () => {
  const errors = [];
  const bridge = createSessionBridge({
    dispatch: async (path) => {
      if (path === "/memory/turn-discard") {
        return { ok: true, status: 200, body: { ok: true, discarded: false } };
      }
      return { ok: true, body: {} };
    },
    debug: (message, detail) => errors.push({ message, detail }),
  });

  bridge.onSessionCreated(session("session-discard-miss"));
  bridge.onSessionEvent(session("session-discard-miss"), { type: "turn/start", data: { turn: 0 } });
  bridge.onSessionEvent(session("session-discard-miss"), { type: "user/message", data: textMessage("query") });
  bridge.onSessionEvent(session("session-discard-miss"), { type: "turn/end", data: { turn: 0, reason: { kind: "interrupted" } } });

  await flushMicrotasks();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].message, "turn-discard found no live turn metadata");
  assert.equal(errors[0].detail, "dsh-3-0");
});

test("concurrent sessions keep independent turn state", async () => {
  const calls = [];
  const bridge = createSessionBridge({
    dispatch: async (path, body) => {
      calls.push({ path, body });
      return { ok: true, body: {} };
    },
  });

  for (const id of ["session-a", "session-b"]) {
    bridge.onSessionCreated(session(id));
    bridge.onSessionEvent(session(id), { type: "turn/start", data: { turn: 0 } });
    bridge.onSessionEvent(session(id), { type: "user/message", data: textMessage(`q:${id}`) });
    bridge.onSessionEvent(session(id), { type: "assistant/message", data: assistantData(`a:${id}`) });
    bridge.onSessionEvent(session(id), { type: "turn/end", data: { turn: 0, reason: { kind: "completed" } } });
  }

  await flushMicrotasks();
  assert.equal(bridge.sessionCount(), 2);
  const writebacks = calls.filter((call) => call.path === "/memory/writeback");
  assert.deepEqual(
    writebacks.map((call) => [call.body.sessionId, call.body.userText]).sort(),
    [["session-a", "q:session-a"], ["session-b", "q:session-b"]],
  );
});

async function flushMicrotasks() {
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
test("a late turn-start response cannot inject context after turn/end", async () => {
  let releaseTurnStart;
  const dispatched = [];
  const bridge = createSessionBridge({
    dispatch: (path, body) => {
      dispatched.push({ path, body });
      if (path === "/memory/turn-start") {
        return new Promise((resolve) => { releaseTurnStart = resolve; });
      }
      return Promise.resolve({ ok: true, body: { ok: true } });
    },
    debug: () => {},
  });

  const sess = session("session-late-response");
  bridge.onSessionCreated(sess);
  bridge.onSessionEvent(sess, { type: "turn/start", data: { turn: 0 } });
  bridge.onSessionEvent(sess, { type: "user/message", data: textMessage("query") });
  bridge.onSessionEvent(sess, { type: "assistant/message", data: assistantData("reply") });
  bridge.onSessionEvent(sess, { type: "turn/end", data: { turn: 0, reason: { kind: "completed" } } });

  // The turn is over; only now does the turn-start response arrive carrying
  // retrieval context for the finished turn.
  await flushMicrotasks();
  assert.equal(typeof releaseTurnStart, "function", "turn-start dispatch must have been issued");
  releaseTurnStart({ ok: true, body: { ok: true, additionalContext: "stale context" } });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await flushMicrotasks();

  assert.equal(bridge.takePendingContext("session-late-response"), undefined,
    "a response for a finished turn must not land in pendingContext");
});

test("an out-of-order user message keeps its text when turn/start arrives late", async () => {
  const dispatched = [];
  const bridge = createSessionBridge({
    dispatch: (path, body) => {
      dispatched.push({ path, body });
      return Promise.resolve({ ok: true, body: { ok: true } });
    },
    debug: () => {},
  });

  const sess = session("session-out-of-order");
  bridge.onSessionCreated(sess);
  // The first user message arrives BEFORE the turn/start event, so the bridge
  // has text but no turn id to dispatch with.
  bridge.onSessionEvent(sess, { type: "user/message", data: textMessage("early bird text") });
  // Now the turn id arrives for the same turn.
  bridge.onSessionEvent(sess, { type: "turn/start", data: { turn: 0 } });
  await flushMicrotasks();

  const turnStart = dispatched.find((entry) => entry.path === "/memory/turn-start");
  assert.ok(turnStart, "the carried text must be dispatched once the turn id is known");
  assert.equal(turnStart.body.prompt, "early bird text");
});
