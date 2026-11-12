import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createCursorMemoryHookRuntime } from "../../../dist/clients/cursor/memory-hook-runtime.js";
import { cursorTextDigest } from "../../../dist/clients/cursor/database-turn.js";
import { cursorTurnStatePath } from "../../../dist/clients/cursor/turn-store.js";
import { createRepositoryMemorySessionRuntime } from "../../../dist/memory/repository-session.js";
import { readDiagnosticHistory } from "../../../dist/lifecycle/diagnostic-history.js";
import { createMemoryService } from "../../../dist/memory/service.js";
import { createMemorySearchGuidanceRuntime } from "../../../dist/memory/search-guidance.js";
import { JEV_MODEL } from "../../../dist/provider/jev/adapter.js";
import { readCurrentTraceTurn } from "../../../dist/trace/store.js";
import { withJsonFileLockAsync } from "../../../../memorax-code-adapter-common/src/config-utils.mjs";
import { databaseFixture, nativeField, nativeMessage } from "./support/database-fixtures.mjs";

const prompt = "Keep the synthetic Cursor module boundary stable.";
const answer = "The synthetic Cursor module boundary is preserved.";
async function fixture() {
  const db = await databaseFixture();
  const root = await realpath(db.directory);
  const home = join(root, "memorax"), workspace = join(root, "workspace");
  await Promise.all([mkdir(home), mkdir(workspace)]);
  const start = { version: 1, client: "cursor", sessionId: db.sessionId,
    turnId: randomUUID(), cwd: workspace, prompt, databasePath: db.databasePath };
  const userMessageId = randomUUID();
  const native = (command = start, steps = [{ type: "assistantMessage", text: answer }]) => ({
    requestId: command.turnId, userPrompt: command.prompt, userMessageId, steps,
  });
  const env = {
    MEMORAX_CODE_HOME: home, MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "true",
    MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true", MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
    MEMORAX_CODE_CURSOR_TRACE_ENABLED: "false", MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
    MEMORAX_CODE_MEMORAX_API_KEY: "synthetic-secret", MEMORAX_CODE_MEMORAX_USER_ID: "cursor-test-user",
  };
  return { ...db, root, home, workspace, start, env, native,
    append: () => db.write({ latestGenerationId: start.turnId, turns: [native()] }) };
}
function response(start, digest = cursorTextDigest(answer)) {
  const { prompt: _prompt, ...identity } = start;
  return { ...identity, phase: "response", responseDigest: digest };
}
function stop(start, status = "completed") {
  const { prompt: _prompt, ...identity } = start;
  return { ...identity, phase: "stop", status };
}
function runtime(f, overrides = {}) {
  const writes = [];
  const instance = createCursorMemoryHookRuntime({ env: f.env, memoraxCodeHome: f.home,
    fetchImpl: async () => { throw new Error("Cursor hooks must not auto-search"); },
    automaticWriteback: (input) => { writes.push(input); return { accepted: true }; },
    databaseRetryDelayMs: 20, databaseRetryWindowMs: 2000, ...overrides });
  return { instance, writes };
}
const observeResponse = (instance, start, text = answer) => instance.writeback(response(start, cursorTextDigest(text)));
const readState = async (f) => JSON.parse(await readFile(cursorTurnStatePath(f.home, f.sessionId), "utf8"));
async function until(predicate) {
  for (let i = 0; i < 100; i++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Expected pending writeback to complete");
}

test("Cursor first turn reads DB QA without transcript or starting content, once across restart", async () => {
  const f = await fixture();
  const quotaCalls = [];
  const pendingQuotaNotice = {
    queue() {},
    async claim() { quotaCalls.push("claim"); return "Pending Add quota notice."; },
    close() { quotaCalls.push("close"); },
  };
  const first = runtime(f, { pendingQuotaNotice }); let second;
  try {
    assert.equal((await first.instance.recordTurnStart(f.start)).recorded, true);
    await f.append();
    assert.equal((await observeResponse(first.instance, f.start)).reason, "completion_event_missing");
    assert.deepEqual(await first.instance.writeback(stop(f.start)), { ok: true, scheduled: true });
    assert.equal(first.writes.length, 1);
    assert.equal(first.writes[0].client, "cursor");
    assert.equal(first.writes[0].userText, prompt);
    assert.equal(first.writes[0].assistantText, answer);
    assert.equal(first.instance.size(), 0);
    const persisted = await readState(f);
    assert.equal(persisted.active.metadata, undefined);
    for (const text of [prompt, answer, "synthetic-secret"]) assert.equal(JSON.stringify(persisted).includes(text), false);
    if (process.platform !== "win32") assert.equal((await stat(cursorTurnStatePath(f.home, f.sessionId))).mode & 0o777, 0o600);
    first.instance.close(); second = runtime(f, { pendingQuotaNotice });
    assert.equal((await second.instance.writeback(stop(f.start))).reason, "already_accepted_locally");
    assert.equal(second.writes.length, 0);
    assert.deepEqual(quotaCalls, [], "Cursor must leave Add notices for clients that can display them");
  } finally { first.instance.close(); second?.instance.close(); await f.cleanup(); }
});

test("Cursor projectless turns use the shared General scope without a workspace", async () => {
  const f = await fixture(); const { instance, writes } = runtime(f);
  const start = { ...f.start, cwd: undefined, workspaceKind: "projectless" };
  try {
    assert.equal((await instance.recordTurnStart(start)).recorded, true);
    f.write({ latestGenerationId: start.turnId, turns: [f.native(start)] });
    await observeResponse(instance, start);
    assert.deepEqual(await instance.writeback(stop(start)), { ok: true, scheduled: true });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].repositoryScope.scopeKind, "general");
    assert.equal(writes[0].repositoryScope.effectiveUserId, "cursor-test-user@General");
    assert.equal(writes[0].repositoryScope.boundWorkspaceRoot, undefined);
    const persisted = await readState(f);
    assert.equal(persisted.active.workspaceKind, "projectless");
    assert.equal("cwd" in persisted.active, false);
    const current = await readCurrentTraceTurn({ client: "cursor", sessionId: f.sessionId,
      memoraxCodeHome: f.home, env: f.env });
    assert.equal(current.traceContext.workspaceKind, "projectless");
    assert.equal(current.traceContext.cwd, undefined);
  } finally { instance.close(); await f.cleanup(); }
});

test("Cursor automatic Add excludes native Hook reminders and keeps the user-text digest authoritative", async (t) => {
  const contexts = [
    { event: "beforeSubmitPrompt", text: "Synthetic Profile Memory: prefer concise review comments." },
    { event: "beforeSubmitPrompt", text: "Synthetic periodic reminder: consult the memorax-code Skill and stored procedures." },
  ];
  for (const matches of [true, false]) await t.test(matches ? "reminders excluded" : "reminders cannot replace user text", async () => {
    const f = await fixture(); const { instance, writes } = runtime(f);
    try {
      await instance.recordTurnStart(f.start);
      const promptDigest = (await readState(f)).active.promptDigest;
      assert.equal(promptDigest, cursorTextDigest(prompt));
      const hookContexts = [...contexts, { event: "beforeSubmitPrompt", text: prompt }];
      f.write({ latestGenerationId: f.start.turnId, turns: [{
        ...f.native(),
        userPrompt: matches ? prompt : "A different native user question.",
        user: { extra: hookContexts.map(({ event, text }) => nativeField(21,
          nativeMessage(nativeField(1, event), nativeField(2, text)))) },
      }] });
      await observeResponse(instance, f.start);
      const result = await instance.writeback(stop(f.start));
      assert.equal((await readState(f)).active.promptDigest, promptDigest);
      if (matches) {
        assert.deepEqual(result, { ok: true, scheduled: true });
        assert.equal(writes.length, 1);
        assert.equal(writes[0].userText, prompt);
        assert.equal(writes[0].assistantText, answer);
        for (const { text } of contexts) assert.equal(JSON.stringify(writes[0]).includes(text), false);
      } else {
        assert.equal(result.reason, "native_prompt_mismatch");
        assert.equal(writes.length, 0);
      }
    } finally { instance.close(); await f.cleanup(); }
  });
});

test("Cursor excludes native subagent users and simulated completions even with matching Hook identities", async (t) => {
  for (const kind of ["subagent", "simulated"]) await t.test(kind, async () => {
    const f = await fixture(); const { instance, writes } = runtime(f);
    try {
      // A valid Hook envelope cannot turn a task-generated native user into
      // ordinary user authority, even if future clients emit complete IDs.
      await instance.recordTurnStart(f.start);
      const excludedUser = kind === "subagent"
        ? f.blob(nativeMessage(nativeField(1, prompt)))
        : f.user({ text: prompt, simulated: true });
      const excludedTurn = f.turn({ requestId: f.start.turnId, userRef: excludedUser,
        stepRefs: [f.step({ text: answer })] });
      f.write({ latestGenerationId: f.start.turnId, turns: [excludedTurn] });
      await observeResponse(instance, f.start);
      const rejected = await instance.writeback(stop(f.start));
      const reason = kind === "subagent" ? "native_user_unsupported" : "native_user_simulated";
      assert.equal(rejected.scheduled, false);
      assert.equal(rejected.reason, reason);
      assert.equal(writes.length, 0);
      assert.equal((await readState(f)).active.state, "blocked");
      assert.ok((await readState(f)).active.metadata);

      // Excluded history must not suppress the next genuine user Turn.
      const next = { ...f.start, turnId: randomUUID(), prompt: "A subsequent real user question." };
      await instance.recordTurnStart(next);
      f.write({ latestGenerationId: next.turnId, turns: [excludedTurn, f.native(next)] });
      await observeResponse(instance, next);
      assert.deepEqual(await instance.writeback(stop(next)), { ok: true, scheduled: true });
      assert.equal(writes.length, 1);
      assert.equal(writes[0].userText, next.prompt);
      assert.equal(writes[0].assistantText, answer);
    } finally { instance.close(); await f.cleanup(); }
  });
});

test("Cursor native child metadata prevents registration before generation or content checks", async (t) => {
  for (const childInfo of [
    { parentComposerId: randomUUID(), rootParentConversationId: randomUUID(), subagentTypeName: "synthetic-maintenance" },
    null,
    "invalid",
    {},
  ]) await t.test(JSON.stringify(childInfo), async () => {
    const f = await fixture(); const { instance, writes } = runtime(f);
    try {
      // Metadata can arrive before conversationState. Complete Hook IDs must
      // not authorize Repo Memory dispatch for this native child session.
      f.writeComposer({ composerId: f.sessionId, subagentInfo: childInfo });
      assert.deepEqual(await instance.recordTurnStart(f.start), { ok: true, recorded: false });
      await assert.rejects(readFile(cursorTurnStatePath(f.home, f.sessionId)), { code: "ENOENT" });
      assert.equal(failures(f).length, 0);
      assert.equal((await instance.writeback(stop(f.start))).reason, "start_missing");
      assert.equal(writes.length, 0);
    } finally { instance.close(); await f.cleanup(); }
  });
});

test("Cursor durably deduplicates failed session classification without registering a Turn", async () => {
  const f = await fixture(); let current = runtime(f);
  try {
    f.setRow(`composerData:${f.sessionId}`, JSON.stringify({ composerId: randomUUID(), privateContent: prompt }));
    for (const result of await Promise.all([
      current.instance.recordTurnStart(f.start),
      current.instance.recordTurnStart(f.start),
      current.instance.recordTurnStart({ ...f.start, turnId: randomUUID() }),
    ])) assert.deepEqual(result, { ok: true, recorded: false });
    current.instance.close(); current = runtime(f);
    assert.deepEqual(await current.instance.recordTurnStart({ ...f.start, turnId: randomUUID() }),
      { ok: true, recorded: false });
    const records = failures(f);
    assert.equal(records.length, 1);
    assert.equal(records[0].operation, "memory.turn-start");
    assert.equal(records[0].errorCode, "CURSOR_DATABASE_NATIVE_FORMAT_INVALID");
    for (const value of [prompt, answer, f.root, f.sessionId, f.start.turnId, "synthetic-secret"]) {
      assert.equal(JSON.stringify(records).includes(value), false);
    }
    const state = await readState(f);
    assert.equal(state.diagnosticKeys.length, 1);
    assert.equal(state.active, undefined);
    assert.equal(state.repositoryScope, undefined);
    assert.equal((await readCurrentTraceTurn({ client: "cursor", sessionId: f.sessionId,
      memoraxCodeHome: f.home, env: f.env })).ok, false);
    assert.equal(current.instance.size(), 0);
    assert.equal(current.writes.length, 0);

    // A different cause or Session must remain independently reportable.
    await current.instance.recordTurnStart({ ...f.start, databasePath: "relative-native-db" });
    const other = { ...f.start, sessionId: randomUUID() };
    f.setRow(`composerData:${other.sessionId}`, JSON.stringify({ composerId: randomUUID() }));
    await current.instance.recordTurnStart(other);
    assert.equal(failures(f).length, 3);
    assert.equal(failures(f).filter((record) => record.failureReason === "database_path_invalid").length, 1);
    assert.equal((await readState(f)).diagnosticKeys.length, 2);

    await f.append();
    assert.equal((await current.instance.recordTurnStart(f.start)).recorded, true);
    assert.equal(failures(f).length, 3);
  } finally { current.instance.close(); await f.cleanup(); }
});

test("Cursor late child metadata excludes otherwise ordinary native QA from writeback", async () => {
  const f = await fixture(); const { instance, writes } = runtime(f);
  try {
    assert.equal((await instance.recordTurnStart(f.start)).recorded, true);
    const native = f.append();
    f.writeComposer({ composerId: f.sessionId, latestChatGenerationUUID: f.start.turnId,
      conversationState: "~" + native.state.toString("base64"),
      subagentInfo: { parentComposerId: randomUUID() } });
    await observeResponse(instance, f.start);
    assert.equal((await instance.writeback(stop(f.start))).reason, "native_user_unsupported");
    assert.equal(writes.length, 0);
  } finally { instance.close(); await f.cleanup(); }
});

test("Cursor root registration tolerates absent composer and root metadata without content", async (t) => {
  for (const present of [false, true]) await t.test(String(present), async () => {
    const f = await fixture(); const { instance } = runtime(f);
    try {
      if (present) f.writeComposer({ composerId: f.sessionId, subagentComposerIds: [randomUUID()] });
      assert.equal((await instance.recordTurnStart(f.start)).recorded, true);
      assert.equal((await readState(f)).active.turnId, f.start.turnId);
    } finally { instance.close(); await f.cleanup(); }
  });
});

test("Cursor child-session completion cannot consume the parent's matching generation", async () => {
  const f = await fixture(); const { instance, writes } = runtime(f);
  try {
    await instance.recordTurnStart(f.start);
    f.append();
    const child = { ...f.start, sessionId: randomUUID() };
    assert.equal((await observeResponse(instance, child)).reason, "start_missing");
    assert.equal((await instance.writeback(stop(child))).reason, "start_missing");
    assert.equal(writes.length, 0);
    assert.equal((await readState(f)).active.state, "open");
    assert.ok((await readState(f)).active.metadata);
    await observeResponse(instance, f.start);
    assert.deepEqual(await instance.writeback(stop(f.start)), { ok: true, scheduled: true });
    assert.equal(writes.length, 1);
  } finally { instance.close(); await f.cleanup(); }
});

test("Cursor distinguishes recorded starts from wrong-client, duplicate and retired acknowledgements", async () => {
  const f = await fixture(); const { instance } = runtime(f);
  try {
    assert.deepEqual(await instance.recordTurnStart({ ...f.start, client: "codex" }), { ok: true, recorded: false });
    assert.equal((await instance.recordTurnStart(f.start)).recorded, true);
    assert.deepEqual(await instance.recordTurnStart(f.start), { ok: true, recorded: false });
    const next = { ...f.start, turnId: randomUUID(), prompt: "The next registered prompt." };
    assert.equal((await instance.recordTurnStart(next)).recorded, true);
    assert.deepEqual(await instance.recordTurnStart(f.start), { ok: true, recorded: false });
    assert.equal((await readState(f)).active.turnId, next.turnId);
  } finally { instance.close(); await f.cleanup(); }
});

test("Cursor lock-timeout acknowledgement does not claim registration and a later prompt can register", async () => {
  const f = await fixture(); const { instance } = runtime(f, { turnStateLockTimeoutMs: 10 });
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const locked = new Promise((resolve) => { entered = resolve; });
  const holder = withJsonFileLockAsync(cursorTurnStatePath(f.home, f.sessionId), async () => { entered(); await gate; });
  try {
    await locked;
    assert.deepEqual(await instance.recordTurnStart(f.start), { ok: true, recorded: false });
    await assert.rejects(readState(f), { code: "ENOENT" });
    assert.equal(instance.size(), 0);
    release(); await holder;
    const next = { ...f.start, turnId: randomUUID(), prompt: "The first successfully registered prompt." };
    assert.equal((await instance.recordTurnStart(next)).recorded, true);
    assert.equal((await readState(f)).active.turnId, next.turnId);
  } finally { release(); await holder; instance.close(); await f.cleanup(); }
});

test("Cursor delayed DB persistence recovers without another Hook, including Backend restart", async (t) => {
  for (const restart of [false, true]) await t.test(String(restart), async () => {
    const f = await fixture(); let active = runtime(f, { databaseRetryDelayMs: 100 });
    try {
      await active.instance.recordTurnStart(f.start);
      assert.equal((await active.instance.writeback(stop(f.start))).reason, "response_digest_missing");
      assert.equal((await observeResponse(active.instance, f.start)).scheduled, false);
      assert.ok((await readState(f)).active.retryUntil);
      if (restart) { active.instance.close(); active = runtime(f); }
      await f.append();
      await until(() => active.writes.length === 1);
      assert.equal(active.writes[0].assistantText, answer);
      assert.equal((await active.instance.writeback(stop(f.start))).reason, "already_accepted_locally");
    } finally { active.instance.close(); await f.cleanup(); }
  });
});

test("Cursor restart recovers pending writeback beyond retained terminal sessions", { timeout: 20_000 }, async () => {
  const f = await fixture(); let first, recovered, pendingDb;
  try {
    const directory = join(f.home, "runtime", "cursor", "turns");
    await mkdir(directory, { recursive: true });
    const sessions = new Map();
    for (let index = 0; index < 8194; index += 1) {
      const sessionId = randomUUID();
      const path = cursorTurnStatePath(f.home, sessionId);
      const record = { version: 2, client: "cursor", sessionId, retiredTurnIds: [], active: {
        turnId: randomUUID(), createdAt: Date.now(), promptDigest: cursorTextDigest(prompt),
        databasePath: f.databasePath, state: "accepted",
      } };
      writeFileSync(path, JSON.stringify(record), { mode: 0o600 });
      sessions.set(path, sessionId);
    }
    // Choose an excluded identity from the observed order, not an assumed filename sort.
    const pendingName = readdirSync(directory).at(-1);
    const sessionId = sessions.get(join(directory, pendingName));
    pendingDb = await databaseFixture({ sessionId, databasePath: join(f.root, "pending.vscdb") });
    const start = { ...f.start, sessionId, databasePath: pendingDb.databasePath };
    first = runtime(f, { databaseRetryWindowMs: 60_000 });
    assert.equal((await first.instance.recordTurnStart(start)).recorded, true);
    await first.instance.writeback(stop(start));
    assert.equal((await observeResponse(first.instance, start)).scheduled, false);
    first.instance.close();
    assert.ok(readdirSync(directory).indexOf(pendingName) >= 8192);

    recovered = runtime(f);
    pendingDb.write({ latestGenerationId: start.turnId, turns: [f.native(start)] });
    await until(() => recovered.writes.length === 1);
    assert.equal(recovered.writes[0].userText, prompt);
    assert.equal(recovered.writes[0].assistantText, answer);
    const state = JSON.parse(await readFile(cursorTurnStatePath(f.home, sessionId), "utf8"));
    assert.equal(state.active.state, "accepted");
    assert.equal(state.active.metadata, undefined);
    assert.equal(state.active.retryUntil, undefined);
    assert.equal((await recovered.instance.writeback(stop(start))).reason, "already_accepted_locally");
    assert.equal(recovered.writes.length, 1);
  } finally {
    first?.instance.close(); recovered?.instance.close();
    await pendingDb?.cleanup(); await f.cleanup();
  }
});

test("Cursor Continue binds the aborted native user and selects only the appended final response", async () => {
  const f = await fixture(); let active = runtime(f);
  const partial = [{ type: "thinkingMessage", text: "Synthetic reasoning" },
    { type: "toolCall", text: "Synthetic tool" }, { type: "assistantMessage", text: "Incomplete answer" }];
  const continued = { ...f.start, turnId: randomUUID(), prompt: "" };
  try {
    await active.instance.recordTurnStart(f.start);
    f.write({ latestGenerationId: f.start.turnId, turns: [f.native(f.start, partial)] });
    assert.equal((await active.instance.writeback(stop(f.start, "aborted"))).reason, "interrupted");
    assert.equal(active.writes.length, 0);
    await active.instance.recordTurnStart(continued);
    assert.equal((await readState(f)).active.continuation.requestId, f.start.turnId);
    active.instance.close(); active = runtime(f);
    await observeResponse(active.instance, continued);
    f.write({ latestGenerationId: continued.turnId,
      turns: [f.native(f.start, [...partial, { type: "assistantMessage", text: answer }])] });
    assert.deepEqual(await active.instance.writeback(stop(continued)), { ok: true, scheduled: true });
    assert.equal(active.writes.length, 1);
    assert.equal(active.writes[0].userText, prompt);
    assert.equal(active.writes[0].assistantText, answer);
    assert.equal(active.writes[0].repositoryScope.boundWorkspaceRoot, f.workspace);
  } finally { active.instance.close(); await f.cleanup(); }
});

test("Cursor edits replace native request identity without relying on a JSONL prefix", async () => {
  const f = await fixture(); const { instance, writes } = runtime(f);
  const edited = { ...f.start, turnId: randomUUID(), prompt: "The edited synthetic question." };
  try {
    await instance.recordTurnStart(f.start);
    await observeResponse(instance, f.start);
    await instance.recordTurnStart(edited);
    f.write({ latestGenerationId: edited.turnId, turns: [f.native(edited)] });
    assert.equal((await instance.writeback(stop(f.start))).reason, "generation_replaced");
    await observeResponse(instance, edited);
    assert.equal((await instance.writeback(stop(edited))).scheduled, true);
    assert.equal(writes.length, 1); assert.equal(writes[0].userText, edited.prompt);
  } finally { instance.close(); await f.cleanup(); }
});

test("Cursor unbound Continue retains scope and CLI identity but never guesses a native user", async () => {
  const f = await fixture(); const { instance, writes } = runtime(f);
  const start = { ...f.start, prompt: "" };
  try {
    await f.append(); assert.equal((await instance.recordTurnStart(start)).recorded, true);
    const current = await readCurrentTraceTurn({ client: "cursor", sessionId: f.sessionId, memoraxCodeHome: f.home, env: f.env });
    assert.equal(current.traceContext.turnId, start.turnId);
    await observeResponse(instance, start);
    assert.equal((await instance.writeback(stop(start))).reason, "continuation_user_unbound");
    assert.equal(writes.length, 0);
  } finally { instance.close(); await f.cleanup(); }
});

test("Cursor rejects changed database or workspace authority", async (t) => {
  for (const field of ["databasePath", "cwd"]) await t.test(field, async () => {
    const f = await fixture(); const { instance, writes } = runtime(f);
    try {
      await instance.recordTurnStart(f.start); await observeResponse(instance, f.start); await f.append();
      assert.equal((await instance.writeback({ ...stop(f.start), [field]: join(f.root, "other") })).reason, "database_or_workspace_changed");
      assert.equal(writes.length, 0); assert.ok((await readState(f)).active.metadata);
    } finally { instance.close(); await f.cleanup(); }
  });
});

test("Cursor pending retry stops at its deadline and cannot write after a new generation", async () => {
  const f = await fixture(); const { instance, writes } = runtime(f, { databaseRetryWindowMs: 40, databaseRetryDelayMs: 10 });
  try {
    await instance.recordTurnStart(f.start); await observeResponse(instance, f.start); await instance.writeback(stop(f.start));
    await new Promise((resolve) => setTimeout(resolve, 80));
    await f.append(); await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(writes.length, 0);
    await instance.recordTurnStart({ ...f.start, turnId: randomUUID(), prompt: "Next question" });
    assert.equal((await instance.writeback(stop(f.start))).reason, "generation_replaced");
    // Replacement gets one last exact read before retiring the old pending turn.
    assert.equal(writes.length, 1);
    await new Promise((resolve) => setTimeout(resolve, 40)); assert.equal(writes.length, 1);
  } finally { instance.close(); await f.cleanup(); }
});

test("Cursor concurrent starts keep the CLI current-turn bridge on the newer generation", async () => {
  const f = await fixture("concurrent-starts");
  const base = createRepositoryMemorySessionRuntime();
  let releaseFirst;
  let markFirstEntered;
  const entered = new Promise((resolve) => { markFirstEntered = resolve; });
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const first = runtime(f, {
    repositoryMemorySession: {
      async resolve(input) { markFirstEntered(); await gate; return await base.resolve(input); },
      close() {},
    },
  });
  const second = runtime(f);
  const next = { ...f.start, turnId: randomUUID(), prompt: "A newer concurrent prompt." };
  const pending = [];
  try {
    pending.push(first.instance.recordTurnStart(f.start));
    await entered;
    pending.push(second.instance.recordTurnStart(next));
    releaseFirst();
    await Promise.all(pending);
    const current = await readCurrentTraceTurn({ client: "cursor", sessionId: f.sessionId, memoraxCodeHome: f.home, env: f.env });
    assert.equal(current.ok, true);
    assert.equal(current.traceContext.turnId, next.turnId);
    assert.equal((await readState(f)).active.turnId, next.turnId);
    assert.equal((await readState(f)).active.state, "open");
  } finally {
    releaseFirst();
    await Promise.allSettled(pending);
    first.instance.close(); second.instance.close(); base.close(); await f.cleanup();
  }
});


test("Cursor local enqueue rejection retains durable and live metadata for retry", async () => {
  const f = await fixture("enqueue-rejected");
  let accepted = false;
  let calls = 0, acceptedWrites = 0;
  const { instance } = runtime(f, { automaticWriteback: () => { calls += 1; if (accepted) acceptedWrites += 1; return accepted ? { accepted: true } : { accepted: false, reason: "disabled" }; } });
  try {
    await instance.recordTurnStart(f.start);
    await observeResponse(instance, f.start);
    await f.append();
    assert.equal((await instance.writeback(stop(f.start))).reason, "disabled");
    assert.equal(instance.size(), 1);
    assert.ok((await readState(f)).active.metadata);
    accepted = true;
    const result = await instance.writeback(stop(f.start));
    assert.ok(result.scheduled || result.reason === "already_accepted_locally");
    assert.equal(instance.size(), 0);
    assert.ok(calls >= 2);
    assert.equal(acceptedWrites, 1);
  } finally { instance.close(); await f.cleanup(); }
});

test("Cursor next generation preserves completed Jev QA independently of Add acceptance or DB timing", async (t) => {
  for (const accepted of [true, false]) for (const late of [false, true]) {
    await t.test(`${accepted ? "accepted" : "disabled"}, ${late ? "late DB" : "completed before next start"}`, async () => {
      const f = await fixture();
      const requests = [];
      const searchGuidance = createMemorySearchGuidanceRuntime({ memoraxCodeHome: f.home,
        env: { ...f.env, MEMORAX_CODE_JEV_ENABLED: "true", MEMORAX_CODE_JEV_API_KEY: "synthetic-jev-key" },
        fetchImpl: async (_url, init) => {
          requests.push(JSON.parse(init.body).state);
          return Response.json({ model: JEV_MODEL, answers: { search_needed: { type: "noul", noul: 0.9 } } });
        },
      });
      const { instance } = runtime(f, { searchGuidance, databaseRetryDelayMs: 2000,
        automaticWriteback: () => accepted ? { accepted: true } : { accepted: false, reason: "disabled" } });
      const next = { ...f.start, turnId: randomUUID(), prompt: "Recall the earlier module boundary decision." };
      try {
        await instance.recordTurnStart(f.start);
        await observeResponse(instance, f.start);
        if (!late) await f.append();
        const completion = await instance.writeback(stop(f.start));
        if (late) {
          assert.equal(completion.reason, "database_session_missing");
          await f.append();
        } else {
          assert.equal(completion.scheduled, accepted);
          if (!accepted) assert.equal(completion.reason, "disabled");
        }
        assert.equal((await instance.recordTurnStart(next)).recorded, true);
        assert.equal((await searchGuidance.evaluate(next)).decision, "search");
        assert.deepEqual(requests, [{ current_prompt: next.prompt,
          previous_turn: { user: prompt, assistant: answer } }]);
        assert.equal(instance.size(), 1, "retirement still removes the previous Turn's writeback metadata");
        assert.equal((await instance.writeback(stop(f.start))).reason, "generation_replaced");
        assert.equal((await instance.recordTurnStart(f.start)).recorded, false);
        assert.equal((await searchGuidance.evaluate(f.start)).reason, "context_unavailable");
      } finally { instance.close(); searchGuidance.close(); await f.cleanup(); }
    });
  }
});

test("Cursor replacement invalidates in-flight Jev and cannot carry older QA past an incomplete Turn", async () => {
  const f = await fixture();
  const requests = [];
  let finishPending;
  const searchGuidance = createMemorySearchGuidanceRuntime({ memoraxCodeHome: f.home,
    env: { ...f.env, MEMORAX_CODE_JEV_ENABLED: "true", MEMORAX_CODE_JEV_API_KEY: "synthetic-jev-key" },
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body).state);
      if (requests.length === 1) await new Promise((resolve) => { finishPending = resolve; });
      return Response.json({ model: JEV_MODEL, answers: { search_needed: { type: "noul", noul: 0.9 } } });
    },
  });
  const { instance } = runtime(f, { searchGuidance, databaseRetryDelayMs: 2000 });
  const incomplete = { ...f.start, turnId: randomUUID(), prompt: "An unfinished request." };
  const next = { ...f.start, turnId: randomUUID(), prompt: "A subsequent request." };
  let pending;
  try {
    await instance.recordTurnStart(f.start); await f.append(); await observeResponse(instance, f.start);
    assert.equal((await instance.writeback(stop(f.start))).scheduled, true);
    await instance.recordTurnStart(incomplete);
    pending = searchGuidance.evaluate(incomplete);
    await until(() => Boolean(finishPending));
    await observeResponse(instance, incomplete);
    assert.equal((await instance.writeback(stop(incomplete))).scheduled, false);
    assert.equal((await instance.recordTurnStart(next)).recorded, true);
    finishPending();
    assert.equal((await pending).reason, "context_unavailable");
    assert.equal((await searchGuidance.evaluate(incomplete)).reason, "context_unavailable");
    assert.equal((await searchGuidance.evaluate(next)).decision, "search");
    assert.deepEqual(requests[1], { current_prompt: next.prompt });
    assert.equal(instance.size(), 1);
    f.write({ latestGenerationId: incomplete.turnId, turns: [f.native(incomplete)] });
    assert.equal((await instance.writeback(stop(incomplete))).reason, "generation_replaced");
    assert.equal((await instance.recordTurnStart(incomplete)).recorded, false);
  } finally { finishPending?.(); await pending; instance.close(); searchGuidance.close(); await f.cleanup(); }
});

test("Cursor retirement invalidates unfinished Jev before the next scope lookup completes", async (t) => {
  for (const phase of ["open", "native_content_pending"]) await t.test(phase, async () => {
    const f = await fixture();
    const repositoryMemorySession = createRepositoryMemorySessionRuntime();
    let holdNextScope = false, finishPending, releaseScope, scopeStarted;
    const scopeEntered = new Promise((resolve) => { scopeStarted = resolve; });
    const scopeGate = new Promise((resolve) => { releaseScope = resolve; });
    const searchGuidance = createMemorySearchGuidanceRuntime({ memoraxCodeHome: f.home,
      env: { ...f.env, MEMORAX_CODE_JEV_ENABLED: "true", MEMORAX_CODE_JEV_API_KEY: "synthetic-jev-key" },
      fetchImpl: async () => {
        await new Promise((resolve) => { finishPending = resolve; });
        return Response.json({ model: JEV_MODEL, answers: { search_needed: { type: "noul", noul: 0.9 } } });
      },
    });
    const { instance } = runtime(f, { searchGuidance, databaseRetryDelayMs: 2000, repositoryMemorySession: {
      async resolve(input) {
        if (holdNextScope) { scopeStarted(); await scopeGate; }
        return await repositoryMemorySession.resolve(input);
      },
      close() {},
    } });
    let pending, registration;
    try {
      await instance.recordTurnStart(f.start);
      pending = searchGuidance.evaluate(f.start);
      await until(() => Boolean(finishPending));
      if (phase === "native_content_pending") {
        await observeResponse(instance, f.start);
        assert.equal((await instance.writeback(stop(f.start))).reason, "database_session_missing");
      }
      holdNextScope = true;
      registration = instance.recordTurnStart({ ...f.start, turnId: randomUUID(), prompt: "Next request" });
      await scopeEntered;
      finishPending();
      assert.equal((await pending).reason, "context_unavailable");
      assert.equal((await searchGuidance.evaluate(f.start)).reason, "context_unavailable");
      releaseScope();
      assert.equal((await registration).recorded, true);
    } finally {
      finishPending?.(); releaseScope(); await pending; await registration;
      instance.close(); searchGuidance.close(); repositoryMemorySession.close(); await f.cleanup();
    }
  });
});

test("Cursor blocked completion cannot pass previously materialized Jev QA to the next generation", async (t) => {
  for (const failure of ["native_changed", "response_conflict"]) await t.test(failure, async () => {
    const f = await fixture();
    const requests = [];
    const searchGuidance = createMemorySearchGuidanceRuntime({ memoraxCodeHome: f.home,
      env: { ...f.env, MEMORAX_CODE_JEV_ENABLED: "true", MEMORAX_CODE_JEV_API_KEY: "synthetic-jev-key" },
      fetchImpl: async (_url, init) => {
        requests.push(JSON.parse(init.body).state);
        return Response.json({ model: JEV_MODEL, answers: { search_needed: { type: "noul", noul: 0.9 } } });
      },
    });
    const { instance } = runtime(f, { searchGuidance, databaseRetryDelayMs: 2000,
      automaticWriteback: () => ({ accepted: false, reason: "disabled" }) });
    try {
      await instance.recordTurnStart(f.start); await f.append(); await observeResponse(instance, f.start);
      assert.equal((await instance.writeback(stop(f.start))).reason, "disabled");
      if (failure === "native_changed") {
        f.write({ latestGenerationId: f.start.turnId, turns: [{ ...f.native(), userPrompt: "Conflicting native user content." }] });
      } else {
        assert.equal((await observeResponse(instance, f.start, "Conflicting response.")).reason, "conflicting_response_events");
      }
      const next = { ...f.start, turnId: randomUUID(), prompt: "A fresh question after the invalidated Turn." };
      assert.equal((await instance.recordTurnStart(next)).recorded, true);
      assert.equal((await searchGuidance.evaluate(next)).decision, "search");
      assert.deepEqual(requests, [{ current_prompt: next.prompt }]);
      assert.equal(instance.size(), 1);
    } finally { instance.close(); searchGuidance.close(); await f.cleanup(); }
  });
});

test("Cursor failed next-generation registration still invalidates retired Jev guidance", async (t) => {
  for (const failure of ["repository_resolution", "state_publication"]) await t.test(failure, async () => {
    const f = await fixture();
    const repositoryMemorySession = createRepositoryMemorySessionRuntime();
    let failNext = false, finishPending, calls = 0;
    const searchGuidance = createMemorySearchGuidanceRuntime({ memoraxCodeHome: f.home,
      env: { ...f.env, MEMORAX_CODE_JEV_ENABLED: "true", MEMORAX_CODE_JEV_API_KEY: "synthetic-jev-key" },
      fetchImpl: async () => {
        calls++;
        await new Promise((resolve) => { finishPending = resolve; });
        return Response.json({ model: JEV_MODEL, answers: { search_needed: { type: "noul", noul: 0.9 } } });
      },
    });
    const { instance } = runtime(f, { searchGuidance, repositoryMemorySession: {
      async resolve(input) {
        if (failNext && failure === "repository_resolution") throw new Error("Synthetic scope lookup failure");
        const result = await repositoryMemorySession.resolve(input);
        if (failNext && failure === "state_publication") {
          const statePath = cursorTurnStatePath(f.home, f.sessionId);
          await rm(statePath);
          await mkdir(statePath);
        }
        return result;
      },
      close() {},
    } });
    let pending;
    try {
      await instance.recordTurnStart(f.start);
      pending = searchGuidance.evaluate(f.start);
      await until(() => Boolean(finishPending));
      failNext = true;
      assert.equal((await instance.recordTurnStart({ ...f.start, turnId: randomUUID(), prompt: "Next request" })).recorded, false);
      finishPending();
      assert.equal((await pending).reason, "context_unavailable");
      assert.equal((await searchGuidance.evaluate(f.start)).reason, "context_unavailable");
      assert.equal(calls, 1);
    } finally {
      finishPending?.(); await pending; instance.close(); searchGuidance.close(); repositoryMemorySession.close(); await f.cleanup();
    }
  });
});

test("Cursor failed next-generation registration cannot pass older completed QA to a later prompt", async () => {
  const f = await fixture();
  const repositoryMemorySession = createRepositoryMemorySessionRuntime();
  let failNext = false;
  const requests = [];
  const searchGuidance = createMemorySearchGuidanceRuntime({ memoraxCodeHome: f.home,
    env: { ...f.env, MEMORAX_CODE_JEV_ENABLED: "true", MEMORAX_CODE_JEV_API_KEY: "synthetic-jev-key" },
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body).state);
      return Response.json({ model: JEV_MODEL, answers: { search_needed: { type: "noul", noul: 0.9 } } });
    },
  });
  const { instance } = runtime(f, { searchGuidance, repositoryMemorySession: {
    async resolve(input) {
      if (failNext) throw new Error("Synthetic scope lookup failure");
      return await repositoryMemorySession.resolve(input);
    },
    close() {},
  } });
  try {
    await instance.recordTurnStart(f.start); await f.append(); await observeResponse(instance, f.start);
    assert.equal((await instance.writeback(stop(f.start))).scheduled, true);
    failNext = true;
    assert.equal((await instance.recordTurnStart({ ...f.start, turnId: randomUUID(), prompt: "Unregistered request" })).recorded, false);
    failNext = false;
    const next = { ...f.start, turnId: randomUUID(), prompt: "A later request" };
    assert.equal((await instance.recordTurnStart(next)).recorded, true);
    assert.equal((await searchGuidance.evaluate(next)).decision, "search");
    assert.deepEqual(requests, [{ current_prompt: next.prompt }]);
  } finally { instance.close(); searchGuidance.close(); repositoryMemorySession.close(); await f.cleanup(); }
});


test("Cursor abort, duplicate starts, response conflicts and replacement fail closed", async (t) => {
  for (const variant of ["aborted", "duplicate_start", "conflicting_response_events", "generation_replaced"]) await t.test(variant, async () => {
    const f = await fixture(variant);
    const { instance, writes } = runtime(f);
    try {
      await instance.recordTurnStart(f.start);
      await observeResponse(instance, f.start);
      if (variant === "aborted") await instance.writeback(stop(f.start, "aborted"));
      if (variant === "duplicate_start") await instance.recordTurnStart(f.start);
      if (variant === "conflicting_response_events") await observeResponse(instance, f.start, "A conflicting answer.");
      if (variant === "generation_replaced") await instance.recordTurnStart({ ...f.start, turnId: randomUUID(), prompt: "The replacement prompt." });
      await f.append();
      const result = await instance.writeback(stop(f.start));
      assert.equal(result.reason, variant === "aborted" ? "interrupted" : variant);
      assert.equal(writes.length, 0);
      if (variant === "aborted") {
        assert.equal(instance.size(), 0);
        assert.equal((await readState(f)).active.metadata, undefined);
      }
    } finally { instance.close(); await f.cleanup(); }
  });
});


test("Cursor persisted schemas reject string-coercible arrays and cross-client identity", async (t) => {
  for (const field of ["state", "stopStatus", "scopeKind", "client"]) await t.test(field, async () => {
    const f = await fixture(`invalid-${field}`);
    const { instance, writes } = runtime(f);
    try {
      await instance.recordTurnStart(f.start);
      await observeResponse(instance, f.start);
      await f.append();
      const record = await readState(f);
      if (field === "state") record.active.state = ["open"];
      if (field === "stopStatus") record.active.stopStatus = ["completed"];
      if (field === "scopeKind") record.repositoryScope.scopeKind = [record.repositoryScope.scopeKind];
      if (field === "client") record.client = "codex";
      await writeFile(cursorTurnStatePath(f.home, f.sessionId), JSON.stringify(record));
      assert.equal((await instance.writeback(stop(f.start))).reason, "turn_state_unavailable");
      assert.equal(writes.length, 0);
    } finally { instance.close(); await f.cleanup(); }
  });
});


test("Cursor independent processes serialize completion and enqueue at most once", async () => {
  const f = await fixture("process-lock");
  const { instance } = runtime(f);
  try {
    await instance.recordTurnStart(f.start);
    await observeResponse(instance, f.start);
    instance.close();
    await f.append();
    const runtimeUrl = new URL("../../../dist/clients/cursor/memory-hook-runtime.js", import.meta.url).href;
    const code = `
      const { createCursorMemoryHookRuntime } = await import(process.argv[1]);
      let enqueueCount = 0;
      const runtime = createCursorMemoryHookRuntime({
        env: process.env, databaseRetryDelayMs: 1000,
        automaticWriteback: () => { enqueueCount++; return { accepted: true }; },
        fetchImpl: async () => { throw new Error('Unexpected network'); },
      });
      try { const result = await runtime.writeback(JSON.parse(process.argv[2])); console.log(JSON.stringify({result, enqueueCount})); }
      finally { runtime.close(); }
    `;
    const run = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", code, runtimeUrl, JSON.stringify(stop(f.start))], {
        env: { PATH: process.env.PATH, HOME: f.root, ...f.env }, stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "", error = "";
      child.stdout.on("data", (data) => { out += data; });
      child.stderr.on("data", (data) => { error += data; });
      child.once("error", reject);
      child.once("exit", (exitCode) => {
        if (exitCode !== 0) reject(new Error(error || `child exited ${exitCode}`));
        else { try { resolve(JSON.parse(out.trim())); } catch (parseError) { reject(parseError); } }
      });
    });
    const results = await Promise.all([run(), run()]);
    assert.equal(results.reduce((total, item) => total + item.enqueueCount, 0), 1);
    assert.equal(results.filter((item) => item.result.scheduled).length, 1);
    assert.equal(results.find((item) => !item.result.scheduled).result.reason, "already_accepted_locally");
  } finally { instance.close(); await f.cleanup(); }
});


test("Cursor restart retries temporary contention on the pending session lock", async () => {
  const f = await fixture(); const first = runtime(f, { databaseRetryDelayMs: 1000 }); let second;
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const locked = new Promise((resolve) => { entered = resolve; });
  let holder;
  try {
    await first.instance.recordTurnStart(f.start); await observeResponse(first.instance, f.start);
    await first.instance.writeback(stop(f.start)); first.instance.close(); await f.append();
    holder = withJsonFileLockAsync(cursorTurnStatePath(f.home, f.sessionId), async () => { entered(); await gate; });
    await locked;
    second = runtime(f, { turnStateLockTimeoutMs: 10, databaseRetryDelayMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 70));
    release(); await holder;
    await until(() => second.writes.length === 1);
    assert.equal(second.writes[0].assistantText, answer);
  } finally { release(); await holder; first.instance.close(); second?.instance.close(); await f.cleanup(); }
});


async function compactionFixture() {
  const f = await fixture();
  const git = join(f.workspace, ".git");
  await mkdir(join(git, "objects"), { recursive: true });
  await mkdir(join(git, "refs", "heads"), { recursive: true });
  await writeFile(join(git, "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(git, "config"), '[remote "origin"]\n\turl = https://example.test/owner/cursor-compaction.git\n');
  const roots = ["1".repeat(64), "2".repeat(64), "3".repeat(64)];
  const summary = "4".repeat(64);
  const archive = { summaryMessageId: summary, summarizedMessageIds: roots.slice(1) };
  const { prompt: _prompt, ...identity } = f.start;
  return { ...f, roots, summary, archive,
    compact: { ...identity, turnId: randomUUID() },
    next: () => ({ ...f.start, turnId: randomUUID(), prompt: "Synthetic prompt after compaction." }),
    before: () => f.writeCompaction({ rootMessageIds: roots, latestGenerationId: f.start.turnId, turns: [f.native()] }),
    after: () => f.writeCompaction({ rootMessageIds: [roots[0], summary], archives: [archive],
      latestGenerationId: f.start.turnId, turns: [f.native()] }),
  };
}

test("Cursor missing first-turn DB can arm at preCompact and restores once across restart", async () => {
  const f = await compactionFixture(); let current = runtime(f);
  try {
    const start = await current.instance.recordTurnStart(f.start);
    assert.equal(start.repoMemoryWorktree, f.workspace);
    assert.equal((await current.instance.recordPreCompact(f.compact)).reason, "database_session_missing");
    assert.equal((await readState(f)).compaction, undefined);
    f.before();
    const before = await readState(f);
    assert.deepEqual(await current.instance.recordPreCompact(f.compact), { ok: true, recorded: true });
    assert.deepEqual(await current.instance.recordPreCompact(f.compact), { ok: true, recorded: true });
    assert.deepEqual((await readState(f)).active, before.active);
    current.instance.close(); current = runtime(f);
    f.after();
    const next = f.next();
    const restored = await current.instance.recordTurnStart(next);
    assert.equal(restored.recorded, true);
    assert.equal(restored.restorePersonalMemory, true);
    const saved = await readState(f);
    assert.equal(saved.compaction.baseline, undefined);
    assert.equal(saved.compaction.processedArchiveIds.length, 1);
    assert.equal(JSON.stringify(saved.compaction).includes("Synthetic summary text"), false);
    assert.equal((await current.instance.recordTurnStart(next)).recorded, false);
    current.instance.close(); current = runtime(f);
    assert.equal((await current.instance.recordTurnStart(f.next())).restorePersonalMemory, undefined);
    assert.equal(current.writes.length, 0);
  } finally { current.instance.close(); await f.cleanup(); }
});

test("Cursor does not infer compression from an archive without an observed baseline", async () => {
  const f = await compactionFixture(); const { instance } = runtime(f);
  try {
    await instance.recordTurnStart(f.start);
    assert.equal((await instance.recordPreCompact(f.compact)).recorded, false);
    f.after();
    assert.equal((await instance.recordTurnStart(f.next())).restorePersonalMemory, undefined);
    assert.equal((await readState(f)).compaction, undefined);
  } finally { instance.close(); await f.cleanup(); }
});

test("Cursor compaction interruption and unrelated branch updates cannot request restoration", async (t) => {
  for (const scenario of ["cancelled", "ordinary_append", "summary_not_applied", "unrelated_archive", "lost_preserved_root", "archive_rollback"]) {
    await t.test(scenario, async () => {
      const f = await compactionFixture(); const { instance } = runtime(f);
      try {
        await instance.recordTurnStart(f.start);
        let initial = f.before();
        if (scenario === "archive_rollback") initial = f.after();
        assert.equal((await instance.recordPreCompact(f.compact)).recorded, true);
        if (scenario === "ordinary_append") f.writeCompaction({ rootMessageIds: [...f.roots, "5".repeat(64)] });
        if (scenario === "summary_not_applied") f.writeCompaction({ rootMessageIds: f.roots, archives: [f.archive] });
        if (scenario === "unrelated_archive") f.writeCompaction({ rootMessageIds: [f.roots[0], f.summary],
          archives: [{ ...f.archive, summarizedMessageIds: ["6".repeat(64)] }] });
        if (scenario === "lost_preserved_root") f.writeCompaction({ rootMessageIds: [f.summary], archives: [f.archive] });
        if (scenario === "archive_rollback") {
          assert.equal(initial.archiveIds.length, 1);
          f.before();
        }
        assert.equal((await instance.recordTurnStart(f.next())).restorePersonalMemory, undefined);
      } finally { instance.close(); await f.cleanup(); }
    });
  }
});

test("Cursor consecutive compactions retain replacement evidence if a later attempt is cancelled", async () => {
  const f = await compactionFixture(); const { instance } = runtime(f);
  try {
    await instance.recordTurnStart(f.start); f.before();
    await instance.recordPreCompact(f.compact);
    const first = f.after();
    await instance.recordPreCompact({ ...f.compact, turnId: randomUUID() });
    const secondSummary = "7".repeat(64);
    const second = f.writeCompaction({ rootMessageIds: [f.roots[0], secondSummary], archives: [
      ...first.archiveIds, { summaryMessageId: secondSummary, summarizedMessageIds: [f.summary] },
    ] });
    await instance.recordPreCompact({ ...f.compact, turnId: randomUUID() });
    // The third attempt aborts without replacing these roots or archives.
    const result = await instance.recordTurnStart(f.next());
    assert.equal(result.restorePersonalMemory, true);
    assert.deepEqual((await readState(f)).compaction.processedArchiveIds, second.archiveIds);
    // Replaying an already acknowledged native archive after a rollback is not
    // a new restoration request, even when a new preCompact Hook is received.
    f.before(); await instance.recordPreCompact({ ...f.compact, turnId: randomUUID() }); f.after();
    assert.equal((await instance.recordTurnStart(f.next())).restorePersonalMemory, undefined);
  } finally { instance.close(); await f.cleanup(); }
});

test("Cursor Continue retains compaction evidence for the next nonempty prompt", async () => {
  const f = await compactionFixture(); const { instance } = runtime(f);
  try {
    await instance.recordTurnStart(f.start); f.before(); await instance.recordPreCompact(f.compact); f.after();
    const continuation = await instance.recordTurnStart({ ...f.next(), prompt: "" });
    assert.equal(continuation.restorePersonalMemory, undefined);
    assert.ok((await readState(f)).compaction.baseline);
    assert.equal((await instance.recordTurnStart(f.next())).restorePersonalMemory, true);
  } finally { instance.close(); await f.cleanup(); }
});

test("Cursor compaction observations require registered scope and remain isolated from Add", async (t) => {
  for (const scenario of ["missing_start", "non_git_workspace", "changed_database", "changed_workspace", "changed_user"]) {
    await t.test(scenario, async () => {
      const f = scenario === "non_git_workspace" ? await fixture() : await compactionFixture();
      const { instance } = runtime(f);
      try {
        if (scenario !== "missing_start") await instance.recordTurnStart(f.start);
        const { prompt: _prompt, ...identity } = f.start;
        const command = { ...identity, turnId: randomUUID() };
        f.writeCompaction({ rootMessageIds: ["1".repeat(64)] });
        const before = scenario === "missing_start" ? undefined : (await readState(f)).active;
        if (scenario === "changed_database") command.databasePath = join(f.root, "other.vscdb");
        if (scenario === "changed_workspace") command.cwd = f.root;
        if (scenario === "changed_user") f.env.MEMORAX_CODE_MEMORAX_USER_ID = "another-synthetic-user";
        assert.equal((await instance.recordPreCompact(command)).recorded, false);
        if (before) {
          const saved = await readState(f);
          assert.deepEqual(saved.active, before);
          assert.equal(saved.compaction, undefined);
        }
      } finally { instance.close(); await f.cleanup(); }
    });
  }
});

test("Cursor changed user binding discards armed compaction before the next prompt", async () => {
  const f = await compactionFixture(); const { instance } = runtime(f);
  try {
    await instance.recordTurnStart(f.start); f.before(); await instance.recordPreCompact(f.compact); f.after();
    f.env.MEMORAX_CODE_MEMORAX_USER_ID = "another-synthetic-user";
    assert.equal((await instance.recordTurnStart(f.next())).restorePersonalMemory, undefined);
    assert.equal((await readState(f)).compaction, undefined);
  } finally { instance.close(); await f.cleanup(); }
});

function failures(f) {
  const history = readDiagnosticHistory(f.home, { limit: 100 });
  assert.equal(history.ok, true);
  assert.equal(history.skipped, 0);
  return history.records;
}

test("Cursor persists native failures without trace or Debug, once across repeated Hooks and restart", async () => {
  const f = await fixture(); let current = runtime(f);
  try {
    await current.instance.recordTurnStart(f.start);
    f.write({ latestGenerationId: f.start.turnId, turns: [{ ...f.native(), userPrompt: "A different private prompt" }] });
    await observeResponse(current.instance, f.start);
    assert.equal((await current.instance.writeback(stop(f.start))).reason, "native_prompt_mismatch");
    await current.instance.writeback(stop(f.start));
    current.instance.close(); current = runtime(f);
    await current.instance.writeback(stop(f.start));
    const records = failures(f);
    assert.equal(records.length, 1);
    const record = records[0];
    assert.equal(record.errorCode, "CURSOR_NATIVE_PROMPT_MISMATCH");
    assert.equal(record.operation, "memory.writeback");
    assert.equal(record.stage, "correlation");
    assert.equal(record.client, "cursor");
    assert.ok(record.impact && record.userAction);
    assert.equal(record.sessionHash, cursorTextDigest(f.sessionId).slice(0, 24));
    for (const privateText of [prompt, answer, f.root, f.sessionId, f.start.turnId, "synthetic-secret", "A different private prompt"]) {
      assert.equal(JSON.stringify(records).includes(privateText), false);
    }
    assert.ok((await readState(f)).active.metadata);
    assert.equal(current.writes.length, 0);
  } finally { current.instance.close(); await f.cleanup(); }
});

test("Cursor reports native content timeout only after retries expire and preserves late exact recovery", async () => {
  const f = await fixture(); let clock = Date.now();
  const options = { now: () => clock, databaseRetryWindowMs: 80, databaseRetryDelayMs: 10 };
  let current = runtime(f, options);
  try {
    await current.instance.recordTurnStart(f.start); await observeResponse(current.instance, f.start);
    assert.equal((await current.instance.writeback(stop(f.start))).reason, "database_session_missing");
    assert.deepEqual(failures(f), []);
    clock += 80;
    await until(() => failures(f).length === 1);
    const record = failures(f)[0];
    assert.equal(record.errorCode, "CURSOR_NATIVE_CONTENT_TIMEOUT");
    assert.equal(record.failureReason, "database_session_missing");
    const state = await readState(f);
    assert.equal(state.active.state, "open"); assert.ok(state.active.metadata);
    current.instance.close(); current = runtime(f, options);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(failures(f).length, 1);
    await f.append();
    assert.equal((await current.instance.writeback(stop(f.start))).scheduled, true);
    assert.equal(current.writes.length, 1);
  } finally { current.instance.close(); await f.cleanup(); }
});

test("Cursor pending reads that recover and normal skips produce no failure records", async () => {
  const f = await fixture(); const { instance, writes } = runtime(f);
  try {
    await instance.recordTurnStart(f.start); await observeResponse(instance, f.start);
    await instance.writeback(stop(f.start));
    assert.deepEqual(failures(f), []);
    await f.append(); await until(() => writes.length === 1);
    await instance.writeback(stop(f.start));
    await instance.recordTurnStart(f.start);
    const next = { ...f.start, turnId: randomUUID() };
    await instance.recordTurnStart(next);
    await instance.writeback(stop(f.start));
    await instance.writeback(stop(next, "aborted"));
    assert.deepEqual(failures(f), []);
  } finally { instance.close(); await f.cleanup(); }
});

test("Cursor records a failure discovered by a background DB retry, without a second Hook", async () => {
  const f = await fixture(); const { instance } = runtime(f);
  try {
    await instance.recordTurnStart(f.start); await observeResponse(instance, f.start);
    await instance.writeback(stop(f.start));
    f.write({ latestGenerationId: f.start.turnId, turns: [{ ...f.native(), userPrompt: "Different" }] });
    await until(() => failures(f).length === 1);
    assert.equal(failures(f)[0].failureReason, "native_prompt_mismatch");
    await instance.writeback(stop(f.start));
    assert.equal(failures(f).length, 1);
  } finally { instance.close(); await f.cleanup(); }
});

test("Cursor state failures are diagnosed at all three operations without changing their results", async (t) => {
  for (const operation of ["turn-start", "pre-compact", "writeback"]) await t.test(operation, async () => {
    const f = await fixture(); const { instance } = runtime(f);
    try {
      await mkdir(join(f.home, "runtime", "cursor"), { recursive: true });
      await writeFile(join(f.home, "runtime", "cursor", "turns"), "private invalid state");
      const result = operation === "turn-start" ? await instance.recordTurnStart(f.start)
        : operation === "pre-compact" ? await instance.recordPreCompact(stop(f.start))
        : await instance.writeback(stop(f.start));
      assert.equal(result.ok, true);
      assert.equal(result.recorded ?? result.scheduled, false);
      assert.equal(failures(f).length, 1);
      assert.equal(failures(f)[0].operation, "memory." + operation);
      assert.equal(failures(f)[0].failureReason, "turn_state_unavailable");
      assert.equal(JSON.stringify(failures(f)).includes("private invalid state"), false);
    } finally { instance.close(); await f.cleanup(); }
  });
});

test("Cursor diagnostics storage failure never changes a native rejection or enqueue acceptance", async () => {
  const f = await fixture(); const { instance, writes } = runtime(f);
  try {
    await instance.recordTurnStart(f.start); await observeResponse(instance, f.start);
    await writeFile(join(f.home, "runtime", "diagnostics"), "occupied");
    f.write({ latestGenerationId: f.start.turnId, turns: [{ ...f.native(), userPrompt: "Different" }] });
    assert.equal((await instance.writeback(stop(f.start))).reason, "native_prompt_mismatch");
    const next = { ...f.start, turnId: randomUUID() };
    await instance.recordTurnStart(next); await observeResponse(instance, next);
    f.write({ latestGenerationId: next.turnId, turns: [f.native(next)] });
    assert.equal((await instance.writeback(stop(next))).scheduled, true);
    assert.equal(writes.length, 1);
    assert.equal(await readFile(join(f.home, "runtime", "diagnostics"), "utf8"), "occupied");
  } finally { instance.close(); await f.cleanup(); }
});

test("Cursor service does not duplicate runtime diagnostics for shared scope failures", async () => {
  const f = await fixture(); const service = createMemoryService({ env: f.env, memoraxCodeHome: f.home,
    fetchImpl: async () => { throw new Error("Unexpected network"); } });
  try {
    await service.recordTurnStart(f.start); await service.writebackTurn(response(f.start)); await f.append();
    f.env.MEMORAX_CODE_MEMORAX_USER_ID = "changed-user";
    assert.equal((await service.writebackTurn(stop(f.start))).reason, "workspace_scope_mismatch");
    await service.writebackTurn(stop(f.start));
    assert.equal(failures(f).length, 1);
    assert.equal(failures(f)[0].errorCode, "WRITEBACK_WORKSPACE_SCOPE_MISMATCH");
  } finally { service.close(); await f.cleanup(); }
});
