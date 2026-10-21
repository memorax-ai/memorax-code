import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { isAbsolute, join, win32 } from "node:path";

const steps = ["sessionStart", "beforeSubmitPrompt", "preCompact", "afterAgentResponse", "stop"];
const statuses = ["present", "absent", "invalid", "unsafe", "oversized", "unavailable"];
const filterReasons = ["parse", "event", "session", "generation"];
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const maxBytes = 2 * 1024 * 1024, maxFiles = 16, maxExecutions = 32, maxExecutionBlocks = 4096;
const directories = [/^logs$/, /^\d{8}T\d{6}$/, /^window\d+(?:_wb\d+)?$/, /^output_\d{8}T\d{6}$/];
const filename = /^cursor\.hooks(?:\.workspaceId-[a-zA-Z0-9_-]{1,128})?\.log$/;
const record = (value) => Boolean(value && typeof value === "object" && !Array.isArray(value));
const count = (value, maximum) => Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : 0;
const choice = (value, values, fallback) => values.includes(value) ? value : fallback;
const executionBlock = /(?:^|\n)\u2550{87}\n(\w+)\n\u2550{87}\nCommand: ([^\n]+) \(\d+ms\) exit code: (\d+|N\/A)\n\nINPUT:\n([\s\S]*?)\n\nOUTPUT:\n([\s\S]*?)\n\u2550{87}(?=\n|$)/g;
const elapsed = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 1800000 ? value : null;

export function projectCursorAppHookDiagnostics(value) {
  return {
    readStatus: choice(value?.readStatus, statuses, "unavailable"), filesRead: count(value?.filesRead, maxFiles),
    // Request lines have no native identity; they are never evidence for this Turn.
    unscopedRequests: Object.fromEntries(steps.map((step) => [step, count(value?.unscopedRequests?.[step], 4096)])),
    // Only complete, marker-owned blocks enter these counts, before identity filtering.
    ownedExecutionBlocks: Object.fromEntries(steps.map((step) => [step, count(value?.ownedExecutionBlocks?.[step], maxExecutionBlocks)])),
    filteredExecutionBlocks: Object.fromEntries(steps.map((step) => [step, Object.fromEntries(filterReasons
      .map((reason) => [reason, count(value?.filteredExecutionBlocks?.[step]?.[reason], maxExecutionBlocks)]))])),
    executions: (Array.isArray(value?.executions) ? value.executions.slice(0, maxExecutions) : [])
      .filter((item) => record(item) && steps.includes(item.step) && ["turn", "session"].includes(item.scope))
      .map((item) => ({
        step: item.step, scope: item.scope,
        generation: choice(item.generation, ["matched", "absent", "invalid"], "invalid"),
        sessionAliasMatched: item.sessionAliasMatched === true,
        workspaceKind: choice(item.workspaceKind, ["single", "projectless", "invalid"], "invalid"),
        promptKind: choice(item.promptKind, ["string", "absent", "other"], "other"),
        exitCode: Number.isInteger(item.exitCode) && item.exitCode >= 0 && item.exitCode <= 0xffff_ffff ? item.exitCode : null,
        responseKind: choice(item.responseKind, ["empty", "json", "invalid"], "invalid"),
        continue: choice(item.continue, ["allow", "deny", "absent"], "absent"),
        additionalContextPresent: item.additionalContextPresent === true, stderrPresent: item.stderrPresent === true,
      })),
  };
}

function ownedCommand(command) {
  const encoded = /(?:^|\s)-EncodedCommand\s+([A-Za-z0-9+/]+={0,2})\s*$/.exec(command)?.[1];
  const text = encoded && encoded.length % 4 === 0 ? Buffer.from(encoded, "base64").toString("utf16le") : command;
  return text.includes("--memorax-code-cursor-hook-v1");
}

function collectLog(text, sessionId, turnId, result, observe, sessionOnly = false) {
  text = text.replaceAll("\r\n", "\n");
  for (const match of text.matchAll(/^\[[0-9T:.Z-]+\] Hook step requested: (\w+)$/gm)) {
    if (steps.includes(match[1]) && (!sessionOnly || match[1] === "sessionStart")) {
      if (result.unscopedRequests[match[1]] >= 4096) throw "oversized";
      result.unscopedRequests[match[1]] += 1;
    }
  }
  // Cursor's Hooks output channel frames INPUT/OUTPUT JSON with 87 double rules.
  let ownedBlocks = steps.reduce((total, step) => total + result.ownedExecutionBlocks[step], 0);
  for (const match of text.matchAll(executionBlock)) {
    const [, step, command, exit, input, output] = match;
    if (!steps.includes(step) || !ownedCommand(command) || sessionOnly && step !== "sessionStart") continue;
    if (ownedBlocks >= maxExecutionBlocks) throw "oversized";
    ownedBlocks += 1;
    result.ownedExecutionBlocks[step] += 1;
    const filtered = result.filteredExecutionBlocks[step];
    let request;
    try { request = JSON.parse(input); } catch { filtered.parse += 1; continue; }
    if (!record(request)) { filtered.parse += 1; continue; }
    if (request.hook_event_name !== step) { filtered.event += 1; continue; }
    if ((request.conversation_id ?? request.session_id) !== sessionId) { filtered.session += 1; continue; }
    const generation = request.generation_id === undefined ? "absent"
      : typeof request.generation_id === "string" && uuid.test(request.generation_id) ? "matched" : "invalid";
    if (generation === "matched" && request.generation_id !== turnId) { filtered.generation += 1; continue; }
    const split = output.indexOf("\n\nSTDERR:\n"), responseText = split < 0 ? output : output.slice(0, split);
    let response, responseKind = responseText === "(empty)" ? "empty" : "invalid";
    if (responseKind !== "empty") {
      try { response = JSON.parse(responseText); if (record(response)) responseKind = "json"; } catch {}
    }
    const roots = request.workspace_roots;
    result.executions.push({ step, scope: generation === "matched" ? "turn" : "session", generation,
      sessionAliasMatched: request.session_id === undefined || request.session_id === sessionId,
      workspaceKind: Array.isArray(roots) && roots.length === 0 ? "projectless"
        : Array.isArray(roots) && roots.length === 1 && typeof roots[0] === "string"
          && !/[\0\r\n]/.test(roots[0]) && (isAbsolute(roots[0]) || win32.isAbsolute(roots[0])) ? "single" : "invalid",
      promptKind: typeof request.prompt === "string" ? "string" : request.prompt === undefined ? "absent" : "other",
      exitCode: exit === "N/A" ? null : Number(exit), responseKind,
      continue: response?.continue === true ? "allow" : response?.continue === false ? "deny" : "absent",
      additionalContextPresent: typeof response?.additional_context === "string" && response.additional_context.length > 0,
      stderrPresent: split >= 0 && output.slice(split + "\n\nSTDERR:\n".length).trim().length > 0 });
    observe?.(request, response, result.executions.at(-1));
    if (result.executions.length > maxExecutions) throw "oversized";
  }
}

async function readHookLogs(home, consume) {
  const result = { readStatus: "absent", filesRead: 0 };
  if (typeof home !== "string" || !isAbsolute(home) || /[\0\r\n]/.test(home)) return { ...result, readStatus: "invalid" };
  let bytes = 0, entries = 0;
  async function walk(path, depth) {
    const before = await lstat(path);
    if (before.isSymbolicLink() || !before.isDirectory()) throw "unsafe";
    for await (const entry of await opendir(path)) {
      if (++entries > 512) throw "oversized";
      if (depth < directories.length) {
        if (directories[depth].test(entry.name)) await walk(join(path, entry.name), depth + 1);
      } else if (filename.test(entry.name)) {
        if (result.filesRead >= maxFiles) throw "oversized";
        const filePath = join(path, entry.name), info = await lstat(filePath);
        if (info.isSymbolicLink() || !info.isFile()) throw "unsafe";
        if ((bytes += info.size) > maxBytes) throw "oversized";
        const file = await open(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
        try {
          const opened = await file.stat();
          if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size) throw "unsafe";
          const buffer = Buffer.alloc(info.size);
          let position = 0;
          while (position < buffer.length) {
            const { bytesRead } = await file.read(buffer, position, buffer.length - position, position);
            if (!bytesRead) throw "unavailable";
            position += bytesRead;
          }
          let text;
          try { text = new TextDecoder("utf-8", { fatal: true }).decode(buffer); } catch { throw "invalid"; }
          result.filesRead += 1;
          result.readStatus = "present";
          consume(text);
        } finally { await file.close(); }
      }
    }
    const after = await lstat(path);
    if (after.isSymbolicLink() || after.dev !== before.dev || after.ino !== before.ino) throw "unsafe";
  }
  try { await walk(home, 0); }
  catch (error) { result.readStatus = statuses.includes(error) ? error : error?.code === "ENOENT" ? "absent" : "unavailable"; }
  return result;
}

export async function collectCursorAppHookDiagnostics({ home, sessionId, turnId } = {}) {
  const result = projectCursorAppHookDiagnostics();
  if (typeof sessionId !== "string" || sessionId.length !== 36 || !uuid.test(sessionId)
    || typeof turnId !== "string" || turnId.length !== 36 || !uuid.test(turnId)) {
    return projectCursorAppHookDiagnostics({ readStatus: "invalid" });
  }
  Object.assign(result, await readHookLogs(home, (text) => collectLog(text, sessionId, turnId, result)));
  return projectCursorAppHookDiagnostics(result);
}

export function projectCursorAppHookTiming(value) {
  return {
    phase: choice(value?.phase, ["config", "session", "turn"], "config"),
    appLaunch: count(value?.appLaunch, 16),
    runIndex: Number.isSafeInteger(value?.runIndex) && value.runIndex >= 0 && value.runIndex <= 64 ? value.runIndex : null,
    resumedSession: value?.resumedSession === true,
    readStatus: choice(value?.readStatus, statuses, "unavailable"), currentLogFiles: count(value?.currentLogFiles, maxFiles),
    requiredUserHooksLoaded: value?.requiredUserHooksLoaded === true, sessionStartReady: value?.sessionStartReady === true,
    counts: Object.fromEntries(["reload", "userConfigLoad", "beforeSubmitRequest", "beforeSubmitExecution"]
      .map((key) => [key, count(value?.counts?.[key], maxExecutionBlocks)])),
    nativeLogMs: Object.fromEntries(["firstReload", "lastReload", "lastRequiredUserConfigLoad", "lastBeforeSubmitRequest"]
      .map((key) => [key, elapsed(value?.nativeLogMs?.[key])])),
    // Execution blocks have no timestamps. These fields are CI observation times, not native event times.
    observedMs: Object.fromEntries(["sessionStartReady", "submit", "modelRequest", "turnStart"]
      .map((key) => [key, elapsed(value?.observedMs?.[key])])),
  };
}

export async function collectCursorAppHookTiming({ home, startedAt, sessionId, turnId } = {}) {
  const result = projectCursorAppHookTiming();
  if (!Number.isSafeInteger(startedAt) || startedAt < 0
    || (sessionId !== undefined && (typeof sessionId !== "string" || !uuid.test(sessionId)))
    || (turnId !== undefined && (typeof turnId !== "string" || !uuid.test(turnId)))) {
    return projectCursorAppHookTiming({ readStatus: "invalid" });
  }
  function increment(key) { if (++result.counts[key] > maxExecutionBlocks) throw "oversized"; }
  const status = await readHookLogs(home, (raw) => {
    const current = currentLaunchLog(raw, startedAt);
    if (!current) return;
    result.currentLogFiles += 1;
    let loaded = false;
    for (const match of current.lines) {
      const milliseconds = elapsed(Date.parse(match[1]) - startedAt);
      if (milliseconds === null || Date.parse(match[1]) > Date.now()) continue;
      if (match[2] === "Reloading hooks configuration...") {
        increment("reload"); loaded = false;
        result.nativeLogMs.firstReload ??= milliseconds; result.nativeLogMs.lastReload = milliseconds;
      }
      const load = /^Loaded (\d+) user hook\(s\) for steps: ([A-Za-z0-9_, ]+)$/.exec(match[2]);
      if (load) {
        increment("userConfigLoad");
        const configured = new Set(load[2].split(", "));
        loaded = Number(load[1]) >= steps.length && Number(load[1]) <= maxExecutionBlocks
          && steps.every((step) => configured.has(step));
        if (loaded) result.nativeLogMs.lastRequiredUserConfigLoad = milliseconds;
      }
      if (/^(?:No user hooks configuration found|ERROR: (?:Failed to parse user hooks configuration|Error accessing user config file|Error loading Cursor disk hooks|Error loading hooks from config))/.test(match[2])) loaded = false;
      // Native request lines are unscoped; only execution blocks below bind a request to this Turn.
      if (match[2] === "Hook step requested: beforeSubmitPrompt") {
        increment("beforeSubmitRequest"); result.nativeLogMs.lastBeforeSubmitRequest = milliseconds;
      }
    }
    result.requiredUserHooksLoaded = loaded;
    if (sessionId) {
      const diagnostic = projectCursorAppHookDiagnostics();
      collectLog(current.text, sessionId, turnId, diagnostic, (request, response, execution) => {
        if (execution.step === "beforeSubmitPrompt" && execution.scope === "turn") increment("beforeSubmitExecution");
        if (execution.step === "sessionStart" && execution.scope === "session" && execution.sessionAliasMatched
          && (request.generation_id === undefined || request.generation_id === "") && execution.exitCode === 0
          && execution.responseKind === "json" && execution.continue !== "deny" && execution.workspaceKind === "single"
          && sessionTraceContextMatched(response, sessionId)) result.sessionStartReady = true;
      });
    }
  });
  result.readStatus = status.readStatus;
  if (status.readStatus !== "present" || result.currentLogFiles !== 1) {
    result.requiredUserHooksLoaded = false; result.sessionStartReady = false;
  }
  return projectCursorAppHookTiming(result);
}

// Use the same current-launch framing rules for readiness and failure evidence.
function currentLaunchLog(raw, startedAt) {
  const text = raw.replaceAll("\r\n", "\n");
  const unframed = text.replace(executionBlock, ""), partial = unframed.indexOf("\u2550".repeat(87));
  const metadata = partial < 0 ? unframed : unframed.slice(0, partial);
  const lines = [...metadata.matchAll(/^\[([0-9T:.Z-]+)\] ([^\n]+)$/gm)];
  const initial = lines.findIndex((match) => match[2] === "Initializing Cursor Hooks Service..."
    && Number.isFinite(Date.parse(match[1])) && Date.parse(match[1]) >= startedAt
    && Date.parse(match[1]) <= Date.now());
  if (initial < 0) return undefined;
  if (partial >= 0 || !text.endsWith("\n")) throw "invalid";
  return { text: text.slice(text.indexOf(lines[initial][0])), lines: lines.slice(initial) };
}

function sessionTraceContextMatched(response, sessionId) {
  return typeof response?.additional_context === "string"
    && [...response.additional_context.matchAll(/(?:^|[^A-Za-z0-9_])MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT=cursor and MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID=([A-Za-z0-9_-]+)/g)]
      .some((match) => match[1] === sessionId);
}

export function projectCursorAppSessionHookDiagnostics(value) {
  const executions = (Array.isArray(value?.executions) ? value.executions.slice(0, maxExecutions) : [])
    .filter((item) => record(item) && item.step === "sessionStart" && item.scope === "session");
  return {
    readStatus: choice(value?.readStatus, statuses, "unavailable"), filesRead: count(value?.filesRead, maxFiles),
    currentLogFiles: count(value?.currentLogFiles, maxFiles),
    unscopedRequests: count(value?.unscopedRequests, 4096),
    ownedExecutionBlocks: count(value?.ownedExecutionBlocks, maxExecutionBlocks),
    filteredExecutionBlocks: Object.fromEntries(filterReasons.map((reason) =>
      [reason, count(value?.filteredExecutionBlocks?.[reason], maxExecutionBlocks)])),
    executions: executions.map((item) => ({ ...projectCursorAppHookDiagnostics({ executions: [item] }).executions[0],
      generationAllowed: item.generationAllowed === true, traceContextMatched: item.traceContextMatched === true })),
  };
}

export async function collectCursorAppSessionHookDiagnostics({ home, startedAt, sessionId } = {}) {
  const result = { ...projectCursorAppHookDiagnostics(), currentLogFiles: 0 };
  if (!Number.isSafeInteger(startedAt) || startedAt < 0 || typeof sessionId !== "string" || !uuid.test(sessionId)) {
    return projectCursorAppSessionHookDiagnostics({ readStatus: "invalid" });
  }
  const status = await readHookLogs(home, (raw) => {
    const current = currentLaunchLog(raw, startedAt);
    if (!current) return;
    result.currentLogFiles += 1;
    // An absent turn is intentional: only this explicit SessionStart identity is observed.
    collectLog(current.text, sessionId, undefined, result, (request, response, execution) => {
      execution.generationAllowed = request.generation_id === undefined || request.generation_id === "";
      execution.traceContextMatched = sessionTraceContextMatched(response, sessionId);
    }, true);
  });
  return projectCursorAppSessionHookDiagnostics({ ...result, ...status,
    unscopedRequests: result.unscopedRequests.sessionStart, ownedExecutionBlocks: result.ownedExecutionBlocks.sessionStart,
    filteredExecutionBlocks: result.filteredExecutionBlocks.sessionStart });
}

export function projectCursorAppHookReadinessFailure(value) {
  return {
    phase: choice(value?.phase, ["config", "session"], "config"), appLaunch: count(value?.appLaunch, 16),
    code: /^CURSOR_(?:APP|AGENT|MOCK)_[A-Z0-9_]{1,100}$/.test(value?.code ?? "") ? value.code : "CURSOR_APP_CHECK_FAILED",
    timeoutKind: choice(value?.timeoutKind, ["none", "predicate", "overall"], "none"),
    waitElapsedMs: elapsed(value?.waitElapsedMs), lastObservationElapsedMs: elapsed(value?.lastObservationElapsedMs),
    observationPending: value?.observationPending === true,
    lastObservation: record(value?.lastObservation) ? projectCursorAppHookTiming(value.lastObservation) : null,
    sessionDiagnosticsStatus: choice(value?.sessionDiagnosticsStatus, ["not-requested", "completed", "timeout", "failed"], "not-requested"),
    sessionStart: projectCursorAppSessionHookDiagnostics(value?.sessionStart),
  };
}
