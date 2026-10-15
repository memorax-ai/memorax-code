import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { preparePendingCodingSessionTurn } from "../../dist/coding-sessions/attachment.js";
import { CODING_SESSION_BATCH_MAX_BYTES } from "../../dist/coding-sessions/contracts.js";
import { createAutomaticMemoryWritebackRuntime } from "../../dist/memory/automatic-writeback.js";
import { combinedMemoryWritebackParts } from "../../dist/memory/writeback-archive.js";

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
        client: source.client, sessionKey: source.sessionId, repositoryScope: scope,
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

test("valid tool archives do not bypass existing QA content rejection", async (t) => {
  const run = setup(t);
  const source = sourceTurn(1, 1);
  source.items[2].output = "Tool inspection complete.";
  assert.ok(preparePendingCodingSessionTurn(source, scope));

  for (const [qa, reason] of [
    [{ userText: "pwd" }, "user_prompt_empty"],
    [{ assistantText: "pwd" }, "assistant_text_empty"],
    [{ userText: "password=synthetic-password" }, "user_prompt_empty"],
    [{ assistantText: "password=synthetic-password" }, "assistant_text_empty"],
  ]) {
    assert.deepEqual(run.enqueue(source, qa), { accepted: false, reason });
  }
  await run.runtime.drain();
  assert.equal(run.requests.length, 0);
  assert.equal(run.reads(), 0, "rejected QA must not schedule a separate archive reread");
});

test("ordinary QA keeps the default eight-Turn Add trigger and payload with archives", async (t) => {
  const run = setup(t);
  const expectedMessages = [];
  for (let index = 1; index <= 8; index += 1) {
    const source = sourceTurn(index, 1);
    source.items[2].output = `Tool result ${index}.`;
    assert.deepEqual(run.enqueue(source), { accepted: true });
    expectedMessages.push(
      { role: "user", content: `Question ${index}.` },
      { role: "assistant", content: `Answer ${index}.` },
    );
    if (index < 8) {
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(run.requests.length, 0);
      assert.equal(run.reads(), 0);
    }
  }

  const deadline = Date.now() + 2000;
  while (!run.requests.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(run.requests.length, 1, "the eighth Turn must trigger Add before shutdown");
  const { body } = run.requests[0];
  assert.deepEqual(body.messages.map(({ role, content }) => ({ role, content })), expectedMessages);
  assert.equal(body.content_type, "code");
  assert.equal(body.async_mode, true);
  assert.deepEqual(body.coding_context.turns.map(({ turn_id }) => turn_id),
    Array.from({ length: 8 }, (_, index) => `turn-${index + 1}`));
  assert.equal(body.coding_context.items.filter(({ type }) => type === "function_call").length, 8);
  assert.equal(body.coding_context.items.filter(({ type }) => type === "function_call_output").length, 8);
  await run.runtime.drain();
  assert.equal(run.requests.length, 1);
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

test("a truncated large Turn retains its archive and QA alongside a following archive", async (t) => {
  const run = setup(t);
  run.enqueue(sourceTurn(1, 24));
  run.enqueue(sourceTurn(2));
  await run.runtime.drain();
  assert.deepEqual(run.requests.flatMap(({ body }) => body.messages.map(({ content }) => content)), [
    "Question 1.", "Answer 1.", "Question 2.", "Answer 2.",
  ]);
  assert.deepEqual(run.requests.flatMap(({ body }) => body.coding_context?.turns.map(({ turn_id }) => turn_id) ?? []), ["turn-1", "turn-2"]);
  assert.equal(run.requests[0].body.coding_context.turns[0].truncation.original_item_count, 50);
  assert.equal(run.diagnostics.some(({ message }) => message === "coding_sessions.attachment_skipped"), false);
  assert.equal(run.requests.every(({ body }) => !body.coding_context
    || Buffer.byteLength(JSON.stringify(body.coding_context), "utf8") <= 2 * 1024 * 1024), true);
});

for (const client of ["codex", "opencode"]) {
  for (const escaped of [false, true]) {
    test(`large Turns reserve the complete attachment envelope (${client}, escaped=${escaped})`, async (t) => {
      const run = setup(t);
      const identifier = escaped ? '中"\\\u0001'.repeat(63) : "x".repeat(252);
      const repositoryScope = { ...scope, repositorySlug: identifier };
      const expectedIds = [];
      for (let index = 1; index <= 2; index += 1) {
        const source = {
          ...sourceTurn(index, 24), client, sessionId: identifier,
          turnId: `${identifier}-${index}`, turnIndex: Number.MAX_SAFE_INTEGER - 2 + index,
        };
        if (client === "opencode") delete source.source;
        expectedIds.push(source.turnId);
        assert.deepEqual(run.enqueue(source, {
          repositoryScope, userText: `Question ${index}.`, assistantText: `Answer ${index}.`,
        }), { accepted: true });
      }
      await run.runtime.drain();
      assert.equal(run.reads(), client === "codex" ? 2 : 0);
      assert.equal(run.requests.length, 2, "large archives must split at complete Turn boundaries");
      assert.deepEqual(run.requests.flatMap(({ body }) => body.messages.map(({ content }) => content)), [
        "Question 1.", "Answer 1.", "Question 2.", "Answer 2.",
      ]);
      assert.deepEqual(run.requests.flatMap(({ body }) => body.coding_context?.turns.map(({ turn_id }) => turn_id) ?? []), expectedIds);
      for (const { body } of run.requests) {
        const archive = body.coding_context;
        const bytes = Buffer.byteLength(JSON.stringify(archive), "utf8");
        assert.ok(bytes <= CODING_SESSION_BATCH_MAX_BYTES, `attachment exceeded its limit: ${bytes}`);
        assert.ok(bytes > CODING_SESSION_BATCH_MAX_BYTES - 1024, "exercise the byte limit, not just the item limit");
        assert.equal(archive.repository_slug, identifier);
        assert.equal(archive.turns[0].item_count, archive.items.length);
        assert.equal(archive.turns[0].truncation.original_item_count, 50);
        assert.ok(archive.turns[0].truncation.truncated_text_fields > 0);
        const calls = archive.items.filter(({ type }) => type === "function_call").map(({ call_id }) => call_id);
        const outputs = archive.items.filter(({ type }) => type === "function_call_output").map(({ call_id }) => call_id);
        assert.ok(calls.length > 0);
        assert.deepEqual(calls, outputs);
        assert.equal(archive.items[0].role, "user");
        assert.equal(archive.items.at(-1).phase, "final_answer");
      }
      assert.equal(run.diagnostics.some(({ message }) => message === "coding_sessions.attachment_skipped"), false);
    });
  }
}

test("the final attachment size guard still rejects oversized prepared data while preserving QA", async () => {
  const source = { ...sourceTurn(1, 1), client: "opencode", source: undefined };
  const pending = preparePendingCodingSessionTurn(source, scope);
  pending.prepared.items[2].output = "x".repeat(CODING_SESSION_BATCH_MAX_BYTES);
  const messages = [{ role: "user", content: "Question 1." }, { role: "assistant", content: "Answer 1." }];
  const diagnostics = [];
  const parts = await combinedMemoryWritebackParts({
    idempotencyKey: "oversized-prepared", messages, codingTurn: pending,
  }, {
    repositoryScope: scope, env,
    diagnosticLogger: (message, fields) => diagnostics.push({ message, fields }),
  });
  assert.deepEqual(parts.flatMap(({ messages }) => messages.map(({ role, content }) => ({ role, content }))), messages);
  assert.equal(parts.every((part) => part.codingContext === undefined), true);
  assert.ok(diagnostics.some(({ fields }) => fields.reason === "turn_exceeds_archive_limit"));
});

test("attachment assembly failure leaves the complete QA batch deliverable", async (t) => {
  const run = setup(t);
  run.enqueue(sourceTurn(1));
  run.enqueue({ ...sourceTurn(2), turnIndex: 1 }, { userText: "Question 2.", assistantText: "Answer 2." });
  assert.equal(run.requests.length, 0);
  await run.runtime.drain();
  assert.equal(run.requests.length, 1);
  assert.equal(run.requests[0].body.coding_context, undefined);
  assert.deepEqual(run.requests[0].body.messages.map(({ content }) => content), [
    "Question 1.", "Answer 1.", "Question 2.", "Answer 2.",
  ]);
  assert.equal(run.diagnostics.filter(({ message, fields }) => message === "coding_sessions.attachment_skipped"
    && fields.reason === "assembly_failed").length, 1);
});

test("attachment size calculation failure leaves QA deliverable before dispatch", async (t) => {
  const byteLength = Buffer.byteLength;
  t.mock.method(Buffer, "byteLength", (value, encoding) => {
    if (typeof value === "string" && value.startsWith('{"schema_version":1,"redaction_version":1,')
      && !value.includes('"items":[]')) {
      throw new Error("synthetic attachment size failure");
    }
    return byteLength(value, encoding);
  });
  const run = setup(t);
  run.enqueue(sourceTurn(1));
  assert.equal(run.requests.length, 0);
  await run.runtime.drain();
  assert.equal(run.requests.length, 1);
  assert.equal(run.requests[0].body.coding_context, undefined);
  assert.deepEqual(run.requests[0].body.messages.map(({ content }) => content), ["Question 1.", "Answer 1."]);
  assert.equal(run.diagnostics.filter(({ message, fields }) => message === "coding_sessions.attachment_skipped"
    && fields.reason === "assembly_failed").length, 1);
});

for (const failure of ["missing", "changed", "throwing"]) {
  test(`${failure} native content leaves buffered QA deliverable`, async (t) => {
    const run = setup(t);
    const source = sourceTurn(1);
    run.enqueue(source);
    if (failure === "missing") {
      run.sources.delete(source.turnId);
    } else if (failure === "changed") {
      run.sources.set(source.turnId, { ...source, items: sourceTurn(2).items });
    } else {
      const unreadable = { ...source };
      Object.defineProperty(unreadable, "items", { get() { throw new Error("synthetic native read failure"); } });
      run.sources.set(source.turnId, unreadable);
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
