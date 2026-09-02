import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTraeMemoryHookRuntime } from "../../../dist/clients/trae/memory-hook-runtime.js";
import {
  parseSkillReminderCommand,
  parseTurnStartCommand,
  parseWritebackCommand,
} from "../../../dist/memory/hook-command.js";
import { traeTracePaths } from "../../../dist/trace/config.js";

test("Trae Hook commands keep a closed content-authority schema", () => {
  const sessionId = "trae-schema-session";
  const prompt = "  Keep the exact Trae prompt.  ";
  const turnId = traeTurnId(sessionId, prompt);
  const start = {
    version: 1,
    client: "trae",
    sessionId,
    turnId,
    prompt,
    cwd: "/workspace/trae",
    workspaceKind: "project",
  };
  const writeback = {
    version: 1,
    client: "trae",
    sessionId,
    turnId,
    prompt,
    lastAssistantMessage: "  Keep the exact Trae answer.  ",
    cwd: "/workspace/trae",
    workspaceKind: "project",
  };

  assert.deepEqual(parseTurnStartCommand(start), { ok: true, command: start });
  assert.deepEqual(parseWritebackCommand(writeback), { ok: true, command: writeback });
  assert.equal(parseSkillReminderCommand({
    version: 1,
    client: "trae",
    sessionId,
    turnId,
    cwd: "/workspace/trae",
    content: "Use the memorax-code skill when prior work may help.",
    triggers: ["cadence"],
  }).ok, true);

  for (const [name, parser, command] of [
    ["foreign transcript authority", parseTurnStartCommand, { ...start, transcriptPath: "/tmp/session.jsonl" }],
    ["cross-session turn id", parseTurnStartCommand, { ...start, turnId: traeTurnId("other-session", prompt) }],
    ["prompt-mismatched turn id", parseTurnStartCommand, { ...start, prompt: "Different prompt." }],
    ["non-canonical timestamp", parseTurnStartCommand, { ...start, turnId: `${sessionId}:01:${"a".repeat(64)}` }],
    ["missing assistant authority", parseWritebackCommand, { ...writeback, lastAssistantMessage: " " }],
    ["foreign message collection", parseWritebackCommand, { ...writeback, messages: [] }],
    ["foreign reminder transcript", parseSkillReminderCommand, {
      version: 1,
      client: "trae",
      sessionId,
      turnId,
      content: "Do not accept foreign authority.",
      triggers: ["cadence"],
      transcriptPath: "/tmp/session.jsonl",
    }],
  ]) {
    assert.equal(parser(command).ok, false, name);
  }
});

test("Trae runtime writes exact Hook content once for a repeated completed Turn", async () => {
  const fixture = await createFixture("exact-writeback");
  const requests = [];
  const runtime = createTraeMemoryHookRuntime({
    env: configuredEnv(fixture.home, { MEMORAX_CODE_TRAE_TRACE_ENABLED: "false" }),
    fetchImpl: memoraxFetch(requests),
  });
  const prompt = "  Preserve this Trae prompt exactly.  ";
  const assistant = "  Preserve this Trae response exactly.  ";
  const command = turnStart("trae-exact-session", prompt, fixture.workspace);
  try {
    assert.deepEqual(await runtime.recordTurnStart(command), { ok: true });
    const writeback = {
      ...command,
      lastAssistantMessage: assistant,
    };
    assert.deepEqual(await runtime.writeback(writeback), { ok: true, scheduled: true });
    assert.deepEqual(await runtime.writeback(writeback), { ok: true, scheduled: true });
    await waitFor(() => requests.length === 1, "Trae writeback did not settle");
    assert.deepEqual(requests[0].body.messages.map(({ role, content }) => ({ role, content })), [
      { role: "user", content: prompt.trim() },
      { role: "assistant", content: assistant.trim() },
    ]);
    assert.match(requests[0].body.metadata.idempotency_key, /^automatic:trae:/);
  } finally {
    runtime.close();
    await fixture.cleanup();
  }
});

test("Trae runtime interrupts a replaced active Turn without writing it back", async () => {
  const fixture = await createFixture("interrupted");
  const writes = [];
  const runtime = createTraeMemoryHookRuntime({
    env: configuredEnv(fixture.home, { MEMORAX_CODE_TRAE_TRACE_ENABLED: "false" }),
    automaticWriteback: (request) => {
      writes.push(request);
      return { accepted: true };
    },
  });
  const first = turnStart("trae-interrupted-session", "Cancel the first Trae turn.", fixture.workspace, 1_700_000_000_001);
  const second = turnStart("trae-interrupted-session", "Continue with the next Trae turn.", fixture.workspace, 1_700_000_000_002);
  try {
    await runtime.recordTurnStart(first);
    await runtime.recordTurnStart(second);
    assert.equal(runtime.size(), 1);
    assert.deepEqual(await runtime.writeback({
      ...first,
      lastAssistantMessage: "This stale completion must not be retained.",
    }), { ok: true, scheduled: false, reason: "interrupted" });
    assert.deepEqual(await runtime.writeback({
      ...second,
      lastAssistantMessage: "The replacement turn completed.",
    }), { ok: true, scheduled: true });
    assert.deepEqual(writes.map(({ userText, assistantText }) => ({ userText, assistantText })), [{
      userText: second.prompt,
      assistantText: "The replacement turn completed.",
    }]);
  } finally {
    runtime.close();
    await fixture.cleanup();
  }
});

test("Trae runtime preserves interruption authority after coordinator metadata expires", async () => {
  const fixture = await createFixture("expired-interruption");
  const writes = [];
  let now = 1_700_000_000_000;
  const runtime = createTraeMemoryHookRuntime({
    env: configuredEnv(fixture.home, { MEMORAX_CODE_TRAE_TRACE_ENABLED: "false" }),
    automaticWriteback: (request) => {
      writes.push(request);
      return { accepted: true };
    },
    now: () => now,
    ttlMs: 5,
    cleanupIntervalMs: 60_000,
  });
  const first = turnStart("trae-expired-session", "Run a long Trae task.", fixture.workspace, now);
  const second = turnStart("trae-expired-session", "Replace the long Trae task.", fixture.workspace, now + 10);
  try {
    await runtime.recordTurnStart(first);
    now += 10;
    await runtime.recordTurnStart(second);
    assert.deepEqual(await runtime.writeback({
      ...first,
      lastAssistantMessage: "This late completion must remain interrupted.",
    }), { ok: true, scheduled: false, reason: "interrupted" });
    assert.deepEqual(await runtime.writeback({
      ...second,
      lastAssistantMessage: "The replacement completed.",
    }), { ok: true, scheduled: true });
    assert.deepEqual(writes.map(({ userText }) => userText), [second.prompt]);
  } finally {
    runtime.close();
    await fixture.cleanup();
  }
});

test("Trae complete Hook payload restores writeback after Backend runtime restart", async () => {
  const fixture = await createFixture("restart");
  const env = configuredEnv(fixture.home, { MEMORAX_CODE_TRAE_TRACE_ENABLED: "false" });
  const command = turnStart("trae-restart-session", "Persist across a Backend restart.", fixture.workspace);
  const beforeRestart = createTraeMemoryHookRuntime({
    env,
    automaticWriteback: () => ({ accepted: true }),
  });
  await beforeRestart.recordTurnStart(command);
  beforeRestart.close();

  const writes = [];
  const afterRestart = createTraeMemoryHookRuntime({
    env,
    automaticWriteback: (request) => {
      writes.push(request);
      return { accepted: true };
    },
  });
  try {
    assert.deepEqual(await afterRestart.writeback({
      ...command,
      lastAssistantMessage: "The complete Stop payload restored the turn.",
    }), { ok: true, scheduled: true });
    assert.equal(afterRestart.size(), 0);
    assert.deepEqual(writes.map(({ userText, assistantText }) => ({ userText, assistantText })), [{
      userText: command.prompt,
      assistantText: "The complete Stop payload restored the turn.",
    }]);
  } finally {
    afterRestart.close();
    await fixture.cleanup();
  }
});

test("Trae runtime fails closed when a session changes physical workspace", async () => {
  const fixture = await createFixture("scope-mismatch");
  const otherWorkspace = join(fixture.root, "other-workspace");
  await mkdir(otherWorkspace);
  const writes = [];
  const runtime = createTraeMemoryHookRuntime({
    env: configuredEnv(fixture.home, { MEMORAX_CODE_TRAE_TRACE_ENABLED: "false" }),
    automaticWriteback: (request) => {
      writes.push(request);
      return { accepted: true };
    },
  });
  const command = turnStart("trae-scope-session", "Keep the original workspace authority.", fixture.workspace);
  try {
    await runtime.recordTurnStart(command);
    assert.deepEqual(await runtime.writeback({
      ...command,
      cwd: otherWorkspace,
      lastAssistantMessage: "Do not cross the workspace boundary.",
    }), { ok: true, scheduled: false, reason: "workspace_scope_mismatch" });
    assert.equal(writes.length, 0);
  } finally {
    runtime.close();
    await fixture.cleanup();
  }
});

test("Trae trace records interrupted and completed Turn lifecycles", async () => {
  const fixture = await createFixture("trace");
  const sessionId = "trae-trace-session";
  const writes = [];
  const runtime = createTraeMemoryHookRuntime({
    memoraxCodeHome: fixture.home,
    env: configuredEnv(fixture.home),
    automaticWriteback: (request) => {
      writes.push(request);
      return { accepted: true };
    },
  });
  const first = turnStart(sessionId, "Interrupt this Trae turn.", fixture.workspace, 1_700_000_000_011);
  const second = turnStart(sessionId, "Complete this Trae turn.", fixture.workspace, 1_700_000_000_012);
  try {
    await runtime.recordTurnStart(first);
    await runtime.recordTurnStart(second);
    await runtime.writeback({ ...second, lastAssistantMessage: "Trae completed the second turn." });

    const events = (await readFile(traeTracePaths(fixture.home).eventsJsonl(sessionId), "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    assert.deepEqual(events.map(({ type, outcome }) => ({ type, outcome })), [
      { type: "turn_start", outcome: undefined },
      { type: "turn_end", outcome: "interrupted" },
      { type: "turn_start", outcome: undefined },
      { type: "turn_end", outcome: "completed" },
      { type: "turn_materialized", outcome: undefined },
    ]);
    assert.deepEqual(events.map((event) => event.trace.turn_id), [
      first.turnId,
      first.turnId,
      second.turnId,
      second.turnId,
      second.turnId,
    ]);
    assert.equal(events.every((event) => event.trace.client === "trae"), true);
    assert.equal(events.every((event) => event.trace.context_origin === "trae-hook-body"), true);
    assert.equal(writes.length, 1);
    const current = JSON.parse(await readFile(
      traeTracePaths(fixture.home).sessionCurrentTurnPath(sessionId),
      "utf8",
    ));
    assert.equal(current.turn_state, "completed");
    assert.equal(current.trace.turn_id, second.turnId);
  } finally {
    runtime.close();
    await fixture.cleanup();
  }
});

function turnStart(sessionId, prompt, cwd, createdAt = 1_700_000_000_000) {
  return {
    version: 1,
    client: "trae",
    sessionId,
    turnId: traeTurnId(sessionId, prompt, createdAt),
    prompt,
    cwd,
    workspaceKind: "project",
  };
}

function traeTurnId(sessionId, prompt, createdAt = 1_700_000_000_000) {
  const digest = createHash("sha256").update(prompt.trim()).digest("hex");
  return `${sessionId}:${createdAt}:${digest}`;
}

async function createFixture(name) {
  const root = await mkdtemp(join(tmpdir(), `memorax-code-trae-${name}-`));
  const home = join(root, "home");
  const workspace = join(root, "workspace");
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(workspace, { recursive: true }),
  ]);
  return {
    root,
    home,
    workspace,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function configuredEnv(home, overrides = {}) {
  return {
    MEMORAX_CODE_HOME: home,
    MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
    MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
    MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
    MEMORAX_CODE_MEMORAX_API_KEY: "secret",
    MEMORAX_CODE_MEMORAX_USER_ID: "trae-user",
    ...overrides,
  };
}

function memoraxFetch(requests) {
  return async (url, init) => {
    requests.push({ url: String(url), body: JSON.parse(init.body) });
    return new Response(JSON.stringify({
      success: true,
      data: { task_id: `trae-write-${requests.length}`, status: "completed" },
    }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

async function waitFor(predicate, message, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
