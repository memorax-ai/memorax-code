import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { assertNativeHookCorrelation, assertNativeSessionBinding, assertNativeWritebackContent,
  runNativeMemoryCheck, selectReportedBashStdout, summarizeNativeSkillBashResult } from "./codebuddy-native-memory-support.mjs";

const sessionId = "native-session";
const prompt = "First paragraph: caf\u00e9.\n\nSecond paragraph: \u65e5\u672c\u8a9e.";
const answer = "Preserve every line.\nKeep complete text.";

for (const client of ["codebuddy", "workbuddy"]) {
  const otherClient = client === "codebuddy" ? "workbuddy" : "codebuddy";

  test(`${client} memory runner rejects missing arguments without launching a client`, async () => {
    const report = await runNativeMemoryCheck({ client, args: [] });
    assert.equal(report.status, "FAIL");
    assert.equal(report.stage, "prerequisites");
    assert.equal(report.error, `EXPECTED_INSTALLED_PACKAGE_${client.toUpperCase()}_PATH_AND_VERSION`);
    assert.equal(report.scope, `native_${client}_installed_plugin_mock_memorax`);
    assert.equal(report.skillExecutionValidated, false);
    assert.equal(report.modelRequests, undefined);
    assert.equal(report.workBuddyValidated, client === "codebuddy" ? false : undefined);
  });

  test(`${client} native tool environment accepts its own trace binding or native fallback`, () => {
    assert.doesNotThrow(() => assertNativeSessionBinding({ native: sessionId, client, trace: sessionId }, { client, sessionId }));
    assert.doesNotThrow(() => assertNativeSessionBinding({ native: sessionId }, { client, sessionId }));
  });

  test(`${client} native tool environment rejects foreign, partial and overridden bindings`, () => {
    for (const binding of [
      { native: "foreign-session", client, trace: sessionId },
      { native: sessionId, client: otherClient, trace: sessionId },
      { native: sessionId, client, trace: "foreign-session" },
      { native: sessionId, client },
      { native: sessionId, trace: sessionId },
      { native: sessionId, memory: sessionId },
    ]) assert.throws(() => assertNativeSessionBinding(binding, { client, sessionId }), { nativeCode: "NATIVE_SESSION_ENV_MISMATCH" });
  });

  test(`${client} automatic writeback retains complete Unicode and multiline content`, () => {
    assert.doesNotThrow(() => assertNativeWritebackContent(messages(), { client, prompt, answer }));
    const truncated = messages();
    truncated[0].content = "First paragraph: caf\u00e9.";
    assert.throws(() => assertNativeWritebackContent(truncated, { client, prompt, answer }), { nativeCode: "NATIVE_WRITEBACK_PROMPT_MISMATCH" });
    const incomplete = messages();
    incomplete[1].content = "Preserve every line.";
    assert.throws(() => assertNativeWritebackContent(incomplete, { client, prompt, answer }), { nativeCode: "NATIVE_WRITEBACK_ANSWER_MISMATCH" });
  });

  test(`${client} Hook correlation remains client/session qualified`, () => {
    const events = hookEvents(client);
    const start = assertNativeHookCorrelation(events, { client, sessionId, prompt });
    assert.equal(start, events[0]);
    for (const foreign of [hookEvents(otherClient), hookEvents(client, { session: "foreign-session" })]) {
      assert.throws(() => assertNativeHookCorrelation(foreign, { client, sessionId, prompt }), { nativeCode: "NATIVE_HOOK_PROMPT_CORRELATION_MISSING" });
    }
  });

  test(`${client} Hook correlation rejects duplicate starts and unrelated completion`, () => {
    const events = hookEvents(client);
    assert.throws(() => assertNativeHookCorrelation([...events, events[0]], { client, sessionId, prompt }),
      { nativeCode: "NATIVE_HOOK_PROMPT_CORRELATION_MISSING" });
    for (const mutation of [
      (end) => { end.trace.client = otherClient; },
      (end) => { end.trace.session_id = "foreign-session"; },
      (end) => { end.trace.turn_id += "-foreign"; },
      (end) => { end.outcome = "interrupted"; },
    ]) {
      const changed = structuredClone(events);
      mutation(changed[1]);
      assert.throws(() => assertNativeHookCorrelation(changed, { client, sessionId, prompt }),
        { nativeCode: "NATIVE_HOOK_COMPLETION_CORRELATION_MISSING" });
    }
  });

  test(`${client} invalid Bash stdout adds only its fixed reason to the existing report`, () => {
    const canary = "PRIVATE_STDOUT_CANARY";
    for (const [stdout, reason] of [["", "zero_length"], ["(empty)", "literal_empty"], [`${canary}\nExit Code: 1`, "envelope_fields"]]) {
      const report = { status: "FAIL", stage: "native same-session resume and real tool" };
      assert.throws(() => selectReportedBashStdout(report, ...bashToolResult(client, stdout)),
        { nativeCode: "NATIVE_BASH_STDOUT_INVALID", message: "NATIVE_BASH_STDOUT_INVALID", stdoutInvalidReason: reason });
      assert.deepEqual(report, { status: "FAIL", stage: "native same-session resume and real tool", bashStdoutInvalidReason: reason });
      assert.ok(!JSON.stringify(report).includes(canary));
    }
    const report = {};
    for (const stdout of ["(empty)", ""]) {
      assert.throws(() => selectReportedBashStdout(report, ...bashToolResult(client, stdout)), { nativeCode: "NATIVE_BASH_STDOUT_INVALID" });
    }
    assert.deepEqual(report, { bashStdoutInvalidReason: "literal_empty" });
  });

  test(`${client} valid Bash results and other Bash failures leave the report unchanged`, () => {
    const report = {};
    assert.equal(selectReportedBashStdout(report, ...bashToolResult(client, "complete output\n")), "complete output\n");
    assert.throws(() => selectReportedBashStdout(report, ...bashToolResult(client, "complete output\n", "1")),
      { nativeCode: "NATIVE_BASH_RESULT_MISMATCH" });
    assert.throws(() => selectReportedBashStdout(report, null, "'fixture-command'", { client }), { nativeCode: "NATIVE_BASH_RESULT_INVALID" });
    assert.deepEqual(report, {});
  });
}

test("WorkBuddy exact and projected Hook digests form one unique candidate set", () => {
  const exact = hookEvents("workbuddy", { projected: false });
  assert.doesNotThrow(() => assertNativeHookCorrelation(exact, { client: "workbuddy", sessionId, prompt }));
  assert.throws(() => assertNativeHookCorrelation([...exact, ...hookEvents("workbuddy")], { client: "workbuddy", sessionId, prompt }),
    { nativeCode: "NATIVE_HOOK_PROMPT_CORRELATION_MISSING" });
});

test("CodeBuddy retains its projected Hook digest acceptance contract", () => {
  assert.throws(() => assertNativeHookCorrelation(hookEvents("codebuddy", { projected: false }), { client: "codebuddy", sessionId, prompt }),
    { nativeCode: "NATIVE_HOOK_PROMPT_CORRELATION_MISSING" });
});

test("WorkBuddy keeps its strict content contract while CodeBuddy retains additional-content reporting", () => {
  for (const mutation of [
    (items) => { items[0].content += "\nAdditional content."; },
    (items) => { items[1].content += "\nAdditional content."; },
    (items) => { items.push({ role: "assistant", content: "Additional content.", timestamp: 3 }); },
    (items) => { items[0].content = items[0].content.replace("\n\n", " "); },
  ]) {
    const changed = messages();
    mutation(changed);
    assert.throws(() => assertNativeWritebackContent(changed, { client: "workbuddy", prompt, answer }),
      { nativeCode: "NATIVE_WRITEBACK_CONTENT_MISMATCH" });
    assert.doesNotThrow(() => assertNativeWritebackContent(changed, { client: "codebuddy", prompt, answer }));
  }
});

test("Memory runner and acceptance helpers reject unknown client identities", async () => {
  await assert.rejects(runNativeMemoryCheck({ client: "other", args: [] }), { nativeCode: "NATIVE_CLIENT_INVALID" });
  assert.throws(() => assertNativeSessionBinding({}, { client: "other", sessionId }), { nativeCode: "NATIVE_CLIENT_INVALID" });
  assert.throws(() => assertNativeWritebackContent(messages(), { client: "other", prompt, answer }), { nativeCode: "NATIVE_CLIENT_INVALID" });
  assert.throws(() => assertNativeHookCorrelation([], { client: "other", sessionId, prompt }), { nativeCode: "NATIVE_CLIENT_INVALID" });
});

test("Skill Bash diagnostics distinguish shell startup failures without exposing output", () => {
  const secret = "fixture-private-token";
  const command = `memorax-cli search --query '${secret}' --json`;
  const output = `Command: ${command}\nStdout: (empty)\nStderr: /private/${secret}/memorax-cli: line 2: import: command not found\nline 3: syntax error near unexpected token '('\nENOEXEC\nExit Code: 2\nSignal: (none)`;
  const result = summarizeNativeSkillBashResult(output, command);
  assert.equal(result.commandEchoMatched, true);
  assert.equal(result.structuredEnvelopeMatched, true);
  assert.equal(result.stderr, "nonempty");
  assert.equal(result.exitCode, "nonzero");
  assert.equal(result.signal, "none");
  assert.equal(result.stdoutJson, false);
  assert.deepEqual(result.errorSignatures, ["enoexec", "shell_import_command_not_found", "syntax", "command_not_found"]);
  assert.ok(!JSON.stringify(result).includes(secret));
  assert.ok(!JSON.stringify(result).includes("/private"));
  assert.ok(!JSON.stringify(result).includes(command));
});

test("CodeBuddy commandless Skill diagnostics report status without claiming a command echo", () => {
  const command = "memorax-cli search --query fixture --json";
  const output = 'Stdout: {"ok":false,"errorCode":"MEMORY_SCOPE_MISMATCH"}\nStderr: (empty)\nExit Code: 1\nSignal: (none)';
  const result = summarizeNativeSkillBashResult(output, command, { client: "codebuddy" });
  assert.equal(result.structuredEnvelopeMatched, true);
  assert.equal(result.commandEchoMatched, false);
  assert.equal(result.stderr, "empty");
  assert.equal(result.exitCode, "nonzero");
  assert.equal(result.signal, "none");
  assert.equal(result.stdoutJson, true);
  assert.equal(result.memoryError, "MEMORY_SCOPE_MISMATCH");
  assert.deepEqual(result.errorSignatures, []);
  assert.equal(summarizeNativeSkillBashResult(output, command, { client: "workbuddy" }).structuredEnvelopeMatched, false);
});

test("Skill Bash diagnostics preserve only known scope error enums from JSON", () => {
  const command = "memorax-cli search --query fixture --json";
  for (const errorCode of ["MEMORY_CONFIG_MISSING", "MEMORY_SCOPE_MISMATCH", "MEMORY_SCOPE_UNAVAILABLE", "private-error-value"]) {
    const output = `Command: ${command}\nStdout: ${JSON.stringify({ ok: false, errorCode, error: "private-path-or-token" })}\nStderr: (empty)\nExit Code: 1\nSignal: (none)`;
    const result = summarizeNativeSkillBashResult(output, command);
    assert.equal(result.stdoutJson, true);
    assert.equal(result.memoryError, errorCode === "private-error-value" ? "other" : errorCode);
    assert.deepEqual(result.errorSignatures, []);
    assert.ok(!JSON.stringify(result).includes("private"));
  }
});

test("Skill Bash diagnostics do not classify ordinary successful Memory content as shell errors", () => {
  const command = "memorax-cli search --query fixture --json";
  const output = `Command: ${command}\nStdout: ${JSON.stringify({ memory: "ENOEXEC syntax error import: command not found" })}\nStderr: (empty)\nExit Code: 0\nSignal: (none)`;
  const result = summarizeNativeSkillBashResult(output, command);
  assert.equal(result.exitCode, "zero");
  assert.equal(result.stderr, "empty");
  assert.deepEqual(result.errorSignatures, []);
});

test("Skill Bash diagnostics bound malformed output and never return arbitrary enums", () => {
  const result = summarizeNativeSkillBashResult(`ENOEXEC ${"private".repeat(20000)}`, "not-the-command");
  assert.equal(result.resultTruncated, true);
  assert.equal(result.commandEchoMatched, false);
  assert.equal(result.structuredEnvelopeMatched, false);
  assert.equal(result.exitCode, "missing");
  assert.deepEqual(result.errorSignatures, ["enoexec"]);
  assert.ok(!JSON.stringify(result).includes("private"));
  assert.equal(summarizeNativeSkillBashResult(undefined, "command").resultPresent, false);
  const malformed = summarizeNativeSkillBashResult("Command: command\nStdout: (empty)\nStderr: (empty)\nExit Code: private-exit\nSignal: private-signal", "command");
  assert.equal(malformed.exitCode, "other");
  assert.equal(malformed.signal, "other");
  assert.ok(!JSON.stringify(malformed).includes("private"));
});

function messages() {
  return [{ role: "user", content: prompt, timestamp: 1 }, { role: "assistant", content: answer, timestamp: 2 }];
}
function bashToolResult(client, stdout, exitCode = "0") {
  const command = "'fixture-node' '-e' 'fixture'";
  const call = { id: "bash-call", name: "Bash", input: { command, description: "Run the fixture", timeout: 15000 } };
  const output = `${client === "codebuddy" ? "" : `Command: ${command}\n`}Stdout: ${stdout}\nStderr: (empty)\nExit Code: ${exitCode}\nSignal: (none)`;
  const body = { messages: [{ role: "assistant", tool_calls: [{ id: call.id, type: "function",
    function: { name: call.name, arguments: JSON.stringify(call.input) } }] }, { role: "tool", tool_call_id: call.id, content: output }] };
  return [output, command, { client, body, call }];
}
function hookEvents(client, { session = sessionId, projected = true } = {}) {
  const text = projected ? prompt.replace(/\r\n|\r|\n/g, "") : prompt;
  const turnId = `${session}:0:${createHash("sha256").update(text).digest("hex")}`;
  const trace = { client, session_id: session, turn_id: turnId };
  return [{ type: "turn_start", trace: { ...trace } }, { type: "turn_end", outcome: "completed", trace: { ...trace } }];
}
