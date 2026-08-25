import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { readKimiWireTurn } from "../../../dist/clients/kimi/wire-turn.js";
import { createMemoryService } from "../../../dist/memory/service.js";
import { parseSkillReminderCommand, parseTurnStartCommand, parseWritebackCommand } from "../../../dist/memory/hook-command.js";
import { kimiTracePaths } from "../../../dist/trace/config.js";
import { recordTraceEvent } from "../../../dist/trace/store.js";

const TEST_WORKSPACE = fileURLToPath(new URL("../../..", import.meta.url));

test("Kimi commands keep a closed client-specific schema", () => {
  const promptId = sha256("Kimi prompt.");
  assert.equal(parseTurnStartCommand({
    version: 1,
    client: "kimi",
    sessionId: "session-1",
    promptId,
    prompt: "Kimi prompt.",
    cwd: TEST_WORKSPACE,
  }).ok, true);
  assert.equal(parseWritebackCommand({
    version: 1,
    client: "kimi",
    sessionId: "session-1",
    promptId,
    turnId: "2",
    wirePath: "/tmp/session-1/agents/main/wire.jsonl",
  }).ok, true);
  assert.equal(parseWritebackCommand({
    version: 1,
    client: "kimi",
    sessionId: "session-1",
    promptId,
    turnId: "2",
    wirePath: "/tmp/session-1/agents/main/wire.jsonl",
    lastAssistantMessage: "Hook text is not Kimi writeback authority.",
  }).ok, false);
  assert.equal(parseSkillReminderCommand({
    version: 1,
    client: "kimi",
    sessionId: "session-1",
    promptId,
    content: "Use /memorax-code when memory may help.",
    triggers: ["cadence"],
  }).ok, true);
});

test("Kimi wire materializes only the exact completed main turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-kimi-wire-"));
  const sessionId = "session-wire";
  const wirePath = await writeWire(root, sessionId, "  Kimi user prompt.  ", "Kimi assistant reply.");
  try {
    assert.deepEqual(await readKimiWireTurn({
      sessionId,
      promptId: sha256("Kimi user prompt."),
      turnId: "4",
      wirePath,
    }), {
      ok: true,
      turn: {
        turnId: "4",
        userPrompt: "Kimi user prompt.",
        assistantReply: "Kimi assistant reply.",
      },
    });
    assert.deepEqual(await readKimiWireTurn({
      sessionId,
      promptId: sha256("different prompt"),
      turnId: "4",
      wirePath,
    }), { ok: false, reason: "prompt_identity_mismatch" });
    assert.deepEqual(await readKimiWireTurn({
      sessionId: "different-session",
      promptId: sha256("Kimi user prompt."),
      turnId: "4",
      wirePath,
    }), { ok: false, reason: "wire_identity_mismatch" });
    await appendFile(wirePath, "{\"type\":\"incomplete\"");
    assert.equal((await readKimiWireTurn({
      sessionId,
      promptId: sha256("Kimi user prompt."),
      turnId: "4",
      wirePath,
    })).ok, true);
    await writeWire(root, sessionId, "Kimi user prompt.", "partial", {
      cancelled: true,
      reason: "cancelled",
    });
    assert.deepEqual(await readKimiWireTurn({
      sessionId,
      promptId: sha256("Kimi user prompt."),
      turnId: "4",
      wirePath,
    }), { ok: false, reason: "cancelled" });
    await writeWire(root, sessionId, "Kimi user prompt.", "");
    assert.deepEqual(await readKimiWireTurn({
      sessionId,
      promptId: sha256("Kimi user prompt."),
      turnId: "4",
      wirePath,
    }), { ok: false, reason: "assistant_message_missing" });
    await appendFile(wirePath, "{not-json}\n");
    assert.deepEqual(await readKimiWireTurn({
      sessionId,
      promptId: sha256("Kimi user prompt."),
      turnId: "4",
      wirePath,
    }), { ok: false, reason: "malformed_record" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Kimi wire accepts the current native shape without prompt.accepted", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-kimi-wire-native-"));
  const sessionId = "session-native-wire";
  const wirePath = join(root, sessionId, "agents", "main", "wire.jsonl");
  await mkdir(join(root, sessionId, "agents", "main"), { recursive: true });
  await writeFile(wirePath, `${[
    { type: "turn.prompt", origin: { kind: "user" }, input: [{ type: "text", text: "Native Kimi prompt." }] },
    { type: "context.append_loop_event", event: { type: "step.begin", turnId: 0 } },
    { type: "context.append_loop_event", event: { type: "content.part", turnId: 0, part: { type: "text", text: "Native Kimi reply." } } },
    { type: "turn.ended", turnId: 0, reason: "completed" },
  ].map(JSON.stringify).join("\n")}\n`);
  try {
    assert.deepEqual(await readKimiWireTurn({
      sessionId,
      promptId: sha256("Native Kimi prompt."),
      turnId: "0",
      wirePath,
    }), {
      ok: true,
      turn: {
        turnId: "0",
        userPrompt: "Native Kimi prompt.",
        assistantReply: "Native Kimi reply.",
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Kimi completed wire turn uses shared automatic writeback", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-kimi-writeback-"));
  const sessionId = "session-writeback";
  const prompt = "Persist the Kimi result.";
  const wirePath = await writeWire(root, sessionId, prompt, "Stored Kimi answer.");
  const requests = [];
  const traceWrites = [];
  const memoraxCodeHome = join(root, "memorax-home");
  const service = createMemoryService({
    memoraxCodeHome,
    env: {
      MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
      MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
      MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
      MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
      MEMORAX_CODE_MEMORAX_API_KEY: "test-key",
      MEMORAX_CODE_MEMORAX_USER_ID: "test-user",
    },
    memoryObservability: {
      recordEvent(event) {
        traceWrites.push(recordTraceEvent({
          memoraxCodeHome,
          env: {
            MEMORAX_CODE_HOME: memoraxCodeHome,
          },
          type: event.operation === "writeback" ? "memory_writeback" : "memory_retrieve",
          ...event,
          traceContext: event.traceContext,
        }));
      },
    },
    fetchImpl: async (url, request) => {
      requests.push({ url: String(url), body: JSON.parse(request.body) });
      return new Response(JSON.stringify({
        success: true,
        data: { task_id: "writeback-1", status: "queued" },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  try {
    const promptId = sha256(prompt);
    await service.recordTurnStart({
      version: 1,
      client: "kimi",
      sessionId,
      promptId,
      prompt,
      cwd: TEST_WORKSPACE,
    });
    assert.deepEqual(await service.writebackTurn({
      version: 1,
      client: "kimi",
      sessionId,
      promptId,
      turnId: "4",
      wirePath,
      cwd: TEST_WORKSPACE,
    }), { ok: true, scheduled: true });
    await service.drain();
    await Promise.all(traceWrites);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "http://memorax.test/v1/memories/add");
    assert.match(JSON.stringify(requests[0].body), /Stored Kimi answer/);
    const traceEvents = (await readFile(kimiTracePaths(join(root, "memorax-home")).eventsJsonl(sessionId), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(traceEvents.map((event) => event.type), ["turn_start", "turn_end", "turn_materialized", "memory_writeback"]);
    assert.equal(traceEvents.every((event) => event.trace.client === "kimi"), true);
    assert.equal(traceEvents[0].trace.turn_id, promptId);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Kimi automatic retrieval runs once per exact prompt id", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-kimi-retrieval-"));
  const requests = [];
  const service = createMemoryService({
    memoraxCodeHome: join(root, "memorax-home"),
    env: {
      MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "true",
      MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
      MEMORAX_CODE_MEMORAX_API_KEY: "test-key",
      MEMORAX_CODE_MEMORAX_USER_ID: "test-user",
    },
    fetchImpl: async (url, request) => {
      requests.push({ url: String(url), body: JSON.parse(request.body) });
      return new Response(JSON.stringify({
        success: true,
        data: {
          task_id: "kimi-retrieval-1",
          status: "completed",
          data: [{
            id: "memory-1",
            memory: "Kimi retrieval context.",
            score: 0.9,
            metadata: { memory_type: "core" },
          }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  try {
    const first = await service.recordTurnStart({
      version: 1,
      client: "kimi",
      sessionId: "session-retrieval",
      promptId: sha256("Kimi retrieval prompt."),
      prompt: "Kimi retrieval prompt.",
      cwd: TEST_WORKSPACE,
    });
    const duplicate = await service.recordTurnStart({
      version: 1,
      client: "kimi",
      sessionId: "session-retrieval",
      promptId: sha256("Kimi retrieval prompt."),
      prompt: "Kimi retrieval prompt.",
      cwd: TEST_WORKSPACE,
    });
    const next = await service.recordTurnStart({
      version: 1,
      client: "kimi",
      sessionId: "session-retrieval",
      promptId: sha256("Kimi next prompt."),
      prompt: "Kimi next prompt.",
      cwd: TEST_WORKSPACE,
    });
    assert.match(first.additionalContext, /Kimi retrieval context/);
    assert.equal(duplicate.ok, true);
    assert.match(next.additionalContext, /Kimi retrieval context/);
    assert.equal(requests.length, 2);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Kimi reopens retrieval after an identical prompt turn materializes", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-kimi-retrieval-repeat-"));
  const sessionId = "session-retrieval-repeat";
  const prompt = "Repeat the same Kimi prompt.";
  const wirePath = await writeWire(root, sessionId, prompt, "Repeated Kimi answer.");
  const requests = [];
  const service = createMemoryService({
    memoraxCodeHome: join(root, "memorax-home"),
    env: {
      MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "true",
      MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
      MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
      MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
      MEMORAX_CODE_MEMORAX_API_KEY: "test-key",
      MEMORAX_CODE_MEMORAX_USER_ID: "test-user",
    },
    fetchImpl: async (url, request) => {
      const path = new URL(String(url)).pathname;
      requests.push({ path, body: JSON.parse(request.body) });
      return new Response(JSON.stringify(path.endsWith("/search")
        ? {
          success: true,
          data: {
            task_id: "kimi-retrieval-repeat",
            status: "completed",
            data: [{
              id: "memory-repeat",
              memory: "Repeated Kimi retrieval context.",
              score: 0.9,
              metadata: { memory_type: "core" },
            }],
          },
        }
        : { success: true, data: { task_id: "kimi-writeback-repeat", status: "queued" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  try {
    const promptId = sha256(prompt);
    const first = await service.recordTurnStart({
      version: 1,
      client: "kimi",
      sessionId,
      promptId,
      prompt,
      cwd: TEST_WORKSPACE,
    });
    await service.recordTurnStart({
      version: 1,
      client: "kimi",
      sessionId,
      promptId,
      prompt,
      cwd: TEST_WORKSPACE,
    });
    assert.match(first.additionalContext, /Repeated Kimi retrieval context/);
    assert.equal(requests.filter(({ path }) => path.endsWith("/search")).length, 1);

    assert.deepEqual(await service.writebackTurn({
      version: 1,
      client: "kimi",
      sessionId,
      promptId,
      turnId: "4",
      wirePath,
      cwd: TEST_WORKSPACE,
    }), { ok: true, scheduled: true });
    await service.drain();

    const repeated = await service.recordTurnStart({
      version: 1,
      client: "kimi",
      sessionId,
      promptId,
      prompt,
      cwd: TEST_WORKSPACE,
    });
    assert.match(repeated.additionalContext, /Repeated Kimi retrieval context/);
    assert.equal(requests.filter(({ path }) => path.endsWith("/search")).length, 2);
  } finally {
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Kimi writeback restores exact scope from the current trace after Backend restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-kimi-trace-recovery-"));
  const memoraxCodeHome = join(root, "memorax-home");
  const sessionId = "session-kimi-recovery";
  const prompt = "Recover the Kimi session scope.";
  const wirePath = await writeWire(root, sessionId, prompt, "Recovered Kimi answer.");
  const env = {
    MEMORAX_CODE_HOME: memoraxCodeHome,
    MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
    MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
    MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
    MEMORAX_CODE_MEMORAX_API_KEY: "test-key",
    MEMORAX_CODE_MEMORAX_USER_ID: "test-user",
  };
  const requests = [];
  const fetchImpl = async (url, request) => {
    requests.push({ url: String(url), body: JSON.parse(request.body) });
    return new Response(JSON.stringify({ success: true, data: { task_id: "recovery-task", status: "queued" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const firstService = createMemoryService({ memoraxCodeHome, env, fetchImpl });
    const promptId = sha256(prompt);
    await firstService.recordTurnStart({
      version: 1,
      client: "kimi",
      sessionId,
      promptId,
      prompt,
      cwd: TEST_WORKSPACE,
    });
    firstService.close();

    const restartedService = createMemoryService({ memoraxCodeHome, env, fetchImpl });
    assert.deepEqual(await restartedService.writebackTurn({
      version: 1,
      client: "kimi",
      sessionId,
      promptId,
      turnId: "4",
      wirePath,
    }), { ok: true, scheduled: true });
    await restartedService.drain();
    restartedService.close();
    assert.equal(requests.length, 1);
    assert.match(JSON.stringify(requests[0].body), /Recovered Kimi answer/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function writeWire(root, sessionId, prompt, reply, options = {}) {
  const wirePath = join(root, sessionId, "agents", "main", "wire.jsonl");
  await mkdir(join(root, sessionId, "agents", "main"), { recursive: true });
  await writeFile(wirePath, `${[
    { type: "prompt.accepted", promptId: "native-prompt" },
    { type: "turn.prompt", origin: { kind: "user" }, input: [{ type: "text", text: prompt }] },
    { type: "context.append_loop_event", event: { type: "step.begin", turnId: 4 } },
    { type: "context.append_loop_event", event: { type: "content.part", turnId: 4, part: { type: "think", think: "private" } } },
    { type: "context.append_loop_event", event: { type: "content.part", turnId: 4, part: { type: "text", text: reply } } },
    ...(options.cancelled ? [{ type: "turn.cancel", turnId: 4, reason: "user_cancelled" }] : []),
    { type: "turn.ended", turnId: 4, reason: options.reason ?? "completed" },
  ].map(JSON.stringify).join("\n")}\n`);
  return wirePath;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
