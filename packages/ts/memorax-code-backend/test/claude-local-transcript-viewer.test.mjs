import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  clearClaudeLocalTranscriptProjections,
  readClaudeLocalTranscriptHistory,
} from "../dist/viewer/history/claude-transcript.js";
import {
  clearMemoryViewerEvents,
  listMemoryViewerDataWithHistory,
} from "../dist/viewer/store.js";
import { projectMemoryViewerUserData } from "../dist/viewer/projection/user.js";

test.beforeEach(() => {
  clearClaudeLocalTranscriptProjections();
  clearMemoryViewerEvents();
});

test("Claude Viewer keeps native-only prompts as activity interval boundaries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-viewer-native-boundary-"));
  const memoraxCodeHome = join(root, "memorax-code-home");
  const repo = join(root, "workspace", "Claude-Repo");
  const projectsRoot = join(root, "claude-home", "projects");
  const transcriptDirectory = join(projectsRoot, "encoded-project");
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(join(repo, ".git"), { recursive: true }),
    mkdir(transcriptDirectory, { recursive: true }),
  ]);
  await writeFile(join(transcriptDirectory, "session-boundary.jsonl"), `${[
    userRecord(
      "turn-admitted",
      "2026-07-27T10:00:00.000Z",
      "private admitted prompt",
      repo,
      "session-boundary",
    ),
    userRecord(
      "turn-native-only",
      "2026-07-27T10:01:00.000Z",
      "private native-only prompt",
      repo,
      "session-boundary",
    ),
  ].join("\n")}\n`, "utf8");
  await writeTraceEvents(memoraxCodeHome, "session-boundary", [{
    type: "turn_start",
    event_id: "hook-boundary-start",
    timestamp: "2026-07-27T10:00:00.100Z",
    trace: {
      session_id: "session-boundary",
      turn_id: "turn-admitted",
      cwd: repo,
    },
    operation: "query",
    request: { prompt: "Hook prompt should be supplemented." },
  }, {
    ...memoryEvent({
      type: "memory_cli_search",
      eventId: "search-after-native-only-start",
      timestamp: "2026-07-27T10:02:00.000Z",
      capturedAt: "2026-07-27T10:01:30.000Z",
      cwd: repo,
      operation: "query",
    }),
    trace: {
      client: "claude",
      session_id: "session-boundary",
      cwd: repo,
      captured_at: "2026-07-27T10:01:30.000Z",
    },
  }]);

  const data = await listMemoryViewerDataWithHistory(
    memoraxCodeHome,
    { client: "claude" },
    { claudeProjectsRoot: projectsRoot },
  );
  const search = data.events.find(
    (event) => event.id === "claude-trace:search-after-native-only-start",
  );
  assert.equal(search?.turnId, undefined);
  assert.equal(search?.turnReferences?.[0]?.turnId, undefined);
  assert.equal(data.events.some((event) => event.turnId === "turn-native-only"), false);
  assert.doesNotMatch(JSON.stringify(data), /private native-only prompt/);
});

test("Claude Viewer admits Hook turns and associates bounded transcript references", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-viewer-"));
  const memoraxCodeHome = join(root, "memorax-code-home");
  const repo = join(root, "workspace", "Claude-Repo");
  const otherRepo = join(root, "workspace", "Other-Repo");
  const projectsRoot = join(root, "claude-home", "projects");
  const transcriptDirectory = join(projectsRoot, "encoded-project");
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(join(repo, ".git"), { recursive: true }),
    mkdir(join(otherRepo, ".git"), { recursive: true }),
    mkdir(transcriptDirectory, { recursive: true }),
  ]);
  await writeFile(join(transcriptDirectory, "session-local.jsonl"), `${[
    userRecord("turn-one", "2026-07-27T10:00:00.000Z", "private exact prompt one", repo),
    hiddenRecord(
      "hidden-turn-one",
      "user-record-turn-one",
      "2026-07-27T10:00:30.000Z",
      repo,
    ),
    assistantRecord("assistant-one", "2026-07-27T10:01:00.000Z", "private exact answer one", repo, {
      parentUuid: "hidden-turn-one",
    }),
    userRecord("turn-two", "2026-07-27T10:02:00.000Z", "private exact prompt two", repo),
    sidechainRecord(
      "sidechain-turn-two",
      "user-record-turn-two",
      "2026-07-27T10:02:15.000Z",
      repo,
    ),
    assistantRecord(
      "assistant-sidechain-descendant",
      "2026-07-27T10:02:30.000Z",
      "private sidechain answer",
      repo,
      { parentUuid: "sidechain-turn-two" },
    ),
    assistantRecord("assistant-two", "2026-07-27T10:03:00.000Z", "private exact answer two", repo, {
      parentUuid: "user-record-turn-two",
    }),
  ].join("\n")}\n`, "utf8");
  await writeTraceEvents(memoraxCodeHome, "session-local", [
    {
      type: "turn_start",
      event_id: "hook-turn-two-start",
      timestamp: "2026-07-27T10:02:00.100Z",
      trace: { session_id: "session-local", turn_id: "turn-two", cwd: repo },
      operation: "query",
      request: { prompt: "Hook prompt should be supplemented." },
    },
    memoryEvent({
      type: "memory_cli_search",
      eventId: "search-in-turn-two",
      timestamp: "2026-07-27T10:10:00.000Z",
      capturedAt: "2026-07-27T10:02:30.000Z",
      cwd: repo,
      operation: "query",
    }),
    memoryEvent({
      type: "memory_cli_search",
      eventId: "search-between-turns",
      timestamp: "2026-07-27T10:10:01.000Z",
      capturedAt: "2026-07-27T10:01:30.000Z",
      cwd: repo,
      operation: "query",
    }),
    memoryEvent({
      type: "memory_cli_search",
      eventId: "search-other-project",
      timestamp: "2026-07-27T10:10:02.000Z",
      capturedAt: "2026-07-27T10:02:30.000Z",
      cwd: otherRepo,
      operation: "query",
    }),
    {
      ...memoryEvent({
        type: "memory_cli_add",
        eventId: "buffered-add",
        timestamp: "2026-07-27T10:10:03.000Z",
        capturedAt: "2026-07-27T10:10:03.000Z",
        cwd: repo,
        operation: "writeback",
      }),
      related_turns: [
        { captured_at: "2026-07-27T10:00:30.000Z" },
        { captured_at: "2026-07-27T10:02:30.000Z" },
      ],
    },
  ]);

  const localBefore = await readClaudeLocalTranscriptHistory(projectsRoot);
  const data = await listMemoryViewerDataWithHistory(
    memoraxCodeHome,
    { client: "claude" },
    { claudeProjectsRoot: projectsRoot },
  );
  assert.equal(data.events.length, 6);
  assert.equal(data.events.filter((event) => event.type === "turn_start").length, 1);
  assert.equal(data.events.filter((event) => event.type === "turn_end").length, 1);
  assert.equal(data.events.some((event) => event.turnId === "turn-one"), false);
  assert.equal(data.events.find((event) => event.id === "claude-trace:hook-turn-two-start")?.prompt, "private exact prompt two");
  const nativeEnd = data.events.find(
    (event) => event.id === "claude-local:session-local:turn_end:turn-two",
  );
  assert.equal(nativeEnd?.answer, "private exact answer two");
  assert.equal(nativeEnd?.turnOutcome, "completed");
  assert.doesNotMatch(
    JSON.stringify(data),
    /private exact prompt one|private exact answer one|private hidden transcript content|private sidechain/,
  );
  assert.equal(data.events.find((event) => event.id === "claude-trace:search-in-turn-two")?.turnId, "turn-two");
  assert.equal(data.events.find((event) => event.id === "claude-trace:search-between-turns")?.turnId, undefined);
  assert.equal(data.events.find((event) => event.id === "claude-trace:search-other-project")?.turnId, undefined);
  const buffered = data.events.find((event) => event.id === "claude-trace:buffered-add");
  assert.equal(buffered?.turnId, undefined);
  assert.deepEqual(buffered?.turnReferences.map((reference) => reference.turnId), [undefined, "turn-two"]);
  assert.equal(data.turnEvents.filter((event) => event.eventKey === buffered?.eventKey).length, 1);
  assert.deepEqual(data.activitySummary, {
    activityCount: 6,
    recalledCount: 0,
    addCount: 1,
    searchCount: 3,
  });

  const user = projectMemoryViewerUserData(data.events);
  assert.equal(user.summary.turnCount, 1);
  assert.equal(user.summary.searchOperationCount, 3);
  assert.equal(user.summary.addedMemoryCount, 1);
  assert.doesNotMatch(JSON.stringify(user), /private exact|session-local|turn-one|turn-two/);

  const disabled = await listMemoryViewerDataWithHistory(
    memoraxCodeHome,
    { client: "claude" },
    { claudeProjectsRoot: false },
  );
  assert.equal(disabled.events.some((event) => event.id.startsWith("claude-local:")), false);
  assert.equal(disabled.events.find((event) => event.id === "claude-trace:search-in-turn-two")?.turnId, undefined);
  assert.equal(disabled.events.find((event) => event.id === "claude-trace:buffered-add")?.turnReferences?.some(
    (reference) => reference.turnId !== undefined,
  ), false);
  const localAfterDisable = await readClaudeLocalTranscriptHistory(projectsRoot);
  assert.notStrictEqual(localAfterDisable, localBefore);
});

test("Claude Viewer lets trace activities win one-to-one while native history fills missing calls", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-viewer-native-memory-"));
  const memoraxCodeHome = join(root, "memorax-code-home");
  const repo = join(root, "workspace", "Native-Activity-Repo");
  const projectsRoot = join(root, "claude-home", "projects");
  const transcriptDirectory = join(projectsRoot, "encoded-project");
  const transcriptSecrets = [
    "transcript-query-secret-a",
    "transcript-query-secret-b",
    "transcript-reason-secret",
    "transcript-token-secret",
    "/private/transcript-query-path",
    "transcript-result-secret-a",
    "transcript-result-secret-b",
  ];
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(join(repo, ".git"), { recursive: true }),
    mkdir(transcriptDirectory, { recursive: true }),
  ]);
  const records = [
    {
      type: "user",
      userType: "external",
      sessionId: "session-local",
      uuid: "user-record-before-install",
      promptId: "turn-before-install",
      cwd: repo,
      timestamp: "2026-07-27T09:00:00.000Z",
      message: { role: "user", content: "Old session prompt." },
    },
    {
      type: "assistant",
      sessionId: "session-local",
      uuid: "assistant-before-install-tool",
      parentUuid: "user-record-before-install",
      cwd: repo,
      timestamp: "2026-07-27T09:00:10.000Z",
      message: {
        role: "assistant",
        stop_reason: "tool_use",
        content: [{
          type: "tool_use",
          id: "tool-before-install",
          name: "Bash",
          input: {
            command: "memorax-cli search --query transcript-before-install-secret",
          },
        }],
      },
    },
    {
      type: "user",
      userType: "external",
      sessionId: "session-local",
      uuid: "result-before-install",
      parentUuid: "assistant-before-install-tool",
      cwd: repo,
      timestamp: "2026-07-27T09:00:11.000Z",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "tool-before-install",
          content: "<memories><facts memory_type=\"core\">transcript-before-install-result</facts></memories>",
        }],
      },
    },
    {
      type: "assistant",
      sessionId: "session-local",
      uuid: "assistant-before-install-final",
      parentUuid: "result-before-install",
      cwd: repo,
      timestamp: "2026-07-27T09:00:20.000Z",
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Old session answer." }],
      },
    },
    {
      type: "user",
      userType: "external",
      sessionId: "session-local",
      uuid: "user-record-native",
      promptId: "turn-native",
      cwd: repo,
      timestamp: "2026-07-27T10:00:00.000Z",
      message: { role: "user", content: "Use memory twice." },
    },
    {
      type: "assistant",
      sessionId: "session-local",
      uuid: "assistant-native-one",
      parentUuid: "user-record-native",
      cwd: repo,
      timestamp: "2026-07-27T10:00:10.000Z",
      message: {
        role: "assistant",
        stop_reason: "tool_use",
        content: [{
          type: "tool_use",
          id: "tool-native-search-one",
          name: "Bash",
          input: {
            command: "memorax-cli search --query transcript-query-secret-a --reason transcript-reason-secret --query-file /private/transcript-query-path --token transcript-token-secret",
          },
        }],
      },
    },
    {
      type: "user",
      userType: "external",
      sessionId: "session-local",
      uuid: "result-native-one",
      parentUuid: "assistant-native-one",
      cwd: repo,
      timestamp: "2026-07-27T10:00:11.000Z",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "tool-native-search-one",
          content: [
            "<memories>",
            "  <facts memory_type=\"core\">",
            "   - transcript-result-secret-a",
            "   - safe item two",
            "   - safe item three",
            "   - safe item four",
            "   - safe item five",
            "   - safe item six",
            "   - safe item seven",
            "  </facts>",
            "</memories>",
          ].join("\n"),
        }],
      },
    },
    {
      type: "assistant",
      sessionId: "session-local",
      uuid: "assistant-native-two",
      parentUuid: "result-native-one",
      cwd: repo,
      timestamp: "2026-07-27T10:00:10.000Z",
      message: {
        role: "assistant",
        stop_reason: "tool_use",
        content: [{
          type: "tool_use",
          id: "tool-native-search-two",
          name: "Bash",
          input: {
            command: "\"/private/install path/memorax-cli\" search --query transcript-query-secret-b",
          },
        }],
      },
    },
    {
      type: "user",
      userType: "external",
      sessionId: "session-local",
      uuid: "result-native-two",
      parentUuid: "assistant-native-two",
      cwd: repo,
      timestamp: "2026-07-27T10:00:12.000Z",
      message: {
        role: "user",
        content: [{
          type: "tool_result",
          tool_use_id: "tool-native-search-two",
          content: [
            "<memories>",
            "  <facts memory_type=\"core\">",
            "   - transcript-result-secret-b",
            "   - safe item two",
            "   - safe item three",
            "   - safe item four",
            "   - safe item five",
            "   - safe item six",
            "   - safe item seven",
            "  </facts>",
            "</memories>",
          ].join("\n"),
        }],
      },
    },
    {
      type: "assistant",
      sessionId: "session-local",
      uuid: "assistant-native-final",
      parentUuid: "result-native-two",
      cwd: repo,
      timestamp: "2026-07-27T10:00:20.000Z",
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Done." }],
      },
    },
  ];
  await writeFile(
    join(transcriptDirectory, "session-local.jsonl"),
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    "utf8",
  );
  await writeTraceEvents(memoraxCodeHome, "session-local", [memoryEvent({
    type: "memory_cli_search",
    eventId: "trace-search-native-turn",
    timestamp: "2026-07-27T10:12:30.000Z",
    capturedAt: "2026-07-27T10:00:10.000Z",
    cwd: repo,
    operation: "query",
  }), {
    type: "turn_start",
    event_id: "hook-native-turn-start",
    timestamp: "2026-07-27T10:00:00.100Z",
    trace: { session_id: "session-local", turn_id: "turn-native", cwd: repo },
    operation: "query",
    request: { prompt: "Hook prompt should be supplemented." },
  }, {
    type: "turn_end",
    event_id: "hook-native-turn-end",
    timestamp: "2026-07-27T10:00:20.100Z",
    trace: { session_id: "session-local", turn_id: "turn-native", cwd: repo },
    operation: "reply",
    response: { assistantMessage: "Hook answer should be supplemented." },
  }]);

  const data = await listMemoryViewerDataWithHistory(
    memoraxCodeHome,
    { client: "claude" },
    { claudeProjectsRoot: projectsRoot },
  );
  const searches = data.events.filter((event) => event.type === "memory_cli_search");
  assert.equal(searches.length, 2);
  assert.equal(searches.filter((event) => event.id.startsWith("claude-local:")).length, 1);
  assert.equal(searches.filter((event) => event.id === "claude-trace:trace-search-native-turn").length, 1);
  assert.equal(searches.every((event) => event.turnId === "turn-native"), true);
  const nativeSearch = searches.find((event) => event.id.startsWith("claude-local:"));
  assert.equal(nativeSearch?.content, "Claude Code invoked memory search.");
  assert.equal(nativeSearch?.query, undefined);
  assert.equal(nativeSearch?.results, undefined);
  assert.equal(nativeSearch?.itemCount, 7);
  assert.deepEqual(data.activitySummary, {
    activityCount: 4,
    recalledCount: 7,
    addCount: 0,
    searchCount: 2,
  });
  const userSummary = projectMemoryViewerUserData(data.events).summary;
  assert.equal(userSummary.searchOperationCount, 2);
  assert.equal(userSummary.searchedMemoryCount, 7);
  assert.equal(userSummary.unknownCount, 0);
  assert.doesNotMatch(
    JSON.stringify(data),
    new RegExp([...transcriptSecrets, "transcript-before-install"].join("|")),
  );
});

test("Claude Viewer source switches roots without serving the previous transcript projection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-viewer-switch-"));
  const memoraxCodeHome = join(root, "memorax-code-home");
  const firstRoot = join(root, "claude-a", "projects");
  const secondRoot = join(root, "claude-b", "projects");
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    writeTranscript(firstRoot, "session-shared", "turn-shared", "2026-07-27T11:00:00.000Z", "private A"),
    writeTranscript(secondRoot, "session-shared", "turn-shared", "2026-07-27T11:01:00.000Z", "private B"),
  ]);
  await writeTraceEvents(memoraxCodeHome, "session-shared", [{
    type: "turn_start",
    event_id: "hook-shared-start",
    timestamp: "2026-07-27T11:00:00.100Z",
    trace: { session_id: "session-shared", turn_id: "turn-shared" },
    operation: "query",
    request: { prompt: "Hook prompt should be supplemented." },
  }]);

  const first = await listMemoryViewerDataWithHistory(
    memoraxCodeHome,
    { client: "claude" },
    { claudeProjectsRoot: firstRoot },
  );
  assert.equal(first.events[0]?.prompt, "private A");

  const second = await listMemoryViewerDataWithHistory(
    memoraxCodeHome,
    { client: "claude" },
    { claudeProjectsRoot: secondRoot },
  );
  assert.equal(second.events[0]?.prompt, "private B");
  assert.doesNotMatch(JSON.stringify(second), /private A/);
});

test("Claude Viewer refuses to coalesce matching turn identities across projects", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-viewer-project-"));
  const memoraxCodeHome = join(root, "memorax-code-home");
  const nativeRepo = join(root, "workspace", "Native-Repo");
  const traceRepo = join(root, "workspace", "Trace-Repo");
  const projectsRoot = join(root, "claude-home", "projects");
  const transcriptDirectory = join(projectsRoot, "encoded-project");
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(join(nativeRepo, ".git"), { recursive: true }),
    mkdir(join(traceRepo, ".git"), { recursive: true }),
    mkdir(transcriptDirectory, { recursive: true }),
  ]);
  await writeFile(
    join(transcriptDirectory, "cross-project-session.jsonl"),
    `${[
      userRecord(
        "shared-turn",
        "2026-07-27T12:00:00.000Z",
        "private native project prompt",
        nativeRepo,
        "cross-project-session",
      ),
      JSON.stringify({
        type: "assistant",
        sessionId: "cross-project-session",
        uuid: "cross-project-tool",
        parentUuid: "user-record-shared-turn",
        cwd: nativeRepo,
        timestamp: "2026-07-27T12:00:10.000Z",
        message: {
          role: "assistant",
          stop_reason: "tool_use",
          content: [{
            type: "tool_use",
            id: "cross-project-tool-use",
            name: "Bash",
            input: { command: "memorax-cli search --query private-cross-project-query" },
          }],
        },
      }),
      JSON.stringify({
        type: "user",
        userType: "external",
        sessionId: "cross-project-session",
        uuid: "cross-project-result",
        parentUuid: "cross-project-tool",
        cwd: nativeRepo,
        timestamp: "2026-07-27T12:00:11.000Z",
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "cross-project-tool-use",
            content: "<memories><facts memory_type=\"core\">private-cross-project-result</facts></memories>",
          }],
        },
      }),
      assistantRecord(
        "cross-project-final",
        "2026-07-27T12:00:20.000Z",
        "private native project answer",
        nativeRepo,
        {
          parentUuid: "cross-project-result",
          sessionId: "cross-project-session",
        },
      ),
      userRecord(
        "unscoped-hook-turn",
        "2026-07-27T12:01:00.000Z",
        "private scoped prompt for unscoped Hook",
        nativeRepo,
        "cross-project-session",
      ),
    ].join("\n")}\n`,
    "utf8",
  );
  await writeTraceEvents(memoraxCodeHome, "cross-project-session", [{
    type: "turn_start",
    event_id: "cross-project-hook",
    timestamp: "2026-07-27T12:00:00.100Z",
    trace: {
      session_id: "cross-project-session",
      turn_id: "shared-turn",
      cwd: traceRepo,
    },
    operation: "query",
    request: { prompt: "trace project prompt" },
  }, {
    type: "turn_start",
    event_id: "unscoped-hook",
    timestamp: "2026-07-27T12:01:00.100Z",
    trace: {
      session_id: "cross-project-session",
      turn_id: "unscoped-hook-turn",
    },
    operation: "query",
    request: { prompt: "unscoped Hook prompt" },
  }]);

  const data = await listMemoryViewerDataWithHistory(
    memoraxCodeHome,
    { client: "claude" },
    { claudeProjectsRoot: projectsRoot },
  );
  assert.equal(data.events.length, 2);
  const crossProject = data.events.find((event) => event.id === "claude-trace:cross-project-hook");
  assert.equal(crossProject?.projectLabel, "Trace-Repo");
  assert.equal(crossProject?.prompt, "trace project prompt");
  assert.equal(
    data.events.find((event) => event.id === "claude-trace:unscoped-hook")?.prompt,
    "unscoped Hook prompt",
  );
  assert.doesNotMatch(
    JSON.stringify(data),
    /private native project|private scoped prompt|private-cross-project|Native-Repo/,
  );
});

test("Claude Viewer materializes interrupted Turns with their partial reply", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-viewer-interrupted-"));
  const repo = join(root, "workspace", "Claude-Repo");
  const projectsRoot = join(root, "claude-home", "projects");
  const transcriptDirectory = join(projectsRoot, "encoded-project");
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(join(repo, ".git"), { recursive: true }),
    mkdir(transcriptDirectory, { recursive: true }),
  ]);
  await writeFile(join(transcriptDirectory, "session-interrupted.jsonl"), `${[
    userRecord("turn-interrupted", "2026-07-27T13:00:00.000Z", "private interrupted prompt", repo, "session-interrupted"),
    assistantRecord("assistant-partial", "2026-07-27T13:00:30.000Z", "private partial reply", repo, {
      messageId: "message-partial",
      parentUuid: "user-record-turn-interrupted",
      sessionId: "session-interrupted",
      stopReason: null,
    }),
    interruptedRecord("message-partial", "assistant-partial", "2026-07-27T13:00:31.000Z", repo, "session-interrupted"),
  ].join("\n")}\n`, "utf8");

  const events = await readClaudeLocalTranscriptHistory(projectsRoot);
  const end = events.find((event) => event.type === "turn_end");
  assert.equal(end?.turnId, "turn-interrupted");
  assert.equal(end?.turnOutcome, "interrupted");
  assert.equal(end?.answer, "private partial reply");
  assert.equal(end?.ok, false);
});

test("Claude Viewer user summary treats max_tokens as interrupted", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-viewer-max-tokens-"));
  const memoraxCodeHome = join(root, "memorax-code-home");
  const repo = join(root, "workspace", "Claude-Repo");
  const projectsRoot = join(root, "claude-home", "projects");
  const transcriptDirectory = join(projectsRoot, "encoded-project");
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(join(repo, ".git"), { recursive: true }),
    mkdir(transcriptDirectory, { recursive: true }),
  ]);
  await writeFile(join(transcriptDirectory, "session-max-tokens.jsonl"), `${[
    userRecord(
      "turn-max-tokens",
      "2026-07-27T13:30:00.000Z",
      "private long prompt",
      repo,
      "session-max-tokens",
    ),
    assistantRecord("assistant-truncated", "2026-07-27T13:30:30.000Z", "private truncated reply", repo, {
      parentUuid: "user-record-turn-max-tokens",
      sessionId: "session-max-tokens",
      stopReason: "max_tokens",
    }),
  ].join("\n")}\n`, "utf8");
  await writeTraceEvents(memoraxCodeHome, "session-max-tokens", [
    {
      type: "turn_start",
      event_id: "hook-max-tokens-start",
      timestamp: "2026-07-27T13:30:00.100Z",
      trace: { session_id: "session-max-tokens", turn_id: "turn-max-tokens", cwd: repo },
      operation: "query",
      request: { prompt: "Hook prompt should be supplemented." },
    },
    {
      type: "turn_end",
      event_id: "hook-max-tokens-end",
      timestamp: "2026-07-27T13:30:30.100Z",
      trace: { session_id: "session-max-tokens", turn_id: "turn-max-tokens", cwd: repo },
      operation: "reply",
      outcome: "completed",
      response: { assistantMessage: "Hook reply should be supplemented." },
    },
  ]);

  const events = await readClaudeLocalTranscriptHistory(projectsRoot);
  const end = events.find((event) => event.type === "turn_end");
  assert.equal(end?.turnOutcome, "interrupted");
  assert.equal(end?.answer, "private truncated reply");
  assert.equal(end?.ok, false);

  const data = await listMemoryViewerDataWithHistory(
    memoraxCodeHome,
    { client: "claude" },
    { claudeProjectsRoot: projectsRoot },
  );
  assert.equal(
    data.events.find((event) => event.id === "claude-trace:hook-max-tokens-end")?.turnOutcome,
    "interrupted",
  );
  const user = projectMemoryViewerUserData(data.events);
  assert.equal(user.activities.find((activity) => activity.kind === "turn")?.status, "interrupted");
  assert.doesNotMatch(
    JSON.stringify(user),
    /private long prompt|private truncated reply|Hook prompt|Hook reply|session-max-tokens|turn-max-tokens/,
  );
});

test("Claude Viewer withholds ambiguous retry branches", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-viewer-retry-"));
  const repo = join(root, "workspace", "Claude-Repo");
  const projectsRoot = join(root, "claude-home", "projects");
  const transcriptDirectory = join(projectsRoot, "encoded-project");
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(join(repo, ".git"), { recursive: true }),
    mkdir(transcriptDirectory, { recursive: true }),
  ]);
  await writeFile(join(transcriptDirectory, "session-retry.jsonl"), `${[
    userRecord("turn-retry", "2026-07-27T14:00:00.000Z", "private retry prompt", repo, "session-retry"),
    assistantRecord("assistant-first", "2026-07-27T14:00:30.000Z", "private first branch", repo, {
      parentUuid: "user-record-turn-retry",
      sessionId: "session-retry",
    }),
    assistantRecord("assistant-second", "2026-07-27T14:00:31.000Z", "private second branch", repo, {
      parentUuid: "user-record-turn-retry",
      sessionId: "session-retry",
    }),
  ].join("\n")}\n`, "utf8");

  const events = await readClaudeLocalTranscriptHistory(projectsRoot);
  assert.equal(events.filter((event) => event.type === "turn_start").length, 1);
  assert.equal(events.filter((event) => event.type === "turn_end").length, 0);
  assert.doesNotMatch(JSON.stringify(events), /private first branch|private second branch/);
});

test("Claude Viewer clears rejected explicit Turn references", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-viewer-turn-reference-"));
  const memoraxCodeHome = join(root, "memorax-code-home");
  const repo = join(root, "workspace", "Claude-Repo");
  const otherRepo = join(root, "workspace", "Other-Repo");
  const projectsRoot = join(root, "claude-home", "projects");
  const transcriptDirectory = join(projectsRoot, "encoded-project");
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(join(repo, ".git"), { recursive: true }),
    mkdir(join(otherRepo, ".git"), { recursive: true }),
    mkdir(transcriptDirectory, { recursive: true }),
  ]);
  await writeFile(join(transcriptDirectory, "session-local.jsonl"), `${[
    userRecord("turn-one", "2026-07-27T15:00:00.000Z", "private exact prompt", repo),
    assistantRecord("assistant-one", "2026-07-27T15:01:00.000Z", "private exact answer", repo, {
      parentUuid: "user-record-turn-one",
    }),
  ].join("\n")}\n`, "utf8");
  await writeTraceEvents(memoraxCodeHome, "session-local", [
    {
      ...memoryEvent({
        type: "memory_cli_search",
        eventId: "stale-prelabeled-search",
        timestamp: "2026-07-27T15:02:00.000Z",
        capturedAt: "2026-07-27T15:01:30.000Z",
        cwd: repo,
        operation: "query",
      }),
      trace: {
        client: "claude",
        session_id: "session-local",
        turn_id: "turn-one",
        cwd: repo,
        captured_at: "2026-07-27T15:01:30.000Z",
      },
    },
    {
      ...memoryEvent({
        type: "memory_cli_add",
        eventId: "cross-project-buffered-add",
        timestamp: "2026-07-27T15:02:01.000Z",
        capturedAt: "2026-07-27T15:00:30.000Z",
        cwd: otherRepo,
        operation: "writeback",
      }),
      related_turns: [{ turn_id: "turn-one", captured_at: "2026-07-27T15:00:30.000Z" }],
    },
  ]);

  const data = await listMemoryViewerDataWithHistory(
    memoraxCodeHome,
    { client: "claude" },
    { claudeProjectsRoot: projectsRoot },
  );
  const search = data.events.find((event) => event.id === "claude-trace:stale-prelabeled-search");
  assert.equal(search?.turnId, undefined);
  assert.equal(search?.turnReferences?.[0]?.turnId, undefined);
  const add = data.events.find((event) => event.id === "claude-trace:cross-project-buffered-add");
  assert.equal(add?.turnId, undefined);
  assert.equal(add?.turnReferences?.[0]?.turnId, undefined);
});

function userRecord(turnId, timestamp, content, cwd, sessionId = "session-local") {
  return JSON.stringify({
    type: "user",
    userType: "external",
    sessionId,
    uuid: `user-record-${turnId}`,
    promptId: turnId,
    cwd,
    timestamp,
    message: { role: "user", content },
  });
}

function assistantRecord(uuid, timestamp, content, cwd, options = {}) {
  return JSON.stringify({
    type: "assistant",
    userType: "external",
    sessionId: options.sessionId ?? "session-local",
    uuid,
    ...(options.parentUuid ? { parentUuid: options.parentUuid } : {}),
    cwd,
    timestamp,
    message: {
      ...(options.messageId ? { id: options.messageId } : {}),
      role: "assistant",
      stop_reason: options.stopReason === undefined ? "end_turn" : options.stopReason,
      content: [{ type: "text", text: content }],
    },
  });
}

function hiddenRecord(uuid, parentUuid, timestamp, cwd, sessionId = "session-local") {
  return JSON.stringify({
    type: "user",
    userType: "external",
    isMeta: true,
    sessionId,
    uuid,
    parentUuid,
    cwd,
    timestamp,
    message: {
      role: "user",
      content: "private hidden transcript content",
    },
  });
}

function sidechainRecord(uuid, parentUuid, timestamp, cwd, sessionId = "session-local") {
  return JSON.stringify({
    type: "user",
    userType: "external",
    isSidechain: true,
    sessionId,
    uuid,
    parentUuid,
    cwd,
    timestamp,
    message: {
      role: "user",
      content: "private sidechain transcript content",
    },
  });
}

function interruptedRecord(interruptedMessageId, parentUuid, timestamp, cwd, sessionId) {
  return JSON.stringify({
    type: "user",
    userType: "external",
    sessionId,
    uuid: `interrupted-${interruptedMessageId}`,
    parentUuid,
    interruptedMessageId,
    cwd,
    timestamp,
    message: { role: "user", content: "" },
  });
}

function memoryEvent({ type, eventId, timestamp, capturedAt, cwd, operation }) {
  return {
    type,
    event_id: eventId,
    timestamp,
    trace: {
      client: "claude",
      session_id: "session-local",
      cwd,
      captured_at: capturedAt,
    },
    source: "memory_cli",
    operation,
    ok: true,
    request: operation === "writeback"
      ? { payload: { messages: [{ role: "user", content: "private memory add" }] } }
      : { payload: { query: "private memory query" } },
    response: operation === "writeback"
      ? { status: "saved", outcome: "saved", savedMemoryCount: 1 }
      : { items: [] },
  };
}

async function writeTraceEvents(memoraxCodeHome, sessionId, events) {
  const directory = join(memoraxCodeHome, "debug", "traces", "claude", "sessions", sessionId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`, "utf8");
}

async function writeTranscript(projectsRoot, sessionId, turnId, timestamp, content) {
  const directory = join(projectsRoot, "encoded-project");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${sessionId}.jsonl`), `${JSON.stringify({
    type: "user",
    userType: "external",
    sessionId,
    uuid: turnId,
    timestamp,
    message: { role: "user", content },
  })}\n`, "utf8");
}
