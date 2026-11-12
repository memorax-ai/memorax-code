import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQoderMemoryHookRuntime } from "../../../dist/clients/qoder/memory-hook-runtime.js";
import { parseTurnStartCommand } from "../../../dist/memory/hook-command.js";
import { readOpenTraceTurn } from "../../../dist/trace/store.js";

test("late Qoder Submit replay cannot replace the newer open turn or enqueue the old turn again", async (t) => {
  const f = await fixture(t);
  await f.runtime.recordTurnStart(f.first);
  await f.writeNative();
  assert.equal((await f.runtime.writeback(f.finish(f.first))).scheduled, true);
  await f.runtime.recordTurnStart(f.second);
  const replay = await f.runtime.recordTurnStart(f.first);
  const bridge = await readOpenTraceTurn({
    client: "qoder", expectedSessionId: f.first.sessionId, memoraxCodeHome: f.home,
  });
  const oldCompletion = await f.runtime.writeback(f.finish(f.first));
  const currentCompletion = await f.runtime.writeback(f.finish(f.second));
  assert.deepEqual({
    replayRecorded: replay.recorded,
    openTurn: bridge.ok ? bridge.traceContext.turnId : undefined,
    oldScheduled: oldCompletion.scheduled,
    currentScheduled: currentCompletion.scheduled,
    acceptedTurns: f.writes.map((write) => write.traceContext.turnId),
  }, {
    replayRecorded: false,
    openTurn: f.second.turnId,
    oldScheduled: false,
    currentScheduled: true,
    acceptedTurns: [f.first.turnId, f.second.turnId],
  });
});

for (const outcome of ["aborted", "superseded"]) {
  test(`late Qoder Submit cannot resurrect an ${outcome} turn or discard its successor`, async (t) => {
    const f = await fixture(t);
    await f.runtime.recordTurnStart(f.first);
    await f.writeNative();
    if (outcome === "aborted") await f.runtime.writeback({ ...f.finish(f.first), status: "aborted" });
    await f.runtime.recordTurnStart(f.second);
    const replay = await f.runtime.recordTurnStart(f.first);
    const bridge = await readOpenTraceTurn({
      client: "qoder", expectedSessionId: f.first.sessionId, memoraxCodeHome: f.home,
    });
    const oldCompletion = await f.runtime.writeback(f.finish(f.first));
    const currentCompletion = await f.runtime.writeback(f.finish(f.second));
    assert.deepEqual({
      replayRecorded: replay.recorded,
      openTurn: bridge.ok ? bridge.traceContext.turnId : undefined,
      oldScheduled: oldCompletion.scheduled,
      currentScheduled: currentCompletion.scheduled,
      acceptedTurns: f.writes.map((write) => write.traceContext.turnId),
    }, {
      replayRecorded: false,
      openTurn: f.second.turnId,
      oldScheduled: false,
      currentScheduled: true,
      acceptedTurns: [f.second.turnId],
    });
  });
}

test("Qoder ingress rejects a projectless scope hint that has no native authority", async (t) => {
  const f = await fixture(t);
  const parsed = parseTurnStartCommand({ ...f.first, workspaceKind: "projectless" });
  assert.equal(parsed.ok, true);
  assert.deepEqual(await f.runtime.recordTurnStart(parsed.command), {
    ok: true, recorded: false, reason: "workspace_scope_mismatch",
  });
  await f.writeNative();
  assert.equal((await f.runtime.writeback({ ...f.finish(f.first), workspaceKind: "projectless" })).scheduled, false);
  assert.equal(f.runtime.size(), 0);
  assert.equal(f.writes.length, 0);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "memorax-qoder-review-"));
  const cwd = join(root, "workspace");
  const home = join(root, "state");
  await mkdir(cwd);
  const writes = [];
  const runtime = createQoderMemoryHookRuntime({
    memoraxCodeHome: home,
    env: {
      MEMORAX_CODE_HOME: home,
      MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
      MEMORAX_CODE_MEMORAX_API_KEY: "synthetic-key",
      MEMORAX_CODE_MEMORAX_USER_ID: "synthetic-user",
      MEMORAX_CODE_QODER_TRACE_ENABLED: "false",
    },
    automaticWriteback(input) { writes.push(input); return { accepted: true }; },
  });
  t.after(async () => { runtime.close(); await rm(root, { recursive: true, force: true }); });
  const first = { version: 1, client: "qoder", sessionId: "session-review", turnId: "request-first",
    cwd, transcriptPath: join(root, "transcript.jsonl"), prompt: "First prompt." };
  const second = { ...first, turnId: "request-second", prompt: "Second prompt." };
  return {
    home, runtime, writes, first, second,
    finish({ prompt, ...command }) { return { ...command, status: "completed" }; },
    async writeNative() {
      const records = [];
      let parentUuid = null;
      for (const command of [first, second]) {
        const identity = { sessionId: command.sessionId, cwd, isSidechain: false };
        records.push({ ...identity, type: "user", uuid: command.turnId, parentUuid,
          requestSetId: command.turnId, origin: { kind: "human" }, humanInput: { text: command.prompt },
          message: { role: "user", content: [{ type: "text", text: command.prompt }] } });
        parentUuid = `${command.turnId}-final`;
        records.push({ ...identity, type: "assistant", uuid: parentUuid, parentUuid: command.turnId,
          message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Synthetic final." }] } });
      }
      records.push({ type: "active-leaf", sessionId: first.sessionId, leafUuid: parentUuid });
      await writeFile(first.transcriptPath, records.map(JSON.stringify).join("\n") + "\n");
    },
  };
}
