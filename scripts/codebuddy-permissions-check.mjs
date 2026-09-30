#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { check, createNativeHarness, fixtureKey, fixtureModel, fixtureUser, waitFor } from "./codebuddy-native-support.mjs";
import { assertCompleteText, assertNoForeignContent, assertWritebackMessages } from "./codex-native-content-check.mjs";
import { nativeHookPrompt, selectNativeTurnContent, summarizeNativeCompletion } from "./codebuddy-native-content-check.mjs";
import { assertInitializedModel, assertNativeInterruption, assertPermissionInitializations, assertToolLineage,
  CodeBuddyControlSession, inflightCommand, inflightWorkerScript, modelToolResult,
  nativePrompt, permissionArguments, selectCanceledToolTurn, summarizeToolFailure } from "./codebuddy-permissions-support.mjs";

const cases = [
  { id: "policy-allow", preallowed: true, writes: true },
  { id: "user-allow", decision: "allow", writes: true },
  { id: "user-deny", decision: "deny", writes: false },
  { id: "user-cancel", decision: "cancel", interrupted: true, writes: false },
  { id: "user-inflight-interrupt", decision: "allow", inflight: true, interrupted: true, writes: false },
  { id: "user-wait-interrupt", interrupted: true, writes: false },
];
const report = { status: "FAIL", suite: "native_codebuddy_permissions", platform: process.platform,
  paidModelRequests: 0, modelQualityEvaluated: false,
  scope: "Native CLI permission protocol, actual tool effects, native transcript and automatic writeback",
  interruptedTraceReconciliationValidated: false,
  excludes: ["desktop approval UI", "OS sandbox or privilege enforcement", "LLM automatic approval quality",
    "background Repo Memory permissions", "late approval after cancellation", "interrupted trace reconciliation"], cases: [] };
const completedCases = [], canceledContent = [], toolPids = new Set();
let harness, control, current, cleanupPromise, suiteCompleted = false, stage = "prerequisites";

try {
  check(process.argv.length === 5, "EXPECTED_INSTALLED_PACKAGE_CODEBUDDY_PATH_AND_VERSION");
  harness = await createNativeHarness({ packageRoot: resolve(process.argv[2]), codebuddyCommand: resolve(process.argv[3]),
    expectedVersion: process.argv[4], label: "permissions" });
  harness.setBeforeClose(cleanupFixtures);
  stage = "installed plugin setup";
  await harness.setup();
  report.codebuddyVersion = harness.codebuddyVersion;
  check(harness.memoryRequests.length === 0 && harness.modelRequests.length === 0, "SETUP_MADE_UNEXPECTED_REQUESTS");
  const scriptPath = join(harness.workspace, "permission-inflight-worker.cjs");
  await writeFile(scriptPath, inflightWorkerScript, { mode: 0o600 });
  harness.setModelHandler(async (body) => {
    check(current && body.model === fixtureModel, "PERMISSION_MODEL_SUBSTITUTION");
    check(++current.modelRequests <= 2, "UNEXPECTED_PERMISSION_MODEL_RETRY");
    if (current.recovering) {
      check(JSON.stringify(body.messages).includes(current.recoveryPrompt), "PERMISSION_RECOVERY_PROMPT_MISSING");
      return { text: current.recoveryAnswer };
    }
    check(JSON.stringify(body.messages).includes(current.prompt), "PERMISSION_MODEL_PROMPT_MISMATCH");
    if (current.modelRequests === 1) {
      check(body.tools?.some((tool) => tool.type === "function" && tool.function?.name === current.tool.name),
        "PERMISSION_NATIVE_TOOL_NOT_ADVERTISED");
      return { toolCalls: [current.tool] };
    }
    const text = modelToolResult(body, current.tool.id);
    if (current.test.inflight) current.earlyToolResult ??= summarizeToolFailure(text);
    check(!current.test.interrupted, "INTERRUPTED_PERMISSION_CONTINUED_MODEL_EXECUTION");
    if (current.test.writes) check(await readFile(current.markerPath, "utf8") === current.marker, "PERMISSION_TOOL_RESULT_WITHOUT_FILE_EFFECT");
    else check(!await exists(current.markerPath) && text.includes(current.denialReason), "PERMISSION_NATIVE_DENIAL_RESULT_MISSING");
    current.toolResultObserved = true;
    return { text: current.answer };
  });

  for (const test of cases) {
    stage = test.id;
    current = { test, modelRequests: 0, toolResultObserved: false, recovering: false,
      prompt: `Run the isolated CodeBuddy permission fixture ${test.id}.`,
      answer: `CodeBuddy permission fixture ${test.id} is complete.`,
      recoveryPrompt: `Complete the independent follow-up ${test.id}.`,
      recoveryAnswer: `The independent follow-up ${test.id} is complete.`,
      denialReason: `CODEBUDDY_PERMISSION_DENIED_${test.id}`,
      marker: `CODEBUDDY_PERMISSION_MARKER_${test.id}`, markerPath: join(harness.workspace, `${test.id}.txt`),
      startedPath: join(harness.workspace, `${test.id}-started.json`),
    };
    current.tool = test.inflight ? { id: `permission-${test.id}`, name: "Bash", input: {
      command: inflightCommand({ executable: process.execPath, scriptPath, ...current }),
      description: "Run the bounded isolated permission fixture", timeout: 120000,
    } } : { id: `permission-${test.id}`, name: "Write", input: { file_path: current.markerPath, content: current.marker } };
    check(!await exists(current.markerPath) && !await exists(current.startedPath), "PERMISSION_MARKER_EXISTS_BEFORE_TOOL");
    const result = { id: test.id, status: "FAIL" };
    report.cases.push(result);
    control = new CodeBuddyControlSession(harness.startCodeBuddy(permissionArguments({ allowedTool: test.preallowed ? "Write" : undefined })));
    const initialized = await control.request({ subtype: "initialize" });
    assertInitializedModel(initialized);
    control.prompt(current.prompt);
    const init = await control.wait((event) => event.type === "system" && event.subtype === "init");
    current.sessionId = init.session_id;
    assertPermissionInitializations([init], current.sessionId);
    let approval;
    if (!test.preallowed) {
      approval = await control.wait((event) => event.type === "control_request" && event.request?.subtype === "can_use_tool");
      check(approval.request.tool_name === current.tool.name && approval.request.tool_use_id === current.tool.id
        && isDeepStrictEqual(approval.request.input, current.tool.input), "PERMISSION_REQUEST_TOOL_IDENTITY_MISMATCH");
      await assertPending(approval);
      if (test.decision) control.respond(approval, test.decision === "allow"
        ? { allowed: true, updatedInput: approval.request.input }
        : { allowed: false, reason: current.denialReason, interrupt: test.decision === "cancel" });
      if (test.inflight) {
        await waitFor(() => exists(current.startedPath), "PERMISSION_TOOL_DID_NOT_START");
        current.toolPid = await readFixturePid(current);
        toolPids.add(current.toolPid);
        check(alive(current.toolPid), "PERMISSION_STARTED_PROCESS_NOT_RUNNING");
        check(!await exists(current.markerPath), "PERMISSION_TOOL_FINISHED_BEFORE_INTERRUPT");
        check(sessionAdds().length === 0, "INFLIGHT_PERMISSION_WROTE_MEMORY");
      }
      if (test.interrupted && test.decision !== "cancel") {
        const interrupted = await control.request({ subtype: "interrupt", session_id: current.sessionId, reason: "Native CI cancellation" });
        check(interrupted?.interrupted === true && interrupted.session_id === current.sessionId,
          "PERMISSION_NATIVE_INTERRUPT_ACK_MISMATCH");
        result.nativeInterruptAcknowledged = true;
      }
    }
    const terminal = await control.wait((event) => event.type === "result");
    check(terminal.session_id === current.sessionId, "PERMISSION_RESULT_SESSION_MISMATCH");
    if (test.interrupted) {
      const interruptionKind = assertNativeInterruption(terminal, current.sessionId,
        { permissionCancellationTool: test.decision === "cancel" ? current.tool : undefined });
      check(current.modelRequests === 1 && sessionAdds().length === 0, "INTERRUPTED_PERMISSION_WROTE_OR_CONTINUED");
      const records = await transcript({ prompt: current.prompt, toolId: current.tool.id });
      const interrupted = selectCanceledToolTurn(records, { sessionId: current.sessionId, prompt: current.prompt, tool: current.tool });
      await findPromptTrace(current.prompt);
      if (test.inflight) {
        await waitFor(() => !alive(current.toolPid), "PERMISSION_INTERRUPTED_TOOL_PROCESS_REMAINS");
        toolPids.delete(current.toolPid);
      }
      check(!await exists(current.markerPath), "PERMISSION_INTERRUPTED_TOOL_COMPLETED_EFFECT");
      canceledContent.push(current.prompt, current.answer);
      current.recovering = true;
      const recoveryIndex = control.events.length;
      control.prompt(current.recoveryPrompt, current.sessionId);
      const recovered = await control.wait((event) => event.type === "result", recoveryIndex);
      assertSuccess(recovered, current.recoveryAnswer);
      result.writeback = await verifyCompleted({ prompt: current.recoveryPrompt, answer: current.recoveryAnswer });
      Object.assign(result, { nativeInterruptionResultMatched: true, nativeInterruptionResultKind: interruptionKind,
        nativeCanceledToolRequestMatched: true,
        nativeCanceledToolResultRecorded: interrupted.toolResultRecorded,
        sameSessionRecovered: true, interruptedTurnNotWritten: true,
        ...(test.inflight ? { toolStartedBeforeInterrupt: true, interruptedToolProcessExited: true } : {}) });
    } else {
      assertSuccess(terminal, current.answer);
      check(current.toolResultObserved, "PERMISSION_NATIVE_TOOL_RESULT_NOT_RETURNED_TO_MODEL");
      result.writeback = await verifyCompleted({ prompt: current.prompt, answer: current.answer, tool: current.tool, denied: !test.writes });
    }
    check(control.events.filter((event) => event.type === "control_request").length === (test.preallowed ? 0 : 1),
      "PERMISSION_UNEXPECTED_APPROVAL_COUNT");
    check((await exists(current.markerPath)) === test.writes, "PERMISSION_UNEXPECTED_FILE_EFFECT");
    if (test.writes) check(await readFile(current.markerPath, "utf8") === current.marker, "PERMISSION_FILE_CONTENT_MISMATCH");
    check(current.modelRequests === 2, "PERMISSION_MODEL_REQUEST_COUNT_MISMATCH");
    await control.finish();
    assertPermissionInitializations(control.events, current.sessionId);
    control = undefined;
    completedCases.push({ ...current });
    Object.assign(result, { status: "PASS", nativeTurnOutcome: test.interrupted ? "interrupted_then_recovered" : "completed",
      targetWritten: test.writes, observedPendingWithoutSideEffect: Boolean(approval), modelRequests: current.modelRequests });
  }
  stage = "cross-case isolation";
  await auditReceivers();
  suiteCompleted = true;
} catch (error) {
  report.stage = stage;
  report.error = error.nativeCode ?? "PERMISSION_CHECK_FAILED_PRIVATE_OUTPUT_SUPPRESSED";
  report.receiverErrors = harness?.serverErrors ?? [];
  if (current) report.activeCaseModelRequests = current.modelRequests;
  if (current && control) {
    try {
      report.nativeCompletion = summarizeNativeCompletion(control.events, {
        answer: current.answer, model: fixtureModel, modelRequests: current.modelRequests,
        memoryRequests: sessionAdds().length, receiverErrors: harness.serverErrors,
      });
    } catch { report.nativeCompletion = { available: false }; }
  }
  if (current?.earlyToolResult) report.unexpectedInflightToolResult = current.earlyToolResult;
  if (current?.test.inflight && current.toolPid) {
    try {
      report.inflightInterruption = {
        toolProcessAlive: alive(current.toolPid),
        finalMarkerPresent: await exists(current.markerPath),
      };
    } catch { report.inflightInterruption = { available: false }; }
  }
} finally {
  try { await harness?.close(); report.cleanup = "PASS"; }
  catch (error) { report.cleanup = error.nativeCode ?? "PERMISSION_CLEANUP_FAILED_PRIVATE_OUTPUT_SUPPRESSED"; }
}
if (suiteCompleted && report.cleanup === "PASS") {
  try {
    // Backend stop completes before the final count, so late requests cannot be
    // hidden by setting PASS while a cancellation writeback is still pending.
    auditMemory();
    report.observedModelHttpRequests = harness.modelRequests.length;
    report.observedMemoryHttpRequests = harness.memoryRequests.length;
    report.status = "PASS";
  } catch (error) { report.stage = "final receiver audit after cleanup"; report.error = error.nativeCode; }
}
console.log(JSON.stringify(report, null, 2));
if (report.status !== "PASS") process.exitCode = 1;

function sessionAdds() {
  return harness.memoryRequests.filter((request) => request.path === "/v1/memories/add" && request.body.session_id === current.sessionId);
}
async function assertPending(approval) {
  check(!await exists(current.markerPath) && !await exists(current.startedPath), "PERMISSION_TOOL_EXECUTED_BEFORE_APPROVAL");
  await delay(300);
  check(control.permissions.get(approval.request_id)?.status === "pending" && !control.events.some((event) => event.type === "result"),
    "PERMISSION_REQUEST_NOT_PENDING");
  check(!await exists(current.markerPath) && !await exists(current.startedPath), "PERMISSION_TOOL_EXECUTED_WHILE_PENDING");
  check(sessionAdds().length === 0, "PENDING_PERMISSION_WROTE_MEMORY");
}
function assertSuccess(event, answer) {
  check(event.session_id === current.sessionId && event.is_error === false && event.subtype === "success"
    && event.terminal_reason === undefined && event.result === answer, "PERMISSION_NATIVE_TURN_NOT_COMPLETED");
}
async function transcript({ prompt, answer, toolId }) {
  return waitFor(async () => {
    const home = await realpath(harness.codebuddyHome);
    const files = (await readdir(home, { recursive: true })).filter((path) => basename(path) === `${current.sessionId}.jsonl`);
    check(files.length <= 1, "PERMISSION_NATIVE_TRANSCRIPT_NOT_UNIQUE");
    if (!files.length) return undefined;
    const path = await realpath(join(home, files[0]));
    const rel = relative(home, path);
    check(rel !== ".." && !rel.startsWith(`..\\`) && !rel.startsWith("../") && !isAbsolute(rel), "PERMISSION_NATIVE_TRANSCRIPT_OUTSIDE_HOME");
    const text = await readFile(path, "utf8");
    if (!text.endsWith("\n")) return undefined;
    let records;
    try { records = text.trim().split(/\r?\n/).map(JSON.parse); }
    catch { check(false, "PERMISSION_NATIVE_TRANSCRIPT_INVALID_JSON"); }
    if (!records.some((record) => record.type === "message" && record.role === "user" && nativePrompt(record.content) === prompt)) return undefined;
    if (toolId && !records.some((record) => record.type === "function_call" && record.callId === toolId)) return undefined;
    if (answer && !records.some((record) => record.type === "message" && record.role === "assistant" && record.status === "completed"
      && record.content?.some((part) => part.type === "output_text" && part.text === answer))) return undefined;
    return records;
  }, "PERMISSION_NATIVE_TRANSCRIPT_NOT_MATERIALIZED");
}
async function findPromptTrace(prompt, completed = false) {
  return waitFor(async () => {
    const text = await readFile(join(harness.stateHome, "debug", "traces", "codebuddy", "sessions", current.sessionId, "events.jsonl"), "utf8")
      .catch((error) => { if (error.code === "ENOENT") return ""; throw error; });
    if (!text.endsWith("\n")) return undefined;
    const events = text.trim().split(/\r?\n/).map(JSON.parse);
    check(events.every((event) => event.trace?.client === "codebuddy" && event.trace.session_id === current.sessionId),
      "PERMISSION_TRACE_SESSION_MISMATCH");
    const starts = events.filter((event) => event.type === "turn_start" && event.trace.turn_id?.startsWith(`${current.sessionId}:`)
      && event.trace.turn_id.endsWith(`:${hash(nativeHookPrompt(prompt))}`));
    check(starts.length <= 1, "PERMISSION_HOOK_PROMPT_AMBIGUOUS");
    if (!starts.length || completed && !events.some((event) => event.type === "turn_end"
      && event.trace.turn_id === starts[0].trace.turn_id && event.outcome === "completed")) return undefined;
    return starts[0];
  }, "PERMISSION_HOOK_CORRELATION_MISSING");
}
async function verifyCompleted({ prompt, answer, tool, denied }) {
  const selected = selectNativeTurnContent(await transcript({ prompt, answer }), { sessionId: current.sessionId, prompt, finalText: answer });
  if (tool) assertToolLineage(selected.lineage, tool, { denied });
  await waitFor(() => sessionAdds().length > 0, "PERMISSION_COMPLETED_TURN_DID_NOT_WRITE_BACK");
  const requests = sessionAdds();
  check(requests.length === 1, "PERMISSION_SESSION_WRITEBACK_COUNT_MISMATCH");
  const request = requests[0], body = request.body;
  check(request.method === "POST" && request.authorization === `Token ${fixtureKey}`, "PERMISSION_MEMORY_TRANSPORT_MISMATCH");
  assertWritebackMessages(body.messages);
  assertCompleteText(body.messages[0].content, selected.user.content, "PERMISSION_NATIVE_PROMPT_INCOMPLETE");
  assertCompleteText(body.messages[1].content, selected.assistant.content, "PERMISSION_NATIVE_ANSWER_INCOMPLETE");
  check(body.metadata?.memorax_code_session_id === current.sessionId && body.user_id === `${fixtureUser}@${basename(harness.workspace)}`
    && body.metadata.memorax_code_base_user_id === fixtureUser && body.metadata.memorax_code_workspace === basename(harness.workspace)
    && body.metadata.memorax_code_memory_scope === "workspace-name.v1", "PERMISSION_MEMORY_SCOPE_MISMATCH");
  check(body.metadata.idempotency_key === `automatic:codebuddy:${shortHash(body.user_id)}:${current.sessionId}:${shortHash(body.messages[0].content)}:${shortHash(body.messages[1].content)}`,
    "PERMISSION_AUTOMATIC_ADD_IDENTITY_MISMATCH");
  for (const [index, source] of [selected.user, selected.assistant].entries()) if (source.timestamp !== undefined) {
    check(body.messages[index].timestamp === source.timestamp && body.metadata.memorax_code_timestamp_sources?.[index] === "native",
      "PERMISSION_NATIVE_TIMESTAMP_MISMATCH");
  }
  await findPromptTrace(prompt, true);
  assertNoForeignContent(body.messages, canceledContent);
  return { requestCount: 1, nativeContentAndToolLineageMatched: true, scopeAndAvailableTimestampsMatched: true,
    completedHookCorrelationMatched: true, interruptedContentExcluded: true };
}
async function auditReceivers() {
  for (const completed of completedCases) check((await exists(completed.markerPath)) === completed.test.writes, "PERMISSION_LATE_FILE_EFFECT");
  auditMemory();
}
function auditMemory() {
  check(completedCases.length === cases.length && new Set(completedCases.map((item) => item.sessionId)).size === cases.length,
    "PERMISSION_CASE_SESSION_ISOLATION_FAILED");
  for (const completed of completedCases) {
    const requests = harness.memoryRequests.filter((request) => request.body.session_id === completed.sessionId);
    check(requests.length === 1 && requests[0].path === "/v1/memories/add", "PERMISSION_LATE_OR_MISSING_WRITEBACK");
    assertNoForeignContent(requests[0].body.messages, completedCases.filter((entry) => entry !== completed)
      .flatMap((entry) => [entry.prompt, entry.answer, entry.recoveryPrompt, entry.recoveryAnswer]));
  }
  for (const request of harness.memoryRequests) {
    assertNoForeignContent(request.body.messages, [...canceledContent, ...completedCases.flatMap((entry) => [entry.marker, entry.denialReason]),
      fixtureKey, harness.root, harness.root.replaceAll("\\", "/")]);
    const serialized = JSON.stringify(request.body);
    for (const forbidden of [fixtureKey, harness.root, harness.root.replaceAll("\\", "/")]) {
      check(!serialized.includes(JSON.stringify(forbidden).slice(1, -1)), "PERMISSION_PRIVATE_METADATA_ENTERED_MEMORY");
    }
  }
  check(harness.memoryRequests.length === cases.length && harness.modelRequests.length === cases.length * 2,
    "PERMISSION_UNEXPECTED_RECEIVER_REQUEST_COUNT");
  check(harness.serverErrors.length === 0, "PERMISSION_LOCAL_RECEIVER_FAILED");
}
function cleanupFixtures() {
  return cleanupPromise ??= (async () => {
    let error;
    try { control?.endInput(); } catch (caught) { error = caught; }
    try {
      if (current?.test.inflight && current.toolPid === undefined && await exists(current.startedPath)) {
        toolPids.add(await readFixturePid(current));
      }
    } catch (caught) { error ??= caught; }
    // Only this generated worker's exact PID is a fallback. Killing it here is
    // cleanup, never evidence that CodeBuddy implemented interruption correctly.
    for (const pid of toolPids) try {
      if (alive(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch (caught) { if (caught.code !== "ESRCH") throw caught; }
        await waitFor(() => !alive(pid), "PERMISSION_FIXTURE_PROCESS_REMAINS");
      }
    } catch (caught) { error ??= caught; }
    if (error) throw error;
  })();
}
async function readFixturePid(fixture) {
  const record = JSON.parse(await readFile(fixture.startedPath, "utf8"));
  check(record.marker === fixture.marker && Number.isSafeInteger(record.pid) && record.pid > 1 && record.pid !== process.pid,
    "PERMISSION_STARTED_PROCESS_INVALID");
  return record.pid;
}
async function exists(path) { try { await access(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; if (error.code === "EPERM") return true; throw error; } }
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function shortHash(value) { return hash(value).slice(0, 16); }
