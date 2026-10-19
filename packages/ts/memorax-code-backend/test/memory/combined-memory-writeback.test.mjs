import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preparePendingCodingSessionTurn } from "../../dist/coding-sessions/attachment.js";
import { createAutomaticMemoryWritebackRuntime } from "../../dist/memory/automatic-writeback.js";

const home = await mkdtemp(join(tmpdir(), "memorax-combined-writeback-"));
after(() => rm(home, { recursive: true, force: true }));
const scope = {
  schemaVersion: "workspace-memory-scope.v1", baseUserId: "user-1",
  effectiveUserId: "user-1@combined-tests", repositoryKey: "combined-tests-key",
  repositorySlug: "combined-tests", repositoryName: "combined-tests",
  identitySource: "workspace-directory", scopeKind: "local-directory", boundWorkspaceRoot: home,
};
const env = {
  MEMORAX_CODE_HOME: home,
  MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
  MEMORAX_CODE_CODING_SESSIONS_ENABLED: "true",
  MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
  MEMORAX_CODE_MEMORAX_API_KEY: "synthetic-key",
  MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
  MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_AGE_MS: "60000",
};

function sourceTurn(index, outputCount = 0) {
  return {
    client: "codex", sessionId: "combined-session", turnId: `turn-${index}`, turnIndex: index,
    outcome: "completed", closedAt: "2026-09-21T00:00:00.000Z",
    source: { transcriptPath: join(home, "synthetic-session.jsonl"), endBytes: index * 100 },
    items: [
      { type: "message", role: "user", content: [{ type: "input_text", text: `Question ${index}.` }] },
      ...Array.from({ length: outputCount }, (_, tool) => [
        { type: "function_call", call_id: `call-${index}-${tool}`, name: "read_file", arguments: "{}" },
        { type: "function_call_output", call_id: `call-${index}-${tool}`, output: "Tool output. ".repeat(8000) },
      ]).flat(),
      { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: `Answer ${index}.` }] },
    ],
  };
}

function setup(t, overrides = {}) {
  const requests = [];
  const diagnostics = [];
  const sources = new Map();
  let reads = 0;
  const runtime = createAutomaticMemoryWritebackRuntime({
    diagnosticLogger: (message, fields) => diagnostics.push({ message, fields }),
    readCodingSessionTurn: async (reference) => {
      reads += 1;
      return sources.get(reference.turnId);
    },
  });
  t.after(() => runtime.close());
  return {
    runtime, requests, diagnostics, sources, reads: () => reads,
    enqueue(source, qa = {}) {
      sources.set(source.turnId, source);
      return runtime.enqueue({
        client: "codex", sessionKey: source.sessionId, repositoryScope: scope,
        userText: `Question ${source.turnIndex}.`, assistantText: `Answer ${source.turnIndex}.`,
        userTimestamp: 1789948800000, assistantTimestamp: 1789948801000,
        codingTurn: source, env: { ...env, ...overrides }, ...qa,
        fetchImpl: async (_url, init) => {
          requests.push({ body: JSON.parse(init.body), bytes: Buffer.byteLength(init.body, "utf8") });
          return new Response(JSON.stringify({ success: true, data: { task_id: "qa-accepted", status: "queued" } }), {
            status: 202, headers: { "content-type": "application/json" },
          });
        },
      });
    },
  };
}

test("native pending archives retain only frozen source authority and a digest", () => {
  const source = sourceTurn(1, 6);
  const pending = preparePendingCodingSessionTurn(source, scope);
  assert.ok(pending);
  assert.equal("prepared" in pending, false);
  assert.equal("items" in pending.reference, false);
  assert.match(pending.digest, /^[a-f0-9]{64}$/);
  assert.ok(Buffer.byteLength(JSON.stringify(pending), "utf8") < 1000);
  source.source.endBytes = 999;
  assert.equal(pending.reference.source.endBytes, 100);
});

test("a combined batch between one and two MiB remains in one Add request", async (t) => {
  const run = setup(t);
  for (let index = 1; index <= 2; index += 1) run.enqueue(sourceTurn(index, 6));
  await run.runtime.drain();
  assert.equal(run.requests.length, 1);
  assert.ok(run.requests[0].bytes > 1024 * 1024);
  assert.ok(run.requests[0].bytes <= 2 * 1024 * 1024);
  assert.deepEqual(run.requests[0].body.coding_context.turns.map(({ turn_id }) => turn_id), ["turn-1", "turn-2"]);
});

test("a combined batch splits at complete Turn boundaries within the archive limit", async (t) => {
  const run = setup(t);
  for (let index = 1; index <= 2; index += 1) {
    assert.deepEqual(run.enqueue(sourceTurn(index, 12)), { accepted: true });
  }
  assert.equal(run.reads(), 0, "buffering must not re-read native content before QA flush");
  assert.equal(run.requests.length, 0);
  await run.runtime.drain();
  assert.equal(run.reads(), 2);
  assert.equal(run.requests.length, 2);
  for (const [index, { body }] of run.requests.entries()) {
    const archiveBytes = Buffer.byteLength(JSON.stringify(body.coding_context), "utf8");
    assert.ok(archiveBytes > 1024 * 1024);
    assert.ok(archiveBytes <= 2 * 1024 * 1024);
    assert.equal(body.event, undefined);
    assert.deepEqual(body.messages.map(({ content }) => content), [`Question ${index + 1}.`, `Answer ${index + 1}.`]);
    assert.deepEqual(body.coding_context.turns.map(({ turn_id }) => turn_id), [`turn-${index + 1}`]);
    assert.equal(body.coding_context.items.length, 26);
    assert.equal(JSON.stringify(body).includes(home), false);
    assert.equal(JSON.stringify(body).includes("sourceTurnId"), false);
  }
  assert.notEqual(run.requests[0].body.metadata.idempotency_key, run.requests[1].body.metadata.idempotency_key);
  assert.notEqual(run.requests[0].body.coding_context.batch_id, run.requests[1].body.coding_context.batch_id);
});

test("QA does not make an in-budget archive split or disappear when the complete Add exceeds two MiB", async (t) => {
  const run = setup(t, { MEMORAX_CODE_MEMORY_WRITEBACK_CHUNK_MAX_CHARS: "128000" });
  run.enqueue(sourceTurn(1, 20), { assistantText: "Detailed answer. ".repeat(4000) });
  await run.runtime.drain();
  assert.equal(run.requests.length, 1);
  const [{ body, bytes }] = run.requests;
  assert.deepEqual(body.coding_context.turns.map(({ turn_id }) => turn_id), ["turn-1"]);
  assert.ok(Buffer.byteLength(JSON.stringify(body.coding_context), "utf8") <= 2 * 1024 * 1024);
  assert.ok(bytes > 2 * 1024 * 1024);
  assert.equal(run.diagnostics.some(({ message }) => message === "coding_sessions.attachment_skipped"), false);
});

test("QA fragments and overlap attach each original Turn only once", async (t) => {
  const run = setup(t, { MEMORAX_CODE_MEMORY_WRITEBACK_CHUNK_MAX_CHARS: "80" });
  run.enqueue(sourceTurn(1), { assistantText: "Preserve this detailed answer. ".repeat(12) });
  run.enqueue(sourceTurn(2));
  await run.runtime.drain();
  assert.ok(run.requests.length > 2);
  assert.deepEqual(run.requests.flatMap(({ body }) => body.coding_context?.turns.map(({ turn_id }) => turn_id) ?? []), ["turn-1", "turn-2"]);
  assert.equal(run.requests.every(({ body }) => !body.coding_context
    || Buffer.byteLength(JSON.stringify(body.coding_context), "utf8") <= 2 * 1024 * 1024), true);
  assert.equal(run.requests.every(({ body }) => body.messages.every(({ content }) => content.length <= 80)), true);
});

for (const buffered of [false, true]) {
  test(`identical QA in distinct native Turns is archived without collapsing identity (buffered=${buffered})`, async (t) => {
    const run = setup(t, { MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: String(buffered) });
    const qa = { userText: "Continue the work.", assistantText: "Completed." };
    const first = sourceTurn(1);
    assert.deepEqual(run.enqueue(first, qa), { accepted: true });
    assert.deepEqual(run.enqueue(first, qa), { accepted: true });
    assert.deepEqual(run.enqueue(sourceTurn(2), qa), { accepted: true });
    await run.runtime.drain();
    assert.deepEqual(run.requests.flatMap(({ body }) => body.coding_context?.turns.map(({ turn_id }) => turn_id) ?? []), ["turn-1", "turn-2"]);
    assert.equal(run.requests.flatMap(({ body }) => body.messages).length, 4);
  });
}

test("successive batches with identical QA preserve different archive Turn identities", async (t) => {
  const run = setup(t, { MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_TURNS: "2" });
  for (let index = 1; index <= 4; index += 1) {
    run.enqueue(sourceTurn(index), { userText: "Continue the work.", assistantText: "Completed." });
  }
  await run.runtime.drain();
  assert.equal(run.requests.length, 2);
  assert.deepEqual(run.requests.flatMap(({ body }) => body.coding_context.turns.map(({ turn_id }) => turn_id)), [
    "turn-1", "turn-2", "turn-3", "turn-4",
  ]);
  assert.notEqual(run.requests[0].body.metadata.idempotency_key, run.requests[1].body.metadata.idempotency_key);
});

test("an oversized single Turn skips its archive without losing QA or a following archive", async (t) => {
  const run = setup(t);
  run.enqueue(sourceTurn(1, 24));
  run.enqueue(sourceTurn(2));
  await run.runtime.drain();
  assert.deepEqual(run.requests.flatMap(({ body }) => body.messages.map(({ content }) => content)), [
    "Question 1.", "Answer 1.", "Question 2.", "Answer 2.",
  ]);
  assert.deepEqual(run.requests.flatMap(({ body }) => body.coding_context?.turns.map(({ turn_id }) => turn_id) ?? []), ["turn-2"]);
  assert.ok(run.diagnostics.some(({ message, fields }) => message === "coding_sessions.attachment_skipped"
    && fields.reason === "turn_exceeds_archive_limit"));
  assert.equal(run.requests.every(({ body }) => !body.coding_context
    || Buffer.byteLength(JSON.stringify(body.coding_context), "utf8") <= 2 * 1024 * 1024), true);
});

for (const changed of [false, true]) {
  test(`${changed ? "changed" : "missing"} native content leaves buffered QA deliverable`, async (t) => {
    const run = setup(t);
    const source = sourceTurn(1);
    run.enqueue(source);
    if (changed) {
      run.sources.set(source.turnId, { ...source, items: sourceTurn(2).items });
    } else {
      run.sources.delete(source.turnId);
    }
    await run.runtime.drain();
    assert.equal(run.requests.length, 1);
    assert.equal(run.requests[0].body.coding_context, undefined);
    assert.deepEqual(run.requests[0].body.messages.map(({ content }) => content), ["Question 1.", "Answer 1."]);
    assert.ok(run.diagnostics.some(({ message, fields }) => message === "coding_sessions.attachment_skipped"
      && fields.reason === "source_unavailable_or_changed"));
  });
}

test("the existing idle fallback uploads QA and archive together below eight Turns", async (t) => {
  const run = setup(t, { MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_AGE_MS: "20" });
  run.enqueue(sourceTurn(1));
  const deadline = Date.now() + 2000;
  while (!run.requests.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(run.requests.length, 1);
  assert.deepEqual(run.requests[0].body.coding_context.turns.map(({ turn_id }) => turn_id), ["turn-1"]);
  await run.runtime.drain();
  assert.equal(run.requests.length, 1, "shutdown must not upload an already flushed Turn again");
});
