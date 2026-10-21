import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { disableQoderAdapter, enableQoderAdapter } from "../src/config.mjs";
import { fixture, hook, hookInput, json } from "./support.mjs";

test("SessionStart accepts a not-yet-created native transcript and ensures only the Backend", async (t) => {
  const f = await fixture(t, { server: true });
  const input = hookInput(f, { hook_event_name: "SessionStart", request_set_id: undefined, prompt: undefined });
  assert.equal(existsSync(input.transcript_path), false);
  const result = await hook(f, input, { MEMORAX_CODE_HOME: join(f.root, "unrelated-home") });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.deepEqual(f.requests.map((entry) => entry.path), ["/health"]);
  const observation = await json(join(f.memoraxCodeHome, "adapters", "qoder", "runtime-observed.json"));
  assert.equal(observation.runtimeDigest, f.installed.runtimeDigest);
  assert.equal(observation.qoderHome, f.qoderHome);
});

test("Submit preserves native request identity, prompt and paths, and shares reminder helpers", async (t) => {
  const f = await fixture(t, { server: true });
  f.notice = "Synthetic quota notice.";
  const procedure = join(f.memoraxCodeHome, "personal-memory", "procedure-memory");
  await mkdir(procedure, { recursive: true });
  await writeFile(join(procedure, "checks.md"), "# Checks\n\nRun the focused Qoder adapter tests.\n");
  const input = hookInput(f, { prompt: "  Synthetic Unicode 用户 prompt.\r\nPreserve line breaks.  ", cwd: `${f.root} `, transcript_path: `${f.root}/native path.jsonl ` });
  const result = await hook(f, input);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.requests[0], { path: "/memory/turn-start", body: {
    version: 1, client: "qoder", sessionId: input.session_id, turnId: input.request_set_id,
    transcriptPath: input.transcript_path, cwd: input.cwd, prompt: input.prompt,
  } });
  assert.equal(f.requests.some((entry) => entry.path === "/memory/search-guidance"), true);
  const output = JSON.parse(result.stdout);
  assert.equal(output.systemMessage, f.notice);
  assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(output.hookSpecificOutput.additionalContext, /memorax-code/);
  assert.match(output.hookSpecificOutput.additionalContext, /focused Qoder adapter tests/);
  const trace = f.requests.find((entry) => entry.path === "/memory/skill-reminder");
  assert.equal(trace.body.client, "qoder");
  assert.equal(trace.body.turnId, input.request_set_id);
  assert.equal(trace.body.transcriptPath, input.transcript_path);
});

test("unrecorded or rejected turns retain local guidance but do not request search guidance or trace reminders", async (t) => {
  const f = await fixture(t, { server: true });
  f.recorded = false;
  let result = await hook(f, hookInput(f));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /additionalContext/);
  assert.deepEqual(f.requests.map((entry) => entry.path), ["/memory/turn-start"]);
  f.rejectTurnStart = true;
  f.requests.length = 0;
  result = await hook(f, hookInput(f, { session_id: "rejected-session", request_set_id: "rejected-turn" }));
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.requests.map((entry) => entry.path), ["/memory/turn-start"]);
});

test("managed default chat Hooks consistently carry projectless scope while ordinary paths cannot claim it", async (t) => {
  const f = await fixture(t, { server: true });
  const cwd = join(f.home, "Documents", "Qoder", "2026-10-06", "ab1234ef");
  await mkdir(cwd, { recursive: true });
  const input = hookInput(f, { cwd });
  const result = await hook(f, input);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(f.requests.map((entry) => entry.path), [
    "/memory/turn-start", "/memory/search-guidance", "/memory/skill-reminder",
  ]);
  for (const { body } of f.requests) {
    assert.equal(body.workspaceKind, "projectless");
    assert.equal(body.cwd, cwd);
  }
  await hook(f, { ...input, hook_event_name: "QueryEnd", reason: "end_turn" });
  assert.equal(f.requests.at(-1).path, "/memory/writeback");
  assert.equal(f.requests.at(-1).body.workspaceKind, "projectless");
  assert.equal(f.requests.at(-1).body.cwd, cwd);

  f.requests.length = 0;
  await hook(f, hookInput(f, { session_id: "ordinary-session", workspaceKind: "projectless", workspace_kind: "projectless" }));
  assert.equal(f.requests[0].path, "/memory/turn-start");
  for (const { body } of f.requests) assert.equal(body.workspaceKind, undefined);
});

test("managed default chat notification candidates keep projectless scope through delayed registration", async (t) => {
  const f = await fixture(t, { server: true });
  const cwd = join(f.home, "Documents", "Qoder", "2026-10-06", "ab1234ef");
  await mkdir(cwd, { recursive: true });
  const input = hookInput(f, { cwd,
    prompt: "<task-notification><task-id>synthetic-task</task-id><status>completed</status></task-notification>",
  });
  assert.equal((await hook(f, input)).stdout, "");
  assert.deepEqual(f.requests, []);
  await hook(f, { ...input, hook_event_name: "QueryEnd", reason: "end_turn" });
  assert.deepEqual(f.requests.map((entry) => entry.path), ["/memory/turn-start", "/memory/writeback"]);
  for (const { body } of f.requests) {
    assert.equal(body.workspaceKind, "projectless");
    assert.equal(body.cwd, cwd);
  }
  assert.equal(f.requests[0].body.prompt, input.prompt);
});

test("QueryEnd sends exact completion or abort identity and never sends Hook text as content", async (t) => {
  const f = await fixture(t, { server: true });
  for (const [reason, status] of [["end_turn", "completed"], ["abort", "aborted"]]) {
    const input = hookInput(f, { hook_event_name: "QueryEnd", reason, last_assistant_message: "Non-authoritative Hook text." });
    const result = await hook(f, input);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.deepEqual(f.requests.at(-1), { path: "/memory/writeback", body: {
      version: 1, client: "qoder", sessionId: input.session_id, turnId: input.request_set_id,
      transcriptPath: input.transcript_path, cwd: input.cwd, status,
    } });
  }
  const before = f.requests.length;
  for (const overrides of [
    { hook_event_name: "Stop", parent_request_set_id: "qoder-turn-1", last_assistant_message: "No Add." },
    { hook_event_name: "QueryEnd", reason: "error" },
    { hook_event_name: "QueryEnd", reason: "max_turns" },
    { hook_event_name: "QueryEnd", reason: "tool_use" },
  ]) assert.equal((await hook(f, hookInput(f, overrides))).status, 0);
  assert.equal(f.requests.length, before);
});

test("missing, malformed or conflicting native identity fails before transport", async (t) => {
  const f = await fixture(t, { server: true });
  for (const invalid of [
    { session_id: "" }, { session_id: " session " }, { session_id: "session\nother" }, { session_id: "session\tother" },
    { request_set_id: undefined }, { request_set_id: "" }, { prompt: " " },
    { cwd: "relative" }, { cwd: `${f.root}\0other` },
    { transcript_path: "relative.jsonl" }, { transcript_path: `${f.root}/file\0other` },
    { sessionId: "conflicting-session" }, { requestSetId: "conflicting-turn" },
    { transcriptPath: join(f.root, "other.jsonl") },
  ]) {
    const result = await hook(f, hookInput(f, invalid));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  }
  assert.deepEqual(f.requests, []);
});

test("PreToolUse rewrites only Bash CLI invocations and preserves all native input fields", async (t) => {
  const f = await fixture(t, { server: true });
  const input = hookInput(f, { hook_event_name: "PreToolUse", request_set_id: undefined,
    tool_name: "Bash", tool_input: {
      command: 'memorax-cli search --query "synthetic"', description: "Synthetic memory search",
      dir_path: f.root, run_in_background: false, timeout: 2500, pty: true,
    } });
  const result = await hook(f, input, { MEMORAX_CODE_HOME: join(f.root, "unrelated-home") });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(output), ["hookSpecificOutput"]);
  assert.deepEqual(Object.keys(output.hookSpecificOutput), ["hookEventName", "updatedInput"]);
  const updated = output.hookSpecificOutput.updatedInput;
  assert.deepEqual({ ...updated, command: input.tool_input.command }, input.tool_input);
  assert.match(updated.command, /MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT='qoder'/);
  assert.match(updated.command, /MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID='qoder-session-1'/);
  assert.equal(updated.command.includes(`MEMORAX_CODE_HOME='${f.memoraxCodeHome}'`), true);
  assert.equal(output.hookSpecificOutput.permissionDecision, undefined);
  assert.equal((await hook(f, { ...input, tool_input: updated })).stdout, "");
  assert.equal((await hook(f, { ...input, tool_name: "Read" })).stdout, "");
  assert.equal((await hook(f, { ...input, tool_input: { command: "echo memorax-cli" } })).stdout, "");
  assert.equal((await hook(f, { ...input, sessionId: "conflict" })).stdout, "");
  assert.deepEqual(f.requests, []);
});

test("native child events never inherit the parent Memory CLI or turn identity", async (t) => {
  const f = await fixture(t, { server: true });
  for (const event of ["SessionStart", "UserPromptSubmit", "QueryEnd", "PreToolUse"]) {
    const result = await hook(f, hookInput(f, { hook_event_name: event, reason: "end_turn",
      agent_id: "native-child", agent_type: "memorax-repo-memory",
      tool_name: "Bash", tool_input: { command: "memorax-cli search --query synthetic" },
    }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  }
  assert.deepEqual(f.requests, []);
});

test("notification candidates defer transport until QueryEnd and rely on Backend native verification", async (t) => {
  const f = await fixture(t, { server: true });
  const prompt = "<task-notification>\n<task-id>synthetic-task</task-id>\n<status>completed</status>\n<summary>Synthetic complete</summary>\n</task-notification>";
  const input = hookInput(f, { prompt });
  assert.equal((await hook(f, input)).stdout, "");
  assert.deepEqual(f.requests, []);
  f.recorded = false;
  assert.equal((await hook(f, { ...input, hook_event_name: "QueryEnd", reason: "end_turn" })).stdout, "");
  assert.deepEqual(f.requests.map((entry) => entry.path), ["/memory/turn-start"]);
  const pasted = { ...input, request_set_id: "human-pasted-notification" };
  await hook(f, pasted);
  f.requests.length = 0;
  f.recorded = true;
  await hook(f, { ...pasted, hook_event_name: "QueryEnd", reason: "end_turn" });
  assert.deepEqual(f.requests.map((entry) => entry.path), ["/memory/turn-start", "/memory/writeback"]);
  assert.equal(f.requests[0].body.prompt, prompt);
  const aborted = { ...input, request_set_id: "aborted-candidate" };
  await hook(f, aborted);
  f.requests.length = 0;
  await hook(f, { ...aborted, hook_event_name: "QueryEnd", reason: "abort" });
  assert.deepEqual(f.requests.map((entry) => entry.path), ["/memory/writeback"]);
  assert.equal(f.requests[0].body.status, "aborted");
  assert.equal(f.requests[0].body.turnId, aborted.request_set_id);
});

test("deferred human prompts survive failed registration and retry the exact turn", async (t) => {
  for (const failure of ["unrecorded", "http-error", "transport-error"]) {
    await t.test(failure, async (t) => {
      const f = await fixture(t, { server: true });
      const input = hookInput(f, {
        prompt: "  <task-notification><task-id>human-paste</task-id><status>completed</status></task-notification>\r\n",
      });
      const end = { ...input, hook_event_name: "QueryEnd", reason: "end_turn" };
      const pendingPath = join(f.memoraxCodeHome, "adapters", "qoder", "deferred-task-notifications.json");
      assert.equal((await hook(f, input)).status, 0);
      const pending = await json(pendingPath);
      assert.equal(pending.records[0].command.prompt, input.prompt);
      f.recorded = failure !== "unrecorded";
      f.rejectTurnStart = failure === "http-error";
      f.disconnectTurnStart = failure === "transport-error";
      assert.equal((await hook(f, end)).status, 0);
      assert.deepEqual(f.requests.map((entry) => entry.path), ["/memory/turn-start"]);
      assert.deepEqual(await json(pendingPath), pending);

      f.recorded = true;
      f.rejectTurnStart = false;
      f.disconnectTurnStart = false;
      f.requests.length = 0;
      assert.equal((await hook(f, end)).status, 0);
      assert.deepEqual(f.requests.map((entry) => entry.path), ["/memory/turn-start", "/memory/writeback"]);
      assert.deepEqual(f.requests[0].body, pending.records[0].command);
      assert.equal(existsSync(pendingPath), false);
    });
  }
});

test("an abort during deferred registration prevents the pending completion from writing back", async (t) => {
  const f = await fixture(t, { server: true });
  const input = hookInput(f, {
    prompt: "<task-notification><task-id>human-paste</task-id><status>completed</status></task-notification>",
  });
  await hook(f, input);
  let arrived;
  let release;
  const received = new Promise((resolve) => { arrived = resolve; });
  const released = new Promise((resolve) => { release = resolve; });
  f.beforeReply = async ({ path }) => {
    if (path === "/memory/turn-start") { arrived(); await released; }
  };
  const completion = hook(f, { ...input, hook_event_name: "QueryEnd", reason: "end_turn" });
  try {
    await received;
    assert.equal((await hook(f, { ...input, hook_event_name: "QueryEnd", reason: "abort" })).status, 0);
  } finally { release(); }
  assert.equal((await completion).status, 0);
  assert.deepEqual(f.requests.map((entry) => entry.path), ["/memory/turn-start", "/memory/writeback"]);
  assert.equal(f.requests[1].body.status, "aborted");
  assert.equal(f.requests[1].body.sessionId, input.session_id);
  assert.equal(f.requests[1].body.turnId, input.request_set_id);
  assert.equal(existsSync(join(f.memoraxCodeHome, "adapters", "qoder", "deferred-task-notifications.json")), false);
  // Later completion retries reach the Backend after its matching abort.
  await hook(f, { ...input, hook_event_name: "QueryEnd", reason: "end_turn" });
  assert.deepEqual(f.requests.filter((entry) => entry.path === "/memory/writeback")
    .map((entry) => entry.body.status), ["aborted", "completed"]);
});

test("disabled and superseded runtimes cannot recover the Backend or forward commands", async (t) => {
  const f = await fixture(t, { server: true });
  await disableQoderAdapter(f.options);
  for (const event of ["SessionStart", "UserPromptSubmit", "QueryEnd", "PreToolUse"]) {
    const result = await hook(f, hookInput(f, { hook_event_name: event, reason: "end_turn", tool_name: "Bash", tool_input: { command: "memorax-cli search --query synthetic" } }));
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, "");
  }
  assert.deepEqual(f.requests, []);
  const nextCommand = join(f.root, "replacement-lifecycle.mjs");
  await writeFile(nextCommand, "process.exit(0);\n");
  await enableQoderAdapter({ ...f.options, memoraxCodeCommand: nextCommand });
  assert.equal((await hook(f, hookInput(f, { hook_event_name: "SessionStart" }))).stdout, "");
  assert.deepEqual(f.requests, []);
});

test("SessionStart recovery calls the explicit lifecycle command with pinned homes and preserve-clients", async (t) => {
  const f = await fixture(t, { server: true });
  f.healthy = false;
  const observed = join(f.root, "recovery-arguments.json");
  await writeFile(f.options.memoraxCodeCommand, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(observed)},JSON.stringify(process.argv.slice(2))); process.stdout.write(JSON.stringify({ok:true}));\n`);
  const result = await hook(f, hookInput(f, { hook_event_name: "SessionStart" }), {
    MEMORAX_CODE_QODER_ENSURE_TIMEOUT_MS: "100", MEMORAX_CODE_QODER_START_TIMEOUT_MS: "3000",
  });
  assert.equal(result.status, 0, result.stderr);
  const args = await json(observed);
  assert.deepEqual(args.slice(0, 5), ["start", "--home", f.memoraxCodeHome, "--qoder-home", f.qoderHome]);
  assert.equal(args.includes("--preserve-clients"), true);
  assert.equal(args.includes("--json"), true);
  const state = await readFile(f.installed.statePath, "utf8");
  assert.equal(JSON.parse(state).enabled, true);
});

test("disablement during a pending health check prevents recovery without reporting success", async (t) => {
  const f = await fixture(t, { server: true });
  f.healthy = false;
  const marker = join(f.root, "must-not-start.json");
  await writeFile(f.options.memoraxCodeCommand, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},'started'); process.stdout.write(JSON.stringify({ok:true}));\n`);
  let healthArrived;
  let releaseHealth;
  const received = new Promise((resolve) => { healthArrived = resolve; });
  const released = new Promise((resolve) => { releaseHealth = resolve; });
  let firstHealth = true;
  f.beforeReply = async ({ path }) => {
    if (path !== "/health" || !firstHealth) return;
    firstHealth = false;
    healthArrived();
    await released;
  };
  const pending = hook(f, hookInput(f, { hook_event_name: "SessionStart" }), {
    MEMORAX_CODE_QODER_ENSURE_TIMEOUT_MS: "5000", MEMORAX_CODE_QODER_START_TIMEOUT_MS: "6000",
  });
  try {
    await received;
    assert.equal((await disableQoderAdapter(f.options)).ok, true);
  } finally { releaseHealth(); }
  const result = await pending;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
  assert.equal(existsSync(marker), false);
  assert.equal((await json(f.installed.statePath)).enabled, false);
});
