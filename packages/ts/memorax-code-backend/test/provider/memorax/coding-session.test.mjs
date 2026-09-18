import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CODING_SESSION_BATCH_MAX_BYTES,
  CODING_SESSION_EVENT,
} from "../../../dist/coding-sessions/contracts.js";
import { memoraxConfigFromEnv } from "../../../dist/provider/memorax/config.js";
import { uploadCodingSessionBatch } from "../../../dist/provider/memorax/coding-session.js";

const repositoryScope = {
  schemaVersion: "workspace-memory-scope.v1",
  baseUserId: "user-1",
  effectiveUserId: "user-1@repository",
  repositoryKey: "test-repository",
  repositorySlug: "repository",
  repositoryName: "repository",
  identitySource: "origin-remote",
  scopeKind: "git-repository",
};
const configured = memoraxConfigFromEnv({
  MEMORAX_CODE_MEMORAX_ENDPOINT: "https://memorax.test",
  MEMORAX_CODE_MEMORAX_API_KEY: "test-key",
  MEMORAX_CODE_MEMORAX_USER_ID: repositoryScope.baseUserId,
}, {});
assert.equal(configured.ok, true);
const config = configured.config;

function batch(turnCount = 1) {
  return {
    event: CODING_SESSION_EVENT,
    batch_id: "batch-1",
    user_id: repositoryScope.effectiveUserId,
    client: "codex",
    session_id: "session-1",
    coding_turns: Array.from({ length: turnCount }, (_, index) => ({
      schema_version: 1,
      client: "codex",
      session_id: "session-1",
      turn_id: `turn-${index + 1}`,
      turn_index: index + 1,
      events: [
        { index: 1, type: "user_message", content: "Review the upload boundary." },
        { index: 2, type: "assistant_message", phase: "final", content: "The upload boundary is verified." },
      ],
      outcome: "completed",
      closed_at: "2026-01-01T00:00:00.000Z",
      redaction_version: 1,
      repository_slug: repositoryScope.repositorySlug,
    })),
  };
}

function storedReceipt(value) {
  return { success: true, data: { event: value.event, batch_id: value.batch_id, status: "stored" } };
}

test("Coding Session upload sends a scoped event-only Add and allows more than twenty Turns", async () => {
  const value = batch(21);
  const requests = [];
  const result = await uploadCodingSessionBatch({ ...value, messages: ["must not be forwarded"], async_mode: true }, {
    config,
    repositoryScope,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json(storedReceipt(value));
    },
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://memorax.test/v1/memories/add");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers.Authorization, "Token test-key");
  assert.deepEqual(JSON.parse(requests[0].init.body), value);
});

test("Coding Session upload requires a matching stored receipt instead of ordinary Add acceptance", async () => {
  const value = batch();
  const invalidReceipts = [
    { success: true, data: { task_id: "qa-task", status: "accepted" } },
    { success: true },
    { success: true, data: { ...storedReceipt(value).data, batch_id: "another-batch" } },
    { success: true, data: { ...storedReceipt(value).data, event: "another-event" } },
    { success: true, data: { ...storedReceipt(value).data, status: "accepted" } },
    { success: false, data: storedReceipt(value).data, error: "private request echoed here" },
  ];
  for (const receipt of invalidReceipts) {
    const result = await uploadCodingSessionBatch(value, {
      config,
      repositoryScope,
      fetchImpl: async () => Response.json(receipt, { status: 202 }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorKind, "response");
    assert.doesNotMatch(JSON.stringify(result), /private request|another-batch|qa-task/);
  }
});

test("Coding Session upload rejects mismatched scope and batch identities before transport", async () => {
  let calls = 0;
  const value = batch();
  const cases = [
    [{ ...value, user_id: "another-user" }, config, repositoryScope],
    [value, { ...config, userId: "another-user" }, repositoryScope],
    [value, config, undefined],
    [{ ...value, batch_id: " " }, config, repositoryScope],
    [{ ...value, coding_turns: [] }, config, repositoryScope],
    [{ ...value, session_id: "another-session" }, config, repositoryScope],
    [{ ...value, client: "claude-code" }, config, repositoryScope],
    [{ ...value, coding_turns: [{ ...value.coding_turns[0], repository_slug: "another-repository" }] }, config, repositoryScope],
  ];
  for (const [candidate, candidateConfig, candidateScope] of cases) {
    const result = await uploadCodingSessionBatch(candidate, {
      config: candidateConfig,
      repositoryScope: candidateScope,
      fetchImpl: async () => {
        calls += 1;
        return Response.json(storedReceipt(candidate));
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.errorCode, /^MEMORAX_CODING_SESSION_(?:SCOPE_MISMATCH|INVALID_BATCH)$/);
  }
  assert.equal(calls, 0);
});

test("Coding Session upload bounds the entire JSON UTF-8 body to twenty MiB", async () => {
  const value = batch(11);
  for (const turn of value.coding_turns) turn.events[0].content = "中".repeat(600_000);
  let remaining = CODING_SESSION_BATCH_MAX_BYTES - Buffer.byteLength(JSON.stringify(value), "utf8");
  for (const turn of value.coding_turns) {
    const padding = Math.min(remaining, 2 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(turn)) - 100);
    turn.events[0].content += "x".repeat(padding);
    remaining -= padding;
  }
  assert.equal(remaining, 0);
  assert.equal(Buffer.byteLength(JSON.stringify(value), "utf8"), CODING_SESSION_BATCH_MAX_BYTES);
  let calls = 0;
  const options = {
    config,
    repositoryScope,
    fetchImpl: async (_url, init) => {
      calls += 1;
      assert.equal(Buffer.byteLength(init.body, "utf8"), CODING_SESSION_BATCH_MAX_BYTES);
      return Response.json(storedReceipt(value));
    },
  };
  assert.deepEqual(await uploadCodingSessionBatch(value, options), { ok: true });
  value.coding_turns[0].events[0].content += "x";
  const oversized = await uploadCodingSessionBatch(value, options);
  assert.equal(oversized.ok, false);
  assert.equal(oversized.errorCode, "MEMORAX_CODING_SESSION_BATCH_TOO_LARGE");
  assert.equal(calls, 1);
});

test("Coding Session upload preserves safe HTTP retry classification", async () => {
  const result = await uploadCodingSessionBatch(batch(), {
    config,
    repositoryScope,
    fetchImpl: async () => new Response("private request echoed here", {
      status: 429,
      headers: { "retry-after": "2" },
    }),
  });
  assert.deepEqual(result, {
    ok: false,
    error: "MemoraX HTTP 429",
    errorCode: "MEMORAX_HTTP_ERROR",
    errorKind: "http",
    httpStatus: 429,
    retryAfterMs: 2000,
  });
});
