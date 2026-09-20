import assert from "node:assert/strict";
import { appendFile, mkdtemp, readFile, readdir, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readCodexCodingSessionTurn } from "../../dist/clients/codex/rollout-turn.js";
import { readClaudeCodingSessionTurn } from "../../dist/clients/claude/transcript-turn.js";
import { createCodingSessionCursorStore } from "../../dist/coding-sessions/cursor-store.js";
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

test("projection upgrade replays an old pending batch byte-for-byte and deduplicates its old acknowledgement", async (t) => {
  const f = await fixture(t);
  const path = join(f.home, "claude.jsonl");
  const transcript = (index) => [
    { type: "user", userType: "external", uuid: `user-${index}`, promptId: `prompt-${index}`, sessionId: "session-1",
      message: { role: "user", content: [{ type: "text", text: "  inspect\n" }, { type: "text", text: "the project  " }] } },
    { type: "assistant", uuid: `assistant-${index}`, parentUuid: `user-${index}`, sessionId: "session-1",
      message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "  checked\n" }, { type: "text", text: "done  " }] } },
  ];
  await writeFile(path, lines(transcript(1)));
  const source = async (index, projectionVersion) => {
    const result = await readClaudeCodingSessionTurn({ transcriptPath: path, sessionId: "session-1", promptId: `prompt-${index}`, projectionVersion });
    assert.equal(result.ok, true);
    return {
      client: "claude-code", sessionId: "session-1", turnId: `prompt-${index}`, turnIndex: result.turn.sessionTurnIndex,
      source: result.turn.source, items: result.turn.items, outcome: "completed", closedAt: "2026-09-20T00:00:00.000Z",
    };
  };
  const attempted = [];
  const oldRuntime = f.make({
    readTurn: (ref) => readCodingSessionSourceTurn({ ...ref, projectionVersion: 1 }),
    fetchImpl: async (_url, init) => { attempted.push(init.body); return new Response("lost receipt", { status: 503 }); },
  });
  assert.deepEqual(await f.enqueue(oldRuntime, await source(1, 1)), { accepted: true });
  await f.advance(DAY);
  oldRuntime.close();
  assert.equal(attempted.length, 1);
  // Model the pre-upgrade cursor: no projection field, frozen v1 digest and ID.
  const store = createCodingSessionCursorStore(f.home);
  const [key] = await store.list();
  await store.update(key, (state) => ({ state: { ...state, turns: state.turns.map(({ projectionVersion, ...ref }) => ref) }, value: undefined }));
  const pending = store.read(key);
  const runtime = f.make({ fetchImpl: async (_url, init) => { attempted.push(init.body); return stored(JSON.parse(init.body)); } });
  const latest = await source(1, 2);
  assert.notDeepEqual(latest.items, JSON.parse(attempted[0]).items);
  assert.deepEqual(await f.enqueue(runtime, latest), { accepted: true });
  assert.deepEqual(store.read(key), pending, "duplicate completion must not upgrade frozen bytes or identity");
  const altered = { ...latest, items: [latest.items[0], { ...latest.items[1], content: [{ type: "output_text", text: "not native" }] }] };
  assert.deepEqual(await f.enqueue(runtime, altered), { accepted: false, reason: "source_mismatch" });
  await appendFile(path, lines(transcript(2)));
  assert.deepEqual(await f.enqueue(runtime, await source(2, 2)), { accepted: true });
  assert.equal(store.read(key).turns[1].projectionVersion, 2);
  await f.advance(5 * MINUTE);
  assert.equal(attempted.length, 2);
  assert.equal(attempted[1], attempted[0]);
  assert.equal(store.read(key).uploadedThrough, 1);
  runtime.close();
  const restarted = f.make();
  assert.deepEqual(await f.enqueue(restarted, latest), { accepted: true });
  assert.deepEqual(await f.enqueue(restarted, altered), { accepted: false, reason: "turn_before_checkpoint" });
  await f.advance(DAY);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.requests[0].items, (await source(2, 2)).items);
  assert.doesNotMatch(JSON.stringify(f.requests), /projectionVersion|transcriptPath|endBytes/);
  assert.equal(store.read(key).confirmedTurns[0].projectionVersion, 2);
});

test("Codex search-item upgrade preserves frozen v1 batches and confirmed deduplication", async (t) => {
  for (const projectionVersion of [undefined, 1]) {
    await t.test(projectionVersion === undefined ? "legacy cursor without projection version" : "explicit v1 cursor", async (t) => {
      const f = await fixture(t);
      const searchTypes = ["web_search_call", "tool_search_call", "tool_search_output"];
      const appendTurn = async (index) => {
        const turn = records(index);
        const search = [
          { type: "web_search_call", status: "completed", action: { type: "search", query: "Synthetic reference" } },
          { type: "tool_search_call", call_id: `search-${index}`, execution: "server", status: "completed",
            arguments: { query: "Synthetic tool" } },
          { type: "tool_search_output", call_id: `search-${index}`, execution: "server", status: "completed",
            tools: [{ type: "function", name: "lookup", description: "Synthetic lookup",
              parameters: { type: "object", properties: {} } }] },
        ].map((payload) => ({ type: "response_item", payload }));
        await appendFile(f.path, lines([...turn.slice(0, 3), ...search, ...turn.slice(3)]));
      };
      const source = async (index, version) => {
        const result = await readCodexCodingSessionTurn({
          transcriptPath: f.path, sessionId: "session-1", turnId: `turn-${index}`, projectionVersion: version,
        });
        assert.equal(result.ok, true);
        return {
          client: "codex", sessionId: "session-1", turnId: `turn-${index}`, turnIndex: result.turn.sessionTurnIndex,
          items: result.turn.items, source: result.turn.source, outcome: "completed", closedAt: "2026-09-20T00:00:00.000Z",
        };
      };
      await appendTurn(1);
      const attempted = [];
      const oldRuntime = f.make({
        readTurn: (ref) => readCodingSessionSourceTurn({ ...ref, projectionVersion: 1 }),
        fetchImpl: async (_url, init) => { attempted.push(init.body); return new Response("lost receipt", { status: 503 }); },
      });
      assert.deepEqual(await f.enqueue(oldRuntime, await source(1, 1)), { accepted: true });
      await f.advance(DAY);
      oldRuntime.close();
      assert.equal(attempted.length, 1);
      assert.deepEqual(JSON.parse(attempted[0]).items.map((item) => item.type), ["message", "message"]);

      const store = createCodingSessionCursorStore(f.home);
      const [key] = await store.list();
      // Both historical cursor spellings must keep the pre-upgrade bytes and batch ID.
      await store.update(key, (state) => ({ state: { ...state,
        turns: state.turns.map(({ projectionVersion: _version, ...ref }) => ({
          ...ref, ...(projectionVersion === undefined ? {} : { projectionVersion }),
        })),
      }, value: undefined }));
      const pending = store.read(key);
      const latest = await source(1, 2);
      assert.deepEqual(latest.items.slice(1, -1).map((item) => item.type), searchTypes);
      const runtime = f.make({ fetchImpl: async (_url, init) => { attempted.push(init.body); return stored(JSON.parse(init.body)); } });
      assert.deepEqual(await f.enqueue(runtime, latest), { accepted: true });
      assert.deepEqual(store.read(key), pending, "a repeated v2 completion must not upgrade a frozen v1 reference");
      const altered = { ...latest, items: latest.items.map((item) => item.type === "web_search_call"
        ? { ...item, action: { type: "search", query: "Not the native query" } } : item) };
      assert.deepEqual(await f.enqueue(runtime, altered), { accepted: false, reason: "source_mismatch" });

      await appendTurn(2);
      const next = await source(2, 2);
      assert.deepEqual(await f.enqueue(runtime, next), { accepted: true });
      assert.equal(store.read(key).turns[1].projectionVersion, 2);
      assert.deepEqual(store.read(key).batch, pending.batch, "a new v2 Turn must not enter the frozen v1 batch");
      await f.advance(5 * MINUTE);
      assert.equal(attempted.length, 2);
      assert.equal(attempted[1], attempted[0], "retry must preserve the entire old HTTP body byte-for-byte");
      assert.equal(store.read(key).uploadedThrough, 1);
      assert.equal(store.read(key).confirmedTurns[0].projectionVersion, projectionVersion);
      assert.deepEqual(store.read(key).turns.map((turn) => turn.turnId), ["turn-2"]);
      runtime.close();

      const restarted = f.make();
      const confirmed = store.read(key);
      assert.deepEqual(await f.enqueue(restarted, latest), { accepted: true });
      assert.deepEqual(store.read(key), confirmed, "an old acknowledgement must deduplicate the same native v2 completion");
      assert.deepEqual(await f.enqueue(restarted, altered), { accepted: false, reason: "turn_before_checkpoint" });
      await f.advance(DAY);
      assert.equal(f.requests.length, 1);
      assert.deepEqual(f.requests[0].turns.map((turn) => turn.turn_id), ["turn-2"]);
      assert.deepEqual(f.requests[0].items, next.items);
      assert.deepEqual(f.requests[0].items.slice(1, -1).map((item) => item.type), searchTypes);
      assert.doesNotMatch(JSON.stringify(f.requests), /projectionVersion|transcriptPath|endBytes/);
      assert.equal(store.read(key).confirmedTurns[0].projectionVersion, 2);
    });
  }
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
