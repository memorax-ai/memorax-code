import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  parseSkillReminderCommand,
  parseTurnDiscardCommand,
  parseTurnStartCommand,
  parseWritebackCommand,
} from "../../dist/memory/hook-command.js";
import { createMemoryService } from "../../dist/memory/service.js";

test("parseTurnStartCommand accepts a minimal DSH turn-start command", () => {
  const result = parseTurnStartCommand({
    version: 1,
    client: "dsh",
    sessionId: "session-dsh",
    turnId: "dsh-0-3",
    prompt: "Find the failing test",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.command, {
    version: 1,
    client: "dsh",
    sessionId: "session-dsh",
    turnId: "dsh-0-3",
    prompt: "Find the failing test",
  });
});

test("parseTurnStartCommand rejects a DSH command carrying a transcript path", () => {
  // DSH turns are inline text and have no transcript file: a client-supplied
  // path would be an unbacked provenance string injected into local traces,
  // so the parser must refuse it outright (Codex round 8, hook-command.ts:18).
  const result = parseTurnStartCommand({
    version: 1,
    client: "dsh",
    sessionId: "session-dsh",
    turnId: "dsh-0-3",
    prompt: "hello",
    cwd: "/repo",
    transcriptPath: "/tmp/session.jsonl",
  });
  assert.equal(result.ok, false);
});

test("parseWritebackCommand rejects a DSH writeback carrying a transcript path", () => {
  const result = parseWritebackCommand({
    version: 1,
    client: "dsh",
    sessionId: "session-dsh",
    turnId: "dsh-0-3",
    userText: "hello",
    assistantText: "world",
    transcriptPath: "/tmp/session.jsonl",
  });
  assert.equal(result.ok, false);
});

test("parseTurnStartCommand rejects a DSH command missing its turn id", () => {
  const result = parseTurnStartCommand({
    version: 1,
    client: "dsh",
    sessionId: "session-dsh",
    prompt: "hello",
  });
  assert.equal(result.ok, false);
});

test("parseWritebackCommand accepts inline DSH user and assistant text", () => {
  const result = parseWritebackCommand({
    version: 1,
    client: "dsh",
    sessionId: "session-dsh",
    turnId: "dsh-0-3",
    userText: "Fix the build",
    assistantText: "The build is fixed",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.command, {
    version: 1,
    client: "dsh",
    sessionId: "session-dsh",
    turnId: "dsh-0-3",
    userText: "Fix the build",
    assistantText: "The build is fixed",
  });
});

test("parseWritebackCommand rejects a DSH command missing assistant text", () => {
  const result = parseWritebackCommand({
    version: 1,
    client: "dsh",
    sessionId: "session-dsh",
    turnId: "dsh-0-3",
    userText: "Fix the build",
  });
  assert.equal(result.ok, false);
});

test("parseTurnDiscardCommand accepts a DSH discard command and rejects other clients", () => {
  const result = parseTurnDiscardCommand({
    version: 1,
    client: "dsh",
    sessionId: "session-dsh",
    turnId: "dsh-0-3",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.command, {
    version: 1,
    client: "dsh",
    sessionId: "session-dsh",
    turnId: "dsh-0-3",
  });

  assert.equal(parseTurnDiscardCommand({
    version: 1,
    client: "dsh",
    sessionId: "session-dsh",
  }).ok, false);

  assert.equal(parseTurnDiscardCommand({
    version: 1,
    client: "codex",
    sessionId: "session-dsh",
    turnId: "dsh-0-3",
  }).ok, false);
});

test("parseSkillReminderCommand rejects DSH and keeps codex and claude-code reminders", () => {
  assert.equal(parseSkillReminderCommand({
    version: 1,
    client: "dsh",
    sessionId: "session-dsh",
    turnId: "dsh-0-0",
    transcriptPath: "/tmp/dsh.jsonl",
    content: "reminder",
    triggers: ["cadence"],
  }).ok, false);

  const codex = parseSkillReminderCommand({
    version: 1,
    client: "codex",
    sessionId: "session-dsh",
    turnId: "turn-1",
    transcriptPath: "/tmp/codex.jsonl",
    content: "reminder",
    triggers: ["cadence"],
  });
  assert.equal(codex.ok, true);

  const claude = parseSkillReminderCommand({
    version: 1,
    client: "claude-code",
    sessionId: "session-dsh",
    promptId: "prompt-1",
    transcriptPath: "/tmp/claude.jsonl",
    content: "reminder",
    triggers: ["post_compaction"],
  });
  assert.equal(claude.ok, true);
});

test("DSH memory service records a turn start and schedules an inline writeback", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-dsh-service-"));
  const memoraxCodeHome = join(root, "home");
  const workspace = join(root, "workspace");
  await Promise.all([
    mkdir(memoraxCodeHome, { recursive: true }),
    mkdir(join(workspace, ".git"), { recursive: true }),
  ]);
  const diagnosticEvents = [];
  const requests = [];
  const service = createMemoryService({
    diagnosticLogger(message, fields) {
      diagnosticEvents.push({ message, fields });
    },
    env: {
      MEMORAX_CODE_HOME: memoraxCodeHome,
      MEMORAX_CODE_DSH_TRACE_ENABLED: "false",
      MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
      MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
      MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
      MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
      MEMORAX_CODE_MEMORAX_API_KEY: "secret",
      MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
    },
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({
        success: true,
        data: { task_id: "dsh-task", status: "queued" },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    memoraxCodeHome,
  });
  try {
    assert.deepEqual(await service.recordTurnStart({
      version: 1,
      client: "dsh",
      sessionId: "session-dsh",
      turnId: "dsh-0-0",
      prompt: "Remember this turn.",
      cwd: workspace,
    }), { ok: true });
    assert.equal(diagnosticEvents.some((event) => event.message === "dsh_memory_hook.turn_start"), true);

    assert.deepEqual(await service.writebackTurn({
      version: 1,
      client: "dsh",
      sessionId: "session-dsh",
      turnId: "dsh-0-0",
      userText: "Remember this turn.",
      assistantText: "I will remember this turn.",
      cwd: workspace,
    }), { ok: true, scheduled: true });
    assert.equal(diagnosticEvents.some((event) => event.message === "dsh_memory_hook.writeback" && event.fields?.scheduled === true), true);

    await waitFor(() => requests.length === 1, "DSH writeback did not reach MemoraX add");
    assert.equal(requests[0].url, "http://memorax.test/v1/memories/add");
    assert.deepEqual(requests[0].body.messages.map(({ role, content }) => ({ role, content })), [
      { role: "user", content: "Remember this turn." },
      { role: "assistant", content: "I will remember this turn." },
    ]);

    // Replaying the same completed turn must not produce a duplicate writeback;
    // its turn metadata is already consumed, so the replay is rejected.
    assert.deepEqual(await service.writebackTurn({
      version: 1,
      client: "dsh",
      sessionId: "session-dsh",
      turnId: "dsh-0-0",
      userText: "Remember this turn.",
      assistantText: "I will remember this turn.",
      cwd: workspace,
    }), { ok: true, scheduled: false, reason: "turn_metadata_missing" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(requests.length, 1);

    await service.drain();
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("DSH reconnect cannot restart a completed turn id (finalized-turn gate)", async () => {
  // Round 10 #1: writeback consumes the coordinator entry, so its absence
  // cannot distinguish "never started" from "already finished". A DSH
  // reconnect replays session events and re-sends the SAME turnId; without
  // the finalized-turn gate the replayed start would rebuild the entry and
  // the replayed writeback would schedule a SECOND memory.
  const root = await mkdtemp(join(tmpdir(), "memorax-code-dsh-finalized-"));
  const memoraxCodeHome = join(root, "home");
  const workspace = join(root, "workspace");
  await Promise.all([
    mkdir(memoraxCodeHome, { recursive: true }),
    mkdir(join(workspace, ".git"), { recursive: true }),
  ]);
  const diagnosticEvents = [];
  const requests = [];
  // Trace stays ENABLED (the default): the on-disk current-turn record is the
  // gate that survives a Backend restart, so it must be written and closed.
  const env = {
    MEMORAX_CODE_HOME: memoraxCodeHome,
    MEMORAX_CODE_DSH_TRACE_ENABLED: "true",
    MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
    MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
    MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
    MEMORAX_CODE_MEMORAX_API_KEY: "secret",
    MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
  };
  const fetchImpl = async (url) => {
    requests.push({ url: String(url) });
    return new Response(JSON.stringify({
      success: true,
      data: { task_id: "dsh-task", status: "queued" },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const makeService = () => createMemoryService({
    diagnosticLogger(message, fields) {
      diagnosticEvents.push({ message, fields });
    },
    env,
    fetchImpl,
    memoraxCodeHome,
  });

  const service = makeService();
  try {
    assert.equal((await service.recordTurnStart({
      version: 1,
      client: "dsh",
      sessionId: "session-dsh",
      turnId: "dsh-0-1",
      prompt: "Original prompt.",
      cwd: workspace,
    })).ok, true);
    assert.equal((await service.writebackTurn({
      version: 1,
      client: "dsh",
      sessionId: "session-dsh",
      turnId: "dsh-0-1",
      userText: "Original prompt.",
      assistantText: "Recorded.",
      cwd: workspace,
    })).scheduled, true);
    await waitFor(() => requests.length === 1, "first writeback did not reach MemoraX add");

    // Reconnect replay, same process: the in-memory finalized set must gate
    // the start (acked fail-silent, no entry rebuilt, no second memory).
    assert.deepEqual(await service.recordTurnStart({
      version: 1,
      client: "dsh",
      sessionId: "session-dsh",
      turnId: "dsh-0-1",
      prompt: "Original prompt.",
      cwd: workspace,
    }), { ok: true });
    assert.equal(
      diagnosticEvents.some((event) => event.message === "dsh_memory_hook.turn_start_after_finalize"),
      true,
    );
    assert.deepEqual(await service.writebackTurn({
      version: 1,
      client: "dsh",
      sessionId: "session-dsh",
      turnId: "dsh-0-1",
      userText: "Original prompt.",
      assistantText: "Recorded.",
      cwd: workspace,
    }), { ok: true, scheduled: false, reason: "turn_metadata_missing" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(requests.length, 1);
    await service.drain();
  } finally {
    service.close();
  }

  // Backend restart: the in-memory finalized set is empty again, so the
  // on-disk current-turn record (closed for this exact turnId) must carry
  // the gate. Without it a restart would resurrect the turn.
  const restarted = makeService();
  try {
    assert.deepEqual(await restarted.recordTurnStart({
      version: 1,
      client: "dsh",
      sessionId: "session-dsh",
      turnId: "dsh-0-1",
      prompt: "Original prompt.",
      cwd: workspace,
    }), { ok: true });
    assert.deepEqual(await restarted.writebackTurn({
      version: 1,
      client: "dsh",
      sessionId: "session-dsh",
      turnId: "dsh-0-1",
      userText: "Original prompt.",
      assistantText: "Recorded.",
      cwd: workspace,
    }), { ok: true, scheduled: false, reason: "turn_metadata_missing" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(requests.length, 1);
    await restarted.drain();
  } finally {
    restarted.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("DSH memory service isolates the same native id from other clients", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-dsh-isolation-"));
  const memoraxCodeHome = join(root, "home");
  const workspace = join(root, "workspace");
  await Promise.all([
    mkdir(memoraxCodeHome, { recursive: true }),
    mkdir(join(workspace, ".git"), { recursive: true }),
  ]);
  const diagnosticEvents = [];
  const service = createMemoryService({
    diagnosticLogger(message, fields) {
      diagnosticEvents.push({ message, fields });
    },
    env: {
      MEMORAX_CODE_HOME: memoraxCodeHome,
      MEMORAX_CODE_DSH_TRACE_ENABLED: "false",
      MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
      MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
      MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
      MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
      MEMORAX_CODE_MEMORAX_API_KEY: "secret",
      MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
    },
    memoraxCodeHome,
  });
  try {
    await service.recordTurnStart({
      version: 1,
      client: "dsh",
      sessionId: "session-shared",
      turnId: "dsh-0-0",
      prompt: "DSH turn.",
      cwd: workspace,
    });
    assert.deepEqual(await service.writebackTurn({
      version: 1,
      client: "dsh",
      sessionId: "session-shared",
      turnId: "dsh-0-0",
      userText: "DSH turn.",
      assistantText: "DSH reply.",
      cwd: workspace,
    }), { ok: true, scheduled: true });
    assert.equal(diagnosticEvents.some((event) => event.message === "dsh_memory_hook.writeback"), true);
    assert.equal(diagnosticEvents.some((event) => event.message === "codex_memory_hook.writeback"), false);
    assert.equal(diagnosticEvents.some((event) => event.message === "claude_memory_hook.writeback"), false);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("DSH writeback without matching turn metadata is rejected", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-dsh-missing-metadata-"));
  const memoraxCodeHome = join(root, "home");
  const workspace = join(root, "workspace");
  await Promise.all([
    mkdir(memoraxCodeHome, { recursive: true }),
    mkdir(join(workspace, ".git"), { recursive: true }),
  ]);
  const diagnosticEvents = [];
  const requests = [];
  const service = createMemoryService({
    diagnosticLogger(message, fields) {
      diagnosticEvents.push({ message, fields });
    },
    env: {
      MEMORAX_CODE_HOME: memoraxCodeHome,
      MEMORAX_CODE_DSH_TRACE_ENABLED: "false",
      MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
      MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
      MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
      MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
      MEMORAX_CODE_MEMORAX_API_KEY: "secret",
      MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
    },
    fetchImpl: async (url) => {
      requests.push({ url: String(url) });
      return new Response(JSON.stringify({
        success: true,
        data: { task_id: "dsh-task", status: "queued" },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    memoraxCodeHome,
  });
  try {
    assert.deepEqual(await service.writebackTurn({
      version: 1,
      client: "dsh",
      sessionId: "session-dsh",
      turnId: "dsh-0-0",
      userText: "orphan turn.",
      assistantText: "orphan reply.",
      cwd: workspace,
    }), { ok: true, scheduled: false, reason: "turn_metadata_missing" });
    assert.equal(
      diagnosticEvents.some((event) => (
        event.message === "dsh_memory_hook.writeback"
        && event.fields?.reason === "turn_metadata_missing"
      )),
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(requests.length, 0);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("DSH writeback with a mismatched prompt is rejected and does not consume metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-dsh-prompt-mismatch-"));
  const memoraxCodeHome = join(root, "home");
  const workspace = join(root, "workspace");
  await Promise.all([
    mkdir(memoraxCodeHome, { recursive: true }),
    mkdir(join(workspace, ".git"), { recursive: true }),
  ]);
  const diagnosticEvents = [];
  const requests = [];
  const service = createMemoryService({
    diagnosticLogger(message, fields) {
      diagnosticEvents.push({ message, fields });
    },
    env: {
      MEMORAX_CODE_HOME: memoraxCodeHome,
      MEMORAX_CODE_DSH_TRACE_ENABLED: "false",
      MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
      MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
      MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
      MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
      MEMORAX_CODE_MEMORAX_API_KEY: "secret",
      MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
    },
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({
        success: true,
        data: { task_id: "dsh-task", status: "queued" },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    memoraxCodeHome,
  });
  try {
    await service.recordTurnStart({
      version: 1,
      client: "dsh",
      sessionId: "session-dsh",
      turnId: "dsh-0-0",
      prompt: "Remember this turn.",
      cwd: workspace,
    });

    assert.deepEqual(await service.writebackTurn({
      version: 1,
      client: "dsh",
      sessionId: "session-dsh",
      turnId: "dsh-0-0",
      userText: "A forged different prompt.",
      assistantText: "I will remember this turn.",
      cwd: workspace,
    }), { ok: true, scheduled: false, reason: "prompt_mismatch" });
    assert.equal(
      diagnosticEvents.some((event) => (
        event.message === "dsh_memory_hook.writeback"
        && event.fields?.reason === "prompt_mismatch"
      )),
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(requests.length, 0);

    // The rejected writeback must not consume metadata, so the correct
    // userText can still be written back afterwards.
    assert.deepEqual(await service.writebackTurn({
      version: 1,
      client: "dsh",
      sessionId: "session-dsh",
      turnId: "dsh-0-0",
      userText: "Remember this turn.",
      assistantText: "I will remember this turn.",
      cwd: workspace,
    }), { ok: true, scheduled: true });
    await waitFor(() => requests.length === 1, "matching writeback did not reach MemoraX add");
    await service.drain();
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("DSH writeback accepts a userText that extends the started prompt", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-dsh-prompt-prefix-"));
  const memoraxCodeHome = join(root, "home");
  const workspace = join(root, "workspace");
  await Promise.all([
    mkdir(memoraxCodeHome, { recursive: true }),
    mkdir(join(workspace, ".git"), { recursive: true }),
  ]);
  const requests = [];
  const service = createMemoryService({
    env: {
      MEMORAX_CODE_HOME: memoraxCodeHome,
      MEMORAX_CODE_DSH_TRACE_ENABLED: "false",
      MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
      MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
      MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
      MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
      MEMORAX_CODE_MEMORAX_API_KEY: "secret",
      MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
    },
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({
        success: true,
        data: { task_id: "dsh-task", status: "queued" },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    memoraxCodeHome,
  });
  try {
    await service.recordTurnStart({
      version: 1,
      client: "dsh",
      sessionId: "session-dsh",
      turnId: "dsh-0-0",
      prompt: "Fix the build.",
      cwd: workspace,
    });
    assert.deepEqual(await service.writebackTurn({
      version: 1,
      client: "dsh",
      sessionId: "session-dsh",
      turnId: "dsh-0-0",
      userText: "Fix the build.\n\nAlso run the tests.",
      assistantText: "Done.",
      cwd: workspace,
    }), { ok: true, scheduled: true });
    await waitFor(() => requests.length === 1, "prefix writeback did not reach MemoraX add");
    await service.drain();
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("DSH discard removes turn metadata and closes the current turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-dsh-discard-"));
  const memoraxCodeHome = join(root, "home");
  const workspace = join(root, "workspace");
  await Promise.all([
    mkdir(memoraxCodeHome, { recursive: true }),
    mkdir(join(workspace, ".git"), { recursive: true }),
  ]);
  const diagnosticEvents = [];
  const requests = [];
  const service = createMemoryService({
    diagnosticLogger(message, fields) {
      diagnosticEvents.push({ message, fields });
    },
    env: {
      MEMORAX_CODE_HOME: memoraxCodeHome,
      MEMORAX_CODE_DSH_TRACE_ENABLED: "false",
      MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
      MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
      MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
      MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
      MEMORAX_CODE_MEMORAX_API_KEY: "secret",
      MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
    },
    fetchImpl: async (url) => {
      requests.push({ url: String(url) });
      return new Response(JSON.stringify({
        success: true,
        data: { task_id: "dsh-task", status: "queued" },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    memoraxCodeHome,
  });
  try {
    await service.recordTurnStart({
      version: 1,
      client: "dsh",
      sessionId: "session-dsh",
      turnId: "dsh-0-0",
      prompt: "Interrupted turn.",
      cwd: workspace,
    });
    assert.deepEqual(await service.discardTurn({
      version: 1,
      client: "dsh",
      sessionId: "session-dsh",
      turnId: "dsh-0-0",
    }), { ok: true, discarded: true });
    assert.equal(
      diagnosticEvents.some((event) => event.message === "dsh_memory_hook.turn_discarded"),
      true,
    );

    assert.deepEqual(await service.writebackTurn({
      version: 1,
      client: "dsh",
      sessionId: "session-dsh",
      turnId: "dsh-0-0",
      userText: "Interrupted turn.",
      assistantText: "Reply.",
      cwd: workspace,
    }), { ok: true, scheduled: false, reason: "turn_metadata_missing" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(requests.length, 0);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Codex round 8: the trace-recovery writeback path (coordinator entry gone,
// current-turn attestation on disk) and its trust chain.
// ---------------------------------------------------------------------------

async function createDshTraceRecoveryHarness(t) {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-dsh-recovery-"));
  const memoraxCodeHome = join(root, "home");
  const workspace = join(root, "workspace");
  const unrelatedDir = join(root, "unrelated");
  await Promise.all([
    mkdir(memoraxCodeHome, { recursive: true }),
    mkdir(join(workspace, ".git"), { recursive: true }),
    mkdir(unrelatedDir, { recursive: true }),
  ]);
  const requests = [];
  const diagnosticEvents = [];
  const fetchImpl = async (url, init) => {
    requests.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify({
      success: true,
      data: { task_id: "dsh-task", status: "queued" },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const createService = (envOverrides = {}) => createMemoryService({
    diagnosticLogger(message, fields) {
      diagnosticEvents.push({ message, fields });
    },
    env: {
      MEMORAX_CODE_HOME: memoraxCodeHome,
      // The recovery path only exists when the on-disk current-turn
      // attestation is written, so trace stays ON for every service here.
      MEMORAX_CODE_DSH_TRACE_ENABLED: "true",
      MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
      MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
      MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
      MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
      MEMORAX_CODE_MEMORAX_API_KEY: "secret",
      MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
      ...envOverrides,
    },
    fetchImpl,
    memoraxCodeHome,
  });
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  return { workspace, unrelatedDir, memoraxCodeHome, requests, diagnosticEvents, createService };
}

test("trace recovery verifies the attested prompt and binds the attested cwd", async (t) => {
  const { workspace, unrelatedDir, requests, diagnosticEvents, createService } = await createDshTraceRecoveryHarness(t);

  // Service 1 accepts the turn-start and writes the current-turn attestation.
  const first = createService();
  try {
    assert.deepEqual(await first.recordTurnStart({
      version: 1,
      client: "dsh",
      sessionId: "session-dsh",
      turnId: "dsh-0-0",
      prompt: "Recovered turn.",
      cwd: workspace,
    }), { ok: true });
  } finally {
    first.close();
  }

  // Service 2 simulates a Backend restart: the in-memory coordinator entry is
  // gone and only the attestation remains.
  const second = createService();
  try {
    // Round 8 #1: a forged userText must not ride an attested turnId.
    assert.deepEqual(await second.writebackTurn({
      version: 1,
      client: "dsh",
      sessionId: "session-dsh",
      turnId: "dsh-0-0",
      userText: "A forged different prompt.",
      assistantText: "Reply.",
      cwd: workspace,
    }), { ok: true, scheduled: false, reason: "prompt_mismatch" });
    assert.equal(
      diagnosticEvents.some((event) => (
        event.message === "dsh_memory_hook.writeback"
        && event.fields?.reason === "prompt_mismatch"
        && event.fields?.metadataSource === "current_turn_trace"
      )),
      true,
    );

    // Round 8 #2: the writeback request's cwd points at a directory with no
    // repository. The turn must stay bound to the attested workspace; without
    // that binding this writeback would be rejected by repository resolution
    // (or worse, silently bound to the unrelated directory).
    assert.deepEqual(await second.writebackTurn({
      version: 1,
      client: "dsh",
      sessionId: "session-dsh",
      turnId: "dsh-0-0",
      userText: "Recovered turn.",
      assistantText: "Recovered reply.",
      cwd: unrelatedDir,
    }), { ok: true, scheduled: true });
    await waitFor(() => requests.length === 1, "recovered writeback did not reach MemoraX add");
    assert.equal(requests[0].url, "http://memorax.test/v1/memories/add");
    await second.drain();
  } finally {
    second.close();
  }
});

test("a rejected trace-recovery writeback keeps the attestation open for retry", async (t) => {
  const { workspace, requests, diagnosticEvents, createService } = await createDshTraceRecoveryHarness(t);

  const first = createService();
  try {
    await first.recordTurnStart({
      version: 1,
      client: "dsh",
      sessionId: "session-dsh",
      turnId: "dsh-0-0",
      prompt: "Transient failure turn.",
      cwd: workspace,
    });
  } finally {
    first.close();
  }

  // Round 8 #3: the writeback is rejected for a transient reason (writeback
  // disabled). The attestation must stay OPEN so a later retry can recover.
  const rejected = createService({ MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "false" });
  try {
    const attempt = await rejected.writebackTurn({
      version: 1,
      client: "dsh",
      sessionId: "session-dsh",
      turnId: "dsh-0-0",
      userText: "Transient failure turn.",
      assistantText: "Reply.",
      cwd: workspace,
    });
    assert.equal(attempt.ok, true);
    assert.equal(attempt.scheduled, false);
    assert.equal(typeof attempt.reason, "string");
    assert.equal(
      diagnosticEvents.some((event) => (
        event.message === "dsh_memory_hook.writeback"
        && event.fields?.scheduled === false
        && event.fields?.metadataSource === "current_turn_trace"
      )),
      true,
      "the rejected recovery must be diagnosable as coming from the trace path",
    );
  } finally {
    rejected.close();
  }

  const retried = createService();
  try {
    assert.deepEqual(await retried.writebackTurn({
      version: 1,
      client: "dsh",
      sessionId: "session-dsh",
      turnId: "dsh-0-0",
      userText: "Transient failure turn.",
      assistantText: "Reply.",
      cwd: workspace,
    }), { ok: true, scheduled: true });
    await waitFor(() => requests.length === 1, "retried writeback did not reach MemoraX add");
    await retried.drain();
  } finally {
    retried.close();
  }
});

test("discarding an evicted turn closes its trace attestation", async (t) => {
  const { workspace, requests, diagnosticEvents, createService } = await createDshTraceRecoveryHarness(t);

  const first = createService();
  try {
    await first.recordTurnStart({
      version: 1,
      client: "dsh",
      sessionId: "session-dsh",
      turnId: "dsh-0-0",
      prompt: "Abandoned turn.",
      cwd: workspace,
    });
  } finally {
    first.close();
  }

  // Round 8 #7: the coordinator entry is gone, so the discard falls back to
  // the attestation and must CLOSE it — an open attestation for a discarded
  // turn would let a delayed or replayed writeback punch through.
  const second = createService();
  try {
    assert.deepEqual(await second.discardTurn({
      version: 1,
      client: "dsh",
      sessionId: "session-dsh",
      turnId: "dsh-0-0",
    }), { ok: true, discarded: false });
    assert.equal(
      diagnosticEvents.some((event) => (
        event.message === "dsh_memory_hook.turn_discarded"
        && event.fields?.metadataSource === "current_turn_trace"
      )),
      true,
    );

    assert.deepEqual(await second.writebackTurn({
      version: 1,
      client: "dsh",
      sessionId: "session-dsh",
      turnId: "dsh-0-0",
      userText: "Abandoned turn.",
      assistantText: "Delayed reply.",
      cwd: workspace,
    }), { ok: true, scheduled: false, reason: "turn_metadata_missing" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(requests.length, 0);
  } finally {
    second.close();
  }
});

test("a self-healed conflicting turn-start re-claims automatic retrieval", async (t) => {
  const { workspace, diagnosticEvents, createService } = await createDshTraceRecoveryHarness(t);

  // Round 8 #5: the conflicting turn-start self-heals by replacing the
  // coordinator entry; the replaced claim on automaticRetrievalTurns must be
  // released so the new prompt gets its retrieval pass too. Retrieval is
  // disabled here on purpose: the automatic.memory_retrieval diagnostic still
  // fires once per successful claim, which is exactly the observable.
  const service = createService();
  try {
    await service.recordTurnStart({
      version: 1,
      client: "dsh",
      sessionId: "session-dsh",
      turnId: "dsh-0-0",
      prompt: "First prompt.",
      cwd: workspace,
    });
    const firstPasses = diagnosticEvents.filter((event) => event.message === "automatic.memory_retrieval").length;
    assert.equal(firstPasses, 1);

    await service.recordTurnStart({
      version: 1,
      client: "dsh",
      sessionId: "session-dsh",
      turnId: "dsh-0-0",
      prompt: "A different prompt for the same turn id.",
      cwd: workspace,
    });
    const secondPasses = diagnosticEvents.filter((event) => event.message === "automatic.memory_retrieval").length;
    assert.equal(secondPasses, 2, "the self-healed turn must claim retrieval again");
  } finally {
    service.close();
  }
});

async function waitFor(predicate, message) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}
test("recovered writebacks bind the repository scope to the attested workspace", async (t) => {
  const { workspace, unrelatedDir, requests, createService } = await createDshTraceRecoveryHarness(t);
  // Make the unrelated directory a REAL second repository: if the recovery
  // ever falls back to the writeback request's own cwd, the MemoraX user_id
  // (derived per-repo) differs from the attested workspace's.
  await mkdir(join(unrelatedDir, ".git"), { recursive: true });

  // Only ONE current-turn attestation exists at a time, so the turns must be
  // started and recovered strictly one after another.
  const starter = createService();
  try {
    await starter.recordTurnStart({
      version: 1, client: "dsh", sessionId: "session-scope",
      turnId: "dsh-0-0", prompt: "Scope probe turn.", cwd: workspace,
    });
  } finally {
    starter.close();
  }

  const middle = createService();
  try {
    assert.deepEqual(await middle.writebackTurn({
      version: 1, client: "dsh", sessionId: "session-scope",
      turnId: "dsh-0-0", userText: "Scope probe turn.",
      assistantText: "A.", cwd: unrelatedDir,
    }), { ok: true, scheduled: true });
    await middle.drain();
    // Start the second turn from a live service so it overwrites the (now
    // closed) attestation with a fresh OPEN record for the next recovery.
    assert.deepEqual(await middle.recordTurnStart({
      version: 1, client: "dsh", sessionId: "session-scope",
      turnId: "dsh-0-1", prompt: "Scope probe second turn.", cwd: workspace,
    }), { ok: true });
  } finally {
    middle.close();
  }

  const finisher = createService();
  try {
    assert.deepEqual(await finisher.writebackTurn({
      version: 1, client: "dsh", sessionId: "session-scope",
      turnId: "dsh-0-1", userText: "Scope probe second turn.",
      assistantText: "B.", cwd: workspace,
    }), { ok: true, scheduled: true });
    await waitFor(() => requests.length === 2, "both recovered writebacks did not reach MemoraX add");
    await finisher.drain();
    assert.equal(typeof requests[0].body.user_id, "string");
    assert.equal(requests[0].body.user_id, requests[1].body.user_id,
      "recovery must scope the memory to the attested workspace, not the writeback's self-reported cwd");
  } finally {
    finisher.close();
  }
});

test("a replayed recovery writeback is rejected by the in-memory tombstone", async (t) => {
  const { workspace, requests, diagnosticEvents, createService } = await createDshTraceRecoveryHarness(t);

  const first = createService();
  try {
    await first.recordTurnStart({
      version: 1, client: "dsh", sessionId: "session-dsh",
      turnId: "dsh-0-0", prompt: "Replay gate turn.", cwd: workspace,
    });
  } finally {
    first.close();
  }

  const second = createService();
  try {
    const command = {
      version: 1, client: "dsh", sessionId: "session-dsh",
      turnId: "dsh-0-0", userText: "Replay gate turn.",
      assistantText: "Original reply.", cwd: workspace,
    };
    assert.deepEqual(await second.writebackTurn(command), { ok: true, scheduled: true });
    await waitFor(() => requests.length === 1, "recovered writeback did not reach MemoraX add");
    await second.drain();

    // Replaying the exact same command must not schedule a second memory even
    // if the on-disk attestation close silently failed: the tombstone set in
    // memory is the second, independent gate.
    assert.deepEqual(await second.writebackTurn({
      ...command, assistantText: "Replayed reply.",
    }), { ok: true, scheduled: false, reason: "turn_metadata_missing" });
    assert.equal(
      diagnosticEvents.some((event) => (
        event.message === "dsh_memory_hook.writeback"
        && event.fields?.reason === "turn_metadata_missing"
        && event.fields?.replayedRecovery === true
      )),
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(requests.length, 1, "the replayed writeback must not reach MemoraX");
  } finally {
    second.close();
  }
});

test("an attestation older than the recovery window is not a writeback credential", async (t) => {
  const { workspace, memoraxCodeHome, requests, diagnosticEvents, createService } = await createDshTraceRecoveryHarness(t);

  const first = createService();
  try {
    await first.recordTurnStart({
      version: 1, client: "dsh", sessionId: "session-dsh",
      turnId: "dsh-0-0", prompt: "Ancient turn.", cwd: workspace,
    });
  } finally {
    first.close();
  }

  // Age the on-disk attestation past the 24h recovery window.
  for (const record of await findTraceFiles(memoraxCodeHome, ".current-turn.json")) {
    const value = JSON.parse(await readFile(record, "utf8"));
    ageCapturedAt(value);
    await writeFile(record, JSON.stringify(value), "utf8");
  }

  const second = createService();
  try {
    assert.deepEqual(await second.writebackTurn({
      version: 1, client: "dsh", sessionId: "session-dsh",
      turnId: "dsh-0-0", userText: "Ancient turn.",
      assistantText: "Late reply.", cwd: workspace,
    }), { ok: true, scheduled: false, reason: "turn_metadata_missing" });
    assert.equal(
      diagnosticEvents.some((event) => (
        event.message === "dsh_memory_hook.writeback"
        && event.fields?.reason === "turn_metadata_missing"
        && event.fields?.attestationExpired === true
      )),
      true,
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(requests.length, 0);
  } finally {
    second.close();
  }
});

test("the turn_start trace event never stores the prompt plaintext", async (t) => {
  const { workspace, memoraxCodeHome, createService } = await createDshTraceRecoveryHarness(t);

  const service = createService();
  try {
    await service.recordTurnStart({
      version: 1, client: "dsh", sessionId: "session-dsh",
      turnId: "dsh-0-0", prompt: "SECRET PROMPT TOKEN FOR TRACE AUDIT.", cwd: workspace,
    });
  } finally {
    service.close();
  }

  const events = await findTraceFiles(memoraxCodeHome, "events.jsonl");
  assert.equal(events.length > 0, true, "expected at least one events.jsonl");
  for (const path of events) {
    const content = await readFile(path, "utf8");
    assert.equal(content.includes("SECRET PROMPT TOKEN"), false,
      `events.jsonl must not contain the prompt plaintext (${path})`);
    assert.equal(content.includes("promptSha256"), true,
      `the turn_start event must record the prompt hash instead (${path})`);
  }
});

async function findTraceFiles(home, fileName) {
  const found = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name === fileName) found.push(path);
    }
  }
  await walk(home);
  return found;
}

function ageCapturedAt(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (key === "captured_at" && typeof nested === "string") {
      value[key] = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    } else {
      ageCapturedAt(nested);
    }
  }
}
