#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { check, createNativeHarness, fixtureKey, fixtureUser, summarizeCleanupDiagnostic, waitFor } from "./codebuddy-native-support.mjs";
import { assertCompleteText, assertWritebackMessages } from "./codex-native-content-check.mjs";
import { assertNativeToolCalls, nativeHookPrompt, selectNativeBashStdout, selectNativeTurnContent, summarizeWritebackTrace, toolResult } from "./codebuddy-native-content-check.mjs";

const report = { status: "FAIL", scope: "workbuddy_bundled_runtime_minimal_native_smoke", platform: process.platform,
  desktopUIValidated: false, loginFlowValidated: false, lifecycleRecoveryValidated: false,
  skillExecutionValidated: false, permissionMatrixValidated: false, repoMemoryBuildValidated: false,
  paidModelRequests: 0, modelQualityEvaluated: false, checks: [] };
const expectedTurns = [];
const toolMarker = "WORKBUDDY_NATIVE_TOOL_MARKER";
let harness, stage = "prerequisites", checksCompleted = false;
try {
  check(process.argv.length === 5, "EXPECTED_INSTALLED_PACKAGE_WORKBUDDY_PATH_AND_VERSION");
  const packageRoot = await realpath(process.argv[2]);
  const command = await realpath(process.argv[3]);
  const { isWorkBuddyBundledCommand } = await import(pathToFileURL(join(packageRoot,
    "lib/memorax-code-adapter-common/src/clients/codebuddy-command.mjs")));
  check(isWorkBuddyBundledCommand(command), "EXPECTED_WORKBUDDY_BUNDLED_RUNTIME");
  check(/^\d+\.\d+\.\d+$/.test(process.argv[4]), "EXPECTED_EXACT_WORKBUDDY_RUNTIME_VERSION");
  harness = await createNativeHarness({ packageRoot, codebuddyCommand: command, client: "workbuddy",
    label: "minimal-smoke", expectedVersion: process.argv[4] });

  stage = "installed WorkBuddy plugin setup";
  const status = await harness.setup();
  const adapter = status.workbuddyAdapter;
  check(adapter?.ok === true && adapter.installed === true && adapter.enabled === true
    && adapter.managed === true && adapter.runtime === "workbuddy" && adapter.codebuddyHooks?.configured === true,
  "NATIVE_WORKBUDDY_PLUGIN_NOT_READY");
  const nativeHome = await realpath(harness.nativeHome);
  const pluginRoot = await realpath(join(dirname(adapter.codebuddySkills.path), "../.."));
  check(within(nativeHome, pluginRoot), "NATIVE_PLUGIN_PATH_OUTSIDE_HOME");
  const metadata = JSON.parse(await readFile(join(pluginRoot, ".memorax-code-package.json"), "utf8"));
  check(metadata.client === "workbuddy" && await realpath(metadata.codeBuddyHome) === nativeHome
    && await realpath(metadata.codeBuddyCommand) === command, "NATIVE_WORKBUDDY_INSTALLATION_IDENTITY_MISMATCH");
  check(harness.modelRequests.length === 0 && harness.memoryRequests.length === 0, "SETUP_MADE_MEMORY_OR_MODEL_REQUESTS");
  report.bundledRuntimeVersion = harness.codebuddyVersion;
  report.checks.push("isolated WorkBuddy installation selects the actual bundled runtime");

  stage = "cold first turn";
  const first = await turn({
    prompt: "Explain parser validation for caf\u00e9 and \u65e5\u672c\u8a9e.",
    answer: "Validate the complete input first.\nPreserve caf\u00e9 and \u65e5\u672c\u8a9e before interpretation.",
  });
  check(harness.modelRequests.some(({ body }) => JSON.stringify(body.messages).includes("MemoraX Code reminder:")),
    "NATIVE_PROMPT_HOOK_REMINDER_MISSING");
  report.checks.push("cold first turn loads the global Hook and writes back complete native content");

  stage = "same-session resume and real local tool";
  const answer = "The resumed turn keeps the same WorkBuddy session and its own writeback.";
  const markerFile = "workbuddy-native-marker.txt";
  const script = `require("node:fs").writeFileSync(${JSON.stringify(markerFile)},${JSON.stringify(toolMarker)});console.log(${JSON.stringify(toolMarker)});`;
  const shell = [process.execPath.replaceAll("\\", "/"), "-e", script]
    .map((value) => `'${value.replaceAll("'", "'\\''")}'`).join(" ");
  const tool = { id: "workbuddy-native-marker", name: "Bash", input: { command: shell,
    description: "Write an isolated WorkBuddy marker", timeout: 15000 } };
  await turn({ prompt: "Continue after writing the isolated local marker.", answer, sessionId: first,
    args: ["--allowedTools", "Bash"], steps: [
      (body) => {
        check(body.tools?.some((item) => item.type === "function" && item.function?.name === tool.name), "NATIVE_REQUIRED_TOOL_MISSING");
        return { toolCalls: [tool] };
      },
      async (body) => {
        check(selectNativeBashStdout(toolResult(body, tool.id), shell).trim() === toolMarker, "NATIVE_TOOL_OUTPUT_MISMATCH");
        check(await readFile(join(harness.workspace, markerFile), "utf8") === toolMarker, "NATIVE_TOOL_EFFECT_MISSING");
        return { text: answer };
      },
    ] });
  report.checks.push("same-session resume executes a real local tool and writes back only the completed prompt and answer");

  stage = "multiline prompt correlation";
  await turn({ sessionId: first,
    prompt: "Explain parser validation for caf\u00e9 and \u65e5\u672c\u8a9e.\nKeep the original line break.",
    answer: "The multiline prompt remains intact and belongs to its own completed turn.",
  });
  report.checks.push("multiline Hook projection selects unchanged native WorkBuddy content");

  stage = "native transcript and WorkBuddy identity";
  for (const expected of expectedTurns) await verifyNativeTranscript(expected);
  const observed = JSON.parse((await harness.runProduct(["status", "--clients", "workbuddy", "--json"])).stdout);
  check(observed.workbuddyAdapter?.codebuddyHooks?.runtimeObserved === true, "NATIVE_HOOK_EXECUTION_NOT_OBSERVED");
  const standaloneEntries = await readdir(join(harness.home, ".codebuddy"), { recursive: true, withFileTypes: true }).catch((error) => {
    if (error.code === "ENOENT") return []; throw error;
  });
  // The bundled runtime initializes this empty directory even with WorkBuddy state.
  check(standaloneEntries.length === 0 || (standaloneEntries.length === 1
    && standaloneEntries[0].name === "diagnostics" && standaloneEntries[0].isDirectory()),
  "NATIVE_STANDALONE_CODEBUDDY_HOME_CHANGED");
  report.checks.push("native JSONL, correlated prompt and Add identities belong to WorkBuddy, not CodeBuddy CLI");
  checksCompleted = true;
} catch (error) {
  report.stage = stage;
  report.error = /^[A-Z][A-Z0-9_]+$/.test(error.nativeCode ?? "") ? error.nativeCode : "NATIVE_CHECK_FAILED_PRIVATE_OUTPUT_SUPPRESSED";
  if (Number.isInteger(error.code)) report.commandExitCode = error.code;
  if (["ENOEXEC", "ENOENT", "EACCES", "EPERM"].includes(error.code)) report.systemCode = error.code;
} finally {
  try { await harness?.close(); report.cleanup = "PASS"; }
  catch (error) { report.cleanup = "FAIL"; report.cleanupDiagnostic = summarizeCleanupDiagnostic(error); }
}
if (harness) {
  report.modelRequests = harness.modelRequests.length;
  report.memoryRequests = harness.memoryRequests.length;
  report.receiverErrors = harness.serverErrors;
  if (checksCompleted && report.cleanup === "PASS") {
    if (report.modelRequests === 4 && report.memoryRequests === 3 && report.receiverErrors.length === 0) report.status = "PASS";
    else { report.stage = "final receiver audit after cleanup"; report.error = "NATIVE_REQUEST_COUNT_OR_RECEIVER_MISMATCH"; }
  }
}
console.log(JSON.stringify(report, null, 2));
if (report.status !== "PASS") process.exitCode = 1;

async function turn({ prompt, answer, sessionId, args = [], steps = [() => ({ text: answer })] }) {
  const before = harness.memoryRequests.length;
  let requests = 0;
  const tools = [];
  harness.setModelHandler(async (body) => {
    check(requests < steps.length && JSON.stringify(body.messages).includes(JSON.stringify(prompt).slice(1, -1)),
      "UNEXPECTED_NATIVE_MODEL_REQUEST");
    const response = await steps[requests++](body);
    tools.push(...(response.toolCalls ?? []));
    return response;
  });
  const output = await harness.runCodeBuddy(prompt, { sessionId, args });
  check(/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(output.sessionId)
    && (!sessionId || output.sessionId === sessionId), "NATIVE_RESUME_SESSION_MISMATCH");
  check(output.text === answer && requests === steps.length, "NATIVE_FINAL_OUTPUT_MISMATCH");
  try {
    await waitFor(() => harness.memoryRequests.length > before, "NATIVE_STOP_DID_NOT_WRITE_BACK");
  } catch (error) {
    report.writebackDiagnostic = await writebackDiagnostic(output, prompt, answer);
    throw error;
  }
  check(harness.memoryRequests.length === before + 1, "NATIVE_TURN_MEMORY_REQUEST_COUNT_MISMATCH");
  const request = harness.memoryRequests[before], body = request.body;
  check(request.method === "POST" && request.path === "/v1/memories/add"
    && request.authorization === `Token ${fixtureKey}`, "NATIVE_AUTOMATIC_ADD_TRANSPORT_MISMATCH");
  assertWritebackMessages(body.messages);
  check(body.messages.length === 2 && body.messages[0].content === prompt && body.messages[1].content === answer,
    "NATIVE_WRITEBACK_CONTENT_MISMATCH");
  check(body.session_id === output.sessionId && body.metadata?.memorax_code_session_id === output.sessionId,
    "NATIVE_WRITEBACK_SESSION_MISMATCH");
  check(body.user_id === `${fixtureUser}@${basename(harness.workspace)}`
    && body.metadata.memorax_code_workspace === basename(harness.workspace)
    && body.metadata.memorax_code_memory_scope === "workspace-name.v1", "NATIVE_WRITEBACK_SCOPE_MISMATCH");
  check(body.metadata.idempotency_key === `automatic:workbuddy:${hash(body.user_id).slice(0, 16)}:${output.sessionId}:${hash(body.messages[0].content).slice(0, 16)}:${hash(body.messages[1].content).slice(0, 16)}`,
    "NATIVE_WRITEBACK_IDEMPOTENCY_MISMATCH");
  const payload = JSON.stringify(body);
  for (const forbidden of [fixtureKey, harness.root, harness.root.replaceAll("\\", "/"), toolMarker, "MemoraX Code reminder:"]) {
    check(!payload.includes(JSON.stringify(forbidden).slice(1, -1)), "LOCAL_OR_SENSITIVE_CONTENT_ENTERED_MEMORY_PAYLOAD");
  }
  const expected = { prompt, answer, sessionId: output.sessionId, body, tools };
  await verifyNativeTranscript(expected);
  expectedTurns.push(expected);
  return output.sessionId;
}
async function verifyNativeTranscript(expected) {
  const nativeHome = await realpath(harness.nativeHome);
  const files = (await readdir(nativeHome, { recursive: true })).filter((file) => basename(file) === `${expected.sessionId}.jsonl`);
  check(files.length === 1, "NATIVE_SESSION_TRANSCRIPT_NOT_UNIQUE");
  const transcript = await realpath(join(nativeHome, files[0]));
  check(within(nativeHome, transcript), "NATIVE_TRANSCRIPT_PATH_OUTSIDE_HOME");
  const selected = selectNativeTurnContent((await readFile(transcript, "utf8")).split(/\r?\n/).filter(Boolean).map(JSON.parse),
    { sessionId: expected.sessionId, prompt: expected.prompt, finalText: expected.answer });
  assertNativeToolCalls(selected.lineage, expected.tools);
  assertCompleteText(expected.body.messages[0].content, selected.user.content);
  assertCompleteText(expected.body.messages[1].content, selected.assistant.content);
  const trace = (await readFile(join(harness.stateHome, "debug/traces/workbuddy/sessions", expected.sessionId, "events.jsonl"), "utf8"))
    .split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const promptDigests = [hash(expected.prompt.trim()), hash(nativeHookPrompt(expected.prompt))];
  const starts = trace.filter((event) => event.type === "turn_start" && event.trace?.client === "workbuddy"
    && event.trace.session_id === expected.sessionId && promptDigests.some((digest) => event.trace.turn_id?.endsWith(`:${digest}`)));
  check(starts.length === 1 && starts[0].trace.turn_id.startsWith(`${expected.sessionId}:`), "NATIVE_HOOK_PROMPT_CORRELATION_MISSING");
  check(trace.some((event) => event.type === "turn_end" && event.trace?.client === "workbuddy"
    && event.trace.session_id === expected.sessionId && event.trace.turn_id === starts[0].trace.turn_id
    && event.outcome === "completed"), "NATIVE_HOOK_COMPLETION_CORRELATION_MISSING");
}
async function writebackDiagnostic(output, prompt, answer) {
  const summary = { promptReminderObserved: harness.modelRequests.some(({ body }) => JSON.stringify(body.messages).includes("MemoraX Code reminder:")),
    traceAvailable: false, pendingAvailable: false, nativeTranscriptCount: 0,
    stderrSignatures: ["ENOEXEC", "ENOENT", "EACCES", "EPERM"].filter((code) => output.stderr.includes(code)) };
  let events = [], pending;
  try {
    events = (await readFile(join(harness.stateHome, "debug/traces/workbuddy/sessions", output.sessionId, "events.jsonl"), "utf8"))
      .split(/\r?\n/).filter(Boolean).map(JSON.parse);
    summary.traceAvailable = true;
  } catch { /* A diagnostic must not replace the original failure. */ }
  try {
    pending = JSON.parse(await readFile(join(harness.stateHome, "adapters/workbuddy/pending.json"), "utf8"));
    summary.pendingAvailable = true;
  } catch { /* Keep raw native data and paths out of the report. */ }
  try {
    const files = (await readdir(harness.nativeHome, { recursive: true })).filter((file) => basename(file) === `${output.sessionId}.jsonl`);
    summary.nativeTranscriptCount = files.length;
    if (files.length === 1) {
      const records = (await readFile(join(harness.nativeHome, files[0]), "utf8")).split(/\r?\n/).filter(Boolean).map(JSON.parse);
      selectNativeTurnContent(records, { sessionId: output.sessionId, prompt, finalText: answer });
      summary.nativeCompletedContentMatched = true;
    }
  } catch (error) {
    summary.nativeCompletedContentMatched = false;
    summary.nativeContentError = /^[A-Z][A-Z0-9_]+$/.test(error.nativeCode ?? "") ? error.nativeCode : "other";
  }
  // Both digests describe Hook correlation; content is always checked against native JSONL.
  return { ...summary, ...summarizeWritebackTrace(events, pending, { client: "workbuddy", sessionId: output.sessionId,
    promptHash: hash(prompt.trim()), promptWithoutLineBreaksHash: hash(nativeHookPrompt(prompt)) }) };
}
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function within(parent, child) {
  const path = relative(parent, child);
  return path !== ".." && !path.startsWith("../") && !path.startsWith("..\\") && !isAbsolute(path);
}
