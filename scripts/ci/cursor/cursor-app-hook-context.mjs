const sources = ["initial", "fresh", "dynamic", "user", "exec"];
const marker = /(?:^|[^A-Za-z0-9_])MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT=cursor and MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID=([A-Za-z0-9_-]+)/g;

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

function observe(result, run, sessionId) {
  const content = {
    initial: [run?.inputRequestContext?.hooksAdditionalContext],
    fresh: [run?.requestContext?.hooksAdditionalContext],
    dynamic: [run?.requestContextParts?.dynamicContext?.hooksAdditionalContext],
    user: Array.isArray(run?.userHookAdditionalContexts) ? run.userHookAdditionalContexts.map((entry) => entry?.content) : [],
    exec: Array.isArray(run?.execHookAdditionalContexts) ? run.execHookAdditionalContexts.map((entry) => entry?.content) : [],
  };
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
