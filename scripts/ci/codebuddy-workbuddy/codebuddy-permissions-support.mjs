import { isDeepStrictEqual } from "node:util";
import { check, fixtureModel, waitFor } from "./codebuddy-native-support.mjs";
import { matchesNativeModel, selectNativeTurnContent } from "./codebuddy-native-content-check.mjs";

export function permissionInvocation(args) {
  const client = args[3] ?? "codebuddy";
  check(client === "codebuddy" || client === "workbuddy", "NATIVE_CLIENT_INVALID");
  check(args.length === 3 || args.length === 4 || client === "workbuddy" && args.length === 6,
    `EXPECTED_INSTALLED_PACKAGE_${client.toUpperCase()}_PATH_AND_VERSION`);
  const [packageRoot, command, expectedVersion] = args;
  check([packageRoot, command, expectedVersion].every(identifier), `EXPECTED_INSTALLED_PACKAGE_${client.toUpperCase()}_PATH_AND_VERSION`);
  if (client === "workbuddy") check(/^\d+\.\d+\.\d+$/.test(expectedVersion), "EXPECTED_EXACT_WORKBUDDY_RUNTIME_VERSION");
  const interruptCase = args[5];
  if (args.length === 6) check(args[4] === "--interrupt-case" && identifier(interruptCase), "EXPECTED_WORKBUDDY_INTERRUPT_CASE");
  permissionCases(client, interruptCase);
  return { client, packageRoot, command, expectedVersion, ...(interruptCase === undefined ? {} : { interruptCase }) };
}

export function permissionCases(client = "codebuddy", interruptCase) {
  check(client === "codebuddy" || client === "workbuddy", "NATIVE_CLIENT_INVALID");
  const cases = [
    { id: "policy-allow", preallowed: true, writes: true },
    { id: "user-allow", decision: "allow", writes: true },
    { id: "user-deny", decision: "deny", writes: false },
    { id: "user-cancel", decision: "cancel", interrupted: true, writes: false },
    { id: "user-inflight-interrupt", decision: "allow", inflight: true, interrupted: true, nativeInterrupt: true, writes: false },
    { id: "user-wait-interrupt", interrupted: true, nativeInterrupt: true, writes: false },
  ];
  if (interruptCase !== undefined) {
    check(client === "workbuddy" && cases.some((test) => test.id === interruptCase && test.nativeInterrupt),
      "EXPECTED_WORKBUDDY_INTERRUPT_CASE");
    return cases.filter((test) => test.id === interruptCase);
  }
  return client === "workbuddy" ? cases.filter((test) => !test.nativeInterrupt) : cases;
}

export function createPermissionReport(client = "codebuddy", platform = process.platform, interruptCase) {
  permissionCases(client, interruptCase);
  return { status: "FAIL", suite: interruptCase === undefined ? `native_${client}_permissions` : "native_workbuddy_interrupt_diagnostic", platform,
    paidModelRequests: 0, modelQualityEvaluated: false,
    scope: client === "codebuddy" ? "MemoraX automatic writeback against native permission outcomes, with separate interrupt compatibility observations"
      : interruptCase === undefined ? "MemoraX automatic writeback for native approval, denial and permission cancellation; explicit runtime interrupts are separate diagnostics"
        : "Strict native WorkBuddy explicit-interrupt diagnostic, excluded from default permission acceptance",
    nativeInterruptSemanticsValidated: false,
    interruptedTraceReconciliationValidated: false,
    ...(client === "workbuddy" ? { desktopUIValidated: false, loginFlowValidated: false } : {}),
    ...(interruptCase !== undefined ? { diagnosticOnly: true, interruptCase }
      : client === "workbuddy" ? { excludedCases: [
        { id: "user-inflight-interrupt", status: "NOT_RUN", reason: "Native cancellation results can conflict with the recovery request owner; strict manual diagnostic only" },
        { id: "user-wait-interrupt", status: "NOT_RUN", reason: "Native SDK interrupt can leave permission pending without a terminal result; strict manual diagnostic only" },
      ] } : {}),
    excludes: ["desktop approval UI", "OS sandbox or privilege enforcement", "LLM automatic approval quality",
      "background Repo Memory permissions", "late approval after cancellation", "interrupted trace reconciliation",
      ...(client === "workbuddy" ? ["desktop startup environment", "standalone CodeBuddy CLI"] : [])], cases: [] };
}

// WorkBuddy's bundled runtime projects SDK denial into this fixed tool result;
// its native result event separately retains the denied tool's exact identity.
const workbuddyDenialResult = "The user doesn't want to proceed with this tool use. The tool use was rejected (eg. if it was a file edit, the new_string was NOT written to the file). STOP what you are doing and wait for the user to tell you how to proceed.";

export function summarizePermissionDenial(text, reason) {
  return { textBytes: typeof text === "string" ? Buffer.byteLength(text) : null,
    suppliedReasonObserved: typeof text === "string" && identifier(reason) && text.includes(reason),
    nativeGenericDenialExact: typeof text === "string" && text.trim() === workbuddyDenialResult,
    nativeGenericDenialIncluded: typeof text === "string" && text.includes(workbuddyDenialResult) };
}

export function assertPermissionDenialResult(text, { client = "codebuddy", reason }) {
  check(client === "codebuddy" || client === "workbuddy", "NATIVE_CLIENT_INVALID");
  check(identifier(reason), "PERMISSION_DENIAL_REASON_INVALID");
  const diagnostic = summarizePermissionDenial(text, reason);
  if (diagnostic.suppliedReasonObserved) return "supplied_denial_reason";
  if (client === "workbuddy" && diagnostic.nativeGenericDenialExact) return "native_generic_denial";
  check(false, "PERMISSION_NATIVE_DENIAL_RESULT_MISSING");
}

export function assertPermissionDenialTerminal(event, sessionId, tool) {
  check(identifier(sessionId) && identifier(tool?.name) && identifier(tool?.id)
    && tool.input && typeof tool.input === "object" && !Array.isArray(tool.input)
    && event?.type === "result" && event.session_id === sessionId && event.is_error === false
    && event.subtype === "success" && event.terminal_reason === undefined
    && isDeepStrictEqual(event.permission_denials, [{ tool_name: tool.name, tool_use_id: tool.id, tool_input: tool.input }]),
  "PERMISSION_NATIVE_DENIAL_IDENTITY_MISMATCH");
}

export function assertInitializedModel(initialized) {
  check(matchesNativeModel(initialized?.currentModelId, fixtureModel) && Array.isArray(initialized?.models)
    && initialized.models.some((model) => matchesNativeModel(model?.id, fixtureModel)), "PERMISSION_INITIALIZED_MODEL_MISMATCH");
}

export function assertPermissionInitializations(events, sessionId) {
  const initializations = Array.isArray(events)
    ? events.filter((event) => event?.type === "system" && event.subtype === "init") : [];
  check(typeof sessionId === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(sessionId) && initializations.length > 0
    && initializations.every((event) => event.session_id === sessionId && matchesNativeModel(event.model, fixtureModel)
      && event.permissionMode === "default"), "PERMISSION_NATIVE_INIT_MISMATCH");
}

export function permissionArguments({ sessionId, allowedTool } = {}) {
  check(typeof sessionId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionId),
    "PERMISSION_SESSION_ID_INVALID");
  return ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--session-id", sessionId,
    "--model", fixtureModel, "--permission-mode", "default", "--setting-sources", "user",
    "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} }),
    ...(allowedTool ? ["--allowedTools", allowedTool] : [])];
}

// CodeBuddy and WorkBuddy use allowed/reason on the CLI wire, not the SDK's
// public behavior/message object. Stream JSON selects this channel directly.
export class CodeBuddyControlSession {
  constructor(child, { outputLimit = 16 * 1024 * 1024, requestTimeout = 30_000, exitTimeout = 15_000 } = {}) {
    this.child = child;
    this.events = [];
    this.pending = new Map();
    this.permissions = new Map();
    this.nextId = 0;
    this.requestTimeout = requestTimeout;
    this.exitTimeout = exitTimeout;
    this.ended = false;
    this.inputEnded = false;
    let buffer = "";
    const bytes = { stdout: 0, stderr: 0 };
    for (const name of ["stdout", "stderr"]) {
      child[name].setEncoding("utf8");
      child[name].on("data", (text) => {
        bytes[name] += Buffer.byteLength(text);
        if (bytes[name] > outputLimit) return this.fail("CODEBUDDY_CONTROL_OUTPUT_LIMIT");
        if (name === "stderr" || this.failure) return;
        buffer += text;
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, end).trim();
          buffer = buffer.slice(end + 1);
          if (line) this.accept(line);
        }
      });
    }
    child.stdout.on("end", () => { if (buffer.trim()) this.fail("CODEBUDDY_CONTROL_TRUNCATED_JSON"); });
    child.stdin.on("error", () => this.fail("CODEBUDDY_CONTROL_INPUT_FAILED"));
    child.once("error", () => this.fail("CODEBUDDY_CONTROL_SPAWN_FAILED"));
    child.once("close", (code, signal) => {
      this.ended = true;
      this.exitCode = code;
      this.signal = signal;
      if (this.pending.size) this.fail("CODEBUDDY_CONTROL_EXITED_DURING_REQUEST");
    });
  }
  fail(code) {
    this.failure ??= code;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(Object.assign(new Error(this.failure), { nativeCode: this.failure }));
    }
    this.pending.clear();
  }
  accept(line) {
    try {
      const event = JSON.parse(line);
      check(event && typeof event === "object" && !Array.isArray(event) && typeof event.type === "string",
        "CODEBUDDY_CONTROL_INVALID_EVENT");
      check(this.events.length < 20_000, "CODEBUDDY_CONTROL_EVENT_LIMIT");
      this.events.push(event);
      if (event.type === "control_response") {
        const response = event.response, pending = this.pending.get(response?.request_id);
        check(pending, "CODEBUDDY_CONTROL_RESPONSE_ID_MISMATCH");
        check(response.subtype === "success" || response.subtype === "error", "CODEBUDDY_CONTROL_RESPONSE_INVALID");
        clearTimeout(pending.timer);
        this.pending.delete(response.request_id);
        if (response.subtype === "error") pending.reject(Object.assign(new Error("CODEBUDDY_CONTROL_REQUEST_REJECTED"),
          { nativeCode: "CODEBUDDY_CONTROL_REQUEST_REJECTED" }));
        else pending.resolve(response.response);
      } else if (event.type === "control_request") {
        check(identifier(event.request_id) && !this.permissions.has(event.request_id), "CODEBUDDY_CONTROL_REQUEST_ID_INVALID");
        check(event.request?.subtype === "can_use_tool" && identifier(event.request.tool_use_id)
          && identifier(event.request.tool_name) && event.request.input && typeof event.request.input === "object"
          && !Array.isArray(event.request.input), "CODEBUDDY_CONTROL_PERMISSION_INVALID");
        this.permissions.set(event.request_id, { event, status: "pending" });
      }
    } catch (error) { this.fail(error.nativeCode ?? "CODEBUDDY_CONTROL_INVALID_JSON"); }
  }
  send(value) {
    check(!this.failure, this.failure);
    check(!this.ended && !this.inputEnded, "CODEBUDDY_CONTROL_IS_CLOSED");
    this.child.stdin.write(`${JSON.stringify(value)}\n`);
  }
  request(request) {
    check(!this.failure, this.failure);
    check(!this.ended && !this.inputEnded, "CODEBUDDY_CONTROL_IS_CLOSED");
    const requestId = `native-control-${++this.nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail("CODEBUDDY_CONTROL_REQUEST_TIMEOUT"), this.requestTimeout);
      this.pending.set(requestId, { resolve, reject, timer });
      this.send({ type: "control_request", request_id: requestId, request });
    });
  }
  respond(event, response) {
    const permission = this.permissions.get(event.request_id);
    check(permission?.event === event && permission.status === "pending", "CODEBUDDY_CONTROL_PERMISSION_NOT_PENDING");
    check(typeof response?.allowed === "boolean" && response.behavior === undefined,
      "CODEBUDDY_CONTROL_PERMISSION_RESPONSE_INVALID");
    this.send({ type: "control_response", response: { subtype: "success", request_id: event.request_id, response } });
    permission.status = "responded";
  }
  prompt(content, sessionId = "") {
    this.send({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: sessionId });
  }
  wait(predicate, after = 0) {
    return waitFor(() => {
      check(!this.failure, this.failure);
      const event = this.events.slice(after).find(predicate);
      check(event || !this.ended, "CODEBUDDY_CONTROL_EXITED_BEFORE_EVENT");
      return event;
    }, "CODEBUDDY_CONTROL_EVENT_TIMEOUT", 45_000);
  }
  endInput() { if (!this.inputEnded) { this.inputEnded = true; this.child.stdin.end(); } }
  async finish() {
    this.endInput();
    await waitFor(() => {
      check(!this.failure, this.failure);
      return this.ended;
    }, "CODEBUDDY_CONTROL_EXIT_TIMEOUT", this.exitTimeout);
    check(!this.failure, this.failure);
    check(this.exitCode === 0 && !this.signal, "CODEBUDDY_CONTROL_PROCESS_FAILED");
  }
  async finishAfterInterrupt(stopOwnedChild) {
    try { await this.finish(); }
    catch (error) {
      check(!this.failure, this.failure);
      if (error.nativeCode !== "CODEBUDDY_CONTROL_EXIT_TIMEOUT") throw error;
      if (this.ended) await this.finish();
      else {
        // An interrupt can leave CodeBuddy's original delivery pending after
        // recovery. Cleanup is not evidence that native cancellation finished.
        await stopOwnedChild(this.child);
        await waitFor(() => this.ended, "CODEBUDDY_CONTROL_CLEANUP_EXIT_TIMEOUT", this.exitTimeout);
        check(!this.failure, this.failure);
        return { naturalExit: false, forcedCleanup: true, reason: "CODEBUDDY_CONTROL_EXIT_TIMEOUT" };
      }
    }
    return { naturalExit: true, forcedCleanup: false };
  }
}

export function assertToolLineage(lineage, tool, { denied = false, interrupted = false } = {}) {
  const calls = lineage.filter((record) => record.type === "function_call" && record.callId === tool.id);
  const results = lineage.filter((record) => record.type === "function_call_result" && record.callId === tool.id);
  check(calls.length === 1 && calls[0].name === tool.name, "PERMISSION_TRANSCRIPT_TOOL_MISMATCH");
  let input;
  try { input = typeof calls[0].arguments === "string" ? JSON.parse(calls[0].arguments) : calls[0].arguments; }
  catch { check(false, "PERMISSION_TRANSCRIPT_TOOL_ARGUMENTS_INVALID"); }
  check(isDeepStrictEqual(input, tool.input), "PERMISSION_TRANSCRIPT_TOOL_MISMATCH");
  check(results.length <= 1 && (interrupted || results.length === 1), "PERMISSION_TRANSCRIPT_RESULT_COUNT_MISMATCH");
  if (results.length) check(results[0].status === (denied || interrupted ? "incomplete" : "completed")
    && lineage.indexOf(results[0]) > lineage.indexOf(calls[0]), "PERMISSION_TRANSCRIPT_RESULT_STATUS_MISMATCH");
  if (results.length) {
    const byId = new Map(lineage.map((record) => [record.id, record]));
    const seen = new Set();
    let current = results[0];
    while (current !== calls[0]) {
      check(current && !seen.has(current.id), "PERMISSION_TRANSCRIPT_RESULT_LINEAGE_MISMATCH");
      seen.add(current.id);
      current = byId.get(current.parentId);
    }
  }
  return { toolResultRecorded: results.length === 1 };
}

export function assertNativeInterruption(event, sessionId, { permissionCancellationTool } = {}) {
  if (permissionCancellationTool !== undefined) {
    const tool = permissionCancellationTool;
    check(identifier(sessionId) && identifier(tool?.name) && identifier(tool?.id)
      && tool.input && typeof tool.input === "object" && !Array.isArray(tool.input)
      && event?.type === "result" && event.session_id === sessionId && event.is_error === true
      && event.subtype === "error_during_execution" && event.terminal_reason === undefined && event.result === undefined
      && isDeepStrictEqual(event.errors, [`Permission denied for tool(s): ${tool.name}`])
      && isDeepStrictEqual(event.permission_denials, [{ tool_name: tool.name, tool_use_id: tool.id, tool_input: tool.input }]),
    "PERMISSION_NATIVE_INTERRUPTION_RESULT_MISSING");
    return "permission_denied_interrupt";
  }
  check(event?.type === "result" && event.session_id === sessionId && event.is_error === false
    && event.subtype === "success" && event.terminal_reason === "aborted_tools", "PERMISSION_NATIVE_INTERRUPTION_RESULT_MISSING");
  return "aborted_tools";
}

// Cancellation authority is the correlated native control/result protocol.
// This oracle independently verifies the persisted call belongs to that prompt;
// it does not invent a result or interruption marker missing from the JSONL.
export function selectCanceledToolTurn(records, { sessionId, prompt, tool }) {
  const { user, lineage } = selectToolTurnBranch(records, { sessionId, prompt });
  check(lineage.filter((record) => record.type === "message" && record.role === "assistant")
    .every((record) => record.status === "incomplete"), "PERMISSION_CANCELED_TRANSCRIPT_HAS_COMPLETED_ANSWER");
  const toolEvidence = assertToolLineage(lineage, tool, { interrupted: true });
  return { user, lineage, ...toolEvidence };
}

export function selectInterruptRecovery(records, { client = "codebuddy", sessionId, prompt, tool, recoveryPrompt, recoveryAnswer }) {
  check(client === "codebuddy" || client === "workbuddy", "NATIVE_CLIENT_INVALID");
  const expected = { sessionId, prompt: recoveryPrompt, finalText: recoveryAnswer };
  let selected;
  try { selected = selectNativeTurnContent(records, expected); }
  catch (error) { if (error.nativeCode !== "NATIVE_TRANSCRIPT_FINAL_INCOMPLETE") throw error; }
  if (selected && selected.lineage.length === 2
    && !records.slice(records.findIndex((record) => record.id === selected.user.id) + 1)
      .some((record) => record.type === "function_call_result")) {
    return { ...selected, lateOriginalToolResultCount: 0 };
  }
  const recovery = selectToolTurnBranch(records, { sessionId, prompt: recoveryPrompt });
  const assistants = recovery.lineage.filter((record) => record.type === "message" && record.role === "assistant");
  check(assistants.length === 1 && assistants[0].status === "completed", "NATIVE_TRANSCRIPT_FINAL_INCOMPLETE");
  const assistant = assistants[0], assistantIndex = records.indexOf(assistant), recoveryIndex = records.indexOf(recovery.user);
  const lateOriginal = records.filter((record, index) => index > recoveryIndex
    && record.type === "function_call_result" && record.callId === tool?.id);

  // Both runtimes can append cancellation bookkeeping to the current history
  // head. Projection requires native request or exact original-call authority.
  const original = selectToolTurnBranch(records, { sessionId, prompt });
  const selectedRecords = new Set([...original.lineage, ...recovery.lineage]);
  function checkTail(condition, clause, record, parent) {
    if (condition) return;
    const isContent = (item) => ["message", "function_call", "function_call_result"].includes(item.type);
    const isOriginalResult = (item) => item.type === "function_call_result" && item.callId === tool?.id;
    const diagnostic = {
      clause, recordCount: records.length, originalBranchCount: original.lineage.length,
      recoveryBranchCount: recovery.lineage.length,
      tailCount: recovery.lineage.filter((item) => item !== recovery.user && item !== assistant).length,
      originalResultBeforeAnswerCount: records.slice(0, assistantIndex).filter(isOriginalResult).length,
      originalResultAfterAnswerCount: lateOriginal.filter((item) => records.indexOf(item) > assistantIndex).length,
      unselectedContentCount: records.slice(records.indexOf(original.user)).filter((item) => isContent(item) && !selectedRecords.has(item)).length,
      laterUserCount: records.slice(records.indexOf(recovery.user) + 1).filter((item) => item.type === "message" && item.role === "user").length,
      assistantChildCount: records.filter((item) => item.parentId === assistant.id).length,
      assistantParentIsRecoveryUser: assistant.parentId === recovery.user.id,
    };
    if (parent) diagnostic.parentChildCount = records.filter((item) => item.parentId === parent.id).length;
    if (record) diagnostic.member = {
      typeIsResult: record.type === "function_call_result", roleAbsent: record.role === undefined,
      callIdMatches: record.callId === tool.id, toolNameMatches: record.name === tool.name,
      statusIncomplete: record.status === "incomplete", skipRun: record.providerData?.skipRun === true,
      sessionMatches: record.sessionId === sessionId,
      ownerMatches: record.providerData?.conversationRequestId === original.user.providerData?.conversationRequestId,
      parentMatches: record.parentId === parent?.id, afterParent: records.indexOf(record) > records.indexOf(parent),
      childCount: diagnostic.parentChildCount,
    };
    if (record) {
      const originalTool = original.lineage.find((item) => item.type === "function_call" && item.callId === tool.id);
      const ownerField = (key) => {
        const value = record.providerData?.[key];
        const matches = (item) => identifier(item?.providerData?.conversationRequestId)
          && value === item.providerData.conversationRequestId;
        return { present: Object.hasOwn(record.providerData ?? {}, key),
          type: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
          matchesOriginalPrompt: matches(original.user), matchesOriginalTool: matches(originalTool),
          matchesRecoveryPrompt: matches(recovery.user), matchesRecoveryAnswer: matches(assistant) };
      };
      diagnostic.member.ownerFields = { conversationRequestId: ownerField("conversationRequestId"), requestId: ownerField("requestId") };
    }
    throw Object.assign(new Error("PERMISSION_INTERRUPT_RECOVERY_TAIL_INVALID"), {
      nativeCode: "PERMISSION_INTERRUPT_RECOVERY_TAIL_INVALID", interruptRecoveryDiagnostic: diagnostic,
    });
  }
  checkTail(records.slice(records.indexOf(original.user)).every((record) =>
    !["message", "function_call", "function_call_result"].includes(record.type) || selectedRecords.has(record)),
  "branch_coverage");
  assertToolLineage(original.lineage, tool, { interrupted: true });
  const calls = original.lineage.filter((record) => record.type === "function_call");
  check(calls.length === 1, "PERMISSION_TRANSCRIPT_TOOL_MISMATCH");
  check(records.indexOf(original.user) < records.indexOf(calls[0])
    && records.indexOf(calls[0]) < recoveryIndex && recoveryIndex < assistantIndex,
  "PERMISSION_INTERRUPT_RECOVERY_ORDER_INVALID");
  const tail = recovery.lineage.filter((record) => record !== recovery.user && record !== assistant);
  checkTail(tail.length >= 1 && tail.length <= 2 && tail.length === lateOriginal.length
    && tail.every((record) => lateOriginal.includes(record))
    && !records.slice(recoveryIndex + 1).some((record) => record.type === "message" && record.role === "user"),
  "tail_shape");
  const originalOwner = original.user.providerData?.conversationRequestId;
  const recoveryOwner = recovery.user.providerData?.conversationRequestId;
  const toolOwner = calls[0].providerData?.conversationRequestId;
  const answerOwner = assistant.providerData?.conversationRequestId;
  const ownersValid = identifier(originalOwner) && identifier(recoveryOwner) && originalOwner !== recoveryOwner
    && original.lineage.every((record) => record.sessionId === sessionId && record.providerData?.conversationRequestId === originalOwner)
    && [recovery.user, assistant].every((record) => record.sessionId === sessionId
      && record.providerData?.conversationRequestId === recoveryOwner);
  // WorkBuddy 2.137.1's input processor and cancellation-result constructor omit
  // both owner fields. Only its observed two-turn, sole-call schema qualifies;
  // present-but-invalid ownership must never fall back to call identity.
  const ownersAbsent = (record) => !Object.hasOwn(record.providerData ?? {}, "conversationRequestId")
    && !Object.hasOwn(record.providerData ?? {}, "requestId");
  const workbuddyCallAuthority = client === "workbuddy" && original.lineage.length === 2
    && calls[0].parentId === original.user.id
    && records.filter((record) => record.type === "function_call" && record.callId === tool.id).length === 1
    && records.every((record) => !["message", "function_call", "function_call_result"].includes(record.type)
      || selectedRecords.has(record))
    && [original.user, calls[0], recovery.user, assistant].every((record) => record.sessionId === sessionId)
    && identifier(toolOwner) && identifier(answerOwner) && toolOwner !== answerOwner
    && [calls[0], assistant].every((record) => !Object.hasOwn(record.providerData ?? {}, "requestId"))
    && [original.user, recovery.user, ...lateOriginal].every(ownersAbsent);
  if (!ownersValid && !workbuddyCallAuthority) {
    const matchesOwner = (record, owner) => identifier(owner) && record.providerData?.conversationRequestId === owner;
    const member = (record) => ({ sessionMatches: record.sessionId === sessionId,
      ownerFieldPresent: Object.hasOwn(record.providerData ?? {}, "conversationRequestId"),
      ownerPresent: identifier(record.providerData?.conversationRequestId),
      requestIdAliasFieldPresent: Object.hasOwn(record.providerData ?? {}, "requestId"),
      requestIdAliasPresent: identifier(record.providerData?.requestId),
      matchesOriginalToolOwner: matchesOwner(record, toolOwner), matchesRecoveryAnswerOwner: matchesOwner(record, answerOwner) });
    const originalNonPrompt = original.lineage.filter((record) => record !== original.user);
    const code = "PERMISSION_INTERRUPT_REQUEST_OWNER_MISMATCH";
    throw Object.assign(new Error(code), { nativeCode: code, interruptRecoveryDiagnostic: {
      clause: "request_owner", originalPrompt: member(original.user), originalTool: member(calls[0]),
      recoveryPrompt: member(recovery.user), recoveryAnswer: member(assistant),
      promptOwnersDistinct: identifier(originalOwner) && identifier(recoveryOwner) && originalOwner !== recoveryOwner,
      toolAndAnswerOwnersDistinct: identifier(toolOwner) && identifier(answerOwner) && toolOwner !== answerOwner,
      originalNonPromptCount: originalNonPrompt.length,
      originalNonPromptSessionMatches: originalNonPrompt.filter((record) => record.sessionId === sessionId).length,
      originalNonPromptOwnerMatches: originalNonPrompt.filter((record) => matchesOwner(record, toolOwner)).length,
      lateOriginalResultCount: lateOriginal.length,
      lateOriginalResultSessionMatches: lateOriginal.filter((record) => record.sessionId === sessionId).length,
      lateOriginalResultOwnerMatches: lateOriginal.filter((record) => matchesOwner(record, toolOwner)).length,
      lateOriginalResults: lateOriginal.map((record) => ({ ...member(record),
        functionCallResult: record.type === "function_call_result", roleAbsent: record.role === undefined,
        callIdMatches: record.callId === tool.id, toolNameMatches: record.name === tool.name,
        incomplete: record.status === "incomplete", skipRun: record.providerData?.skipRun === true })),
    } });
  }
  let parent = recovery.user;
  for (const record of recovery.lineage.slice(1)) {
    if (record !== assistant) checkTail(record.type === "function_call_result" && record.role === undefined && record.callId === tool.id
      && record.name === tool.name && record.status === "incomplete" && record.providerData?.skipRun === true
      && record.sessionId === sessionId
      && (workbuddyCallAuthority ? ownersAbsent(record) : record.providerData.conversationRequestId === originalOwner),
    "tail_member", record, parent);
    checkTail(record.parentId === parent.id && records.indexOf(record) > records.indexOf(parent),
    "tail_member", record, parent);
    checkTail(records.filter((child) => child.parentId === parent.id).length === 1, "single_child", record, parent);
    parent = record;
  }
  checkTail(!records.some((record) => record.parentId === parent.id), "terminal_leaf", undefined, parent);
  // Contract only the proven cancellation nodes, preserving native content and IDs.
  const projected = records.filter((record) => !tail.includes(record))
    .map((record) => record === assistant ? { ...record, parentId: recovery.user.id } : record);
  return { ...selectNativeTurnContent(projected, expected),
    lateOriginalToolResultCount: tail.length };
}

// Call after same-session recovery and confirmed client shutdown, including
// reported forced cleanup. A missing assistant alone is not interruption proof.
export function selectInterruptOutcome(records, { client = "codebuddy", sessionId, prompt, answer, tool, recoveryPrompt, recoveryAnswer }) {
  const recovery = selectInterruptRecovery(records, { client, sessionId, prompt, tool, recoveryPrompt, recoveryAnswer });
  const { lateOriginalToolResultCount } = recovery;
  const original = selectToolTurnBranch(records, { sessionId, prompt });
  check(records.findIndex((record) => record.id === recovery.user.id) > records.indexOf(original.user),
    "PERMISSION_INTERRUPT_RECOVERY_ORDER_INVALID");
  if (original.lineage.some((record) => record.type === "message" && record.role === "assistant" && record.status === "completed")) {
    const completed = selectNativeTurnContent(records, { sessionId, prompt, finalText: answer });
    const toolEvidence = assertToolLineage(completed.lineage, tool, { denied: true });
    return { outcome: "completed", ...toolEvidence, lateOriginalToolResultCount };
  }
  const incomplete = selectCanceledToolTurn(records, { sessionId, prompt, tool });
  return { outcome: "incomplete", toolResultRecorded: incomplete.toolResultRecorded || lateOriginalToolResultCount > 0,
    lateOriginalToolResultCount };
}

export function permissionModelTurn(body, { prompt, recoveryPrompt, recoverySent }) {
  const lastUser = Array.isArray(body?.messages) ? body.messages.filter((message) => message?.role === "user").at(-1) : undefined;
  const content = lastUser?.content;
  const text = typeof content === "string" ? content : Array.isArray(content)
    && content.every((part) => part?.type === "text" && typeof part.text === "string") ? content.map((part) => part.text).join("\n") : undefined;
  const actual = typeof text === "string" ? nativePrompt([{ type: "input_text", text }]) : undefined;
  if (actual === recoveryPrompt) {
    check(recoverySent, "PERMISSION_RECOVERY_MODEL_REQUEST_BEFORE_PROMPT");
    return "recovery";
  }
  check(actual === prompt, "PERMISSION_MODEL_PROMPT_MISMATCH");
  return "original";
}

export function assertPermissionWritebacks(requests, { sessionId, turns }) {
  check(requests.length === turns.length && requests.every((request) => request.path === "/v1/memories/add"
    && request.body.session_id === sessionId), "PERMISSION_LATE_OR_MISSING_WRITEBACK");
  for (const turn of turns) check(requests.filter((request) => request.body.messages?.[0]?.content === turn.prompt
    && request.body.messages?.[1]?.content === turn.answer).length === 1, "PERMISSION_TURN_WRITEBACK_COUNT_MISMATCH");
}

function selectToolTurnBranch(records, { sessionId, prompt }) {
  check(identifier(sessionId) && typeof prompt === "string" && prompt.length > 0 && Array.isArray(records),
    "PERMISSION_TRANSCRIPT_IDENTITY_INVALID");
  const byId = new Map(), children = new Map();
  for (const record of records) {
    check(record && typeof record === "object" && !Array.isArray(record)
      && (record.sessionId === undefined || record.sessionId === sessionId), "PERMISSION_TRANSCRIPT_IDENTITY_INVALID");
    if (record.id === undefined) {
      check(record.type !== "message" && record.type !== "function_call" && record.parentId === undefined,
        "PERMISSION_TRANSCRIPT_IDENTITY_INVALID");
      continue;
    }
    check(identifier(record.id) && !byId.has(record.id), "PERMISSION_TRANSCRIPT_IDENTITY_INVALID");
    byId.set(record.id, record);
    if (record.parentId !== undefined && record.parentId !== null) {
      check(identifier(record.parentId), "PERMISSION_TRANSCRIPT_PARENT_INVALID");
      const siblings = children.get(record.parentId) ?? [];
      siblings.push(record);
      children.set(record.parentId, siblings);
    }
  }
  const users = records.filter((record) => record.type === "message" && record.role === "user"
    && nativePrompt(record.content) === prompt);
  check(users.length === 1 && users[0].sessionId === sessionId, "PERMISSION_TRANSCRIPT_PROMPT_MISMATCH");
  const user = users[0], branch = [user], seen = new Set([user.id]);
  for (let index = 0; index < branch.length; index += 1) {
    for (const child of children.get(branch[index].id) ?? []) {
      check(!seen.has(child.id), "PERMISSION_TRANSCRIPT_LINEAGE_INVALID");
      seen.add(child.id);
      if (child.type === "message" && child.role === "user") continue;
      branch.push(child);
    }
  }
  return { user, lineage: branch };
}

export function nativePrompt(content) {
  if (!Array.isArray(content)) return undefined;
  const parts = content.filter((part) => part?.type === "input_text");
  if (!parts.length || parts.some((part) => typeof part.text !== "string")) return undefined;
  const originals = parts.filter((part) => part.providerData && Object.hasOwn(part.providerData, "content"));
  if (originals.length) return originals.every((part) => typeof part.providerData.content === "string")
    ? originals.map((part) => part.providerData.content).join("\n") : undefined;
  const text = parts.map((part) => part.text).join("\n");
  if (!text.includes("<user_query>") && !text.includes("</user_query>")) return text;
  if (text.split("<user_query>").length !== 2 || text.split("</user_query>").length !== 2) return undefined;
  const start = text.indexOf("<user_query>") + "<user_query>".length, end = text.indexOf("</user_query>");
  return start <= end ? text.slice(start, end).trim() : undefined;
}

export function modelToolResult(body, toolId) {
  const results = body.messages?.filter((message) => message.role === "tool" && message.tool_call_id === toolId);
  check(results?.length === 1, "PERMISSION_MATCHING_NATIVE_TOOL_RESULT_MISSING");
  const content = results[0].content;
  check(typeof content === "string" || Array.isArray(content)
    && content.every((part) => part?.type === "text" && typeof part.text === "string"), "PERMISSION_TOOL_RESULT_CONTENT_INVALID");
  return typeof content === "string" ? content : content.map((part) => part.text).join("\n");
}

export const inflightWorkerScript = `const fs=require("node:fs");const [startedPath,markerPath,marker]=process.argv.slice(2);fs.writeFileSync(startedPath+".tmp",JSON.stringify({pid:process.pid,marker}));fs.renameSync(startedPath+".tmp",startedPath);setTimeout(()=>fs.writeFileSync(markerPath,marker),60000);\n`;

export function inflightCommand({ executable, scriptPath, startedPath, markerPath, marker }, platform = process.platform) {
  const args = [executable, scriptPath, startedPath, markerPath];
  if (platform === "win32") for (let index = 0; index < args.length; index += 1) args[index] = args[index].replaceAll("\\", "/");
  args.push(marker);
  return args.map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(" ");
}

export function summarizeToolFailure(text) {
  return { textBytes: Buffer.byteLength(text), signatures: [
    ["syntax_error", /\bSyntaxError:/], ["invalid_unicode_escape", /Invalid Unicode escape sequence/],
    ["enoent", /\bENOENT\b/], ["eacces", /\bEACCES\b/], ["eperm", /\bEPERM\b/],
    ["command_not_found", /: command not found(?:\r?\n|$)/], ["timeout", /\b(?:timed out|ETIMEDOUT)\b/i],
  ].filter(([, pattern]) => pattern.test(text)).map(([name]) => name) };
}

function identifier(value) { return typeof value === "string" && value.trim().length > 0 && value === value.trim(); }
