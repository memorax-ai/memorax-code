#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  assertNoSensitivePayload, check, createNativeHarness, fixtureKey, fixtureModel, fixtureProvider, fixtureUser, waitFor,
} from "./opencode-native-support.mjs";

// V1 permission/session APIs, exercised against the installed native client.
// OpenCode permissions are application policy, not an operating-system sandbox.
const lateApprovalOnly = process.argv[4] === "--late-approval";
const cases = lateApprovalOnly ? [
  { id: "user-wait-interrupt-late", action: "ask", interrupt: true, lateReply: true, writes: false },
] : [
  { id: "policy-allow", action: "allow", writes: true },
  { id: "user-allow", action: "ask", reply: "once", writes: true },
  { id: "user-reject", action: "ask", reply: "reject", writes: false },
  { id: "user-wait-interrupt", action: "ask", interrupt: true, writes: false },
];
const report = {
  status: "FAIL", suite: lateApprovalOnly ? "native_opencode_late_approval" : "native_opencode_permissions", platform: process.platform,
  model: "controlled local Chat Completions fixture", paidModelRequests: 0,
  scope: "Native server permission API and actual write-tool file effects with installed MemoraX plugin",
  contentCheck: "Complete native SDK user and terminal assistant text; additional context allowed",
  excludes: ["desktop permission UI", "OS sandbox or privilege enforcement", "background Repo Memory permissions"],
  separateCheck: lateApprovalOnly ? "Late approval after native abort must never execute the tool"
    : "Late approval after abort is checked separately with --late-approval",
  notApplicable: ["Codex auto_review has no equivalent in this OpenCode permission API",
    "OpenCode has no separate cancel reply; cancellation uses session.abort"],
  cases: [],
};
let harness, server, stream, current;
let stage = "prerequisites";

try {
  check(process.argv.length === 4 || (process.argv.length === 5 && lateApprovalOnly),
    "EXPECTED_INSTALLED_PACKAGE_ROOT_AND_OPENCODE_CLI_PATH_OPTIONAL_LATE_APPROVAL");
  harness = await createNativeHarness({ packageRoot: resolve(process.argv[2]),
    openCodeCommand: resolve(process.argv[3]), label: "permissions" });
  stage = "installed plugin setup";
  await harness.setup();
  report.openCodeVersion = harness.openCodeVersion;
  harness.setModelHandler((body) => {
    check(body.model === fixtureModel, "PERMISSION_MODEL_SUBSTITUTION");
    if (!(body.tools?.length > 0)) return { text: "Isolated permission fixture" };
    check(current, "MODEL_REQUEST_OUTSIDE_PERMISSION_CASE");
    check(JSON.stringify(body.messages).includes(current.prompt), "PERMISSION_MODEL_PROMPT_MISMATCH");
    check(++current.modelRequests <= 2, "UNEXPECTED_PERMISSION_MODEL_RETRY");
    if (current.modelRequests === 1) {
      check(body.tools.some((tool) => tool.function?.name === "write"), "NATIVE_WRITE_TOOL_NOT_ADVERTISED");
      return { text: current.initialText, toolCalls: [{ id: current.callId, name: "write",
        arguments: { filePath: current.markerPath, content: current.marker } }] };
    }
    check(!current.test.interrupt, "ABORTED_TURN_CONTINUED");
    check(body.messages.some((message) => message.role === "tool" && message.tool_call_id === current.callId),
      "MATCHING_NATIVE_TOOL_RESULT_MISSING");
    current.toolResultObserved = true;
    return { text: current.finalText };
  });
  stage = "native server initialization";
  server = await harness.startOpenCodeServer();
  stream = await subscribeEvents(server);
  const serverPid = server.process.pid;
  for (const test of cases) {
    stage = test.id;
    current = {
      test, modelRequests: 0, toolResultObserved: false,
      markerPath: join(harness.workspace, `${test.id}.txt`), marker: `MEMORAX_PERMISSION_${test.id}`,
      prompt: `Run the isolated OpenCode permission fixture ${test.id}, then report its result.`,
      initialText: `I will attempt the isolated OpenCode permission fixture ${test.id}.`,
      finalText: `OpenCode permission fixture ${test.id} finished.`, callId: `permission-${test.id}`,
    };
    check(!await exists(current.markerPath), "MARKER_EXISTS_BEFORE_TOOL_EXECUTION");
    const result = { id: test.id, status: "FAIL" };
    report.cases.push(result);
    const started = await server.request("/session", { method: "POST", body: {
      title: `Permission fixture ${test.id}`,
      permission: [{ permission: "edit", pattern: "*", action: test.action }],
    } });
    const sessionId = started.id;
    check(typeof sessionId === "string" && /^ses_[A-Za-z0-9]+$/.test(sessionId), "NATIVE_SESSION_ID_INVALID");
    check(started.permission?.some((rule) => rule.permission === "edit" && rule.pattern === "*"
      && rule.action === test.action), "NATIVE_SESSION_PERMISSION_MISMATCH");
    current.sessionId = sessionId;
    const startIndex = stream.events.length;
    const caseEvents = () => stream.events.slice(startIndex).filter((event) => event.properties?.sessionID === sessionId
      || event.properties?.info?.sessionID === sessionId || event.properties?.part?.sessionID === sessionId);
    await server.request(`/session/${sessionId}/prompt_async`, { method: "POST", body: {
      model: { providerID: fixtureProvider, modelID: fixtureModel },
      parts: [{ type: "text", text: current.prompt }],
    } });
    let permission;
    if (test.action === "ask") {
      permission = (await stream.wait((event) => event.type === "permission.asked"
        && event.properties?.sessionID === sessionId, startIndex)).properties;
      check(permission.permission === "edit" && permission.tool?.callID === current.callId
        && typeof permission.tool.messageID === "string", "PERMISSION_REQUEST_IDENTITY_MISMATCH");
      const pending = await server.request("/permission");
      check(pending.some((entry) => entry.id === permission.id && entry.sessionID === sessionId),
        "NATIVE_PERMISSION_NOT_PENDING");
      check(!await exists(current.markerPath), "TARGET_CHANGED_BEFORE_APPROVAL");
      await delay(300);
      check(!await exists(current.markerPath), "TARGET_CHANGED_WHILE_APPROVAL_PENDING");
      check(!caseEvents().some(isIdle), "PENDING_APPROVAL_WAS_REPORTED_IDLE");
      check(sessionAdds(sessionId).length === 0, "PENDING_PERMISSION_WROTE_MEMORY");
      if (test.interrupt) await server.request(`/session/${sessionId}/abort`, { method: "POST" });
      else await server.request(`/permission/${permission.id}/reply`, { method: "POST", body: { reply: test.reply } });
    }
    await stream.wait((event) => isIdle(event) && event.properties.sessionID === sessionId, startIndex);
    if (test.interrupt) {
      const aborted = await waitFor(async () => (await server.request(`/session/${sessionId}/message`))
        .find((message) => message.info?.role === "assistant" && message.info.error?.name
          && Number.isFinite(message.info.time?.completed)), "NATIVE_ABORT_RECORD_MISSING");
      const pendingAtAbort = await server.request("/permission");
      result.nativeAbortRecorded = true;
      result.nativeAbortName = aborted.info.error.name;
      result.permissionStillPendingAfterAbort = pendingAtAbort.some((entry) => entry.id === permission.id);
      await delay(300);
      result.targetWrittenAfterAbort = await exists(current.markerPath);
      check(!result.targetWrittenAfterAbort, "ABORTED_TOOL_EXECUTED_BEFORE_LATE_REPLY");
      if (test.lateReply) {
        const late = await server.request(`/permission/${permission.id}/reply`, {
          method: "POST", body: { reply: "once" }, raw: true,
        });
        await late.arrayBuffer();
        result.lateReplyStatus = late.status;
        check(late.ok || late.status === 404, "UNEXPECTED_LATE_PERMISSION_RESPONSE");
        await delay(300);
      }
    }
    const pendingAfter = await server.request("/permission");
    if (!test.interrupt || test.lateReply) {
      check(!pendingAfter.some((entry) => entry.sessionID === sessionId), "NATIVE_PERMISSION_REMAINS_PENDING");
    }
    const messages = await server.request(`/session/${sessionId}/message`);
    const user = messages.find((message) => message.info?.role === "user" && visibleText(message).includes(current.prompt));
    check(user && user.info.sessionID === sessionId, "NATIVE_PERMISSION_USER_MISSING");
    const assistants = messages.filter((message) => message.info?.role === "assistant"
      && message.info.sessionID === sessionId && message.info.parentID === user.info.id
      && Number.isFinite(message.info.time?.completed));
    const terminal = assistants.sort((left, right) => left.info.time.completed - right.info.time.completed
      || left.info.id.localeCompare(right.info.id)).at(-1);
    check(terminal, "NATIVE_PERMISSION_TERMINAL_ASSISTANT_MISSING");
    check(terminal.info.modelID === fixtureModel && terminal.info.providerID === fixtureProvider,
      "NATIVE_PERMISSION_PROVIDER_MISMATCH");
    const toolParts = messages.flatMap((message) => message.parts ?? []).filter((part) =>
      part.type === "tool" && part.tool === "write" && part.callID === current.callId && part.sessionID === sessionId);
    check(toolParts.length === 1, "NATIVE_WRITE_TOOL_RECORD_MISSING_OR_AMBIGUOUS");
    const tool = toolParts[0];
    if (permission) check(tool.messageID === permission.tool.messageID, "PERMISSION_TOOL_MESSAGE_MISMATCH");
    const wrote = await exists(current.markerPath);
    Object.assign(result, { targetWritten: wrote, toolStatus: tool.state?.status });
    if (test.writes) {
      check(wrote, "NATIVE_WRITE_TOOL_DID_NOT_WRITE_TARGET");
      check(await readFile(current.markerPath, "utf8") === current.marker, "TARGET_CONTENT_MISMATCH");
      check(tool.state?.status === "completed" && current.toolResultObserved, "NATIVE_WRITE_TOOL_NOT_COMPLETED");
      check(visibleText(terminal).includes(current.finalText), "NATIVE_FINAL_REPLY_MISSING");
    } else check(tool.state?.status === "error", "REJECTED_OR_ABORTED_WRITE_NOT_RECORDED");
    if (test.interrupt) {
      check(typeof terminal.info.error?.name === "string", "INTERRUPTED_ASSISTANT_HAS_NO_NATIVE_ERROR");
      check(tool.state.metadata?.interrupted === true, "ABORTED_TOOL_HAS_NO_NATIVE_INTERRUPT_MARKER");
      check(current.modelRequests === 1, "ABORTED_TURN_CONTINUED_MODEL_EXECUTION");
    } else {
      check(!terminal.info.error, "COMPLETED_PERMISSION_TURN_HAS_NATIVE_ERROR");
      if (test.reply === "reject") {
        check(visibleText(terminal).includes(current.modelRequests === 1 ? current.initialText : current.finalText),
          "REJECTED_TURN_DID_NOT_PRESERVE_NATIVE_VISIBLE_REPLY");
        result.deniedToolLoopContinued = current.modelRequests > 1;
      }
    }
    const asked = caseEvents().filter((event) => event.type === "permission.asked");
    check(asked.length === (permission ? 1 : 0), "UNEXPECTED_PERMISSION_REQUEST_COUNT");
    if (test.reply) check(caseEvents().some((event) => event.type === "permission.replied"
      && event.properties.requestID === permission.id && event.properties.reply === test.reply),
    "NATIVE_PERMISSION_REPLY_EVENT_MISSING");
    result.writeback = await verifyWriteback({ sessionId, user, terminal, completed: !test.interrupt });
    check(wrote === test.writes, test.lateReply ? "LATE_PERMISSION_EXECUTED_ABORTED_TOOL" : "UNEXPECTED_TARGET_FILE_EFFECT");
    Object.assign(result, { status: "PASS", effectiveEditPermission: test.action,
      reply: test.interrupt ? (test.lateReply ? "wait_then_abort_and_late_reply" : "wait_then_abort") : test.reply ?? "policy_allow",
      nativeTurnOutcome: test.interrupt ? "interrupted" : "completed", targetWritten: wrote,
      toolStatus: tool.state.status, modelRequests: current.modelRequests,
      nativeSessionAndParentLineageMatched: true, observedPendingWithoutSideEffect: Boolean(permission) });
    check(server.process.pid === serverPid && server.process.exitCode === null, "NATIVE_SERVER_NOT_REUSED");
  }
  for (const test of cases) check(await exists(join(harness.workspace, `${test.id}.txt`)) === test.writes,
    "LATE_OR_CROSS_CASE_FILE_EFFECT");
  check(harness.memoryRequests.filter((request) => request.path === "/v1/memories/add").length === cases.filter((test) => !test.interrupt).length,
    "LATE_OR_CROSS_CASE_MEMORY_WRITEBACK");
  check(harness.serverErrors.length === 0, "LOCAL_RECEIVER_REPORTED_ERRORS");
  report.nativeServerReused = true;
  report.observedModelHttpRequests = harness.modelRequests.length;
  report.observedMemoryHttpRequests = harness.memoryRequests.length;
  report.status = "PASS";
} catch (error) {
  report.stage = stage;
  report.error = error.nativeCode ?? "PERMISSIONS_CHECK_FAILED_PRIVATE_OUTPUT_SUPPRESSED";
  report.receiverErrors = harness?.serverErrors ?? [];
  if (current) report.activeCaseModelRequests = current.modelRequests;
  if (stream) report.observedEventTypes = [...new Set(stream.events.map((event) => event.type))];
} finally {
  try {
    try { await stream?.close(); }
    finally { await harness?.close(); }
    report.cleanup = "PASS";
  } catch (error) { report.status = "FAIL"; report.cleanup = error.nativeCode ?? "FAILED_PRIVATE_OUTPUT_SUPPRESSED"; }
}
console.log(JSON.stringify(report, null, 2));
if (report.status !== "PASS") process.exitCode = 1;

function isIdle(event) { return event.type === "session.status" && event.properties?.status?.type === "idle"; }
function sessionAdds(sessionId) {
  return harness.memoryRequests.filter((request) => request.path === "/v1/memories/add" && request.body.session_id === sessionId);
}
async function exists(path) {
  try { await access(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
function visibleText(message) {
  return (message.parts ?? []).filter((part) => part.type === "text" && part.synthetic !== true && part.ignored !== true
    && part.sessionID === message.info.sessionID && part.messageID === message.info.id)
    .map((part) => part.text).join("\n\n").trim();
}
async function verifyWriteback({ sessionId, user, terminal, completed }) {
  // Trace is only a lifecycle observation. The SDK records above remain content authority.
  const tracePath = join(harness.stateHome, "debug", "traces", "opencode", "sessions", sessionId, "events.jsonl");
  const ended = await waitFor(async () => {
    const text = await readFile(tracePath, "utf8").catch((error) => { if (error.code === "ENOENT") return ""; throw error; });
    return text.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse).find((event) => event.type === "turn_end"
      && event.trace?.client === "opencode" && event.trace?.session_id === sessionId && event.trace?.turn_id === user.info.id);
  }, "PERMISSION_TURN_NOT_CLOSED_BY_PLUGIN");
  check(ended.outcome === (completed ? "completed" : "interrupted"), "PERMISSION_PLUGIN_TURN_OUTCOME_MISMATCH");
  if (!completed) {
    await delay(300);
    check(sessionAdds(sessionId).length === 0, "INTERRUPTED_PERMISSION_WROTE_MEMORY");
    return { requestCount: 0, nativeInterruptedTurnClosed: true, interruptedTurnNotWritten: true };
  }
  await waitFor(() => sessionAdds(sessionId).length > 0, "PERMISSION_TURN_DID_NOT_WRITE_BACK");
  const requests = sessionAdds(sessionId);
  check(requests.length === 1, "PERMISSION_WRITEBACK_COUNT_MISMATCH");
  const request = requests[0], body = request.body;
  check(request.method === "POST" && request.authorization === `Token ${fixtureKey}`, "PERMISSION_ADD_TRANSPORT_MISMATCH");
  check(body.metadata?.memorax_code_session_id === sessionId, "PERMISSION_WRITEBACK_SESSION_MISMATCH");
  check(body.user_id === `${fixtureUser}@${basename(harness.workspace)}`
    && body.metadata.memorax_code_base_user_id === fixtureUser
    && body.metadata.memorax_code_workspace === basename(harness.workspace)
    && body.metadata.memorax_code_memory_scope === "workspace-name.v1", "PERMISSION_WRITEBACK_SCOPE_MISMATCH");
  check(Array.isArray(body.messages) && body.messages.length >= 2 && body.messages[0].role === "user"
    && body.messages[1].role === "assistant", "PERMISSION_WRITEBACK_MESSAGES_MISMATCH");
  const userText = visibleText(user), assistantText = visibleText(terminal);
  check(userText && body.messages[0].content.includes(userText), "PERMISSION_NATIVE_USER_CONTENT_INCOMPLETE");
  check(assistantText && body.messages[1].content.includes(assistantText), "PERMISSION_NATIVE_ASSISTANT_CONTENT_INCOMPLETE");
  check(body.messages[0].timestamp === user.info.time.created && body.messages[1].timestamp === terminal.info.time.completed,
    "PERMISSION_NATIVE_TIMESTAMP_MISMATCH");
  check(body.metadata.memorax_code_timestamp_sources?.slice(0, 2).every((source) => source === "native")
    && body.metadata.memorax_code_timestamp_sources.length === body.messages.length, "PERMISSION_TIME_AUTHORITY_MISMATCH");
  const hash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);
  check(body.metadata.idempotency_key === `automatic:opencode:${hash(body.user_id)}:${sessionId}:${hash(body.messages[0].content)}:${hash(body.messages[1].content)}`,
    "PERMISSION_WRITEBACK_IDEMPOTENCY_MISMATCH");
  const serialized = JSON.stringify(body);
  for (const test of cases.filter((test) => test.id !== current.test.id)) {
    check(!serialized.includes(`permission fixture ${test.id}`), "FOREIGN_PERMISSION_CASE_ENTERED_WRITEBACK");
  }
  assertNoSensitivePayload(body, [fixtureKey, harness.root, harness.root.replaceAll("\\", "/"), current.marker]);
  return { requestCount: 1, selectedContentComplete: true, nativeSessionAndParentLineageMatched: true,
    scopeMatched: true, timestampsMatched: true, pluginTurnClosed: true,
    additionalContentObserved: body.messages[0].content !== userText || body.messages[1].content !== assistantText || body.messages.length > 2 };
}

async function subscribeEvents(server) {
  const controller = new AbortController();
  const response = await server.request("/event", { raw: true, signal: controller.signal });
  check(response.ok && response.body, "NATIVE_EVENT_STREAM_UNAVAILABLE");
  const events = [];
  let failure;
  const finished = (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n");
      check(buffer.length < 2 * 1024 * 1024, "NATIVE_EVENT_STREAM_BUFFER_LIMIT");
      let end;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame.split("\n").filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart()).join("\n");
        if (data) events.push(JSON.parse(data));
        check(events.length < 20_000, "NATIVE_EVENT_COUNT_LIMIT");
      }
    }
    if (!controller.signal.aborted) failure = "NATIVE_EVENT_STREAM_ENDED_EARLY";
  })().catch((error) => { if (!controller.signal.aborted) failure = error.nativeCode ?? "NATIVE_EVENT_STREAM_FAILED"; });
  return {
    events,
    wait: (predicate, after = 0) => waitFor(() => {
      check(!failure, failure);
      return events.slice(after).find(predicate);
    }, "NATIVE_PERMISSION_EVENT_TIMEOUT", 45_000),
    async close() { controller.abort(); await finished; },
  };
}
