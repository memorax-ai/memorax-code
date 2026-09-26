#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { check, createNativeHarness, fixtureKey, fixtureUser, searchResult, sendResponses, stopNativeProcessTree, waitFor } from "./codex-native-support.mjs";

const report = { status: "FAIL", scope: "native_codex_installed_plugin_mock_memorax", platform: process.platform,
  paidModelRequests: 0, modelQualityEvaluated: false, checks: [] };
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
  report.checks.push("real Codex 0.147.0, installed plugin, trusted Hooks and Backend ready");

  stage = "native first turn and filtering";
  const first = await turn({ prompt: "Explain why parser input must be validated before use.", answer: "Validate parser input before interpreting it.",
    steps: [(_body, response) => sendResponses(response, { output: [
      { type: "reasoning", id: "reasoning-fixture", summary: [{ type: "summary_text", text: reasoningCanary }] },
      message(commentaryCanary, "commentary"), message("Validate parser input before interpreting it."),
    ] })] });
  check(inputText(harness.modelRequests[0].body).includes("MemoraX Code reminder:"), "NATIVE_HOOK_REMINDER_NOT_IN_MODEL_CONTEXT");
  report.checks.push("native SessionStart/UserPromptSubmit/Stop chain produces exact QA; reasoning and commentary excluded");

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
  report.checks.push("exec resume keeps the native session; tool output is excluded from automatic Add");

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
  const beforeDirect = harness.memoryRequests.length;
  const searched = JSON.parse((await harness.runMemory(["search", "--query", directQuery, "--session-id", first, "--json"])).stdout);
  check(searched.ok === true && JSON.stringify(searched).includes(searchResult), "DIRECT_SEARCH_RESULT_MISMATCH");
  const added = JSON.parse((await harness.runMemory(["add", "--memory", directMemory, "--type", "procedural",
    "--reason", "Preserve the parser validation invariant.", "--session-id", first, "--json"])).stdout);
  check(added.ok === true && added.receipt?.accepted === true, "DIRECT_ADD_NOT_ACCEPTED");
  check(harness.memoryRequests.length === beforeDirect + 2, "DIRECT_MEMORY_REQUEST_COUNT_MISMATCH");
  check(harness.memoryRequests[beforeDirect].body.query === directQuery
    && JSON.stringify(harness.memoryRequests[beforeDirect + 1].body.messages).includes(directMemory), "DIRECT_MEMORY_PAYLOAD_MISMATCH");
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
    const args = operation === "search" ? ["search", "--query", query, "--json"]
      : ["add", "--memory", memory, "--type", "procedural", "--reason", "Keep the verified parser validation lesson.", "--json"];
    const command = nodeCommand([harness.memoryEntrypoint, ...args]);
    const before = harness.memoryRequests.length;
    const prompt = `$${skillName} Use coding memory ${operation} for the parser validation lesson.`;
    const answer = `Native Skill ${operation} completed through the installed memory CLI.`;
    await turn({ sessionId: first, prompt, answer, extraMemoryRequests: 1, steps: [
      (body, response) => {
        check(inputText(body).includes("# MemoraX Code") && inputText(body).includes("## Authority Router"), "NATIVE_SKILL_NOT_LOADED");
        sendResponses(response, { output: [shellCall(body, nodeCommand(["-e",
          'process.stdout.write(require("node:fs").readFileSync(process.argv[1], "utf8"))', reference]), `read-${operation}`)] });
      },
      (body, response) => {
        check(inputText(body).includes(referenceText.split("\n")[0])
          && inputText(body).includes(referenceText.trim().split("\n").at(-1)), "NATIVE_SKILL_REFERENCE_NOT_READ");
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
    check(request.path === `/v1/memories/${operation}`, "NATIVE_SKILL_OPERATION_MISMATCH");
    check(operation === "search" ? request.body.query === query : JSON.stringify(request.body.messages).includes(memory), "NATIVE_SKILL_PAYLOAD_MISMATCH");
    report.checks.push(`native Skill ${operation}: loaded router, read installed reference, executed native shell tool and consumed CLI result`);
  }

  stage = "native identities, exact requests and outbound boundary";
  await verifyNativeRollouts();
  check(harness.serverErrors.length === 0, "LOCAL_RECEIVER_REPORTED_FAILURE");
  check(harness.modelRequests.length === 11, "UNEXPECTED_NATIVE_MODEL_REQUEST_COUNT");
  check(harness.memoryRequests.length === 10, "UNEXPECTED_TOTAL_MEMORY_REQUEST_COUNT");
  check(harness.memoryRequests.filter((request) => request.path === "/v1/memories/search").length === 2, "UNEXPECTED_AUTOMATIC_SEARCH");
  for (const request of harness.memoryRequests) {
    check(request.authorization === `Token ${fixtureKey}`, "MEMORY_AUTHORIZATION_MISMATCH");
    const payload = JSON.stringify(request.body);
    for (const excluded of [harness.root, fixtureKey, reasoningCanary, commentaryCanary, toolCanary, redactionCanary]) {
      check(!payload.includes(excluded), "PRIVATE_OR_NON_QA_CONTENT_ENTERED_MEMORY_PAYLOAD");
    }
  }
  report.status = "PASS";
  report.nativeSessions = 2;
  report.nativeTurns = expectedTurns.length;
  report.mainChainModelRequests = harness.modelRequests.length;
  report.modelRequests = harness.modelRequests.length + 2;
  report.memoryRequests = { automaticAdd: 6, explicitAdd: 2, explicitSearch: 2 };
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

async function turn({ prompt, answer, sessionId, cwd = harness.workspace, expectedPrompt = prompt, extraMemoryRequests = 0,
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
  check(threads.length === 1 && completed.length === 1 && messages.at(-1)?.item.text === answer, "NATIVE_TURN_RESULT_MISMATCH");
  check(step === steps.length, "NATIVE_MODEL_STEPS_NOT_EXERCISED");
  const nativeSession = threads[0].thread_id;
  check(typeof nativeSession === "string" && (!sessionId || sessionId === nativeSession), "NATIVE_RESUME_SESSION_MISMATCH");
  await waitFor(() => harness.memoryRequests.length >= beforeMemory + 1 + extraMemoryRequests, "NATIVE_STOP_DID_NOT_WRITE_BACK");
  check(harness.memoryRequests.length === beforeMemory + 1 + extraMemoryRequests, "NATIVE_TURN_MEMORY_REQUEST_COUNT_MISMATCH");
  const automatic = harness.memoryRequests.slice(beforeMemory).filter((request) => request.body.metadata?.idempotency_key?.startsWith("automatic:codex:"));
  check(automatic.length === 1, "EXPECTED_ONE_AUTOMATIC_ADD_PER_NATIVE_TURN");
  const body = automatic[0].body;
  check(body.session_id === nativeSession && body.metadata.memorax_code_session_id === nativeSession, "NATIVE_WRITEBACK_SESSION_MISMATCH");
  check(body.user_id === `${fixtureUser}@${basename(cwd)}` && body.metadata.memorax_code_workspace === basename(cwd)
    && body.metadata.memorax_code_memory_scope === "workspace-name.v1", "NATIVE_WRITEBACK_SCOPE_MISMATCH");
  const qaMatches = JSON.stringify(body.messages.map(({ role, content }) => ({ role, content })))
    === JSON.stringify([{ role: "user", content: expectedPrompt }, { role: "assistant", content: answer }]);
  if (!qaMatches) report.qaMismatch = {
    expectedUserChars: expectedPrompt.length, observedUserChars: body.messages[0]?.content?.length ?? 0,
    userMatches: body.messages[0]?.content === expectedPrompt, assistantMatches: body.messages[1]?.content === answer,
    userContainsSkillRouter: body.messages[0]?.content?.includes("## Authority Router") === true,
    userContainsHookReminder: body.messages[0]?.content?.includes("MemoraX Code reminder:") === true,
  };
  check(qaMatches, "NATIVE_WRITEBACK_QA_MISMATCH");
  const hash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 16);
  check(body.metadata.idempotency_key === `automatic:codex:${hash(body.user_id)}:${nativeSession}:${hash(expectedPrompt)}:${hash(answer)}`,
    "NATIVE_WRITEBACK_IDEMPOTENCY_MISMATCH");
  expectedTurns.push({ sessionId: nativeSession, prompt, answer, cwd, body });
  return nativeSession;
}

async function verifyNativeRollouts() {
  const paths = (await readdir(join(harness.codexHome, "sessions"), { recursive: true })).filter((path) => path.endsWith(".jsonl"));
  check(paths.length === 2, "NATIVE_ROLLOUT_COUNT_MISMATCH");
  const turnIds = new Set();
  for (const path of paths) {
    const records = (await readFile(join(harness.codexHome, "sessions", path), "utf8")).trim().split(/\r?\n/).map(JSON.parse);
    const meta = records.find((record) => record.type === "session_meta")?.payload;
    check(meta?.model_provider === "local_native" && meta.cli_version === "0.147.0", "NATIVE_ROLLOUT_PROVIDER_MISMATCH");
    const expected = expectedTurns.filter((turn) => turn.sessionId === meta.id);
    const starts = records.filter((record) => record.type === "event_msg" && record.payload.type === "task_started");
    check(starts.length === expected.length, "NATIVE_ROLLOUT_TURN_COUNT_MISMATCH");
    for (const start of starts) { check(typeof start.payload.turn_id === "string", "NATIVE_TURN_ID_MISSING"); turnIds.add(start.payload.turn_id); }
    const workspaces = await Promise.all(expected.map((turn) => realpath(turn.cwd)));
    for (const context of records.filter((record) => record.type === "turn_context")) {
      check(context.payload.model === "gpt-5.4" && workspaces.includes(await realpath(context.payload.cwd)), "NATIVE_ROLLOUT_CONTEXT_MISMATCH");
    }
    for (const [index, turn] of expected.entries()) {
      const interval = records.slice(records.indexOf(starts[index]), index + 1 < starts.length ? records.indexOf(starts[index + 1]) : undefined);
      const user = interval.find((record) => record.type === "event_msg" && record.payload.type === "user_message"
        && record.payload.message === turn.prompt);
      const assistant = interval.find((record) => record.type === "response_item" && record.payload.role === "assistant"
        && record.payload.phase === "final_answer" && record.payload.content?.map((part) => part.text ?? "").join("\n") === turn.answer);
      const completed = interval.find((record) => record.type === "event_msg" && record.payload.type === "task_complete"
        && record.payload.turn_id === starts[index].payload.turn_id);
      check(user && assistant, "NATIVE_ROLLOUT_QA_NOT_FOUND");
      check(turn.body.messages[0].timestamp === Date.parse(user.timestamp)
        && [assistant, completed].filter(Boolean).some((record) => turn.body.messages[1].timestamp === Date.parse(record.timestamp)),
      "NATIVE_MESSAGE_TIMESTAMP_MISMATCH");
      check(JSON.stringify(turn.body.metadata.memorax_code_timestamp_sources) === '["native","native"]', "NATIVE_MESSAGE_TIME_AUTHORITY_MISMATCH");
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
    let workerObserved = false;
    for (const file of files) {
      const records = (await readFile(join(background.codexHome, "sessions", file), "utf8")).trim().split(/\r?\n/).map(JSON.parse);
      const metadata = records.find((record) => record.type === "session_meta")?.payload;
      check(metadata?.model_provider === "local_native" && metadata.cli_version === "0.147.0", "BACKGROUND_NATIVE_PROVIDER_MISMATCH");
      ids.add(metadata.id);
      const contexts = records.filter((record) => record.type === "turn_context");
      check(contexts.length >= 1 && contexts.every((record) => record.payload.model === "gpt-5.4"), "BACKGROUND_NATIVE_MODEL_MISMATCH");
      const userMessages = records.filter((record) => record.type === "event_msg" && record.payload.type === "user_message");
      if (metadata.id !== foregroundId) workerObserved = userMessages.some((record) => record.payload.message === job.prompt);
    }
    check(ids.size === 2 && ids.has(foregroundId) && workerObserved, "BACKGROUND_NATIVE_WORKER_IDENTITY_MISSING");
    await waitFor(() => [...ownedPids].every((pid) => !processAlive(pid)), "BACKGROUND_PROCESS_REMAINS");
    return { status: "PASS", model: "gpt-5.4", provider: "local_native", foregroundRequests: 1, backgroundRequests: 1,
      distinctNativeSessions: 2, jobStatus: "failed", expectedFailure: "artifact_validation_failed",
      repoMemoryBuildValidated: false, permissionInheritanceValidated: false };
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
