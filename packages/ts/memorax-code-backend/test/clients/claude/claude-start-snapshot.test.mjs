import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createClaudeMemoryHookRuntime } from "../../../dist/clients/claude/memory-hook-runtime.js";
import {
  captureClaudeTurnStartSnapshot,
  claudeTurnStartCorrelationFromJsonLines,
  readClaudeArchiveSource,
  readClaudeWritebackTurn,
} from "../../../dist/clients/claude/transcript-turn.js";
import { materializePendingCodingSessionTurn, preparePendingCodingSessionTurn } from "../../../dist/coding-sessions/attachment.js";
import { assistantRecord, jsonLines, PROMPT_ID, SESSION_ID, userRecord } from "./support/claude-transcript-fixtures.mjs";

const identity = { sessionId: SESSION_ID, promptId: PROMPT_ID };
const lines = (rows) => rows.length ? `${jsonLines(rows)}\n` : "";

function nativeTurn(index) {
  return [
    userRecord({ uuid: `user-${index}`, content: `Request ${index}.` }),
    assistantRecord({ uuid: `answer-${index}`, parentUuid: `user-${index}`,
      stopReason: "end_turn", content: `Answer ${index}.`, timestamp: "2026-10-14T01:00:00.000Z" }),
  ];
}

async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), "memorax-claude-start-snapshot-"));
  const transcriptPath = join(root, "session.jsonl");
  const scope = { schemaVersion: "workspace-memory-scope.v1", baseUserId: "user-1",
    effectiveUserId: "user-1@snapshot", repositoryKey: "snapshot-key", repositorySlug: "snapshot",
    repositoryName: "snapshot", identitySource: "workspace-directory", scopeKind: "local-directory",
    boundWorkspaceRoot: root };
  const enqueued = [], diagnostics = [];
  const runtime = createClaudeMemoryHookRuntime({
    captureCodingTurns: true, memoraxCodeHome: root, transcriptReadAttempts: 1,
    env: { MEMORAX_CODE_HOME: root, MEMORAX_CODE_CLAUDE_TRACE_ENABLED: "false" },
    repositoryMemorySession: { async resolve() { return { ok: true, memory: { config: {}, scope } }; } },
    automaticWriteback(input) { enqueued.push(input); return { accepted: true }; },
    diagnosticLogger(event, fields) { diagnostics.push({ event, fields }); },
  });
  t.after(async () => { runtime.close(); await fs.rm(root, { recursive: true, force: true }); });
  const command = { version: 1, client: "claude-code", ...identity, transcriptPath, cwd: root };
  return { runtime, command, scope, enqueued, diagnostics,
    save: (rows) => fs.writeFile(transcriptPath, lines(rows)) };
}

async function observeNativeWork(transcriptPath, rows, action, afterRead) {
  const readFile = fs.readFile, open = fs.open, parse = JSON.parse;
  const decode = TextDecoder.prototype.decode;
  const parses = new Map(rows.map(row => [typeof row === "string" ? row : JSON.stringify(row), 0]));
  const counts = { reads: 0, decodes: 0, parses };
  fs.readFile = async (...args) => {
    const result = await readFile(...args);
    if (args[0] === transcriptPath) {
      counts.reads++;
      await afterRead?.();
    }
    return result;
  };
  fs.open = async (...args) => {
    if (args[0] === transcriptPath) counts.reads++;
    return open(...args);
  };
  JSON.parse = function (text, ...args) {
    if (parses.has(text)) parses.set(text, parses.get(text) + 1);
    return parse(text, ...args);
  };
  TextDecoder.prototype.decode = function (...args) {
    counts.decodes++;
    return decode.apply(this, args);
  };
  syncBuiltinESMExports();
  try {
    return { result: await action(counts), counts };
  } finally {
    fs.readFile = readFile;
    fs.open = open;
    JSON.parse = parse;
    TextDecoder.prototype.decode = decode;
    syncBuiltinESMExports();
  }
}

function assertSingleSnapshot(counts, rows, parseCount = 1) {
  assert.equal(counts.reads, 1, "one native read");
  assert.deepEqual([...counts.parses.values()], rows.map(() => parseCount), "complete native lines share one lazy parse");
}

test("Claude snapshot handles absent and unreadable files without retaining the prompt body", async (t) => {
  const run = await fixture(t);
  const input = { ...run.command, prompt: "Request 1." };
  const missing = await captureClaudeTurnStartSnapshot(input);
  assert.equal(missing.ok, true);
  assert.deepEqual(missing.correlation, claudeTurnStartCorrelationFromJsonLines("", input).correlation);
  assert.deepEqual(Object.keys(missing.correlation).sort(), ["endBytes", "observedEndBytes", "prefixDigest", "promptDigest"]);
  assert.equal(JSON.stringify(missing).includes(input.prompt), false);
  assert.deepEqual(missing.snapshot.validate(), { ok: true });
  const unreadable = await captureClaudeTurnStartSnapshot({ ...input, transcriptPath: input.cwd });
  assert.equal(unreadable.ok, false);
  assert.equal(unreadable.reason, "transcript_unavailable");
});

test("Claude first Start captures native bytes without decoding or parsing history", { concurrency: false }, async (t) => {
  const run = await fixture(t);
  const rows = [...nativeTurn(1), nativeTurn(2)[0]];
  await run.save(rows);
  const observed = await observeNativeWork(run.command.transcriptPath, rows,
    () => run.runtime.recordTurnStart({ ...run.command, prompt: "Request 2." }));
  assert.equal(observed.result.ok, true);
  assertSingleSnapshot(observed.counts, rows, 0);
  assert.equal(observed.counts.decodes, 0);
  assert.equal(run.runtime.size(), 1);
  assert.equal(run.enqueued.length, 0);
});

for (const state of ["settled", "completed", "interrupted", "abandoned"]) {
  test(`Claude Start reads once and parses only if needed when its reused-ID predecessor is ${state}`, { concurrency: false }, async (t) => {
    const run = await fixture(t);
    const first = nativeTurn(1);
    await run.save([]);
    await run.runtime.recordTurnStart({ ...run.command, prompt: first[0].message.content });
    const rows = state === "interrupted" ? [first[0], userRecord({ uuid: "interruption-1",
      parentUuid: first[0].uuid, content: "Interrupted by the user.", interruptedMessageId: "message-1" })]
      : state === "abandoned" ? [first[0]] : first;
    await run.save(rows);
    if (state === "settled") {
      assert.deepEqual(await run.runtime.writeback({ ...run.command, lastAssistantMessage: "Answer 1." }),
        { ok: true, scheduled: true });
    }
    const observed = await observeNativeWork(run.command.transcriptPath, rows,
      () => run.runtime.recordTurnStart({ ...run.command, prompt: "Request 2." }));
    assert.equal(observed.result.ok, true);
    assertSingleSnapshot(observed.counts, rows, state === "settled" ? 0 : 1);
    assert.equal(observed.counts.decodes, state === "settled" ? 0 : 1);
    assert.deepEqual(run.enqueued.map(input => input.codingTurn.turnId),
      state === "completed" || state === "settled" ? ["user-1"] : []);
    assert.equal(run.runtime.size(), 1, "only the successor metadata remains open");
  });
}

test("Claude snapshot parses once when validation or either selector first needs native records", { concurrency: false }, async (t) => {
  const run = await fixture(t);
  const rows = nativeTurn(1);
  await run.save(rows);
  for (const firstMethod of ["validate", "writeback", "interrupted"]) {
    const observed = await observeNativeWork(run.command.transcriptPath, rows, async (counts) => {
      const captured = await captureClaudeTurnStartSnapshot({ ...run.command, prompt: "Request 2." });
      assert.equal(captured.ok, true);
      assertSingleSnapshot(counts, rows, 0);
      assert.equal(counts.decodes, 0);
      const selection = { ...identity, nativeUserUuid: "user-1" };
      captured.snapshot[firstMethod](selection);
      assert.deepEqual(captured.snapshot.validate(), { ok: true });
      assert.deepEqual(captured.snapshot.validate(), { ok: true });
      const completed = captured.snapshot.writeback(selection, { captureCodingItems: true });
      assert.equal(completed.ok, true);
      assert.equal(completed.turn.assistantReply, "Answer 1.");
      assert.equal(completed.turn.source.endBytes, Buffer.byteLength(lines(rows)));
      assert.deepEqual(captured.snapshot.interrupted(selection), { ok: false, reason: "turn_not_interrupted" });
    });
    assertSingleSnapshot(observed.counts, rows);
    assert.equal(observed.counts.decodes, 1);
  }
});

for (const kind of ["invalid JSONL", "invalid UTF-8", "mixed sessions"]) {
  test(`Claude snapshot defers and caches ${kind} failure for validation and selectors`, { concurrency: false }, async (t) => {
    const run = await fixture(t);
    const user = nativeTurn(1)[0];
    const foreign = { ...nativeTurn(2)[0], sessionId: "other-session" };
    const rows = kind === "mixed sessions" ? [user, foreign]
      : kind === "invalid JSONL" ? [user, "{invalid}"] : [user];
    const bytes = kind === "mixed sessions" ? Buffer.from(lines(rows))
      : Buffer.concat([Buffer.from(lines([user])), kind === "invalid JSONL"
        ? Buffer.from("{invalid}\n") : Buffer.from([0xc3, 0x28, 0x0a])]);
    await fs.writeFile(run.command.transcriptPath, bytes);
    for (const firstMethod of ["validate", "writeback", "interrupted"]) {
      const observed = await observeNativeWork(run.command.transcriptPath, rows, async (counts) => {
        const captured = await captureClaudeTurnStartSnapshot({ ...run.command, prompt: "Request 2." });
        assert.equal(captured.ok, true, "capture must not parse or validate completed native lines");
        assertSingleSnapshot(counts, rows, 0);
        assert.equal(counts.decodes, 0);
        const selection = { ...identity, nativeUserUuid: "user-1" };
        const failure = captured.snapshot[firstMethod](selection);
        assert.equal(failure.ok, false);
        assert.equal(failure.reason, kind === "mixed sessions" ? "transcript_session_mismatch" : "transcript_unavailable");
        assert.deepEqual(captured.snapshot.validate(), failure);
        assert.deepEqual(captured.snapshot.writeback(selection), failure);
        assert.deepEqual(captured.snapshot.interrupted(selection), failure);
      });
      assertSingleSnapshot(observed.counts, rows, kind === "invalid UTF-8" ? 0 : 1);
      assert.equal(observed.counts.decodes, 1, "failed validation is not decoded again");
    }
  });
}

test("Claude Start reuses its snapshot for a same-file interruption with a different prompt ID", { concurrency: false }, async (t) => {
  const run = await fixture(t);
  const user = nativeTurn(1)[0];
  await run.save([]);
  await run.runtime.recordTurnStart({ ...run.command, prompt: user.message.content });
  const rows = [user, userRecord({ uuid: "interruption-1", parentUuid: user.uuid,
    content: "Interrupted by the user.", interruptedMessageId: "message-1" })];
  await run.save(rows);
  const observed = await observeNativeWork(run.command.transcriptPath, rows,
    () => run.runtime.recordTurnStart({ ...run.command, promptId: "next-prompt", prompt: "Request 2." }));
  assert.equal(observed.result.ok, true);
  assertSingleSnapshot(observed.counts, rows);
  assert.equal(run.runtime.size(), 1);
  assert.equal(run.enqueued.length, 0);
  assert.equal(run.diagnostics.some(entry => entry.event === "claude_memory_hook.interrupted_turn_reconciled"), true);
});

test("Claude Start reads an interruption candidate independently when its path differs", { concurrency: false }, async (t) => {
  const run = await fixture(t);
  const user = nativeTurn(1)[0];
  await run.save([]);
  await run.runtime.recordTurnStart({ ...run.command, prompt: user.message.content });
  const rows = [user, userRecord({ uuid: "interruption-1", parentUuid: user.uuid,
    content: "Interrupted by the user.", interruptedMessageId: "message-1" })];
  await run.save(rows);
  const nextPath = join(run.command.cwd, "next-session.jsonl");
  await fs.writeFile(nextPath, "");
  const observed = await observeNativeWork(run.command.transcriptPath, rows,
    () => run.runtime.recordTurnStart({ ...run.command, transcriptPath: nextPath,
      promptId: "next-prompt", prompt: "Request 2." }));
  assert.equal(observed.result.ok, true);
  assertSingleSnapshot(observed.counts, rows);
  assert.equal(run.runtime.size(), 1);
  assert.equal(run.enqueued.length, 0);
  assert.equal(run.diagnostics.some(entry => entry.event === "claude_memory_hook.interrupted_turn_reconciled"), true);
});

test("Claude Start settles a predecessor from captured bytes even if the file is replaced before parsing", { concurrency: false }, async (t) => {
  const run = await fixture(t);
  const first = nativeTurn(1);
  await run.save([]);
  await run.runtime.recordTurnStart({ ...run.command, prompt: first[0].message.content });
  await run.save(first);
  const replacement = structuredClone(first);
  replacement[1].message.content = "Replacement answer.";
  const observed = await observeNativeWork(run.command.transcriptPath, first,
    () => run.runtime.recordTurnStart({ ...run.command, prompt: "Request 2." }),
    () => run.save([...replacement, ...nativeTurn(2)]));
  assert.equal(observed.result.ok, true);
  assertSingleSnapshot(observed.counts, first);
  assert.deepEqual(run.enqueued.map(input => [input.userText, input.assistantText]), [["Request 1.", "Answer 1."]]);
  assert.equal(run.enqueued[0].codingTurn.source.endBytes, Buffer.byteLength(lines(first)));
});

test("Claude Start cannot settle a predecessor from a final appended after its snapshot", { concurrency: false }, async (t) => {
  const run = await fixture(t);
  const first = nativeTurn(1);
  await run.save([]);
  await run.runtime.recordTurnStart({ ...run.command, prompt: first[0].message.content });
  await run.save([first[0]]);
  const observed = await observeNativeWork(run.command.transcriptPath, [first[0]],
    () => run.runtime.recordTurnStart({ ...run.command, prompt: "Request 2." }),
    () => fs.appendFile(run.command.transcriptPath, lines([first[1]])));
  assert.equal(observed.result.ok, true);
  assertSingleSnapshot(observed.counts, [first[0]]);
  assert.equal(run.enqueued.length, 0);
  assert.equal(run.runtime.size(), 1);
  assert.equal(run.diagnostics.some(entry => entry.event === "claude_memory_hook.previous_turn_superseded"), true);
});

test("Claude snapshot excludes a partial final while retaining every observed byte in correlation", { concurrency: false }, async (t) => {
  const run = await fixture(t);
  const first = nativeTurn(1);
  const previous = claudeTurnStartCorrelationFromJsonLines("", { ...identity, prompt: "Request 1." });
  assert.equal(previous.ok, true);
  const final = lines([first[1]]), tailLength = 20;
  const prefix = lines([first[0]]) + final.slice(0, tailLength);
  await fs.writeFile(run.command.transcriptPath, prefix);
  const observed = await observeNativeWork(run.command.transcriptPath, [first[0]], async () => {
    const captured = await captureClaudeTurnStartSnapshot({ ...run.command, prompt: "Request 2." });
    assert.equal(captured.ok, true);
    assert.equal(captured.correlation.endBytes, Buffer.byteLength(lines([first[0]])));
    assert.equal(captured.correlation.observedEndBytes, Buffer.byteLength(prefix));
    assert.equal(captured.correlation.prefixDigest, createHash("sha256").update(prefix).digest("hex"));
    await fs.appendFile(run.command.transcriptPath, final.slice(tailLength));
    const selection = { ...identity, correlation: previous.correlation };
    assert.deepEqual(captured.snapshot.writeback(selection, { captureCodingItems: true }),
      { ok: false, reason: "assistant_message_missing" });
    assert.deepEqual(captured.snapshot.interrupted(selection), { ok: false, reason: "turn_not_interrupted" });
  });
  assertSingleSnapshot(observed.counts, [first[0]]);
  const fresh = await readClaudeWritebackTurn({ ...run.command, correlation: previous.correlation, captureCodingItems: true });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.turn.assistantReply, "Answer 1.");
});

test("Claude lazy snapshot preserves CRLF and hashes an incomplete UTF-8 tail without decoding it", { concurrency: false }, async (t) => {
  const run = await fixture(t);
  const previous = lines(nativeTurn(1)).replaceAll("\n", "\r\n");
  const completeLines = nativeTurn(1).map(row => `${JSON.stringify(row)}\r`);
  const current = nativeTurn(2);
  current[0].message.content = "中文请求";
  const all = Buffer.from(previous + lines(current).replaceAll("\n", "\r\n"));
  const cut = all.indexOf(Buffer.from(current[0].message.content)) + 1;
  const observedBytes = all.subarray(0, cut);
  await fs.writeFile(run.command.transcriptPath, observedBytes);
  const observed = await observeNativeWork(run.command.transcriptPath, completeLines, async (counts) => {
    const captured = await captureClaudeTurnStartSnapshot({ ...run.command, prompt: current[0].message.content });
    assert.equal(captured.ok, true);
    assertSingleSnapshot(counts, completeLines, 0);
    assert.equal(counts.decodes, 0);
    assert.equal(captured.correlation.endBytes, Buffer.byteLength(previous));
    assert.equal(captured.correlation.observedEndBytes, cut);
    assert.equal(captured.correlation.prefixDigest, createHash("sha256").update(observedBytes).digest("hex"));
    await fs.appendFile(run.command.transcriptPath, all.subarray(cut));
    assert.deepEqual(captured.snapshot.validate(), { ok: true });
    assert.deepEqual(captured.snapshot.writeback({ ...identity, nativeUserUuid: "user-2" }),
      { ok: false, reason: "turn_not_found" });
    return captured.correlation;
  });
  assertSingleSnapshot(observed.counts, completeLines);
  assert.equal(observed.counts.decodes, 1);
  const fresh = await readClaudeWritebackTurn({ ...run.command, correlation: observed.result, captureCodingItems: true });
  assert.equal(fresh.ok, true);
  assert.equal(fresh.turn.nativeUserUuid, "user-2");
  assert.equal(fresh.turn.userPrompt, current[0].message.content);
});

test("Claude snapshot selection still rejects changes to an earlier observed prefix", { concurrency: false }, async (t) => {
  const run = await fixture(t);
  const first = nativeTurn(1);
  await run.save([first[0]]);
  const previous = await captureClaudeTurnStartSnapshot({ ...run.command, prompt: "Request 1." });
  assert.equal(previous.ok, true);
  const changed = structuredClone(first);
  changed[0].message.content = "Changed request.";
  await run.save(changed);
  const observed = await observeNativeWork(run.command.transcriptPath, changed, async () => {
    const captured = await captureClaudeTurnStartSnapshot({ ...run.command, prompt: "Request 2." });
    assert.equal(captured.ok, true);
    const selection = { ...identity, correlation: previous.correlation };
    assert.deepEqual(captured.snapshot.writeback(selection, { captureCodingItems: true }),
      { ok: false, reason: "turn_correlation_invalid" });
    assert.deepEqual(captured.snapshot.interrupted(selection), { ok: false, reason: "turn_correlation_invalid" });
  });
  assertSingleSnapshot(observed.counts, changed);
});

test("Claude Stop and archive reread native bytes independently of the Start snapshot", { concurrency: false }, async (t) => {
  const run = await fixture(t);
  const first = nativeTurn(1);
  await run.save([]);
  await run.runtime.recordTurnStart({ ...run.command, prompt: "Request 1." });
  const stop = { ...run.command, lastAssistantMessage: "Diagnostic Hook reply." };
  await run.save([first[0]]);
  const early = await observeNativeWork(run.command.transcriptPath, [first[0]], () => run.runtime.writeback(stop));
  assert.deepEqual(early.result, { ok: true, scheduled: false, reason: "assistant_message_missing" });
  assertSingleSnapshot(early.counts, [first[0]]);
  await fs.appendFile(run.command.transcriptPath, lines([first[1]]));
  const completed = await observeNativeWork(run.command.transcriptPath, first, () => run.runtime.writeback(stop));
  assert.deepEqual(completed.result, { ok: true, scheduled: true });
  assertSingleSnapshot(completed.counts, first);
  assert.equal(run.enqueued.length, 1);
  const pending = preparePendingCodingSessionTurn(run.enqueued[0].codingTurn, run.scope);
  assert.ok(pending);
  await fs.appendFile(run.command.transcriptPath, lines(nativeTurn(2)));
  const archive = await observeNativeWork(run.command.transcriptPath, first,
    () => materializePendingCodingSessionTurn(pending, run.scope, readClaudeArchiveSource));
  assertSingleSnapshot(archive.counts, first);
  assert.equal(archive.result.turn_id, "user-1");
  assert.equal(JSON.stringify(archive.result).includes("Request 2."), false);
  const changed = structuredClone(first);
  changed[1].message.content = "Mutant 1.";
  await run.save([...changed, ...nativeTurn(2)]);
  const rejected = await observeNativeWork(run.command.transcriptPath, changed,
    () => materializePendingCodingSessionTurn(pending, run.scope, readClaudeArchiveSource));
  assert.equal(rejected.counts.reads, 1);
  assert.equal(rejected.result, undefined, "archive digest validation must detect changed native content");
});
