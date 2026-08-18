import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createBackendState } from "../../../dist/app/state.js";
import { createBackendServer } from "../../../dist/server.js";
import { clientTracePaths, tracePaths } from "../../../dist/trace/config.js";
import { listen } from "../../support/helpers.mjs";
import {
  memoraxAddFetch,
  waitFor,
  waitForFile,
  withEnv,
  writeRollout,
} from "../../clients/codex/support/memory-hook-fixtures.mjs";

const TEST_WORKSPACE = fileURLToPath(new URL("../../..", import.meta.url));
const TEST_REPO_ROOT = resolve(TEST_WORKSPACE, "../../..");
const GIT_TURN_START_RESULT = { ok: true, repoMemoryWorktree: TEST_REPO_ROOT };
const TEST_MEMORAX_CODE_HOME = join(tmpdir(), `memorax-code-hook-scope-${process.pid}`);
const WRITEBACK_ENV = {
  MEMORAX_CODE_HOME: TEST_MEMORAX_CODE_HOME,
  MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
  MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
  MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
  MEMORAX_CODE_MEMORAX_API_KEY: "secret",
  MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
};

test("Backend memory hook endpoints record and write back a turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-http-rollout-"));
  const transcriptPath = await writeRollout(root, "session-http", [{
    turnId: "turn-http",
    prompt: "HTTP hook prompt.",
    reply: "HTTP hook answer.",
  }]);
  const { fetchImpl, requests } = memoraxAddFetch();
  const restoreEnv = withEnv(WRITEBACK_ENV);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const state = createBackendState();
  const server = createBackendServer(state);
  const url = await listen(server);
  try {
    const start = await originalFetch(`${url}/memory/turn-start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        client: "codex",
        sessionId: "session-http",
        turnId: "turn-http",
        prompt: "HTTP hook prompt.",
        cwd: TEST_WORKSPACE,
        transcriptPath,
      }),
    });
    assert.equal(start.status, 200);
    assert.deepEqual(await start.json(), GIT_TURN_START_RESULT);

    const writeback = await originalFetch(`${url}/memory/writeback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        client: "codex",
        sessionId: "session-http",
        turnId: "turn-http",
        lastAssistantMessage: "HTTP hook answer.",
        transcriptPath,
      }),
    });
    assert.equal(writeback.status, 200);
    assert.deepEqual(await writeback.json(), { ok: true, scheduled: true });
    await waitFor(() => requests.length === 1, "HTTP hook writeback did not call MemoraX add");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    globalThis.fetch = originalFetch;
    restoreEnv();
    await rm(root, { recursive: true, force: true });
  }
});

test("Backend memory hook endpoints reject commands outside the closed schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-http-contract-"));
  const state = createBackendState("127.0.0.1", { sessionHome: root });
  const server = createBackendServer(state);
  const url = await listen(server);
  const codexTurnStart = {
    version: 1,
    client: "codex",
    sessionId: "session-codex-turn-start",
    prompt: "Codex turn start.",
    transcriptPath: "/tmp/codex.jsonl",
  };
  const claudeTurnStart = {
    version: 1,
    client: "claude-code",
    sessionId: "session-claude-turn-start",
    promptId: "prompt-claude-turn-start",
    prompt: "Claude turn start.",
    transcriptPath: "/tmp/claude.jsonl",
  };
  const codexWriteback = {
    version: 1,
    client: "codex",
    sessionId: "session-codex-writeback",
    lastAssistantMessage: "Codex writeback.",
  };
  const claudeWriteback = {
    version: 1,
    client: "claude-code",
    sessionId: "session-claude-writeback",
    promptId: "prompt-claude-writeback",
    lastAssistantMessage: "Claude writeback.",
    transcriptPath: "/tmp/claude.jsonl",
  };
  const openCodeTurnStart = {
    version: 1,
    client: "opencode",
    sessionId: "session-opencode-turn-start",
    userMessageId: "user-opencode-turn-start",
    prompt: "OpenCode turn start.",
  };
  const openCodeWriteback = {
    version: 1,
    client: "opencode",
    sessionId: "session-opencode-writeback",
    userMessageId: "user-opencode-writeback",
    assistantMessageId: "assistant-opencode-writeback",
    messages: [],
  };
  const dshTurnStart = {
    version: 1,
    client: "dsh",
    sessionId: "session-dsh-turn-start",
    turn: 1,
    startSeq: 0,
    cwd: "/workspace/dsh",
    prompt: "DSH turn start.",
  };
  const dshWriteback = {
    version: 1,
    client: "dsh",
    sessionId: "session-dsh-writeback",
    turn: 1,
    startSeq: 0,
    endSeq: 1,
    cwd: "/workspace/dsh",
    sessionHeader: {},
    events: [],
  };
  try {
    for (const [caseName, path, body] of [
      ["unversioned command", "/memory/turn-start", {
        client: "codex",
        sessionId: "session-unversioned",
        prompt: "Old commands must not inherit Codex authority.",
        transcriptPath: "/tmp/codex.jsonl",
      }],
      ["missing client", "/memory/turn-start", {
        version: 1,
        sessionId: "session-clientless",
        prompt: "Client identity is required.",
        transcriptPath: "/tmp/codex.jsonl",
      }],
      ["unsupported version", "/memory/turn-start", {
        version: 2,
        client: "codex",
        sessionId: "session-future",
        prompt: "Unknown versions fail closed.",
        transcriptPath: "/tmp/codex.jsonl",
      }],
      ["unknown client", "/memory/turn-start", {
        version: 1,
        client: "unknown-client",
        sessionId: "session-unknown",
        prompt: "Unknown clients fail closed.",
        transcriptPath: "/tmp/codex.jsonl",
      }],
      ["incomplete Claude writeback", "/memory/writeback", {
        version: 1,
        client: "claude-code",
        sessionId: "session-incomplete-writeback",
        lastAssistantMessage: "Client-specific required fields fail closed.",
        transcriptPath: "/tmp/claude.jsonl",
      }],
      ["unknown Codex turn-start field", "/memory/turn-start", {
        ...codexTurnStart,
        unexpected: true,
      }],
      ["Codex field on Claude turn-start", "/memory/turn-start", {
        ...claudeTurnStart,
        turnId: "wrong-client-field",
      }],
      ["invalid optional Codex turn id", "/memory/turn-start", {
        ...codexTurnStart,
        turnId: 42,
      }],
      ["invalid optional Claude cwd", "/memory/turn-start", {
        ...claudeTurnStart,
        cwd: {},
      }],
      ["unknown snake-case Codex writeback field", "/memory/writeback", {
        ...codexWriteback,
        session_id: codexWriteback.sessionId,
      }],
      ["Claude field on Codex writeback", "/memory/writeback", {
        ...codexWriteback,
        promptId: "wrong-client-field",
      }],
      ["invalid optional Codex transcript path", "/memory/writeback", {
        ...codexWriteback,
        transcriptPath: 42,
      }],
      ["Codex field on Claude writeback", "/memory/writeback", {
        ...claudeWriteback,
        turnId: "wrong-client-field",
      }],
      ["invalid optional Claude workspace kind", "/memory/writeback", {
        ...claudeWriteback,
        workspaceKind: {},
      }],
      ["transcript field on OpenCode turn-start", "/memory/turn-start", {
        ...openCodeTurnStart,
        transcriptPath: "/tmp/opencode.jsonl",
      }],
      ["Hook assistant text on OpenCode writeback", "/memory/writeback", {
        ...openCodeWriteback,
        lastAssistantMessage: "Hook text is not OpenCode writeback authority.",
      }],
      ["invalid OpenCode messages container", "/memory/writeback", {
        ...openCodeWriteback,
        messages: {},
      }],
      ["transcript field on DSH turn-start", "/memory/turn-start", {
        ...dshTurnStart,
        transcriptPath: "/tmp/dsh.jsonl",
      }],
      ["invalid DSH events container", "/memory/writeback", {
        ...dshWriteback,
        events: {},
      }],
      ["invalid DSH event interval", "/memory/writeback", {
        ...dshWriteback,
        endSeq: -1,
      }],
    ]) {
      const response = await fetch(`${url}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400, caseName);
      assert.deepEqual(await response.json(), {
        ok: false,
        error: "invalid memory Hook command",
      }, caseName);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test("Backend memory hook endpoints write client-isolated trace events", async () => {
  const { fetchImpl, requests } = memoraxAddFetch();
  const sessionHome = await mkdtemp(join(tmpdir(), "memorax-code-hook-trace-"));
  const restoreEnv = withEnv({
    ...WRITEBACK_ENV,
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "true",
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_TURNS: "1",
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_AGE_MS: "60000",
    MEMORAX_CODE_HOME: undefined,
    MEMORAX_CODE_CLAUDE_TRACE_ENABLED: undefined,
    MEMORAX_CODE_CODEX_TRACE_ENABLED: undefined,
    MEMORAX_CODE_DSH_TRACE_ENABLED: undefined,
    MEMORAX_CODE_OPENCODE_TRACE_ENABLED: undefined,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const state = createBackendState("127.0.0.1", { sessionHome });
  const server = createBackendServer(state);
  const url = await listen(server);
  const transcriptPath = await writeRollout(sessionHome, "session-trace-hook", [{
    turnId: "turn-trace-hook",
    prompt: "Trace this hook prompt.",
    reply: "Trace this hook answer.",
    toolCalls: [
      'const r = await tools.exec_command({ cmd: "sed -n \'1,240p\' /Users/test/.codex/plugins/cache/memorax-code/memorax-code-codex-adapter/0.1.11/skills/memorax-code/references/repo-read.md" });',
      'const r = await tools.exec_command({ cmd: "memorax-cli search --query \\"trace ordering\\"" });',
    ],
    tokenUsage: {
      input_tokens: 120,
      cached_input_tokens: 80,
      cache_write_input_tokens: 0,
      output_tokens: 20,
      reasoning_output_tokens: 5,
      total_tokens: 140,
    },
  }]);
  try {
    const start = await originalFetch(`${url}/memory/turn-start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        client: "codex",
        sessionId: "session-trace-hook",
        turnId: "turn-trace-hook",
        prompt: "Trace this hook prompt.",
        cwd: TEST_WORKSPACE,
        transcriptPath,
      }),
    });
    assert.equal(start.status, 200);

    await waitForFile(tracePaths(sessionHome).currentTurnPath, /session-trace-hook/, "current turn trace was not written");
    const currentTurn = JSON.parse(await readFile(tracePaths(sessionHome).currentTurnPath, "utf8"));
    assert.equal(currentTurn.turn_state, "open");
    assert.equal(currentTurn.trace.session_id, "session-trace-hook");
    assert.equal(currentTurn.trace.turn_id, "turn-trace-hook");
    assert.equal(currentTurn.trace.context_origin, "codex-hook-body");

    const scopedCurrentPath = tracePaths(sessionHome).sessionCurrentTurnPath("session-trace-hook");
    await waitForFile(scopedCurrentPath, /session-trace-hook/, "session current turn trace was not written");
    const scopedCurrentTurn = JSON.parse(await readFile(scopedCurrentPath, "utf8"));
    assert.equal(scopedCurrentTurn.turn_state, "open");
    assert.equal(scopedCurrentTurn.trace.session_id, "session-trace-hook");
    assert.equal(scopedCurrentTurn.trace.turn_id, "turn-trace-hook");
    assert.equal(scopedCurrentTurn.trace.context_origin, "codex-hook-body");

    const reminder = await originalFetch(`${url}/memory/skill-reminder`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        client: "codex",
        sessionId: "session-trace-hook",
        turnId: "turn-trace-hook",
        transcriptPath,
        content: "MemoraX Code reminder: use the skill when prior work could help.",
        triggers: ["cadence", "post_compaction"],
      }),
    });
    assert.equal(reminder.status, 200);
    assert.deepEqual(await reminder.json(), { ok: true });

    const unversionedReminder = await originalFetch(`${url}/memory/skill-reminder`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client: "codex",
        sessionId: "session-trace-hook",
        turnId: "turn-trace-hook",
        transcriptPath,
        content: "Unversioned reminder commands must not be recorded.",
        triggers: ["cadence"],
      }),
    });
    assert.equal(unversionedReminder.status, 200);
    assert.deepEqual(await unversionedReminder.json(), { ok: true });

    const mismatchedClaudeReminder = await originalFetch(`${url}/memory/skill-reminder`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        client: "claude-code",
        sessionId: "session-trace-hook",
        turnId: "turn-trace-hook",
        transcriptPath,
        content: "Claude reminder commands must use promptId.",
        triggers: ["cadence"],
      }),
    });
    assert.equal(mismatchedClaudeReminder.status, 200);
    assert.deepEqual(await mismatchedClaudeReminder.json(), { ok: true });

    const claudeReminder = await originalFetch(`${url}/memory/skill-reminder`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        client: "claude-code",
        sessionId: "session-trace-hook",
        promptId: "turn-trace-hook",
        transcriptPath,
        cwd: TEST_WORKSPACE,
        workspaceKind: "project",
        content: "MemoraX Code reminder: use the skill in Claude when prior work could help.",
        triggers: ["cadence"],
      }),
    });
    assert.equal(claudeReminder.status, 200);
    assert.deepEqual(await claudeReminder.json(), { ok: true });

    const dshReminder = await originalFetch(`${url}/memory/skill-reminder`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        client: "dsh",
        sessionId: "session-trace-hook",
        turn: 1,
        cwd: TEST_WORKSPACE,
        content: "MemoraX Code reminder: use /memorax-code when prior work could help.",
        triggers: ["cadence"],
      }),
    });
    assert.equal(dshReminder.status, 200);
    assert.deepEqual(await dshReminder.json(), { ok: true });

    const dshReminderWithTranscript = await originalFetch(`${url}/memory/skill-reminder`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        client: "dsh",
        sessionId: "session-trace-hook",
        turn: 1,
        cwd: TEST_WORKSPACE,
        transcriptPath,
        content: "DSH reminder commands must not invent transcript authority.",
        triggers: ["cadence"],
      }),
    });
    assert.equal(dshReminderWithTranscript.status, 200);
    assert.deepEqual(await dshReminderWithTranscript.json(), { ok: true });

    const mismatchedOpenCodeReminder = await originalFetch(`${url}/memory/skill-reminder`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        client: "opencode",
        sessionId: "session-trace-hook",
        turnId: "turn-trace-hook",
        transcriptPath,
        content: "OpenCode reminder commands must use userMessageId.",
        triggers: ["post_compaction"],
      }),
    });
    assert.equal(mismatchedOpenCodeReminder.status, 200);
    assert.deepEqual(await mismatchedOpenCodeReminder.json(), { ok: true });

    const openCodeReminder = await originalFetch(`${url}/memory/skill-reminder`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        client: "opencode",
        sessionId: "session-trace-hook",
        userMessageId: "turn-trace-hook",
        cwd: TEST_WORKSPACE,
        workspaceKind: "project",
        content: "MemoraX Code reminder: use the memorax-code skill in OpenCode.",
        triggers: ["post_compaction"],
      }),
    });
    assert.equal(openCodeReminder.status, 200);
    assert.deepEqual(await openCodeReminder.json(), { ok: true });

    const writeback = await originalFetch(`${url}/memory/writeback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        client: "codex",
        sessionId: "session-trace-hook",
        turnId: "turn-trace-hook",
        lastAssistantMessage: "Trace this hook answer.",
        transcriptPath,
      }),
    });
    assert.equal(writeback.status, 200);
    await waitFor(() => requests.length === 1, "HTTP hook writeback did not call MemoraX add");

    const completedCurrentTurn = JSON.parse(await readFile(tracePaths(sessionHome).currentTurnPath, "utf8"));
    const completedScopedTurn = JSON.parse(await readFile(scopedCurrentPath, "utf8"));
    assert.equal(completedCurrentTurn.turn_state, "completed");
    assert.equal(completedScopedTurn.turn_state, "completed");
    assert.equal(completedCurrentTurn.trace.turn_id, "turn-trace-hook");
    assert.equal(completedScopedTurn.trace.turn_id, "turn-trace-hook");

    const eventsPath = tracePaths(sessionHome).eventsJsonl("session-trace-hook");
    await waitForFile(eventsPath, /memory_writeback/, "trace events were not written");
    const events = (await readFile(eventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events[0].type, "turn_start");
    assert.equal(events[0].trace.context_origin, "codex-hook-body");
    assert.deepEqual(events.slice(0, 3).map((event) => event.type), ["turn_start", "skill_reminder", "turn_end"]);
    const skillReminder = events[1];
    assert.equal(skillReminder.source, "codex-hook");
    assert.equal(skillReminder.operation, "reminder");
    assert.equal(skillReminder.trace.client, "codex");
    assert.deepEqual(skillReminder.request.triggers, ["cadence", "post_compaction"]);
    assert.deepEqual(skillReminder.response, {
      role: "developer",
      content: "MemoraX Code reminder: use the skill when prior work could help.",
    });
    assert.equal(events.filter((event) => event.type === "skill_reminder").length, 1);

    const claudeEventsPath = clientTracePaths("claude", sessionHome).eventsJsonl("session-trace-hook");
    await waitForFile(claudeEventsPath, /skill_reminder/, "Claude reminder trace event was not written");
    const claudeEvents = (await readFile(claudeEventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(claudeEvents.length, 1);
    assert.equal(claudeEvents[0].type, "skill_reminder");
    assert.equal(claudeEvents[0].source, "claude-hook");
    assert.equal(claudeEvents[0].operation, "reminder");
    assert.equal(claudeEvents[0].trace.client, "claude");
    assert.equal(claudeEvents[0].trace.session_id, "session-trace-hook");
    assert.equal(claudeEvents[0].trace.turn_id, "turn-trace-hook");
    assert.equal(claudeEvents[0].trace.context_origin, "claude-hook-body");
    assert.deepEqual(claudeEvents[0].request.triggers, ["cadence"]);
    assert.deepEqual(claudeEvents[0].response, {
      role: "developer",
      content: "MemoraX Code reminder: use the skill in Claude when prior work could help.",
    });
    const dshEventsPath = clientTracePaths("dsh", sessionHome).eventsJsonl("session-trace-hook");
    await waitForFile(dshEventsPath, /skill_reminder/, "DSH reminder trace event was not written");
    const dshEvents = (await readFile(dshEventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(dshEvents.length, 1);
    assert.equal(dshEvents[0].type, "skill_reminder");
    assert.equal(dshEvents[0].source, "dsh-cordis");
    assert.equal(dshEvents[0].operation, "reminder");
    assert.equal(dshEvents[0].trace.client, "dsh");
    assert.equal(dshEvents[0].trace.session_id, "session-trace-hook");
    assert.equal(dshEvents[0].trace.turn_id, "1");
    assert.equal(dshEvents[0].trace.context_origin, "dsh-cordis-reminder");
    assert.deepEqual(dshEvents[0].request.triggers, ["cadence"]);
    assert.deepEqual(dshEvents[0].response, {
      role: "user",
      content: "MemoraX Code reminder: use /memorax-code when prior work could help.",
    });
    const openCodeEventsPath = clientTracePaths("opencode", sessionHome).eventsJsonl("session-trace-hook");
    await waitForFile(openCodeEventsPath, /skill_reminder/, "OpenCode reminder trace event was not written");
    const openCodeEvents = (await readFile(openCodeEventsPath, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(openCodeEvents.length, 1);
    assert.equal(openCodeEvents[0].type, "skill_reminder");
    assert.equal(openCodeEvents[0].source, "opencode-plugin");
    assert.equal(openCodeEvents[0].operation, "reminder");
    assert.equal(openCodeEvents[0].trace.client, "opencode");
    assert.equal(openCodeEvents[0].trace.session_id, "session-trace-hook");
    assert.equal(openCodeEvents[0].trace.turn_id, "turn-trace-hook");
    assert.equal(openCodeEvents[0].trace.context_origin, "opencode-hook-body");
    assert.equal(openCodeEvents[0].trace.transcript_path, undefined);
    assert.deepEqual(openCodeEvents[0].request.triggers, ["post_compaction"]);
    assert.deepEqual(openCodeEvents[0].response, {
      role: "developer",
      content: "MemoraX Code reminder: use the memorax-code skill in OpenCode.",
    });
    const turnEnd = events.find((event) => event.type === "turn_end");
    assert.equal(turnEnd.source, "codex-hook");
    assert.equal(turnEnd.trace.session_id, "session-trace-hook");
    assert.equal(turnEnd.trace.turn_id, "turn-trace-hook");
    assert.equal(turnEnd.trace.transcript_path, transcriptPath);
    assert.equal(turnEnd.response.assistantMessage, "Trace this hook answer.");
    assert.deepEqual(turnEnd.usage, {
      input_tokens: 120,
      cached_input_tokens: 80,
      cache_write_input_tokens: 0,
      output_tokens: 20,
      reasoning_output_tokens: 5,
      total_tokens: 140,
    });
    assert.deepEqual(turnEnd.activities, [
      { index: 1, type: "repo_memory_operation", operation: "repo-read" },
      { index: 2, type: "memory_cli_search" },
    ]);
    const writebackEvent = events.find((event) => event.type === "memory_writeback");
    assert.equal(writebackEvent.source, "codex_hook_writeback");
    assert.equal(writebackEvent.trace.session_id, "session-trace-hook");
    assert.equal(writebackEvent.trace.turn_id, undefined);
    assert.deepEqual(writebackEvent.related_turns.map((turn) => turn.turn_id), ["turn-trace-hook"]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    globalThis.fetch = originalFetch;
    restoreEnv();
    await rm(sessionHome, { recursive: true, force: true });
  }
});

test("Backend memory hook endpoints keep working when Codex trace is disabled", async () => {
  const { fetchImpl, requests } = memoraxAddFetch();
  const sessionHome = await mkdtemp(join(tmpdir(), "memorax-code-hook-trace-disabled-"));
  await writeFile(join(sessionHome, "config.toml"), [
    "[trace.codex]",
    "enabled = false",
    "",
  ].join("\n"), "utf8");
  const restoreEnv = withEnv({
    ...WRITEBACK_ENV,
    MEMORAX_CODE_HOME: undefined,
    MEMORAX_CODE_CODEX_TRACE_ENABLED: undefined,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const state = createBackendState("127.0.0.1", { sessionHome });
  const server = createBackendServer(state);
  const url = await listen(server);
  const transcriptPath = await writeRollout(sessionHome, "session-trace-disabled", [{
    turnId: "turn-trace-disabled",
    prompt: "Trace disabled prompt.",
    reply: "Trace disabled answer.",
  }]);
  try {
    await originalFetch(`${url}/memory/turn-start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        client: "codex",
        sessionId: "session-trace-disabled",
        turnId: "turn-trace-disabled",
        prompt: "Trace disabled prompt.",
        cwd: TEST_WORKSPACE,
        transcriptPath,
      }),
    });
    const writeback = await originalFetch(`${url}/memory/writeback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        version: 1,
        client: "codex",
        sessionId: "session-trace-disabled",
        turnId: "turn-trace-disabled",
        lastAssistantMessage: "Trace disabled answer.",
        transcriptPath,
      }),
    });
    assert.equal(writeback.status, 200);
    assert.deepEqual(await writeback.json(), { ok: true, scheduled: true });
    await waitFor(() => requests.length === 1, "disabled trace hook writeback did not call MemoraX add");
    await assert.rejects(readFile(tracePaths(sessionHome).currentTurnPath, "utf8"));
    await assert.rejects(readFile(tracePaths(sessionHome).eventsJsonl("session-trace-disabled"), "utf8"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    globalThis.fetch = originalFetch;
    restoreEnv();
    await rm(sessionHome, { recursive: true, force: true });
  }
});
