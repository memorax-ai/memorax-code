import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, appendFile, rm, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCodexMemoryHookRuntime } from "../../../dist/clients/codex/memory-hook-runtime.js";
import { writeRollout } from "./support/memory-hook-fixtures.mjs";

test("Codex completion after Hook returns recovers once; next turn cannot replace it", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "helpful-deferred-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = await writeRollout(home, "s", [{ turnId: "n", prompt: "source", reply: "" }]);
  const received = [];
  const runtime = createCodexMemoryHookRuntime({
    memoraxCodeHome: home,
    env: { MEMORAX_CODE_HOME: home, MEMORAX_CODE_MEMORAX_API_KEY: "synthetic",
      MEMORAX_CODE_MEMORAX_USER_ID: "synthetic", MEMORAX_CODE_CODEX_TRACE_ENABLED: "false" },
    automaticWriteback: value => { received.push(value); return { accepted: true }; },
  });
  t.after(() => runtime.close());
  const command = { version: 1, client: "codex", sessionId: "s", turnId: "n", cwd: home, transcriptPath: path };
  await runtime.recordTurnStart({ ...command, prompt: "source" });
  assert.equal((await runtime.writeback({ ...command, lastAssistantMessage: "late" })).deferred, true);
  assert.equal((await runtime.writeback({ ...command, lastAssistantMessage: "late" })).deferred, true);
  await appendFile(path, JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "n", last_agent_message: "late" } }) + "\n");
  await runtime.recordTurnStart({ ...command, turnId: "n1", prompt: "next" });
  const deadline = Date.now() + 1500;
  while (!received.length && Date.now() < deadline) await new Promise(r => setTimeout(r, 20));
  assert.equal(received.length, 1);
  assert.equal(received[0].userText, "source");
  assert.equal(received[0].assistantText, "late");
  await runtime.drain();
});

test("Codex drain cancels pending reread and forbids late enqueue", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "helpful-close-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = await writeRollout(home, "s", [{ turnId: "n", prompt: "source", reply: "" }]);
  const received = [];
  const runtime = createCodexMemoryHookRuntime({
    memoraxCodeHome: home,
    env: { MEMORAX_CODE_HOME: home, MEMORAX_CODE_MEMORAX_API_KEY: "synthetic", MEMORAX_CODE_MEMORAX_USER_ID: "synthetic" },
    automaticWriteback: v => { received.push(v); return { accepted: true }; },
  });
  t.after(() => runtime.close());
  const command = { version: 1, client: "codex", sessionId: "s", turnId: "n", cwd: home, transcriptPath: path, lastAssistantMessage: "late" };
  assert.equal((await runtime.writeback(command)).deferred, true);
  await runtime.drain();
  await appendFile(path, JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "n", last_agent_message: "late" } }) + "\n");
  assert.equal((await runtime.writeback(command)).reason, "runtime_closed");
  assert.equal(received.length, 0);
});

test("Codex missing final exhausts exactly five additional reads and records the final cause", { timeout: 6000 }, async (t) => {
  const home = await mkdtemp(join(tmpdir(), "helpful-exhaust-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = await writeRollout(home, "s", [{ turnId: "n", prompt: "source", reply: "" }]);
  const failures = [];
  const runtime = createCodexMemoryHookRuntime({
    memoraxCodeHome: home,
    env: { MEMORAX_CODE_HOME: home, MEMORAX_CODE_MEMORAX_API_KEY: "synthetic", MEMORAX_CODE_MEMORAX_USER_ID: "synthetic",
      MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true", MEMORAX_CODE_CODEX_TRACE_ENABLED: "false" },
    diagnosticLogger: (name, fields) => { if (name === "memory_hook.writeback" && fields.reason === "assistant_message_missing") failures.push(fields); },
    automaticWriteback: () => assert.fail("no final answer means no Add"),
  });
  t.after(() => runtime.close());
  const result = await runtime.writeback({ version: 1, client: "codex", sessionId: "s", turnId: "n", cwd: home, transcriptPath: path, lastAssistantMessage: "not authority" });
  assert.equal(result.deferred, true);
  const deadline = Date.now() + 4800;
  const dir = join(home, "runtime/diagnostics");
  let files = [];
  while (Date.now() < deadline) {
    files = await readdir(dir).catch(() => []);
    if (files.length) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(failures.length, 6);
  assert.equal(files.length, 1);
  const diagnostic = JSON.parse(await readFile(join(dir, files[0]), "utf8"));
  assert.equal(diagnostic.failureReason, "deferred_assistant_message_missing");
});
