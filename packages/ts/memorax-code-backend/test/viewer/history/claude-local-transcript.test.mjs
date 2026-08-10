import assert from "node:assert/strict";
import { appendFile, chmod, mkdir, mkdtemp, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import {
  claudeLocalProjectsRoot,
  clearClaudeLocalTranscriptProjections,
  readClaudeLocalTranscriptHistory,
} from "../../../dist/viewer/history/claude-transcript.js";

test.beforeEach(() => clearClaudeLocalTranscriptProjections());

test("Claude native transcript source stays explicitly injectable and disabled reads share empty history", async () => {
  const configuredHome = join(tmpdir(), "memorax-code-claude-configured-home");
  const legacyHome = join(tmpdir(), "memorax-code-claude-legacy-home");
  assert.equal(claudeLocalProjectsRoot({
    CLAUDE_CONFIG_DIR: ` ${configuredHome} `,
    CLAUDE_HOME: legacyHome,
  }), join(resolve(configuredHome), "projects"));
  assert.equal(claudeLocalProjectsRoot({ CLAUDE_HOME: legacyHome }), join(resolve(legacyHome), "projects"));

  let resolveCalls = 0;
  const resolver = () => {
    resolveCalls += 1;
    return { projectId: "repo:00000000000000000000000000000000", projectLabel: "Unexpected" };
  };
  const disabled = await readClaudeLocalTranscriptHistory(false, resolver);
  const unspecified = await readClaudeLocalTranscriptHistory(undefined, resolver);
  const blank = await readClaudeLocalTranscriptHistory("   ", resolver);
  assert.strictEqual(unspecified, disabled);
  assert.strictEqual(blank, disabled);
  assert.deepEqual(disabled, []);
  assert.equal(resolveCalls, 0);
});

test("Claude native transcript projects only real interactive turns", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-native-"));
  const repo = join(root, "workspace", "Claude-Repo");
  const projectsRoot = join(root, "claude-home", "projects");
  const projectDirectory = join(projectsRoot, "encoded-project");
  const transcript = join(projectDirectory, "session-local.jsonl");
  const hiddenValues = [
    "injected startup context",
    "sidechain prompt",
    "missing user type",
    "private tool output",
    "sidechain answer",
  ];
  try {
    await Promise.all([
      mkdir(join(repo, ".git"), { recursive: true }),
      mkdir(projectDirectory, { recursive: true }),
    ]);
    await writeFile(transcript, [
      userRecord({
        uuid: "meta-turn",
        content: hiddenValues[0],
        cwd: repo,
        isMeta: true,
      }),
      userRecord({
        uuid: "sidechain-turn",
        content: hiddenValues[1],
        cwd: repo,
        isSidechain: true,
      }),
      userRecord({
        uuid: "missing-user-type",
        content: hiddenValues[2],
        cwd: repo,
        omitUserType: true,
      }),
      userRecord({
        uuid: "user-record-one",
        promptId: "turn-one",
        content: "Visible Claude prompt.",
        cwd: repo,
        timestamp: "Sun, 27 Jul 2026 10:01:00 GMT (private timestamp suffix)",
      }),
      assistantRecord({
        uuid: "assistant-tool",
        cwd: repo,
        stopReason: "tool_use",
        content: [{ type: "tool_use", id: "tool-1", name: "Read", input: {} }],
      }),
      userRecord({
        uuid: "tool-result",
        cwd: repo,
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: hiddenValues[3] }],
      }),
      assistantRecord({
        uuid: "assistant-sidechain",
        cwd: repo,
        stopReason: "end_turn",
        content: [{ type: "text", text: hiddenValues[4] }],
        isSidechain: true,
      }),
      assistantRecord({
        uuid: "assistant-final",
        cwd: repo,
        stopReason: "end_turn",
        content: [
          { type: "thinking", thinking: "private reasoning" },
          { type: "text", text: "Visible Claude answer." },
        ],
      }),
      "{malformed",
      "",
    ].join("\n"), "utf8");

    const first = await readClaudeLocalTranscriptHistory(projectsRoot);
    const unchanged = await readClaudeLocalTranscriptHistory(projectsRoot);
    assert.strictEqual(unchanged, first);
    assert.deepEqual(first.map((event) => event.type), ["turn_start", "turn_end"]);
    assert.deepEqual(first.map((event) => event.client), ["claude", "claude"]);
    assert.deepEqual(first.map((event) => event.turnId), ["turn-one", "turn-one"]);
    assert.equal(first[0].projectLabel, "Claude-Repo");
    assert.equal(first[0].prompt, "Visible Claude prompt.");
    assert.equal(first[0].timestamp, "2026-07-27T10:01:00.000Z");
    assert.equal(first[1].answer, "Visible Claude answer.");
    assert.equal(first[1].turnOutcome, "completed");
    assert.equal(
      first[0].eventKey,
      JSON.stringify(["claude", "session-local", "claude-local:session-local:turn_start:turn-one"]),
    );
    assert.doesNotMatch(JSON.stringify(first), new RegExp(hiddenValues.join("|")));

    const disabled = await readClaudeLocalTranscriptHistory(false);
    const cachedAgain = await readClaudeLocalTranscriptHistory(projectsRoot);
    assert.deepEqual(disabled, []);
    assert.strictEqual(cachedAgain, first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude native transcript projects confirmed exact-branch memory activity without private command data", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-memory-activity-"));
  const repo = join(root, "workspace", "Claude-Memory-Repo");
  const projectsRoot = join(root, "claude-home", "projects");
  const projectDirectory = join(projectsRoot, "encoded-project");
  const transcript = join(projectDirectory, "session-secure.jsonl");
  const secrets = {
    query: "PRIVATE_SEARCH_QUERY_92a7",
    memory: "PRIVATE_MEMORY_BODY_40ef",
    reason: "PRIVATE_WRITE_REASON_f04d",
    token: "PRIVATE_PROVIDER_TOKEN_603c",
    path: "/private/Claude Workspace/bin/memorax-cli",
    reasoning: "PRIVATE_CHAIN_OF_THOUGHT_a103",
    toolResult: "PRIVATE_TOOL_RESULT_5f6b",
    failedQuery: "PRIVATE_FAILED_QUERY_357e",
    failedResult: "PRIVATE_FAILED_RESULT_06dc",
    offBranch: "PRIVATE_OFF_BRANCH_MEMORY_b841",
  };
  try {
    await Promise.all([
      mkdir(join(repo, ".git"), { recursive: true }),
      mkdir(projectDirectory, { recursive: true }),
    ]);
    await writeFile(transcript, [
      userRecord({
        uuid: "private-user-record-uuid",
        promptId: "public-turn-id",
        content: "Visible prompt.",
        sessionId: "session-secure",
        cwd: repo,
        timestamp: "2026-07-27T10:00:00.000Z",
      }),
      assistantRecord({
        uuid: "assistant-off-branch",
        parentUuid: "private-user-record-uuid",
        sessionId: "session-secure",
        cwd: repo,
        timestamp: "2026-07-27T10:00:01.000Z",
        stopReason: "tool_use",
        content: [{
          type: "tool_use",
          id: "tool-off-branch",
          name: "Bash",
          input: { command: `memorax-cli add --content '${secrets.offBranch}'` },
        }],
      }),
      userRecord({
        uuid: "result-off-branch",
        parentUuid: "assistant-off-branch",
        sessionId: "session-secure",
        cwd: repo,
        timestamp: "2026-07-27T10:00:02.000Z",
        content: [{
          type: "tool_result",
          tool_use_id: "tool-off-branch",
          content: "off-branch result",
        }],
      }),
      assistantRecord({
        uuid: "assistant-memory-first",
        parentUuid: "private-user-record-uuid",
        sessionId: "session-secure",
        cwd: repo,
        timestamp: "2026-07-27T10:00:03.000Z",
        stopReason: "tool_use",
        content: [
          { type: "thinking", thinking: secrets.reasoning },
          {
            type: "tool_use",
            id: "tool-memory-shared",
            name: "Bash",
            input: {
              command: `"${secrets.path}" search --query '${secrets.query}' && memorax-cli add --content '${secrets.memory}' --reason '${secrets.reason}' --token '${secrets.token}'`,
            },
          },
        ],
      }),
      assistantRecord({
        uuid: "assistant-memory-snapshot",
        parentUuid: "assistant-memory-first",
        sessionId: "session-secure",
        cwd: repo,
        timestamp: "2026-07-27T10:00:04.000Z",
        stopReason: "tool_use",
        content: [{
          type: "tool_use",
          id: "tool-memory-shared",
          name: "Bash",
          input: {
            command: `"${secrets.path}" search --query '${secrets.query}' && memorax-cli add --content '${secrets.memory}' --reason '${secrets.reason}' --token '${secrets.token}'`,
          },
        }],
      }),
      userRecord({
        uuid: "result-memory-shared",
        parentUuid: "assistant-memory-snapshot",
        sessionId: "session-secure",
        cwd: repo,
        timestamp: "2026-07-27T10:00:05.000Z",
        content: [{
          type: "tool_result",
          tool_use_id: "tool-memory-shared",
          content: secrets.toolResult,
        }],
      }),
      assistantRecord({
        uuid: "assistant-memory-failed",
        parentUuid: "result-memory-shared",
        sessionId: "session-secure",
        cwd: repo,
        timestamp: "2026-07-27T10:00:06.000Z",
        stopReason: "tool_use",
        content: [{
          type: "tool_use",
          id: "tool-memory-failed",
          name: "Bash",
          input: { command: `memorax-cli search --query '${secrets.failedQuery}'` },
        }],
      }),
      userRecord({
        uuid: "result-memory-failed",
        parentUuid: "assistant-memory-failed",
        sessionId: "session-secure",
        cwd: repo,
        timestamp: "2026-07-27T10:00:07.000Z",
        content: [{
          type: "tool_result",
          tool_use_id: "tool-memory-failed",
          is_error: true,
          content: secrets.failedResult,
        }],
      }),
      assistantRecord({
        uuid: "assistant-final-secure",
        parentUuid: "result-memory-failed",
        sessionId: "session-secure",
        cwd: repo,
        timestamp: "2026-07-27T10:00:08.000Z",
        stopReason: "end_turn",
        content: [{ type: "text", text: "Visible answer." }],
      }),
    ].join("\n") + "\n", "utf8");

    const events = await readClaudeLocalTranscriptHistory(projectsRoot);
    const activities = events.filter((event) => (
      event.type === "memory_cli_search" || event.type === "memory_cli_add"
    ));
    assert.equal(activities.length, 3);
    assert.equal(activities.filter((event) => event.type === "memory_cli_search").length, 2);
    assert.equal(activities.filter((event) => event.type === "memory_cli_add").length, 1);
    assert.equal(new Set(activities.map((event) => event.id)).size, 3);
    assert.deepEqual(new Set(activities.map((event) => event.turnId)), new Set(["public-turn-id"]));
    assert.equal(events.some((event) => event.turnId === "private-user-record-uuid"), false);

    const successful = activities.filter((event) => event.ok);
    assert.equal(successful.length, 2);
    assert.equal(successful.every((event) => event.error === undefined), true);
    const failed = activities.find((event) => event.ok === false);
    assert.equal(failed?.type, "memory_cli_search");
    assert.equal(failed?.content, "Claude Code invoked memory search.");
    assert.equal(failed?.error, "Claude Code recorded a failed memory command.");

    const projected = JSON.stringify(events);
    for (const secret of Object.values(secrets)) {
      assert.equal(projected.includes(secret), false, `projected private transcript value: ${secret}`);
    }
    assert.equal(projected.includes("tool-memory-shared"), false);
    assert.equal(projected.includes("tool-memory-failed"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude native transcript replaces cached Search activity with rewritten Add activity", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-memory-rewrite-"));
  const projectsRoot = join(root, "projects");
  const projectDirectory = join(projectsRoot, "project");
  const transcript = join(projectDirectory, "session-memory-rewrite.jsonl");
  try {
    await mkdir(projectDirectory, { recursive: true });
    const before = memoryTurnTranscript({
      sessionId: "session-memory-rewrite",
      command: "memorax-cli search --query S",
      toolUseId: "tool-rewrite",
    });
    const after = memoryTurnTranscript({
      sessionId: "session-memory-rewrite",
      command: "memorax-cli add  --content M",
      toolUseId: "tool-rewrite",
    });
    assert.equal(Buffer.byteLength(after), Buffer.byteLength(before));

    await writeFile(transcript, before, "utf8");
    const first = await readClaudeLocalTranscriptHistory(projectsRoot);
    assert.deepEqual(memoryActivityTypes(first), ["memory_cli_search"]);

    await writeFile(transcript, after, "utf8");
    const future = new Date(Date.now() + 1_000);
    await utimes(transcript, future, future);
    const rewritten = await readClaudeLocalTranscriptHistory(projectsRoot);
    assert.deepEqual(memoryActivityTypes(rewritten), ["memory_cli_add"]);
    assert.equal(rewritten.some((event) => event.type === "memory_cli_search"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude native transcript waits for complete tool result and terminal records before activity projection", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-memory-partial-"));
  const projectsRoot = join(root, "projects");
  const projectDirectory = join(projectsRoot, "project");
  const transcript = join(projectDirectory, "session-memory-partial.jsonl");
  const prompt = userRecord({
    uuid: "user-memory-partial",
    promptId: "turn-memory-partial",
    content: "Visible partial prompt.",
    sessionId: "session-memory-partial",
    timestamp: "2026-07-27T10:30:00.000Z",
  });
  const toolUse = assistantRecord({
    uuid: "assistant-memory-partial",
    parentUuid: "user-memory-partial",
    sessionId: "session-memory-partial",
    timestamp: "2026-07-27T10:30:01.000Z",
    stopReason: "tool_use",
    content: [{
      type: "tool_use",
      id: "tool-memory-partial",
      name: "Bash",
      input: { command: "memorax-cli search --query PRIVATE_PARTIAL_QUERY" },
    }],
  });
  const toolResult = userRecord({
    uuid: "result-memory-partial",
    parentUuid: "assistant-memory-partial",
    sessionId: "session-memory-partial",
    timestamp: "2026-07-27T10:30:02.000Z",
    content: [{
      type: "tool_result",
      tool_use_id: "tool-memory-partial",
      content: "PRIVATE_PARTIAL_RESULT",
    }],
  });
  const terminal = assistantRecord({
    uuid: "assistant-final-partial",
    parentUuid: "result-memory-partial",
    sessionId: "session-memory-partial",
    timestamp: "2026-07-27T10:30:03.000Z",
    stopReason: "end_turn",
    content: [{ type: "text", text: "Visible partial answer." }],
  });
  try {
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(transcript, `${prompt}\n${toolUse}\n`, "utf8");
    const awaitingResult = await readClaudeLocalTranscriptHistory(projectsRoot);
    assert.deepEqual(memoryActivityTypes(awaitingResult), []);

    const resultSplit = Math.floor(toolResult.length / 2);
    await appendFile(transcript, toolResult.slice(0, resultSplit), "utf8");
    const partialResult = await readClaudeLocalTranscriptHistory(projectsRoot);
    assert.deepEqual(memoryActivityTypes(partialResult), []);

    await appendFile(transcript, `${toolResult.slice(resultSplit)}\n`, "utf8");
    const awaitingTerminal = await readClaudeLocalTranscriptHistory(projectsRoot);
    assert.deepEqual(memoryActivityTypes(awaitingTerminal), []);

    const terminalSplit = Math.floor(terminal.length / 2);
    await appendFile(transcript, terminal.slice(0, terminalSplit), "utf8");
    const partialTerminal = await readClaudeLocalTranscriptHistory(projectsRoot);
    assert.deepEqual(memoryActivityTypes(partialTerminal), []);

    await appendFile(transcript, `${terminal.slice(terminalSplit)}\n`, "utf8");
    const completed = await readClaudeLocalTranscriptHistory(projectsRoot);
    assert.deepEqual(memoryActivityTypes(completed), ["memory_cli_search"]);
    const activity = completed.find((event) => event.type === "memory_cli_search");
    assert.equal(activity?.ok, true);
    assert.equal(JSON.stringify(completed).includes("PRIVATE_PARTIAL_QUERY"), false);
    assert.equal(JSON.stringify(completed).includes("PRIVATE_PARTIAL_RESULT"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude native transcript coalesces terminal snapshots before projecting memory activity", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-terminal-lineage-"));
  const projectsRoot = join(root, "projects");
  const projectDirectory = join(projectsRoot, "project");
  const transcript = join(projectDirectory, "session-terminal-lineage.jsonl");
  try {
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(transcript, `${[
      userRecord({
        uuid: "user-terminal-lineage",
        promptId: "turn-terminal-lineage",
        content: "Recover one terminal lineage.",
        sessionId: "session-terminal-lineage",
        timestamp: "2026-07-27T10:00:00.000Z",
      }),
      assistantRecord({
        uuid: "assistant-lineage-tool",
        parentUuid: "user-terminal-lineage",
        sessionId: "session-terminal-lineage",
        timestamp: "2026-07-27T10:00:01.000Z",
        stopReason: "tool_use",
        content: [{
          type: "tool_use",
          id: "tool-lineage-search",
          name: "Bash",
          input: { command: "memorax-cli search --query PRIVATE_LINEAGE_QUERY" },
        }],
      }),
      userRecord({
        uuid: "result-terminal-lineage",
        parentUuid: "assistant-lineage-tool",
        sessionId: "session-terminal-lineage",
        timestamp: "2026-07-27T10:00:02.000Z",
        content: [{
          type: "tool_result",
          tool_use_id: "tool-lineage-search",
          content: "PRIVATE_LINEAGE_RESULT",
        }],
      }),
      assistantRecord({
        uuid: "assistant-terminal-ancestor",
        parentUuid: "result-terminal-lineage",
        sessionId: "session-terminal-lineage",
        timestamp: "2026-07-27T10:00:03.000Z",
        stopReason: "end_turn",
        content: [{ type: "text", text: "Earlier terminal snapshot." }],
      }),
      assistantRecord({
        uuid: "assistant-terminal-descendant",
        parentUuid: "assistant-terminal-ancestor",
        sessionId: "session-terminal-lineage",
        timestamp: "2026-07-27T10:00:04.000Z",
        stopReason: "end_turn",
        content: [{ type: "text", text: "Final terminal snapshot." }],
      }),
    ].join("\n")}\n`, "utf8");

    const events = await readClaudeLocalTranscriptHistory(projectsRoot);
    assert.deepEqual(events.map((event) => event.type), [
      "turn_start",
      "memory_cli_search",
      "turn_end",
    ]);
    assert.equal(events.find((event) => event.type === "turn_end")?.answer, "Final terminal snapshot.");
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_LINEAGE/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude native transcript preserves activity on an accepted interrupted branch", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-interrupted-activity-"));
  const projectsRoot = join(root, "projects");
  const projectDirectory = join(projectsRoot, "project");
  const transcript = join(projectDirectory, "session-interrupted-activity.jsonl");
  try {
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(transcript, `${[
      userRecord({
        uuid: "user-interrupted-activity",
        promptId: "turn-interrupted-activity",
        content: "Run memory search before interruption.",
        sessionId: "session-interrupted-activity",
        timestamp: "2026-07-27T10:10:00.000Z",
      }),
      assistantRecord({
        uuid: "assistant-interrupted-tool",
        parentUuid: "user-interrupted-activity",
        sessionId: "session-interrupted-activity",
        timestamp: "2026-07-27T10:10:01.000Z",
        stopReason: "tool_use",
        content: [{
          type: "tool_use",
          id: "tool-interrupted-search",
          name: "Bash",
          input: { command: "memorax-cli search --query PRIVATE_INTERRUPTED_QUERY" },
        }],
      }),
      userRecord({
        uuid: "result-interrupted-activity",
        parentUuid: "assistant-interrupted-tool",
        sessionId: "session-interrupted-activity",
        timestamp: "2026-07-27T10:10:02.000Z",
        content: [{
          type: "tool_result",
          tool_use_id: "tool-interrupted-search",
          content: "PRIVATE_INTERRUPTED_RESULT",
        }],
      }),
      userRecord({
        uuid: "marker-interrupted-activity",
        parentUuid: "result-interrupted-activity",
        content: "Interrupted by the user.",
        sessionId: "session-interrupted-activity",
        timestamp: "2026-07-27T10:10:03.000Z",
        interruptedMessageId: "unresolved-interrupted-message",
      }),
    ].join("\n")}\n`, "utf8");

    const events = await readClaudeLocalTranscriptHistory(projectsRoot);
    assert.deepEqual(events.map((event) => event.type), [
      "turn_start",
      "memory_cli_search",
      "turn_end",
    ]);
    assert.equal(events.find((event) => event.type === "turn_end")?.turnOutcome, "interrupted");
    assert.doesNotMatch(JSON.stringify(events), /PRIVATE_INTERRUPTED/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude native transcript preserves activity for supported assistant terminals", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-error-activity-"));
  const projectsRoot = join(root, "projects");
  const projectDirectory = join(projectsRoot, "project");
  const cases = [
    {
      suffix: "max-tokens",
      stopReason: "max_tokens",
      terminalFields: {},
      expectedOutcome: "interrupted",
    },
    {
      suffix: "api-error",
      stopReason: null,
      terminalFields: { isApiErrorMessage: true },
      expectedOutcome: "interrupted",
    },
    {
      suffix: "stop-sequence",
      stopReason: "stop_sequence",
      terminalFields: {},
      expectedOutcome: "completed",
    },
  ];
  try {
    await mkdir(projectDirectory, { recursive: true });
    await Promise.all(cases.map(({ suffix, stopReason, terminalFields }) => {
      const sessionId = `session-${suffix}`;
      return writeFile(join(projectDirectory, `${sessionId}.jsonl`), `${[
        userRecord({
          uuid: `user-${suffix}`,
          promptId: `turn-${suffix}`,
          content: `Run memory search before ${suffix}.`,
          sessionId,
          timestamp: "2026-07-27T10:20:00.000Z",
        }),
        assistantRecord({
          uuid: `assistant-tool-${suffix}`,
          parentUuid: `user-${suffix}`,
          sessionId,
          timestamp: "2026-07-27T10:20:01.000Z",
          stopReason: "tool_use",
          content: [{
            type: "tool_use",
            id: `tool-${suffix}`,
            name: "Bash",
            input: { command: `memorax-cli search --query PRIVATE_${suffix}` },
          }],
        }),
        userRecord({
          uuid: `result-${suffix}`,
          parentUuid: `assistant-tool-${suffix}`,
          sessionId,
          timestamp: "2026-07-27T10:20:02.000Z",
          content: [{
            type: "tool_result",
            tool_use_id: `tool-${suffix}`,
            content: `PRIVATE_RESULT_${suffix}`,
          }],
        }),
        assistantRecord({
          uuid: `terminal-${suffix}`,
          parentUuid: `result-${suffix}`,
          sessionId,
          timestamp: "2026-07-27T10:20:03.000Z",
          stopReason,
          content: [{ type: "text", text: `Partial ${suffix} answer.` }],
          ...terminalFields,
        }),
      ].join("\n")}\n`, "utf8");
    }));

    const events = await readClaudeLocalTranscriptHistory(projectsRoot);
    for (const { suffix, expectedOutcome } of cases) {
      const scoped = events.filter((event) => event.sessionId === `session-${suffix}`);
      assert.deepEqual(scoped.map((event) => event.type), [
        "turn_start",
        "memory_cli_search",
        "turn_end",
      ]);
      assert.equal(scoped.find((event) => event.type === "turn_end")?.turnOutcome, expectedOutcome);
    }
    assert.doesNotMatch(
      JSON.stringify(events),
      /PRIVATE_(?:RESULT_)?(?:max-tokens|api-error|stop-sequence)/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude native transcript rejects lineage and activity across session and project boundaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-lineage-scope-"));
  const repoA = join(root, "workspace", "Repo-A");
  const repoB = join(root, "workspace", "Repo-B");
  const projectsRoot = join(root, "claude-home", "projects");
  const projectDirectory = join(projectsRoot, "encoded-project");
  try {
    await Promise.all([
      mkdir(join(repoA, ".git"), { recursive: true }),
      mkdir(join(repoB, ".git"), { recursive: true }),
      mkdir(projectDirectory, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(projectDirectory, "session-boundary.jsonl"), `${[
        userRecord({
          uuid: "user-session-a",
          promptId: "turn-session-a",
          content: "Session A prompt.",
          sessionId: "session-a",
          cwd: repoA,
        }),
        userRecord({
          type: "summary",
          uuid: "hidden-session-b",
          parentUuid: "user-session-a",
          content: "Foreign session metadata.",
          sessionId: "session-b",
          cwd: repoA,
          isMeta: true,
        }),
        assistantRecord({
          uuid: "assistant-session-a",
          parentUuid: "hidden-session-b",
          content: [{ type: "text", text: "Foreign hidden bridge answer." }],
          stopReason: "end_turn",
          sessionId: "session-a",
          cwd: repoA,
        }),
      ].join("\n")}\n`, "utf8"),
      writeFile(join(projectDirectory, "project-boundary.jsonl"), `${[
        userRecord({
          uuid: "user-project-a",
          promptId: "turn-project-a",
          content: "Project A prompt.",
          sessionId: "session-project",
          cwd: repoA,
        }),
        userRecord({
          type: "summary",
          uuid: "hidden-project-a",
          parentUuid: "user-project-a",
          content: "Project A metadata.",
          sessionId: "session-project",
          cwd: repoA,
          isMeta: true,
        }),
        assistantRecord({
          uuid: "assistant-project-b",
          parentUuid: "hidden-project-a",
          content: [{ type: "text", text: "Foreign project answer." }],
          stopReason: "end_turn",
          sessionId: "session-project",
          cwd: repoB,
        }),
      ].join("\n")}\n`, "utf8"),
      writeFile(join(projectDirectory, "active-boundary.jsonl"), `${[
        userRecord({
          uuid: "user-active-a",
          promptId: "turn-active-a",
          content: "Active Turn A prompt.",
          sessionId: "session-active-a",
          cwd: repoA,
        }),
        userRecord({
          type: "summary",
          uuid: "hidden-active-a",
          parentUuid: "user-active-a",
          content: "Active Turn A metadata.",
          sessionId: "session-active-a",
          cwd: repoA,
          isMeta: true,
        }),
        assistantRecord({
          uuid: "assistant-parented-b",
          parentUuid: "hidden-active-a",
          content: [{ type: "text", text: "Foreign parented answer." }],
          stopReason: "end_turn",
          sessionId: "session-active-b",
          cwd: repoA,
        }),
        assistantRecord({
          uuid: "assistant-parentless-b",
          content: [{ type: "text", text: "Foreign parentless answer." }],
          stopReason: "end_turn",
          sessionId: "session-active-b",
          cwd: repoA,
        }),
      ].join("\n")}\n`, "utf8"),
      writeFile(join(projectDirectory, "session-activity.jsonl"), `${[
        userRecord({
          uuid: "user-activity-a",
          promptId: "turn-activity-a",
          content: "Activity project A prompt.",
          sessionId: "session-activity",
          cwd: repoA,
        }),
        assistantRecord({
          uuid: "assistant-activity-a",
          parentUuid: "user-activity-a",
          content: [{ type: "text", text: "Accepted project A answer." }],
          stopReason: "end_turn",
          sessionId: "session-activity",
          cwd: repoA,
        }),
        assistantRecord({
          uuid: "assistant-activity-b",
          parentUuid: "assistant-activity-a",
          content: [{
            type: "tool_use",
            id: "tool-activity-b",
            name: "Bash",
            input: { command: "memorax-cli search --query PRIVATE_FOREIGN_QUERY" },
          }],
          stopReason: "tool_use",
          sessionId: "session-activity",
          cwd: repoB,
        }),
        userRecord({
          uuid: "result-activity-b",
          parentUuid: "assistant-activity-b",
          content: [{
            type: "tool_result",
            tool_use_id: "tool-activity-b",
            content: "PRIVATE_FOREIGN_RESULT",
          }],
          sessionId: "session-activity",
          cwd: repoB,
        }),
        assistantRecord({
          uuid: "assistant-final-activity-b",
          parentUuid: "result-activity-b",
          content: [{ type: "text", text: "Foreign activity answer." }],
          stopReason: "end_turn",
          sessionId: "session-activity",
          cwd: repoB,
        }),
      ].join("\n")}\n`, "utf8"),
    ]);

    const events = await readClaudeLocalTranscriptHistory(projectsRoot);
    assert.equal(events.filter((event) => event.type === "turn_start").length, 4);
    assert.equal(events.filter((event) => event.type === "turn_end").length, 1);
    assert.deepEqual(memoryActivityTypes(events), []);
    assert.deepEqual(
      events.filter((event) => event.type === "turn_start").map((event) => event.turnId).sort(),
      ["turn-active-a", "turn-activity-a", "turn-project-a", "turn-session-a"],
    );
    assert.equal(
      events.find((event) => event.type === "turn_end")?.turnId,
      "turn-activity-a",
    );
    assert.doesNotMatch(JSON.stringify(events), /Foreign .* answer/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude native transcript refreshes complete appends and replaces rewritten cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-incremental-"));
  const projectsRoot = join(root, "projects");
  const projectDirectory = join(projectsRoot, "project");
  const transcript = join(projectDirectory, "session-incremental.jsonl");
  try {
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(transcript, `${interactiveRecord("turn-one", "2026-07-27T11:00:00.000Z", "one")}\n`, "utf8");
    const first = await readClaudeLocalTranscriptHistory(projectsRoot);
    assert.deepEqual(first.map((event) => event.turnId), ["turn-one"]);

    const secondLine = interactiveRecord("turn-two", "2026-07-27T11:01:00.000Z", "two");
    const splitAt = Math.floor(secondLine.length / 2);
    await appendFile(transcript, secondLine.slice(0, splitAt), "utf8");
    const partial = await readClaudeLocalTranscriptHistory(projectsRoot);
    assert.strictEqual(partial, first);

    await appendFile(transcript, `${secondLine.slice(splitAt)}\n`, "utf8");
    const completed = await readClaudeLocalTranscriptHistory(projectsRoot);
    assert.deepEqual(completed.map((event) => event.turnId), ["turn-one", "turn-two"]);

    await writeFile(transcript, `${interactiveRecord(
      "turn-replaced",
      "2026-07-27T11:02:00.000Z",
      "replacement content that changes the cached prefix",
    )}\n`, "utf8");
    const replaced = await readClaudeLocalTranscriptHistory(projectsRoot);
    assert.deepEqual(replaced.map((event) => event.turnId), ["turn-replaced"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude native transcript drops stale cached events when a changed file is unreadable", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-unreadable-"));
  const projectsRoot = join(root, "projects");
  const projectDirectory = join(projectsRoot, "project");
  const transcript = join(projectDirectory, "session-unreadable.jsonl");
  try {
    await mkdir(projectDirectory, { recursive: true });
    await writeFile(transcript, `${interactiveRecord(
      "turn-cached",
      "2026-07-27T11:01:00.000Z",
      "cached content",
      "session-unreadable",
    )}\n`, "utf8");
    const cached = await readClaudeLocalTranscriptHistory(projectsRoot);
    assert.deepEqual(cached.map((event) => event.turnId), ["turn-cached"]);

    await writeFile(transcript, `${interactiveRecord(
      "turn-replaced",
      "2026-07-27T11:02:00.000Z",
      "replacement content",
      "session-unreadable",
    )}\n`, "utf8");
    await chmod(transcript, 0o000);
    const unreadable = await readClaudeLocalTranscriptHistory(projectsRoot);
    assert.deepEqual(unreadable, []);

    await chmod(transcript, 0o600);
    const recovered = await readClaudeLocalTranscriptHistory(projectsRoot);
    assert.deepEqual(recovered.map((event) => event.turnId), ["turn-replaced"]);
  } finally {
    await chmod(transcript, 0o600).catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude native transcript rebuilds a same-size change outside the recent tail region", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-rewrite-"));
  const projectsRoot = join(root, "projects");
  const projectDirectory = join(projectsRoot, "project");
  const transcript = join(projectDirectory, "session-rewrite.jsonl");
  const padding = userRecord({
    uuid: "hidden-padding",
    promptId: "hidden-padding",
    content: "x".repeat(8_192),
    sessionId: "session-rewrite",
    isMeta: true,
  });
  try {
    await mkdir(projectDirectory, { recursive: true });
    const before = `${interactiveRecord(
      "turn-rewrite",
      "2026-07-27T11:02:00.000Z",
      "private prompt A",
      "session-rewrite",
    )}\n${padding}\n`;
    const after = before.replace("private prompt A", "private prompt B");
    assert.equal(Buffer.byteLength(after), Buffer.byteLength(before));
    await writeFile(transcript, before, "utf8");
    const first = await readClaudeLocalTranscriptHistory(projectsRoot);
    assert.equal(first[0]?.prompt, "private prompt A");

    await writeFile(transcript, after, "utf8");
    const future = new Date(Date.now() + 1_000);
    await utimes(transcript, future, future);
    const rewritten = await readClaudeLocalTranscriptHistory(projectsRoot);
    assert.equal(rewritten[0]?.prompt, "private prompt B");
    assert.doesNotMatch(JSON.stringify(rewritten), /private prompt A/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude native transcript bounds retained events across files and refreshes", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-retained-"));
  const projectsRoot = join(root, "projects");
  const projectDirectory = join(projectsRoot, "project");
  try {
    await mkdir(projectDirectory, { recursive: true });
    let next = 0;
    const writeSession = async (sessionId, count) => {
      const records = [];
      for (let index = 0; index < count; index += 1) {
        const ordinal = next;
        next += 1;
        records.push(interactiveRecord(
          `turn-${ordinal}`,
          new Date(Date.UTC(2026, 6, 27, 12) + ordinal).toISOString(),
          `prompt ${ordinal}`,
          sessionId,
        ));
      }
      await writeFile(join(projectDirectory, `${sessionId}.jsonl`), `${records.join("\n")}\n`, "utf8");
    };
    await writeSession("session-a", 1_500);
    await writeSession("session-b", 1_500);
    await writeSession("session-c", 1_500);

    const initial = await readClaudeLocalTranscriptHistory(projectsRoot);
    assert.equal(initial.length, 4_000);
    assert.equal(initial.some((event) => event.turnId === "turn-0"), false);
    assert.equal(initial.some((event) => event.turnId === "turn-4499"), true);

    await writeSession("session-d", 1_000);
    const refreshed = await readClaudeLocalTranscriptHistory(projectsRoot);
    assert.equal(refreshed.length, 4_000);
    assert.equal(refreshed.some((event) => event.turnId === "turn-500"), false);
    assert.equal(refreshed.some((event) => event.turnId === "turn-5499"), true);

    await unlink(join(projectDirectory, "session-d.jsonl"));
    const backfilled = await readClaudeLocalTranscriptHistory(projectsRoot);
    assert.equal(backfilled.length, 4_000);
    assert.equal(backfilled.some((event) => event.turnId === "turn-500"), true);
    assert.equal(backfilled.some((event) => event.turnId === "turn-5499"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude native transcript bounds oversized first reads to the recent tail", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-bounded-"));
  const projectsRoot = join(root, "projects");
  const projectDirectory = join(projectsRoot, "project");
  const transcript = join(projectDirectory, "session-oversized.jsonl");
  try {
    await mkdir(projectDirectory, { recursive: true });
    const recent = interactiveRecord(
      "turn-from-bounded-tail",
      "2026-07-27T11:03:00.000Z",
      "recent bounded tail",
      "session-oversized",
    );
    await writeFile(transcript, Buffer.concat([
      Buffer.alloc(8 * 1024 * 1024 + 1_024, 0x78),
      Buffer.from(`\n${recent}\n`, "utf8"),
    ]));

    const bounded = await readClaudeLocalTranscriptHistory(projectsRoot);
    assert.deepEqual(bounded.map((event) => event.turnId), ["turn-from-bounded-tail"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function interactiveRecord(uuid, timestamp, content, sessionId = "session-incremental") {
  return userRecord({ uuid, timestamp, content, sessionId });
}

function memoryTurnTranscript({ sessionId, command, toolUseId }) {
  return [
    userRecord({
      uuid: "user-memory-rewrite",
      promptId: "turn-memory-rewrite",
      content: "Visible rewrite prompt.",
      timestamp: "2026-07-27T10:20:00.000Z",
      sessionId,
    }),
    assistantRecord({
      uuid: "assistant-memory-rewrite",
      parentUuid: "user-memory-rewrite",
      content: [{ type: "tool_use", id: toolUseId, name: "Bash", input: { command } }],
      stopReason: "tool_use",
      timestamp: "2026-07-27T10:20:01.000Z",
      sessionId,
    }),
    userRecord({
      uuid: "result-memory-rewrite",
      parentUuid: "assistant-memory-rewrite",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: "private rewrite result" }],
      timestamp: "2026-07-27T10:20:02.000Z",
      sessionId,
    }),
    assistantRecord({
      uuid: "assistant-final-rewrite",
      parentUuid: "result-memory-rewrite",
      content: [{ type: "text", text: "Visible rewrite answer." }],
      stopReason: "end_turn",
      timestamp: "2026-07-27T10:20:03.000Z",
      sessionId,
    }),
  ].join("\n") + "\n";
}

function memoryActivityTypes(events) {
  return events
    .filter((event) => event.type === "memory_cli_search" || event.type === "memory_cli_add")
    .map((event) => event.type);
}

function userRecord({
  uuid,
  promptId = uuid,
  content,
  timestamp = "2026-07-27T10:01:00.000Z",
  sessionId = "session-local",
  cwd,
  userType = "external",
  omitUserType = false,
  ...fields
}) {
  return JSON.stringify({
    type: "user",
    ...(omitUserType ? {} : { userType }),
    sessionId,
    uuid,
    promptId,
    ...(cwd ? { cwd } : {}),
    timestamp,
    message: { role: "user", content },
    ...fields,
  });
}

function assistantRecord({
  uuid,
  content,
  stopReason,
  timestamp = "2026-07-27T10:01:03.000Z",
  sessionId = "session-local",
  cwd,
  ...fields
}) {
  return JSON.stringify({
    type: "assistant",
    sessionId,
    uuid,
    ...(cwd ? { cwd } : {}),
    timestamp,
    message: { role: "assistant", stop_reason: stopReason, content },
    ...fields,
  });
}
