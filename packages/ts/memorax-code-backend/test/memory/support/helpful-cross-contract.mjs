// Invoked by the server's optional cross-repository contract test.
import assert from "node:assert/strict";
import { mkdtemp, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryService } from "../../../dist/memory/service.js";
import { runMemoryCli } from "../../../dist/memory/cli.js";
import { writeRollout } from "../../clients/codex/support/memory-hook-fixtures.mjs";

let input = "";
for await (const chunk of process.stdin) input += chunk;
const incoming = JSON.parse(input);
const searchResponse = incoming.search_response ?? incoming;
const home = await mkdtemp(join(tmpdir(), "helpful-cross-"));
const requests = [];
const env = {
  MEMORAX_CODE_HOME: home, CODEX_THREAD_ID: "synthetic-session",
  MEMORAX_CODE_BACKEND_TOKEN: "synthetic-local-token",
  MEMORAX_CODE_MEMORAX_API_KEY: "synthetic-remote-token",
  MEMORAX_CODE_MEMORAX_USER_ID: "synthetic-user",
  MEMORAX_CODE_MEMORAX_ENDPOINT: incoming.base_url ?? "http://synthetic.invalid",
  MEMORAX_CODE_CODEX_TRACE_ENABLED: "false",
  MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
  MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_TURNS: "8",
  MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_AGE_MS: "60000",
};
let service;
const fetchImpl = async (url, init) => {
  const path = new URL(url).pathname, body = JSON.parse(init.body);
  if (path === "/v1/memories/search") return incoming.base_url ? fetch(url, init) : Response.json(searchResponse);
  if (path === "/memory/turn-context") {
    assert.equal(init.headers["x-memorax-code-backend-token"], "synthetic-local-token");
    const value = service.registerHelpfulSearch(body);
    assert.equal("candidates" in body, false);
    assert.equal(value.accepted, true);
    return Response.json(value);
  }
  assert.equal(path, "/v1/memories/add");
  assert.equal(init.headers.Authorization, "Token synthetic-remote-token");
  requests.push(body);
  return incoming.base_url ? fetch(url, init) : Response.json({
    success: true, data: { status: "accepted", task_id: "synthetic-add-task" },
  }, { status: 202 });
};
const completed = new Set();
service = createMemoryService({ memoraxCodeHome: home, env, fetchImpl,
  diagnosticLogger(name, fields) {
    if (name === "memory_hook.writeback" && fields.scheduled) completed.add(fields.turnId);
  },
});
try {
  const turns = [];
  for (let i = 0; i < 8; i++) {
    turns.push({ turnId: `turn-${i}`, prompt: `Synthetic question ${i}`, reply: `Synthetic answer ${i}` });
    const transcriptPath = await writeRollout(home, "synthetic-session",
      incoming.deferred && i === 0 ? [{ ...turns[0], reply: "" }] : turns);
    const command = { version: 1, client: "codex", sessionId: "synthetic-session",
      turnId: `turn-${i}`, cwd: home, transcriptPath };
    await service.recordTurnStart({ ...command, prompt: turns[i].prompt });
    if (i === 0) {
      const search = await runMemoryCli(["search", "--query", "synthetic query"], { cwd: home, env, fetchImpl });
      assert.equal(search.ok, true);
      assert.equal(search.search_id, searchResponse.data.search_id);
    }
    const result = await service.writebackTurn({ ...command, lastAssistantMessage: turns[i].reply });
    if (incoming.deferred && i === 0) {
      assert.equal(result.deferred, true);
      await appendFile(transcriptPath, JSON.stringify({
        type: "event_msg", payload: { type: "task_complete", turn_id: "turn-0", last_agent_message: turns[0].reply },
      }) + "\n");
      const deadline = Date.now() + 2000;
      while (!completed.has("turn-0") && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
      assert.ok(completed.has("turn-0"), "deferred native QA must reach the Add buffer");
    }
    if (i < 7) assert.equal(requests.length, 0);
  }
  await service.drain();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].h.length, 1);
  assert.equal("summaries" in requests[0].h[0], false);
  process.stdout.write(JSON.stringify(requests[0]));
} finally { service.close(); await rm(home, { recursive: true, force: true }); }
