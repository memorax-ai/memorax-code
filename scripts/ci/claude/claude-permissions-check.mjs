#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, readFile, readdir, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { check, createNativeHarness, fixtureKey, fixtureModel, fixtureUser, waitFor } from "./claude-native-support.mjs";
import { assertCompleteText, assertNoForeignContent, assertWritebackMessages } from "../codex/codex-native-content-check.mjs";
import { selectNativeMemoraxPlugin, selectNativeTurnContent } from "./claude-native-content-check.mjs";
import { ClaudeControlSession, inflightScript, permissionArguments, selectInterruptedTurn, summarizePermissionToolResult, textContent } from "./claude-permissions-support.mjs";

const cases = [
  { id: "policy-allow", preallowed: true, writes: true },
  { id: "user-allow", decision: "allow", writes: true },
  { id: "user-deny", decision: "deny", writes: false },
  { id: "user-cancel", decision: "cancel", interrupted: true, writes: false },
  { id: "user-wait-interrupt", interrupted: true, writes: false },
  { id: "user-inflight-interrupt", decision: "allow", inflight: true, interrupted: true, writes: false },
];
const report = { status: "FAIL", suite: "native_claude_permissions", platform: process.platform,
  paidModelRequests: 0, modelQualityEvaluated: false,
  scope: "Native CLI control protocol, actual tool effects, transcript lineage and automatic writeback",
  interruptedTraceReconciliationValidated: false,
  excludes: ["desktop approval UI", "OS sandbox or privilege enforcement", "LLM automatic approval quality",
    "background Repo Memory permissions", "late approval after cancellation", "interrupted trace reconciliation"], cases: [] };
const completedCases = [], canceledContent = [], toolPids = new Set();
let harness, control, current, pluginRoots, stage = "prerequisites";

try {
  check(process.argv.length === 5, "EXPECTED_INSTALLED_PACKAGE_CLAUDE_PATH_AND_VERSION");
  harness = await createNativeHarness({ packageRoot: resolve(process.argv[2]), claudeCommand: resolve(process.argv[3]),
    expectedVersion: process.argv[4], label: "permissions" });
  stage = "installed plugin setup";
  const status = await harness.setup();
  const marketplace = join(harness.packageRoot, "lib", "memorax-code-claude-marketplace");
  const manifest = JSON.parse(await readFile(join(marketplace, ".claude-plugin", "marketplace.json"), "utf8"));
  const declared = manifest.plugins.filter((plugin) => plugin.name === "memorax-code-claude-adapter");
  check(declared.length === 1 && typeof declared[0].source === "string"
    && status.claudeAdapter.pluginStatus?.enabled === true, "PERMISSION_INSTALLED_PLUGIN_MISSING");
  pluginRoots = [await realpath(join(marketplace, declared[0].source)), await realpath(status.claudeAdapter.pluginStatus.installPath)];
  report.claudeVersion = harness.claudeVersion;
  check(harness.memoryRequests.length === 0 && harness.modelRequests.length === 0, "SETUP_MADE_EXTERNAL_REQUESTS");
  harness.setModelHandler((body) => {
    check(current && body.model === fixtureModel, "PERMISSION_MODEL_SUBSTITUTION");
    check(++current.modelRequests <= 2, "UNEXPECTED_PERMISSION_MODEL_RETRY");
    check(JSON.stringify(body.messages).includes(current.prompt), "PERMISSION_MODEL_PROMPT_MISMATCH");
    if (current.recovering) {
      check(JSON.stringify(body.messages).includes(current.recoveryPrompt), "PERMISSION_RECOVERY_PROMPT_MISSING");
      check(modelToolResult(body).is_error === true, "PERMISSION_RECOVERY_LOST_NATIVE_TOOL_RESULT");
      return { text: current.recoveryAnswer };
    }
    if (current.modelRequests === 1) {
      check(body.tools?.some((tool) => tool.name === current.tool.name), "PERMISSION_NATIVE_TOOL_NOT_ADVERTISED");
      return { text: current.intermediate, toolCalls: [current.tool] };
    }
    if (current.test.inflight) current.earlyToolResult ??= summarizePermissionToolResult(modelToolResult(body));
    check(!current.test.interrupted, "INTERRUPTED_PERMISSION_CONTINUED_MODEL_EXECUTION");
    const result = modelToolResult(body);
    check((result.is_error === true) === !current.test.writes, "PERMISSION_NATIVE_TOOL_RESULT_MISMATCH");
    current.toolResultObserved = true;
    return { text: current.answer };
  });

  for (const test of cases) {
    stage = test.id;
    current = { test, modelRequests: 0, toolResultObserved: false, recovering: false,
      prompt: `Run the isolated Claude permission fixture ${test.id}.`,
      intermediate: `CLAUDE_PERMISSION_PARTIAL_${test.id}`,
      answer: `Claude permission fixture ${test.id} is complete.`,
      recoveryPrompt: `Complete the independent follow-up ${test.id}.`,
      recoveryAnswer: `The independent follow-up ${test.id} is complete.`,
      marker: `CLAUDE_PERMISSION_MARKER_${test.id}`, markerPath: join(harness.workspace, `${test.id}.txt`),
      startedPath: join(harness.workspace, `${test.id}-started.json`),
    };
    current.tool = test.inflight ? { id: `permission-${test.id}`, name: "Bash", input: {
      command: inflightCommand(current), description: "Run the bounded isolated permission fixture", timeout: 120000,
    } } : { id: `permission-${test.id}`, name: "Write", input: { file_path: current.markerPath, content: current.marker } };
    check(!await exists(current.markerPath) && !await exists(current.startedPath), "PERMISSION_MARKER_EXISTS_BEFORE_TOOL");
    const result = { id: test.id, status: "FAIL" };
    report.cases.push(result);
    control = new ClaudeControlSession(harness.spawnClaude(permissionArguments({ allowedTool: test.preallowed ? "Write" : undefined })));
    const initialized = await control.request({ subtype: "initialize", hooks: null });
    check(initialized?.current_permission_mode === "default", "PERMISSION_EFFECTIVE_MODE_MISMATCH");
    control.prompt(current.prompt);
    const init = await control.wait((event) => event.type === "system" && event.subtype === "init");
    current.sessionId = init.session_id;
    check(typeof current.sessionId === "string" && /^[0-9a-f-]{36}$/i.test(current.sessionId)
      && init.model === fixtureModel && init.permissionMode === "default"
      && init.claude_code_version === harness.claudeVersion, "PERMISSION_NATIVE_INIT_MISMATCH");
    check(pluginRoots.includes(await realpath(selectNativeMemoraxPlugin(init.plugins).path)), "PERMISSION_PLUGIN_SOURCE_MISMATCH");
    let approval;
    if (!test.preallowed) {
      approval = await control.wait((event) => event.type === "control_request" && event.request?.subtype === "can_use_tool");
      check(approval.request.tool_name === current.tool.name && approval.request.tool_use_id === current.tool.id
        && isDeepStrictEqual(approval.request.input, current.tool.input), "PERMISSION_REQUEST_TOOL_IDENTITY_MISMATCH");
      await assertPending(approval);
      if (test.decision) control.respond(approval, test.decision === "allow"
        ? { behavior: "allow", updatedInput: approval.request.input }
        : { behavior: "deny", message: "Synthetic permission rejection.", ...(test.decision === "cancel" ? { interrupt: true } : {}) });
      if (test.inflight) {
        await waitFor(() => exists(current.startedPath), "PERMISSION_TOOL_DID_NOT_START");
        const started = JSON.parse(await readFile(current.startedPath, "utf8"));
        check(started.marker === current.marker && Number.isSafeInteger(started.pid) && started.pid > 0
          && started.pid !== process.pid && alive(started.pid), "PERMISSION_STARTED_PROCESS_INVALID");
        current.toolPid = started.pid;
        toolPids.add(started.pid);
        check(!await exists(current.markerPath), "PERMISSION_TOOL_FINISHED_BEFORE_INTERRUPT");
        check(sessionAdds().length === 0, "INFLIGHT_PERMISSION_WROTE_MEMORY");
      }
      if (test.interrupted && test.decision !== "cancel") {
        await control.request({ subtype: "interrupt" });
        if (!test.inflight) await control.wait((event) => event.type === "control_cancel_request" && event.request_id === approval.request_id);
      }
    }
    const terminal = await control.wait((event) => event.type === "result");
    check(terminal.session_id === current.sessionId, "PERMISSION_RESULT_SESSION_MISMATCH");
    if (test.interrupted) {
      check(terminal.is_error === true && terminal.subtype === "error_during_execution"
        && terminal.stop_reason === "tool_use", "PERMISSION_NATIVE_INTERRUPTION_RESULT_MISSING");
      check(current.modelRequests === 1 && sessionAdds().length === 0, "INTERRUPTED_PERMISSION_WROTE_OR_CONTINUED");
      const marker = await control.wait((event) => event.type === "user" && event.session_id === current.sessionId
        && textContent(event.message?.content) === "[Request interrupted by user for tool use]");
      const interrupted = selectInterruptedTurn(await transcript(marker.uuid), { sessionId: current.sessionId,
        interruptionUuid: marker.uuid, prompt: current.prompt, toolCall: current.tool });
      const initialTrace = await trace();
      check(initialTrace.some((event) => event.type === "turn_start" && event.trace?.turn_id === interrupted.promptId),
        "PERMISSION_INTERRUPTED_PROMPT_HOOK_MISSING");
      if (test.inflight) {
        await waitFor(() => !alive(current.toolPid), "PERMISSION_INTERRUPTED_TOOL_PROCESS_REMAINS");
        toolPids.delete(current.toolPid);
      }
      check(!await exists(current.markerPath), "PERMISSION_INTERRUPTED_TOOL_COMPLETED_EFFECT");
      canceledContent.push(current.prompt, current.intermediate, current.answer);
      current.recovering = true;
      const recoveryIndex = control.events.length;
      control.prompt(current.recoveryPrompt);
      const recovered = await control.wait((event) => event.type === "result", recoveryIndex);
      assertSuccess(recovered, current.recoveryAnswer);
      result.writeback = await verifyCompleted({ prompt: current.recoveryPrompt, answer: current.recoveryAnswer, after: recoveryIndex });
      const endEvents = (await trace()).filter((event) => event.type === "turn_end" && event.trace?.turn_id === interrupted.promptId);
      Object.assign(result, { nativeInterruptedPromptMatched: true, nativeControlCancelObserved: !test.inflight && test.decision !== "cancel",
        hasInterruptedMessageId: interrupted.hasInterruptedMessageId,
        observedInterruptedTraceEnds: endEvents.filter((event) => event.outcome === "interrupted").length,
        sameSessionRecovered: recovered.session_id === current.sessionId, interruptedTurnNotWritten: true,
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
    control = undefined;
    Object.assign(result, { status: "PASS", nativeTurnOutcome: test.interrupted ? "interrupted_then_recovered" : "completed",
      targetWritten: test.writes, observedPendingWithoutSideEffect: Boolean(approval), modelRequests: current.modelRequests });
    completedCases.push({ ...current });
  }
  stage = "cross-case isolation";
  for (const completed of completedCases) {
    check((await exists(completed.markerPath)) === completed.test.writes, "PERMISSION_LATE_FILE_EFFECT");
    const requests = harness.memoryRequests.filter((request) => request.body.session_id === completed.sessionId);
    check(requests.length === 1, "PERMISSION_LATE_OR_MISSING_WRITEBACK");
    assertNoForeignContent(requests[0].body.messages, completedCases.filter((entry) => entry !== completed
      && entry.sessionId !== completed.sessionId).flatMap((entry) => [entry.prompt, entry.answer, entry.recoveryPrompt, entry.recoveryAnswer]));
  }
  for (const request of harness.memoryRequests) {
    assertNoForeignContent(request.body.messages, [...canceledContent, ...completedCases.flatMap((entry) => [entry.intermediate, entry.marker]),
      fixtureKey, harness.root, harness.root.replaceAll("\\", "/")]);
    const serialized = JSON.stringify(request.body);
    for (const forbidden of [fixtureKey, harness.root, harness.root.replaceAll("\\", "/")]) {
      check(!serialized.includes(JSON.stringify(forbidden).slice(1, -1)), "PERMISSION_PRIVATE_METADATA_ENTERED_MEMORY");
    }
  }
  check(harness.memoryRequests.length === cases.length && harness.modelRequests.length === cases.length * 2,
    "PERMISSION_UNEXPECTED_RECEIVER_REQUEST_COUNT");
  check(harness.serverErrors.length === 0, "PERMISSION_LOCAL_RECEIVER_FAILED");
  report.observedModelHttpRequests = harness.modelRequests.length;
  report.observedMemoryHttpRequests = harness.memoryRequests.length;
  report.status = "PASS";
} catch (error) {
  report.stage = stage;
  report.error = error.nativeCode ?? "PERMISSION_CHECK_FAILED_PRIVATE_OUTPUT_SUPPRESSED";
  report.receiverErrors = harness?.serverErrors ?? [];
  if (current) report.activeCaseModelRequests = current.modelRequests;
  if (current?.earlyToolResult) report.unexpectedInflightToolResult = current.earlyToolResult;
} finally {
  let cleanupError;
  try { control?.endInput(); } catch (error) { cleanupError = error; }
  // The fixture worker never spawns children; its exact owned PID is a final
  // cleanup fallback, not native-interruption evidence or general containment.
  for (const pid of toolPids) {
    try {
      if (alive(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
        await waitFor(() => !alive(pid), "PERMISSION_FIXTURE_PROCESS_REMAINS");
      }
    } catch (error) { cleanupError ??= error; }
  }
  try { await harness?.close(); } catch (error) { cleanupError ??= error; }
  if (cleanupError) {
    report.status = "FAIL";
    report.cleanup = cleanupError.nativeCode ?? "PERMISSION_CLEANUP_FAILED_PRIVATE_OUTPUT_SUPPRESSED";
  } else report.cleanup = "PASS";
}
console.log(JSON.stringify(report, null, 2));
if (report.status !== "PASS") process.exitCode = 1;

function sessionAdds() {
  return harness.memoryRequests.filter((request) => request.path === "/v1/memories/add" && request.body.session_id === current.sessionId);
}
function modelToolResult(body) {
  const results = body.messages?.flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .filter((part) => part.type === "tool_result" && part.tool_use_id === current.tool.id);
  check(results?.length === 1, "PERMISSION_MATCHING_NATIVE_TOOL_RESULT_MISSING");
  return results[0];
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
    && event.stop_reason === "end_turn" && event.result === answer, "PERMISSION_NATIVE_TURN_NOT_COMPLETED");
}
async function transcript(expectedUuid, finalAssistant = false) {
  check(typeof expectedUuid === "string" && expectedUuid.length > 0, "PERMISSION_NATIVE_UUID_MISSING");
  const root = join(harness.claudeHome, "projects");
  // Native stdout can precede its JSONL flush. Wait for this exact UUID, while
  // malformed complete records and conflicting transcript identities fail closed.
  return waitFor(async () => {
    const files = await readdir(root, { recursive: true }).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
    const paths = files.filter((path) => basename(path) === `${current.sessionId}.jsonl`);
    check(paths.length <= 1, "PERMISSION_NATIVE_TRANSCRIPT_NOT_UNIQUE");
    if (!paths.length) return undefined;
    const text = await readFile(join(root, paths[0]), "utf8").catch((error) => { if (error.code === "ENOENT") return ""; throw error; });
    if (!text.endsWith("\n")) return undefined;
    let records;
    try { records = text.trim().split(/\r?\n/).map(JSON.parse); }
    catch { check(false, "PERMISSION_NATIVE_TRANSCRIPT_INVALID_JSON"); }
    const matching = records.filter((record) => record.uuid === expectedUuid);
    check(matching.length <= 1, "PERMISSION_NATIVE_TRANSCRIPT_UUID_DUPLICATED");
    if (!matching.length || (finalAssistant && matching[0].type === "assistant" && matching[0].message?.stop_reason == null)) return undefined;
    return records;
  }, "PERMISSION_NATIVE_TRANSCRIPT_NOT_MATERIALIZED");
}
async function trace() {
  const path = join(harness.stateHome, "debug", "traces", "claude", "sessions", current.sessionId, "events.jsonl");
  const events = (await readFile(path, "utf8")).trim().split(/\r?\n/).map(JSON.parse);
  check(events.every((event) => event.trace?.client === "claude" && event.trace.session_id === current.sessionId),
    "PERMISSION_TRACE_SESSION_MISMATCH");
  return events;
}
async function verifyCompleted({ prompt, answer, after = 0, tool, denied }) {
  const finals = control.events.slice(after).filter((event) => event.type === "assistant" && event.session_id === current.sessionId
    && textContent(event.message?.content) === answer);
  check(finals.length === 1 && typeof finals[0].uuid === "string", "PERMISSION_NATIVE_FINAL_UUID_MISSING");
  const selected = selectNativeTurnContent(await transcript(finals[0].uuid, true), { sessionId: current.sessionId, assistantUuid: finals[0].uuid, prompt, answer });
  if (tool) {
    const parts = selected.lineage.flatMap((record) => Array.isArray(record.message?.content) ? record.message.content : []);
    const calls = parts.filter((part) => part.type === "tool_use" && part.id === tool.id);
    const results = parts.filter((part) => part.type === "tool_result" && part.tool_use_id === tool.id);
    check(calls.length === 1 && calls[0].name === tool.name && isDeepStrictEqual(calls[0].input, tool.input)
      && results.length === 1 && (results[0].is_error === true) === denied, "PERMISSION_TRANSCRIPT_TOOL_MISMATCH");
  }
  await waitFor(() => sessionAdds().length > 0, "PERMISSION_COMPLETED_TURN_DID_NOT_WRITE_BACK");
  const requests = sessionAdds();
  check(requests.length === 1, "PERMISSION_SESSION_WRITEBACK_COUNT_MISMATCH");
  const request = requests[0], body = request.body;
  check(request.method === "POST" && request.authorization === `Token ${fixtureKey}`, "PERMISSION_MEMORY_TRANSPORT_MISMATCH");
  assertWritebackMessages(body.messages);
  assertCompleteText(body.messages[0].content, selected.user.content, "PERMISSION_NATIVE_PROMPT_INCOMPLETE");
  assertCompleteText(body.messages[1].content, selected.assistant.content, "PERMISSION_NATIVE_ANSWER_INCOMPLETE");
  check(body.metadata?.memorax_code_session_id === current.sessionId
    && body.user_id === `${fixtureUser}@${basename(harness.workspace)}` && body.metadata.memorax_code_base_user_id === fixtureUser
    && body.metadata.memorax_code_workspace === basename(harness.workspace)
    && body.metadata.memorax_code_memory_scope === "workspace-name.v1", "PERMISSION_MEMORY_SCOPE_MISMATCH");
  check(body.metadata.idempotency_key === `automatic:claude-code:${hash(body.user_id)}:${current.sessionId}:${hash(body.messages[0].content)}:${hash(body.messages[1].content)}`,
    "PERMISSION_AUTOMATIC_ADD_IDENTITY_MISMATCH");
  check(body.messages[0].timestamp === selected.user.timestamp && body.messages[1].timestamp === selected.assistant.timestamp
    && JSON.stringify(body.metadata.memorax_code_timestamp_sources) === JSON.stringify(["native", "native"]),
  "PERMISSION_NATIVE_TIMESTAMP_MISMATCH");
  const events = await trace();
  check(events.some((event) => event.type === "turn_start" && event.trace.turn_id === selected.promptId)
    && events.some((event) => event.type === "turn_end" && event.trace.turn_id === selected.promptId && event.outcome === "completed"),
  "PERMISSION_COMPLETED_HOOK_CORRELATION_MISSING");
  assertNoForeignContent(body.messages, canceledContent);
  return { requestCount: 1, nativeContentAndPromptLineageMatched: true, scopeAndTimestampsMatched: true,
    completedHookCorrelationMatched: true, interruptedContentExcluded: true };
}
function inflightCommand(fixture) {
  return [process.execPath.replaceAll("\\", "/"), "-e", inflightScript(fixture)].map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(" ");
}
async function exists(path) { try { await access(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; if (error.code === "EPERM") return true; throw error; } }
function hash(value) { return createHash("sha256").update(value).digest("hex").slice(0, 16); }
