import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readCodexCodingSessionTurn } from "../../dist/clients/codex/rollout-turn.js";
import { readCodingSessionSourceTurn } from "../../dist/memory/coding-session-source.js";
import { resolveRepositoryMemoryScope } from "../../dist/repository/scope.js";
import { createNativeCodingSessionUploadRuntime } from "../../dist/coding-sessions/native-upload.js";
import { createCodingSessionUploadRuntime } from "../../dist/coding-sessions/upload.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const stored = (body) => Response.json({ success: true, data: { event: "dreaming", batch_id: body.batch_id, status: "stored" } });
const lines = (records) => records.map(JSON.stringify).join("\n") + "\n";
const event = (type, fields) => ({ type: "event_msg", payload: { type, ...fields } });
function records(index, toolCount = 0) {
  const turn_id = `turn-${index}`;
  return [
    event("task_started", { turn_id }),
    { type: "turn_context", payload: { turn_id } },
    { type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `Synthetic prompt ${index}.` }] } },
    ...Array.from({ length: toolCount }, (_, call) => ({ type: "response_item", payload: {
      type: "function_call_output", call_id: `call-${call}`, output: "Synthetic tool result. ".repeat(5_000),
    } })),
    { type: "response_item", payload: { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: `Synthetic answer ${index}.` }] } },
    event("task_complete", { turn_id, last_agent_message: `Synthetic answer ${index}.` }),
  ];
}

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "memorax-native-upload-"));
  const path = join(home, "session.jsonl");
  await writeFile(path, lines([{ type: "session_meta", payload: { id: "session-1" } }]));
  const env = {
    MEMORAX_CODE_HOME: home, MEMORAX_CODE_MEMORAX_ENDPOINT: "https://memorax.test",
    MEMORAX_CODE_MEMORAX_API_KEY: "synthetic-key", MEMORAX_CODE_MEMORAX_USER_ID: "synthetic-user",
    MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "false",
  };
  const scope = (await resolveRepositoryMemoryScope({ workspaceRoot: home, baseUserId: "synthetic-user" })).scope;
  let now = Date.parse("2026-09-20T00:00:00Z");
  const timers = new Map();
  const clock = {
    now: () => now,
    setTimeout(callback, delay) { const timer = { unref() {} }; timers.set(timer, { at: now + delay, callback }); return timer; },
    clearTimeout(timer) { timers.delete(timer); },
  };
  const requests = [];
  const runtimes = [];
  const make = (extra = {}) => {
    const runtime = createNativeCodingSessionUploadRuntime({
      enabled: true, env, clock, readTurn: readCodingSessionSourceTurn,
      fetchImpl: async (_url, init) => { const body = JSON.parse(init.body); requests.push(body); return stored(body); },
      ...extra,
    });
    runtimes.push(runtime);
    return runtime;
  };
  async function advance(duration) {
    now += duration;
    for (const [timer, entry] of [...timers]) {
      if (entry.at <= now) { timers.delete(timer); entry.callback(); }
    }
    await Promise.all(runtimes.map((runtime) => runtime.settle()));
  }
  async function source(index, toolCount = 0) {
    await appendFile(path, lines(records(index, toolCount)));
    const result = await readCodexCodingSessionTurn({ transcriptPath: path, sessionId: "session-1", turnId: `turn-${index}` });
    assert.equal(result.ok, true);
    return {
      client: "codex", sessionId: "session-1", turnId: `turn-${index}`, turnIndex: result.turn.sessionTurnIndex,
      items: result.turn.items, source: result.turn.source, outcome: "completed", closedAt: new Date(now).toISOString(),
    };
  }
  async function cursors() {
    const root = join(home, "runtime", "coding-sessions");
    return await Promise.all((await readdir(root)).filter((name) => name.endsWith(".json"))
      .map(async (name) => JSON.parse(await readFile(join(root, name), "utf8"))));
  }
  const enqueue = (runtime, turn) => runtime.enqueue({ turn, repositoryScope: scope, env });
  t.after(async () => {
    for (const runtime of runtimes) runtime.close();
    await Promise.all(runtimes.map((runtime) => runtime.settle()));
    await rm(home, { recursive: true, force: true });
  });
  return { home, path, env, scope, make, advance, source, enqueue, cursors, requests };
}

test("native archive records references only, starts with observed completions and flushes at 50 new Turns", async (t) => {
  const f = await fixture(t);
  // Historical content exists, but is not registered for collection.
  const historical = await f.source(1);
  const runtime = f.make();
  for (let index = 2; index <= 50; index++) assert.deepEqual(await f.enqueue(runtime, await f.source(index)), { accepted: true });
  await runtime.settle();
  assert.equal(f.requests.length, 0);
  const pending = JSON.stringify(await f.cursors());
  assert.doesNotMatch(pending, /Synthetic prompt|Synthetic answer|synthetic-key|"items"/);
  assert.match(pending, /endBytes/);
  const last = await f.source(51);
  assert.deepEqual(await f.enqueue(runtime, last), { accepted: true });
  await runtime.settle();
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0].turns.map((turn) => turn.turn_index), Array.from({ length: 50 }, (_, i) => i + 2));
  assert.equal(f.requests[0].items.length, 100);
  assert.doesNotMatch(JSON.stringify(f.requests), /transcriptPath|endBytes/);
  assert.equal((await f.cursors())[0].uploadedThrough, 51);
  assert.equal((await f.cursors())[0].turns.length, 0);
  assert.deepEqual(await f.enqueue(runtime, historical), { accepted: false, reason: "turn_before_checkpoint" },
    "a late unuploaded Turn must not be acknowledged merely because its index is below the checkpoint");
  runtime.close();
  const restarted = f.make();
  assert.deepEqual(await f.enqueue(restarted, last), { accepted: true }, "the last confirmed batch is deduplicated across restart");
  await restarted.settle();
  assert.equal(f.requests.length, 1);
});

test("one-MiB trigger keeps a large complete Turn intact and does not require 50 Turns", async (t) => {
  const f = await fixture(t);
  const runtime = f.make();
  const turn = await f.source(1, 11);
  assert.deepEqual(await f.enqueue(runtime, turn), { accepted: true });
  await runtime.settle();
  assert.equal(f.requests.length, 1);
  assert.ok(Buffer.byteLength(JSON.stringify(f.requests[0])) >= 1024 * 1024);
  assert.equal(f.requests[0].turns.length, 1);
  assert.equal(f.requests[0].turns[0].item_count, 13);
});

test("short idle needs five Turns and new interaction resets it; restart uploads sub-five tail after one day", async (t) => {
  const f = await fixture(t);
  const runtime = f.make();
  for (let index = 1; index <= 5; index++) await f.enqueue(runtime, await f.source(index));
  await f.advance(29 * MINUTE);
  assert.equal(f.requests.length, 0);
  await runtime.observeInteraction({ client: "codex", sessionId: "session-1", repositoryScope: f.scope });
  await f.advance(29 * MINUTE);
  assert.equal(f.requests.length, 0);
  await f.advance(MINUTE);
  assert.equal(f.requests.length, 1);
  for (let index = 6; index <= 9; index++) await f.enqueue(runtime, await f.source(index));
  await runtime.drain();
  runtime.close();
  assert.equal(f.requests.length, 1, "shutdown retains a short tail instead of forcing a small batch");
  await f.advance(DAY - 1);
  const restarted = f.make();
  await restarted.settle();
  assert.equal(f.requests.length, 1);
  await f.advance(MINUTE);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests[1].turns.map((turn) => turn.turn_index), [6, 7, 8, 9]);
});

test("failed receipt preserves batch identity/progress through restart and later completions cannot overtake it", async (t) => {
  const f = await fixture(t);
  const attempted = [];
  const failed = f.make({ fetchImpl: async (_url, init) => {
    attempted.push(init.body);
    return Response.json({ success: true, data: { task_id: "qa-task", status: "accepted" } }, { status: 202 });
  } });
  for (let index = 1; index <= 5; index++) await f.enqueue(failed, await f.source(index));
  await failed.drain();
  failed.close();
  const pending = (await f.cursors())[0];
  assert.equal(pending.uploadedThrough, 0);
  assert.equal(pending.turns.length, 5);
  assert.equal(pending.batch.id, JSON.parse(attempted[0]).batch_id);
  const restarted = f.make({ fetchImpl: async (_url, init) => { attempted.push(init.body); return stored(JSON.parse(init.body)); } });
  for (let index = 6; index <= 10; index++) await f.enqueue(restarted, await f.source(index));
  await restarted.settle();
  assert.equal(attempted.length, 1);
  await f.advance(5 * MINUTE);
  assert.equal(attempted.length, 2);
  assert.equal(attempted[1], attempted[0]);
  assert.deepEqual((await f.cursors())[0].turns.map((turn) => turn.turnIndex), [6, 7, 8, 9, 10]);
  await restarted.drain();
  assert.equal(attempted.length, 3);
  assert.deepEqual(JSON.parse(attempted[2]).turns.map((turn) => turn.turn_index), [6, 7, 8, 9, 10]);
});

test("registration stays independent of an in-flight upload; two runtimes do not upload the same batch concurrently", async (t) => {
  const f = await fixture(t);
  let release;
  const response = new Promise((resolve) => { release = resolve; });
  const sent = [];
  const fetchImpl = async (_url, init) => { const body = JSON.parse(init.body); sent.push(body); await response; return stored(body); };
  const first = f.make({ fetchImpl });
  for (let index = 1; index <= 5; index++) await f.enqueue(first, await f.source(index));
  const draining = first.drain();
  // Wait for the injected request, not for a wall-clock upload deadline.
  while (!sent.length) await new Promise((resolve) => setImmediate(resolve));
  const second = f.make({ fetchImpl });
  assert.deepEqual(await f.enqueue(second, await f.source(6)), { accepted: true });
  assert.equal((await f.cursors())[0].turns.length, 6);
  release();
  await draining;
  await second.settle();
  assert.equal(sent.length, 1);
  assert.deepEqual((await f.cursors())[0].turns.map((turn) => turn.turnIndex), [6]);
});

test("rewritten or unavailable native content cannot advance the cursor or change a retry payload", async (t) => {
  const f = await fixture(t);
  const runtime = f.make();
  for (let index = 1; index <= 5; index++) await f.enqueue(runtime, await f.source(index));
  const original = await readFile(f.path, "utf8");
  await writeFile(f.path, original.replace("Synthetic answer 1.", "Changedxx answer 1."));
  await runtime.drain();
  assert.equal(f.requests.length, 0);
  const state = (await f.cursors())[0];
  assert.equal(state.uploadedThrough, 0);
  await truncate(f.path, 1);
  await f.advance(5 * MINUTE);
  assert.equal(f.requests.length, 0);
  await writeFile(f.path, original);
  runtime.close();
  await f.advance(5 * MINUTE);
  const restarted = f.make();
  await restarted.settle();
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].batch_id, state.batch.id);
});

test("restart rechecks current connection and global kill switch without persisting credentials", async (t) => {
  const f = await fixture(t);
  const runtime = f.make();
  for (let index = 1; index <= 5; index++) await f.enqueue(runtime, await f.source(index));
  runtime.close();
  await runtime.settle();
  f.env.MEMORAX_CODE_MEMORAX_API_KEY = "another-synthetic-key";
  const changed = f.make();
  await f.advance(DAY);
  assert.equal(f.requests.length, 0);
  changed.close();
  f.env.MEMORAX_CODE_MEMORAX_API_KEY = "synthetic-key";
  f.env.MEMORAX_CODE_MEMORAX_WRITEBACK_ENABLED = "false";
  const disabled = f.make();
  await disabled.settle();
  assert.equal(f.requests.length, 0);
  disabled.close();
  delete f.env.MEMORAX_CODE_MEMORAX_WRITEBACK_ENABLED;
  await f.make().settle();
  assert.equal(f.requests.length, 1);
});

test("native upload uses the explicitly selected configuration home", async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.home, "config.toml"), '[memorax]\nendpoint = "https://memorax.test"\napi_key = "synthetic-key"\nuser_id = "synthetic-user"\n');
  const runtime = f.make({ memoraxCodeHome: f.home, env: {} });
  for (let index = 1; index <= 5; index++) await f.enqueue(runtime, await f.source(index));
  await runtime.drain();
  assert.equal(f.requests.length, 1);
});

test("the shared uploader rejects native references when no native reader is installed", async (t) => {
  const f = await fixture(t);
  const runtime = createCodingSessionUploadRuntime({ enabled: true, env: f.env });
  t.after(() => runtime.close());
  assert.deepEqual(await f.enqueue(runtime, await f.source(1)), { accepted: false, reason: "source_reader_unavailable" });
  await runtime.drain();
  assert.equal(f.requests.length, 0);
});
