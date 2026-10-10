#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import { check, createNativeHarness, fixtureKey, fixtureModel, fixtureUser, searchResult, waitFor } from "./claude-native-support.mjs";
import { assertCompleteText, assertNoForeignContent, assertSearchResult, assertSkillReferenceContract,
  assertWritebackMessages, expectedSearchAnswer } from "../codex/codex-native-content-check.mjs";
import { assertExactText, assertNativeReadText, selectNativeMemoraxPlugin, selectNativeTurnContent } from "./claude-native-content-check.mjs";
import { verifyBackgroundGlobalConfiguration } from "./claude-background-check.mjs";

const report = { status: "FAIL", scope: "native_claude_installed_plugin_mock_memorax", platform: process.platform,
  paidModelRequests: 0, modelQualityEvaluated: false, checks: [], contentChecks: [],
  contentContract: "CLI-observed final UUID and exact native transcript prompt lineage", allowsAdditionalContent: true,
  skillExecutionValidated: false, permissionMatrixValidated: false, repoMemoryBuildValidated: false };
const pluginName = "memorax-code-claude-adapter";
const toolCanary = "CLAUDE_TOOL_OUTPUT_MUST_STAY_LOCAL";
const commentaryCanary = "CLAUDE_INTERMEDIATE_TEXT_MUST_STAY_LOCAL";
const redactionCanary = "sk_nativeFixtureOnlyAbcdefghijklmnop";
const expectedTurns = [], workspaceControls = new Map();
let harness, pluginSource, pluginCache, pluginVersion, loadedPluginPath, stage = "prerequisites";
try {
  check(process.argv.length === 5, "EXPECTED_INSTALLED_PACKAGE_CLAUDE_PATH_AND_VERSION");
  harness = await createNativeHarness({ packageRoot: process.argv[2], claudeCommand: process.argv[3],
    expectedVersion: process.argv[4] });
  stage = "installed plugin setup";
  const status = await harness.setup();
  const pluginStatus = status.claudeAdapter.pluginStatus;
  check(pluginStatus?.ok === true && pluginStatus.installed === true && pluginStatus.enabled === true,
    "NATIVE_PLUGIN_INSTALL_STATUS_MISMATCH");
  const marketplaceRoot = await realpath(join(harness.packageRoot, "lib", "memorax-code-claude-marketplace"));
  const marketplaces = JSON.parse((await harness.runClaude(["plugin", "marketplace", "list", "--json"])).stdout);
  const registered = marketplaces.filter((entry) => entry.name === "memorax-code-local");
  check(registered.length === 1 && registered[0].source === "directory"
    && await realpath(registered[0].path) === marketplaceRoot, "NATIVE_MARKETPLACE_REGISTRATION_MISMATCH");
  const marketplace = JSON.parse(await readFile(join(marketplaceRoot, ".claude-plugin", "marketplace.json"), "utf8"));
  const declared = marketplace.plugins.filter((entry) => entry.name === pluginName);
  check(declared.length === 1 && typeof declared[0].source === "string", "NATIVE_MARKETPLACE_PLUGIN_MISSING");
  pluginSource = await realpath(join(marketplaceRoot, declared[0].source));
  pluginCache = await realpath(pluginStatus.installPath);
  check(within(marketplaceRoot, pluginSource) && within(await realpath(harness.claudeHome), pluginCache),
    "NATIVE_INSTALLED_PLUGIN_PATH_MISMATCH");
  pluginVersion = JSON.parse(await readFile(join(harness.packageRoot, "package.json"), "utf8")).version;
  check(harness.modelRequests.length === 0 && harness.memoryRequests.length === 0, "SETUP_MADE_MEMORY_OR_MODEL_REQUESTS");
  report.claudeVersion = harness.claudeVersion;
  report.checks.push("real Claude, installed plugin and isolated Backend ready");

  stage = "native first turn and complete Unicode text";
  const firstPrompt = "\u7b2c\u4e00\u6bb5 \ud83e\uddea: Explain parser validation.\n\n\u7b2c\u4e8c\u6bb5: Preserve this middle requirement, including caf\u00e9 and \u65e5\u672c\u8a9e.\n\n\u7b2c\u4e09\u6bb5: Separate parsing from interpretation.";
  const firstAnswer = "\u7b2c\u4e00\u6bb5: Validate every parser input.\n\n\u7b2c\u4e8c\u6bb5 \ud83e\uddea: Preserve required fields and Unicode such as caf\u00e9 and \u65e5\u672c\u8a9e.\n\n\u7b2c\u4e09\u6bb5: Reject incomplete input before interpretation.";
  const first = await turn({ prompt: firstPrompt, answer: firstAnswer, kind: "first-unicode" });
  check(harness.modelRequests.some(({ body }) => inputText(body).includes("MemoraX Code reminder:")),
    "NATIVE_HOOK_REMINDER_NOT_IN_MODEL_CONTEXT");
  report.checks.push("native plugin discovery and Hook reminder reach the real model context");

  stage = "native resume and real shell tool";
  const continuedAnswer = "The resumed conversation retains its original workspace.";
  await turn({ sessionId: first, prompt: "Continue after checking the isolated local marker.", answer: continuedAnswer,
    kind: "resume-tool", args: ["--allowedTools", "Bash"], steps: [
      (body) => {
        check(body.tools?.some((tool) => tool.name === "Bash"), "NATIVE_BASH_TOOL_MISSING");
        const script = `console.log(${JSON.stringify(toolCanary)}); console.log("NATIVE_SESSION=" + JSON.stringify({client:process.env.MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT,trace:process.env.MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID,memory:process.env.MEMORAX_CODE_MEMORY_CLI_SESSION_ID}));`;
        return { text: commentaryCanary, toolCalls: [{ id: "native-marker", name: "Bash", input: {
          command: shellCommand([process.execPath.replaceAll("\\", "/"), "-e", script]),
          description: "Print the isolated native fixture marker", timeout: 15000,
        } }] };
      },
      (body) => {
        const output = toolResult(body, "native-marker");
        check(output.includes(toolCanary), "NATIVE_TOOL_RESULT_MISSING");
        const match = output.match(/NATIVE_SESSION=(\{[^\r\n]+\})/);
        check(match, "NATIVE_SESSION_ENV_MISSING");
        const binding = JSON.parse(match[1]);
        check(binding.client === "claude" && binding.trace === first && binding.memory === undefined,
          "NATIVE_SESSION_ENV_MISMATCH");
        return { text: continuedAnswer };
      },
    ] });
  report.checks.push("native resume executes a real Bash tool and inherits the SessionStart memory CLI binding");

  stage = "native credential redaction";
  await turn({ sessionId: first, prompt: `Preserve the parser lesson. Synthetic credential: ${redactionCanary}`,
    expectedPrompt: "Preserve the parser lesson. Synthetic credential: [REDACTED:API_KEY]",
    answer: "Keep credentials outside source files.", kind: "redaction" });

  stage = "second session and workspace isolation";
  const secondWorkspace = join(harness.root, "project-beta");
  await mkdir(secondWorkspace);
  const secondPrompt = "Describe the independent beta workspace invariant.";
  const secondAnswer = "The beta answer belongs only to this separate workspace.";
  const second = await turn({ cwd: secondWorkspace, prompt: secondPrompt, answer: secondAnswer, kind: "separate-workspace" });
  check(first !== second, "NATIVE_SESSIONS_NOT_DISTINCT");

  stage = "direct installed memory commands";
  const query = "Parser validation: which boundary was established?";
  const memory = "Validate parser input before interpreting structured data.";
  const reason = "Preserve the parser validation invariant.";
  const env = { MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT: "claude", MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID: first };
  const before = harness.memoryRequests.length;
  const searched = JSON.parse((await harness.runMemory(["search", "--query", query, "--session-id", first, "--json"], { env })).stdout);
  assertSearchResult(searched, { query, memory: searchResult });
  const plain = await harness.runMemory(["search", "--query", query, "--session-id", first], { env });
  assertExactText(plain.stdout.trim(), expectedSearchAnswer(searchResult), "DIRECT_SEARCH_TEXT_MISMATCH");
  const added = JSON.parse((await harness.runMemory(["add", "--memory", memory, "--type", "procedural",
    "--reason", reason, "--session-id", first, "--json"], { env })).stdout);
  check(added.ok === true && added.action === "memory.add" && added.receipt?.accepted === true, "DIRECT_ADD_NOT_ACCEPTED");
  for (const result of [searched, added]) assertScopeResult(result, "DIRECT_MEMORY_SCOPE_RESULT_MISMATCH");
  check(harness.memoryRequests.length === before + 3, "DIRECT_MEMORY_REQUEST_COUNT_MISMATCH");
  verifyExplicitRequest(harness.memoryRequests[before], { operation: "search", value: query });
  verifyExplicitRequest(harness.memoryRequests[before + 1], { operation: "search", value: query });
  verifyExplicitRequest(harness.memoryRequests[before + 2], { operation: "add", value: memory, reason, sessionId: first });
  report.checks.push("installed Search/Add preserve scoped payloads, receipts and default Search output");

  const skillRoot = join(loadedPluginPath, "skills", "memorax-code");
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
        (body) => ({ toolCalls: [toolCall(body, "Skill", { skill: `${pluginName}:memorax-code` }, `load-${operation}`)] }),
        (body) => {
          toolResult(body, `load-${operation}`);
          assertCompleteText(inputText(body), skillBody, "NATIVE_SKILL_ROUTER_INCOMPLETE");
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
    const explicit = harness.memoryRequests.slice(before).filter((entry) => operation === "search"
      ? entry.path === "/v1/memories/search" : entry.body.metadata?.source_detail === "memorax_code_memory_cli");
    check(explicit.length === 1, "NATIVE_SKILL_EXPLICIT_REQUEST_COUNT_MISMATCH");
    // SessionStart supplies trace scope, not a memory CLI session override.
    verifyExplicitRequest(explicit[0], { operation, value: operation === "search" ? query : memory, reason, sessionId: "memorax-cli" });
  }
  report.skillExecutionValidated = true;
  report.checks.push("real Skill and Read tools load complete installed guidance before PATH-discovered Search/Add, with results returned to the model");

  stage = "native transcript authority and outbound isolation";
  for (const expected of expectedTurns) await verifyNativeTranscript(expected);
  for (const request of harness.memoryRequests) {
    check(request.authorization === `Token ${fixtureKey}`, "MEMORY_AUTHORIZATION_MISMATCH");
    const payload = JSON.stringify(request.body);
    for (const forbidden of [fixtureKey, redactionCanary, toolCanary, commentaryCanary, "## Authority Router",
      "# MemoraX Code Coding Memory Search", "# MemoraX Code Coding Memory Add", harness.root, harness.root.replaceAll("\\", "/")]) {
      check(!payload.includes(JSON.stringify(forbidden).slice(1, -1)), "LOCAL_OR_SENSITIVE_CONTENT_ENTERED_MEMORY_PAYLOAD");
    }
    if (Array.isArray(request.body.messages)) {
      const workspace = request.body.metadata?.memorax_code_workspace;
      check(workspaceControls.has(workspace), "NATIVE_OUTBOUND_WORKSPACE_UNKNOWN");
      assertNoForeignContent(request.body.messages,
        [...workspaceControls].filter(([name]) => name !== workspace).flatMap(([, content]) => content));
    }
  }
  const trace = (await readFile(join(harness.stateHome, "debug", "traces", "claude", "sessions", first, "events.jsonl"), "utf8"))
    .trim().split(/\r?\n/).map(JSON.parse);
  check(trace.filter((event) => event.type === "memory_cli_search").length === 3
    && trace.filter((event) => event.type === "memory_cli_add").length === 2,
    "NATIVE_SKILL_TRACE_BINDING_MISSING");
  check(!trace.some((event) => event.type === "memory_retrieve"), "LEGACY_AUTOMATIC_SEARCH_RETURNED");
  check(harness.memoryRequests.filter((request) => request.path === "/v1/memories/search").length === 3,
    "UNEXPECTED_AUTOMATIC_SEARCH");
  check(harness.modelRequests.length === 13 && harness.memoryRequests.length === 11 && harness.serverErrors.length === 0,
    "NATIVE_REQUEST_COUNT_OR_RECEIVER_MISMATCH");
  report.checks.push("complete native text, prompt identities, native timestamps, redaction and workspace isolation");
  stage = "native flow cleanup before background worker";
  await harness.close();
  stage = "global settings and real Repo Memory worker";
  report.backgroundGlobalConfiguration = {};
  await verifyBackgroundGlobalConfiguration(harness, report.backgroundGlobalConfiguration);
  report.checks.push("foreground and installed Repo Memory worker use global Claude settings; native noop output fails artifact validation");
  report.status = "PASS";
  report.nativeSessions = 2;
  report.nativeTurns = expectedTurns.length;
  report.modelRequests = harness.modelRequests.length;
  report.memoryRequests = { automaticAdd: 6, explicitAdd: 2, explicitSearch: 3 };
  report.skillExecutionMode = "scripted model tool calls; natural-language instruction following is not evaluated";
  report.model = fixtureModel;
  report.executionMode = "scripted local model responses; model instruction following is not evaluated";
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
console.log(JSON.stringify(report, null, 2));
if (report.status !== "PASS") process.exitCode = 1;

async function turn({ prompt, answer, sessionId, cwd = harness.workspace, expectedPrompt = prompt, kind,
  args = [], explicitRequests = 0, steps = [() => ({ text: answer })] }) {
  let step = 0;
  const before = harness.memoryRequests.length;
  const tools = [];
  harness.setModelHandler(async (body) => {
    check(body.model === fixtureModel, "NATIVE_MODEL_SUBSTITUTION");
    check(step < steps.length, "UNEXPECTED_NATIVE_MODEL_CONTINUATION");
    const response = await steps[step++](body);
    tools.push(...(response.toolCalls ?? []).map(({ id, name }) => ({ id, name })));
    return response;
  });
  const output = await harness.runClaude(prompt, { sessionId, cwd, args });
  check(typeof output.sessionId === "string" && (!sessionId || sessionId === output.sessionId), "NATIVE_RESUME_SESSION_MISMATCH");
  const init = output.events.filter((event) => event.type === "system" && event.subtype === "init");
  const result = output.events.filter((event) => event.type === "result");
  check(init.length === 1 && init[0].session_id === output.sessionId && init[0].model === fixtureModel,
    "NATIVE_INIT_IDENTITY_MISMATCH");
  check(result.length === 1 && result[0].subtype === "success" && result[0].is_error === false
    && result[0].session_id === output.sessionId, "NATIVE_TURN_RESULT_MISMATCH");
  const installedPath = await realpath(selectNativeMemoraxPlugin(init[0].plugins).path);
  check(installedPath === pluginSource || installedPath === pluginCache, "NATIVE_LOADED_PLUGIN_PATH_MISMATCH");
  loadedPluginPath = installedPath;
  const manifest = JSON.parse(await readFile(join(installedPath, ".claude-plugin", "plugin.json"), "utf8"));
  check(manifest.name === pluginName && manifest.version === pluginVersion, "NATIVE_PLUGIN_MANIFEST_MISMATCH");
  check(init[0].skills?.includes(`${pluginName}:memorax-code`), "NATIVE_INSTALLED_SKILL_NOT_DISCOVERED");
  assertExactText(output.text, answer, "NATIVE_FINAL_OUTPUT_MISMATCH");
  check(step === steps.length, "NATIVE_MODEL_STEPS_NOT_EXERCISED");
  const final = output.events.filter((event) => event.type === "assistant" && event.parent_tool_use_id === null
    && Array.isArray(event.message?.content)
    && event.message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n\n") === output.text);
  check(final.length === 1 && typeof final[0].uuid === "string" && final[0].session_id === output.sessionId,
    "NATIVE_FINAL_ASSISTANT_IDENTITY_MISSING");
  await waitFor(() => harness.memoryRequests.length >= before + 1 + explicitRequests, "NATIVE_STOP_DID_NOT_WRITE_BACK");
  check(harness.memoryRequests.length === before + 1 + explicitRequests, "NATIVE_TURN_MEMORY_REQUEST_COUNT_MISMATCH");
  const automatic = harness.memoryRequests.slice(before).filter((request) =>
    request.body.metadata?.idempotency_key?.startsWith("automatic:claude-code:"));
  check(automatic.length === 1, "NATIVE_AUTOMATIC_ADD_COUNT_MISMATCH");
  const [request] = automatic, body = request.body;
  check(request.method === "POST" && request.path === "/v1/memories/add", "NATIVE_AUTOMATIC_ADD_TRANSPORT_MISMATCH");
  assertWritebackMessages(body.messages);
  assertCompleteText(body.messages[0].content, expectedPrompt, "NATIVE_WRITEBACK_PROMPT_MISMATCH");
  assertCompleteText(body.messages[1].content, answer, "NATIVE_WRITEBACK_ANSWER_MISMATCH");
  check(body.session_id === output.sessionId && body.metadata?.memorax_code_session_id === output.sessionId,
    "NATIVE_WRITEBACK_SESSION_MISMATCH");
  check(body.user_id === `${fixtureUser}@${basename(cwd)}` && body.metadata.memorax_code_workspace === basename(cwd)
    && body.metadata.memorax_code_memory_scope === "workspace-name.v1", "NATIVE_WRITEBACK_SCOPE_MISMATCH");
  check(body.metadata.idempotency_key === `automatic:claude-code:${hash(body.user_id)}:${output.sessionId}:${hash(body.messages[0].content)}:${hash(body.messages[1].content)}`,
    "NATIVE_WRITEBACK_IDEMPOTENCY_MISMATCH");
  expectedTurns.push({ prompt, answer, expectedPrompt, sessionId: output.sessionId, assistantUuid: final[0].uuid, cwd, body, kind, tools });
  const workspace = basename(cwd);
  workspaceControls.set(workspace, [...(workspaceControls.get(workspace) ?? []), ...new Set([prompt, expectedPrompt, answer])]);
  return output.sessionId;
}

async function verifyNativeTranscript(expected) {
  const projects = join(harness.claudeHome, "projects");
  const paths = (await readdir(projects, { recursive: true })).filter((path) => basename(path) === `${expected.sessionId}.jsonl`);
  check(paths.length === 1, "NATIVE_SESSION_TRANSCRIPT_NOT_UNIQUE");
  const records = (await readFile(join(projects, paths[0]), "utf8")).trim().split(/\r?\n/).map(JSON.parse);
  const selected = selectNativeTurnContent(records, expected);
  const userCoverage = assertCompleteText(expected.body.messages[0].content,
    selected.user.content.replaceAll(redactionCanary, "[REDACTED:API_KEY]"));
  const assistantCoverage = assertCompleteText(expected.body.messages[1].content, selected.assistant.content);
  check(expected.body.messages[0].timestamp === selected.user.timestamp
    && expected.body.messages[1].timestamp === selected.assistant.timestamp, "NATIVE_TIMESTAMP_AUTHORITY_MISMATCH");
  check(JSON.stringify(expected.body.metadata.memorax_code_timestamp_sources) === JSON.stringify(["native", "native"]),
    "NATIVE_TIMESTAMP_SOURCE_MISMATCH");
  const trace = (await readFile(join(harness.stateHome, "debug", "traces", "claude", "sessions", expected.sessionId, "events.jsonl"), "utf8"))
    .trim().split(/\r?\n/).map(JSON.parse);
  for (const type of ["turn_start", "turn_end"]) {
    check(trace.some((event) => event.type === type && event.trace?.client === "claude"
      && event.trace.session_id === expected.sessionId && event.trace.turn_id === selected.promptId),
    "NATIVE_HOOK_PROMPT_CORRELATION_MISSING");
  }
  if (expected.kind.startsWith("skill-")) {
    const type = `memory_cli_${expected.kind.slice("skill-".length)}`;
    const events = trace.filter((event) => event.type === type && event.trace?.client === "claude"
      && event.trace.session_id === expected.sessionId && event.trace.turn_id === selected.promptId);
    check(events.length === 1 && events[0].ok === true, "NATIVE_SKILL_TRACE_BINDING_MISMATCH");
  }
  for (const tool of expected.tools) {
    const calls = selected.lineage.flatMap((record) => Array.isArray(record.message?.content) ? record.message.content : [])
      .filter((part) => part.type === "tool_use" && part.id === tool.id && part.name === tool.name);
    const results = selected.lineage.flatMap((record) => Array.isArray(record.message?.content) ? record.message.content : [])
      .filter((part) => part.type === "tool_result" && part.tool_use_id === tool.id);
    check(calls.length === 1 && results.length === 1 && results[0].is_error !== true, "NATIVE_TRANSCRIPT_TOOL_NOT_COMPLETED");
  }
  report.contentChecks.push({ case: expected.kind, source: "native Claude transcript", nativePromptCorrelation: true,
    completeSelectedContent: true, nativeTimestamps: true, completedNativeTools: expected.tools.length,
    additionalContentObserved: userCoverage.additionalContentObserved || assistantCoverage.additionalContentObserved
      || expected.body.messages.length > 2 });
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
  check(body.metadata.idempotency_key === `memory-cli:${sessionId}:${hash(`procedural\n${reason}\n${value}`)}`
    && body.metadata.source_detail === "memorax_code_memory_cli" && body.metadata.memory_type === "procedural"
    && body.metadata.memorax_code_memory_reason === reason, "EXPLICIT_ADD_METADATA_MISMATCH");
}
function hash(value) { return createHash("sha256").update(value).digest("hex").slice(0, 16); }
function assertScopeResult(result, code = "NATIVE_SKILL_MEMORY_SCOPE_RESULT_MISMATCH") {
  check(result.baseUserId === fixtureUser && result.effectiveUserId === `${fixtureUser}@${basename(harness.workspace)}`
    && result.workspace === basename(harness.workspace) && result.scopeKind === "local-directory"
    && result.workspaceScope === "bound", code);
}
function toolCall(body, name, input, id) {
  check(body.tools?.some((tool) => tool.name === name), "NATIVE_REQUIRED_TOOL_MISSING");
  return { id, name, input };
}
function within(root, path) { const nested = relative(root, path); return Boolean(nested) && !nested.startsWith("..") && !isAbsolute(nested); }
function inputText(body) {
  const text = [];
  const visit = (value) => {
    if (typeof value === "string") text.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  };
  visit(body.system);
  visit(body.messages);
  return text.join("\n");
}
function toolResult(body, id) {
  const results = body.messages?.flatMap((message) => Array.isArray(message.content) ? message.content : [])
    .filter((part) => part.type === "tool_result" && part.tool_use_id === id);
  check(results?.length === 1 && results[0].is_error !== true, "NATIVE_TOOL_RESULT_MISSING");
  const content = results[0].content;
  return typeof content === "string" ? content : content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}
function shellCommand(args) { return args.map((value) => `'${String(value).replaceAll("'", "'\\''")}'`).join(" "); }
