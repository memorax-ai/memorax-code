import assert from "node:assert/strict";
import test from "node:test";
import { collectCursorAppSkillHookContext, projectCursorAppSkillHookContext } from "./cursor-app-hook-context.mjs";

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
