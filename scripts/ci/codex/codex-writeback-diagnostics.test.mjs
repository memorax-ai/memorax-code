import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { collectWritebackDiagnostics, summarizeBackendLog, summarizeDiagnosticHistory,
  summarizeHookEvents } from "./codex-writeback-diagnostics.mjs";

const identity = { threadId: "parent-thread", turnId: "parent-turn" };
const secret = "synthetic-secret-canary";
const privatePath = "/synthetic/private/transcript.jsonl";
const digest = (value, length) => createHash("sha256").update(value).digest("hex").slice(0, length);
const counts = { warning: 0, stop: 0, feedback: 0, context: 0, error: 0 };

// These fields are shared by the 0.147.0 and 0.158.0 generated HookRunSummary schemas.
function hook(run = {}, params = {}, method = "hook/completed") {
  return { method, params: { ...identity, run: {
    id: "private-hook-run", eventName: "stop", handlerType: "command", executionMode: "sync",
    scope: "turn", sourcePath: privatePath, source: "plugin", displayOrder: 2,
    status: "completed", statusMessage: null, startedAt: 100, completedAt: 125, durationMs: 25,
    entries: [], ...run,
  }, ...params } };
}

function debugLine(event, fields) {
  return `[memorax-code-backend:debug] ${event} ${Object.entries(fields)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(" ")}`;
}

function failure(fields = {}) {
  return { source: "client-hook", client: "codex", operation: "memory.writeback",
    sessionHash: digest(identity.threadId, 24), turnHash: digest(identity.turnId, 24),
    errorCode: "HOOK_BACKEND_HTTP_REJECTED", httpStatus: 503, ...fields };
}

function history(records, fields = {}) { return { ok: true, skipped: 0, records, ...fields }; }

function assertRedacted(report) {
  const text = JSON.stringify(report);
  for (const value of [secret, privatePath, identity.threadId, identity.turnId, "private-hook-run"]) {
    assert.equal(text.includes(value), false, "diagnostic output contains a private fixture value");
  }
}

async function fixtureHarness(t, { log, runProduct } = {}) {
  const stateHome = await mkdtemp(join(tmpdir(), "codex-writeback-diagnostics-test-"));
  t.after(() => rm(stateHome, { recursive: true, force: true }));
  if (log !== undefined) {
    await mkdir(join(stateHome, "runtime", "backend"), { recursive: true });
    await writeFile(join(stateHome, "runtime", "backend", "backend.log"), log);
  }
  return { stateHome, memoryRequests: [], runProduct: runProduct ?? (async () => ({ stdout: JSON.stringify(history([])) })) };
}

test("hook summaries use the real run object and retain only safe outcome fields", () => {
  const report = summarizeHookEvents([
    hook({ status: "running", durationMs: null }, {}, "hook/started"),
    hook({ status: "failed", entries: [{ kind: "error", text: `${secret} ${privatePath}` },
      { kind: "warning", text: secret }, { kind: "unknown", text: secret }] }),
  ], identity);
  assert.deepEqual(report, { available: true, truncated: false, entries: [
    { phase: "started", correlation: "turn", event: "stop", handler: "command", source: "plugin",
      mode: "sync", status: "running", order: 2, durationMs: undefined, entryCounts: counts },
    { phase: "completed", correlation: "turn", event: "stop", handler: "command", source: "plugin",
      mode: "sync", status: "failed", order: 2, durationMs: 25, entryCounts: { ...counts, warning: 1, error: 1 } },
  ] });
  assertRedacted(report);
});

test("hook summaries never borrow another turn or Guardian thread", () => {
  const report = summarizeHookEvents([
    hook({}, { threadId: "guardian-thread" }), hook({}, { turnId: "another-turn" }),
    hook({}, {}, "item/autoApprovalReview/completed"), hook({}, {}, "turn/completed"),
    hook({}, { turnId: null }), hook(), null, { method: "hook/completed" },
  ], identity);
  assert.deepEqual(report.entries.map((entry) => entry.correlation), ["session", "turn"]);
  assert.equal(report.entries.length, 2);
  assertRedacted(report);
});

test("hook unknown values and nested serializers cannot leak through the projection", () => {
  let serialized = 0;
  const poison = { toJSON() { serialized++; return secret; } };
  const report = summarizeHookEvents([hook({
    eventName: poison, handlerType: "", executionMode: null, source: privatePath, status: secret,
    displayOrder: -1, durationMs: "25", statusMessage: secret, command: secret, exitCode: 123,
    entries: [{ kind: "error", text: poison, toJSON: poison.toJSON }, poison], toJSON: poison.toJSON,
  }), hook({ eventName: "interrupt", handlerType: "mcpTool", executionMode: "async", status: "blocked" })], identity);
  assert.deepEqual(report.entries[0], { phase: "completed", correlation: "turn", event: "unknown",
    handler: "unknown", source: "unknown", mode: "unknown", status: "unknown", order: undefined,
    durationMs: undefined, entryCounts: { ...counts, error: 1 } });
  assert.equal(report.entries[1].event, "interrupt");
  assert.equal(report.entries[1].handler, "mcpTool");
  assert.equal(report.entries[1].mode, "async");
  assert.equal(report.entries[1].status, "blocked");
  assertRedacted(report);
  assert.equal(serialized, 0);
});

test("backend fields consume nested JSON and quoted spaces without exposing the values", () => {
  const report = summarizeBackendLog(debugLine("memory_hook.writeback", {
    sessionId: identity.threadId, turnId: identity.turnId,
    error: `failed with spaces and an escaped \"quote\" ${secret} ${privatePath}`,
    dispatchReceipt: { accepted: false, nested: { messages: [secret, { path: privatePath }] } },
    scheduled: false, accepted: false, reason: "assistant_message_missing",
  }), identity);
  assert.deepEqual(report, { available: true, unparsedLines: 0, truncated: false, entries: [
    { event: "memory_hook.writeback", correlation: "turn", scheduled: false, accepted: false,
      reason: "assistant_message_missing" },
  ] });
  assertRedacted(report);
});

test("embedded markers and duplicate or malformed backend fields cannot forge a matching record", () => {
  const forged = `sessionId=\"${identity.threadId}\" turnId=\"${identity.turnId}\" scheduled=true`;
  const report = summarizeBackendLog([
    debugLine("memory_hook.writeback", { sessionId: "foreign", error: forged }),
    debugLine("memory_hook.writeback", { sessionId: "foreign", dispatchReceipt: { error: forged } }),
    `${debugLine("memory_hook.writeback", { sessionId: "foreign" })} ${forged}`,
    `${debugLine("memory_hook.writeback", { sessionId: identity.threadId })} scheduled=true scheduled=false`,
    `${debugLine("memory_hook.writeback", { sessionId: identity.threadId })} garbage`,
    `${debugLine("memory_hook.writeback", { sessionId: identity.threadId })} error="unterminated`,
    `untrusted prefix ${debugLine("memory_hook.writeback", { sessionId: identity.threadId })}`,
  ].join("\n"), identity);
  assert.equal(report.entries.length, 0);
  assert.equal(report.unparsedLines, 4);
  assertRedacted(report);
});

test("backend summaries require exact raw or hashed identity and allowlist state and reason fields", () => {
  const report = summarizeBackendLog([
    debugLine("memory_hook.writeback", { sessionId: identity.threadId, turnId: "other", accepted: true }),
    debugLine("memory_hook.writeback", { sessionId: "guardian-thread", turnId: identity.turnId }),
    debugLine("memory.automatic_writeback", { sessionKeyHash: digest("foreign", 16), scheduled: true }),
    debugLine("memory.automatic_writeback", { sessionKeyHash: digest(identity.threadId, 24), scheduled: true }),
    debugLine("memory.automatic_writeback", { sessionKeyHash: digest(identity.threadId, 16), scheduled: false,
      skipReason: "disabled", retrying: true, attempt: 1, maxAttempts: 2, retryDelayMs: 100, httpStatus: 503 }),
    debugLine("memory_hook.writeback", { sessionId: identity.threadId, turnId: identity.turnId, scheduled: "true",
      accepted: true, retrying: null, reason: secret, skipReason: { text: secret }, attempt: -1, maxAttempts: "2" }),
    debugLine("unknown.event", { sessionId: identity.threadId, turnId: identity.turnId }),
  ].join("\r\n"), identity);
  assert.deepEqual(report.entries, [
    { event: "memory.automatic_writeback", correlation: "session", scheduled: false, retrying: true,
      skipReason: "disabled", attempt: 1, maxAttempts: 2, retryDelayMs: 100, httpStatus: 503 },
    { event: "memory_hook.writeback", correlation: "turn", accepted: true, reason: "unknown", skipReason: "unknown" },
  ]);
  assertRedacted(report);
});

test("history filters client, source and exact session and turn hashes", () => {
  const report = summarizeDiagnosticHistory(history([
    failure({ client: "opencode" }), failure({ source: "lifecycle" }),
    failure({ sessionHash: digest("guardian-thread", 24) }), failure({ turnHash: digest("other", 24) }),
    failure({ sessionHash: digest(identity.threadId, 16) }), failure(),
    failure({ source: "automatic-writeback", turnHash: undefined, errorCode: "MEMORAX_TIMEOUT", httpStatus: undefined }),
  ]), identity);
  assert.deepEqual(report, { available: true, incomplete: false, truncated: false, entries: [
    { correlation: "turn", source: "client-hook", operation: "memory.writeback", errorCode: "HOOK_BACKEND_HTTP_REJECTED", httpStatus: 503 },
    { correlation: "session", source: "automatic-writeback", operation: "memory.writeback", errorCode: "MEMORAX_TIMEOUT" },
  ] });
  assertRedacted(report);
});

test("history exposes only known codes and bounded numeric fields, not nested data or serializers", () => {
  let serialized = 0;
  const poison = { toJSON() { serialized++; return secret; } };
  const report = summarizeDiagnosticHistory(history([
    failure({ operation: poison, errorCode: secret, httpStatus: 600, commandExitCode: 256,
      filePath: privatePath, error: poison, toJSON: poison.toJSON }),
    failure({ errorCode: "WRITEBACK_TRANSCRIPT_UNAVAILABLE", commandExitCode: 2 }),
    failure({ errorCode: "WRITEBACK_ASSISTANT_TEXT_EMPTY", httpStatus: "503", commandExitCode: -1 }),
    failure({ errorCode: "MEMORAX_HTTP_ERROR", commandExitCode: 0 }),
  ]), identity);
  assert.deepEqual(report.entries[0], { correlation: "turn", source: "client-hook", operation: "unknown", errorCode: "unknown" });
  assert.equal(report.entries[1].errorCode, "WRITEBACK_TRANSCRIPT_UNAVAILABLE");
  assert.equal(report.entries[1].commandExitCode, 2);
  assert.equal(report.entries[2].errorCode, "WRITEBACK_ASSISTANT_TEXT_EMPTY");
  assert.equal(Object.hasOwn(report.entries[2], "httpStatus"), false);
  assert.equal(Object.hasOwn(report.entries[2], "commandExitCode"), false);
  assert.equal(report.entries[3].commandExitCode, 0);
  assertRedacted(report);
  assert.equal(serialized, 0);
});

test("history reports unavailable and incomplete inputs without copying CLI error details", () => {
  for (const value of [null, {}, { records: secret }]) {
    assert.deepEqual(summarizeDiagnosticHistory(value, identity), { available: false });
  }
  for (const fields of [{ skipped: 1 }, { errorCode: secret }, { ok: false, skipped: 1 }]) {
    const report = summarizeDiagnosticHistory(history([], fields), identity);
    assert.equal(report.incomplete, true);
    assert.equal(report.available, fields.ok !== false);
    assertRedacted(report);
  }
  assert.equal(summarizeDiagnosticHistory(history(Array(100).fill(failure())), identity).incomplete, true);
});

test("projections cap stream tails and newest-first history at forty matching entries", () => {
  const hooks = summarizeHookEvents(Array.from({ length: 45 }, (_, index) => hook({ displayOrder: index })), identity);
  const backend = summarizeBackendLog(Array.from({ length: 45 }, (_, index) => debugLine("memory_hook.writeback",
    { sessionId: identity.threadId, turnId: identity.turnId, attempt: index })).join("\n"), identity);
  const failures = summarizeDiagnosticHistory(history(Array.from({ length: 45 }, (_, index) => failure({ httpStatus: 100 + index }))), identity);
  for (const report of [hooks, backend, failures]) {
    assert.equal(report.entries.length, 40);
    assert.equal(report.truncated, true);
    assertRedacted(report);
  }
  assert.equal(hooks.entries[0].order, 5);
  assert.equal(backend.entries[0].attempt, 5);
  assert.equal(failures.entries[0].httpStatus, 100);
});

test("HTTP status fields reject invalid numeric values in logs and diagnostic history", () => {
  for (const httpStatus of [0, 99, 600, 1.5, "503", null]) {
    const backend = summarizeBackendLog(debugLine("memory.automatic_writeback",
      { sessionKeyHash: digest(identity.threadId, 16), httpStatus }), identity);
    const failures = summarizeDiagnosticHistory(history([failure({ httpStatus })]), identity);
    assert.equal(Object.hasOwn(backend.entries[0], "httpStatus"), false);
    assert.equal(Object.hasOwn(failures.entries[0], "httpStatus"), false);
  }
});

test("missing identity returns unavailable before reading files or invoking the CLI", async () => {
  const harness = { get stateHome() { throw new Error("UNEXPECTED_FILE_ACCESS"); },
    get memoryRequests() { throw new Error("UNEXPECTED_REQUEST_ACCESS"); },
    runProduct() { throw new Error("UNEXPECTED_CLI_CALL"); } };
  for (const value of [{}, { threadId: "", turnId: identity.turnId }, { threadId: identity.threadId },
    { threadId: 1, turnId: identity.turnId }]) {
    assert.deepEqual(summarizeHookEvents([], value), { available: false });
    assert.deepEqual(summarizeBackendLog("", value), { available: false });
    assert.deepEqual(summarizeDiagnosticHistory(history([]), value), { available: false });
    assert.deepEqual(await collectWritebackDiagnostics({ ...value, harness }),
      { available: false });
  }
});

test("collector uses a fixed bounded CLI request and ignores an unfinished trailing log line", async (t) => {
  const calls = [];
  const complete = debugLine("memory_hook.writeback", { sessionId: identity.threadId, turnId: identity.turnId, scheduled: true });
  const harness = await fixtureHarness(t, { log: `${complete}\n${complete}`, runProduct: async (...args) => {
    calls.push(args);
    return { stdout: JSON.stringify(history([failure()])), stderr: `${secret} ${privatePath}` };
  } });
  harness.memoryRequests = [{ body: { session_id: identity.threadId, content: secret } },
    { body: { session_id: "guardian-thread", content: secret } }, { body: {} }];
  const report = await collectWritebackDiagnostics({ harness, events: [hook()], ...identity });
  assert.deepEqual(calls, [[ ["logs", "--diagnostics", "--limit", "100", "--json"], { timeout: 5000 } ]]);
  assert.equal(report.matchingMemoryRequests, 1);
  assert.equal(report.backend.entries.length, 1);
  assert.equal(report.backend.tailTruncated, false);
  assert.equal(report.failures.entries.length, 1);
  assertRedacted(report);
});

test("collector bounds the log tail and rejects oversized records", async (t) => {
  const complete = debugLine("memory_hook.writeback", { sessionId: identity.threadId, turnId: identity.turnId, scheduled: true });
  const oversized = debugLine("memory_hook.writeback", { sessionId: identity.threadId, error: secret.repeat(1000) });
  const harness = await fixtureHarness(t, { log: `${complete}\n${"x".repeat(256 * 1024)}\n${oversized}\n${complete}\n${complete}` });
  const report = await collectWritebackDiagnostics({ harness, events: [], ...identity });
  assert.equal(report.backend.tailTruncated, true);
  assert.equal(report.backend.unparsedLines, 1);
  assert.equal(report.backend.entries.length, 1);
  assertRedacted(report);
});

test("missing logs and CLI exceptions or invalid JSON remain unavailable without replacing the failure", async (t) => {
  for (const runProduct of [async () => { throw new Error(`${secret} ${privatePath}`); },
    async () => ({ stdout: secret }), async () => ({ stdout: JSON.stringify({ error: secret, path: privatePath }) })]) {
    const harness = await fixtureHarness(t, { runProduct });
    const report = await collectWritebackDiagnostics({ harness, events: [hook()], ...identity });
    assert.equal(report.hooks.available, true);
    assert.deepEqual(report.backend, { available: false });
    assert.deepEqual(report.failures, { available: false });
    assertRedacted(report);
  }
});
