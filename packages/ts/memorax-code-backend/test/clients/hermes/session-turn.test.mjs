import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { hermesSessionTurn } from "../../../dist/clients/hermes/session-turn.js";

function tempHermesHome(messages) {
  const home = mkdtempSync(join(tmpdir(), "mx-hermes-session-turn-"));
  const db = new DatabaseSync(join(home, "state.db"));
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT)");
  db.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY, session_id TEXT, role TEXT, content TEXT, timestamp REAL, active INTEGER)");
  db.prepare("INSERT INTO sessions (id, parent_session_id) VALUES (?, ?)").run("session-1", null);
  for (const message of messages) {
    db.prepare(
      "INSERT INTO messages (session_id, role, content, timestamp, active) VALUES (?, ?, ?, ?, 1)",
    ).run("session-1", message.role, message.content, message.timestamp);
  }
  db.close();
  return home;
}

test("materializes a completed turn from Hermes state.db timestamps in seconds", async () => {
  const home = tempHermesHome([
    { role: "user", content: "Reply with exactly: PONG", timestamp: 1_787_048_000 },
    { role: "assistant", content: "PONG", timestamp: 1_787_048_002 },
  ]);
  try {
    const result = await hermesSessionTurn({
      sessionId: "session-1",
      turnId: "turn-1",
      cwd: "C:\\x",
      completed: true,
      interrupted: false,
      failed: false,
      hermesHome: home,
      turnStartedAt: 1_787_048_000 * 1000,
      now: 1_787_048_010 * 1000,
    });
    assert.deepEqual(result, {
      ok: true,
      turn: {
        sessionId: "session-1",
        turnId: "turn-1",
        userPrompt: "Reply with exactly: PONG",
        assistantReply: "PONG",
        userMessageTimestamp: 1_787_048_000,
        assistantMessageTimestamp: 1_787_048_002,
      },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("tolerates a turn-start timestamp given in seconds", async () => {
  const home = tempHermesHome([
    { role: "user", content: "Hello", timestamp: 1_787_048_000 },
    { role: "assistant", content: "Hi", timestamp: 1_787_048_002 },
  ]);
  try {
    const result = await hermesSessionTurn({
      sessionId: "session-1",
      turnId: "turn-1",
      cwd: "C:\\x",
      completed: true,
      interrupted: false,
      failed: false,
      hermesHome: home,
      turnStartedAt: 1_787_048_000,
      now: 1_787_048_010 * 1000,
    });
    assert.equal(result.ok, true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("rejects user messages outside the turn window", async () => {
  const home = tempHermesHome([
    { role: "user", content: "Old", timestamp: 1_787_000_000 },
    { role: "assistant", content: "Old reply", timestamp: 1_787_000_002 },
    { role: "user", content: "Fresh", timestamp: 1_787_048_000 },
    { role: "assistant", content: "Fresh reply", timestamp: 1_787_048_002 },
  ]);
  try {
    const result = await hermesSessionTurn({
      sessionId: "session-1",
      turnId: "turn-2",
      cwd: "C:\\x",
      completed: true,
      interrupted: false,
      failed: false,
      hermesHome: home,
      turnStartedAt: 1_787_047_900 * 1000,
      now: 1_787_048_010 * 1000,
    });
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.turn.userPrompt, "Fresh");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("reports missing user message when only an old message exists", async () => {
  const home = tempHermesHome([
    { role: "user", content: "Old", timestamp: 1_787_000_000 },
  ]);
  try {
    const result = await hermesSessionTurn({
      sessionId: "session-1",
      turnId: "turn-2",
      cwd: "C:\\x",
      completed: true,
      interrupted: false,
      failed: false,
      hermesHome: home,
      turnStartedAt: 1_787_048_000 * 1000,
      now: 1_787_048_010 * 1000,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok || result.reason, "user_message_missing");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("matches prompt when provided", async () => {
  const home = tempHermesHome([
    { role: "user", content: "A", timestamp: 1_787_048_000 },
    { role: "assistant", content: "B", timestamp: 1_787_048_002 },
    { role: "user", content: "C", timestamp: 1_787_048_004 },
    { role: "assistant", content: "D", timestamp: 1_787_048_006 },
  ]);
  try {
    const result = await hermesSessionTurn({
      sessionId: "session-1",
      turnId: "turn-2",
      cwd: "C:\\x",
      prompt: "C",
      completed: true,
      interrupted: false,
      failed: false,
      hermesHome: home,
      now: 1_787_048_010 * 1000,
    });
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.turn.userPrompt, "C");
    assert.equal(result.ok && result.turn.assistantReply, "D");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("reports subagent sessions", async () => {
  const home = tempHermesHome([
    { role: "user", content: "X", timestamp: 1_787_048_000 },
  ]);
  const db = new DatabaseSync(join(home, "state.db"));
  db.prepare("UPDATE sessions SET parent_session_id = ? WHERE id = ?").run("parent-1", "session-1");
  db.close();
  try {
    const result = await hermesSessionTurn({
      sessionId: "session-1",
      turnId: "turn-1",
      cwd: "C:\\x",
      completed: true,
      interrupted: false,
      failed: false,
      hermesHome: home,
      now: 1_787_048_010 * 1000,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok || result.reason, "subagent_session");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("reports incomplete turns with interrupted outcome", async () => {
  const home = tempHermesHome([
    { role: "user", content: "X", timestamp: 1_787_048_000 },
  ]);
  try {
    const result = await hermesSessionTurn({
      sessionId: "session-1",
      turnId: "turn-1",
      cwd: "C:\\x",
      completed: false,
      interrupted: true,
      failed: false,
      hermesHome: home,
      now: 1_787_048_010 * 1000,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok || result.reason, "turn_not_completed");
    assert.equal(result.ok || result.outcome, "interrupted");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});