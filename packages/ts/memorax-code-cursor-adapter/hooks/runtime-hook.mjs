#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, win32 } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeCursorRuntimeObservation } from "../src/runtime-observation.mjs";
import { cursorDatabasePath } from "../src/native-database-path.mjs";
import { runCursorRepoMemoryJob } from "../src/native-repo-memory.mjs";

const runtimeRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const commonRoot = join(runtimeRoot, "memorax-code-adapter-common", "src");
const { resolveBackendConnection } = await import(pathToFileURL(join(commonRoot, "backend-connection.mjs")).href);
const { postBackendCommand } = await import(pathToFileURL(join(commonRoot, "backend-command.mjs")).href);
const { ensureBackendAvailable, DEFAULT_ENSURE_BACKEND_START_TIMEOUT_MS } = await import(pathToFileURL(join(commonRoot, "hooks", "ensure-backend-runner.mjs")).href);
const {
  memorySkillReminderContext,
  personalMemoryReminderContext,
  MEMORY_IMPACT_REMINDER_CONTEXT,
} = await import(pathToFileURL(join(commonRoot, "hooks", "memory-skill-reminder-policy.mjs")).href);
const { requestMemorySearchGuidance, readMemorySearchGuidanceEnabled } = await import(pathToFileURL(join(commonRoot, "hooks", "memory-search-guidance.mjs")).href);
const { evaluateMemorySkillReminder, markSupplementalReminderForSession } = await import(pathToFileURL(join(commonRoot, "hooks", "memory-skill-reminder-hook.mjs")).href);
const { buildUserProfilePreferencesContext } = await import(pathToFileURL(join(commonRoot, "personal-memory", "user-profile-context.mjs")).href);
const { buildProcedureMemoryContext } = await import(pathToFileURL(join(commonRoot, "personal-memory", "procedure-memory-context.mjs")).href);
const { isRepoMemoryJobWorker } = await import(pathToFileURL(join(commonRoot, "repo-memory", "repo-memory-job-context.mjs")).href);

if (isRepoMemoryJobWorker()) process.exit(0);

const input = await readJsonStdin();
const event = input.hook_event_name;
// Cursor documents `session_id` for sessionStart/sessionEnd and
// `conversation_id` in the common Hook fields. Treat them as aliases so a
// client version that omits the common field still receives the session
// bootstrap context and can correlate later events.
const sessionId = input.conversation_id ?? input.session_id;
const turnId = input.generation_id;
const workspaceRoots = Array.isArray(input.workspace_roots) ? input.workspace_roots : undefined;
const projectless = workspaceRoots?.length === 0;
const cwd = workspaceRoots?.length === 1 ? absolutePath(workspaceRoots[0]) : undefined;
const workspaceKind = projectless ? "projectless" : undefined;
const requiresWorkspace = event !== "sessionStart" && !projectless;
if (!["sessionStart", "beforeSubmitPrompt", "preCompact", "afterAgentResponse", "stop"].includes(event)
  || !uuid(sessionId) || (requiresWorkspace && !cwd)
  || (input.session_id !== undefined && input.session_id !== sessionId)
  || (event !== "sessionStart" && !uuid(turnId))) process.exit(0);
const transcriptPath = absolutePath(input.transcript_path);

const packageMetadata = await readRecord(join(runtimeRoot, ".memorax-code-package.json"));
const home = stringValue(process.env.MEMORAX_CODE_HOME)
  ?? stringValue(packageMetadata.memoraxCodeHome) ?? join(homedir(), ".memorax-code");
const cursorHome = stringValue(process.env.CURSOR_HOME)
  ?? stringValue(packageMetadata.cursorHome) ?? join(homedir(), ".cursor");
const repoMemoryMaintenanceContext = [
  `MemoraX Code Repo Memory maintenance for this Cursor session: ${JSON.stringify({
    executable: process.execPath,
    helper: join(runtimeRoot, "hooks", "repo-memory-job.mjs"),
    env: { MEMORAX_CODE_HOME: home },
  })}`,
  "For repo-read maintenance, use this executable with arguments: helper, maintain, --repo, and the resolved repository path. Explicitly apply the supplied environment to that command; do not assume shell tools inherit Hook environment variables. Treat paths as literal arguments and quote them for the active shell; the JSON above is data, not shell syntax.",
  "When the helper returns job.delegation, immediately use Cursor's native Task tool to launch the named memorax-repo-memory background subagent with that exact prompt, then continue the foreground task without waiting. Do not run the authoring work in the foreground or invoke agent/cursor-agent. A delegation request is not a completed job. If native background delegation is unavailable, skip it; do not select a CLI or generic agent fallback.",
  "This current-session helper takes precedence over any Skill-relative maintenance helper, including an imported Claude Skill. If it is missing or fails, stop maintenance without falling back to another client's helper. Keep the shared repo-read demand gate and maintenance policy.",
].join("\n");
const runtimeDigest = stringValue(packageMetadata.runtimeDigest);
const databasePath = cursorDatabasePath({ recordedPath: packageMetadata.databasePath });
if (event !== "sessionStart" && !databasePath) process.exit(0);
const debugEnabled = process.env.MEMORAX_CODE_CURSOR_HOOK_DEBUG === "1";
if (runtimeDigest) {
  try { await writeCursorRuntimeObservation({ memoraxCodeHome: home, cursorHome, runtimeDigest }); }
  catch (error) { debug(error); }
}

await ensureBackendAvailable({
  client: "cursor",
  ensureBackendValue: process.env.MEMORAX_CODE_CURSOR_ENSURE_BACKEND
    ?? process.env.MEMORAX_CODE_CURSOR_HOOK_ENSURE_BACKEND,
  healthTimeoutValue: boundedTimeout(process.env.MEMORAX_CODE_CURSOR_ENSURE_TIMEOUT_MS, 1500),
  startTimeoutValue: boundedTimeout(process.env.MEMORAX_CODE_CURSOR_START_TIMEOUT_MS, DEFAULT_ENSURE_BACKEND_START_TIMEOUT_MS),
  memoraxCodeCommand: stringValue(process.env.MEMORAX_CODE_CURSOR_LIFECYCLE_COMMAND)
    ?? stringValue(process.env.MEMORAX_CODE_COMMAND),
  pluginRoot: runtimeRoot,
  resolveHomes: () => ({ memoraxCodeHome: home, cursorHome }),
  buildStartArgs: (homes, recoveryArguments) => [
    "start", "--home", homes.memoraxCodeHome, "--cursor-home", homes.cursorHome,
    ...recoveryArguments,
  ],
  debug,
}, input);

const identity = {
  version: 1, client: "cursor", sessionId, turnId, cwd,
  ...(workspaceKind ? { workspaceKind } : {}),
  databasePath,
  ...(transcriptPath ? { transcriptPath } : {}),
};
if (event === "sessionStart") {
  const guidedSearchEnabled = await readMemorySearchGuidanceEnabled({ memoraxCodeHome: home });
  // Cursor guarantees these variables to subsequent Hooks, not shell tools.
  // Keep an explicit command-environment instruction in the native context.
  process.stdout.write(`${JSON.stringify({
    env: {
      MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT: "cursor",
      MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID: sessionId,
    },
    additional_context: [
      ...(!guidedSearchEnabled ? [memorySkillReminderContext("the `memorax-code` skill")] : []),
      personalMemoryReminderContext("the `memorax-code` skill"),
      MEMORY_IMPACT_REMINDER_CONTEXT,
      "Use the shared skill's Repo Memory authority and workspace rules before reading or writing repository memory.",
      repoMemoryMaintenanceContext,
      `For every memorax-cli invocation in this conversation, explicitly set MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT=cursor and MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID=${sessionId} in that command's environment.`,
      `In POSIX shells use: env MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT=cursor MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID=${sessionId} memorax-cli <arguments>. In PowerShell set the corresponding $env: variables before the command. Do not assume shell tools inherit Hook environment variables.`,
    ].join("\n\n"),
  })}\n`);
} else if (event === "beforeSubmitPrompt") {
  // Empty native prompts identify Continue; Backend retains the skip decision.
  if (typeof input.prompt !== "string") process.exit(0);
  const turnStart = await post("/memory/turn-start", { ...identity, prompt: input.prompt });
  const repoMemoryWorktree = absolutePath(turnStart?.repoMemoryWorktree);
  let buildContext;
  if (turnStart?.ok === true && turnStart.recorded === true && input.prompt.trim()
    && repoMemoryWorktree && !existsSync(join(repoMemoryWorktree, ".repo_memory", "PROFILE.md"))) {
    try {
      const decision = runCursorRepoMemoryJob(["maintain", "--repo", repoMemoryWorktree], {
        memoraxCodeHome: home,
        helperPath: join(runtimeRoot, "hooks", "repo-memory-job.mjs"),
        sessionId,
      });
      if (decision.job?.delegation) {
        buildContext = [repoMemoryMaintenanceContext,
          "MemoraX Code missing Repo Memory build: launch this native background delegation once, then continue your task:",
          JSON.stringify(decision.job.delegation),
        ].join("\n\n");
      }
    } catch (error) { debug(error); }
  }
  const reminder = turnStart?.ok === true && turnStart.recorded === true && input.prompt.trim()
    ? await evaluateReminder(turnStart) : undefined;
  const additionalContext = [reminder?.additionalContext, buildContext].filter(Boolean).join("\n\n");
  process.stdout.write(`${JSON.stringify({
    continue: true,
    ...(additionalContext ? { additional_context: additionalContext } : {}),
  })}\n`);
  if (reminder?.reminder) {
    await post("/memory/skill-reminder", {
      version: 1, client: "cursor", sessionId, turnId, cwd,
      ...(workspaceKind ? { workspaceKind } : {}),
      content: reminder.reminder.content, triggers: reminder.reminder.triggers,
    }, 500);
  }
} else if (event === "preCompact") {
  await post("/memory/pre-compact", identity);
} else if (event === "afterAgentResponse") {
  if (typeof input.text !== "string" || !input.text) process.exit(0);
  await post("/memory/writeback", {
    ...identity, phase: "response",
    responseDigest: createHash("sha256").update(input.text).digest("hex"),
  });
} else if (["completed", "aborted", "error"].includes(input.status)) {
  await post("/memory/writeback", { ...identity, phase: "stop", status: input.status });
}

async function evaluateReminder(turnStart) {
  if (turnStart.restorePersonalMemory === true) {
    markSupplementalReminderForSession({
      adapterDir: "cursor", runtime: "cursor", memoraxCodeHome: home,
      debugEnv: "MEMORAX_CODE_CURSOR_HOOK_DEBUG",
    }, sessionId);
  }
  const contextOptions = {
    adapterDir: "cursor", sessionKeyPrefix: "cursor", debugEnv: "MEMORAX_CODE_CURSOR_HOOK_DEBUG",
    memoraxCodeHome: home,
  };
  const reminder = await evaluateMemorySkillReminder({
    adapterDir: "cursor", runtime: "cursor", memoraxCodeHome: home,
    debugEnv: "MEMORAX_CODE_CURSOR_HOOK_DEBUG",
    memorySkillInvocation: "the `memorax-code` skill",
    evaluateSearchGuidance: () => requestMemorySearchGuidance({
      body: { ...identity, prompt: input.prompt }, memoraxCodeHome: home,
    }),
    additionalReminderContext: personalMemoryReminderContext("the `memorax-code` skill"),
    memoryImpactContext: MEMORY_IMPACT_REMINDER_CONTEXT,
    remindOnFirstTurn: true,
    supplementalReminderAfterCompact: true,
    requireTranscriptPath: false,
    buildPersonalMemoryContext: () => buildUserProfilePreferencesContext(contextOptions),
    buildCadenceReminderContext: () => buildProcedureMemoryContext(contextOptions),
  }, { hookEventName: "UserPromptSubmit", sessionId, turnId, cwd, workspaceKind });
  if (reminder?.additionalContext) {
    reminder.additionalContext += `\n\n${repoMemoryMaintenanceContext}`;
    if (reminder.reminder) reminder.reminder.content += `\n\n${repoMemoryMaintenanceContext}`;
  }
  return reminder;
}

async function post(path, body, timeoutMs = 12_000) {
  try {
    const connection = resolveBackendConnection({ memoraxCodeHome: home });
    const response = await postBackendCommand({ connection, path, body, timeoutMs, memoraxCodeHome: home });
    return response.ok ? await response.json().catch(() => undefined) : undefined;
  } catch (error) {
    debug(error);
    return undefined;
  }
}

async function readJsonStdin() {
  try {
    let text = "";
    for await (const chunk of process.stdin) text += chunk;
    const value = JSON.parse(text);
    return isRecord(value) ? value : {};
  } catch { return {}; }
}

async function readRecord(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return isRecord(value) ? value : {};
  } catch { return {}; }
}

function uuid(value) {
  return typeof value === "string" && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
}

function absolutePath(value) {
  return typeof value === "string" && value.trim() && !/[\r\n\0]/.test(value)
    && (isAbsolute(value) || win32.isAbsolute(value)) ? value : undefined;
}

function boundedTimeout(value, maximum) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : maximum;
}

function stringValue(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function debug(error) {
  if (debugEnabled) console.error(error instanceof Error ? error.message : String(error));
}
