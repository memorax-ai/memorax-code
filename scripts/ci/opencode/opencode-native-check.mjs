#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { assertNoSensitivePayload, check, createNativeHarness, describeSafeError, fixtureKey, fixtureModel, fixtureProvider, fixtureUser,
  processAlive, searchResult, waitFor } from "./opencode-native-support.mjs";
import { assertCompleteText, assertNoForeignContent, assertSearchResult, assertSkillReferenceContract,
  assertWritebackMessages, expectedSearchAnswer } from "../codex/codex-native-content-check.mjs";

const report = { status: "FAIL", scope: "native_opencode_installed_plugin_mock_memorax", platform: process.platform,
  paidModelRequests: 0, modelQualityEvaluated: false, checks: [], contentChecks: [],
  contentContract: "matching SDK user and completed final assistant text", rawTrajectoryValidated: false };
const toolCanary = "OPENCODE_TOOL_OUTPUT_MUST_STAY_LOCAL";
const commentaryCanary = "OPENCODE_INTERMEDIATE_TEXT_MUST_STAY_LOCAL";
const redactionCanary = "sk_nativeFixtureOnlyAbcdefghijklmnop";
const expectedTurns = [], workspaceControls = new Map();
let harness, stage = "prerequisites";
try {
  check(process.argv.length === 4, "EXPECTED_INSTALLED_PACKAGE_AND_OPENCODE_PATHS");
  harness = await createNativeHarness({ packageRoot: process.argv[2], openCodeCommand: process.argv[3] });
  stage = "installed plugin setup";
  await harness.setup();
  check(harness.modelRequests.length === 0 && harness.memoryRequests.length === 0, "SETUP_MADE_MEMORY_OR_MODEL_REQUESTS");
  report.openCodeVersion = harness.openCodeVersion;
  report.checks.push("real OpenCode, installed plugin and isolated Backend ready");

  stage = "native first turn and complete Unicode text";
  const firstPrompt = "第一段 🧪：Explain parser validation.\n\n第二段：Preserve this middle requirement, including café and 日本語.\n\n第三段：Separate parsing from interpretation.";
  const firstAnswer = "第一段：Validate every parser input.\n\n第二段 🧪：Preserve required fields and Unicode such as café and 日本語.\n\n第三段：Reject incomplete input before interpretation.";
  workspaceControls.set(basename(harness.workspace), [firstPrompt, firstAnswer]);
  const first = await turn({ prompt: firstPrompt, answer: firstAnswer });
  check(harness.modelRequests.some(({ body }) => inputText(body).includes("MemoraX Code reminder:")),
    "NATIVE_PLUGIN_REMINDER_NOT_IN_MODEL_CONTEXT");
  check(harness.memoryRequests.every((request) => request.path === "/v1/memories/add"), "UNEXPECTED_AUTOMATIC_SEARCH");
  report.checks.push("ordinary native turn preserves complete multi-paragraph Unicode content without automatic Search");

  stage = "native resume and tool filtering";
  await turn({ sessionId: first, prompt: "Continue after checking the local marker.",
    answer: "The resumed conversation retains its original workspace.", steps: [
      (body) => ({ text: commentaryCanary, toolCalls: [toolCall(body, "bash", {
        command: nodeCommand(["-e", `process.stdout.write(${JSON.stringify(toolCanary)})`]),
        description: "Print the isolated native fixture marker", timeout: 15000,
      }, "native-marker")] }),
      (body) => {
        check(toolResult(body, "native-marker").includes(toolCanary), "NATIVE_TOOL_RESULT_MISSING");
        return { text: "The resumed conversation retains its original workspace." };
      },
    ] });
  report.checks.push("native session resume executes a real shell tool and excludes intermediate tool/commentary content from Add");

  stage = "native credential redaction";
  await turn({ sessionId: first, prompt: `Preserve the parser lesson. Synthetic credential: ${redactionCanary}`,
    expectedPrompt: "Preserve the parser lesson. Synthetic credential: [REDACTED:API_KEY]",
    answer: "Keep credentials outside source files." });

  stage = "second session and workspace isolation";
  const secondWorkspace = join(harness.root, "project-beta");
  await mkdir(secondWorkspace);
  const secondPrompt = "Describe the independent beta workspace invariant.";
  const secondAnswer = "The beta answer belongs only to this separate workspace.";
  workspaceControls.set(basename(secondWorkspace), [secondPrompt, secondAnswer]);
  const second = await turn({ cwd: secondWorkspace, prompt: secondPrompt, answer: secondAnswer });
  check(first !== second, "NATIVE_SESSIONS_NOT_DISTINCT");

  stage = "direct installed memory commands";
  const directQuery = "Parser validation: which boundary was established?";
  const directMemory = "Validate parser input before interpreting structured data.";
  const directReason = "Preserve the parser validation invariant.";
  const directEnv = { MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT: "opencode", MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID: first };
  const beforeDirect = harness.memoryRequests.length;
  const searched = JSON.parse((await harness.runMemory(["search", "--query", directQuery, "--session-id", first, "--json"],
    { env: directEnv })).stdout);
  assertSearchResult(searched, { query: directQuery, memory: searchResult });
  const plain = await harness.runMemory(["search", "--query", directQuery, "--session-id", first], { env: directEnv });
  check(plain.stdout.trim() === expectedSearchAnswer(searchResult), "DIRECT_SEARCH_TEXT_MISMATCH");
  const added = JSON.parse((await harness.runMemory(["add", "--memory", directMemory, "--type", "procedural",
    "--reason", directReason, "--session-id", first, "--json"], { env: directEnv })).stdout);
  check(added.ok === true && added.receipt?.accepted === true, "DIRECT_ADD_NOT_ACCEPTED");
  for (const result of [searched, added]) assertScopeResult(result, harness.workspace);
  check(harness.memoryRequests.length === beforeDirect + 3, "DIRECT_MEMORY_REQUEST_COUNT_MISMATCH");
  verifyExplicitRequest(harness.memoryRequests[beforeDirect], { operation: "search", value: directQuery });
  verifyExplicitRequest(harness.memoryRequests[beforeDirect + 1], { operation: "search", value: directQuery });
  verifyExplicitRequest(harness.memoryRequests[beforeDirect + 2],
    { operation: "add", value: directMemory, reason: directReason, sessionId: first });
  report.checks.push("direct installed Search/Add preserve scoped payloads, receipts and default Search output");

  const skillRoot = join(harness.openCodeConfigDir, "skills", "memorax-code");
  const skillText = await readFile(join(skillRoot, "SKILL.md"), "utf8");
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
      answer, kind: `skill-${operation}`, explicitRequests: 1, steps: [
        (body) => ({ toolCalls: [toolCall(body, "skill", { name: "memorax-code" }, `load-${operation}`)] }),
        (body) => {
          const loaded = toolResult(body, `load-${operation}`);
          check(loaded.includes("## Authority Router") && loaded.includes(skillText.trim().split(/\r?\n/).at(-1)),
            "NATIVE_SKILL_NOT_LOADED");
          const script = 'process.stdout.write(require("node:fs").readFileSync(process.argv[1],"utf8")); console.log("\\nNATIVE_SKILL_SESSION="+JSON.stringify({client:process.env.MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT,trace:process.env.MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID,memory:process.env.MEMORAX_CODE_MEMORY_CLI_SESSION_ID}));';
          return { toolCalls: [toolCall(body, "bash", { command: nodeCommand(["-e", script, reference]),
            description: "Read the installed Skill reference and native shell identity", timeout: 15000 }, `read-${operation}`)] };
        },
        (body) => {
          const loaded = toolResult(body, `read-${operation}`);
          assertCompleteText(loaded, referenceText, "NATIVE_SKILL_REFERENCE_INCOMPLETE");
          const match = loaded.match(/NATIVE_SKILL_SESSION=(\{[^\r\n]+\})/);
          check(match, "NATIVE_SKILL_SHELL_ENV_MISSING");
          const binding = JSON.parse(match[1]);
          check(binding.client === "opencode" && binding.trace === first && binding.memory === first,
            "NATIVE_SKILL_SHELL_ENV_MISMATCH");
          return { toolCalls: [toolCall(body, "bash", { command: shellCommand([executable, ...args]),
            description: `Run the installed Coding Memory ${operation} command`, timeout: 15000 }, `memory-${operation}`)] };
        },
        (body) => {
          const result = toolJsonResult(body, `memory-${operation}`);
          if (operation === "search") assertSearchResult(result, { query, memory: searchResult });
          else check(result.ok === true && result.action === "memory.add" && result.receipt?.accepted === true,
            "NATIVE_SKILL_ADD_RESULT_MISMATCH");
          assertScopeResult(result, harness.workspace);
          return { text: answer };
        },
      ] });
    const request = harness.memoryRequests.slice(before).find((entry) =>
      operation === "search" ? entry.path === "/v1/memories/search"
        : entry.body.metadata?.source_detail === "memorax_code_memory_cli");
    verifyExplicitRequest(request, { operation, value: operation === "search" ? query : memory, reason, sessionId: first });
  }
  report.checks.push("real Skill loader, full installed references, native shell.env and PATH-discovered Search/Add commands");

  stage = "native SDK content authority";
  const inspector = await harness.startOpenCodeServer();
  for (const turn of expectedTurns) {
    const messages = await inspector.request(`/session/${turn.sessionId}/message`, { cwd: turn.cwd });
    const assistant = messages.find((message) => message.info.id === turn.assistantMessageId);
    check(assistant?.info.role === "assistant" && assistant.info.sessionID === turn.sessionId
      && Number.isFinite(assistant.info.time?.completed) && !assistant.info.error && assistant.info.finish === "stop",
    "NATIVE_SDK_FINAL_ASSISTANT_MISSING");
    const user = messages.find((message) => message.info.id === assistant.info.parentID);
    check(user?.info.role === "user" && user.info.sessionID === turn.sessionId, "NATIVE_SDK_USER_MISSING");
    assertCompleteText(nativeText(user), turn.prompt, "NATIVE_SDK_SUBMITTED_PROMPT_INCOMPLETE");
    check(assistant.info.modelID === fixtureModel && assistant.info.providerID === fixtureProvider,
      "NATIVE_SDK_PROVIDER_MODEL_MISMATCH");
    assertCompleteText(nativeText(assistant), turn.answer, "NATIVE_SDK_FINAL_TEXT_INCOMPLETE");
    const userCoverage = assertCompleteText(turn.body.messages[0].content,
      nativeText(user).replaceAll(redactionCanary, "[REDACTED:API_KEY]"), "NATIVE_USER_CONTENT_INCOMPLETE");
    const assistantCoverage = assertCompleteText(turn.body.messages[1].content, nativeText(assistant),
      "NATIVE_ASSISTANT_CONTENT_INCOMPLETE");
    check(turn.body.messages[0].timestamp === user.info.time.created
      && turn.body.messages[1].timestamp === assistant.info.time.completed, "NATIVE_TIMESTAMP_AUTHORITY_MISMATCH");
    check(JSON.stringify(turn.body.metadata.memorax_code_timestamp_sources) === JSON.stringify(["native", "native"]),
      "NATIVE_TIMESTAMP_SOURCE_MISMATCH");
    for (const expected of turn.tools) {
      const parts = messages.filter((message) => message.info.role === "assistant" && message.info.parentID === user.info.id)
        .flatMap((message) => message.parts.filter((part) => part.type === "tool" && part.callID === expected.id
          && part.sessionID === turn.sessionId && part.messageID === message.info.id));
      check(parts.length === 1 && parts[0].tool === expected.name && parts[0].state?.status === "completed",
        "NATIVE_TOOL_NOT_COMPLETED");
      if (expected.name === "bash") check(parts[0].state.metadata?.exit === 0 && parts[0].state.metadata?.truncated === false,
        "NATIVE_SHELL_EXIT_OR_TRUNCATION_MISMATCH");
    }
    report.contentChecks.push({ case: turn.kind, userSource: "OpenCode SDK message", assistantSource: "OpenCode SDK message",
      requiredUserFragments: userCoverage.requiredFragments, requiredAssistantFragments: assistantCoverage.requiredFragments,
      completeSelectedContent: true, nativeTimestamps: true, completedNativeTools: turn.tools.length });
  }
  for (const request of harness.memoryRequests) {
    check(request.authorization === `Token ${fixtureKey}`, "MEMORY_AUTHORIZATION_MISMATCH");
    assertNoSensitivePayload(request.body, [fixtureKey, redactionCanary, harness.root, harness.root.replaceAll("\\", "/")]);
    if (Array.isArray(request.body.messages)) {
      const workspace = request.body.metadata?.memorax_code_workspace;
      check(workspaceControls.has(workspace), "OUTBOUND_WORKSPACE_UNKNOWN");
      const foreign = [...workspaceControls].filter(([name]) => name !== workspace).flatMap(([, fragments]) => fragments);
      assertNoForeignContent(request.body.messages, foreign);
    }
  }
  const payloads = JSON.stringify(harness.memoryRequests.map((request) => request.body));
  for (const localOnly of [toolCanary, commentaryCanary]) check(!payloads.includes(localOnly), "NONFINAL_NATIVE_CONTENT_LEAKED");
  const trace = (await readFile(join(harness.stateHome, "debug", "traces", "opencode", "sessions", first, "events.jsonl"), "utf8"))
    .trim().split(/\r?\n/).map(JSON.parse);
  check(trace.some((event) => event.type === "memory_cli_search") && trace.some((event) => event.type === "memory_cli_add"),
    "NATIVE_SKILL_TRACE_BINDING_MISSING");
  check(!trace.some((event) => event.type === "memory_retrieve"), "LEGACY_AUTOMATIC_SEARCH_RETURNED");
  check(harness.memoryRequests.filter((request) => request.path === "/v1/memories/search").length === 3,
    "UNEXPECTED_SEARCH_REQUEST_COUNT");
  check(harness.memoryRequests.length === 11 && harness.serverErrors.length === 0, "NATIVE_REQUEST_COUNT_OR_RECEIVER_MISMATCH");
  report.checks.push("SDK identities, complete selected content, native timestamps, redaction and cross-workspace isolation");

  stage = "default global model and real Repo Memory worker";
  report.backgroundGlobalConfiguration = await verifyBackgroundGlobalConfiguration();
  report.status = "PASS";
  report.nativeSessions = 2;
  report.nativeTurns = expectedTurns.length;
  report.mainChainModelRequests = harness.modelRequests.length;
  report.memoryRequests = { automaticAdd: 6, explicitAdd: 2, explicitSearch: 3 };
  report.skillExecutionMode = "scripted model tool calls; natural-language instruction following is not evaluated";
  report.model = fixtureModel;
  report.provider = fixtureProvider;
} catch (error) {
  report.stage = stage;
  report.error = error.nativeCode ?? harness?.serverErrors[0] ?? "NATIVE_CHECK_FAILED_PRIVATE_OUTPUT_SUPPRESSED";
  report.errorDetails = describeSafeError(error);
  if (harness) {
    report.observedModelRequests = harness.modelRequests.length;
    report.observedMemoryRequests = harness.memoryRequests.length;
    report.receiverErrors = harness.serverErrors;
  }
} finally {
  try { await harness?.close(); report.cleanup = "PASS"; }
  catch (error) {
    report.status = "FAIL";
    report.cleanup = error.nativeCode ?? "NATIVE_CLEANUP_FAILED";
    report.cleanupErrorDetails = describeSafeError(error);
  }
}
console.log(JSON.stringify(report, null, 2));
if (report.status !== "PASS") process.exitCode = 1;

async function turn({ prompt, answer, sessionId, cwd = harness.workspace, expectedPrompt = prompt, kind = "ordinary",
  explicitRequests = 0, steps = [() => ({ text: answer })] }) {
  let step = 0;
  const tools = [];
  const before = harness.memoryRequests.length;
  harness.setModelHandler(async (body) => {
    check(body.model === fixtureModel, "NATIVE_MODEL_SUBSTITUTION");
    if (!body.tools?.length) return { text: "Native fixture title" };
    check(step < steps.length, "UNEXPECTED_NATIVE_CONTINUATION");
    const result = await steps[step](body);
    for (const call of result.toolCalls ?? []) tools.push({ id: call.id, name: call.name });
    step += 1;
    return result;
  });
  const output = await harness.runOpenCode(prompt, { sessionId, cwd });
  check(output.sessionId && (!sessionId || output.sessionId === sessionId), "NATIVE_RESUME_IDENTITY_MISMATCH");
  check(!output.events.some((event) => event.type === "error"), "NATIVE_TURN_REPORTED_ERROR");
  assertCompleteText(output.text, answer, "NATIVE_FINAL_OUTPUT_INCOMPLETE");
  const assistantMessageId = output.events.filter((event) => event.type === "text").at(-1)?.part?.messageID;
  check(typeof assistantMessageId === "string" && assistantMessageId.length > 0, "NATIVE_CLI_FINAL_MESSAGE_ID_MISSING");
  check(step === steps.length, "NATIVE_MODEL_STEPS_NOT_EXERCISED");
  await waitFor(() => harness.memoryRequests.length >= before + 1 + explicitRequests, "NATIVE_TURN_DID_NOT_WRITE_BACK");
  check(harness.memoryRequests.length === before + 1 + explicitRequests, "NATIVE_TURN_REQUEST_COUNT_MISMATCH");
  const automatic = harness.memoryRequests.slice(before).filter((request) => request.body.metadata?.idempotency_key?.startsWith("automatic:opencode:"));
  check(automatic.length === 1, "EXPECTED_ONE_AUTOMATIC_ADD_PER_TURN");
  const body = automatic[0].body;
  assertWritebackMessages(body.messages);
  check(body.messages.length === 2, "NATIVE_WRITEBACK_MESSAGE_COUNT_MISMATCH");
  assertCompleteText(body.messages[0].content, expectedPrompt, "NATIVE_PROMPT_INCOMPLETE");
  assertCompleteText(body.messages[1].content, answer, "NATIVE_REPLY_INCOMPLETE");
  check(body.session_id === output.sessionId && body.metadata.memorax_code_session_id === output.sessionId,
    "NATIVE_WRITEBACK_SESSION_MISMATCH");
  check(body.user_id === `${fixtureUser}@${basename(cwd)}` && body.metadata.memorax_code_workspace === basename(cwd)
    && body.metadata.memorax_code_memory_scope === "workspace-name.v1", "NATIVE_WRITEBACK_SCOPE_MISMATCH");
  check(body.metadata.idempotency_key === `automatic:opencode:${hash(body.user_id)}:${output.sessionId}:${hash(body.messages[0].content)}:${hash(body.messages[1].content)}`,
    "NATIVE_WRITEBACK_IDEMPOTENCY_MISMATCH");
  expectedTurns.push({ prompt, answer, sessionId: output.sessionId, assistantMessageId, cwd, body, kind, tools });
  return output.sessionId;
}

async function verifyBackgroundGlobalConfiguration() {
  const result = { status: "FAIL" };
  report.backgroundGlobalConfiguration = result;
  let background, server, primaryFailed = false;
  let backgroundStage = "harness creation";
  const received = { foreground: 0, background: 0 };
  const observedPids = new Set();
  try {
    background = await createNativeHarness({ packageRoot: harness.packageRoot, openCodeCommand: harness.openCodeCommand,
      label: "background", writeback: false });
    Object.assign(background.env, { MEMORAX_CODE_REPO_MEMORY_JOB_TIMEOUT_MS: "30000", MEMORAX_CODE_REPO_MEMORY_JOB_KILL_GRACE_MS: "1000" });
    backgroundStage = "repository setup";
    const git = (args) => background.runCommand(process.platform === "win32" ? "git.exe" : "git",
      ["-c", "core.multiPackIndex=false", ...args]);
    await git(["init", "--quiet"]);
    await git(["-c", "user.name=Native Fixture", "-c", "user.email=native@example.invalid", "commit", "--allow-empty",
      "--no-gpg-sign", "--quiet", "-m", "test: native model inheritance fixture"]);
    await git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    await git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    const snapshotHead = (await git(["rev-parse", "HEAD"])).stdout.trim();
    backgroundStage = "installed plugin setup";
    await background.setup();
    background.setModelHandler((body) => {
      check(body.model === fixtureModel, "BACKGROUND_MODEL_SUBSTITUTION");
      if (!body.tools?.length) return { text: "Native background fixture" };
      const kind = inputText(body).includes("This invocation is the authorized background repo-memory worker.") ? "background" : "foreground";
      received[kind] += 1;
      check(received[kind] === 1, "UNEXPECTED_BACKGROUND_CONTINUATION");
      return { text: kind === "background" ? "BACKGROUND_MODEL_CONFIGURATION_ONLY" : "FOREGROUND_MODEL_CONFIGURATION_ONLY" };
    });
    backgroundStage = "native server startup";
    server = await background.startOpenCodeServer();
    backgroundStage = "native parent session creation";
    const foreground = await server.request("/session", { method: "POST", body: { title: "Native background fixture" } });
    backgroundStage = "native foreground message";
    const answer = await server.request(`/session/${foreground.id}/message`, { method: "POST",
      body: { parts: [{ type: "text", text: "Check the current repository default model configuration." }] } });
    check(answer.info?.providerID === fixtureProvider && answer.info?.modelID === fixtureModel && !answer.info.error,
      "BACKGROUND_FOREGROUND_CONFIGURATION_MISMATCH");
    backgroundStage = "background job wait";
    const repository = await realpath(background.workspace);
    const jobs = async () => {
      const jobsRoot = join(background.stateHome, "repo-memory-jobs");
      const files = await readdir(jobsRoot, { recursive: true }).catch((error) => {
        if (error.code === "ENOENT") return []; throw error;
      });
      return Promise.all(files.filter((file) => basename(file) === "job.json").map(async (file) => {
        const job = JSON.parse(await readFile(join(jobsRoot, file), "utf8"));
        check(job.repo === repository && job.runner === "opencode", "BACKGROUND_JOB_AUTHORITY_MISMATCH");
        for (const pid of [job.workerPid, job.childPid]) if (Number.isInteger(pid)) observedPids.add(pid);
        return job;
      }));
    };
    const [job] = await waitFor(async () => {
      const result = await jobs();
      return result.length === 1 && ["failed", "succeeded"].includes(result[0].status) ? result : undefined;
    }, "BACKGROUND_JOB_DID_NOT_FINISH", 45_000);
    backgroundStage = "background job assertions";
    check(job.snapshotHead === snapshotHead && job.sharedSnapshot?.head === snapshotHead
      && job.sharedSnapshot.ref === "refs/remotes/origin/main" && job.sharedSnapshot.baseHead === null,
    "BACKGROUND_SHARED_SNAPSHOT_MISMATCH");
    check(job.status === "failed" && job.failureReason === "artifact_validation_failed" && job.exitCode === 0,
      "BACKGROUND_NOOP_JOB_RESULT_MISMATCH");
    check(received.foreground === 1 && received.background === 1, "BACKGROUND_MODEL_REQUEST_MISSING");
    const workerRequests = background.modelRequests.filter(({ body }) => inputText(body).includes(
      "This invocation is the authorized background repo-memory worker."));
    check(workerRequests.length === 1 && typeof job.prompt === "string", "BACKGROUND_JOB_PROMPT_MISSING");
    assertCompleteText(inputText(workerRequests[0].body), job.prompt, "BACKGROUND_FULL_JOB_PROMPT_MISSING");
    check(background.memoryRequests.length === 0 && background.serverErrors.length === 0, "BACKGROUND_UNEXPECTED_MEMORY_ACTIVITY");
    backgroundStage = "background process exit";
    await waitFor(() => [...observedPids].every((pid) => !processAlive(pid)), "BACKGROUND_PROCESS_REMAINS");
    return Object.assign(result, { status: "PASS", model: fixtureModel, provider: fixtureProvider, foregroundRequests: 1, backgroundRequests: 1,
      expectedFailure: "artifact_validation_failed", repoMemoryBuildValidated: false,
      modelOverrideInheritanceValidated: false, permissionInheritanceValidated: false, fixtureArtifactsInjected: false });
  } catch (error) {
    primaryFailed = true;
    result.stage = backgroundStage;
    result.error = error.nativeCode ?? "BACKGROUND_CHECK_FAILED_PRIVATE_OUTPUT_SUPPRESSED";
    result.errorDetails = describeSafeError(error);
    result.nativeServerInitialization = await server?.diagnostics();
    result.foregroundRequests = received.foreground;
    result.backgroundRequests = received.background;
    result.receiverErrors = background?.serverErrors ?? [];
    throw error;
  } finally {
    try { await background?.close(); result.cleanup = "PASS"; }
    catch (error) {
      result.status = "FAIL";
      result.cleanup = error.nativeCode ?? "BACKGROUND_CLEANUP_FAILED";
      result.cleanupErrorDetails = describeSafeError(error);
      if (!primaryFailed) { result.stage = "cleanup"; throw error; }
    }
  }
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
function assertScopeResult(result, cwd) {
  check(result.baseUserId === fixtureUser && result.effectiveUserId === `${fixtureUser}@${basename(cwd)}`
    && result.workspace === basename(cwd) && result.scopeKind === "local-directory" && result.workspaceScope === "bound",
    "EXPLICIT_MEMORY_SCOPE_RESULT_MISMATCH");
}
function nativeText(message) {
  return message.parts.filter((part) => part.type === "text" && part.synthetic !== true && part.ignored !== true
    && part.sessionID === message.info.sessionID && part.messageID === message.info.id)
    .map((part) => part.text.trim()).filter(Boolean).join("\n\n");
}
function hash(text) { return createHash("sha256").update(text).digest("hex").slice(0, 16); }
function inputText(body) {
  const text = [];
  function visit(value) {
    if (typeof value === "string") text.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  }
  visit(body.messages);
  return text.join("\n");
}
function toolCall(body, name, args, id) {
  check(body.tools?.some((tool) => tool.type === "function" && tool.function?.name === name), `NATIVE_${name.toUpperCase()}_TOOL_MISSING`);
  return { id, name, arguments: args };
}
function toolResult(body, id) {
  const results = body.messages?.filter((message) => message.role === "tool" && message.tool_call_id === id);
  check(results?.length === 1, "NATIVE_TOOL_RESULT_MISSING");
  const content = results[0].content;
  return typeof content === "string" ? content : content.filter((part) => part.type === "text").map((part) => part.text).join("\n");
}
function toolJsonResult(body, id) {
  const result = toolResult(body, id);
  const start = result.indexOf("{"), end = result.lastIndexOf("}");
  check(start >= 0 && end > start, "NATIVE_TOOL_JSON_MISSING");
  try { return JSON.parse(result.slice(start, end + 1)); }
  catch { check(false, "NATIVE_TOOL_JSON_INVALID"); }
}
function shellQuote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }
function shellCommand(args) { return args.map(shellQuote).join(" "); }
function nodeCommand(args) { return shellCommand([process.execPath.replaceAll("\\", "/"), ...args]); }
