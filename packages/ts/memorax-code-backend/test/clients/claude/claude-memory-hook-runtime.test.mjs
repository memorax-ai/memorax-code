import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createClaudeMemoryHookRuntime } from "../../../dist/clients/claude/memory-hook-runtime.js";
import { claudeTracePaths } from "../../../dist/trace/config.js";
import { readOpenClaudeTurn } from "../../../dist/trace/store.js";

const SESSION_ID = "session-claude-hook";
const PROMPT_ID = "prompt-claude-hook";
const TRACE_DISABLED_ENV = { MEMORAX_CODE_CLAUDE_TRACE_ENABLED: "false" };
const SCOPE = {
  schemaVersion: "workspace-memory-scope.v1",
  baseUserId: "user-1",
  effectiveUserId: "user-1@claude-hook",
  repositoryKey: "key:claude-hook",
  repositorySlug: "claude-hook",
  repositoryName: "claude-hook",
  identitySource: "workspace-directory",
  scopeKind: "local-directory",
  boundWorkspaceRoot: "/workspace/claude-hook",
};
const GIT_SCOPE = {
  ...SCOPE,
  identitySource: "git-common-dir",
  scopeKind: "git-repository",
  boundWorkspaceRoot: "/workspace/claude-git-worktree",
};

test("Claude Hook returns the Backend-authorized Git worktree", async () => {
  const runtime = createClaudeMemoryHookRuntime({
    automaticWriteback: () => ({ accepted: true }),
    env: {
      ...TRACE_DISABLED_ENV,
      MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
    },
    repositoryMemorySession: repositoryRuntime({}, GIT_SCOPE),
  });
  try {
    assert.deepEqual(
      await runtime.recordTurnStart(turnStart("/tmp/claude-git-transcript.jsonl")),
      { ok: true, repoMemoryWorktree: GIT_SCOPE.boundWorkspaceRoot },
    );
  } finally {
    runtime.close();
  }
});

test("Claude Hook writeback uses exact transcript content", async () => {
  const fixture = await transcriptFixture("Materialized prompt.", "Materialized answer.");
  const writebacks = [];
  const diagnostics = [];
  const runtime = createClaudeMemoryHookRuntime({
    automaticWriteback: collectAcceptedWriteback(writebacks),
    diagnosticLogger: (event, fields) => diagnostics.push({ event, fields }),
    env: TRACE_DISABLED_ENV,
    repositoryMemorySession: repositoryRuntime(),
    transcriptReadAttempts: 1,
  });
  try {
    await runtime.recordTurnStart(turnStart(fixture.path));
    const result = await runtime.writeback({
      version: 1,
      client: "claude-code",
      sessionId: SESSION_ID,
      promptId: PROMPT_ID,
      transcriptPath: fixture.path,
      cwd: "/workspace/claude-hook",
      lastAssistantMessage: "Hook text is diagnostic only.",
    });

    assert.deepEqual(result, { ok: true, scheduled: true });
    assert.equal(writebacks.length, 1);
    assert.equal(writebacks[0].userText, "Materialized prompt.");
    assert.equal(writebacks[0].assistantText, "Materialized answer.");
    assert.equal(writebacks[0].client, "claude-code");
    assert.equal(writebacks[0].memoryObservabilitySource, "claude_hook_writeback");
    assert.equal(writebacks[0].repositoryScope, SCOPE);
    assert.equal(writebacks[0].traceContext.client, "claude");
    assert.equal(writebacks[0].traceContext.sessionId, SESSION_ID);
    assert.equal(writebacks[0].traceContext.turnId, PROMPT_ID);
    assert.equal(writebacks[0].traceContext.transcriptPath, fixture.path);
    assert.equal(writebacks[0].traceContext.contextOrigin, "claude-hook-body");
    assert.equal(diagnostics.some(({ event }) => event === "claude_memory_hook.assistant_message_mismatch"), true);
  } finally {
    runtime.close();
    await fixture.remove();
  }
});

test("Claude Hook uses repaired Git scope for same-session automatic writeback", async () => {
  const fixture = await transcriptFixture("Repair the Git metadata.", "Git metadata repaired.");
  const degradedScope = {
    ...SCOPE,
    fallbackReason: "git_metadata_invalid",
  };
  const repairedScope = {
    ...SCOPE,
    repositoryKey: "git-key:claude-hook",
    identitySource: "origin-remote",
    scopeKind: "git-repository",
  };
  let currentScope = degradedScope;
  const writebacks = [];
  const runtime = createClaudeMemoryHookRuntime({
    automaticWriteback: collectAcceptedWriteback(writebacks),
    env: TRACE_DISABLED_ENV,
    repositoryMemorySession: {
      async resolve() {
        return { ok: true, memory: { config: {}, scope: currentScope } };
      },
      close() {},
    },
    transcriptReadAttempts: 1,
  });
  try {
    await runtime.recordTurnStart(turnStart(fixture.path));
    currentScope = repairedScope;
    assert.deepEqual(await runtime.writeback({
      version: 1,
      client: "claude-code",
      sessionId: SESSION_ID,
      promptId: PROMPT_ID,
      transcriptPath: fixture.path,
      cwd: "/workspace/claude-hook",
      lastAssistantMessage: "Git metadata repaired.",
    }), { ok: true, scheduled: true });
    assert.equal(writebacks.length, 1);
    assert.strictEqual(writebacks[0].repositoryScope, repairedScope);
  } finally {
    runtime.close();
    await fixture.remove();
  }
});

test("Claude Hook writeback never falls back to an active or latest prompt", async () => {
  const first = await transcriptFixture("First prompt.", "First answer.", { promptId: "prompt-first" });
  const second = await transcriptFixture("Second prompt.", "Second answer.", { promptId: "prompt-second" });
  const writebacks = [];
  const runtime = createClaudeMemoryHookRuntime({
    automaticWriteback: collectAcceptedWriteback(writebacks),
    env: TRACE_DISABLED_ENV,
    repositoryMemorySession: repositoryRuntime(),
    transcriptReadAttempts: 1,
  });
  try {
    await runtime.recordTurnStart(turnStart(first.path, "prompt-first"));
    await runtime.recordTurnStart(turnStart(second.path, "prompt-second"));
    assert.deepEqual(await runtime.writeback({
      version: 1,
      client: "claude-code",
      sessionId: SESSION_ID,
      transcriptPath: second.path,
      lastAssistantMessage: "Second answer.",
    }), { ok: true, scheduled: false, reason: "prompt_id_missing" });
    assert.deepEqual(await runtime.writeback({
      version: 1,
      client: "claude-code",
      sessionId: SESSION_ID,
      promptId: "prompt-unknown",
      transcriptPath: second.path,
      lastAssistantMessage: "Second answer.",
    }), { ok: true, scheduled: false, reason: "turn_not_found" });
    assert.equal(writebacks.length, 0);
    assert.equal(runtime.size(), 2);
  } finally {
    runtime.close();
    await first.remove();
    await second.remove();
  }
});

test("Claude transcript authority survives coordinator metadata expiry", async () => {
  const fixture = await transcriptFixture("Long-running prompt.", "Long-running answer.");
  let now = 100;
  const writebacks = [];
  const runtime = createClaudeMemoryHookRuntime({
    automaticWriteback: collectAcceptedWriteback(writebacks),
    env: TRACE_DISABLED_ENV,
    repositoryMemorySession: repositoryRuntime(),
    now: () => now,
    ttlMs: 10,
    transcriptReadAttempts: 1,
  });
  try {
    await runtime.recordTurnStart(turnStart(fixture.path));
    now += 11;
    const result = await runtime.writeback({
      version: 1,
      client: "claude-code",
      sessionId: SESSION_ID,
      promptId: PROMPT_ID,
      transcriptPath: fixture.path,
      cwd: "/workspace/claude-hook",
      lastAssistantMessage: "Long-running answer.",
    });
    assert.deepEqual(result, { ok: true, scheduled: true });
    assert.equal(writebacks[0].userText, "Long-running prompt.");
    assert.equal(writebacks[0].assistantText, "Long-running answer.");
  } finally {
    runtime.close();
    await fixture.remove();
  }
});

test("Claude Hook writeback performs a bounded retry for transcript materialization", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-hook-retry-"));
  const path = join(root, "transcript.jsonl");
  const user = userRecord("Retry prompt.");
  await writeFile(path, `${JSON.stringify(user)}\n`);
  const writebacks = [];
  const runtime = createClaudeMemoryHookRuntime({
    automaticWriteback: collectAcceptedWriteback(writebacks),
    env: TRACE_DISABLED_ENV,
    repositoryMemorySession: repositoryRuntime(),
    transcriptReadAttempts: 3,
    transcriptRetryDelayMs: 20,
  });
  try {
    await runtime.recordTurnStart(turnStart(path));
    setTimeout(() => {
      void writeFile(path, [
        JSON.stringify(user),
        JSON.stringify(assistantRecord("Retry answer.")),
        "",
      ].join("\n"));
    }, 5);
    const result = await runtime.writeback({
      version: 1,
      client: "claude-code",
      sessionId: SESSION_ID,
      promptId: PROMPT_ID,
      transcriptPath: path,
      cwd: "/workspace/claude-hook",
      lastAssistantMessage: "Retry answer.",
    });
    assert.deepEqual(result, { ok: true, scheduled: true });
    assert.equal(writebacks[0].assistantText, "Retry answer.");
  } finally {
    runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude Hook keeps turn-start scope until a late transcript writeback is accepted", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-hook-late-transcript-"));
  const path = join(root, "transcript.jsonl");
  const user = userRecord("Late transcript prompt.");
  await writeFile(path, `${JSON.stringify(user)}\n`);
  let currentScope = SCOPE;
  let writebackEnabled = false;
  const writebacks = [];
  const runtime = createClaudeMemoryHookRuntime({
    automaticWriteback(options) {
      if (!writebackEnabled) return { accepted: false, reason: "disabled" };
      writebacks.push(options);
      return { accepted: true };
    },
    env: TRACE_DISABLED_ENV,
    repositoryMemorySession: {
      async resolve() {
        return { ok: true, memory: { config: {}, scope: currentScope } };
      },
      close() {},
    },
    transcriptReadAttempts: 1,
  });
  const writeback = {
    version: 1,
    client: "claude-code",
    sessionId: SESSION_ID,
    promptId: PROMPT_ID,
    transcriptPath: path,
    cwd: "/workspace/claude-hook",
    lastAssistantMessage: "Late transcript answer.",
  };
  try {
    await runtime.recordTurnStart(turnStart(path));
    assert.deepEqual(await runtime.writeback(writeback), {
      ok: true,
      scheduled: false,
      reason: "assistant_message_missing",
    });
    assert.equal(runtime.size(), 1);

    await writeFile(path, [
      JSON.stringify(user),
      JSON.stringify(assistantRecord("Late transcript answer.")),
      "",
    ].join("\n"));
    assert.deepEqual(await runtime.writeback(writeback), {
      ok: true,
      scheduled: false,
      reason: "disabled",
    });
    assert.equal(runtime.size(), 1);

    writebackEnabled = true;
    currentScope = {
      ...SCOPE,
      baseUserId: "user-2",
      effectiveUserId: "user-2@claude-hook",
    };
    assert.deepEqual(await runtime.writeback(writeback), {
      ok: true,
      scheduled: false,
      reason: "workspace_scope_mismatch",
    });
    assert.equal(runtime.size(), 1);
    assert.equal(writebacks.length, 0);

    currentScope = SCOPE;
    assert.deepEqual(await runtime.writeback(writeback), { ok: true, scheduled: true });
    assert.equal(runtime.size(), 0);
    assert.equal(writebacks.length, 1);
    assert.equal(writebacks[0].repositoryScope, SCOPE);
  } finally {
    runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude Hooks persist the same immediate trace lifecycle as Codex Hooks", async () => {
  const assistantRecords = completedAssistantRecords("Trace transcript answer.");
  const fixture = await transcriptFixture("Trace prompt.", "Trace transcript answer.", {
    assistantRecords,
  });
  const writebacks = [];
  const runtime = createClaudeMemoryHookRuntime({
    automaticWriteback: collectAcceptedWriteback(writebacks),
    env: {
      MEMORAX_CODE_CLAUDE_TRACE_ENABLED: "true",
      MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
    },
    memoraxCodeHome: fixture.root,
    repositoryMemorySession: repositoryRuntime(),
    transcriptReadAttempts: 1,
  });
  try {
    await runtime.recordTurnStart(turnStart(fixture.path));

    const paths = claudeTracePaths(fixture.root);
    const trace = JSON.parse(await readFile(paths.traceJson(SESSION_ID), "utf8"));
    assert.equal(trace.client, "claude");
    assert.equal(trace.claude.transcript_path, fixture.path);
    const open = await readOpenClaudeTurn({
      memoraxCodeHome: fixture.root,
      expectedSessionId: SESSION_ID,
      allowStale: true,
    });
    assert.equal(open.ok, true);
    assert.equal(open.traceContext.turnId, PROMPT_ID);

    assert.deepEqual(await runtime.writeback({
      version: 1,
      client: "claude-code",
      sessionId: SESSION_ID,
      promptId: PROMPT_ID,
      transcriptPath: fixture.path,
      cwd: "/workspace/claude-hook",
      lastAssistantMessage: "Trace Hook answer.",
    }), { ok: true, scheduled: true });

    const events = (await readFile(paths.eventsJsonl(SESSION_ID), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.type), ["turn_start", "turn_end"]);
    assert.equal(events[0].trace.client, "claude");
    assert.equal(events[0].trace.turn_id, PROMPT_ID);
    assert.equal(events[0].trace.context_origin, "claude-hook-body");
    assert.equal(events[0].request.prompt, "Hook prompt.");
    assert.equal(events[1].source, "claude-hook");
    assert.equal(events[1].outcome, "completed");
    assert.equal(events[1].response.assistantMessage, "Trace Hook answer.");
    assert.equal(events[1].session_turn_index, 1);
    assert.deepEqual(events[1].activities, [{ index: 1, type: "memory_cli_search" }]);
    assert.deepEqual(events[1].usage, expectedCompletedUsage());
    assert.deepEqual(await readOpenClaudeTurn({
      memoraxCodeHome: fixture.root,
      expectedSessionId: SESSION_ID,
      allowStale: true,
    }), {
      ok: false,
      reason: "closed",
      outcome: "completed",
    });
    assert.equal(writebacks[0].assistantText, "Trace transcript answer.");
    assert.equal(writebacks[0].traceContext.turnId, PROMPT_ID);
  } finally {
    runtime.close();
    await fixture.remove();
  }
});

test("Claude next prompt restores an interrupted trace after runtime restart without writeback", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-hook-interrupted-"));
  const transcriptPath = join(root, "transcript.jsonl");
  const firstPromptId = "prompt-interrupted";
  const secondPromptId = "prompt-after-interruption";
  const firstUser = {
    ...userRecord("Investigate before interruption.", firstPromptId),
    uuid: "user-interrupted",
  };
  await writeFile(transcriptPath, `${JSON.stringify(firstUser)}\n`);
  const env = {
    MEMORAX_CODE_CLAUDE_TRACE_ENABLED: "true",
    MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
  };
  const writebacks = [];
  const firstRuntime = createClaudeMemoryHookRuntime({
    automaticWriteback: collectAcceptedWriteback(writebacks),
    env,
    memoraxCodeHome: root,
    repositoryMemorySession: repositoryRuntime(),
    transcriptReadAttempts: 1,
  });
  await firstRuntime.recordTurnStart(turnStart(transcriptPath, firstPromptId));
  firstRuntime.close();

  await writeFile(transcriptPath, [
    JSON.stringify(firstUser),
    JSON.stringify({
      parentUuid: "user-interrupted",
      isSidechain: false,
      type: "assistant",
      message: {
        id: "message-interrupted",
        role: "assistant",
        content: [
          { type: "text", text: "Partial Claude response." },
          {
            type: "tool_use",
            id: "tool-memory-search",
            name: "Bash",
            input: { command: "memorax-cli search --query 'interrupted context'" },
          },
        ],
        stop_reason: null,
        usage: {
          input_tokens: 12,
          cache_creation_input_tokens: null,
          cache_read_input_tokens: null,
          output_tokens: 3,
          cache_creation: null,
          server_tool_use: null,
        },
      },
      uuid: "assistant-interrupted",
      sessionId: SESSION_ID,
    }),
    JSON.stringify({
      ...userRecord("Interrupted by the user.", firstPromptId),
      parentUuid: "assistant-interrupted",
      uuid: "interruption-marker",
      interruptedMessageId: "message-not-required-for-resolution",
      timestamp: "2026-07-25T08:15:30.000Z",
    }),
    JSON.stringify({
      ...userRecord("Continue after interruption.", secondPromptId),
      parentUuid: "interruption-marker",
      uuid: "user-after-interruption",
    }),
    "",
  ].join("\n"));

  const diagnostics = [];
  const secondRuntime = createClaudeMemoryHookRuntime({
    automaticWriteback: collectAcceptedWriteback(writebacks),
    diagnosticLogger: (event, fields) => diagnostics.push({ event, fields }),
    env,
    memoraxCodeHome: root,
    repositoryMemorySession: repositoryRuntime(),
    transcriptReadAttempts: 1,
  });
  try {
    assert.deepEqual(
      await secondRuntime.recordTurnStart(turnStart(transcriptPath, secondPromptId)),
      { ok: true },
    );

    const events = (await readFile(claudeTracePaths(root).eventsJsonl(SESSION_ID), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.type), [
      "turn_start",
      "turn_end",
      "turn_start",
    ]);
    assert.equal(events[1].source, "claude-transcript");
    assert.equal(events[1].outcome, "interrupted");
    assert.equal(events[1].timestamp, "2026-07-25T08:15:30.000Z");
    assert.equal(events[1].trace.turn_id, firstPromptId);
    assert.equal(events[1].session_turn_index, 1);
    assert.equal(events[1].request.prompt, "Investigate before interruption.");
    assert.equal(events[1].response.assistantMessage, "Partial Claude response.");
    assert.deepEqual(events[1].activities, [{ index: 1, type: "memory_cli_search" }]);
    assert.deepEqual(events[1].usage, {
      input_tokens: 12,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: 3,
      cache_creation: {
        ephemeral_1h_input_tokens: 0,
        ephemeral_5m_input_tokens: 0,
      },
      server_tool_use: {
        web_search_requests: 0,
        web_fetch_requests: 0,
      },
    });
    const open = await readOpenClaudeTurn({
      memoraxCodeHome: root,
      expectedSessionId: SESSION_ID,
      allowStale: true,
    });
    assert.equal(open.ok, true);
    assert.equal(open.traceContext.turnId, secondPromptId);
    assert.equal(writebacks.length, 0);
    assert.equal(
      diagnostics.some(({ event }) => event === "claude_memory_hook.interrupted_turn_reconciled"),
      true,
    );
  } finally {
    secondRuntime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude Stop closes trace even when exact transcript validation blocks writeback", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-hook-trace-failure-"));
  const transcriptPath = join(root, "missing-transcript.jsonl");
  const writebacks = [];
  const runtime = createClaudeMemoryHookRuntime({
    automaticWriteback: collectAcceptedWriteback(writebacks),
    env: { MEMORAX_CODE_CLAUDE_TRACE_ENABLED: "true" },
    memoraxCodeHome: root,
    repositoryMemorySession: repositoryRuntime(),
    transcriptReadAttempts: 1,
  });
  try {
    await runtime.recordTurnStart(turnStart(transcriptPath));
    assert.deepEqual(await runtime.writeback({
      version: 1,
      client: "claude-code",
      sessionId: SESSION_ID,
      promptId: PROMPT_ID,
      transcriptPath,
      lastAssistantMessage: "Hook completion remains trace evidence.",
    }), { ok: true, scheduled: false, reason: "transcript_unavailable" });

    const events = (await readFile(claudeTracePaths(root).eventsJsonl(SESSION_ID), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.type), ["turn_start", "turn_end"]);
    assert.equal(events[1].response.assistantMessage, "Hook completion remains trace evidence.");
    assert.equal(events[1].session_turn_index, undefined);
    assert.equal(events[1].activities, undefined);
    assert.equal(events[1].usage, undefined);
    assert.deepEqual(await readOpenClaudeTurn({
      memoraxCodeHome: root,
      expectedSessionId: SESSION_ID,
      allowStale: true,
    }), {
      ok: false,
      reason: "closed",
      outcome: "completed",
    });
    assert.equal(writebacks.length, 0);
  } finally {
    runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude trace write failures do not block retrieval or exact-transcript writeback", async () => {
  const fixture = await transcriptFixture("Fail-open prompt.", "Fail-open answer.");
  const blockerRoot = await mkdtemp(join(tmpdir(), "memorax-code-claude-hook-trace-blocker-"));
  await writeFile(join(blockerRoot, "debug"), "not a directory", "utf8");
  const writebacks = [];
  const diagnostics = [];
  const runtime = createClaudeMemoryHookRuntime({
    automaticWriteback: collectAcceptedWriteback(writebacks),
    diagnosticLogger: (event, fields) => diagnostics.push({ event, fields }),
    env: {
      MEMORAX_CODE_CLAUDE_TRACE_ENABLED: "true",
      MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
    },
    memoraxCodeHome: blockerRoot,
    repositoryMemorySession: repositoryRuntime(),
    transcriptReadAttempts: 1,
  });
  try {
    assert.deepEqual(await runtime.recordTurnStart(turnStart(fixture.path)), { ok: true });
    assert.deepEqual(await runtime.writeback({
      version: 1,
      client: "claude-code",
      sessionId: SESSION_ID,
      promptId: PROMPT_ID,
      transcriptPath: fixture.path,
      lastAssistantMessage: "Fail-open answer.",
    }), { ok: true, scheduled: true });
    assert.equal(writebacks.length, 1);
    assert.equal(
      diagnostics.filter(({ event }) => event === "claude_trace.write_failed").length >= 2,
      true,
    );
  } finally {
    runtime.close();
    await fixture.remove();
    await rm(blockerRoot, { recursive: true, force: true });
  }
});

test("Claude Hooks deduplicate lifecycle events and append late transcript materialization", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-hook-lifecycle-idempotency-"));
  const transcriptPath = join(root, "transcript.jsonl");
  const writebacks = [];
  const runtime = createClaudeMemoryHookRuntime({
    automaticWriteback: collectAcceptedWriteback(writebacks),
    env: {
      MEMORAX_CODE_CLAUDE_TRACE_ENABLED: "true",
      MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
    },
    memoraxCodeHome: root,
    repositoryMemorySession: repositoryRuntime(),
    transcriptReadAttempts: 1,
  });
  const start = turnStart(transcriptPath);
  const stop = {
    version: 1,
    client: "claude-code",
    sessionId: SESSION_ID,
    promptId: PROMPT_ID,
    transcriptPath,
    cwd: "/workspace/claude-hook",
    lastAssistantMessage: "Hook answer before transcript materialization.",
  };
  try {
    assert.deepEqual(await runtime.recordTurnStart(start), { ok: true });
    assert.deepEqual(await runtime.recordTurnStart(start), { ok: true });
    assert.deepEqual(await runtime.writeback(stop), {
      ok: true,
      scheduled: false,
      reason: "transcript_unavailable",
    });

    await writeFile(transcriptPath, [
      JSON.stringify(userRecord("Exact Claude prompt after materialization.")),
      ...completedAssistantRecords("Exact Claude answer after materialization.")
        .map((record) => JSON.stringify(record)),
      "",
    ].join("\n"));
    assert.deepEqual(await runtime.writeback(stop), { ok: true, scheduled: true });

    const events = (await readFile(claudeTracePaths(root).eventsJsonl(SESSION_ID), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(events.map((event) => event.type), [
      "turn_start",
      "turn_end",
      "turn_materialized",
    ]);
    assert.match(events[0].event_id, /^trace-turn-start-[a-f0-9]{32}$/);
    assert.match(events[1].event_id, /^trace-turn-end-[a-f0-9]{32}$/);
    assert.equal(events[1].response.assistantMessage, "Hook answer before transcript materialization.");
    assert.match(events[2].event_id, /^trace-turn-materialized-[a-f0-9]{32}$/);
    assert.equal(events[2].request.original_event_id, events[1].event_id);
    assert.equal(events[2].request.prompt, "Exact Claude prompt after materialization.");
    assert.equal(events[2].response.assistantMessage, "Exact Claude answer after materialization.");
    assert.equal(events[2].session_turn_index, 1);
    assert.deepEqual(events[2].activities, [{ index: 1, type: "memory_cli_search" }]);
    assert.deepEqual(events[2].usage, expectedCompletedUsage());
    assert.equal(writebacks.length, 1);
    assert.equal(writebacks[0].assistantText, "Exact Claude answer after materialization.");
  } finally {
    runtime.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude automatic retrieval counts each prompt id once per session", async () => {
  const requests = [];
  const env = {
    ...TRACE_DISABLED_ENV,
    MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "true",
  };
  const runtime = createClaudeMemoryHookRuntime({
    automaticWriteback: () => ({ accepted: true }),
    env,
    fetchImpl: async (url, init) => {
      requests.push({
        url: String(url),
        body: JSON.parse(init.body),
      });
      return new Response(JSON.stringify({
        success: true,
        data: {
          task_id: "claude-retrieval-dedupe",
          status: "completed",
          data: [{
            id: "memory-1",
            memory: "Deduplicated Claude retrieval context.",
            score: 0.9,
            metadata: { memory_type: "core" },
          }],
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    maxEntries: 2,
    repositoryMemorySession: repositoryRuntime({
      baseUrl: "http://memorax.test",
      apiKey: "secret",
      userId: "user-1",
      topK: 6,
      kDense: 6,
      kSparse: 6,
      timeoutMs: 1000,
      maxContextChars: 4000,
      maxItemChars: 1000,
      memoryTypeOrder: ["core"],
      renderByMemoryType: true,
    }),
  });
  try {
    const first = await runtime.recordTurnStart(turnStart("/tmp/claude-transcript.jsonl", "prompt-1"));
    const duplicate = await runtime.recordTurnStart(turnStart("/tmp/claude-transcript.jsonl", "prompt-1"));
    const nextPrompt = await runtime.recordTurnStart(turnStart("/tmp/claude-transcript.jsonl", "prompt-2"));
    const otherSession = await runtime.recordTurnStart({
      ...turnStart("/tmp/claude-transcript.jsonl", "prompt-1"),
      sessionId: "session-claude-other",
    });

    assert.match(first.additionalContext, /Deduplicated Claude retrieval context/);
    assert.deepEqual(duplicate, { ok: true });
    assert.match(nextPrompt.additionalContext, /Deduplicated Claude retrieval context/);
    assert.match(otherSession.additionalContext, /Deduplicated Claude retrieval context/);
    assert.equal(requests.length, 3);
    assert.deepEqual(requests.map(({ body }) => body.query), [
      "Hook prompt.",
      "Hook prompt.",
      "Hook prompt.",
    ]);
  } finally {
    runtime.close();
  }
});

function repositoryRuntime(config = {}, scope = SCOPE) {
  return {
    async resolve() {
      return { ok: true, memory: { config, scope } };
    },
    close() {},
  };
}

function collectAcceptedWriteback(writebacks) {
  return (options) => {
    writebacks.push(options);
    return { accepted: true };
  };
}

function turnStart(transcriptPath, promptId = PROMPT_ID) {
  return {
    version: 1,
    client: "claude-code",
    sessionId: SESSION_ID,
    promptId,
    transcriptPath,
    cwd: "/workspace/claude-hook",
    prompt: "Hook prompt.",
  };
}

async function transcriptFixture(
  userPrompt,
  assistantReply,
  { promptId = PROMPT_ID, assistantRecords } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-hook-transcript-"));
  const path = join(root, "transcript.jsonl");
  await writeFile(path, [
    JSON.stringify(userRecord(userPrompt, promptId)),
    ...(assistantRecords ?? [assistantRecord(assistantReply)])
      .map((record) => JSON.stringify(record)),
    "",
  ].join("\n"));
  return {
    root,
    path,
    remove: () => rm(root, { recursive: true, force: true }),
  };
}

function userRecord(content, promptId = PROMPT_ID) {
  return {
    parentUuid: null,
    isSidechain: false,
    promptId,
    type: "user",
    userType: "external",
    message: { role: "user", content },
    uuid: "user-visible",
    sessionId: SESSION_ID,
  };
}

function assistantRecord(text, {
  parentUuid = "user-visible",
  uuid = "assistant-final",
  messageId,
  stopReason = "end_turn",
  content,
  usage,
} = {}) {
  return {
    parentUuid,
    isSidechain: false,
    type: "assistant",
    message: {
      ...(messageId === undefined ? {} : { id: messageId }),
      role: "assistant",
      content: content ?? [{ type: "text", text }],
      stop_reason: stopReason,
      ...(usage === undefined ? {} : { usage }),
    },
    uuid,
    sessionId: SESSION_ID,
  };
}

function completedAssistantRecords(answer) {
  return [
    assistantRecord("", {
      uuid: "assistant-memory",
      messageId: "message-memory",
      stopReason: "tool_use",
      content: [{
        type: "tool_use",
        id: "tool-memory-search",
        name: "Bash",
        input: { command: "memorax-cli search --query 'trace context'" },
      }],
      usage: claudeUsage(12, 3),
    }),
    {
      parentUuid: "assistant-memory",
      isSidechain: false,
      type: "user",
      userType: "external",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "tool-memory-search",
          content: "memory result",
        }],
      },
      uuid: "user-memory-result",
      sessionId: SESSION_ID,
    },
    assistantRecord(answer, {
      parentUuid: "user-memory-result",
      messageId: "message-final",
      usage: claudeUsage(5, 4),
    }),
  ];
}

function claudeUsage(inputTokens, outputTokens) {
  return {
    input_tokens: inputTokens,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    output_tokens: outputTokens,
    cache_creation: null,
    server_tool_use: null,
  };
}

function expectedCompletedUsage() {
  return {
    input_tokens: 17,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    output_tokens: 7,
    cache_creation: {
      ephemeral_1h_input_tokens: 0,
      ephemeral_5m_input_tokens: 0,
    },
    server_tool_use: {
      web_search_requests: 0,
      web_fetch_requests: 0,
    },
  };
}
