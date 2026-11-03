const sources = ["initial", "fresh", "dynamic", "user", "exec"];
const marker = /(?:^|[^A-Za-z0-9_])MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT=cursor and MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID=([A-Za-z0-9_-]+)/g;
// Sessions the check created, in order, then their subagents; any other native identity is "other".
export const cursorAppSessionRoles = [...[1, 2, 3, 4, 5, 6].flatMap((index) => [`S${index}`, `S${index}-child`]), "other"];

function projectSources(value) {
  return Object.fromEntries(sources.map((source) => [source, {
    present: value?.[source]?.present === true,
    matched: value?.[source]?.present === true && value?.[source]?.matched === true,
  }]));
}

export function projectCursorAppSkillHookContext(value) {
  const current = projectSources(value?.current), history = projectSources(value?.history);
  return { matched: [...Object.values(current), ...Object.values(history)].some((source) => source.matched), current, history };
}

function contents(run) {
  return {
    initial: [run?.inputRequestContext?.hooksAdditionalContext],
    fresh: [run?.requestContext?.hooksAdditionalContext],
    dynamic: [run?.requestContextParts?.dynamicContext?.hooksAdditionalContext],
    user: Array.isArray(run?.userHookAdditionalContexts) ? run.userHookAdditionalContexts.map((entry) => entry?.content) : [],
    exec: Array.isArray(run?.execHookAdditionalContexts) ? run.execHookAdditionalContexts.map((entry) => entry?.content) : [],
  };
}

function observe(result, run, sessionId) {
  const content = contents(run);
  for (const source of sources) {
    for (const text of content[source]) {
      if (typeof text !== "string" || !text.length) continue;
      result[source].present = true;
      if ([...text.matchAll(marker)].some((match) => match[1] === sessionId)) result[source].matched = true;
    }
  }
}

export function collectCursorAppSkillHookContext({ run, runs } = {}) {
  const result = projectCursorAppSkillHookContext();
  const sessionId = typeof run?.conversationId === "string" && run.conversationId ? run.conversationId : undefined;
  observe(result.current, run, sessionId);
  if (sessionId && Array.isArray(runs) && Array.isArray(run.turnRefs)) {
    for (const previous of runs) {
      if (previous === run || previous?.conversationId !== sessionId || previous.completed !== true
        || !Buffer.isBuffer(previous.turnBlobId)
        || !run.turnRefs.some((ref) => Buffer.isBuffer(ref) && ref.equals(previous.turnBlobId))) continue;
      observe(result.history, previous, sessionId);
    }
  }
  return projectCursorAppSkillHookContext(result);
}

// The strict matcher above decides "own" and "foreign"; text that names the variable without a strict
// match is "unrecognized", so a format change is not reported as a missing marker.
export function classifyCursorAppTraceMarker(text, sessionId) {
  if (typeof text !== "string" || !text.length) return { kind: "absent", sessions: [] };
  const sessions = [...text.matchAll(marker)].map((match) => match[1]);
  return { sessions, kind: sessions.includes(sessionId) ? "own" : sessions.length ? "foreign"
    : text.includes("MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID") ? "unrecognized" : "none" };
}

export function projectCursorAppSessionContext(value) {
  const count = (item) => Number.isSafeInteger(item) && item >= 0 && item <= 4096 ? item : 0;
  const known = (items, values) => values.filter((item) => Array.isArray(items) && items.includes(item));
  return { runs: count(value?.runs), ownRuns: count(value?.ownRuns),
    ...Object.fromEntries(["own", "foreign", "unrecognized", "none"].map((kind) => [kind, known(value?.[kind], sources)])),
    foreignRoles: known(value?.foreignRoles, cursorAppSessionRoles).slice(0, 3) };
}

// Lists the sources in which any run of the session carried each marker class.
export function collectCursorAppSessionContext({ runs, sessionId, roleOf } = {}) {
  const result = { runs: 0, ownRuns: 0, own: [], foreign: [], unrecognized: [], none: [], foreignRoles: [] };
  for (const run of Array.isArray(runs) && typeof sessionId === "string" ? runs : []) {
    if (run?.conversationId !== sessionId) continue;
    result.runs += 1;
    let own = false;
    const content = contents(run);
    for (const source of sources) {
      for (const text of content[source]) {
        const { kind, sessions } = classifyCursorAppTraceMarker(text, sessionId);
        const foreign = sessions.filter((id) => id !== sessionId);
        if (sessions.includes(sessionId)) { result.own.push(source); own = true; }
        if (foreign.length) result.foreign.push(source);
        if (["unrecognized", "none"].includes(kind)) result[kind].push(source);
        result.foreignRoles.push(...foreign.map((id) => roleOf?.(id) ?? "other"));
      }
    }
    if (own) result.ownRuns += 1;
  }
  return projectCursorAppSessionContext(result);
}
