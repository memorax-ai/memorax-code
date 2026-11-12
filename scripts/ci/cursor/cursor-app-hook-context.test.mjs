import assert from "node:assert/strict";
import test from "node:test";
import { collectCursorAppSkillHookContext, projectCursorAppSkillHookContext, classifyCursorAppTraceMarker,
  collectCursorAppSessionContext, projectCursorAppSessionContext } from "./cursor-app-hook-context.mjs";

const sessionId = "11111111-1111-4111-8111-111111111111";
const otherSessionId = "22222222-2222-4222-8222-222222222222";
const context = (session = sessionId) => "For every memorax-cli invocation, explicitly set MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT=cursor and MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID=" + session + " in that command's environment.";
const source = {
  initial: (text) => ({ inputRequestContext: { hooksAdditionalContext: text } }),
  fresh: (text) => ({ requestContext: { hooksAdditionalContext: text } }),
  dynamic: (text) => ({ requestContextParts: { dynamicContext: { hooksAdditionalContext: text } } }),
  user: (text) => ({ userHookAdditionalContexts: [{ hookEventName: "sessionStart", content: text }] }),
  exec: (text) => ({ execHookAdditionalContexts: [{ hookEventName: "sessionStart", content: text }] }),
};

test("Skill context accepts each native source without requiring refreshed context to repeat it", () => {
  for (const [name, fields] of Object.entries(source)) {
    const run = { conversationId: sessionId, turnRefs: [], requestContext: { hooksAdditionalContext: "" }, ...fields(context()) };
    const result = collectCursorAppSkillHookContext({ run, runs: [run] });
    assert.equal(result.matched, true, name);
    assert.deepEqual(result.current[name], { present: true, matched: true });
    assert.equal(Object.values(result.history).some((value) => value.present), false);
  }
});

test("only completed same-session history referenced by the current Turn can supply context", () => {
  const turnBlobId = Buffer.from("synthetic-native-turn");
  for (const mode of ["referenced", "foreign-session", "unreferenced", "incomplete", "non-buffer-reference"]) {
    const run = { conversationId: sessionId, turnRefs: mode === "unreferenced" ? []
      : [mode === "non-buffer-reference" ? { equals: () => true } : turnBlobId] };
    const previous = { conversationId: mode === "foreign-session" ? otherSessionId : sessionId,
      completed: mode !== "incomplete", turnBlobId, ...source.initial(context()), ...source.exec(context()) };
    const result = collectCursorAppSkillHookContext({ run, runs: [previous, run] });
    assert.equal(result.matched, mode === "referenced", mode);
    assert.equal(result.history.initial.present, mode === "referenced", mode);
    assert.equal(result.history.exec.matched, mode === "referenced", mode);
  }
});

test("markers must name the exact current session and Cursor trace client", () => {
  for (const text of [context(otherSessionId), context(sessionId + "-other"), context(sessionId + "0"),
    context().replace("TRACE_CLIENT=cursor", "TRACE_CLIENT=codex"),
    context().replace("MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT", "OTHER_MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT")]) {
    for (const fields of Object.values(source)) {
      const run = { conversationId: sessionId, ...fields(text) };
      assert.equal(collectCursorAppSkillHookContext({ run, runs: [run] }).matched, false);
    }
  }
});

test("context diagnostics contain only fixed boolean projections", () => {
  const secret = "private-content-path-token-canary";
  const run = { conversationId: sessionId, ...source.initial(context() + " " + secret), ...source.fresh(secret),
    userHookAdditionalContexts: [{ content: secret }, { content: null }], execHookAdditionalContexts: secret };
  const result = collectCursorAppSkillHookContext({ run, runs: [run] });
  assert.deepEqual(result.current.initial, { present: true, matched: true });
  assert.deepEqual(result.current.fresh, { present: true, matched: false });
  assert.deepEqual(projectCursorAppSkillHookContext({ ...result, secret }), result);
  const forged = projectCursorAppSkillHookContext({ matched: true, current: {
    initial: { present: secret, matched: true, content: secret }, fresh: { present: true, matched: secret },
  }, history: { exec: { present: false, matched: true } }, extra: secret });
  assert.equal(forged.matched, false);
  for (const value of [result, forged, collectCursorAppSkillHookContext()]) {
    for (const group of [value.current, value.history]) {
      assert.deepEqual(Object.keys(group), ["initial", "fresh", "dynamic", "user", "exec"]);
      for (const state of Object.values(group)) {
        assert.deepEqual(Object.keys(state), ["present", "matched"]);
        assert.equal(typeof state.present, "boolean");
        assert.equal(typeof state.matched, "boolean");
      }
    }
    assert.equal(JSON.stringify(value).includes(secret), false);
    assert.equal(JSON.stringify(value).includes(sessionId), false);
  }
});

const posix = (session = sessionId) => `env MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT=cursor MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID=${session} memorax-cli search`;

test("trace markers are own, foreign, unrecognized by the strict matcher, none or absent", () => {
  for (const [text, kind] of [[context(), "own"], [context(otherSessionId), "foreign"], [context(otherSessionId) + context(), "own"],
    [posix(), "unrecognized"], [context().replace("TRACE_CLIENT=cursor", "TRACE_CLIENT=codex"), "unrecognized"],
    ["Use memorax-cli for coding memory.", "none"], ["", "absent"], [undefined, "absent"], [{ content: context() }, "absent"]]) {
    assert.equal(classifyCursorAppTraceMarker(text, sessionId).kind, kind, String(text));
  }
  // The strict class agrees with the existing Skill context matcher.
  for (const text of [context(), context(otherSessionId), posix()]) {
    const run = { conversationId: sessionId, ...source.initial(text) };
    assert.equal(collectCursorAppSkillHookContext({ run, runs: [run] }).matched, classifyCursorAppTraceMarker(text, sessionId).kind === "own");
  }
});

test("session context lists marker classes per source and names other sessions only by role", () => {
  const child = "33333333-3333-4333-8333-333333333333", unknown = "44444444-4444-4444-8444-444444444444";
  const roles = new Map([[sessionId, "S1"], [otherSessionId, "S2"], [child, "S2-child"]]);
  const runs = [
    { conversationId: sessionId, ...source.initial(context(otherSessionId)), ...source.fresh(context()), ...source.user("plain context") },
    { conversationId: sessionId, ...source.dynamic(context(child) + context(unknown)), ...source.exec(posix()) },
    { conversationId: otherSessionId, ...source.initial(context()) }];
  const result = collectCursorAppSessionContext({ runs, sessionId, roleOf: (id) => roles.get(id) ?? "other" });
  assert.deepEqual(result, { runs: 2, ownRuns: 1, own: ["fresh"], foreign: ["initial", "dynamic"], unrecognized: ["exec"],
    none: ["user"], foreignRoles: ["S2", "S2-child", "other"] });
  assert.deepEqual(projectCursorAppSessionContext(result), result);
  for (const value of [sessionId, otherSessionId, child, unknown, "plain context"]) assert.equal(JSON.stringify(result).includes(value), false);
  const empty = { runs: 0, ownRuns: 0, own: [], foreign: [], unrecognized: [], none: [], foreignRoles: [] };
  assert.deepEqual(collectCursorAppSessionContext({ runs, sessionId: undefined }), empty);
  assert.deepEqual(collectCursorAppSessionContext({ runs: context(), sessionId }), empty);
  assert.deepEqual(projectCursorAppSessionContext({ runs: -1, ownRuns: 4097, own: [context(), "initial", "initial"], foreignRoles: [sessionId, "S7", "S1"] }),
    { ...empty, own: ["initial"], foreignRoles: ["S1"] });
});
