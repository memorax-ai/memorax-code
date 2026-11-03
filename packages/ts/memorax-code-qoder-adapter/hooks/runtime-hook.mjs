#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { withMemoryCliSession } from "../src/memory-cli-context.mjs";
import { writeQoderRuntimeObservation } from "../src/runtime-observation.mjs";
import { runQoderRepoMemoryJob } from "../src/native-repo-memory.mjs";
import { isQoderChildHook, deferQoderNotification, peekQoderNotification, consumeQoderNotification } from "../src/repo-memory-events.mjs";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const commonRoot = join(runtimeRoot, "memorax-code-adapter-common", "src");
const common = (path) => import(pathToFileURL(join(commonRoot, path)).href);
const { readStdinJson, injectClientHookInput, readJsonFile } = await common("config-utils.mjs");
const { isQoderManagedTaskWorkspace } = await common("default-workspace.mjs");
const { isRepoMemoryJobWorker } = await common("repo-memory/repo-memory-job-context.mjs");
const { sharedRepoMemoryPath } = await common("repo-memory/repo-memory-shared-bundle.mjs");
const { resolveBackendConnection } = await common("backend-connection.mjs");
const { postBackendCommand } = await common("backend-command.mjs");
const { runEnsureBackendHook } = await common("hooks/ensure-backend-runner.mjs");
const { requestMemorySearchGuidance } = await common("hooks/memory-search-guidance.mjs");
const { buildProcedureMemoryContext } = await common("personal-memory/procedure-memory-context.mjs");
const { buildUserProfilePreferencesContext } = await common("personal-memory/user-profile-context.mjs");
const {
  evaluateMemorySkillReminder, markSupplementalReminderAfterCompact,
  MEMORY_IMPACT_REMINDER_CONTEXT, personalMemoryReminderContext,
} = await common("hooks/memory-skill-reminder-hook.mjs");

try { await run(); } catch (error) { debug(error); }

async function run() {
  if (isRepoMemoryJobWorker()) return;
  const input = await readStdinJson();
  if (isQoderChildHook(input)) return;
  const event = input.hook_event_name;
  const sessionId = identity(input.session_id);
  if (!["SessionStart", "UserPromptSubmit", "QueryEnd", "PreToolUse"].includes(event) || !sessionId) return;
  if (input.sessionId !== undefined && input.sessionId !== sessionId) return;
  const metadata = await readRecord(join(runtimeRoot, ".memorax-code-package.json"));
  const home = absolutePath(metadata.memoraxCodeHome);
  const qoderHome = absolutePath(metadata.qoderHome);
  if (metadata.version !== 1 || !home || !qoderHome || !/^[a-f0-9]{64}$/.test(metadata.runtimeDigest)) return;
  if (!enabled(home, qoderHome, metadata.runtimeDigest)) return;

  if (event === "PreToolUse") {
    if (input.tool_name !== "Bash" || !isRecord(input.tool_input)) return;
    const command = withMemoryCliSession(input.tool_input.command, sessionId, home);
    if (command === input.tool_input.command) return;
    output({ hookSpecificOutput: {
      hookEventName: "PreToolUse",
      updatedInput: { ...input.tool_input, command },
    } });
    return;
  }

  const cwd = absolutePath(input.cwd);
  const transcriptPath = absolutePath(input.transcript_path);
  const turnId = identity(input.request_set_id);
  if (!cwd || !transcriptPath || (event !== "SessionStart" && !turnId)) return;
  if (input.requestSetId !== undefined && input.requestSetId !== turnId) return;
  if (input.transcriptPath !== undefined && input.transcriptPath !== transcriptPath) return;
  const reminderOptions = {
    adapterDir: "qoder", runtime: "qoder", debugEnv: "MEMORAX_CODE_QODER_HOOK_DEBUG",
    memoraxCodeHome: home, supplementalReminderAfterCompact: true,
  };
  if (event === "SessionStart") {
    // The native transcript need not exist until the first submitted prompt.
    await writeQoderRuntimeObservation({ memoraxCodeHome: home, qoderHome, runtimeDigest: metadata.runtimeDigest });
    injectClientHookInput(input);
    await runEnsureBackendHook({
      client: "qoder", pluginRoot: runtimeRoot,
      ensureBackendValue: process.env.MEMORAX_CODE_QODER_ENSURE_BACKEND ?? process.env.MEMORAX_CODE_QODER_HOOK_ENSURE_BACKEND,
      healthTimeoutValue: process.env.MEMORAX_CODE_QODER_ENSURE_TIMEOUT_MS,
      startTimeoutValue: process.env.MEMORAX_CODE_QODER_START_TIMEOUT_MS,
      memoraxCodeCommand: stringValue(process.env.MEMORAX_CODE_QODER_LIFECYCLE_COMMAND)
        ?? stringValue(process.env.MEMORAX_CODE_COMMAND),
      shouldRecover: () => enabled(home, qoderHome, metadata.runtimeDigest),
      resolveHomes: () => ({ memoraxCodeHome: home, qoderHome }),
      buildStartArgs: (homes, recoveryArguments) => [
        "start", "--home", homes.memoraxCodeHome, "--qoder-home", homes.qoderHome, ...recoveryArguments,
      ],
      debug,
    });
    markSupplementalReminderAfterCompact(reminderOptions, input);
    return;
  }

  const command = { version: 1, client: "qoder", sessionId, turnId, transcriptPath, cwd,
    ...(isQoderManagedTaskWorkspace(cwd) ? { workspaceKind: "projectless" } : {}),
  };
  if (event === "QueryEnd") {
    const status = input.reason === "end_turn" ? "completed" : input.reason === "abort" ? "aborted" : undefined;
    if (!status) return;
    const deferred = await peekQoderNotification(command, { memoraxCodeHome: home });
    if (deferred && status === "aborted") {
      await consumeQoderNotification(deferred, { memoraxCodeHome: home });
      // A concurrent registration may already exist in the Backend.
    } else if (deferred) {
      const response = await post(home, "/memory/turn-start", deferred);
      if (response?.ok !== true || response.recorded !== true) return;
      if (!await consumeQoderNotification(deferred, { memoraxCodeHome: home })) return;
    }
    if (status) await post(home, "/memory/writeback", { ...command, status });
    return;
  }

  const prompt = contentValue(input.prompt);
  if (!prompt) return;
  const turnStart = { ...command, prompt };
  if (await deferQoderNotification(turnStart, { memoraxCodeHome: home })) return;
  const response = await post(home, "/memory/turn-start", turnStart);
  const recorded = response?.ok === true && response.recorded === true;
  const repoMemoryWorktree = absolutePath(response?.repoMemoryWorktree);
  let delegation;
  if (recorded && repoMemoryWorktree) {
    try {
      const agent = await readFile(join(qoderHome, "agents", "memorax-repo-memory.md"));
      const expected = await readFile(join(runtimeRoot, "agents", "memorax-repo-memory.md"));
      if (createHash("sha256").update(agent).digest("hex") !== createHash("sha256").update(expected).digest("hex")) throw new Error("Qoder Repo Memory agent changed");
      if (!existsSync(join(sharedRepoMemoryPath(home, repoMemoryWorktree), "baseline.json"))) {
        const decision = runQoderRepoMemoryJob(["maintain", "--repo", repoMemoryWorktree], {
          memoraxCodeHome: home, sessionId,
          assertEnabled: () => {
            if (!enabled(home, qoderHome, metadata.runtimeDigest)) throw new Error("Qoder Repo Memory runtime disabled");
          },
          helperPath: join(runtimeRoot, "hooks", "repo-memory-job.mjs"),
          validatorPath: join(qoderHome, "skills", "memorax-code", "scripts", "repo-memory.mjs"),
        });
        delegation = decision.job?.delegation;
      }
    } catch (error) { debug(error); }
  }
  const personalOptions = { adapterDir: "qoder", sessionKeyPrefix: "qoder", debugEnv: "MEMORAX_CODE_QODER_HOOK_DEBUG", memoraxCodeHome: home };
  const invocation = "the `memorax-code` skill";
  const reminder = await evaluateMemorySkillReminder({
    ...reminderOptions,
    ...(recorded ? { evaluateSearchGuidance: () => requestMemorySearchGuidance({ body: turnStart, memoraxCodeHome: home }) } : {}),
    additionalReminderContext: personalMemoryReminderContext(invocation),
    memorySkillInvocation: invocation, remindOnFirstTurn: true, requireTranscriptPath: true,
    memoryImpactContext: MEMORY_IMPACT_REMINDER_CONTEXT,
    buildCadenceReminderContext: () => buildProcedureMemoryContext(personalOptions),
    buildPersonalMemoryContext: () => buildUserProfilePreferencesContext(personalOptions),
  }, { ...input, turnId });
  // Delegation capabilities are local native-agent input, never reminder trace content.
  const context = [stringValue(reminder?.additionalContext),
    recorded && (reminder?.additionalContext || delegation) ? maintenanceContext(home) : undefined,
    delegation ? "MemoraX Code missing Repo Memory build: invoke Qoder's Agent tool once with these exact arguments, then continue the foreground task:\n"
      + JSON.stringify(delegation) : undefined,
  ].filter(Boolean).join("\n\n");
  const notice = response?.ok === true ? stringValue(response.userNotice) : undefined;
  if (context || notice) output({
    ...(notice ? { systemMessage: notice } : {}),
    ...(context ? { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: context } } : {}),
  });
  if (recorded && reminder?.reminder?.turnId) await post(home, "/memory/skill-reminder", {
    ...command, content: reminder.reminder.content, triggers: reminder.reminder.triggers,
  }, 1000);
}

function maintenanceContext(home) {
  return [
    `MemoraX Code Repo Memory maintenance for this Qoder session: ${JSON.stringify({
      executable: process.execPath, helper: join(runtimeRoot, "hooks", "repo-memory-job.mjs"),
      env: { MEMORAX_CODE_HOME: home },
    })}`,
    "For repo-read maintenance, use this executable with arguments: helper, maintain, --repo, and the resolved repository path. Explicitly apply the supplied environment; shell tools need not inherit Hook variables. Quote paths as literal arguments for the active shell.",
    "If the helper returns job.delegation, pass its exact arguments to Qoder's native Agent tool, selecting memorax-repo-memory with run_in_background=true. Continue the foreground task without waiting. A delegation is not a completed job. If native delegation is unavailable, skip maintenance without a CLI or foreground authoring fallback.",
    "This current-session helper takes precedence over any Skill-relative helper. If it is missing or fails, stop maintenance. Keep the shared repo-read demand gate and update policy.",
  ].join("\n");
}

function enabled(home, qoderHome, runtimeDigest) {
  try {
    const state = readJsonFile(join(home, "adapters", "qoder", "state.json"))?.value;
    return state?.version === 1 && state.runtime === "qoder" && state.integration === "hooks"
      && state.enabled === true && state.installPending !== true && state.qoderHome === qoderHome
      && state.runtimeDigest === runtimeDigest
      && state.runtimePath === join(home, "adapters", "qoder", "runtime", "generations", runtimeDigest, "hooks", "runtime-hook.mjs")
      && realpathSync(state.runtimePath) === fileURLToPath(import.meta.url);
  } catch { return false; }
}

async function post(home, path, body, timeoutMs = 12_000) {
  try {
    const connection = resolveBackendConnection({ memoraxCodeHome: home });
    const response = await postBackendCommand({ connection, path, body, timeoutMs, memoraxCodeHome: home });
    return response.ok ? await response.json().catch(() => undefined) : undefined;
  } catch (error) { debug(error); return undefined; }
}

async function readRecord(path) {
  try { const value = JSON.parse(await readFile(path, "utf8")); return isRecord(value) ? value : {}; }
  catch { return {}; }
}

function absolutePath(value) {
  return contentValue(value) && isAbsolute(value) && !value.includes("\0") ? value : undefined;
}

function identity(value) {
  return contentValue(value) && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
}

function contentValue(value) {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function stringValue(value) {
  return contentValue(value)?.trim();
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function output(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function debug(error) {
  if (process.env.MEMORAX_CODE_QODER_HOOK_DEBUG === "1") console.error(error?.code ?? "QODER_HOOK_FAILED");
}
