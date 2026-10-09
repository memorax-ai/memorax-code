import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parsePreCompactCommand,
  parseSkillReminderCommand,
  parseTurnStartCommand,
  parseWritebackCommand,
} from "../../dist/memory/hook-command.js";
import { contentTurnId, memoryHookCommands } from "../support/memory-hook-commands.mjs";

const INVALID = { ok: false, error: "invalid memory Hook command" };

test("Cursor pre-compact accepts only native identity and absolute local paths", () => {
  const { start } = memoryHookCommands().find(({ start }) => start.client === "cursor");
  const { prompt, ...command } = start;
  assert.deepEqual(parsePreCompactCommand(command), { ok: true, command });
  const { transcriptPath, ...withoutTranscript } = command;
  assert.deepEqual(parsePreCompactCommand(withoutTranscript), { ok: true, command: withoutTranscript });
  for (const [name, fields] of [
    ["missing version", { version: undefined }],
    ["unsupported version", { version: 2 }],
    ["missing client", { client: undefined }],
    ["foreign client", { client: "codex" }],
    ["unknown client", { client: "unknown-client" }],
    ["missing conversation", { sessionId: undefined }],
    ["invalid conversation", { sessionId: "session" }],
    ["missing generation", { turnId: undefined }],
    ["invalid generation", { turnId: "generation" }],
    ["missing workspace", { cwd: undefined }],
    ["relative workspace", { cwd: "workspace" }],
    ["NUL workspace", { cwd: "/tmp/workspace\0" }],
    ["missing database", { databasePath: undefined }],
    ["relative database", { databasePath: "state.vscdb" }],
    ["NUL database", { databasePath: "/tmp/state.vscdb\0" }],
    ["relative transcript", { transcriptPath: "transcript.jsonl" }],
    ["NUL transcript", { transcriptPath: "/tmp/transcript.jsonl\0" }],
    ["invalid transcript", { transcriptPath: null }],
    ["prompt is not an observation field", { prompt: "Do not register a turn." }],
    ["content is not authority", { content: "Not native context." }],
    ["trigger is not success authority", { trigger: "manual" }],
    ["workspace classification is not accepted", { workspaceKind: "general" }],
    ["unknown field", { unexpected: true }],
  ]) {
    assert.deepEqual(parsePreCompactCommand({ ...command, ...fields }), INVALID, name);
  }
});

const invalidFields = {
  cursor: {
    start: [
      ["missing database authority", { databasePath: undefined }],
      ["relative database path", { databasePath: "state.vscdb" }],
      ["missing generation", { turnId: undefined }],
      ["invalid conversation", { sessionId: "not-a-conversation" }],
      ["missing workspace", { cwd: undefined }],
      ["absent prompt observation", { prompt: undefined }],
      ["foreign prompt identity", { promptId: "claude-prompt" }],
    ],
    writeback: [
      ["missing database authority", { databasePath: undefined }],
      ["native response fallback forbidden", { lastAssistantMessage: "Hook text" }],
      ["stop cannot carry response digest", { responseDigest: "a".repeat(64) }],
      ["unknown completion status", { status: "success" }],
      ["non-string status", { status: ["completed"] }],
      ["missing generation", { turnId: undefined }],
    ],
  },
  codex: {
    start: [
      ["unknown field", { unexpected: true }],
      ["invalid optional turn id", { turnId: 42 }],
    ],
    writeback: [
      ["snake-case identity", { session_id: "session-codex" }],
      ["Claude identity", { promptId: "wrong-client-field" }],
      ["invalid optional transcript path", { transcriptPath: 42 }],
    ],
  },
  "claude-code": {
    start: [
      ["Codex identity", { turnId: "wrong-client-field" }],
      ["invalid optional cwd", { cwd: {} }],
    ],
    writeback: [
      ["missing prompt identity", { promptId: undefined }],
      ["Codex identity", { turnId: "wrong-client-field" }],
      ["invalid optional workspace kind", { workspaceKind: {} }],
    ],
  },
  opencode: {
    start: [["foreign transcript authority", { transcriptPath: "/tmp/opencode.jsonl" }]],
    writeback: [
      ["Hook text authority", { lastAssistantMessage: "Not SDK content." }],
      ["invalid messages container", { messages: {} }],
    ],
  },
  dsh: {
    start: [["foreign transcript authority", { transcriptPath: "/tmp/dsh.jsonl" }]],
    writeback: [
      ["invalid events container", { events: {} }],
      ["invalid event interval", { endSeq: -1 }],
    ],
  },
  codebuddy: {
    start: [
      ["malformed turn id", { turnId: "session-codebuddy:0:short" }],
      ["cross-session turn id", { turnId: contentTurnId("other-session", 0, "Hook prompt.") }],
      ["prompt-mismatched turn id", { prompt: "Different prompt." }],
    ],
    writeback: [["non-canonical boundary", { turnId: `session-codebuddy:00:${"a".repeat(64)}` }]],
  },
  trae: {
    start: [
      ["foreign transcript authority", { transcriptPath: "/tmp/trae.jsonl" }],
      ["cross-session turn id", { turnId: contentTurnId("other-session", 1_700_000_000_000, "Hook prompt.") }],
      ["prompt-mismatched turn id", { prompt: "Different prompt." }],
      ["non-canonical timestamp", { turnId: `session-trae:01:${"a".repeat(64)}` }],
    ],
    writeback: [
      ["prompt-mismatched turn id", { prompt: "Different prompt." }],
      ["missing assistant authority", { lastAssistantMessage: " " }],
      ["foreign message authority", { messages: [] }],
      ["non-finite assistant observation", { assistantObservedAt: Number.NaN }],
      ["infinite assistant observation", { assistantObservedAt: Number.POSITIVE_INFINITY }],
      ["out-of-range assistant observation", { assistantObservedAt: 8_640_000_000_000_001 }],
      ["fractional assistant observation", { assistantObservedAt: 1_700_000_000_000.5 }],
      ["epoch-second assistant observation", { assistantObservedAt: 1_700_000_000 }],
      ["string assistant observation", { assistantObservedAt: "1700000000000" }],
      ["null assistant observation", { assistantObservedAt: null }],
    ],
  },
};

test("memory Hook commands require a versioned known client", () => {
  const { start } = memoryHookCommands()[0];
  for (const [name, fields] of [
    ["missing version", { version: undefined }],
    ["unsupported version", { version: 2 }],
    ["missing client", { client: undefined }],
    ["unknown client", { client: "unknown-client" }],
  ]) {
    assert.deepEqual(parseTurnStartCommand({ ...start, ...fields }), INVALID, name);
  }
});

for (const commands of memoryHookCommands()) {
  const { client } = commands.start;
  test(`${client} Hook commands preserve valid content and reject foreign or invalid fields`, () => {
    for (const [operation, parse] of [["start", parseTurnStartCommand], ["writeback", parseWritebackCommand]]) {
      const command = commands[operation];
      assert.deepEqual(parse(command), { ok: true, command }, `${operation}: valid command`);
      for (const [name, fields] of invalidFields[client === "workbuddy" ? "codebuddy" : client][operation]) {
        assert.deepEqual(parse({ ...command, ...fields }), INVALID, `${operation}: ${name}`);
      }
    }
  });
}

test("Trae reminder commands preserve Hook correlation without foreign transcript authority", () => {
  const { start } = memoryHookCommands().find(({ start }) => start.client === "trae");
  const { prompt, ...identity } = start;
  const command = { ...identity, content: "Use the memorax-code skill.", triggers: ["cadence"] };
  assert.deepEqual(parseSkillReminderCommand(command), { ok: true, command });
  const guided = { ...command, triggers: ["search_guidance"] };
  assert.deepEqual(parseSkillReminderCommand(guided), { ok: true, command: guided });
  assert.deepEqual(parseSkillReminderCommand({ ...command, transcriptPath: "/tmp/trae.jsonl" }), INVALID);
});

test("Cursor response digests and empty continuation prompts retain exact native identity", () => {
  const { start } = memoryHookCommands().find(({ start }) => start.client === "cursor");
  const { prompt, ...identity } = start;
  const response = { ...identity, phase: "response", responseDigest: "a".repeat(64) };
  assert.deepEqual(parseWritebackCommand(response), { ok: true, command: response });
  for (const fields of [{ status: "completed" }, { responseDigest: "A".repeat(64) }, { responseDigest: "short" }]) {
    assert.deepEqual(parseWritebackCommand({ ...response, ...fields }), INVALID);
  }
  const continuation = { ...start, prompt: "" };
  assert.deepEqual(parseTurnStartCommand(continuation), { ok: true, command: continuation });
  const { transcriptPath, ...firstPrompt } = start;
  assert.deepEqual(parseTurnStartCommand(firstPrompt), { ok: true, command: firstPrompt });
  const reminder = { ...identity, content: "Use the memorax-code skill.", triggers: ["cadence"] };
  delete reminder.transcriptPath;
  delete reminder.databasePath;
  assert.deepEqual(parseSkillReminderCommand(reminder), { ok: true, command: reminder });
});

test("Cursor Hook commands preserve native path bytes without accepting blank paths", () => {
  const { start, writeback } = memoryHookCommands().find(({ start }) => start.client === "cursor");
  const paths = {
    cwd: start.cwd + " ", databasePath: start.databasePath + " ", transcriptPath: start.transcriptPath + " ",
  };
  const { prompt, ...identity } = { ...start, ...paths };
  const { databasePath, transcriptPath, ...reminderIdentity } = identity;
  const commands = [
    ["turn-start", parseTurnStartCommand, { ...identity, prompt }],
    ["writeback-response", parseWritebackCommand, { ...identity, phase: "response", responseDigest: "a".repeat(64) }],
    ["writeback-stop", parseWritebackCommand, { ...writeback, ...paths }],
    ["pre-compact", parsePreCompactCommand, identity],
    ["skill-reminder", parseSkillReminderCommand, {
      ...reminderIdentity, content: "Use the memorax-code skill.", triggers: ["cadence"],
    }],
  ];
  for (const [name, parse, command] of commands) {
    assert.deepEqual(parse(command), { ok: true, command }, name + ": exact paths");
    for (const field of ["cwd", "databasePath", "transcriptPath"]) {
      if (!(field in command)) continue;
      for (const value of [" ", null]) {
        assert.deepEqual(parse({ ...command, [field]: value }), INVALID, name + ": invalid " + field);
      }
    }
  }
});

test("Cursor projectless Hook commands preserve General identity without a workspace", () => {
  const { start } = memoryHookCommands().find(({ start }) => start.client === "cursor");
  const projectlessIdentity = { ...start };
  delete projectlessIdentity.cwd;
  delete projectlessIdentity.transcriptPath;
  delete projectlessIdentity.prompt;
  const projectless = { ...projectlessIdentity, workspaceKind: "projectless" };
  const turnStart = { ...projectless, prompt: "A projectless Cursor prompt." };
  assert.deepEqual(parseTurnStartCommand(turnStart), { ok: true, command: turnStart });

  const response = { ...projectless, phase: "response", responseDigest: "a".repeat(64) };
  assert.deepEqual(parseWritebackCommand(response), { ok: true, command: response });
  const preCompact = { ...projectless };
  assert.deepEqual(parsePreCompactCommand(preCompact), { ok: true, command: preCompact });
  const reminder = { ...projectless, content: "Use the memorax-code skill.", triggers: ["cadence"] };
  delete reminder.databasePath;
  assert.deepEqual(parseSkillReminderCommand(reminder), { ok: true, command: reminder });

  assert.deepEqual(parseTurnStartCommand({ ...projectless, workspaceKind: "general", prompt: "invalid" }), INVALID);
  assert.deepEqual(parseTurnStartCommand({ ...projectlessIdentity, prompt: "missing classification" }), INVALID);
});

test("Cursor Hook commands require exactly one workspace identity", () => {
  const { start, writeback } = memoryHookCommands().find(({ start }) => start.client === "cursor");
  const { prompt, ...identity } = start;
  const { databasePath, transcriptPath, ...reminderIdentity } = identity;
  const commands = [
    ["turn-start", parseTurnStartCommand, start],
    ["writeback-response", parseWritebackCommand, { ...identity, phase: "response", responseDigest: "a".repeat(64) }],
    ["writeback-stop", parseWritebackCommand, writeback],
    ["pre-compact", parsePreCompactCommand, identity],
    ["skill-reminder", parseSkillReminderCommand, {
      ...reminderIdentity, content: "Use the memorax-code skill.", triggers: ["cadence"],
    }],
  ];
  for (const [name, parse, command] of commands) {
    assert.deepEqual(parse(command), { ok: true, command }, name + ": workspace");
    const { cwd, ...withoutWorkspace } = command;
    const projectless = { ...withoutWorkspace, workspaceKind: "projectless" };
    assert.deepEqual(parse(projectless), { ok: true, command: projectless }, name + ": projectless");
  }
  assert.deepEqual(
    commands.map(([name, parse, command]) => [name, parse({ ...command, workspaceKind: "projectless" })]),
    commands.map(([name]) => [name, INVALID]),
  );
});
