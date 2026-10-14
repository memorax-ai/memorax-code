import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  captureClaudeTurnStartCorrelation,
  claudeCodingSessionTurnFromJsonLines,
  claudeInterruptedTranscriptTurnFromJsonLines,
  claudeTranscriptTurnFromJsonLines,
  claudeTurnStartCorrelationFromJsonLines,
  readClaudeArchiveSource,
  readClaudeCodingSessionTurn,
  readClaudeWritebackTurn,
} from "../../../dist/clients/claude/transcript-turn.js";
import { materializePendingCodingSessionTurn, preparePendingCodingSessionTurn } from "../../../dist/coding-sessions/attachment.js";
import { assistantRecord, jsonLines, PROMPT_ID, SESSION_ID, userRecord } from "./support/claude-transcript-fixtures.mjs";

const identity = { sessionId: SESSION_ID, promptId: PROMPT_ID };
const prompt = "Repeat the selected task.";
const readers = [claudeTranscriptTurnFromJsonLines, claudeCodingSessionTurnFromJsonLines];
const lines = (records) => `${jsonLines(records)}\n`;

function nativeTurn(id, text = prompt) {
  return [
    userRecord({ uuid: `user-${id}`, content: text }),
    assistantRecord({ uuid: `answer-${id}`, parentUuid: `user-${id}`, stopReason: "end_turn", content: `Answer ${id}.`, timestamp: "2026-10-14T01:00:00.000Z" }),
  ];
}

function start(text, content = prompt) {
  const result = claudeTurnStartCorrelationFromJsonLines(text, { ...identity, prompt: content });
  assert.equal(result.ok, true);
  return result.correlation;
}

test("Claude repeated prompt IDs require a selected native user, even before the second answer arrives", () => {
  const first = nativeTurn("first");
  const second = nativeTurn("second");
  for (const read of readers) {
    for (const records of [[...first, second[0]], [...first, ...second]]) {
      assert.deepEqual(read(lines(records), identity), { ok: false, reason: "turn_ambiguous" });
    }
    for (const [index, id] of ["first", "second"].entries()) {
      const result = read(lines([...first, ...second]), { ...identity, nativeUserUuid: `user-${id}` });
      assert.equal(result.ok, true);
      assert.equal(result.turn.nativeUserUuid, `user-${id}`);
      assert.equal(result.turn.sessionTurnIndex, index + 1);
      assert.equal(result.turn.assistantReply, `Answer ${id}.`);
    }
    assert.deepEqual(read(lines(first), { ...identity, promptId: "different-prompt", nativeUserUuid: "user-first" }), { ok: false, reason: "turn_not_found" });
  }
});

test("Claude start correlation supports users written before and after start and excludes completed same-text history", () => {
  const previous = nativeTurn("previous");
  const current = nativeTurn("current");
  for (const prefix of ["", lines(previous), lines([...previous, current[0]])]) {
    const correlation = start(prefix, `  ${prompt}\n`);
    const transcript = prefix ? lines([...previous, ...current]) : lines(current);
    for (const read of readers) {
      const result = read(transcript, { ...identity, correlation });
      assert.equal(result.ok, true);
      assert.equal(result.turn.nativeUserUuid, "user-current");
      assert.equal(result.turn.assistantReply, "Answer current.");
      assert.equal(result.turn.sessionTurnIndex, prefix ? 2 : 1);
    }
  }
});

test("Claude correlation rejects old open and new same-text users before considering which has a final", () => {
  const previous = nativeTurn("previous");
  const current = nativeTurn("current");
  const prefix = lines([previous[0]]);
  for (const read of readers) {
    assert.deepEqual(read(lines([previous[0], ...current]), { ...identity, correlation: start(prefix) }), { ok: false, reason: "turn_ambiguous" });
    const transcript = lines([previous[0], ...nativeTurn("different", "A different task.")]);
    const selected = read(transcript, { ...identity, correlation: start(prefix, "A different task.") });
    assert.equal(selected.ok, true);
    assert.equal(selected.turn.nativeUserUuid, "user-different");
  }
});

test("Claude correlation never revives a completed user through repeated or descendant final records", () => {
  const previous = nativeTurn("previous");
  const prefix = lines(previous);
  const descendants = [previous[1], { ...previous[1], uuid: "later-snapshot", parentUuid: previous[1].uuid }];
  for (const read of readers) {
    for (const replay of descendants) {
      assert.deepEqual(read(prefix + lines([replay]), { ...identity, correlation: start(prefix) }), { ok: false, reason: "turn_not_found" });
    }
  }
});

test("Claude completion must begin after observed start bytes, including a previously partial final", () => {
  const [user, terminal] = nativeTurn("current");
  const userText = lines([user]);
  const finalText = lines([terminal]);
  const prefix = userText + finalText.slice(0, 25);
  const correlation = start(prefix);
  assert.equal(correlation.endBytes, Buffer.byteLength(userText));
  assert.equal(correlation.observedEndBytes, Buffer.byteLength(prefix));
  for (const read of readers) {
    assert.deepEqual(read(userText + finalText, { ...identity, correlation }), { ok: false, reason: "assistant_message_missing" });
    const uncommittedUser = JSON.stringify(user);
    const result = read(`${uncommittedUser}\n${finalText}`, { ...identity, correlation: start(uncommittedUser) });
    assert.equal(result.ok, true);
  }
});

test("Claude correlation rejects changed or truncated observed bytes", () => {
  const previous = nativeTurn("previous");
  const current = nativeTurn("current");
  const prefix = lines([...previous, current[0]]);
  const correlation = start(prefix);
  for (const read of readers) {
    const changed = lines([...previous, ...current]).replace("Answer previous.", "Changed previous.");
    for (const transcript of [changed, lines(previous)]) {
      assert.deepEqual(read(transcript, { ...identity, correlation }), { ok: false, reason: "turn_correlation_invalid" });
    }
  }
});

test("Claude native turn index counts each user UUID once across equivalent snapshots", () => {
  const first = nativeTurn("first");
  const second = nativeTurn("second");
  const transcript = lines([first[0], { ...first[0], cwd: "/synthetic/snapshot" }, first[1], ...second]);
  for (const read of readers) {
    const result = read(transcript, { sessionId: SESSION_ID, nativeUserUuid: "user-second" });
    assert.equal(result.ok, true);
    assert.equal(result.turn.sessionTurnIndex, 2);
  }
});

test("Claude interrupted selection uses native UUID and the same start evidence", () => {
  const previous = nativeTurn("previous");
  const user = nativeTurn("current")[0];
  const marker = userRecord({ uuid: "interrupted-current", parentUuid: user.uuid, content: "[Request interrupted by user]", interruptedMessageId: "interrupted-answer" });
  const transcript = lines([...previous, user, marker]);
  for (const selection of [
    { sessionId: SESSION_ID, nativeUserUuid: user.uuid },
    { ...identity, correlation: start(lines(previous)) },
  ]) {
    const result = claudeInterruptedTranscriptTurnFromJsonLines(transcript, selection);
    assert.equal(result.ok, true);
    assert.equal(result.turn.nativeUserUuid, user.uuid);
    assert.equal(result.turn.sessionTurnIndex, 2);
  }
  assert.deepEqual(claudeInterruptedTranscriptTurnFromJsonLines(transcript, identity), { ok: false, reason: "turn_ambiguous" });
});

test("Claude capture handles missing files, rejects unreadable or malformed starts, and keeps no prompt body", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-claude-correlation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = { ...identity, prompt };
  const missing = await captureClaudeTurnStartCorrelation({ ...input, transcriptPath: join(root, "absent.jsonl") });
  assert.deepEqual(missing, { ok: true, correlation: start("") });
  const unreadable = await captureClaudeTurnStartCorrelation({ ...input, transcriptPath: root });
  assert.equal(unreadable.ok, false);
  assert.equal(unreadable.reason, "transcript_unavailable");
  assert.deepEqual(Object.keys(missing.correlation).sort(), ["endBytes", "observedEndBytes", "prefixDigest", "promptDigest"]);
  assert.equal(JSON.stringify(missing).includes(prompt), false);
  assert.equal(claudeTurnStartCorrelationFromJsonLines("{invalid}\n", input).ok, false);
  const mixed = lines([nativeTurn("current")[0], { ...nativeTurn("foreign")[0], sessionId: "other-session" }]);
  assert.deepEqual(claudeTurnStartCorrelationFromJsonLines(mixed, input), { ok: false, reason: "transcript_session_mismatch" });
});

test("Claude byte correlation preserves CRLF and partial UTF-8 while selecting a later completion", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-claude-byte-correlation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const transcriptPath = join(root, "transcript.jsonl");
  const content = "中文请求";
  const previous = lines(nativeTurn("previous")).replaceAll("\n", "\r\n");
  const current = lines(nativeTurn("current", content)).replaceAll("\n", "\r\n");
  const all = Buffer.from(previous + current);
  const cut = all.indexOf(Buffer.from(content)) + 1;
  const observed = all.subarray(0, cut);
  await writeFile(transcriptPath, observed);
  const captured = await captureClaudeTurnStartCorrelation({ ...identity, prompt: content, transcriptPath });
  assert.equal(captured.ok, true);
  assert.equal(captured.correlation.endBytes, Buffer.byteLength(previous));
  assert.equal(captured.correlation.observedEndBytes, cut);
  assert.equal(captured.correlation.prefixDigest, createHash("sha256").update(observed).digest("hex"));
  await appendFile(transcriptPath, all.subarray(cut));
  const result = await readClaudeWritebackTurn({ ...identity, transcriptPath, correlation: captured.correlation, captureCodingItems: true });
  assert.equal(result.ok, true);
  assert.equal(result.turn.nativeUserUuid, "user-current");
  assert.equal(result.turn.userPrompt, content);
});

test("Claude archive rereads the frozen native user UUID when prompt IDs are reused", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-claude-uuid-archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const transcriptPath = join(root, "transcript.jsonl");
  const records = [...nativeTurn("first"), ...nativeTurn("second")];
  await writeFile(transcriptPath, lines(records));
  const result = await readClaudeCodingSessionTurn({ sessionId: SESSION_ID, nativeUserUuid: "user-second", transcriptPath });
  assert.equal(result.ok, true);
  const scope = { repositorySlug: "correlation-tests" };
  const pending = preparePendingCodingSessionTurn({
    client: "claude-code", sessionId: SESSION_ID, turnId: result.turn.nativeUserUuid,
    turnIndex: result.turn.sessionTurnIndex, items: result.turn.items, outcome: "completed",
    closedAt: result.turn.closedAt, source: result.turn.source,
  }, scope);
  assert.ok(pending);
  await appendFile(transcriptPath, lines(nativeTurn("third")));
  const materialized = await materializePendingCodingSessionTurn(pending, scope, readClaudeArchiveSource);
  assert.ok(materialized);
  assert.equal(materialized.turn_id, "user-second");
  assert.equal(materialized.turn_index, 2);
  assert.deepEqual(materialized.items, result.turn.items);
});
