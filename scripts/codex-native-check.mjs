#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { check, createNativeHarness, fixtureKey, fixtureUser, searchResult, sendResponses, stopNativeProcessTree, waitFor } from "./codex-native-support.mjs";
import { assertCompleteText, assertWritebackMessages, redactExpectedFixtureText, selectNativeTurnContent } from "./codex-native-content-check.mjs";

const report = { status: "FAIL", scope: "native_codex_installed_plugin_mock_memorax", platform: process.platform,
  paidModelRequests: 0, modelQualityEvaluated: false, checks: [],
  contentContract: "current response-item-first text extraction", allowsAdditionalContent: true,
  rawTrajectoryValidated: false, contentChecks: [] };
const reasoningCanary = "REASONING_MUST_STAY_LOCAL";
const commentaryCanary = "COMMENTARY_MUST_STAY_LOCAL";
const toolCanary = "TOOL_OUTPUT_MUST_STAY_LOCAL";
const redactionCanary = "sk_nativeFixtureOnlyAbcdefghijklmnop";
const expectedTurns = [];
let harness, stage = "prerequisites";
try {
  check(process.argv.length === 4, "EXPECTED_INSTALLED_PACKAGE_AND_CODEX_PATHS");
  harness = await createNativeHarness({ packageRoot: process.argv[2], codexCommand: process.argv[3] });
  stage = "installed plugin setup";
  const status = await harness.setup();
  check(harness.modelRequests.length === 0 && harness.memoryRequests.length === 0, "SETUP_MADE_MEMORY_OR_MODEL_REQUESTS");
  report.codexVersion = harness.codexVersion;
  report.checks.push("real Codex, installed plugin, trusted Hooks and Backend ready");

  stage = "native first turn and filtering";
  const firstPrompt = "第一段 🧪：Explain why parser input must be validated before use.\n\n第二段：Keep this middle requirement intact, including café and 日本語.\n\n第三段：Finish with the boundary between parsing and interpretation.";
  const firstAnswer = "第一段：Validate parser input before interpreting it.\n\n第二段 🧪：Preserve every required field and Unicode value such as café and 日本語.\n\n第三段：Reject incomplete input at the parser boundary.";
  const first = await turn({ prompt: firstPrompt, answer: firstAnswer,
    steps: [(_body, response) => sendResponses(response, { output: [
      { type: "reasoning", id: "reasoning-fixture", summary: [{ type: "summary_text", text: reasoningCanary }] },
      message(commentaryCanary, "commentary"), message(firstAnswer),
    ] })] });
  check(inputText(harness.modelRequests[0].body).includes("MemoraX Code reminder:"), "NATIVE_HOOK_REMINDER_NOT_IN_MODEL_CONTEXT");
  report.checks.push("native SessionStart/UserPromptSubmit/Stop chain preserves complete selected multi-paragraph Unicode text");

  stage = "native resume and tool-output filtering";
  await turn({ sessionId: first, prompt: "Continue the parser lesson after checking a local marker.",
    answer: "The resumed parser conversation retains its original scope.", steps: [
      (body, response) => sendResponses(response, { output: [shellCall(body,
        nodeCommand(["-e", `process.stdout.write(${JSON.stringify(toolCanary)})`]), "filter-tool")] }),
      (body, response) => {
        check(inputText(body).includes(toolCanary), "NATIVE_TOOL_RESULT_NOT_RETURNED_TO_MODEL");
        sendResponses(response, { output: [message("The resumed parser conversation retains its original scope.")] });
      },
    ] });
  report.checks.push("exec resume keeps the native session and preserves selected content");

  stage = "native sensitive-content filtering";
  await turn({ sessionId: first, prompt: `Keep the parser lesson. Test credential: ${redactionCanary}`,
    expectedPrompt: "Keep the parser lesson. Test credential: [REDACTED:API_KEY]",
    answer: "Keep credentials outside source files." });
  report.checks.push("synthetic credential is redacted before outgoing automatic Add");

  stage = "second native session and workspace isolation";
  const secondWorkspace = join(harness.root, "project-beta");
  await mkdir(secondWorkspace);
  const second = await turn({ cwd: secondWorkspace, prompt: "Describe the separate workspace invariant.",
    answer: "This answer belongs only to the separate workspace." });
  check(second !== first, "NATIVE_SESSIONS_NOT_DISTINCT");
  report.checks.push("new native session uses a distinct workspace scope");

  stage = "direct installed memory commands";
  const directQuery = "Parser validation: which boundary was established?";
  const directMemory = "Validate parser input before interpreting structured data.";
  const directReason = "Preserve the parser validation invariant.";
  const beforeDirect = harness.memoryRequests.length;
  const searched = JSON.parse((await harness.runMemory(["search", "--query", directQuery, "--session-id", first, "--json"])).stdout);
  check(searched.ok === true && JSON.stringify(searched).includes(searchResult), "DIRECT_SEARCH_RESULT_MISMATCH");
  const added = JSON.parse((await harness.runMemory(["add", "--memory", directMemory, "--type", "procedural",
    "--reason", directReason, "--session-id", first, "--json"])).stdout);
  check(added.ok === true && added.receipt?.accepted === true, "DIRECT_ADD_NOT_ACCEPTED");
  for (const result of [searched, added]) check(result.baseUserId === fixtureUser
    && result.effectiveUserId === `${fixtureUser}@${basename(harness.workspace)}`
    && result.workspace === basename(harness.workspace) && result.scopeKind === "local-directory"
    && result.workspaceScope === "bound", "DIRECT_MEMORY_SCOPE_RESULT_MISMATCH");
  check(harness.memoryRequests.length === beforeDirect + 2, "DIRECT_MEMORY_REQUEST_COUNT_MISMATCH");
  verifyExplicitRequest(harness.memoryRequests[beforeDirect], { operation: "search", value: directQuery });
  verifyExplicitRequest(harness.memoryRequests[beforeDirect + 1], { operation: "add", value: directMemory, reason: directReason, sessionId: first });
  report.checks.push("direct installed Search and Add each issue one scoped request");

  stage = "installed background launcher model inheritance";
  report.backgroundModelInheritance = await verifyBackgroundInheritance();
  report.checks.push("installed Repo Memory launcher makes a distinct native background request using the foreground model and provider");

  const skillRoot = join(status.codexAdapter.codexSkills.rootPath, "memorax-code");
  const installedManifest = JSON.parse(await readFile(join(skillRoot, "..", "..", ".codex-plugin", "plugin.json"), "utf8"));
  check(installedManifest.name === "memorax-code-codex-adapter", "NATIVE_SKILL_PLUGIN_IDENTITY_MISMATCH");
  const skillName = `${installedManifest.name}:memorax-code`;
  report.skillInvocation = `$${skillName}`;
  for (const operation of ["search", "add"]) {
    stage = `native Skill ${operation}`;
    const reference = join(skillRoot, "references", `memorax-${operation}.md`);
    const referenceText = await readFile(reference, "utf8");
    const query = "Native Skill parser validation: which invariant applies?";
    const memory = "The native Skill preserves parser validation before interpretation.";
    const reason = "Keep the verified parser validation lesson.";
    const args = operation === "search" ? ["search", "--query", query, "--json"]
      : ["add", "--memory", memory, "--type", "procedural", "--reason", reason, "--json"];
    const command = nodeCommand([harness.memoryEntrypoint, ...args]);
    const before = harness.memoryRequests.length;
    const prompt = `$${skillName} Use coding memory ${operation} for the parser validation lesson.`;
    const answer = `Native Skill ${operation} completed through the installed memory CLI.`;
    await turn({ sessionId: first, prompt, answer, kind: `skill-${operation}`, extraMemoryRequests: 1, steps: [
      (body, response) => {
        check(inputText(body).includes("# MemoraX Code") && inputText(body).includes("## Authority Router"), "NATIVE_SKILL_NOT_LOADED");
        sendResponses(response, { output: [shellCall(body, nodeCommand(["-e",
          'process.stdout.write(require("node:fs").readFileSync(process.argv[1], "utf8")); console.log("\\nNATIVE_SKILL_SESSION=" + JSON.stringify({ thread: process.env.CODEX_THREAD_ID ?? null, memoryCli: process.env.MEMORAX_CODE_MEMORY_CLI_SESSION_ID ?? null, memorax: process.env.MEMORAX_CODE_MEMORAX_SESSION_ID ?? null }));', reference]), `read-${operation}`)] });
      },
      (body, response) => {
        check(inputText(body).includes(referenceText.split("\n")[0])
          && inputText(body).includes(referenceText.trim().split("\n").at(-1)), "NATIVE_SKILL_REFERENCE_NOT_READ");
        const result = body.input.filter((item) => item.type === "function_call_output" && item.call_id === `read-${operation}`);
        check(result.length === 1 && typeof result[0].output === "string", "NATIVE_SKILL_REFERENCE_TOOL_RESULT_MISSING");
        const sessions = result[0].output.split(/\r?\n/).filter((line) => line.startsWith("NATIVE_SKILL_SESSION="));
        check(sessions.length === 1, "NATIVE_SKILL_SESSION_ENV_MISSING");
        const session = JSON.parse(sessions[0].slice("NATIVE_SKILL_SESSION=".length));
        check(session.thread === first && session.memoryCli === null && session.memorax === null, "NATIVE_SKILL_SESSION_ENV_MISMATCH");
        sendResponses(response, { output: [shellCall(body, command, `memory-${operation}`)] });
      },
      (body, response) => {
        const text = inputText(body);
        check(operation === "search" ? text.includes(searchResult) : text.includes('"accepted": true') || text.includes('"accepted":true'),
          "NATIVE_SKILL_MEMORY_RESULT_MISSING");
        sendResponses(response, { output: [message(answer)] });
      },
    ] });
    const request = harness.memoryRequests[before];
    // CODEX_THREAD_ID binds native scope. Without a CLI session override, Add uses the documented CLI session.
    verifyExplicitRequest(request, { operation, value: operation === "search" ? query : memory, reason, sessionId: "memorax-cli" });
    report.checks.push(`native Skill ${operation}: loaded router, read installed reference, executed native shell tool and consumed CLI result`);
  }

  stage = "native identities, selected content coverage and outbound fixture checks";
  await verifyNativeRollouts();
  check(harness.serverErrors.length === 0, "LOCAL_RECEIVER_REPORTED_FAILURE");
  check(harness.modelRequests.length === 11, "UNEXPECTED_NATIVE_MODEL_REQUEST_COUNT");
  check(harness.memoryRequests.length === 10, "UNEXPECTED_TOTAL_MEMORY_REQUEST_COUNT");
  check(harness.memoryRequests.filter((request) => request.path === "/v1/memories/search").length === 2, "UNEXPECTED_AUTOMATIC_SEARCH");
  for (const request of harness.memoryRequests) {
    check(request.authorization === `Token ${fixtureKey}`, "MEMORY_AUTHORIZATION_MISMATCH");
    const payload = JSON.stringify(request.body);
    for (const excluded of [fixtureKey, redactionCanary]) {
      check(!payload.includes(excluded), "SENSITIVE_FIXTURE_ENTERED_MEMORY_PAYLOAD");
    }
  }
  const outbound = JSON.stringify(harness.memoryRequests.map((request) => request.body));
  report.additionalContent = { syntheticSourcePathIncluded: outbound.includes(harness.root),
    reasoningFixtureIncluded: outbound.includes(reasoningCanary), commentaryFixtureIncluded: outbound.includes(commentaryCanary),
    toolFixtureIncluded: outbound.includes(toolCanary) };
  report.status = "PASS";
  report.nativeSessions = 2;
  report.nativeTurns = expectedTurns.length;
  report.mainChainModelRequests = harness.modelRequests.length;
  report.modelRequests = harness.modelRequests.length + 2;
  report.memoryRequests = { automaticAdd: 6, explicitAdd: 2, explicitSearch: 2 };
  report.explicitMemoryScope = { requestsValidated: 4, scope: "workspace-name.v1", searchSessionField: "absent",
    directAddSessionSource: "--session-id", nativeSkillScopeSource: "CODEX_THREAD_ID", nativeSkillAddSessionSource: "memorax-cli default" };
  report.model = "gpt-5.4";
  report.provider = "local_native";
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

async function turn({ prompt, answer, sessionId, cwd = harness.workspace, expectedPrompt = prompt, kind = "ordinary", extraMemoryRequests = 0,
  steps = [(_body, response) => sendResponses(response, { output: [message(answer)] })] }) {
  let step = 0;
  const beforeMemory = harness.memoryRequests.length;
  harness.setModelHandler(async (body, response) => {
    check(body.model === "gpt-5.4", "NATIVE_MODEL_SUBSTITUTION");
    check(step < steps.length, "UNEXPECTED_NATIVE_MODEL_CONTINUATION");
    await steps[step++](body, response);
  });
  const args = ["exec", ...(sessionId ? ["resume"] : []), "--strict-config", "--ignore-rules",
    "--skip-git-repo-check", "--json", ...(sessionId ? [sessionId] : []), prompt];
  const output = await harness.runCodex(args, { cwd });
  const events = output.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  check(!events.some((event) => ["error", "turn.failed"].includes(event.type)
    || event.item?.type === "error"), "NATIVE_TURN_REPORTED_ERROR");
  const threads = events.filter((event) => event.type === "thread.started");
  const completed = events.filter((event) => event.type === "turn.completed");
  const messages = events.filter((event) => event.type === "item.completed" && event.item?.type === "agent_message");
  check(threads.length === 1 && completed.length === 1, "NATIVE_TURN_RESULT_MISMATCH");
  assertCompleteText(messages.at(-1)?.item.text, answer, "NATIVE_FINAL_CONTENT_INCOMPLETE");
  check(step === steps.length, "NATIVE_MODEL_STEPS_NOT_EXERCISED");
  const nativeSession = threads[0].thread_id;
  check(typeof nativeSession === "string" && (!sessionId || sessionId === nativeSession), "NATIVE_RESUME_SESSION_MISMATCH");
  await waitFor(() => harness.memoryRequests.length >= beforeMemory + 1 + extraMemoryRequests, "NATIVE_STOP_DID_NOT_WRITE_BACK");
  check(harness.memoryRequests.length === beforeMemory + 1 + extraMemoryRequests, "NATIVE_TURN_MEMORY_REQUEST_COUNT_MISMATCH");
  const automatic = harness.memoryRequests.slice(beforeMemory).filter((request) => request.body.metadata?.idempotency_key?.startsWith("automatic:codex:"));
  check(automatic.length === 1, "EXPECTED_ONE_AUTOMATIC_ADD_PER_NATIVE_TURN");
  const body = automatic[0].body;
  assertWritebackMessages(body.messages);
  check(body.session_id === nativeSession && body.metadata.memorax_code_session_id === nativeSession, "NATIVE_WRITEBACK_SESSION_MISMATCH");
  check(body.user_id === `${fixtureUser}@${basename(cwd)}` && body.metadata.memorax_code_workspace === basename(cwd)
    && body.metadata.memorax_code_memory_scope === "workspace-name.v1", "NATIVE_WRITEBACK_SCOPE_MISMATCH");
  const hash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);
  check(body.metadata.idempotency_key === `automatic:codex:${hash(body.user_id)}:${nativeSession}:${hash(body.messages[0].content)}:${hash(body.messages[1].content)}`,
    "NATIVE_WRITEBACK_IDEMPOTENCY_MISMATCH");
  expectedTurns.push({ sessionId: nativeSession, prompt, expectedPrompt, answer, cwd, body, kind });
  return nativeSession;
}

function verifyExplicitRequest(request, { operation, value, reason, sessionId }) {
  check(request.method === "POST" && request.path === `/v1/memories/${operation}`
    && request.authorization === `Token ${fixtureKey}`, "EXPLICIT_MEMORY_TRANSPORT_MISMATCH");
  const body = request.body;
  check(body.user_id === `${fixtureUser}@${basename(harness.workspace)}`, "EXPLICIT_MEMORY_SCOPE_MISMATCH");
  if (operation === "search") {
    check(body.query === value && !Object.hasOwn(body, "session_id") && !Object.hasOwn(body, "metadata"), "EXPLICIT_SEARCH_PAYLOAD_MISMATCH");
    return;
  }
  check(body.session_id === sessionId && body.metadata?.memorax_code_session_id === sessionId,
    "EXPLICIT_ADD_SESSION_MISMATCH");
  check(body.metadata.memorax_code_base_user_id === fixtureUser
    && body.metadata.memorax_code_workspace === basename(harness.workspace)
    && body.metadata.memorax_code_memory_scope === "workspace-name.v1"
    && !Object.hasOwn(body.metadata, "memorax_code_branch_id"), "EXPLICIT_ADD_SCOPE_METADATA_MISMATCH");
  check(JSON.stringify(body.messages?.map(({ role, content }) => ({ role, content })))
    === JSON.stringify([{ role: "user", content: value }]), "EXPLICIT_ADD_CONTENT_MISMATCH");
  const hash = createHash("sha256").update(`procedural\n${reason}\n${value}`).digest("hex").slice(0, 16);
  check(body.metadata.idempotency_key === `memory-cli:${sessionId}:${hash}`
    && body.metadata.source_detail === "memorax_code_memory_cli" && body.metadata.memory_type === "procedural"
    && body.metadata.memorax_code_memory_reason === reason, "EXPLICIT_ADD_METADATA_MISMATCH");
}

async function verifyNativeRollouts() {
  const paths = (await readdir(join(harness.codexHome, "sessions"), { recursive: true })).filter((path) => path.endsWith(".jsonl"));
  check(paths.length === 2, "NATIVE_ROLLOUT_COUNT_MISMATCH");
  const turnIds = new Set();
  for (const path of paths) {
    const records = (await readFile(join(harness.codexHome, "sessions", path), "utf8")).trim().split(/\r?\n/).map(JSON.parse);
    const meta = records.find((record) => record.type === "session_meta")?.payload;
    check(meta?.model_provider === "local_native" && meta.cli_version === harness.codexVersion, "NATIVE_ROLLOUT_PROVIDER_MISMATCH");
    const expected = expectedTurns.filter((turn) => turn.sessionId === meta.id);
    const starts = records.filter((record) => record.type === "event_msg" && record.payload.type === "task_started");
    check(starts.length === expected.length, "NATIVE_ROLLOUT_TURN_COUNT_MISMATCH");
    for (const start of starts) { check(typeof start.payload.turn_id === "string", "NATIVE_TURN_ID_MISSING"); turnIds.add(start.payload.turn_id); }
    const workspaces = await Promise.all(expected.map((turn) => realpath(turn.cwd)));
    for (const context of records.filter((record) => record.type === "turn_context")) {
      check(context.payload.model === "gpt-5.4" && workspaces.includes(await realpath(context.payload.cwd)), "NATIVE_ROLLOUT_CONTEXT_MISMATCH");
    }
    for (const [index, turn] of expected.entries()) {
      const selected = selectNativeTurnContent(records, { sessionId: turn.sessionId, turnId: starts[index].payload.turn_id });
      if (turn.kind === "ordinary") assertCompleteText(selected.user.content, turn.prompt, "NATIVE_SUBMITTED_PROMPT_INCOMPLETE");
      assertCompleteText(selected.assistant.content, turn.answer, "NATIVE_FIXTURE_ANSWER_INCOMPLETE");
      const expectedUser = redactExpectedFixtureText(selected.user.content,
        { apiKey: redactionCanary, paths: [harness.root, harness.packageRoot] });
      const userCoverage = assertCompleteText(turn.body.messages[0].content, expectedUser, "NATIVE_SELECTED_USER_CONTENT_INCOMPLETE");
      const assistantCoverage = assertCompleteText(turn.body.messages[1].content, selected.assistant.content, "NATIVE_SELECTED_ASSISTANT_CONTENT_INCOMPLETE");
      check(turn.body.messages[0].timestamp === selected.user.timestamp
        && selected.assistant.timestamps.includes(turn.body.messages[1].timestamp), "NATIVE_MESSAGE_TIMESTAMP_MISMATCH");
      const timeSources = turn.body.metadata.memorax_code_timestamp_sources;
      check(Array.isArray(timeSources) && timeSources.length === turn.body.messages.length
        && timeSources[0] === "native" && timeSources[1] === "native"
        && timeSources.every((source) => ["native", "observed", "unspecified"].includes(source)), "NATIVE_MESSAGE_TIME_AUTHORITY_MISMATCH");
      const originalUserPromptIncluded = turn.body.messages.some((message) => {
        if (message.role !== "user") return false;
        try { assertCompleteText(message.content, turn.expectedPrompt); return true; } catch { return false; }
      });
      report.contentChecks.push({ case: turn.kind, userSource: selected.user.source, assistantSource: selected.assistant.source,
        selectedUserChars: expectedUser.length, sentUserChars: turn.body.messages[0].content.length,
        userRequiredFragments: userCoverage.requiredFragments, assistantRequiredFragments: assistantCoverage.requiredFragments,
        selectedContentComplete: true, originalUserPromptIncluded,
        additionalContentObserved: userCoverage.additionalContentObserved || assistantCoverage.additionalContentObserved || turn.body.messages.length > 2 });
    }
  }
  check(turnIds.size === expectedTurns.length, "NATIVE_TURN_IDS_NOT_DISTINCT");
}

async function verifyBackgroundInheritance() {
  const background = await createNativeHarness({ packageRoot: harness.packageRoot, codexCommand: harness.codexCommand,
    label: "inheritance", writeback: false });
  const ownedPids = new Set();
  const jobsRoot = join(background.stateHome, "repo-memory-jobs");
  const repository = await realpath(background.workspace);
  const received = { foreground: 0, background: 0 };
  async function jobs() {
    const files = await readdir(jobsRoot, { recursive: true }).catch((error) => {
      if (error.code === "ENOENT") return []; throw error;
    });
    const result = [];
    for (const file of files.filter((path) => basename(path) === "job.json")) {
      const job = JSON.parse(await readFile(join(jobsRoot, file), "utf8"));
      check(job.repo === repository && job.runner === "codex", "BACKGROUND_JOB_AUTHORITY_MISMATCH");
      for (const pid of [job.workerPid, job.childPid]) if (Number.isInteger(pid) && pid > 0) ownedPids.add(pid);
      result.push(job);
    }
    return result;
  }
  try {
    const gitName = process.platform === "win32" ? "git.exe" : "git";
    const gitCandidates = (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((path) => join(path, gitName));
    let gitCommand;
    for (const path of gitCandidates) if (await stat(path).then((info) => info.isFile(), () => false)) { gitCommand = path; break; }
    check(gitCommand, "BACKGROUND_FIXTURE_REQUIRES_GIT");
    background.env.PATH += `${delimiter}${dirname(gitCommand)}`;
    Object.assign(background.env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(background.home, "missing-git-config"),
      MEMORAX_CODE_REPO_MEMORY_JOB_TIMEOUT_MS: "20000", MEMORAX_CODE_REPO_MEMORY_JOB_KILL_GRACE_MS: "1000" });
    const git = (args) => promisify(execFile)(gitCommand, args, { cwd: repository, env: background.env, timeout: 10_000, windowsHide: true });
    await git(["init", "--quiet"]);
    await git(["-c", "user.name=Native Fixture", "-c", "user.email=native@example.invalid", "commit", "--allow-empty",
      "--no-gpg-sign", "--quiet", "-m", "test: native model inheritance fixture"]);
    await background.setup();
    background.setModelHandler((body, response) => {
      check(body.model === "gpt-5.4", "BACKGROUND_MODEL_SUBSTITUTION");
      const kind = inputText(body).includes("This invocation is the authorized background repo-memory worker.") ? "background" : "foreground";
      received[kind] += 1;
      check(received[kind] === 1, "UNEXPECTED_BACKGROUND_MODEL_CONTINUATION");
      sendResponses(response, { output: [message(kind === "background" ? "BACKGROUND_MODEL_INHERITANCE_ONLY" : "FOREGROUND_MODEL_INHERITANCE_ONLY")] });
    });
    const foreground = await background.runCodex(["exec", "--strict-config", "--ignore-rules", "--json",
      "Check the current repository model inheritance fixture."]);
    const events = foreground.stdout.trim().split(/\r?\n/).map(JSON.parse);
    const foregroundId = events.find((event) => event.type === "thread.started")?.thread_id;
    check(foregroundId && events.some((event) => event.type === "turn.completed"), "BACKGROUND_FOREGROUND_TURN_FAILED");
    await waitFor(async () => {
      const observed = await jobs();
      return observed.length === 1 && ["failed", "succeeded"].includes(observed[0].status);
    }, "BACKGROUND_JOB_DID_NOT_FINISH", 40_000);
    const [job] = await jobs();
    check(job.status === "failed" && job.failureReason === "artifact_validation_failed" && job.exitCode === 0,
      "BACKGROUND_NOOP_JOB_RESULT_MISMATCH");
    check(typeof job.prompt === "string" && job.prompt === job.command?.at(-1), "BACKGROUND_JOB_PROMPT_MISSING");
    check(received.foreground === 1 && received.background === 1 && background.modelRequests.length === 2,
      "BACKGROUND_REQUEST_EVIDENCE_MISSING");
    check(background.memoryRequests.length === 0 && background.serverErrors.length === 0, "BACKGROUND_UNEXPECTED_MEMORY_OR_RECEIVER_ACTIVITY");
    const files = (await readdir(join(background.codexHome, "sessions"), { recursive: true })).filter((path) => path.endsWith(".jsonl"));
    check(files.length === 2, "BACKGROUND_NATIVE_SESSION_COUNT_MISMATCH");
    const ids = new Set();
    const observedPermissions = {};
    let workerObserved = false;
    let workerContent;
    for (const file of files) {
      const records = (await readFile(join(background.codexHome, "sessions", file), "utf8")).trim().split(/\r?\n/).map(JSON.parse);
      const metadata = records.find((record) => record.type === "session_meta")?.payload;
      check(metadata?.model_provider === "local_native" && metadata.cli_version === background.codexVersion, "BACKGROUND_NATIVE_PROVIDER_MISMATCH");
      ids.add(metadata.id);
      const contexts = records.filter((record) => record.type === "turn_context");
      check(contexts.length >= 1, "BACKGROUND_NATIVE_CONTEXT_MISSING");
      for (const context of contexts) check(context.payload.model === "gpt-5.4"
        && await realpath(context.payload.cwd) === repository, "BACKGROUND_NATIVE_CONTEXT_MISMATCH");
      observedPermissions[metadata.id === foregroundId ? "foreground" : "background"] = contexts.map(({ payload }) => {
        check(["untrusted", "on-failure", "on-request", "never"].includes(payload.approval_policy), "BACKGROUND_NATIVE_APPROVAL_POLICY_UNSUPPORTED");
        const sandbox = payload.sandbox_policy;
        check(["danger-full-access", "read-only", "workspace-write", "external-sandbox"].includes(sandbox?.type),
          "BACKGROUND_NATIVE_SANDBOX_POLICY_UNSUPPORTED");
        const network = sandbox.network_access;
        check(network === undefined || typeof network === "boolean" || ["enabled", "restricted"].includes(network),
          "BACKGROUND_NATIVE_NETWORK_POLICY_UNSUPPORTED");
        return { approval_policy: payload.approval_policy,
          sandbox_policy: { type: sandbox.type, ...(network === undefined ? {} : { network_access: network }) } };
      });
      if (metadata.id !== foregroundId) {
        const starts = records.filter((record) => record.type === "event_msg" && record.payload.type === "task_started");
        check(starts.length === 1 && typeof starts[0].payload.turn_id === "string", "BACKGROUND_NATIVE_WORKER_TURN_MISSING");
        const selected = selectNativeTurnContent(records, { sessionId: metadata.id, turnId: starts[0].payload.turn_id });
        const coverage = assertCompleteText(selected.user.content, job.prompt, "BACKGROUND_NATIVE_WORKER_PROMPT_INCOMPLETE");
        workerObserved = true;
        workerContent = { source: selected.user.source, completeJobPromptIncluded: true,
          additionalContentObserved: coverage.additionalContentObserved };
      }
    }
    check(ids.size === 2 && ids.has(foregroundId) && workerObserved, "BACKGROUND_NATIVE_WORKER_IDENTITY_MISSING");
    await waitFor(() => [...ownedPids].every((pid) => !processAlive(pid)), "BACKGROUND_PROCESS_REMAINS");
    return { status: "PASS", codexVersion: background.codexVersion, model: "gpt-5.4", provider: "local_native", foregroundRequests: 1, backgroundRequests: 1,
      distinctNativeSessions: 2, jobStatus: "failed", expectedFailure: "artifact_validation_failed",
      repoMemoryBuildValidated: false, permissionInheritanceValidated: false, observedPermissions, workerContent };
  } finally {
    await jobs().catch(() => {});
    for (const pid of ownedPids) if (processAlive(pid)) {
      await stopNativeProcessTree({ pid, kill: () => process.kill(pid, "SIGKILL") }, background.env);
    }
    await background.close();
  }
}
function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

function message(text, phase = "final_answer") {
  return { type: "message", role: "assistant", phase, content: [{ type: "output_text", text }] };
}
function shellQuote(value) {
  return process.platform === "win32" ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", "'\\''")}'`;
}
function nodeCommand(args) {
  return `${process.platform === "win32" ? "& " : ""}${[process.execPath, ...args].map(shellQuote).join(" ")}`;
}
function shellCall(body, command, callId) {
  const tools = body.tools.flatMap((tool) => tool.type === "namespace"
    ? tool.tools.map((nested) => ({ ...nested, namespace: tool.name })) : [tool]);
  const tool = tools.find((entry) => entry.name === "exec_command") ?? tools.find((entry) => entry.name === "shell_command");
  check(tool, "NATIVE_SHELL_TOOL_NOT_AVAILABLE");
  return { type: "function_call", call_id: callId, name: tool.name, ...(tool.namespace ? { namespace: tool.namespace } : {}),
    arguments: JSON.stringify(tool.name === "exec_command" ? { cmd: command, max_output_tokens: 15000 } : { command, timeout_ms: 15000 }) };
}
function inputText(body) {
  const text = [];
  function visit(value) {
    if (typeof value === "string") {
      text.push(value);
      if (value.startsWith("{") || value.startsWith("[")) { try { visit(JSON.parse(value)); } catch {} }
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") Object.values(value).forEach(visit);
  }
  visit(body.input); visit(body.instructions);
  return text.join("\n");
}
