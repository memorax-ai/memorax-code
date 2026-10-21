import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { check, createNativeHarness, fixtureKey, fixtureModel, fixtureUser, searchResult,
  summarizeCleanupDiagnostic, waitFor } from "./codebuddy-native-support.mjs";
import { assertCompleteText, assertNoForeignContent, assertSearchResult, assertSkillReferenceContract,
  assertWritebackMessages, expectedSearchAnswer } from "../codex/codex-native-content-check.mjs";
import { assertNativeReadText, assertNativeToolCalls, nativeHookPrompt, selectNativeBashStdout, selectNativeTurnContent,
  summarizeWritebackTrace, toolResult } from "./codebuddy-native-content-check.mjs";

export async function runNativeMemoryCheck({ client, args }) {
  check(client === "codebuddy" || client === "workbuddy", "NATIVE_CLIENT_INVALID");
  const workbuddy = client === "workbuddy";
  const clientName = workbuddy ? "WorkBuddy" : "CodeBuddy";
  const report = { status: "FAIL", scope: `native_${client}_installed_plugin_mock_memorax`, platform: process.platform,
    paidModelRequests: 0, modelQualityEvaluated: false, checks: [], contentChecks: [],
    contentContract: "CLI session and final text correlated with an independent native JSONL branch",
    allowsAdditionalContent: !workbuddy, skillExecutionValidated: false,
    permissionMatrixValidated: false, lifecycleRecoveryValidated: false, repoMemoryBuildValidated: false };
  if (workbuddy) Object.assign(report, { desktopUIValidated: false, loginFlowValidated: false });
  else report.workBuddyValidated = false;
  const redactionCanary = "sk_nativeFixtureOnlyAbcdefghijklmnop";
  const toolCanary = workbuddy ? "WORKBUDDY_NATIVE_TOOL_MARKER" : "CODEBUDDY_TOOL_OUTPUT_MUST_STAY_LOCAL";
  const expectedTurns = [];
  let harness, stage = "prerequisites", checksCompleted = false;
  try {
    check(args.length === 3, `EXPECTED_INSTALLED_PACKAGE_${client.toUpperCase()}_PATH_AND_VERSION`);
    let [packageRoot, command, expectedVersion] = args;
    if (workbuddy) {
      packageRoot = await realpath(packageRoot);
      command = await realpath(command);
      const { isWorkBuddyBundledCommand } = await import(pathToFileURL(join(packageRoot,
        "lib/memorax-code-adapter-common/src/clients/codebuddy-command.mjs")));
      check(isWorkBuddyBundledCommand(command), "EXPECTED_WORKBUDDY_BUNDLED_RUNTIME");
      check(/^\d+\.\d+\.\d+$/.test(expectedVersion), "EXPECTED_EXACT_WORKBUDDY_RUNTIME_VERSION");
    }
    harness = await createNativeHarness({ packageRoot, codebuddyCommand: command, client, expectedVersion });
    stage = "installed plugin setup";
    const status = await harness.setup();
    const adapter = status[`${client}Adapter`];
    check(adapter?.ok === true && adapter.installed === true && adapter.enabled === true
      && adapter.managed === true && adapter.codebuddyHooks?.configured === true
      && (!workbuddy || adapter.runtime === "workbuddy"),
    "NATIVE_PLUGIN_INSTALL_STATUS_MISMATCH");
    const skillRoot = await realpath(dirname(adapter.codebuddySkills.path));
    const nativeHome = await realpath(harness.nativeHome);
    check(within(nativeHome, skillRoot), "NATIVE_PLUGIN_PATH_OUTSIDE_HOME");
    const pluginRoot = await realpath(join(skillRoot, "../.."));
    check(within(nativeHome, pluginRoot), "NATIVE_PLUGIN_PATH_OUTSIDE_HOME");
    if (workbuddy) {
      const metadata = JSON.parse(await readFile(join(pluginRoot, ".memorax-code-package.json"), "utf8"));
      check(metadata.client === client && await realpath(metadata.codeBuddyHome) === nativeHome
        && await realpath(metadata.codeBuddyCommand) === command, "NATIVE_WORKBUDDY_INSTALLATION_IDENTITY_MISMATCH");
    }
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
    report[workbuddy ? "bundledRuntimeVersion" : "codebuddyVersion"] = harness.codebuddyVersion;
    report.checks.push(`real ${clientName}, installed plugin, global prompt Hook and isolated Backend configured`);

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
    const markerFile = "workbuddy-native-marker.txt";
    const markerScript = workbuddy ? `require("node:fs").writeFileSync(${JSON.stringify(markerFile)},${JSON.stringify(toolCanary)});` : "";
    const sessionScript = `${markerScript}console.log(${JSON.stringify(toolCanary)});console.log("NATIVE_SESSION="+JSON.stringify({native:process.env.CODEBUDDY_SESSION_ID,client:process.env.MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT,trace:process.env.MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID,memory:process.env.MEMORAX_CODE_MEMORY_CLI_SESSION_ID}));`;
    const sessionCommand = shellCommand([process.execPath.replaceAll("\\", "/"), "-e", sessionScript]);
    await turn({ sessionId: first, prompt: "Continue the parser discussion after checking the isolated native session.",
      answer: resumedAnswer, kind: "resume-tool", args: ["--allowedTools", "Bash"], steps: [
        (body) => ({ toolCalls: [toolCall(body, "Bash", { command: sessionCommand,
          description: "Inspect the isolated native session", timeout: 15000 }, "native-session-marker")] }),
        async (body) => {
          const output = selectNativeBashStdout(toolResult(body, "native-session-marker"), sessionCommand);
          check(output.includes(toolCanary), "NATIVE_TOOL_MARKER_MISSING");
          const match = output.match(/NATIVE_SESSION=(\{[^\r\n]+\})/);
          check(match, "NATIVE_SESSION_ENV_MISSING");
          assertNativeSessionBinding(JSON.parse(match[1]), { client, sessionId: first });
          if (workbuddy) check(await readFile(join(harness.workspace, markerFile), "utf8") === toolCanary, "NATIVE_TOOL_EFFECT_MISSING");
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
    const env = { MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT: client, MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID: first };
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
      const command = shellCommand([executable, ...args]);
      const before = harness.memoryRequests.length;
      const answer = operation === "search" ? `Recalled Coding Memory: ${searchResult}` : "Native Skill Add accepted.";
      await turn({ sessionId: first, prompt: `Use the memorax-code skill to ${operation} the parser validation lesson.`,
        answer, kind: `skill-${operation}`, explicitRequests: 1, args: ["--allowedTools", "Skill", "Read", "Bash"], steps: [
          (body) => ({ toolCalls: [toolCall(body, "Skill", { skill: "memorax-code" }, `load-${operation}`)] }),
          (body) => {
            assertCompleteText(toolResult(body, `load-${operation}`), skillBody, "NATIVE_SKILL_ROUTER_INCOMPLETE");
            return { toolCalls: [toolCall(body, "Read", { file_path: reference }, `read-${operation}`)] };
          },
          (body) => {
            assertNativeReadText(toolResult(body, `read-${operation}`), referenceText);
            return { toolCalls: [toolCall(body, "Bash", { command,
              description: `Run the installed Coding Memory ${operation} command`, timeout: 15000 }, `memory-${operation}`)] };
          },
          (body) => {
            let output;
            try {
              output = toolResult(body, `memory-${operation}`);
              const result = JSON.parse(selectNativeBashStdout(output, command).trim());
              if (operation === "search") assertSearchResult(result, { query, memory: searchResult });
              else check(result.ok === true && result.action === "memory.add" && result.receipt?.accepted === true,
                "NATIVE_SKILL_ADD_RESULT_MISMATCH");
              assertScopeResult(result);
            } catch (error) {
              report.skillBashDiagnostic = { operation, ...summarizeNativeSkillBashResult(output, command) };
              throw error;
            }
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
    const observed = JSON.parse((await harness.runProduct(["status", "--clients", client, "--json"])).stdout);
    check(observed[`${client}Adapter`]?.codebuddyHooks?.runtimeObserved === true, "NATIVE_HOOK_EXECUTION_NOT_OBSERVED");
    if (workbuddy) {
      const entries = await readdir(join(harness.home, ".codebuddy"), { recursive: true, withFileTypes: true }).catch((error) => {
        if (error.code === "ENOENT") return []; throw error;
      });
      // The bundled runtime initializes this empty directory even with WorkBuddy state.
      check(entries.length === 0 || (entries.length === 1 && entries[0].name === "diagnostics" && entries[0].isDirectory()),
        "NATIVE_STANDALONE_CODEBUDDY_HOME_CHANGED");
      report.checks.push("bundled runtime, installation, native JSONL and Add identities belong to WorkBuddy, not CodeBuddy CLI");
    }
    const trace = (await readFile(join(harness.stateHome, "debug", "traces", client, "sessions", first, "events.jsonl"), "utf8"))
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
    report.error = /^[A-Z][A-Z0-9_]+$/.test(error.nativeCode ?? "") ? error.nativeCode : "NATIVE_CHECK_FAILED_PRIVATE_OUTPUT_SUPPRESSED";
    if (Number.isInteger(error.code)) report.commandExitCode = error.code;
    if (["ENOEXEC", "ENOENT", "EACCES", "EPERM"].includes(error.code)) report.systemCode = error.code;
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
      report.cleanupDiagnostic = summarizeCleanupDiagnostic(error);
    }
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
  return report;

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
      && (!workbuddy || /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(output.sessionId))
      && (!sessionId || output.sessionId === sessionId), "NATIVE_RESUME_SESSION_MISMATCH");
    check(output.text === answer && requests === steps.length, "NATIVE_FINAL_OUTPUT_MISMATCH");
    try {
      await waitFor(() => harness.memoryRequests.length >= before + 1 + explicitRequests, "NATIVE_STOP_DID_NOT_WRITE_BACK");
    } catch (error) {
      report.writebackDiagnostic = await writebackDiagnostic(output, prompt, answer);
      throw error;
    }
    check(harness.memoryRequests.length === before + 1 + explicitRequests, "NATIVE_TURN_MEMORY_REQUEST_COUNT_MISMATCH");
    const automatic = harness.memoryRequests.slice(before).filter((request) => request.body.metadata?.idempotency_key?.startsWith(`automatic:${client}:`));
    check(automatic.length === 1, "NATIVE_AUTOMATIC_ADD_COUNT_MISMATCH");
    const [request] = automatic, body = request.body;
    check(request.method === "POST" && request.path === "/v1/memories/add"
      && request.authorization === `Token ${fixtureKey}`, "NATIVE_AUTOMATIC_ADD_TRANSPORT_MISMATCH");
    assertNativeWritebackContent(body.messages, { client, prompt: expectedPrompt, answer });
    check(body.session_id === output.sessionId && body.metadata?.memorax_code_session_id === output.sessionId,
      "NATIVE_WRITEBACK_SESSION_MISMATCH");
    check(body.user_id === `${fixtureUser}@${basename(cwd)}` && body.metadata.memorax_code_workspace === basename(cwd)
      && body.metadata.memorax_code_memory_scope === "workspace-name.v1", "NATIVE_WRITEBACK_SCOPE_MISMATCH");
    check(body.metadata.idempotency_key === `automatic:${client}:${shortHash(body.user_id)}:${output.sessionId}:${shortHash(body.messages[0].content)}:${shortHash(body.messages[1].content)}`,
      "NATIVE_WRITEBACK_IDEMPOTENCY_MISMATCH");
    const expected = { prompt, answer, expectedPrompt, sessionId: output.sessionId, cwd, body, kind, tools };
    if (workbuddy) await verifyNativeTranscript(expected, { record: false });
    expectedTurns.push(expected);
    return output.sessionId;
  }

  async function verifyNativeTranscript(expected, { record = true } = {}) {
    const files = (await readdir(harness.nativeHome, { recursive: true }))
      .filter((file) => basename(file) === `${expected.sessionId}.jsonl`);
    check(files.length === 1, "NATIVE_SESSION_TRANSCRIPT_NOT_UNIQUE");
    const transcriptPath = await realpath(join(harness.nativeHome, files[0]));
    check(within(await realpath(harness.nativeHome), transcriptPath), "NATIVE_TRANSCRIPT_PATH_OUTSIDE_HOME");
    const lines = (await readFile(transcriptPath, "utf8")).split(/\r?\n/).filter(Boolean);
    const selected = selectNativeTurnContent(lines.map(JSON.parse), {
      sessionId: expected.sessionId, prompt: expected.prompt, finalText: expected.answer,
    });
    assertNativeToolCalls(selected.lineage, expected.tools);
    const userCoverage = assertCompleteText(expected.body.messages[0].content,
      selected.user.content.replaceAll(redactionCanary, "[REDACTED:API_KEY]"));
    const assistantCoverage = assertCompleteText(expected.body.messages[1].content, selected.assistant.content);
    assertNativeWritebackContent(expected.body.messages, { client,
      prompt: selected.user.content.replaceAll(redactionCanary, "[REDACTED:API_KEY]"), answer: selected.assistant.content });
    for (const [index, source] of [selected.user, selected.assistant].entries()) {
      if (source.timestamp !== undefined) {
        check(expected.body.messages[index].timestamp === source.timestamp
          && expected.body.metadata.memorax_code_timestamp_sources?.[index] === "native", "NATIVE_TIMESTAMP_AUTHORITY_MISMATCH");
      }
    }
    const trace = (await readFile(join(harness.stateHome, "debug", "traces", client, "sessions", expected.sessionId, "events.jsonl"), "utf8"))
      .trim().split(/\r?\n/).map(JSON.parse);
    const start = assertNativeHookCorrelation(trace, { client, sessionId: expected.sessionId, prompt: expected.prompt });
    if (expected.kind.startsWith("skill-")) {
      const type = `memory_cli_${expected.kind.slice("skill-".length)}`;
      const events = trace.filter((event) => event.type === type && event.trace?.client === client
        && event.trace.session_id === expected.sessionId && event.trace.turn_id === start.trace.turn_id);
      check(events.length === 1 && events[0].ok === true, "NATIVE_SKILL_TRACE_BINDING_MISMATCH");
    }
    if (record) report.contentChecks.push({ scenario: expected.kind, nativePromptMatched: true, nativeCompletedBranchMatched: true,
      completeUserTextIncluded: true, completeAssistantTextIncluded: true, completedNativeTools: expected.tools.length,
      additionalContentObserved: userCoverage.additionalContentObserved || assistantCoverage.additionalContentObserved,
      nativeUserTimestampPresent: selected.user.timestamp !== undefined,
      nativeAssistantTimestampPresent: selected.assistant.timestamp !== undefined });
  }

  async function writebackDiagnostic(output, prompt, answer) {
    const summary = { traceAvailable: false, pendingAvailable: false,
      promptReminderObserved: harness.modelRequests.some(({ body }) => JSON.stringify(body.messages).includes("MemoraX Code reminder:")) };
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(output.sessionId)) return summary;
    const readBounded = async (path) => {
      check((await stat(path)).size <= 1024 * 1024, "DIAGNOSTIC_FILE_TOO_LARGE");
      return readFile(path, "utf8");
    };
    let events = [], pending;
    try {
      const text = await readBounded(join(harness.stateHome, "debug", "traces", client, "sessions", output.sessionId, "events.jsonl"));
      events = text.slice(0, text.lastIndexOf("\n") + 1).split(/\r?\n/).filter(Boolean).map(JSON.parse);
      summary.traceAvailable = true;
    } catch { /* Diagnostic failures do not replace the writeback failure. */ }
    try {
      pending = JSON.parse(await readBounded(join(harness.stateHome, "adapters", client, "pending.json")));
      summary.pendingAvailable = true;
    } catch { /* Do not expose private paths or native exception text. */ }
    if (workbuddy) {
      summary.stderrSignatures = ["ENOEXEC", "ENOENT", "EACCES", "EPERM"].filter((code) => output.stderr.includes(code));
      try {
        const files = (await readdir(harness.nativeHome, { recursive: true })).filter((file) => basename(file) === `${output.sessionId}.jsonl`);
        summary.nativeTranscriptCount = files.length;
        if (files.length === 1) {
          const records = (await readBounded(join(harness.nativeHome, files[0]))).split(/\r?\n/).filter(Boolean).map(JSON.parse);
          selectNativeTurnContent(records, { sessionId: output.sessionId, prompt, finalText: answer });
          summary.nativeCompletedContentMatched = true;
        }
      } catch (error) {
        summary.nativeCompletedContentMatched = false;
        summary.nativeContentError = /^[A-Z][A-Z0-9_]+$/.test(error.nativeCode ?? "") ? error.nativeCode : "other";
      }
    }
    return { ...summary, ...summarizeWritebackTrace(events, pending, { client, sessionId: output.sessionId,
      promptHash: hash(prompt.trim()), promptWithoutLineBreaksHash: hash(nativeHookPrompt(prompt)) }) };
  }
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
}

export function assertNativeSessionBinding(binding, { client, sessionId }) {
  check(client === "codebuddy" || client === "workbuddy", "NATIVE_CLIENT_INVALID");
  check(binding.native === sessionId && binding.memory === undefined
    && ((binding.client === undefined && binding.trace === undefined)
      || (binding.client === client && binding.trace === sessionId)), "NATIVE_SESSION_ENV_MISMATCH");
}

export function assertNativeWritebackContent(messages, { client, prompt, answer }) {
  check(client === "codebuddy" || client === "workbuddy", "NATIVE_CLIENT_INVALID");
  assertWritebackMessages(messages);
  assertCompleteText(messages[0].content, prompt, "NATIVE_WRITEBACK_PROMPT_MISMATCH");
  assertCompleteText(messages[1].content, answer, "NATIVE_WRITEBACK_ANSWER_MISMATCH");
  if (client === "workbuddy") check(messages.length === 2 && messages[0].content === prompt && messages[1].content === answer,
    "NATIVE_WRITEBACK_CONTENT_MISMATCH");
}

export function assertNativeHookCorrelation(events, { client, sessionId, prompt }) {
  check(client === "codebuddy" || client === "workbuddy", "NATIVE_CLIENT_INVALID");
  const digests = [hash(nativeHookPrompt(prompt))];
  if (client === "workbuddy") digests.push(hash(prompt.trim()));
  const starts = events.filter((event) => event.type === "turn_start" && event.trace?.client === client
    && event.trace.session_id === sessionId && digests.some((digest) => event.trace.turn_id?.endsWith(`:${digest}`)));
  check(starts.length === 1 && starts[0].trace.turn_id.startsWith(`${sessionId}:`), "NATIVE_HOOK_PROMPT_CORRELATION_MISSING");
  check(events.some((event) => event.type === "turn_end" && event.trace?.client === client
    && event.trace.session_id === sessionId && event.trace.turn_id === starts[0].trace.turn_id && event.outcome === "completed"),
  "NATIVE_HOOK_COMPLETION_CORRELATION_MISSING");
  return starts[0];
}

// Diagnostic hints only; acceptance still requires the exact successful Bash envelope.
export function summarizeNativeSkillBashResult(output, command) {
  const text = typeof output === "string" ? output.slice(0, 64 * 1024) : "";
  const envelope = /^Command: [^\n]*\nStdout: ([\s\S]*?)\nStderr: ([\s\S]*?)\nExit Code: ([^\r\n]*)\nSignal: ([^\r\n]*)$/.exec(text);
  const stderr = envelope?.[2], exit = envelope?.[3], signal = envelope?.[4];
  const errors = stderr ?? text;
  let result;
  try { result = JSON.parse(envelope?.[1] ?? ""); }
  catch { /* Keep malformed and private tool output out of diagnostics. */ }
  const memoryErrors = ["MEMORY_CONFIG_MISSING", "MEMORY_SCOPE_MISMATCH", "MEMORY_SCOPE_UNAVAILABLE"];
  return {
    resultPresent: typeof output === "string",
    resultTruncated: typeof output === "string" && output.length > text.length,
    expectedCommandMatched: text.startsWith(`Command: ${command}\nStdout: `),
    structuredEnvelopeMatched: Boolean(envelope),
    stderr: stderr === undefined ? "missing" : stderr === "(empty)" ? "empty" : "nonempty",
    exitCode: exit === undefined ? "missing" : exit === "0" ? "zero" : /^\d+$/.test(exit) ? "nonzero" : "other",
    signal: signal === undefined ? "missing" : signal === "(none)" ? "none" : ["SIGTERM", "SIGKILL", "SIGINT"].includes(signal) ? signal : "other",
    stdoutJson: result !== undefined,
    memoryError: memoryErrors.includes(result?.errorCode) ? result.errorCode : result?.errorCode === undefined ? "missing" : "other",
    errorSignatures: [
      ["enoexec", /\bENOEXEC\b|\bexec format error\b/i],
      ["shell_import_command_not_found", /\bimport:\s*(?:command )?not found\b|\bcommand not found:\s*import\b/i],
      ["syntax", /\bSyntaxError\b|\bsyntax error\b|\bunexpected token\b/i],
      ["command_not_found", /\bcommand not found\b|\bnot recognized as an internal or external command\b/i],
    ].filter(([, pattern]) => pattern.test(errors)).map(([name]) => name),
  };
}

function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function shortHash(value) { return hash(value).slice(0, 16); }
function toolCall(body, name, input, id) {
  check(body.tools?.some((tool) => tool.type === "function" && tool.function?.name === name), "NATIVE_REQUIRED_TOOL_MISSING");
  return { id, name, input };
}
function shellCommand(args) { return args.map((value) => `'${String(value).replaceAll("'", "'\\''")}'`).join(" "); }
function within(parent, child) {
  const path = relative(parent, child);
  return path !== ".." && !path.startsWith("../") && !path.startsWith("..\\") && !isAbsolute(path);
}
