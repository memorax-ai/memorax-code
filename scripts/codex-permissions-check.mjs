#!/usr/bin/env node
import { createHash } from "node:crypto";
import { access, readFile, readdir, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { createNativeHarness, fixtureKey, fixtureUser, sendResponses, waitFor } from "./codex-native-support.mjs";
import { assertCompleteText, assertNoForeignContent, assertWritebackMessages, selectNativeTurnContent } from "./codex-native-content-check.mjs";

// Native app-server protocol, checked with baseline and latest Codex. The fixtures only
// test approval routing and enforcement; they do not evaluate reviewer judgment.
const cases = [
  { id: "full-access", policy: "never", reviewer: "user", sandbox: "danger-full-access", writes: true },
  { id: "user-allow", policy: "on-request", reviewer: "user", sandbox: "workspace-write", decision: "accept", writes: true },
  { id: "user-reject", policy: "on-request", reviewer: "user", sandbox: "workspace-write", decision: "decline", writes: false },
  { id: "user-cancel", policy: "on-request", reviewer: "user", sandbox: "workspace-write", decision: "cancel", writes: false },
  { id: "user-wait-interrupt", policy: "on-request", reviewer: "user", sandbox: "workspace-write", interrupt: true, writes: false },
  { id: "auto-review-allow", policy: "on-request", reviewer: "auto_review", sandbox: "workspace-write", verdict: "allow", writes: true },
  { id: "auto-review-deny", policy: "on-request", reviewer: "auto_review", sandbox: "workspace-write", verdict: "deny", writes: false },
];
const report = {
  status: "FAIL", suite: "native_codex_permissions", platform: process.platform,
  model: "controlled Responses fixture", paidModelRequests: 0,
  contentCheck: "Complete required source paragraphs; additional context allowed",
  scope: "Native approval mechanism and observed file effects with installed MemoraX plugin",
  executionProbe: "Native shell tool with explicit sandbox escalation in restricted modes",
  excludes: ["LLM reviewer semantic quality", "desktop approval UI", "OS ordinary-user and UAC coverage", "background Repo Memory permissions"],
  cases: [],
};
let harness;
let rpc;
let current;
let stage = "prerequisites";
async function main() {
try {
  check(process.argv.length === 4, "EXPECTED_INSTALLED_PACKAGE_ROOT_AND_CODEX_CLI_PATH");
  harness = await createNativeHarness({ packageRoot: resolve(process.argv[2]), codexCommand: resolve(process.argv[3]), label: "permissions" });
  stage = "installed plugin setup";
  await harness.setup();
  report.codexVersion = harness.codexVersion;
  harness.setModelHandler((body, response) => {
    check(current, "UNEXPECTED_MODEL_REQUEST_OUTSIDE_CASE");
    check(++current.modelRequests <= 8, "MODEL_REQUEST_LIMIT_EXCEEDED");
    if (body.generate === false) return sendResponses(response, { output: [] });
    const guardian = body.client_metadata?.["x-openai-subagent"] === "guardian";
    if (guardian) {
      check(current.test.reviewer === "auto_review", "UNEXPECTED_NATIVE_REVIEWER");
      current.guardianRequests++;
      current.guardianModels.add(body.model);
      check(current.guardianRequests === 1, "UNEXPECTED_REVIEWER_RETRY");
      return sendResponses(response, { output: [message(JSON.stringify({
        risk_level: current.test.verdict === "allow" ? "low" : "high",
        user_authorization: current.test.verdict === "allow" ? "high" : "low",
        outcome: current.test.verdict,
        rationale: "Controlled test verdict; this fixture does not assess real-world risk.",
      }), `review-${current.test.id}`)] });
    }
    current.parentRequests++;
    if (current.parentRequests === 1) {
      const tools = flattenTools(body.tools ?? []);
      const tool = tools.find((entry) => entry.name === "exec_command")
        ?? tools.find((entry) => entry.name === "shell_command");
      check(tool, "NATIVE_SHELL_TOOL_NOT_ADVERTISED");
      current.toolName = tool.name;
      const args = tool.name === "exec_command"
        ? { cmd: current.command, yield_time_ms: 1000, max_output_tokens: 1000, login: false }
        : { command: current.command, timeout_ms: 10000, login: false };
      if (current.test.sandbox !== "danger-full-access") Object.assign(args, {
        sandbox_permissions: "require_escalated",
        justification: "Create one synthetic marker in this test's isolated directory.",
      });
      return sendResponses(response, { output: [{
        type: "function_call", id: `fc-${current.test.id}`, call_id: current.callId,
        name: tool.name, arguments: JSON.stringify(args), status: "completed",
      }] });
    }
    check(current.parentRequests === 2, "UNEXPECTED_PARENT_MODEL_RETRY");
    const outputs = (body.input ?? []).filter((item) => item.type === "function_call_output" && item.call_id === current.callId);
    check(outputs.length === 1, "MATCHING_NATIVE_TOOL_RESULT_MISSING");
    current.toolResultObserved = true;
    return sendResponses(response, { output: [message(current.finalText, `final-${current.test.id}`)] });
  });
  stage = "native app-server initialization";
  // Codex 0.147.0 coerces workspace-write to read-only on native Windows
  // until a Windows sandbox implementation is explicitly selected. Exercise
  // the supported restricted-token implementation without elevated OS setup.
  const windowsSandboxArgs = process.platform === "win32" ? ["-c", 'windows.sandbox="unelevated"'] : [];
  rpc = new AppServer(harness.spawnCodex(["app-server", "--stdio", "--strict-config",
    "-c", "features.shell_tool=true", "-c", "features.unified_exec=true",
    "-c", "features.shell_snapshot=false", ...windowsSandboxArgs]));
  await rpc.request("initialize", { clientInfo: { name: "memorax_permissions_ci", version: "1.0.0" }, capabilities: { experimentalApi: true } });
  rpc.notify("initialized", {});
  if (process.platform === "win32") {
    const configuration = await rpc.request("config/read", { includeLayers: false });
    report.windowsSandbox = { requested: "unelevated", configured: configuration.config?.windows?.sandbox ?? "missing",
      elevatedSetupExercised: false };
    check(report.windowsSandbox.configured === "unelevated", "WINDOWS_NATIVE_SANDBOX_NOT_CONFIGURED");
  }
  for (const test of cases) {
    stage = test.id;
    current = {
      test, modelRequests: 0, parentRequests: 0, guardianRequests: 0, guardianModels: new Set(),
      markerPath: join(harness.root, `${test.id}.txt`), marker: `MEMORAX_PERMISSION_${test.id}`,
      finalText: `Permission case ${test.id} finished.`, callId: `permission-${test.id}`,
      toolResultObserved: false,
      prompt: `Run the isolated permission fixture ${test.id}, then report its result.`,
    };
    current.command = markerCommand(current.markerPath, current.marker);
    check(!await exists(current.markerPath), "MARKER_EXISTS_BEFORE_TOOL_EXECUTION");
    const result = { id: test.id, status: "FAIL" };
    report.cases.push(result);
    const startIndex = rpc.events.length;
    const started = await rpc.request("thread/start", {
      cwd: harness.workspace, approvalPolicy: test.policy, approvalsReviewer: test.reviewer,
      sandbox: test.sandbox, ephemeral: false,
    });
    Object.assign(result, { requestedApprovalPolicy: test.policy, requestedReviewer: test.reviewer, requestedSandbox: test.sandbox,
      effectiveApprovalPolicy: started.approvalPolicy ?? "missing", effectiveReviewer: started.approvalsReviewer ?? "missing",
      effectiveSandbox: started.sandbox?.type ?? "missing" });
    check(started.approvalPolicy === test.policy && started.approvalsReviewer === test.reviewer, "EFFECTIVE_APPROVAL_CONFIGURATION_MISMATCH");
    const expectedSandbox = test.sandbox === "danger-full-access" ? "dangerFullAccess" : "workspaceWrite";
    check(started.sandbox?.type === expectedSandbox, "EFFECTIVE_SANDBOX_MISMATCH");
    const threadId = started.thread.id;
    const turn = await rpc.request("turn/start", {
      threadId, input: [{ type: "text", text: current.prompt, text_elements: [] }],
    });
    const turnId = turn.turn.id;
    let approval;
    const caseEvents = () => rpc.events.slice(startIndex).filter((event) => event.params?.threadId === threadId
      && (event.params?.turnId ?? event.params?.turn?.id) === turnId);
    if (test.decision || test.interrupt) {
      approval = await rpc.wait((event) => event.method === "item/commandExecution/requestApproval"
        && event.params?.threadId === threadId && event.params?.turnId === turnId, startIndex);
      check(approval.id !== undefined && approval.params.itemId === current.callId, "APPROVAL_IDENTITY_MISMATCH");
      check(!await exists(current.markerPath), "TARGET_CHANGED_BEFORE_APPROVAL");
      // Observe a pending native request; no approval response is sent during this interval.
      await delay(300);
      check(!await exists(current.markerPath), "TARGET_CHANGED_WHILE_APPROVAL_PENDING");
      check(!caseEvents().some((event) => event.method === "turn/completed"), "PENDING_APPROVAL_WAS_REPORTED_COMPLETE");
      if (test.interrupt) await rpc.request("turn/interrupt", { threadId, turnId });
      else rpc.respond(approval.id, { decision: test.decision });
    }
    const completed = await rpc.wait((event) => event.method === "turn/completed"
      && event.params?.threadId === threadId && event.params?.turn?.id === turnId, startIndex);
    if (test.interrupt) {
      check(completed.params.turn.status === "interrupted", "INTERRUPTED_TURN_NOT_MARKED_INTERRUPTED");
      // A late response to the old request must not execute the canceled command.
      rpc.respond(approval.id, { decision: "accept" });
      await delay(300);
    } else if (test.decision === "cancel") {
      check(completed.params.turn.status === "interrupted", "CANCELED_TURN_NOT_MARKED_INTERRUPTED");
    } else {
      check(completed.params.turn.status === "completed", "NATIVE_TURN_DID_NOT_COMPLETE");
      check(current.toolResultObserved, "NATIVE_TOOL_RESULT_NOT_OBSERVED");
    }
    const events = caseEvents();
    const commandItems = events.filter((event) => event.method === "item/completed" && event.params.item?.type === "commandExecution");
    const terminalCommand = commandItems.find((event) => event.params.item.id === current.callId)?.params.item;
    const wrote = await exists(current.markerPath);
    check(wrote === test.writes, "UNEXPECTED_TARGET_FILE_EFFECT");
    if (wrote) {
      check(await readFile(current.markerPath, "utf8") === current.marker, "TARGET_CONTENT_MISMATCH");
      check(terminalCommand?.status === "completed" && terminalCommand.exitCode === 0, "NATIVE_COMMAND_DID_NOT_COMPLETE_SUCCESSFULLY");
    }
    if (test.decision === "decline" || test.verdict === "deny") {
      check(terminalCommand?.status === "declined", "DENIED_COMMAND_NOT_RECORDED_AS_DECLINED");
    }
    const prompts = events.filter((event) => event.method === "item/commandExecution/requestApproval");
    const reviews = events.filter((event) => event.method === "item/autoApprovalReview/completed");
    if (test.reviewer === "auto_review") {
      check(prompts.length === 0, "AUTO_REVIEW_UNEXPECTEDLY_REQUESTED_USER_APPROVAL");
      check(current.guardianRequests === 1 && reviews.length === 1, "NATIVE_GUARDIAN_NOT_OBSERVED");
      const review = reviews[0].params;
      check(review.targetItemId === current.callId && review.decisionSource === "agent"
        && review.review.status === (test.verdict === "allow" ? "approved" : "denied"), "NATIVE_REVIEW_OUTCOME_MISMATCH");
      check(events.some((event) => event.method === "item/autoApprovalReview/started"
        && event.params.reviewId === review.reviewId && event.params.targetItemId === current.callId), "REVIEW_START_IDENTITY_MISMATCH");
      result.nativeReview = { reviewId: review.reviewId, targetItemId: review.targetItemId,
        decisionSource: review.decisionSource, status: review.review.status, models: [...current.guardianModels],
        harnessApprovalResponses: 0, judgmentSource: "deterministic fixture" };
    } else {
      check(reviews.length === 0 && current.guardianRequests === 0, "UNEXPECTED_AUTOMATIC_REVIEW");
      check(prompts.length === (approval ? 1 : 0), "UNEXPECTED_USER_APPROVAL_COUNT");
    }
    if (approval) result.approval = { requestId: approval.id, itemId: approval.params.itemId,
      decision: test.interrupt ? "wait_then_interrupt_and_late_response" : test.decision,
      observedPendingWithoutSideEffect: true };
    Object.assign(result, { threadId, turnId,
      effectiveApprovalPolicy: started.approvalPolicy, effectiveReviewer: started.approvalsReviewer,
      effectiveSandbox: started.sandbox.type, model: started.model, modelProvider: started.modelProvider,
      turnStatus: completed.params.turn.status, targetWritten: wrote,
      commandStatus: terminalCommand?.status ?? "no_completed_command_item", modelRequests: current.modelRequests,
    });
    if (test.interrupt || test.decision === "cancel") check(current.parentRequests === 1, "CANCELED_TURN_CONTINUED_MODEL_EXECUTION");
    if (approval) check(rpc.events.slice(startIndex).some((event) => event.method === "serverRequest/resolved"
      && event.params?.threadId === threadId && event.params?.requestId === approval.id), "APPROVAL_REQUEST_NOT_RESOLVED");
    result.writeback = await verifyWriteback({ threadId, turnId, completed: completed.params.turn.status === "completed" });
    result.status = "PASS";
  }
  for (const test of cases) check(await exists(join(harness.root, `${test.id}.txt`)) === test.writes,
    "LATE_OR_CROSS_CASE_FILE_EFFECT");
  check(harness.serverErrors.length === 0, "LOCAL_RECEIVER_REPORTED_ERRORS");
  check(harness.memoryRequests.length === cases.filter((test) => !test.interrupt && test.decision !== "cancel").length,
    "EXTRA_LATE_OR_REVIEWER_WRITEBACK");
  report.observedModelHttpRequests = harness.modelRequests.length;
  report.observedMemoryHttpRequests = harness.memoryRequests.length;
  report.status = "PASS";
} catch (error) {
  report.stage = stage;
  report.error = error.testCode ?? error.nativeCode ?? "PERMISSIONS_CHECK_FAILED_PRIVATE_OUTPUT_SUPPRESSED";
  report.receiverErrors = harness?.serverErrors ?? [];
  if (rpc) report.observedEventMethods = [...new Set(rpc.events.map((event) => event.method))];
  if (current) report.activeCaseCounts = { parentRequests: current.parentRequests, guardianRequests: current.guardianRequests };
} finally {
  try {
    if (rpc) await rpc.close();
    if (harness) await harness.close();
    report.cleanup = "PASS";
  } catch (error) { report.status = "FAIL"; report.cleanup = error.nativeCode ?? "FAILED_PRIVATE_OUTPUT_SUPPRESSED"; }
}
console.log(JSON.stringify(report, null, 2));
if (report.status !== "PASS") process.exitCode = 1;
}

function check(condition, code) { if (!condition) throw Object.assign(new Error(code), { testCode: code, nativeCode: code }); }
async function exists(path) { try { await access(path); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
function message(text, id) { return { type: "message", id, role: "assistant", status: "completed", phase: "final_answer", content: [{ type: "output_text", text, annotations: [] }] }; }
function flattenTools(tools) { return tools.flatMap((tool) => tool.type === "namespace" ? flattenTools(tool.tools ?? []) : [tool]); }
function markerCommand(path, marker) {
  const script = `require("node:fs").writeFileSync(process.argv[1],${JSON.stringify(marker)})`;
  const quote = (value) => process.platform === "win32" ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;
  return `${process.platform === "win32" ? "& " : ""}${[process.execPath, "-e", script, path].map(quote).join(" ")}`;
}

async function verifyWriteback({ threadId, turnId, completed }) {
  const received = () => harness.memoryRequests.filter((request) => request.body.session_id === threadId);
  if (completed) await waitFor(() => received().length > 0, "PERMISSION_MODE_DID_NOT_WRITE_BACK");
  else await delay(300);
  const requests = received();
  check(requests.length === (completed ? 1 : 0), "PERMISSION_WRITEBACK_COUNT_MISMATCH");
  const paths = (await readdir(join(harness.codexHome, "sessions"), { recursive: true })).filter((path) => path.endsWith(".jsonl"));
  const matches = [];
  for (const path of paths) {
    const lines = (await readFile(join(harness.codexHome, "sessions", path), "utf8")).trim().split(/\r?\n/);
    const first = JSON.parse(lines[0]);
    if (first.type === "session_meta" && first.payload?.id === threadId) {
      matches.push({ metadata: first.payload, records: lines.map(JSON.parse) });
    }
  }
  check(matches.length === 1, "PERMISSION_NATIVE_ROLLOUT_MISSING_OR_AMBIGUOUS");
  const { metadata, records } = matches[0];
  check(metadata.model_provider === "local_native" && metadata.cli_version === harness.codexVersion, "PERMISSION_ROLLOUT_PROVIDER_MISMATCH");
  const starts = records.filter((record) => record.type === "event_msg" && record.payload.type === "task_started");
  check(starts.length === 1 && starts[0].payload.turn_id === turnId, "PERMISSION_NATIVE_TURN_MISMATCH");
  const contexts = records.filter((record) => record.type === "turn_context");
  check(contexts.length > 0, "PERMISSION_NATIVE_CONTEXT_MISSING");
  const workspace = await realpath(harness.workspace);
  for (const context of contexts) {
    check(context.payload.turn_id === turnId && context.payload.model === "gpt-5.4"
      && await realpath(context.payload.cwd) === workspace, "PERMISSION_NATIVE_CONTEXT_MISMATCH");
  }
  if (!completed) {
    check(!records.some((record) => record.type === "event_msg" && record.payload.type === "agent_message"
      && record.payload.message === current.finalText), "INTERRUPTED_TURN_HAS_FIXTURE_FINAL_RESPONSE");
    return { requestCount: 0, nativeTurnMatched: true, interruptedTurnNotWritten: true };
  }
  const request = requests[0];
  const body = request.body;
  check(request.method === "POST" && request.path === "/v1/memories/add"
    && request.authorization === `Token ${fixtureKey}`, "PERMISSION_ADD_TRANSPORT_MISMATCH");
  check(body.session_id === threadId && body.metadata?.memorax_code_session_id === threadId, "PERMISSION_WRITEBACK_SESSION_MISMATCH");
  check(body.user_id === `${fixtureUser}@${basename(harness.workspace)}`
    && body.metadata.memorax_code_base_user_id === fixtureUser
    && body.metadata.memorax_code_workspace === basename(harness.workspace)
    && body.metadata.memorax_code_memory_scope === "workspace-name.v1", "PERMISSION_WRITEBACK_SCOPE_MISMATCH");
  assertWritebackMessages(body.messages);
  assertNoForeignContent(body.messages, cases.filter((test) => test.id !== current.test.id).flatMap((test) => [
    `Run the isolated permission fixture ${test.id}, then report its result.`,
    `Permission case ${test.id} finished.`,
  ]));
  const hash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);
  check(body.metadata.idempotency_key === `automatic:codex:${hash(body.user_id)}:${threadId}:${hash(body.messages[0].content)}:${hash(body.messages[1].content)}`,
    "PERMISSION_WRITEBACK_IDEMPOTENCY_MISMATCH");
  const native = selectNativeTurnContent(records, { sessionId: threadId, turnId });
  const userCoverage = assertCompleteText(body.messages[0].content, native.user.content, "PERMISSION_NATIVE_USER_CONTENT_INCOMPLETE");
  const assistantCoverage = assertCompleteText(body.messages[1].content, native.assistant.content, "PERMISSION_NATIVE_ASSISTANT_CONTENT_INCOMPLETE");
  check(body.messages[0].timestamp === native.user.timestamp, "PERMISSION_NATIVE_USER_TIMESTAMP_MISMATCH");
  check(native.assistant.timestamps.includes(body.messages[1].timestamp), "PERMISSION_NATIVE_ASSISTANT_TIMESTAMP_MISMATCH");
  const timeSources = body.metadata.memorax_code_timestamp_sources;
  check(Array.isArray(timeSources) && timeSources.length === body.messages.length
    && timeSources[0] === "native" && timeSources[1] === "native"
    && timeSources.every((source) => ["native", "observed", "unspecified"].includes(source)), "PERMISSION_TIME_AUTHORITY_MISMATCH");
  const serialized = JSON.stringify(body);
  check(!serialized.includes(fixtureKey), "PERMISSION_SECRET_ENTERED_PAYLOAD");
  return { requestCount: 1, selectedContentComplete: true, additionalContextAllowed: true, nativeSessionAndTurnMatched: true,
    foreignThreadFixtureContentExcluded: true,
    scopeMatched: true, timestampsMatched: true, nativeContentSources: [native.user.source, native.assistant.source],
    originalUserPromptIncluded: body.messages.some((message) => message.role === "user" && message.content.includes(current.prompt)),
    additionalContentObserved: userCoverage.additionalContentObserved || assistantCoverage.additionalContentObserved || body.messages.length > 2,
    additionalContent: { syntheticSourcePathIncluded: serialized.includes(harness.root),
      toolFixtureIncluded: serialized.includes(current.command), reviewerRationaleIncluded: serialized.includes("Controlled test verdict;") } };
}

class AppServer {
  constructor(child) {
    this.child = child;
    this.events = [];
    this.pending = new Map();
    this.nextId = 1;
    this.failure = null;
    this.closed = false;
    this.stderr = "";
    child.stderr.on("data", (data) => { this.stderr = (this.stderr + data.toString()).slice(-16000); });
    child.stdin.on("error", () => {});
    child.on("error", () => { this.failure = "APP_SERVER_SPAWN_FAILED"; });
    child.on("exit", () => { if (!this.closed) this.failure = "APP_SERVER_EXITED_EARLY"; });
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => {
      try {
        const event = JSON.parse(line);
        if (event.method) this.events.push(event);
        else if (event.id !== undefined && this.pending.has(event.id)) {
          const { resolve: accept, reject, timer } = this.pending.get(event.id);
          clearTimeout(timer);
          this.pending.delete(event.id);
          if (event.error) reject(Object.assign(new Error("RPC_REQUEST_REJECTED"), { testCode: "RPC_REQUEST_REJECTED" }));
          else accept(event.result);
        }
        if (this.events.length > 20000) this.failure = "APP_SERVER_EVENT_LIMIT_EXCEEDED";
      } catch { this.failure = "APP_SERVER_INVALID_JSON"; }
    });
  }
  send(value) { this.child.stdin.write(`${JSON.stringify(value)}\n`); }
  notify(method, params) { this.send({ method, params }); }
  respond(id, result) { this.send({ id, result }); }
  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Object.assign(new Error("RPC_TIMEOUT"), { testCode: "RPC_TIMEOUT" })); }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }
  async wait(predicate, after = 0) {
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline) {
      check(!this.failure, this.failure);
      const event = this.events.slice(after).find(predicate);
      if (event) return event;
      await delay(25);
    }
    throw Object.assign(new Error("NATIVE_EVENT_TIMEOUT"), { testCode: "NATIVE_EVENT_TIMEOUT" });
  }
  async close() {
    this.closed = true;
    for (const pending of this.pending.values()) clearTimeout(pending.timer);
    this.child.stdin.end();
    this.lines.close();
    // The shared harness owns process-tree termination, including native workers.
  }
}

await main();
