import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createClaudeMemoryHookRuntime } from "../../../dist/clients/claude/memory-hook-runtime.js";
import { createMemorySearchGuidanceRuntime } from "../../../dist/memory/search-guidance.js";
import { JEV_MODEL } from "../../../dist/provider/jev/adapter.js";

const unavailable = { ok: false, reason: "context_unavailable" };

function userRecord(overrides = {}) {
  return {
    type: "user", userType: "external", sessionId: "session", promptId: "prompt",
    uuid: "user-1", parentUuid: null, message: { role: "user", content: "Check the earlier implementation." },
    ...overrides,
  };
}

function jsonLines(...rows) {
  return rows.map(JSON.stringify).join("\n") + "\n";
}

async function fixture(t, { enabled = true, beforeResolve } = {}) {
  const root = await mkdtemp(join(tmpdir(), "memorax-claude-start-guidance-"));
  const transcriptPath = join(root, "session.jsonl");
  const requests = [], enqueued = [];
  const env = {
    MEMORAX_CODE_HOME: root, MEMORAX_CODE_CLAUDE_TRACE_ENABLED: "false",
    MEMORAX_CODE_JEV_ENABLED: String(enabled), MEMORAX_CODE_JEV_API_KEY: "synthetic-jev-key",
    MEMORAX_CODE_MEMORAX_API_KEY: "synthetic-memory-key", MEMORAX_CODE_MEMORAX_USER_ID: "fixture-user",
  };
  const scope = {
    schemaVersion: "workspace-memory-scope.v1", baseUserId: "fixture-user",
    effectiveUserId: "fixture-user@workspace", repositoryKey: "workspace", repositorySlug: "workspace",
    repositoryName: "workspace", identitySource: "workspace-directory", scopeKind: "local-directory",
    boundWorkspaceRoot: root,
  };
  const guidance = createMemorySearchGuidanceRuntime({
    env, memoraxCodeHome: root,
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return Response.json({ model: JEV_MODEL, answers: { search_needed: { type: "noul", noul: 0.8 } } });
    },
  });
  let time = 1;
  const runtime = createClaudeMemoryHookRuntime({
    env, memoraxCodeHome: root, searchGuidance: guidance, transcriptReadAttempts: 1,
    now: () => time++,
    repositoryMemorySession: { async resolve() {
      await beforeResolve?.(env);
      return { ok: true, memory: { config: {}, scope } };
    } },
    automaticWriteback(input) { enqueued.push(input); return { accepted: true }; },
  });
  const command = {
    version: 1, client: "claude-code", sessionId: "session", promptId: "prompt",
    prompt: userRecord().message.content, transcriptPath, cwd: root,
  };
  t.after(async () => {
    runtime.close();
    guidance.close();
    await rm(root, { recursive: true, force: true });
  });
  return {
    runtime, guidance, env, requests, enqueued, command,
    save(bytes) { return writeFile(transcriptPath, bytes); },
    async start() {
      const result = await runtime.recordTurnStart(command);
      assert.equal(result.ok, true);
      return { ...command, claudeTurnKey: result.claudeTurnKey };
    },
    async evaluate(command) {
      const key = runtime.searchGuidanceTurnKey(command);
      return key ? guidance.evaluate(command, key) : unavailable;
    },
  };
}

for (const [name, bytes, reason] of [
  ["invalid JSONL", "{invalid}\n", "transcript_unavailable"],
  ["invalid UTF-8", Buffer.concat([Buffer.from('{"text":"'), Buffer.from([0xff]), Buffer.from('"}\n')]), "transcript_unavailable"],
  ["mixed sessions", jsonLines(userRecord(), userRecord({ sessionId: "other-session", uuid: "other-user" })), "transcript_session_mismatch"],
]) {
  test(`Claude validates ${name} before Jev and repeated failed Starts cannot obtain guidance`, async (t) => {
    const run = await fixture(t);
    await run.save(bytes);
    const first = await run.start();
    assert.equal(run.runtime.searchGuidanceTurnKey(first), undefined);
    assert.deepEqual(await run.evaluate(first), unavailable);
    const duplicate = await run.start();
    assert.deepEqual(await run.evaluate(duplicate), unavailable);
    assert.deepEqual(await run.runtime.writeback({ ...run.command, lastAssistantMessage: "Hook text is not authority." }),
      { ok: true, scheduled: false, reason });
    assert.equal(run.requests.length, 0);
    assert.equal(run.enqueued.length, 0);

    await run.save(jsonLines(userRecord()));
    const repaired = await run.start();
    assert.equal((await run.evaluate(repaired)).ok, true);
    assert.deepEqual(run.requests.map(request => request.state), [{ current_prompt: run.command.prompt }]);
    assert.deepEqual(await run.evaluate(first), unavailable, "a failed observation cannot borrow a repaired Start");
  });
}

test("enabling Jev after an unvalidated Claude Start requires another validated Start", async (t) => {
  const run = await fixture(t, { enabled: false });
  await run.save(jsonLines(userRecord()));
  const first = await run.start();
  run.env.MEMORAX_CODE_JEV_ENABLED = "true";
  assert.deepEqual(await run.evaluate(first), unavailable);
  assert.equal(run.requests.length, 0);

  const duplicate = await run.start();
  assert.equal(duplicate.claudeTurnKey, first.claudeTurnKey, "validation does not invent a different native occurrence");
  assert.equal((await run.evaluate(duplicate)).ok, true);
  assert.equal((await run.evaluate(duplicate)).ok, true);
  assert.equal(run.requests.length, 1, "a validated duplicate keeps provider decision deduplication");
});

test("enabling Jev between snapshot capture and registration cannot authorize an unvalidated Claude Start", async (t) => {
  const run = await fixture(t, {
    enabled: false,
    beforeResolve(env) { env.MEMORAX_CODE_JEV_ENABLED = "true"; },
  });
  await run.save("{invalid}\n");
  const first = await run.start();
  assert.equal(run.guidance.isEnabled(), true);
  assert.equal(run.runtime.searchGuidanceTurnKey(first), undefined);
  assert.deepEqual(await run.evaluate(first), unavailable);
  assert.equal(run.requests.length, 0, "registration cannot bypass the Start validation gate");

  const duplicate = await run.start();
  assert.deepEqual(await run.evaluate(duplicate), unavailable, "the enabled retry validates and rejects the native file");
  assert.equal(run.requests.length, 0);
});

test("disabling and re-enabling Jev does not restore an old Claude decision without registration", async (t) => {
  const run = await fixture(t);
  await run.save(jsonLines(userRecord()));
  const first = await run.start();
  assert.equal((await run.evaluate(first)).ok, true);
  run.env.MEMORAX_CODE_JEV_ENABLED = "false";
  await run.start();
  run.env.MEMORAX_CODE_JEV_ENABLED = "true";
  assert.deepEqual(await run.evaluate(first), unavailable);
  assert.equal(run.requests.length, 1);
  const freshRegistration = await run.start();
  assert.equal((await run.evaluate(freshRegistration)).ok, true);
  assert.equal(run.requests.length, 2);
});

test("Claude Jev validation accepts only complete lines while retaining the partial tail boundary", async (t) => {
  const run = await fixture(t);
  const complete = jsonLines(userRecord());
  await run.save(Buffer.concat([Buffer.from(complete + '{"text":"'), Buffer.from([0xe4])]));
  const start = await run.start();
  assert.equal((await run.evaluate(start)).ok, true);
  assert.equal(run.requests.length, 1);
  await run.save(complete + '{"text":"changed"}\n');
  assert.deepEqual(await run.runtime.writeback({ ...run.command, lastAssistantMessage: "Done." }),
    { ok: true, scheduled: false, reason: "turn_correlation_invalid" });
  assert.equal(run.enqueued.length, 0, "guidance validation cannot relax the later prefix integrity check");
});
