import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMemoryCli } from "../../../dist/memory/cli.js";
import { createCodeBuddyMemoryHookRuntime } from "../../../dist/clients/codebuddy/memory-hook-runtime.js";
import { clientTracePaths, codeBuddyTracePaths } from "../../../dist/trace/config.js";

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

async function readEvents(home, sessionId, client = "codebuddy") {
  const path = clientTracePaths(client, home).eventsJsonl(sessionId);
  return (await readFile(path, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
}

test("CodeBuddy normalized Hook digest selects the native multiline prompt after its UTF-8 byte boundary", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-codebuddy-multiline-"));
  const transcriptPath = join(home, "session.jsonl"), sessionId = "multiline-completed";
  const prompt = "\u7b2c\u4e00\u6bb5: preserve caf\u00e9.\n\n\u7b2c\u4e8c\u6bb5: preserve the original paragraphs.";
  const hookPrompt = prompt.replaceAll("\n", "");
  const before = lines([
    { id: "earlier-user", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: prompt.replace("\n\n", "\n") }] },
    { id: "earlier-answer", type: "message", role: "assistant", parentId: "earlier-user", status: "completed", content: [{ type: "output_text", text: "Earlier answer must not be reused." }] },
  ]);
  const boundary = Buffer.byteLength(before, "utf8");
  assert.ok(boundary > before.length);
  const turnId = provisionalTurnId(sessionId, hookPrompt, boundary);
  const answer = "Preserve all native paragraphs.\n\nKeep UTF-8 intact.";
  await writeFile(transcriptPath, before + lines([
    { id: "current-user", type: "message", role: "user", sessionId, timestamp: 1_700_000_000_000,
      content: [{ type: "input_text", text: `<user_query>${prompt}</user_query>` }] },
    { id: "current-answer", type: "message", role: "assistant", parentId: "current-user", status: "completed",
      timestamp: 1_700_000_060_000, content: [{ type: "output_text", text: answer }] },
  ]));
  const requests = [];
  const runtime = createCodeBuddyMemoryHookRuntime({ env: configuredEnv(home), transcriptReadAttempts: 1,
    fetchImpl: async (url, init) => {
      requests.push({ path: new URL(url).pathname, body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ success: true, data: { task_id: "multiline-add", status: "queued" } }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    },
  });
  try {
    const start = { ...command(sessionId, turnId, transcriptPath, hookPrompt), cwd: home };
    await runtime.recordTurnStart(start);
    assert.deepEqual(await runtime.writeback({ ...start, prompt: "" }), { ok: true, scheduled: true });
    const deadline = Date.now() + 1_000;
    while (requests.length === 0) {
      assert.ok(Date.now() < deadline, "CodeBuddy multiline Add was not sent");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path, "/v1/memories/add");
    assert.equal(requests[0].body.session_id, sessionId);
    assert.deepEqual(requests[0].body.messages.map(({ role, content, timestamp }) => ({ role, content, timestamp })), [
      { role: "user", content: prompt, timestamp: 1_700_000_000_000 },
      { role: "assistant", content: answer, timestamp: 1_700_000_060_000 },
    ]);
    const events = await readEvents(home, sessionId);
    assert.ok(events.every((event) => event.trace.client === "codebuddy" && event.trace.turn_id === turnId));
    assert.equal(events.find((event) => event.type === "turn_end").request.prompt, prompt);
  } finally {
    runtime.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("CodeBuddy refuses exact and normalized prompt ambiguity within the same byte boundary", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-codebuddy-ambiguous-"));
  const transcriptPath = join(home, "session.jsonl"), sessionId = "multiline-ambiguous";
  const before = lines([{ type: "metadata", note: "UTF-8 \u8fb9\u754c" }]);
  const prompt = "firstsecond", turnId = provisionalTurnId(sessionId, prompt, Buffer.byteLength(before, "utf8"));
  await writeFile(transcriptPath, before + lines([
    { id: "exact-user", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: prompt }] },
    { id: "exact-answer", type: "message", role: "assistant", parentId: "exact-user", status: "completed", content: [{ type: "output_text", text: "Exact answer." }] },
    { id: "multiline-user", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: "first\nsecond" }] },
    { id: "multiline-answer", type: "message", role: "assistant", parentId: "multiline-user", status: "completed", content: [{ type: "output_text", text: "Different answer." }] },
  ]));
  const writes = [];
  const runtime = createCodeBuddyMemoryHookRuntime({ env: configuredEnv(home), transcriptReadAttempts: 1,
    automaticWriteback: (request) => { writes.push(request); return { accepted: true }; } });
  try {
    const start = { ...command(sessionId, turnId, transcriptPath, prompt), cwd: home };
    await runtime.recordTurnStart(start);
    assert.deepEqual(await runtime.writeback({ ...start, prompt: "" }), { ok: true, scheduled: false, reason: "turn_ambiguous" });
    assert.equal(writes.length, 0);
    const events = await readEvents(home, sessionId);
    assert.equal(events.find((event) => event.type === "turn_end").error, "turn_ambiguous");
    assert.equal(events.some((event) => event.type === "turn_materialized"), false);
  } finally {
    runtime.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("WorkBuddy completed writeback still requires the exact multiline Hook digest", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-workbuddy-multiline-"));
  const transcriptPath = join(home, "session.jsonl"), sessionId = "workbuddy-multiline";
  const prompt = "Preserve the first paragraph.\n\nPreserve the second paragraph.";
  const hookPrompt = prompt.replaceAll("\n", "");
  await writeFile(transcriptPath, lines([
    { id: "u1", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: prompt }] },
    { id: "a1", type: "message", role: "assistant", parentId: "u1", status: "completed", content: [{ type: "output_text", text: "Complete answer." }] },
  ]));
  const writes = [];
  const runtime = createCodeBuddyMemoryHookRuntime({ client: "workbuddy", env: configuredEnv(home), transcriptReadAttempts: 1,
    automaticWriteback: (request) => { writes.push(request); return { accepted: true }; } });
  try {
    const normalized = { ...command(sessionId, provisionalTurnId(sessionId, hookPrompt), transcriptPath, hookPrompt), client: "workbuddy", cwd: home };
    await runtime.recordTurnStart(normalized);
    assert.deepEqual(await runtime.writeback({ ...normalized, prompt: "" }), { ok: true, scheduled: false, reason: "user_prompt_missing" });
    assert.equal(writes.length, 0);
    const exact = { ...command(sessionId, provisionalTurnId(sessionId, prompt), transcriptPath, prompt), client: "workbuddy", cwd: home };
    await runtime.recordTurnStart(exact);
    assert.deepEqual(await runtime.writeback({ ...exact, prompt: "" }), { ok: true, scheduled: true });
    assert.equal(writes.length, 1);
    assert.equal(writes[0].client, "workbuddy");
    assert.equal(writes[0].userText, prompt);
    assert.equal(writes[0].assistantText, "Complete answer.");
    assert.ok((await readEvents(home, sessionId, "workbuddy")).every((event) => event.trace.client === "workbuddy"));
  } finally {
    runtime.close();
    await rm(home, { recursive: true, force: true });
  }
});

for (const client of ["codebuddy", "workbuddy"]) {
  test(`${client} interrupted reconciliation applies only its own prompt digest contract`, async () => {
    const home = await mkdtemp(join(tmpdir(), `memorax-${client}-multiline-interrupted-`));
    const transcriptPath = join(home, "session.jsonl"), sessionId = "multiline-interrupted";
    const prompt = "Interrupted first line.\nSecond line.", hookPrompt = prompt.replaceAll("\n", "");
    const firstTurnId = provisionalTurnId(sessionId, hookPrompt);
    const before = lines([
      { id: "u1", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: prompt }] },
      { id: "a1", type: "message", role: "assistant", parentId: "u1", status: "incomplete", content: [{ type: "output_text", text: "Partial answer." }] },
    ]);
    await writeFile(transcriptPath, before);
    const writes = [], diagnostics = [];
    const runtime = createCodeBuddyMemoryHookRuntime({ client, env: configuredEnv(home),
      automaticWriteback: (request) => { writes.push(request); return { accepted: true }; },
      diagnosticLogger: (event) => diagnostics.push(event),
    });
    try {
      await runtime.recordTurnStart({ ...command(sessionId, firstTurnId, transcriptPath, hookPrompt), client, cwd: home });
      const nextPrompt = "Continue independently.";
      await writeFile(transcriptPath, before + lines([
        { id: "u2", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: nextPrompt }] },
      ]));
      const nextTurnId = provisionalTurnId(sessionId, nextPrompt, Buffer.byteLength(before, "utf8"));
      await runtime.recordTurnStart({ ...command(sessionId, nextTurnId, transcriptPath, nextPrompt), client, cwd: home });
      const events = await readEvents(home, sessionId, client);
      assert.ok(events.every((event) => event.trace.client === client));
      assert.deepEqual(events.map((event) => event.type), client === "codebuddy"
        ? ["turn_start", "turn_end", "turn_start"] : ["turn_start", "turn_start"]);
      if (client === "codebuddy") {
        assert.equal(events[1].trace.turn_id, firstTurnId);
        assert.equal(events[1].outcome, "interrupted");
        assert.equal(events[1].request.prompt, prompt);
        assert.equal(events[1].response.assistantMessage, "Partial answer.");
      }
      assert.equal(diagnostics.includes(`${client}_memory_hook.interrupted_turn_reconciled`), client === "codebuddy");
      assert.equal(runtime.size(), client === "codebuddy" ? 1 : 2);
      assert.equal(writes.length, 0);
    } finally {
      runtime.close();
      await rm(home, { recursive: true, force: true });
    }
  });
}

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

test("CodeBuddy next turn reconciles the previous interrupted trace without writeback", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-codebuddy-trace-reconcile-"));
  const transcriptPath = join(home, "session.jsonl");
  const sessionId = "trace-reconcile";
  const firstPrompt = "interrupt this turn";
  const secondPrompt = "continue in the next turn";
  const firstTurnId = provisionalTurnId(sessionId, firstPrompt);
  const firstUser = { id: "u1", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: firstPrompt }] };
  await writeFile(transcriptPath, lines([firstUser]));
  const writes = [];
  const diagnostics = [];
  const runtime = createCodeBuddyMemoryHookRuntime({
    env: {
      MEMORAX_CODE_HOME: home,
      MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
    },
    automaticWriteback: (request) => {
      writes.push(request);
      return { accepted: true };
    },
    diagnosticLogger: (event, fields) => diagnostics.push({ event, fields }),
  });
  try {
    await runtime.recordTurnStart(command(sessionId, firstTurnId, transcriptPath, firstPrompt));
    const beforeSecond = lines([
      firstUser,
      { id: "a1", type: "message", role: "assistant", parentId: "u1", status: "incomplete", content: [{ type: "output_text", text: "partial answer" }] },
    ]);
    await writeFile(transcriptPath, beforeSecond + lines([
      { id: "u2", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: secondPrompt }] },
    ]));
    const secondTurnId = provisionalTurnId(sessionId, secondPrompt, Buffer.byteLength(beforeSecond, "utf8"));
    await runtime.recordTurnStart(command(sessionId, secondTurnId, transcriptPath, secondPrompt));

    const events = await readEvents(home, sessionId);
    assert.deepEqual(events.map((event) => event.type), ["turn_start", "turn_end", "turn_start"]);
    assert.equal(events[1].trace.turn_id, firstTurnId);
    assert.equal(events[1].source, "codebuddy-transcript");
    assert.equal(events[1].outcome, "interrupted");
    assert.equal(events[1].request.prompt, firstPrompt);
    assert.equal(events[1].response.assistantMessage, "partial answer");
    assert.equal(writes.length, 0);
    assert.equal(runtime.size(), 1);
    assert.equal(diagnostics.some(({ event }) => event === "codebuddy_memory_hook.interrupted_turn_reconciled"), true);
    const current = JSON.parse(await readFile(codeBuddyTracePaths(home).sessionCurrentTurnPath(sessionId), "utf8"));
    assert.equal(current.turn_state, "open");
    assert.equal(current.trace.turn_id, secondTurnId);
  } finally {
    runtime.close();
  }
});

test("WorkBuddy next turn restores an assistant-less interrupted trace after runtime restart", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-codebuddy-trace-restart-"));
  const transcriptPath = join(home, "session.jsonl");
  const sessionId = "trace-restart";
  const firstPrompt = "interrupt before restart";
  const secondPrompt = "continue after restart";
  const firstTurnId = provisionalTurnId(sessionId, firstPrompt);
  const firstUser = { id: "u1", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: firstPrompt }] };
  await writeFile(transcriptPath, lines([firstUser]));
  const env = {
    MEMORAX_CODE_HOME: home,
    MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
  };
  const firstRuntime = createCodeBuddyMemoryHookRuntime({
    client: "workbuddy",
    env,
    automaticWriteback: () => ({ accepted: true }),
  });
  await firstRuntime.recordTurnStart({ ...command(sessionId, firstTurnId, transcriptPath, firstPrompt), client: "workbuddy" });
  firstRuntime.close();

  const firstTranscript = lines([firstUser]);
  await writeFile(transcriptPath, firstTranscript + lines([
    { id: "u2", type: "message", role: "user", sessionId, content: [{ type: "input_text", text: secondPrompt }] },
  ]));
  const secondTurnId = provisionalTurnId(sessionId, secondPrompt, Buffer.byteLength(firstTranscript, "utf8"));
  const writes = [];
  const restarted = createCodeBuddyMemoryHookRuntime({
    client: "workbuddy",
    env,
    automaticWriteback: (request) => {
      writes.push(request);
      return { accepted: true };
    },
  });
  try {
    await restarted.recordTurnStart({ ...command(sessionId, secondTurnId, transcriptPath, secondPrompt), client: "workbuddy" });
    const events = await readEvents(home, sessionId, "workbuddy");
    assert.deepEqual(events.map((event) => event.type), ["turn_start", "turn_end", "turn_start"]);
    assert.equal(events[1].trace.turn_id, firstTurnId);
    assert.equal(events[1].outcome, "interrupted");
    assert.equal(events[1].request.prompt, firstPrompt);
    assert.equal(writes.length, 0);
    assert.equal(restarted.size(), 1);
  } finally {
    restarted.close();
  }
});

test("WorkBuddy provisional turn writeback and nested Skill commands share General", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-codebuddy-runtime-"));
  const transcriptPath = join(home, "session.jsonl");
  const workspace = join(home, "WorkBuddy");
  const nested = join(workspace, "work");
  await mkdir(nested, { recursive: true });
  const sessionId = "runtime-completed";
  const prompt = "/memorax-code persist this turn";
  const turnId = provisionalTurnId(sessionId, prompt);
  await writeFile(transcriptPath, lines([
    { id: "u-native", type: "message", role: "user", sessionId, timestamp: 1_700_000_000_000, content: [
      { type: "input_text", text: "<command-name>/memorax-code</command-name>\n# MemoraX Code\nExpanded instructions",
        providerData: { content: prompt } },
    ] },
    { id: "a-native", type: "message", role: "assistant", parentId: "u-native", status: "completed", timestamp: 1_700_000_060_000, content: [{ type: "output_text", text: "persisted reply" }] },
  ]));
  const requests = [];
  const env = configuredEnv(home, { MEMORAX_CODE_WORKBUDDY_TRACE_ENABLED: "false" });
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    const data = String(url).endsWith("/add") ? { task_id: "general-add", status: "queued" } : { data: [] };
    return new Response(JSON.stringify({ success: true, data }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const runtime = createCodeBuddyMemoryHookRuntime({ env, fetchImpl, client: "workbuddy" });
  try {
    await runtime.recordTurnStart({
      ...command(sessionId, turnId, transcriptPath, prompt),
      client: "workbuddy",
      cwd: workspace,
      workspaceKind: "projectless",
    });
    assert.deepEqual(await runtime.writeback({
      ...command(sessionId, turnId, transcriptPath, ""),
      client: "workbuddy",
      cwd: workspace,
    }), { ok: true, scheduled: true });
    const deadline = Date.now() + 1_000;
    while (requests.length === 0) {
      assert.ok(Date.now() < deadline, "WorkBuddy automatic Add was not sent");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.deepEqual(requests[0].body.messages.map(({ role, content, timestamp }) => ({ role, content, timestamp })), [
      { role: "user", content: prompt, timestamp: 1_700_000_000_000 },
      { role: "assistant", content: "persisted reply", timestamp: 1_700_000_060_000 },
    ]);
    const options = {
      cwd: nested,
      env: {
        ...env,
        CODEBUDDY_SESSION_ID: sessionId,
        CODEX_THREAD_ID: "inherited-codex-thread",
      },
      fetchImpl,
    };
    const search = await runMemoryCli(["search", "--query", "general preference"], options);
    const added = await runMemoryCli([
      "add", "--memory", "Keep shared general preferences.", "--type", "preference", "--reason", "Explicit test save.",
    ], options);
    assert.equal(search.ok, true);
    assert.equal(added.ok, true);
    assert.equal(search.effectiveUserId, "user-1@General");
    assert.equal(added.effectiveUserId, "user-1@General");
    assert.deepEqual(requests.map(({ url }) => new URL(url).pathname), [
      "/v1/memories/add", "/v1/memories/search", "/v1/memories/add",
    ]);
    assert.ok(requests.every(({ body }) => body.user_id === "user-1@General"));
    for (const index of [0, 2]) {
      assert.equal(requests[index].body.metadata.memorax_code_memory_scope, "general.v1");
      assert.equal(requests[index].body.metadata.memorax_code_workspace, "General");
    }
    // A later native hook can omit the default-chat hint after entering a child
    // directory. Its operational bridge must retain the session's General root.
    const nextPrompt = "continue from the child directory";
    await runtime.recordTurnStart({
      ...command(sessionId, provisionalTurnId(sessionId, nextPrompt), transcriptPath, nextPrompt),
      client: "workbuddy",
      cwd: nested,
    });
    const nextSearch = await runMemoryCli(["search", "--query", "general preference"], options);
    assert.equal(nextSearch.ok, true);
    assert.equal(nextSearch.effectiveUserId, "user-1@General");
    assert.equal(requests.at(-1).body.user_id, "user-1@General");
  } finally {
    runtime.close();
    await rm(home, { recursive: true, force: true });
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
