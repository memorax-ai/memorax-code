#!/usr/bin/env node
import { readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBackendConnection } from "../../memorax-code-adapter-common/src/backend-connection.mjs";
import { readStdinJson, stringOption } from "../../memorax-code-adapter-common/src/config-utils.mjs";
import {
  evaluateMemorySkillReminder,
  markSupplementalReminderForSession,
  personalMemoryReminderContext,
} from "../../memorax-code-adapter-common/src/hooks/memory-skill-reminder-hook.mjs";
import { buildRepoProcedureMemoryContext } from "../../memorax-code-adapter-common/src/repo-memory/repo-procedure-memory-context.mjs";
import { buildRepoUserProfilePreferencesContext } from "../../memorax-code-adapter-common/src/repo-memory/repo-user-profile-context.mjs";
import {
  attachKimiTurnId,
  consumeKimiTurn,
  kimiCorrelationStatePath,
  pendingKimiTurns,
  rememberKimiPrompt,
} from "./prompt-correlation.mjs";

const TURN_START_TIMEOUT_MS = 12_000;

export async function runKimiHook(input, options = {}) {
  const event = stringOption(input?.hook_event_name) ?? stringOption(input?.hookEventName);
  const sessionId = stringOption(input?.session_id) ?? stringOption(input?.sessionId);
  const cwd = stringOption(input?.cwd);
  const prompt = promptText(input?.prompt);
  if (!event || !sessionId) return {};

  const statePath = options.statePath
    ?? kimiCorrelationStatePath(options.memoraxCodeHome ?? process.env.MEMORAX_CODE_HOME);
  if (event === "UserPromptSubmit") {
    if (!prompt) return {};
    await flushCompletedTurns({ sessionId, cwd, statePath }, options);
    const correlation = rememberKimiPrompt({ statePath, sessionId, prompt });
    const response = await postTurnStart({
      sessionId,
      cwd,
      prompt,
      promptId: correlation?.promptHash,
    }, options);
    const reminder = await evaluateMemorySkillReminder(kimiReminderOptions(options), {
      ...input,
      hook_event_name: "UserPromptSubmit",
      prompt_id: correlation?.reminderId ?? correlation?.promptHash,
    });
    if (reminder?.reminder) await postSkillReminder(reminder.reminder, correlation?.promptHash, options);
    const additionalContext = [
      stringOption(response?.additionalContext),
      stringOption(reminder?.additionalContext),
    ].filter(Boolean).join("\n\n");
    return additionalContext ? { additionalContext } : {};
  }

  if (event === "TurnStarted") {
    const turnId = idOption(input?.turn_id) ?? idOption(input?.turnId);
    if (!prompt || !turnId) return {};
    return {
      correlation: attachKimiTurnId({ statePath, sessionId, prompt, turnId }),
    };
  }
  if (event === "SessionHeartbeat" || event === "SessionEnd" || event === "Interrupt") {
    await flushCompletedTurns({ sessionId, cwd, statePath }, options);
  }
  if (event === "PostCompact") {
    markSupplementalReminderForSession(kimiReminderOptions(options), sessionId);
  }
  return {};
}

function kimiReminderOptions(options) {
  return {
    memoraxCodeHome: options.memoraxCodeHome ?? process.env.MEMORAX_CODE_HOME,
    adapterDir: "kimi",
    runtime: "kimi",
    debugEnv: "MEMORAX_CODE_KIMI_HOOK_DEBUG",
    memorySkillInvocation: "/memorax-code",
    remindOnFirstTurn: true,
    supplementalReminderAfterCompact: true,
    additionalReminderContext: personalMemoryReminderContext("/memorax-code"),
    buildCadenceReminderContext(input) {
      return buildRepoProcedureMemoryContext(input, {
        adapterDir: "kimi",
        sessionKeyPrefix: "kimi",
        debugEnv: "MEMORAX_CODE_KIMI_HOOK_DEBUG",
      });
    },
    buildPersonalMemoryContext(input) {
      return buildRepoUserProfilePreferencesContext(input, {
        adapterDir: "kimi",
        sessionKeyPrefix: "kimi",
        debugEnv: "MEMORAX_CODE_KIMI_HOOK_DEBUG",
      });
    },
  };
}

async function postSkillReminder(reminder, fallbackPromptId, options) {
  // The reminder evaluator uses a local per-submission key for deduplication;
  // the Backend command must retain the content hash used by wire validation.
  const promptId = stringOption(fallbackPromptId);
  if (!promptId || !stringOption(reminder?.content)) return;
  try {
    await postBackend("/memory/skill-reminder", {
      version: 1,
      client: "kimi",
      sessionId: reminder.sessionId,
      promptId,
      content: reminder.content,
      triggers: reminder.triggers,
      ...(reminder.cwd ? { cwd: reminder.cwd } : {}),
      ...(reminder.workspaceKind ? { workspaceKind: reminder.workspaceKind } : {}),
    }, options, 1_000);
  } catch (error) {
    if ((options.env ?? process.env).MEMORAX_CODE_KIMI_HOOK_DEBUG === "1") {
      console.error(error instanceof Error ? error.message : String(error));
    }
  }
}

async function flushCompletedTurns(input, options) {
  const pending = pendingKimiTurns(input);
  if (!pending.length) return;
  const wirePath = await resolveKimiWirePath(input.sessionId, options);
  if (!wirePath) return;
  await Promise.all(pending.map(async (turn) => {
    const response = await postBackend("/memory/writeback", {
      version: 1,
      client: "kimi",
      sessionId: input.sessionId,
      promptId: turn.promptHash,
      turnId: turn.turnId,
      wirePath,
      ...(input.cwd ? { cwd: input.cwd } : {}),
    }, options, 5_000);
    if (response?.scheduled === true || [
      "assistant_message_missing",
      "cancelled",
      "malformed_record",
      "prompt_identity_mismatch",
      "wire_identity_mismatch",
    ].includes(response?.reason)) {
      consumeKimiTurn({
        statePath: input.statePath,
        sessionId: input.sessionId,
        promptHash: turn.promptHash,
        turnId: turn.turnId,
      });
    }
  }));
}

async function postTurnStart(body, options) {
  if (!body.promptId) return undefined;
  return await postBackend("/memory/turn-start", {
    version: 1,
    client: "kimi",
    sessionId: body.sessionId,
    promptId: body.promptId,
    prompt: body.prompt,
    ...(body.cwd ? { cwd: body.cwd } : {}),
  }, options, TURN_START_TIMEOUT_MS);
}

async function postBackend(path, body, options, fallbackTimeoutMs) {
  const connection = resolveBackendConnection({
    backendUrl: options.backendUrl,
    backendToken: options.backendToken,
    memoraxCodeHome: options.memoraxCodeHome,
    env: options.env,
  });
  const timeoutMs = positiveInteger(options.timeoutMs, fallbackTimeoutMs);
  const headers = { "content-type": "application/json", connection: "close" };
  if (connection.token) headers["x-memorax-code-backend-token"] = connection.token;
  const response = await (options.fetchImpl ?? fetch)(new URL(path, connection.url), {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) return undefined;
  return await response.json().catch(() => undefined);
}

async function resolveKimiWirePath(sessionId, options) {
  try {
    const env = options.env ?? process.env;
    const kimiCodeHome = options.kimiCodeHome
      ?? env.KIMI_CODE_HOME
      ?? join(homedir(), ".kimi-code");
    const sessionsRoot = await realpath(join(kimiCodeHome, "sessions"));
    const lines = (await readFile(join(kimiCodeHome, "session_index.jsonl"), "utf8")).split("\n");
    let match;
    for (const line of lines) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (entry?.sessionId === sessionId && typeof entry.sessionDir === "string") match = entry;
    }
    if (!match || !isAbsolute(match.sessionDir) || basename(match.sessionDir) !== sessionId) return undefined;
    const sessionDir = await realpath(match.sessionDir);
    const sessionRelative = relative(sessionsRoot, sessionDir);
    if (!sessionRelative || sessionRelative.startsWith("..") || isAbsolute(sessionRelative)) return undefined;
    const wirePath = await realpath(join(sessionDir, "agents", "main", "wire.jsonl"));
    return relative(sessionDir, wirePath) === join("agents", "main", "wire.jsonl")
      ? wirePath
      : undefined;
  } catch {
    return undefined;
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function idOption(value) {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : typeof value === "number" && Number.isSafeInteger(value)
      ? String(value)
      : undefined;
}

function promptText(value) {
  if (!Array.isArray(value)) return stringOption(value);
  return stringOption(value
    .filter((part) => part && typeof part === "object" && part.type === "text")
    .map((part) => part.text)
    .filter((text) => typeof text === "string")
    .join("\n"));
}

async function main() {
  try {
    const result = await runKimiHook(await readStdinJson());
    if (result.additionalContext) process.stdout.write(`${result.additionalContext}\n`);
  } catch (error) {
    if (process.env.MEMORAX_CODE_KIMI_HOOK_DEBUG === "1") {
      console.error(error instanceof Error ? error.message : String(error));
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
