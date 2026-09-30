#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { check, createNativeHarness, fixtureKey, fixtureModel, fixtureUser, searchResult, waitFor } from "./codebuddy-native-support.mjs";
import { assertCompleteText, assertNoForeignContent, assertSearchResult, assertSkillReferenceContract,
  assertWritebackMessages, expectedSearchAnswer } from "./codex-native-content-check.mjs";
import { assertNativeReadText, assertNativeToolCalls, selectNativeTurnContent, toolResult } from "./codebuddy-native-content-check.mjs";

const report = { status: "FAIL", scope: "native_codebuddy_installed_plugin_mock_memorax", platform: process.platform,
  paidModelRequests: 0, modelQualityEvaluated: false, checks: [], contentChecks: [],
  contentContract: "CLI session and final text correlated with an independent native JSONL branch",
  allowsAdditionalContent: true, workBuddyValidated: false, skillExecutionValidated: false,
  permissionMatrixValidated: false, lifecycleRecoveryValidated: false, repoMemoryBuildValidated: false };
const redactionCanary = "sk_nativeFixtureOnlyAbcdefghijklmnop";
const toolCanary = "CODEBUDDY_TOOL_OUTPUT_MUST_STAY_LOCAL";
const expectedTurns = [];
let harness, stage = "prerequisites", checksCompleted = false;
try {
  check(process.argv.length === 5, "EXPECTED_INSTALLED_PACKAGE_CODEBUDDY_PATH_AND_VERSION");
  harness = await createNativeHarness({ packageRoot: process.argv[2], codebuddyCommand: process.argv[3],
    expectedVersion: process.argv[4] });
  stage = "installed plugin setup";
  const status = await harness.setup();
  const adapter = status.codebuddyAdapter;
  check(adapter?.ok === true && adapter.installed === true && adapter.enabled === true
    && adapter.managed === true && adapter.codebuddyHooks?.configured === true,
  "NATIVE_PLUGIN_INSTALL_STATUS_MISMATCH");
  const skillRoot = await realpath(dirname(adapter.codebuddySkills.path));
  check(within(await realpath(harness.codebuddyHome), skillRoot), "NATIVE_PLUGIN_PATH_OUTSIDE_HOME");
  const pluginRoot = await realpath(join(skillRoot, "../.."));
  const manifest = JSON.parse(await readFile(join(pluginRoot, ".codebuddy-plugin", "plugin.json"), "utf8"));
  const version = JSON.parse(await readFile(join(harness.packageRoot, "package.json"), "utf8")).version;
  check(manifest.name === "memorax-code-codebuddy-adapter" && manifest.version === version,
    "NATIVE_PLUGIN_MANIFEST_MISMATCH");
  const canonicalSkill = join(harness.packageRoot, "lib", "memorax-code-codex-adapter", "skills", "memorax-code");
  for (const file of ["SKILL.md", "references/memorax-search.md", "references/memorax-add.md"]) {
    check(await readFile(join(skillRoot, file), "utf8") === await readFile(join(canonicalSkill, file), "utf8"),
      "NATIVE_INSTALLED_SKILL_CONTENT_MISMATCH");
  }
  check(harness.modelRequests.length === 0 && harness.memoryRequests.length === 0, "SETUP_MADE_MEMORY_OR_MODEL_REQUESTS");
  report.codebuddyVersion = harness.codebuddyVersion;
  report.checks.push("real CodeBuddy, installed plugin, global prompt Hook and isolated Backend configured");

  stage = "cold first turn and complete Unicode text";
  const first = await turn({
    prompt: "\u7b2c\u4e00\u6bb5: Explain parser validation.\n\n\u7b2c\u4e8c\u6bb5: Preserve caf\u00e9 and \u65e5\u672c\u8a9e.\n\n\u7b2c\u4e09\u6bb5: Separate parsing from interpretation.",
    answer: "\u7b2c\u4e00\u6bb5: Validate every parser input.\n\n\u7b2c\u4e8c\u6bb5: Preserve complete Unicode text, including caf\u00e9.\n\n\u7b2c\u4e09\u6bb5: Reject incomplete input before interpretation.",
    kind: "cold-first-unicode",
  });
  check(harness.modelRequests.some(({ body }) => JSON.stringify(body.messages).includes("MemoraX Code reminder:")),
    "NATIVE_PROMPT_HOOK_REMINDER_MISSING");
  report.checks.push("cold first prompt reaches native Hooks, transcript and automatic Add");

  stage = "native same-session resume and real tool";
  const resumedAnswer = "The resumed discussion keeps its original session and workspace.";
  await turn({ sessionId: first, prompt: "Continue the parser discussion after checking the isolated native session.",
    answer: resumedAnswer, kind: "resume-tool", args: ["--allowedTools", "Bash"], steps: [
      (body) => {
        const script = `console.log(${JSON.stringify(toolCanary)});console.log("NATIVE_SESSION="+JSON.stringify({native:process.env.CODEBUDDY_SESSION_ID,client:process.env.MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT,trace:process.env.MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID,memory:process.env.MEMORAX_CODE_MEMORY_CLI_SESSION_ID}));`;
        return { toolCalls: [toolCall(body, "Bash", { command: shellCommand([process.execPath.replaceAll("\\", "/"), "-e", script]),
          description: "Inspect the isolated native session", timeout: 15000 }, "native-session-marker")] };
      },
      (body) => {
        const output = toolResult(body, "native-session-marker");
        check(output.includes(toolCanary), "NATIVE_TOOL_MARKER_MISSING");
        const match = output.match(/NATIVE_SESSION=(\{[^\r\n]+\})/);
        check(match, "NATIVE_SESSION_ENV_MISSING");
        const binding = JSON.parse(match[1]);
        check(binding.native === first && binding.memory === undefined
          && ((binding.client === undefined && binding.trace === undefined)
            || (binding.client === "codebuddy" && binding.trace === first)), "NATIVE_SESSION_ENV_MISMATCH");
        return { text: resumedAnswer };
      },
    ] });
  stage = "native credential redaction";
  await turn({ sessionId: first, prompt: `Preserve the parser lesson. Synthetic credential: ${redactionCanary}`,
    expectedPrompt: "Preserve the parser lesson. Synthetic credential: [REDACTED:API_KEY]",
    answer: "Keep credentials outside source files.", kind: "redaction" });
  stage = "second native session and workspace";
  const secondWorkspace = join(harness.root, "project-beta");
  await mkdir(secondWorkspace);
  const second = await turn({ cwd: secondWorkspace, prompt: "Explain the independent beta workspace boundary.",
    answer: "The beta workspace answer belongs only to this separate session.", kind: "separate-workspace" });
  check(first !== second, "NATIVE_SESSIONS_NOT_DISTINCT");

  stage = "direct installed Search and Add";
  const query = "Parser validation: which boundary was established?";
  const memory = "Validate parser input before interpreting structured data.";
  const reason = "Preserve the parser validation invariant.";
  const env = { MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT: "codebuddy", MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID: first };
  const before = harness.memoryRequests.length;
  const searched = JSON.parse((await harness.runMemory(["search", "--query", query, "--session-id", first, "--json"], { env })).stdout);
  assertSearchResult(searched, { query, memory: searchResult });
  const plain = await harness.runMemory(["search", "--query", query, "--session-id", first], { env });
  check(plain.stdout.trim() === expectedSearchAnswer(searchResult), "DIRECT_SEARCH_TEXT_MISMATCH");
  const added = JSON.parse((await harness.runMemory(["add", "--memory", memory, "--type", "procedural", "--reason", reason,
    "--session-id", first, "--json"], { env })).stdout);
  check(added.ok === true && added.action === "memory.add" && added.receipt?.accepted === true, "DIRECT_ADD_NOT_ACCEPTED");
  for (const result of [searched, added]) assertScopeResult(result);
  check(harness.memoryRequests.length === before + 3, "DIRECT_MEMORY_REQUEST_COUNT_MISMATCH");
  verifyExplicitRequest(harness.memoryRequests[before], { operation: "search", value: query });
  verifyExplicitRequest(harness.memoryRequests[before + 1], { operation: "search", value: query });
  verifyExplicitRequest(harness.memoryRequests[before + 2], { operation: "add", value: memory, reason, sessionId: first });

  const skillText = await readFile(join(skillRoot, "SKILL.md"), "utf8");
  const skillBody = skillText.slice(skillText.indexOf("# MemoraX Code\n"));
  check(skillBody.startsWith("# MemoraX Code\n"), "NATIVE_SKILL_ROUTER_INVALID");
  for (const operation of ["search", "add"]) {
    stage = `native Skill ${operation}`;
    const reference = join(skillRoot, "references", `memorax-${operation}.md`);
    const referenceText = await readFile(reference, "utf8");
    const executable = assertSkillReferenceContract(referenceText, operation, process.platform);
    const query = "Native Skill parser validation: which invariant applies?";
    const memory = "The native Skill preserves parser validation before interpretation.";
    const reason = "Keep the verified parser validation lesson.";
    const args = operation === "search" ? ["search", "--query", query, "--json"]
      : ["add", "--memory", memory, "--type", "procedural", "--reason", reason, "--json"];
    const before = harness.memoryRequests.length;
    const answer = operation === "search" ? `Recalled Coding Memory: ${searchResult}` : "Native Skill Add accepted.";
    await turn({ sessionId: first, prompt: `Use the memorax-code skill to ${operation} the parser validation lesson.`,
      answer, kind: `skill-${operation}`, explicitRequests: 1, args: ["--allowedTools", "Skill", "Read", "Bash"], steps: [
        (body) => ({ toolCalls: [toolCall(body, "Skill", { skill: "memorax-code-codebuddy-adapter:memorax-code" }, `load-${operation}`)] }),
        (body) => {
          assertCompleteText(toolResult(body, `load-${operation}`), skillBody, "NATIVE_SKILL_ROUTER_INCOMPLETE");
          return { toolCalls: [toolCall(body, "Read", { file_path: reference }, `read-${operation}`)] };
        },
        (body) => {
          assertNativeReadText(toolResult(body, `read-${operation}`), referenceText);
          return { toolCalls: [toolCall(body, "Bash", { command: shellCommand([executable, ...args]),
            description: `Run the installed Coding Memory ${operation} command`, timeout: 15000 }, `memory-${operation}`)] };
        },
        (body) => {
          const result = JSON.parse(toolResult(body, `memory-${operation}`).trim());
          if (operation === "search") assertSearchResult(result, { query, memory: searchResult });
          else check(result.ok === true && result.action === "memory.add" && result.receipt?.accepted === true,
            "NATIVE_SKILL_ADD_RESULT_MISMATCH");
          assertScopeResult(result);
          return { text: answer };
        },
      ] });
    const explicit = harness.memoryRequests.slice(before).filter((request) => operation === "search"
      ? request.path === "/v1/memories/search" : request.body.metadata?.source_detail === "memorax_code_memory_cli");
    check(explicit.length === 1, "NATIVE_SKILL_EXPLICIT_REQUEST_COUNT_MISMATCH");
    verifyExplicitRequest(explicit[0], { operation, value: operation === "search" ? query : memory, reason, sessionId: "memorax-cli" });
  }
  report.skillExecutionValidated = true;
  report.checks.push("real tools and Skill load complete installed instructions, execute PATH-discovered Search/Add and return scoped results");

  stage = "native transcript and Hook correlation";
  for (const expected of expectedTurns) await verifyNativeTranscript(expected);
  for (const request of harness.memoryRequests) {
    const payload = JSON.stringify(request.body);
    for (const forbidden of [fixtureKey, redactionCanary, toolCanary, harness.root, harness.root.replaceAll("\\", "/"),
      "MemoraX Code reminder:", "# MemoraX Code", "## Authority Router"]) {
      check(!payload.includes(JSON.stringify(forbidden).slice(1, -1)), "LOCAL_OR_SENSITIVE_CONTENT_ENTERED_MEMORY_PAYLOAD");
    }
    if (Array.isArray(request.body.messages)) assertNoForeignContent(request.body.messages, expectedTurns
      .filter((expected) => basename(expected.cwd) !== request.body.metadata.memorax_code_workspace)
      .flatMap(({ prompt, answer }) => [prompt, answer]));
  }
  const observed = JSON.parse((await harness.runProduct(["status", "--clients", "codebuddy", "--json"])).stdout);
  check(observed.codebuddyAdapter?.codebuddyHooks?.runtimeObserved === true, "NATIVE_HOOK_EXECUTION_NOT_OBSERVED");
  const trace = (await readFile(join(harness.stateHome, "debug", "traces", "codebuddy", "sessions", first, "events.jsonl"), "utf8"))
    .trim().split(/\r?\n/).map(JSON.parse);
  check(trace.filter((event) => event.type === "memory_cli_search").length === 3
    && trace.filter((event) => event.type === "memory_cli_add").length === 2, "NATIVE_MEMORY_CLI_TRACE_BINDING_MISSING");
  check(!trace.some((event) => event.type === "memory_retrieve"), "LEGACY_AUTOMATIC_SEARCH_RETURNED");
  check(harness.modelRequests.length === 13 && harness.memoryRequests.length === 11 && harness.serverErrors.length === 0,
    "NATIVE_REQUEST_COUNT_OR_RECEIVER_MISMATCH");
  report.checks.push("same-session recovery, complete native text, redaction and separate-workspace writeback");
  report.nativeSessions = 2;
  report.nativeTurns = expectedTurns.length;
  report.model = fixtureModel;
  report.executionMode = "scripted local model responses; model instruction following is not evaluated";
  checksCompleted = true;
} catch (error) {
  report.stage = stage;
  report.error = error.nativeCode ?? "NATIVE_CHECK_FAILED_PRIVATE_OUTPUT_SUPPRESSED";
  if (Number.isInteger(error.code)) report.commandExitCode = error.code;
  if (harness) {
    report.observedModelRequests = harness.modelRequests.length;
    report.observedMemoryRequests = harness.memoryRequests.length;
    report.receiverErrors = harness.serverErrors;
  }
} finally {
  try { await harness?.close(); report.cleanup = "PASS"; }
  catch (error) { report.status = "FAIL"; report.cleanup = error.nativeCode ?? "NATIVE_CLEANUP_FAILED"; }
}
if (checksCompleted && report.cleanup === "PASS") {
  if (harness.modelRequests.length === 13 && harness.memoryRequests.length === 11 && harness.serverErrors.length === 0) {
    report.modelRequests = harness.modelRequests.length;
    report.memoryRequests = { automaticAdd: 6, explicitAdd: 2, explicitSearch: 3 };
    report.status = "PASS";
  } else {
    report.stage = "final receiver audit after cleanup";
    report.error = "NATIVE_REQUEST_COUNT_OR_RECEIVER_MISMATCH";
    report.observedModelRequests = harness.modelRequests.length;
    report.observedMemoryRequests = harness.memoryRequests.length;
    report.receiverErrors = harness.serverErrors;
  }
}
console.log(JSON.stringify(report, null, 2));
if (report.status !== "PASS") process.exitCode = 1;

async function turn({ prompt, answer, sessionId, cwd = harness.workspace, expectedPrompt = prompt, kind,
  args = [], explicitRequests = 0, steps = [() => ({ text: answer })] }) {
  const before = harness.memoryRequests.length;
  let requests = 0;
  const tools = [];
  harness.setModelHandler(async (body) => {
    check(body.model === fixtureModel && requests < steps.length, "UNEXPECTED_NATIVE_MODEL_REQUEST");
    check(JSON.stringify(body.messages).includes(JSON.stringify(prompt).slice(1, -1)), "NATIVE_PROMPT_NOT_SENT_TO_MODEL");
    const response = await steps[requests++](body);
    tools.push(...(response.toolCalls ?? []));
    return response;
  });
  const output = await harness.runCodeBuddy(prompt, { sessionId, cwd, args });
  check(typeof output.sessionId === "string" && output.sessionId.length > 0
    && (!sessionId || output.sessionId === sessionId), "NATIVE_RESUME_SESSION_MISMATCH");
  check(output.text === answer && requests === steps.length, "NATIVE_FINAL_OUTPUT_MISMATCH");
  await waitFor(() => harness.memoryRequests.length >= before + 1 + explicitRequests, "NATIVE_STOP_DID_NOT_WRITE_BACK");
  check(harness.memoryRequests.length === before + 1 + explicitRequests, "NATIVE_TURN_MEMORY_REQUEST_COUNT_MISMATCH");
  const automatic = harness.memoryRequests.slice(before).filter((request) => request.body.metadata?.idempotency_key?.startsWith("automatic:codebuddy:"));
  check(automatic.length === 1, "NATIVE_AUTOMATIC_ADD_COUNT_MISMATCH");
  const [request] = automatic, body = request.body;
  check(request.method === "POST" && request.path === "/v1/memories/add"
    && request.authorization === `Token ${fixtureKey}`, "NATIVE_AUTOMATIC_ADD_TRANSPORT_MISMATCH");
  assertWritebackMessages(body.messages);
  assertCompleteText(body.messages[0].content, expectedPrompt, "NATIVE_WRITEBACK_PROMPT_MISMATCH");
  assertCompleteText(body.messages[1].content, answer, "NATIVE_WRITEBACK_ANSWER_MISMATCH");
  check(body.session_id === output.sessionId && body.metadata?.memorax_code_session_id === output.sessionId,
    "NATIVE_WRITEBACK_SESSION_MISMATCH");
  check(body.user_id === `${fixtureUser}@${basename(cwd)}` && body.metadata.memorax_code_workspace === basename(cwd)
    && body.metadata.memorax_code_memory_scope === "workspace-name.v1", "NATIVE_WRITEBACK_SCOPE_MISMATCH");
  check(body.metadata.idempotency_key === `automatic:codebuddy:${shortHash(body.user_id)}:${output.sessionId}:${shortHash(body.messages[0].content)}:${shortHash(body.messages[1].content)}`,
    "NATIVE_WRITEBACK_IDEMPOTENCY_MISMATCH");
  expectedTurns.push({ prompt, answer, expectedPrompt, sessionId: output.sessionId, cwd, body, kind, tools });
  return output.sessionId;
}

async function verifyNativeTranscript(expected) {
  const files = (await readdir(harness.codebuddyHome, { recursive: true }))
    .filter((file) => basename(file) === `${expected.sessionId}.jsonl`);
  check(files.length === 1, "NATIVE_SESSION_TRANSCRIPT_NOT_UNIQUE");
  const transcriptPath = await realpath(join(harness.codebuddyHome, files[0]));
  check(within(await realpath(harness.codebuddyHome), transcriptPath), "NATIVE_TRANSCRIPT_PATH_OUTSIDE_HOME");
  const lines = (await readFile(transcriptPath, "utf8")).split(/\r?\n/).filter(Boolean);
  const selected = selectNativeTurnContent(lines.map(JSON.parse), {
    sessionId: expected.sessionId, prompt: expected.prompt, finalText: expected.answer,
  });
  assertNativeToolCalls(selected.lineage, expected.tools);
  const userCoverage = assertCompleteText(expected.body.messages[0].content,
    selected.user.content.replaceAll(redactionCanary, "[REDACTED:API_KEY]"));
  const assistantCoverage = assertCompleteText(expected.body.messages[1].content, selected.assistant.content);
  for (const [index, source] of [selected.user, selected.assistant].entries()) {
    if (source.timestamp !== undefined) {
      check(expected.body.messages[index].timestamp === source.timestamp
        && expected.body.metadata.memorax_code_timestamp_sources?.[index] === "native", "NATIVE_TIMESTAMP_AUTHORITY_MISMATCH");
    }
  }
  const trace = (await readFile(join(harness.stateHome, "debug", "traces", "codebuddy", "sessions", expected.sessionId, "events.jsonl"), "utf8"))
    .trim().split(/\r?\n/).map(JSON.parse);
  const start = trace.filter((event) => event.type === "turn_start" && event.trace?.client === "codebuddy"
    && event.trace.session_id === expected.sessionId && event.trace.turn_id?.endsWith(`:${hash(expected.prompt.trim())}`));
  check(start.length === 1 && start[0].trace.turn_id.startsWith(`${expected.sessionId}:`), "NATIVE_HOOK_PROMPT_CORRELATION_MISSING");
  check(trace.some((event) => event.type === "turn_end" && event.trace?.client === "codebuddy"
    && event.trace.session_id === expected.sessionId && event.trace.turn_id === start[0].trace.turn_id
    && event.outcome === "completed"),
  "NATIVE_HOOK_COMPLETION_CORRELATION_MISSING");
  if (expected.kind.startsWith("skill-")) {
    const type = `memory_cli_${expected.kind.slice("skill-".length)}`;
    const events = trace.filter((event) => event.type === type && event.trace?.client === "codebuddy"
      && event.trace.session_id === expected.sessionId && event.trace.turn_id === start[0].trace.turn_id);
    check(events.length === 1 && events[0].ok === true, "NATIVE_SKILL_TRACE_BINDING_MISMATCH");
  }
  report.contentChecks.push({ scenario: expected.kind, nativePromptMatched: true, nativeCompletedBranchMatched: true,
    completeUserTextIncluded: true, completeAssistantTextIncluded: true, completedNativeTools: expected.tools.length,
    additionalContentObserved: userCoverage.additionalContentObserved || assistantCoverage.additionalContentObserved,
    nativeUserTimestampPresent: selected.user.timestamp !== undefined,
    nativeAssistantTimestampPresent: selected.assistant.timestamp !== undefined });
}
function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function shortHash(value) { return hash(value).slice(0, 16); }
function toolCall(body, name, input, id) {
  check(body.tools?.some((tool) => tool.type === "function" && tool.function?.name === name), "NATIVE_REQUIRED_TOOL_MISSING");
  return { id, name, input };
}
function shellCommand(args) { return args.map((value) => `'${String(value).replaceAll("'", "'\\''")}'`).join(" "); }
function assertScopeResult(result) {
  check(result.baseUserId === fixtureUser && result.effectiveUserId === `${fixtureUser}@${basename(harness.workspace)}`
    && result.workspace === basename(harness.workspace) && result.scopeKind === "local-directory"
    && result.workspaceScope === "bound", "EXPLICIT_MEMORY_SCOPE_RESULT_MISMATCH");
}
function verifyExplicitRequest(request, { operation, value, reason, sessionId }) {
  check(request?.method === "POST" && request.path === `/v1/memories/${operation}`
    && request.authorization === `Token ${fixtureKey}`, "EXPLICIT_MEMORY_TRANSPORT_MISMATCH");
  const body = request.body;
  check(body.user_id === `${fixtureUser}@${basename(harness.workspace)}`, "EXPLICIT_MEMORY_SCOPE_MISMATCH");
  if (operation === "search") {
    check(body.query === value && !Object.hasOwn(body, "session_id") && !Object.hasOwn(body, "metadata"), "EXPLICIT_SEARCH_PAYLOAD_MISMATCH");
    return;
  }
  check(body.session_id === sessionId && body.metadata?.memorax_code_session_id === sessionId, "EXPLICIT_ADD_SESSION_MISMATCH");
  check(body.metadata.memorax_code_base_user_id === fixtureUser
    && body.metadata.memorax_code_workspace === basename(harness.workspace)
    && body.metadata.memorax_code_memory_scope === "workspace-name.v1", "EXPLICIT_ADD_SCOPE_METADATA_MISMATCH");
  check(JSON.stringify(body.messages?.map(({ role, content }) => ({ role, content })))
    === JSON.stringify([{ role: "user", content: value }]), "EXPLICIT_ADD_CONTENT_MISMATCH");
  check(body.metadata.idempotency_key === `memory-cli:${sessionId}:${shortHash(`procedural\n${reason}\n${value}`)}`
    && body.metadata.source_detail === "memorax_code_memory_cli" && body.metadata.memory_type === "procedural"
    && body.metadata.memorax_code_memory_reason === reason, "EXPLICIT_ADD_METADATA_MISMATCH");
}
function within(parent, child) {
  const path = relative(parent, child);
  return path !== ".." && !path.startsWith("../") && !path.startsWith("..\\") && !isAbsolute(path);
}
