import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { collectCursorAppHookDiagnostics, projectCursorAppHookDiagnostics } from "./cursor-app-hook-diagnostics.mjs";

const secret = "PRIVATE_PROMPT_PATH_EMAIL_TOKEN_CANARY";
const rule = "\u2550".repeat(87), command = `node /${secret}/runtime-hook.mjs --memorax-code-cursor-hook-v1`;
function execution(request, { output = { continue: true }, cmd = command, exit = 0, stderr = secret } = {}) {
  return [rule, request.hook_event_name, rule, `Command: ${cmd} (42ms) exit code: ${exit}`, "", "INPUT:",
    JSON.stringify(request, null, 2), "", "OUTPUT:", output === null ? "(empty)" : JSON.stringify(output, null, 2),
    "", "STDERR:", stderr, rule, ""].join("\n");
}
async function fixture(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "cursor-hook-diagnostic-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const sessionId = randomUUID(), turnId = randomUUID();
  const log = join(home, "logs/20261009T120000/window1/output_20261009T120001/cursor.hooks.workspaceId-fixture.log");
  await mkdir(dirname(log), { recursive: true });
  const request = { hook_event_name: "beforeSubmitPrompt", conversation_id: sessionId, session_id: sessionId,
    generation_id: turnId, workspace_roots: [home], prompt: secret, user_email: secret };
  return { home, sessionId, turnId, log, request, collect: () => collectCursorAppHookDiagnostics({ home, sessionId, turnId }) };
}

test("native Hook blocks bind owned executions to exact session/turn and retain only fixed projections", async (t) => {
  const f = await fixture(t);
  const log = `[2026-10-09T12:00:00.000Z] Hook step requested: beforeSubmitPrompt\n`
    + execution(f.request)
    + execution({ ...f.request, generation_id: randomUUID() })
    + execution({ ...f.request, conversation_id: randomUUID() })
    + execution(f.request, { cmd: `node /${secret}/another-hook.mjs` })
    + execution({ ...f.request, hook_event_name: "stop", prompt: undefined }, { output: null });
  await writeFile(f.log, log.replaceAll("\n", "\r\n"));
  const result = await f.collect();
  assert.equal(result.readStatus, "present");
  assert.equal(result.filesRead, 1);
  assert.equal(result.unscopedRequests.beforeSubmitPrompt, 1);
  assert.deepEqual(result.executions.map(({ step, scope }) => ({ step, scope })),
    [{ step: "beforeSubmitPrompt", scope: "turn" }, { step: "stop", scope: "turn" }]);
  assert.deepEqual(result.executions[0], { step: "beforeSubmitPrompt", scope: "turn", generation: "matched",
    sessionAliasMatched: true, workspaceKind: "single", promptKind: "string", exitCode: 0, responseKind: "json",
    continue: "allow", additionalContextPresent: false, stderrPresent: true });
  assert.equal(result.executions[1].responseKind, "empty");
  assert.deepEqual(projectCursorAppHookDiagnostics(result), result);
  for (const privateValue of [secret, f.home, f.sessionId, f.turnId]) assert.ok(!JSON.stringify(result).includes(privateValue));
  assert.equal(await readFile(f.log, "utf8"), log.replaceAll("\n", "\r\n"));
});

test("missing native identities stay session-scoped; Windows commands and failed executions remain observable", async (t) => {
  const f = await fixture(t), windows = `powershell -EncodedCommand ${Buffer.from(command, "utf16le").toString("base64")}`;
  await writeFile(f.log, execution({ ...f.request, generation_id: undefined, session_id: "conflicting",
    workspace_roots: ["relative"], prompt: undefined }, { cmd: windows, output: null, exit: 1 })
    + execution({ ...f.request, hook_event_name: "sessionStart", generation_id: undefined, workspace_roots: [] },
      { output: { additional_context: secret } })
    + execution({ ...f.request, generation_id: "not-an-id" }, { output: 1, exit: "N/A" }));
  const { executions } = await f.collect();
  assert.deepEqual(executions.map((item) => [item.scope, item.generation, item.exitCode]),
    [["session", "absent", 1], ["session", "absent", 0], ["session", "invalid", null]]);
  assert.equal(executions[0].sessionAliasMatched, false);
  assert.equal(executions[0].workspaceKind, "invalid");
  assert.equal(executions[0].promptKind, "absent");
  assert.equal(executions[1].additionalContextPresent, true);
  assert.equal(executions[2].responseKind, "invalid");
});

test("unbound, malformed and partial log text never manufactures execution evidence", async (t) => {
  const f = await fixture(t);
  for (const text of [secret, execution(f.request).replace('"prompt":', '"broken"'),
    execution(f.request).slice(0, -100), execution({ ...f.request, conversation_id: undefined, session_id: undefined })]) {
    await writeFile(f.log, text);
    assert.deepEqual((await f.collect()).executions, []);
  }
  const projected = projectCursorAppHookDiagnostics({ secret, readStatus: secret, filesRead: -1,
    unscopedRequests: { beforeSubmitPrompt: 99999 }, executions: [{ step: "stop", scope: "turn", exitCode: secret,
      responseKind: secret, additionalContextPresent: secret, stderrPresent: secret, raw: secret }] });
  assert.ok(!JSON.stringify(projected).includes(secret));
  assert.equal(projected.executions[0].exitCode, null);
});

test("reads are bounded and reject unsafe paths, malformed identities and invalid UTF-8", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.collect()).readStatus, "absent");
  for (const [data, expected] of [[Buffer.from([0xff]), "invalid"], [Buffer.alloc(2 * 1024 * 1024 + 1), "oversized"],
    [execution(f.request).repeat(33), "oversized"]]) {
    await writeFile(f.log, data);
    assert.equal((await f.collect()).readStatus, expected);
  }
  for (const patch of [{ home: "relative" }, { sessionId: "invalid" }, { turnId: `${f.turnId}\n` }]) {
    assert.equal((await collectCursorAppHookDiagnostics({ ...f, ...patch })).readStatus, "invalid");
  }
  if (process.platform !== "win32") {
    await rm(f.log);
    await symlink(join(f.home, "outside"), f.log);
    assert.equal((await f.collect()).readStatus, "unsafe");
    await rm(join(f.home, "logs"), { recursive: true });
    await symlink(f.home, join(f.home, "logs"));
    assert.equal((await f.collect()).readStatus, "unsafe");
  }
});

test("discovery stays in native output directories and bounds file count and total bytes", async (t) => {
  const f = await fixture(t), nested = join(dirname(f.log), "nested");
  await mkdir(nested);
  await writeFile(join(nested, "cursor.hooks.log"), execution(f.request));
  await writeFile(join(f.home, "cursor.hooks.log"), execution(f.request));
  assert.equal((await f.collect()).readStatus, "absent");
  for (let index = 0; index < 17; index++) {
    await writeFile(join(dirname(f.log), `cursor.hooks.workspaceId-${index}.log`), "");
  }
  assert.equal((await f.collect()).readStatus, "oversized");
  await rm(dirname(f.log), { recursive: true });
  await mkdir(dirname(f.log));
  for (const name of ["cursor.hooks.log", "cursor.hooks.workspaceId-extra.log"]) {
    await writeFile(join(dirname(f.log), name), Buffer.alloc(1024 * 1024 + 1, 32));
  }
  assert.equal((await f.collect()).readStatus, "oversized");
  await rm(join(f.home, "logs"), { recursive: true });
  for (let index = 0; index < 513; index++) await writeFile(join(f.home, `ignored-${index}`), "");
  assert.equal((await f.collect()).readStatus, "oversized");
});
