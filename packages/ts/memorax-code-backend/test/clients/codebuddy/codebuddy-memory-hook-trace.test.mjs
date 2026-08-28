import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCodeBuddyMemoryHookRuntime } from "../../../dist/clients/codebuddy/memory-hook-runtime.js";
import { codeBuddyTracePaths } from "../../../dist/trace/config.js";

const fetchImpl = async () => new Response(JSON.stringify({ context: "retrieved context" }), {
  status: 200,
  headers: { "content-type": "application/json" },
});

function command(sessionId, turnId, transcriptPath, prompt) {
  return {
    version: 1,
    client: "codebuddy",
    sessionId,
    turnId,
    transcriptPath,
    prompt,
    cwd: process.cwd(),
  };
}

function lines(records) {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

async function readEvents(home, sessionId) {
  const path = codeBuddyTracePaths(home).eventsJsonl(sessionId);
  return (await readFile(path, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
}

test("CodeBuddy runtime records completed turn lifecycle trace", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-codebuddy-trace-"));
  const transcriptPath = join(home, "session.jsonl");
  const sessionId = "trace-completed";
  await writeFile(transcriptPath, lines([
    { id: "u1", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: "<user_query>remember this</user_query>" }] },
    { id: "a1", type: "message", role: "assistant", parentId: "u1", status: "completed", content: [{ type: "output_text", text: "done" }] },
  ]));
  const runtime = createCodeBuddyMemoryHookRuntime({
    env: { MEMORAX_CODE_HOME: home },
    fetchImpl,
    automaticWriteback: async () => undefined,
  });
  const turnId = provisionalTurnId(sessionId, "remember this");
  await runtime.recordTurnStart(command(sessionId, turnId, transcriptPath, "remember this"));
  await runtime.writeback({ ...command(sessionId, turnId, transcriptPath, ""), client: "codebuddy" });
  runtime.close();

  const events = await readEvents(home, sessionId);
  assert.deepEqual(events.map((event) => event.type), ["turn_start", "turn_end", "turn_materialized"]);
  assert.equal(events[1].outcome, "completed");
  assert.equal(events[2].source, "codebuddy-transcript");
  const current = JSON.parse(await readFile(codeBuddyTracePaths(home).sessionCurrentTurnPath(sessionId), "utf8"));
  assert.equal(current.turn_state, "completed");
});

test("CodeBuddy runtime traces incomplete assistant and does not write back", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-codebuddy-trace-"));
  const transcriptPath = join(home, "session.jsonl");
  const sessionId = "trace-incomplete";
  await writeFile(transcriptPath, lines([
    { id: "u1", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: "<user_query>cancel me</user_query>" }] },
    { id: "a1", type: "message", role: "assistant", parentId: "u1", status: "incomplete", content: [{ type: "output_text", text: "partial" }] },
  ]));
  const writes = [];
  const runtime = createCodeBuddyMemoryHookRuntime({
    env: { MEMORAX_CODE_HOME: home },
    fetchImpl,
    automaticWriteback: async (request) => writes.push(request),
  });
  const turnId = provisionalTurnId(sessionId, "cancel me");
  await runtime.recordTurnStart(command(sessionId, turnId, transcriptPath, "cancel me"));
  const result = await runtime.writeback({ ...command(sessionId, turnId, transcriptPath, ""), client: "codebuddy" });
  runtime.close();

  assert.deepEqual(result, { ok: true, scheduled: false, reason: "assistant_message_missing" });
  assert.equal(writes.length, 0);
  const events = await readEvents(home, sessionId);
  assert.deepEqual(events.map((event) => event.type), ["turn_start", "turn_end"]);
  assert.equal(events[1].ok, false);
  assert.equal(events[1].outcome, "interrupted");
  const current = JSON.parse(await readFile(codeBuddyTracePaths(home).sessionCurrentTurnPath(sessionId), "utf8"));
  assert.equal(current.turn_state, "interrupted");
});

test("CodeBuddy runtime writes back the uniquely materialized provisional turn", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-codebuddy-runtime-"));
  const transcriptPath = join(home, "session.jsonl");
  const sessionId = "runtime-completed";
  const prompt = "persist this turn";
  const turnId = provisionalTurnId(sessionId, prompt);
  await writeFile(transcriptPath, lines([
    { id: "u-native", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: prompt }] },
    { id: "a-native", type: "message", role: "assistant", parentId: "u-native", status: "completed", content: [{ type: "output_text", text: "persisted reply" }] },
  ]));
  const writes = [];
  const runtime = createCodeBuddyMemoryHookRuntime({
    env: configuredEnv(home, { MEMORAX_CODE_CODEBUDDY_TRACE_ENABLED: "false" }),
    automaticWriteback: (request) => {
      writes.push(request);
      return { accepted: true };
    },
  });
  try {
    await runtime.recordTurnStart(command(sessionId, turnId, transcriptPath, prompt));
    assert.deepEqual(await runtime.writeback({
      ...command(sessionId, turnId, transcriptPath, ""),
      client: "codebuddy",
    }), { ok: true, scheduled: true });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].userText, prompt);
    assert.equal(writes[0].assistantText, "persisted reply");
  } finally {
    runtime.close();
  }
});

test("CodeBuddy automatic Search returns basic context when explicitly enabled", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-codebuddy-search-"));
  const transcriptPath = join(home, "session.jsonl");
  await writeFile(transcriptPath, "");
  const sessionId = "search-retry";
  const prompt = "find prior context";
  const turnId = provisionalTurnId(sessionId, prompt);
  let searchCalls = 0;
  const runtime = createCodeBuddyMemoryHookRuntime({
    env: configuredEnv(home, {
      MEMORAX_CODE_CODEBUDDY_TRACE_ENABLED: "false",
      MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "true",
    }),
    automaticWriteback: () => ({ accepted: true }),
    claimQuotaNotice: async (_config, quota) => `${quota.featureCode}: ${quota.remaining}`,
    fetchImpl: async () => {
      searchCalls += 1;
      return new Response(JSON.stringify({
        success: true,
        data: {
          task_id: `search-${searchCalls}`,
          status: "completed",
          data: [{ id: "memory-1", memory: "basic retry context", score: 0.9, metadata: { memory_type: "core" } }],
          balances: [{
            product_code: "memory_api",
            feature_code: "memory_search",
            spec_key: "calls",
            quota_unit: "times",
            quota_limit: 10_000,
            reserved: 1,
            consumed: 0,
            remaining: 9_999,
          }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const start = command(sessionId, turnId, transcriptPath, prompt);
  try {
    const result = await runtime.recordTurnStart(start);
    assert.match(result.additionalContext, /basic retry context/);
    assert.equal(result.userNotice, "memory_search: 9999");
    assert.doesNotMatch(result.additionalContext, /memory_search/);
    assert.equal(searchCalls, 1);
  } finally {
    runtime.close();
  }
});

function provisionalTurnId(sessionId, prompt, boundary = 0) {
  return `${sessionId}:${boundary}:${createHash("sha256").update(prompt.trim()).digest("hex")}`;
}

function configuredEnv(home, overrides = {}) {
  return {
    MEMORAX_CODE_HOME: home,
    MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
    MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
    MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
    MEMORAX_CODE_MEMORAX_API_KEY: "secret",
    MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
    ...overrides,
  };
}
