import assert from "node:assert/strict";
import test from "node:test";
import { foldMemoryViewerSupersededTurnStarts } from "../../../dist/viewer/projection/history.js";
import { projectMemoryViewerUserData } from "../../../dist/viewer/projection/user.js";

const PROJECT_ID = `repo:${"a".repeat(32)}`;

test("user projection exposes aggregate activity without private event fields", () => {
  const projection = projectMemoryViewerUserData([
    event("turn-start-codex", "turn_start", "2026-07-15T10:00:00.000Z", {
      client: "codex",
      sessionId: "shared-session",
      turnId: "shared-turn",
      prompt: "private Codex prompt",
      details: { transcriptPath: "/private/codex.jsonl" },
    }),
    event("turn-end-codex", "turn_end", "2026-07-15T10:00:30.000Z", {
      client: "codex",
      sessionId: "shared-session",
      turnId: "shared-turn",
      answer: "private Codex answer",
      turnOutcome: "completed",
    }),
    event("turn-start-claude", "turn_start", "2026-07-15T10:01:00.000Z", {
      client: "claude",
      sessionId: "shared-session",
      turnId: "shared-turn",
      prompt: "private Claude prompt",
    }),
    event("search-saved", "memory_cli_search", "2026-07-15T10:02:00.000Z", {
      sessionId: "private-search-session",
      turnId: "private-search-turn",
      content: "private search result",
      query: "private query",
      results: [
        { content: "private memory one" },
        { content: "private memory two" },
      ],
      itemCount: 2,
      details: { request: { query: "private nested query" } },
    }),
    event("search-failed", "memory_retrieve", "2026-07-15T10:03:00.000Z", {
      ok: false,
      error: "private retrieval error",
    }),
    event("add-saved", "memory_writeback", "2026-07-15T10:04:00.000Z", {
      content: "private saved memory",
      savedMemories: ["private saved memory"],
      savedMemoryCount: 3,
      writebackOutcome: "saved",
    }),
    event("add-pending", "memory_writeback", "2026-07-15T10:05:00.000Z", {
      content: "private pending payload",
      writebackOutcome: "pending",
    }),
    event("add-completed", "memory_writeback", "2026-07-15T10:06:00.000Z", {
      content: "private completed payload",
      writebackOutcome: "completed",
    }),
    event("add-skipped", "memory_cli_add", "2026-07-15T10:07:00.000Z", {
      savedMemoryCount: 0,
    }),
    event("add-failed", "memory_cli_add", "2026-07-15T10:08:00.000Z", {
      ok: false,
      error: "private add error",
    }),
  ]);

  assert.deepEqual(projection.summary, {
    turnCount: 2,
    searchOperationCount: 2,
    searchedMemoryCount: 2,
    addOperationCount: 5,
    addedMemoryCount: 3,
    processingCount: 2,
    unknownCount: 1,
    failedCount: 2,
  });
  assert.deepEqual(projection.activities.map(({ kind, status, count }) => ({ kind, status, count })), [
    { kind: "add", status: "failed", count: 0 },
    { kind: "add", status: "skipped", count: 0 },
    { kind: "add", status: "completed", count: null },
    { kind: "add", status: "processing", count: null },
    { kind: "add", status: "saved", count: 3 },
    { kind: "search", status: "failed", count: 0 },
    { kind: "search", status: "completed", count: 2 },
    { kind: "turn", status: "processing", count: null },
    { kind: "turn", status: "completed", count: null },
  ]);

  for (const activity of projection.activities) {
    assert.deepEqual(Object.keys(activity).sort(), [
      "count",
      "kind",
      "occurredAt",
      "projectId",
      "projectLabel",
      "source",
      "status",
    ]);
  }
  const serialized = JSON.stringify(projection);
  for (const secret of [
    "private Codex prompt",
    "private Codex answer",
    "private Claude prompt",
    "private-search-session",
    "private-search-turn",
    "private query",
    "private memory one",
    "private memory two",
    "private saved memory",
    "private nested query",
    "/private/codex.jsonl",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(escapeRegExp(secret)));
  }
  assert.deepEqual(collectKeys(projection).filter((key) => (
    ["prompt", "answer", "query", "results", "details", "sessionId", "turnId"].includes(key)
  )), []);
});

test("user projection keeps interrupted and unscoped turns privacy-safe", () => {
  const projection = projectMemoryViewerUserData([
    event("unscoped", "turn_end", "2026-07-15T11:00:00.000Z", {
      sessionId: "private-session",
      turnId: "private-turn",
      turnOutcome: "interrupted",
      answer: "private interrupted answer",
      projectId: undefined,
      projectLabel: undefined,
    }),
  ]);

  assert.deepEqual(projection.activities, [{
    kind: "turn",
    occurredAt: "2026-07-15T11:00:00.000Z",
    source: "client",
    status: "interrupted",
    count: null,
  }]);
  assert.doesNotMatch(JSON.stringify(projection), /private-session|private-turn|private interrupted answer/);
});

test("user projection marks only superseded orphan turns as interrupted", () => {
  const folded = foldMemoryViewerSupersededTurnStarts([
    event("latest", "turn_start", "2026-07-15T11:02:00.000Z", {
      client: "codex",
      sessionId: "session-a",
      turnId: "turn-c",
    }),
    event("oldest", "turn_start", "2026-07-15T11:00:00.000Z", {
      client: "codex",
      sessionId: "session-a",
      turnId: "turn-a",
    }),
    event("middle", "turn_start", "2026-07-15T11:01:00.000Z", {
      client: "codex",
      sessionId: "session-a",
      turnId: "turn-b",
    }),
    event("other-client", "turn_start", "2026-07-15T11:00:30.000Z", {
      client: "claude",
      sessionId: "session-a",
      turnId: "turn-a",
    }),
    event("other-session", "turn_start", "2026-07-15T11:00:30.000Z", {
      client: "codex",
      sessionId: "session-b",
      turnId: "turn-a",
    }),
  ]);
  const outcomes = new Map(folded.map((item) => [item.id, item.turnOutcome]));
  assert.equal(outcomes.get("oldest"), "interrupted");
  assert.equal(outcomes.get("middle"), "interrupted");
  assert.equal(outcomes.get("latest"), undefined);
  assert.equal(outcomes.get("other-client"), undefined);
  assert.equal(outcomes.get("other-session"), undefined);

  const projection = projectMemoryViewerUserData(
    [...folded].sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp)),
  );
  assert.deepEqual(projection.activities.map(({ occurredAt, status }) => ({ occurredAt, status })), [
    { occurredAt: "2026-07-15T11:02:00.000Z", status: "processing" },
    { occurredAt: "2026-07-15T11:01:00.000Z", status: "interrupted" },
    { occurredAt: "2026-07-15T11:00:30.000Z", status: "processing" },
    { occurredAt: "2026-07-15T11:00:30.000Z", status: "processing" },
    { occurredAt: "2026-07-15T11:00:00.000Z", status: "interrupted" },
  ]);
  assert.equal(projection.summary.processingCount, 3);
  assert.doesNotMatch(JSON.stringify(projection), /session-a|session-b|turn-a|turn-b|turn-c/);
});

test("superseded-turn folding preserves late ends, duplicate starts, and equal timestamps", () => {
  const folded = foldMemoryViewerSupersededTurnStarts([
    event("ended-start", "turn_start", "2026-07-15T11:00:00.000Z", {
      client: "codex",
      sessionId: "session-ended",
      turnId: "turn-a",
    }),
    event("next-start", "turn_start", "2026-07-15T11:01:00.000Z", {
      client: "codex",
      sessionId: "session-ended",
      turnId: "turn-b",
    }),
    event("late-end", "turn_end", "2026-07-15T11:02:00.000Z", {
      client: "codex",
      sessionId: "session-ended",
      turnId: "turn-a",
      turnOutcome: "completed",
    }),
    event("duplicate-one", "turn_start", "2026-07-15T12:00:00.000Z", {
      client: "codex",
      sessionId: "session-duplicate",
      turnId: "turn-a",
    }),
    event("duplicate-two", "turn_start", "2026-07-15T12:01:00.000Z", {
      client: "codex",
      sessionId: "session-duplicate",
      turnId: "turn-a",
    }),
    event("equal-a", "turn_start", "2026-07-15T13:00:00.000Z", {
      client: "codex",
      sessionId: "session-equal",
      turnId: "turn-a",
    }),
    event("equal-b", "turn_start", "2026-07-15T13:00:00.000Z", {
      client: "codex",
      sessionId: "session-equal",
      turnId: "turn-b",
    }),
  ]);

  for (const id of [
    "ended-start",
    "next-start",
    "duplicate-one",
    "duplicate-two",
    "equal-a",
    "equal-b",
  ]) {
    assert.equal(folded.find((item) => item.id === id)?.turnOutcome, undefined);
  }
});

test("user projection uses safe native Claude Search counts while Add quantities stay unknown", () => {
  const projection = projectMemoryViewerUserData([
    event("claude-local:session:memory_cli_search:one", "memory_cli_search", "2026-07-15T12:00:00.000Z", {
      client: "claude",
      itemCount: 41,
      query: "private native search query",
      results: [{ content: "private native search result" }],
    }),
    event("claude-local:session:memory_cli_add:two", "memory_cli_add", "2026-07-15T12:01:00.000Z", {
      client: "claude",
      savedMemoryCount: 23,
      savedMemories: ["private native added memory"],
      writebackOutcome: "saved",
    }),
    event("claude-local:session:memory_cli_search:codex", "memory_cli_search", "2026-07-15T12:02:00.000Z", {
      client: "codex",
      itemCount: 2,
    }),
    event("claude-local:session:memory_cli_search:unknown", "memory_cli_search", "2026-07-15T12:02:30.000Z", {
      client: "claude",
    }),
    event("claude-local:session:memory_cli_add:failed", "memory_cli_add", "2026-07-15T12:03:00.000Z", {
      client: "claude",
      ok: false,
      error: "private native failure",
    }),
  ]);

  assert.deepEqual(projection.summary, {
    turnCount: 0,
    searchOperationCount: 3,
    searchedMemoryCount: 43,
    addOperationCount: 2,
    addedMemoryCount: 0,
    processingCount: 0,
    unknownCount: 2,
    failedCount: 1,
  });
  assert.deepEqual(projection.activities.map(({ kind, status, count }) => ({ kind, status, count })), [
    { kind: "add", status: "failed", count: 0 },
    { kind: "search", status: "completed", count: null },
    { kind: "search", status: "completed", count: 2 },
    { kind: "add", status: "unknown", count: null },
    { kind: "search", status: "completed", count: 41 },
  ]);
  assert.doesNotMatch(
    JSON.stringify(projection),
    /private native search query|private native search result|private native added memory|private native failure/,
  );
});

test("user projection canonicalizes parseable timestamp payloads and drops invalid timestamps", () => {
  const secret = "private prompt /Users/alice session-123";
  const projection = projectMemoryViewerUserData([
    event(
      "adversarial-timestamp",
      "memory_cli_search",
      `Tue, 28 Jul 2026 00:00:00 GMT (${secret})`,
      { itemCount: 1 },
    ),
    event("invalid-timestamp", "memory_cli_add", `not-a-date (${secret})`),
  ]);

  assert.deepEqual(projection.activities, [{
    kind: "search",
    occurredAt: "2026-07-28T00:00:00.000Z",
    source: "assistant",
    status: "completed",
    count: 1,
    projectId: PROJECT_ID,
    projectLabel: "MemoraX-Code",
  }]);
  assert.doesNotMatch(JSON.stringify(projection), new RegExp(escapeRegExp(secret)));
});

function event(id, type, timestamp, overrides = {}) {
  return {
    id,
    eventKey: id,
    type,
    timestamp,
    source: "memory_cli",
    operation: type.includes("writeback") || type === "memory_cli_add" ? "writeback" : "query",
    ok: true,
    content: "private default content",
    projectId: PROJECT_ID,
    projectLabel: "MemoraX-Code",
    ...overrides,
  };
}

function collectKeys(value, keys = []) {
  if (!value || typeof value !== "object") return keys;
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
    return keys;
  }
  for (const [key, item] of Object.entries(value)) {
    keys.push(key);
    collectKeys(item, keys);
  }
  return keys;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
