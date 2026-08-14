import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildTurnId,
  buildTurnStartCommand,
  buildWritebackCommand,
  createSessionBridge,
  extractMessageText,
  isDirectUserMessage,
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

test("buildTurnId combines session first live seq and turn number", () => {
  assert.equal(buildTurnId("session-1", 7, 2), "dsh-7-2");
  assert.equal(buildTurnId("session-1", undefined, "3"), "dsh-0-3");
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
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/memory/turn-start");
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
