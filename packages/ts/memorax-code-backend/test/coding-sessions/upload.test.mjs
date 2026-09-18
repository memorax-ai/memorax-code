import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { normalizeCodingSessionTurn } from "../../dist/coding-sessions/coding-turn.js";
import { CODING_SESSION_BATCH_MAX_BYTES } from "../../dist/coding-sessions/contracts.js";
import { CODING_SESSION_UPLOAD_IDLE_MS, createCodingSessionUploadRuntime } from "../../dist/coding-sessions/upload.js";

function scope(baseUserId = "test-user", repositorySlug = "test-repository") {
  return {
    schemaVersion: "workspace-memory-scope.v1",
    baseUserId,
    effectiveUserId: `${baseUserId}@${repositorySlug}`,
    repositoryKey: `key-${repositorySlug}`,
    repositorySlug,
    repositoryName: repositorySlug,
    identitySource: "origin-remote",
    scopeKind: "git-repository",
    boundWorkspaceRoot: "/synthetic/workspace",
  };
}

function turn(index = 1) {
  return {
    client: "codex",
    sessionId: "session-1",
    turnId: `turn-${index}`,
    turnIndex: index,
    outcome: "completed",
    closedAt: "2026-01-01T00:00:00.000Z",
    events: [
      { type: "user_message", content: "Please review the upload retry boundary." },
      { type: "assistant_message", phase: "final", content: "The upload retry boundary is verified." },
    ],
  };
}

function fakeClock() {
  let now = 0;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(callback, delay) {
      const timer = { unref() {} };
      timers.set(timer, { at: now + delay, callback });
      return timer;
    },
    clearTimeout(timer) { timers.delete(timer); },
    advance(milliseconds) {
      now += milliseconds;
      for (const [timer, entry] of [...timers]) {
        if (entry.at <= now) {
          timers.delete(timer);
          entry.callback();
        }
      }
    },
    delays() { return [...timers.values()].map(({ at }) => at - now); },
  };
}

async function fixture(t) {
  const home = await mkdtemp(join(tmpdir(), "memorax-coding-upload-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  return {
    MEMORAX_CODE_HOME: home,
    MEMORAX_CODE_MEMORAX_ENDPOINT: "https://memorax.test",
    MEMORAX_CODE_MEMORAX_API_KEY: "synthetic-key",
    MEMORAX_CODE_MEMORAX_USER_ID: "test-user",
    // Source collection is independent of the ordinary QA writeback switch.
    MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "false",
  };
}

function stored(body) {
  return Response.json({ success: true, data: { event: body.event, batch_id: body.batch_id, status: "stored" } });
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("Coding upload has no Turn-count trigger, resets idle and drains complete source batches independently of QA", async (t) => {
  const env = await fixture(t);
  const clock = fakeClock();
  const requests = [];
  const runtime = createCodingSessionUploadRuntime({ enabled: true, clock });
  t.after(() => runtime.close());
  const enqueue = (index) => runtime.enqueue({ turn: turn(index), repositoryScope: scope(), env, fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    return stored(body);
  } });
  for (let index = 1; index <= 25; index += 1) assert.deepEqual(enqueue(index), { accepted: true });
  assert.equal(requests.length, 0);
  clock.advance(CODING_SESSION_UPLOAD_IDLE_MS - 1);
  assert.deepEqual(enqueue(26), { accepted: true });
  clock.advance(1);
  assert.equal(requests.length, 0);
  clock.advance(CODING_SESSION_UPLOAD_IDLE_MS - 1);
  await settle();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].coding_turns.length, 26);
  assert.deepEqual(enqueue(27), { accepted: true });
  await runtime.drain();
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].coding_turns.map(({ turn_id }) => turn_id), ["turn-27"]);
  assert.deepEqual(enqueue(28), { accepted: false, reason: "closed" });
  await runtime.drain();
  assert.equal(requests.length, 2);
});

test("Coding upload flushes at the real twenty-MiB UTF-8 budget without splitting or dropping Turns", async (t) => {
  const env = await fixture(t);
  const requests = [];
  const runtime = createCodingSessionUploadRuntime({ enabled: true });
  t.after(() => runtime.close());
  const sources = Array.from({ length: 12 }, (_, index) => {
    const source = turn(index + 1);
    source.events.splice(1, 0, ...Array.from({ length: 12 }, (_, call) => ({
      type: "tool_result", callId: `call-${call}`, status: "success", output: "中文工具输出。".repeat(16_000),
    })));
    return source;
  });
  for (const source of sources) {
    assert.deepEqual(runtime.enqueue({ turn: source, repositoryScope: scope(), env, fetchImpl: async (_url, init) => {
      const bytes = Buffer.byteLength(init.body, "utf8");
      assert.ok(bytes <= CODING_SESSION_BATCH_MAX_BYTES);
      requests.push({ bytes, body: JSON.parse(init.body) });
      return stored(requests.at(-1).body);
    } }), { accepted: true });
  }
  assert.equal(requests.length, 1);
  assert.ok(requests[0].bytes > 18 * 1024 * 1024);
  await runtime.drain();
  assert.equal(requests.length, 2);
  assert.deepEqual(requests.flatMap(({ body }) => body.coding_turns), sources.map((source) => normalizeCodingSessionTurn({ ...source, repositorySlug: scope().repositorySlug })));
});

test("Coding upload keeps in-flight dedupe beyond cache TTL and freezes payload, batch identity and connection across retry", async (t) => {
  const env = await fixture(t);
  const clock = fakeClock();
  const requests = [];
  let releaseFirst;
  const first = new Promise((resolve) => { releaseFirst = resolve; });
  const runtime = createCodingSessionUploadRuntime({ enabled: true, clock });
  t.after(() => runtime.close());
  const source = turn();
  const enqueue = () => runtime.enqueue({ turn: source, repositoryScope: scope(), env, fetchImpl: async (_url, init) => {
    requests.push({ body: init.body, authorization: init.headers.Authorization });
    if (requests.length === 1) return await first;
    return stored(JSON.parse(init.body));
  } });
  enqueue();
  source.events[0].content = "Changed after acceptance; must not replace the batch.";
  env.MEMORAX_CODE_MEMORAX_API_KEY = "changed-key";
  clock.advance(CODING_SESSION_UPLOAD_IDLE_MS);
  assert.equal(requests.length, 1);
  env.MEMORAX_CODE_MEMORAX_API_KEY = "synthetic-key";
  clock.advance(16 * 60 * 1000);
  assert.deepEqual(enqueue(), { accepted: true });
  releaseFirst(new Response("", { status: 429, headers: { "retry-after": "60" } }));
  await settle();
  assert.deepEqual(clock.delays(), [5000]);
  clock.advance(5000);
  await settle();
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0], requests[1]);
  assert.equal(requests[0].authorization, "Token synthetic-key");
  assert.match(requests[0].body, /Please review/);
  assert.doesNotMatch(requests[0].body, /Changed after/);
  assert.deepEqual(enqueue(), { accepted: true });
  await runtime.drain();
  assert.equal(requests.length, 2);
});

test("Coding upload releases failed batches after bounded retries and never accepts an asynchronous QA receipt", async (t) => {
  const env = await fixture(t);
  const clock = fakeClock();
  let calls = 0;
  const diagnostics = [];
  const runtime = createCodingSessionUploadRuntime({ enabled: true, clock, diagnosticLogger: (...entry) => diagnostics.push(entry) });
  t.after(() => runtime.close());
  const input = { turn: turn(), repositoryScope: scope(), env, fetchImpl: async () => {
    calls += 1;
    return calls <= 2
      ? new Response("private content", { status: 503 })
      : Response.json({ success: true, data: { task_id: "qa-task", status: "accepted" } }, { status: 202 });
  } };
  runtime.enqueue(input);
  clock.advance(CODING_SESSION_UPLOAD_IDLE_MS);
  await settle();
  clock.advance(100);
  await settle();
  assert.equal(calls, 2);
  assert.deepEqual(runtime.enqueue(input), { accepted: true });
  await runtime.drain();
  assert.equal(calls, 3);
  assert.equal(diagnostics.filter(([message]) => message === "coding_sessions.upload.failed").length, 2);
  assert.doesNotMatch(JSON.stringify(diagnostics), /private content|qa-task|test-user|session-1|turn-1/);
});

test("Coding upload isolates clients, sessions, accounts and connections and discards only pending fallback scope", async (t) => {
  const env = await fixture(t);
  const requests = [];
  const runtime = createCodingSessionUploadRuntime({ enabled: true });
  t.after(() => runtime.close());
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ body, authorization: init.headers.Authorization });
    return stored(body);
  };
  const input = { turn: turn(), repositoryScope: scope(), env, fetchImpl };
  runtime.enqueue(input);
  runtime.enqueue({ ...input, turn: { ...turn(), client: "claude-code" } });
  runtime.enqueue({ ...input, turn: { ...turn(), sessionId: "another-session" } });
  runtime.enqueue({ ...input, repositoryScope: scope("another-user"), env: { ...env, MEMORAX_CODE_MEMORAX_USER_ID: "another-user" } });
  runtime.enqueue({ ...input, env: { ...env, MEMORAX_CODE_MEMORAX_API_KEY: "another-key" } });
  const fallbackScope = { ...scope(), repositoryKey: "fallback-key", repositorySlug: "fallback", effectiveUserId: "test-user@fallback", identitySource: "workspace-directory", scopeKind: "local-directory", fallbackReason: "git_metadata_invalid" };
  runtime.enqueue({ ...input, repositoryScope: fallbackScope });
  assert.equal(runtime.discardForScopeUpgrade({ client: "codex", sessionId: "session-1", previousScope: fallbackScope, currentScope: scope() }), 1);
  await runtime.drain();
  assert.equal(requests.length, 5);
  assert.equal(requests.some(({ body }) => body.user_id === "test-user@fallback"), false);
  assert.equal(requests.filter(({ authorization }) => authorization === "Token another-key").length, 1);
});

test("Coding upload honors its opt-in and global kill switch and close drops unsent buffers", async (t) => {
  const env = await fixture(t);
  let calls = 0;
  const input = { turn: turn(), repositoryScope: scope(), env, fetchImpl: async () => { calls += 1; throw new Error("must not call"); } };
  const disabled = createCodingSessionUploadRuntime({ enabled: false });
  assert.deepEqual(disabled.enqueue(input), { accepted: false, reason: "disabled" });
  disabled.close();
  const runtime = createCodingSessionUploadRuntime({ enabled: true });
  assert.deepEqual(runtime.enqueue({ ...input, env: { ...env, MEMORAX_CODE_MEMORAX_WRITEBACK_ENABLED: "false" } }), { accepted: false, reason: "disabled" });
  assert.deepEqual(runtime.enqueue(input), { accepted: true });
  runtime.close();
  await runtime.drain();
  assert.equal(calls, 0);
});
