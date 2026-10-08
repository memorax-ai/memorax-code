import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { gzipSync } from "node:zlib";
import {
  completeToolExecution, createCompletedTurn, createConnectDecoder, createGetBlobMessage, createToolExecution,
  decodeAgentClientMessage, decodeSkillsPart, decodeSubagentsPart, encodeConnectEnvelope,
} from "./cursor-app-protocol.mjs";

const requestId = "11111111-1111-4111-8111-111111111111";
const conversationId = "22222222-2222-4222-8222-222222222222";
const userMessageId = "33333333-3333-4333-8333-333333333333";
const prompt = "A synthetic native prompt\nSecond line";
const answer = "A synthetic native answer\nSecond line";

function varint(value) {
  const bytes = [];
  for (let remaining = BigInt(value);;) {
    const byte = Number(remaining & 127n);
    remaining >>= 7n;
    bytes.push(byte | (remaining ? 128 : 0));
    if (!remaining) return Buffer.from(bytes);
  }
}
function scalar(number, value) { return Buffer.concat([varint(number * 8), varint(value)]); }
function field(number, value) {
  const bytes = Buffer.from(value);
  return Buffer.concat([varint(number * 8 + 2), varint(bytes.length), bytes]);
}
function message(...fields) { return Buffer.concat(fields); }
function frame(bytes, flags = 0) {
  const header = Buffer.alloc(5);
  header[0] = flags;
  header.writeUInt32BE(bytes.length, 1);
  return Buffer.concat([header, bytes]);
}
function fixture({ user, state = Buffer.alloc(0), session = conversationId, action, extraRun } = {}) {
  const userBytes = user ?? message(field(1, prompt), field(2, userMessageId), scalar(4, 1));
  const body = message(field(1, state), field(2, action ?? field(1, field(1, userBytes))), field(5, session), extraRun ?? Buffer.alloc(0));
  return { bytes: field(1, body), userBytes, state };
}
function run(options) { return decodeAgentClientMessage(fixture(options).bytes, { requestId }); }
function hash(bytes) { return createHash("sha256").update(bytes).digest(); }

function expectError(callback, code, label) {
  assert.throws(callback, (error) => {
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    assert.deepEqual(Object.keys(error), ["code"]);
    return true;
  }, label);
}
function contextRun(context, parts) {
  return run({ action: message(field(1, message(field(1, fixture().userBytes), field(2, context))),
    ...(parts === undefined ? [] : [field(17, parts)])) });
}
function execResult(number, detail, { variant = 1, id = 9, execId = userMessageId, extra = Buffer.alloc(0) } = {}) {
  return decodeAgentClientMessage(field(2, message(scalar(1, id), field(15, execId),
    field(number, message(field(variant, detail), extra)))));
}
function execution(step, input = run()) {
  return createToolExecution(input, step, { id: 9, toolCallId: userMessageId });
}
const shellStep = { kind: "shell", command: "memorax-cli search --query synthetic", workingDirectory: "/synthetic/workspace", timeoutMs: 1000 };

test("Connect framing handles fragmented/coalesced frames, explicit gzip and terminal envelopes", () => {
  const bytes = Buffer.from("synthetic frame"), wire = message(frame(bytes), frame(gzipSync(bytes), 1));
  const decoder = createConnectDecoder({ compression: "gzip", maxFrameBytes: 128 }), output = [];
  for (const byte of wire) output.push(...decoder.push(Buffer.from([byte])));
  assert.deepEqual(output, [bytes, bytes]);
  assert.deepEqual(createConnectDecoder({ compression: "gzip" }).push(wire), output);
  const terminal = encodeConnectEnvelope(Buffer.from("{}"), { endStream: true });
  assert.deepEqual(decoder.push(terminal), []);
  decoder.finish();
  assert.deepEqual(encodeConnectEnvelope(Buffer.from([10, 0])), Buffer.from([0, 0, 0, 0, 2, 10, 0]));
  expectError(() => decoder.push(Buffer.from([0])), "CURSOR_APP_CONNECT_TRAILING_DATA");
  expectError(() => createConnectDecoder().push(message(terminal, terminal)), "CURSOR_APP_CONNECT_TRAILING_DATA");
  for (const [name, callback, suffix] of [
    ["unannounced gzip", () => createConnectDecoder().push(frame(gzipSync(bytes), 1)), "COMPRESSION"],
    ["unknown compression", () => createConnectDecoder({ compression: "br" }), "COMPRESSION"],
    ["invalid gzip", () => createConnectDecoder({ compression: "gzip" }).push(frame(bytes, 1)), "COMPRESSION"],
    ["encoded size", () => createConnectDecoder({ maxFrameBytes: 8 }).push(frame(bytes)), "FRAME_TOO_LARGE"],
    ["inflated size", () => createConnectDecoder({ compression: "gzip", maxFrameBytes: 64 }).push(frame(gzipSync(Buffer.alloc(1024)), 1)), "FRAME_TOO_LARGE"],
    ["flags", () => createConnectDecoder().push(frame(bytes, 3)), "FLAGS"],
    ["terminal JSON", () => createConnectDecoder().push(frame(Buffer.from("[]"), 2)), "END_STREAM"],
    ["terminal error", () => createConnectDecoder().push(frame(Buffer.from('{"error":{"message":"private-canary"}}'), 2)), "REMOTE_ERROR"],
  ]) expectError(callback, "CURSOR_APP_CONNECT_" + suffix, name);
  for (const truncated of [Buffer.from([0]), frame(bytes).subarray(0, 8)]) {
    const partial = createConnectDecoder();
    partial.push(truncated);
    expectError(() => partial.finish(), "CURSOR_APP_CONNECT_TRUNCATED");
  }
});

test("Run preserves native identity, Unicode, history and independent prepended context", () => {
  const oldTurn = Buffer.alloc(32, 7), state = message(field(8, oldTurn), scalar(10, 1), field(35, "retained"));
  const input = fixture({ state });
  assert.deepEqual(decodeAgentClientMessage(input.bytes, { requestId }), {
    type: "run", requestId, conversationId, userMessageId, prompt,
    userMessageBytes: input.userBytes, conversationStateBytes: state, turnRefs: [oldTurn],
  });
  const exact = "\ufeffSynthetic \u4e2d\u6587\r\nunchanged";
  assert.equal(run({ user: message(field(1, exact), field(2, userMessageId)) }).prompt, exact);
  const previous = message(field(1, "cancelled"), field(2, conversationId));
  const current = run({ action: field(1, message(field(1, input.userBytes), field(4, previous))) });
  assert.deepEqual(current.prependUserMessages, [{ prompt: "cancelled", userMessageId: conversationId }]);
  assert.equal(current.prompt, prompt);
  assert.deepEqual(createCompletedTurn(current, { answer }).kvWrites[0].bytes, input.userBytes);
  for (const number of [3, 9]) assert.equal(run({ extraRun: field(number, field(1, "model")) }).modelId, "model");
  expectError(() => run({ extraRun: message(field(3, field(1, "one")), field(9, field(1, "two"))) }), "CURSOR_APP_PROTO_FIELD");
});

test("native identity, unsupported actions and malformed protobuf fail closed with fixed errors", () => {
  for (const id of [undefined, "", "not-a-uuid", requestId + "\n"]) {
    expectError(() => decodeAgentClientMessage(fixture().bytes, { requestId: id }), "CURSOR_APP_RUN_IDENTITY");
  }
  for (const [name, options, code] of [
    ["session", { session: "" }, "CURSOR_APP_RUN_IDENTITY"],
    ["user", { user: message(field(1, prompt), field(2, "wrong")) }, "CURSOR_APP_RUN_IDENTITY"],
    ["duplicate user", { user: message(fixture().userBytes, field(2, userMessageId)) }, "CURSOR_APP_PROTO_FIELD"],
    ["duplicate session", { extraRun: field(5, conversationId) }, "CURSOR_APP_PROTO_FIELD"],
    ["action", { action: field(2, Buffer.alloc(0)) }, "CURSOR_APP_RUN_UNSUPPORTED"],
    ["empty prompt", { user: message(field(1, " "), field(2, userMessageId)) }, "CURSOR_APP_RUN_PROMPT"],
    ["invalid UTF8", { user: message(field(1, Buffer.from([0xc3, 0x28])), field(2, userMessageId)) }, "CURSOR_APP_PROTO_UTF8"],
    ["empty reference", { state: field(8, Buffer.alloc(0)) }, "CURSOR_APP_PROTO_REFERENCE"],
  ]) expectError(() => run(options), code, name);
  for (const extra of [scalar(5, 1), scalar(24, 1), field(18, Buffer.alloc(32)), field(19, Buffer.alloc(32)), field(27, "agent")]) {
    expectError(() => run({ user: message(fixture().userBytes, extra) }), "CURSOR_APP_RUN_UNSUPPORTED");
    expectError(() => run({ action: field(1, message(field(1, fixture().userBytes),
      field(4, message(fixture().userBytes, extra)))) }), "CURSOR_APP_RUN_UNSUPPORTED");
  }
  for (const [bytes, suffix] of [[Buffer.from([0]), "TAG"], [Buffer.from([15]), "WIRE"],
    [Buffer.from([10, 2, 0]), "TRUNCATED"], [Buffer.alloc(11, 255), "VARINT"],
    [message(fixture().bytes, field(7, Buffer.alloc(0))), "FIELD"]]) {
    expectError(() => decodeAgentClientMessage(bytes, { requestId }), "CURSOR_APP_PROTO_" + suffix);
  }
  expectError(() => decodeAgentClientMessage(field(8, Buffer.alloc(0))), "CURSOR_APP_CLIENT_MESSAGE_UNSUPPORTED");
});

test("selected Skill rules come only from native context and retain exact attachment bytes", () => {
  const fullPath = "C:\\synthetic\\skills\\memorax-code\\SKILL.md", content = "Exact \u4e2d\u6587 body\r\n";
  const rule = message(field(1, fullPath), field(2, content));
  const user = message(fixture().userBytes, field(3, field(10, field(1, message(rule, field(3, field(4, Buffer.alloc(0))))))));
  const decoded = run({ user });
  assert.deepEqual(decoded.selectedCursorRules, [{ fullPath, content, manuallyAttached: true }]);
  assert.deepEqual(createCompletedTurn(decoded, { answer }).kvWrites[0].bytes, user);
  assert.equal(run({ user: message(fixture().userBytes, field(8, "selectedCursorRules manuallyAttached")) }).selectedCursorRules, undefined);
  assert.equal(run({ user: message(fixture().userBytes, field(3, field(10, field(1, rule)))) }).selectedCursorRules[0].manuallyAttached, false);
  for (const invalid of [scalar(10, 1), field(10, Buffer.alloc(0)),
    field(10, field(1, message(rule, field(3, field(4, field(1, "private-canary")))))),
    field(10, field(1, message(rule, field(3, message(field(1, Buffer.alloc(0)), field(4, Buffer.alloc(0)))))))]) {
    expectError(() => run({ user: message(fixture().userBytes, field(3, invalid)) }), "CURSOR_APP_PROTO_FIELD");
  }
});

test("Skill and subagent catalogs preserve native fields, readiness and bounded hash references", () => {
  const skill = message(field(1, "/synthetic/SKILL.md"), field(2, "Native \u8bb0\u5fc6"), field(3, "Description"),
    field(4, "Parse issue"), field(5, "local"), field(6, "disabled"), scalar(8, 1));
  const agent = message(field(1, "/synthetic/agent.md"), field(2, "memorax-repo-memory"), field(5, "inherit"),
    field(6, "Exact instructions"), scalar(8, 1));
  assert.deepEqual(decodeSkillsPart(message(field(1, skill), field(2, field(1, "private-options-canary")))), [{
    fullPath: "/synthetic/SKILL.md", content: "Native \u8bb0\u5fc6", description: "Description", parseError: "Parse issue",
    disableModelInvocation: true, environments: ["local"], disabledEnvironments: ["disabled"],
  }]);
  assert.deepEqual(decodeSubagentsPart(field(1, agent)), [{ fullPath: "/synthetic/agent.md", name: "memorax-repo-memory",
    description: "", model: "inherit", prompt: "Exact instructions", isBackground: true, bytes: agent }]);
  for (const [decode, item, number, ready, key] of [[decodeSkillsPart, skill, 3, 43, "agentSkillsInfoComplete"],
    [decodeSubagentsPart, agent, 5, 42, "customSubagentsInfoComplete"]]) {
    assert.deepEqual(decode(Buffer.alloc(0)), []);
    for (const value of [undefined, false, true]) {
      const context = message(field(25, "Exact Hook context"), field(ready === 43 ? 29 : 22, item),
        ...(value === undefined ? [] : [scalar(ready, Number(value))]));
      const parts = message(field(number, hash(field(1, item))), scalar(number + 1, field(1, item).length), field(9, context));
      const decoded = contextRun(context, parts);
      assert.equal(decoded.requestContext[key], value);
      assert.equal(decoded.requestContext.hooksAdditionalContext, "Exact Hook context");
      assert.deepEqual(decoded.requestContextParts.dynamicContext, decoded.requestContext);
      assert.deepEqual(decoded.requestContextParts[ready === 43 ? "skillsBlobId" : "subagentsBlobId"], hash(field(1, item)));
    }
    for (const invalid of [field(number, Buffer.alloc(31)), scalar(number + 1, 1)]) {
      expectError(() => contextRun(Buffer.alloc(0), invalid), "CURSOR_APP_PROTO_REFERENCE");
    }
    expectError(() => contextRun(Buffer.alloc(0), message(field(number, Buffer.alloc(32)),
      scalar(number + 1, 16 * 1024 * 1024 + 1))), "CURSOR_APP_PROTO_FIELD");
    for (const invalid of [scalar(1, 1), field(1, message(item, field(1, "duplicate"))), field(1, message(item, scalar(8, 2)))]) {
      expectError(() => decode(invalid), "CURSOR_APP_PROTO_FIELD");
    }
  }
  expectError(() => decodeSkillsPart(field(1, field(1, Buffer.from([0xc3, 0x28])))), "CURSOR_APP_PROTO_UTF8");
  expectError(() => decodeSkillsPart(Buffer.alloc(16 * 1024 * 1024 + 1)), "CURSOR_APP_PROTO_TOO_LARGE");
  assert.equal(run({ extraRun: field(99, field(25, "fake Hook")) }).requestContext, undefined);
  const user = message(fixture().userBytes, field(21, message(field(1, "beforeSubmitPrompt"), field(2, "Exact prompt Hook"))));
  assert.deepEqual(run({ user }).userHookAdditionalContexts, [{ hookEventName: "beforeSubmitPrompt", content: "Exact prompt Hook" }]);
});

test("KV reads and writes correlate IDs, retain exact bytes and redact remote errors", () => {
  const bytes = Buffer.from([0, 255, 3, 4]), blobId = hash(bytes);
  assert.deepEqual(createGetBlobMessage({ id: 11, blobId }), field(4, message(scalar(1, 11), field(2, field(1, blobId)))));
  for (const reading of [false, true]) {
    const number = reading ? 2 : 3, type = reading ? "kvGetResult" : "kvAck";
    const body = reading ? field(1, bytes) : Buffer.alloc(0);
    assert.deepEqual(decodeAgentClientMessage(field(3, message(scalar(1, 11), field(number, body)))),
      { type, id: 11, ...(reading ? { bytes } : {}) });
    const error = field(reading ? 2 : 1, field(1, "private-canary"));
    assert.deepEqual(decodeAgentClientMessage(field(3, message(scalar(1, 11), field(number, error)))),
      { type, id: 11, error: reading ? "CURSOR_APP_KV_READ_FAILED" : "CURSOR_APP_KV_WRITE_FAILED" });
  }
  assert.deepEqual(decodeAgentClientMessage(field(3, message(scalar(1, 1), field(2, field(1, Buffer.alloc(0)))))),
    { type: "kvGetResult", id: 1, bytes: Buffer.alloc(0) });
  assert.deepEqual(decodeAgentClientMessage(field(3, message(scalar(1, 1), field(2, Buffer.alloc(0))))), { type: "kvGetResult", id: 1 });
  expectError(() => decodeAgentClientMessage(field(3, message(scalar(1, 1), field(2, Buffer.alloc(0)), field(3, Buffer.alloc(0))))), "CURSOR_APP_PROTO_FIELD");
  for (const id of [0, -1, 1.5, 0x1_0000_0000]) expectError(() => createGetBlobMessage({ id, blobId }), "CURSOR_APP_KV_ID");
  for (const size of [0, 31, 33]) expectError(() => createGetBlobMessage({ id: 1, blobId: Buffer.alloc(size) }), "CURSOR_APP_PROTO_REFERENCE");
});

test("completion creates the exact content-addressed graph and preserves prior state and Unicode", () => {
  const state = message(field(8, Buffer.alloc(32, 9)), scalar(10, 1), field(35, "retained"));
  const input = run({ state }), exact = "Fixture \u4e2d\u6587 \ud83e\uddea\nunchanged";
  const completed = createCompletedTurn(input, { answer: exact, firstKvId: 11 });
  const step = field(1, field(1, exact)), turn = field(1, message(field(1, hash(input.userMessageBytes)), field(2, hash(step)), field(3, requestId)));
  for (const [index, bytes] of [input.userMessageBytes, step, turn].entries()) {
    const id = index + 11, blobId = hash(bytes);
    assert.deepEqual(completed.kvWrites[index], { id, blobId, bytes,
      message: field(4, message(scalar(1, id), field(3, message(field(1, blobId), field(2, bytes))))) });
  }
  assert.equal(completed.kvWrites.length, 3);
  assert.deepEqual(completed.checkpointMessage, field(3, message(state, field(8, hash(turn)))));
  assert.deepEqual(completed.conversationStateBytes, message(state, field(8, hash(turn))));
  assert.deepEqual(completed.textMessage, field(1, field(1, field(1, exact))));
  assert.deepEqual(completed.turnEndedMessage, field(1, field(14, Buffer.alloc(0))));
  assert.deepEqual(input.conversationStateBytes, state);
  for (const value of ["", " ", undefined]) expectError(() => createCompletedTurn(input, { answer: value }), "CURSOR_APP_RESPONSE_TEXT");
  for (const firstKvId of [0, -1, 1.5, 0xffff_fffe]) expectError(() => createCompletedTurn(input, { answer, firstKvId }), "CURSOR_APP_KV_ID");
});

test("RequestContext is correlated and remains outside visible and persisted tool steps", () => {
  const tool = execution({ kind: "requestContext" }), context = field(25, "Exact Hook context");
  assert.deepEqual(tool.execMessage, field(2, message(scalar(1, 9), field(15, userMessageId),
    field(10, message(field(2, conversationId), scalar(7, 0))))));
  const decoded = execResult(10, field(1, context)), completed = completeToolExecution(tool, decoded);
  assert.deepEqual(completed.result, { hooksAdditionalContext: "Exact Hook context", agentSkills: [] });
  assert.deepEqual(completed.requestContextBytes, context);
  assert.deepEqual([tool.startedMessage, completed.stepBytes, completed.completedMessage], [undefined, undefined, undefined]);
  expectError(() => completeToolExecution(tool, { ...decoded, id: 8 }), "CURSOR_APP_EXEC_IDENTITY");
  expectError(() => completeToolExecution(tool, execResult(10, field(1, "private-canary"), { variant: 2 })), "CURSOR_APP_EXEC_REJECTED");
});

test("Read persists exact native content and tool identity in the completed graph", () => {
  const path = "/synthetic/SKILL.md", content = "Native skill\nUnicode \u8bb0\u5fc6", tool = execution({ kind: "read", path });
  assert.deepEqual(tool.execMessage, field(2, message(scalar(1, 9), field(15, userMessageId), field(7, message(field(1, path), field(2, userMessageId))))));
  const result = execResult(7, message(field(1, path), field(2, content), scalar(3, 2), scalar(4, Buffer.byteLength(content))));
  const completed = completeToolExecution(tool, result);
  assert.deepEqual(completed.result, { kind: "read", path, content, totalLines: 2, fileSize: Buffer.byteLength(content) });
  const success = message(field(1, content), scalar(4, 2), scalar(5, Buffer.byteLength(content)), field(7, path));
  const nativeTool = message(field(8, message(field(1, field(1, path)), field(2, field(1, success)))), field(57, userMessageId));
  assert.deepEqual(completed.stepBytes, field(2, nativeTool));
  assert.deepEqual(completed.completedMessage, field(1, field(3, message(field(1, userMessageId), field(2, nativeTool)))));
  const turn = createCompletedTurn(run(), { answer, toolSteps: [completed.stepBytes] });
  assert.equal(turn.kvWrites.length, 4);
  assert.deepEqual(turn.kvWrites[1].bytes, completed.stepBytes);
  expectError(() => completeToolExecution(tool, { ...result, path: "/other" }), "CURSOR_APP_EXEC_IDENTITY");
  for (const invalid of [message(field(1, path), field(2, content), scalar(6, 1)), message(field(1, path), field(5, "binary"))]) {
    expectError(() => execResult(7, invalid), "CURSOR_APP_EXEC_READ_UNSUPPORTED");
  }
});

test("Shell policies preserve native approval and successful result bytes", () => {
  for (const [extra, policy] of [[{}, []], [{ networkAccess: true }, [field(9, message(scalar(1, 2), scalar(2, 1)))]],
    [{ fullPermissions: true }, [field(9, scalar(1, 1))]]]) {
    const tool = execution({ ...shellStep, ...extra });
    const args = message(field(1, shellStep.command), field(2, shellStep.workingDirectory), scalar(3, 1000), field(4, userMessageId),
      field(8, scalar(1, 1)), ...policy, scalar(13, 1), scalar(14, 1000), scalar(17, 1), field(21, conversationId), field(23, requestId));
    assert.deepEqual(tool.execMessage, field(2, message(scalar(1, 9), field(15, userMessageId), field(2, args))));
    const native = message(field(1, shellStep.command), field(2, shellStep.workingDirectory), field(5, '{"ok":true}\n'));
    const completed = completeToolExecution(tool, execResult(2, native));
    assert.deepEqual(completed.result, { kind: "shell", command: shellStep.command, workingDirectory: shellStep.workingDirectory,
      stdout: '{"ok":true}\n', stderr: "", exitCode: 0 });
    assert.deepEqual(completed.stepBytes, field(2, message(field(1, message(field(1, args), field(2, field(1, native)))), field(57, userMessageId))));
  }
  for (const extra of [{ skipApproval: true }, { networkAccess: false }, { fullPermissions: "true" },
    { networkAccess: true, fullPermissions: true }, { requestedSandboxPolicy: {} }]) {
    expectError(() => execution({ ...shellStep, ...extra }), "CURSOR_APP_EXEC_OPTIONS");
  }
  expectError(() => decodeAgentClientMessage(field(2, message(scalar(1, 9),
    field(2, field(1, Buffer.alloc(0))), field(7, field(1, Buffer.alloc(0)))))), "CURSOR_APP_PROTO_FIELD");
});

test("Shell denial and expected exit one accept only the exact requested native outcome", () => {
  for (const expected of [{ expectRejection: true }, { expectedExitCode: 1 }]) {
    const tool = execution({ ...shellStep, ...expected }), ordinary = execution(shellStep), denied = expected.expectRejection === true;
    assert.deepEqual(tool.execMessage, ordinary.execMessage);
    const stdout = '{"ok":false,"status":"failed","failureReason":"artifact_validation_failed"}\n';
    const detail = message(field(1, shellStep.command), field(2, shellStep.workingDirectory),
      denied ? field(3, "private-reason-canary") : message(scalar(3, 1), field(5, stdout)));
    const decoded = execResult(2, detail, { variant: denied ? 4 : 2 });
    const completed = completeToolExecution(tool, decoded);
    assert.deepEqual(completed.result, { kind: "shell", command: shellStep.command, workingDirectory: shellStep.workingDirectory,
      ...(denied ? { rejected: true } : { stdout, stderr: "", exitCode: 1 }) });
    assert.deepEqual(completed.stepBytes, field(2, message(field(1, message(field(1, tool.toolArgsBytes),
      field(2, field(denied ? 4 : 2, detail)))), field(57, userMessageId))));
    expectError(() => completeToolExecution(ordinary, decoded), "CURSOR_APP_EXEC_REJECTED");
    for (const changed of [{ id: 10 }, { execId: requestId }, { kind: "read" }]) {
      expectError(() => completeToolExecution(tool, { ...decoded, ...changed }), "CURSOR_APP_EXEC_IDENTITY");
    }
    const success = execResult(2, message(field(1, shellStep.command), field(2, shellStep.workingDirectory)));
    expectError(() => completeToolExecution(tool, success), "CURSOR_APP_EXEC_REJECTED");
    if (!denied) {
      for (const [code, extra] of [[2, Buffer.alloc(0)], [1, field(4, "SIGTERM")],
        [1, scalar(10, 1)], [1, scalar(11, 1)], [1, scalar(15, 1)]]) {
        const invalid = execResult(2, message(field(1, shellStep.command), field(2, shellStep.workingDirectory),
          scalar(3, code), extra), { variant: 2 });
        expectError(() => completeToolExecution(tool, invalid), "CURSOR_APP_EXEC_REJECTED");
      }
    }
  }
  for (const extra of [{ expectedExitCode: 2 }, { expectedExitCode: "1" }, { expectedExitCode: 1, expectRejection: true }]) {
    expectError(() => execution({ ...shellStep, ...extra }), "CURSOR_APP_EXEC_OPTIONS");
  }
});

test("Task inherits the parent model and preserves the installed managed definition and child identity", () => {
  const managed = message(field(1, "/synthetic/agent.md"), field(2, "memorax-repo-memory"), field(5, "inherit"),
    field(6, "Exact installed worker instructions"), scalar(8, 1));
  const input = { ...contextRun(field(22, managed)), modelId: "synthetic-model" };
  const step = { kind: "task", subagentType: "memorax-repo-memory", model: "inherit", background: true,
    description: "Run job", prompt: "Exact delegated job" }, tool = execution(step, input);
  const args = message(field(1, userMessageId), field(2, step.subagentType), field(3, input.modelId),
    field(4, step.prompt), scalar(7, 1), field(9, conversationId), scalar(14, 1), field(16, conversationId));
  assert.deepEqual(tool.execMessage, field(2, message(scalar(1, 9), field(15, userMessageId), field(28, args))));
  assert.deepEqual(tool.toolArgsBytes, message(field(1, step.description), field(2, step.prompt),
    field(3, field(3, managed)), field(4, "inherit"), scalar(8, 1)));
  const childId = "44444444-4444-4444-8444-444444444444", result = execResult(28, message(field(1, childId), scalar(4, 1)));
  assert.deepEqual(completeToolExecution(tool, result).result, { kind: "task", agentId: childId, isBackground: true, backgroundReason: 1 });
  for (const changed of [{ model: "other" }, { background: false }, { subagentType: "generic" }]) {
    expectError(() => execution({ ...step, ...changed }, input), "CURSOR_APP_EXEC_TASK_OPTIONS");
  }
  expectError(() => execution(step, { ...input, modelId: "" }), "CURSOR_APP_EXEC_TASK_MODEL");
  expectError(() => execution(step, { ...input, requestContext: undefined }), "CURSOR_APP_EXEC_TASK_DEFINITION");
  expectError(() => completeToolExecution(tool, { ...result, backgroundReason: 0 }), "CURSOR_APP_EXEC_REJECTED");
  const detail = message(field(1, childId), scalar(2, 2), scalar(3, 1), field(4, "private-title-canary"),
    field(5, "private-body-canary"), field(6, "/private-canary"), scalar(8, 1), field(9, childId), field(10, userMessageId));
  const notice = run({ action: field(12, field(1, detail)), extraRun: field(3, field(1, input.modelId)) });
  assert.deepEqual(notice.notifications, [{ taskId: childId, kind: 2, status: 1, reason: 1, subagentId: childId, toolCallId: userMessageId }]);
  assert.equal(JSON.stringify(notice).includes("private"), false);
  expectError(() => run({ action: field(12, message(field(1, detail), field(1, detail))) }), "CURSOR_APP_RUN_UNSUPPORTED");
});

test("failure diagnostics retain only bounded int32, fixed output categories and sandbox policy", () => {
  const json = JSON.stringify({ ok: false, action: "memory.search", errorCode: "MEMORY_SCOPE_UNAVAILABLE", stage: "scope", error: "private-canary" });
  for (const code of [-0x8000_0000, -1, 0, 1, 127, 0x7fff_ffff]) {
    const result = execResult(2, message(scalar(3, BigInt.asUintN(64, BigInt(code))), field(5, json),
      field(6, "private-canary: Operation not permitted")), { variant: 2 });
    assert.equal(result.exitCode, code);
    assert.equal(result.error, "CURSOR_APP_EXEC_REJECTED");
    assert.equal(result.output.errorCode, "MEMORY_SCOPE_UNAVAILABLE");
    assert.equal(result.output.markers.permissionDenied, true);
    assert.equal(JSON.stringify(result).includes("canary"), false);
  }
  for (const invalid of [Buffer.alloc(0), scalar(3, 0x8000_0000), field(3, "private-canary"), message(scalar(3, 1), scalar(3, 2))]) {
    assert.equal(execResult(2, invalid, { variant: 2 }).exitCode, undefined);
  }
  for (const [detail, status] of [[Buffer.alloc(0), "absent"], [field(5, Buffer.alloc(65537)), "oversized"],
    [field(5, Buffer.from([0xc3, 0x28])), "invalid"], [message(field(5, json), field(5, json)), "invalid"]]) {
    const result = execResult(2, message(scalar(3, 1), detail), { variant: 2 });
    assert.equal(result.output.stdoutStatus, status);
    assert.equal(result.error, "CURSOR_APP_EXEC_REJECTED");
  }
  for (const network of [undefined, false, true]) {
    const policy = message(scalar(1, 2), ...(network === undefined ? [] : [scalar(2, Number(network))]), field(3, "private-path-canary"));
    const result = execResult(2, scalar(3, 1), { variant: 2, extra: field(101, policy) });
    assert.deepEqual(result.sandboxPolicy, { type: "workspace_readwrite", networkAccess: network ?? "absent" });
    assert.equal(JSON.stringify(result).includes("canary"), false);
  }
  const invalid = execResult(2, scalar(3, 1), { variant: 2, extra: field(101, scalar(2, 2)) });
  assert.deepEqual(invalid.sandboxPolicy, { type: "invalid", networkAccess: "invalid" });
  assert.equal(invalid.error, "CURSOR_APP_EXEC_REJECTED");
});

test("control messages redact exceptions and only explicitly enabled native Stop reasons are accepted", () => {
  for (const [number, event] of [[1, "close"], [2, "error"], [3, "heartbeat"]]) {
    const body = message(scalar(1, 9), ...(number === 2 ? [field(2, "private-error"), field(3, "private-stack")] : []));
    assert.deepEqual(decodeAgentClientMessage(field(5, field(number, body))), { type: "execControl", id: 9, event });
  }
  assert.deepEqual(decodeAgentClientMessage(field(7, Buffer.alloc(0))), { type: "heartbeat" });
  for (const reason of ["user_stopped_generation", "composer_abort_controller_aborted"]) {
    const stopped = field(4, field(3, field(1, reason)));
    expectError(() => decodeAgentClientMessage(stopped), "CURSOR_APP_CLIENT_MESSAGE_UNSUPPORTED");
    assert.deepEqual(decodeAgentClientMessage(stopped, { allowCancellation: true }), { type: "cancelAction" });
  }
  for (const invalid of [field(4, field(3, field(1, "private-canary"))), field(4, field(2, Buffer.alloc(0))),
    field(4, field(3, message(field(1, "user_stopped_generation"), field(3, Buffer.alloc(0)))))]) {
    expectError(() => decodeAgentClientMessage(invalid, { allowCancellation: true }), "CURSOR_APP_CLIENT_MESSAGE_UNSUPPORTED");
  }
});
