import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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

test("parseTurnStartCommand accepts an optional DSH transcript path", () => {
  const result = parseTurnStartCommand({
    version: 1,
    client: "dsh",
    sessionId: "session-dsh",
    turnId: "dsh-0-3",
    prompt: "hello",
    cwd: "/repo",
    transcriptPath: "/tmp/session.jsonl",
  });
  assert.equal(result.ok, true);
  assert.equal(result.command.transcriptPath, "/tmp/session.jsonl");
  assert.equal(result.command.cwd, "/repo");
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

async function waitFor(predicate, message) {
  const deadline = Date.now() + 1000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(message);
}