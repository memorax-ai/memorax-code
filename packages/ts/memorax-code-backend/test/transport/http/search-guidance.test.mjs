import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createMemoryService } from "../../../dist/memory/service.js";
import { createMemoryReminderTraceRecorder } from "../../../dist/memory/reminder-trace-recorder.js";
import { handleMemoryHookRequest } from "../../../dist/transport/http/memory-hook.js";
import { dshTurnInterval } from "../../clients/dsh/support/dsh-session-fixtures.mjs";
import { writeRollout } from "../../clients/codex/support/memory-hook-fixtures.mjs";
import { listen } from "../../support/helpers.mjs";

test("Jev guidance uses native prior final text without Add or trace and isolates clients", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-jev-native-guidance-"));
  const home = join(root, "state");
  const cwd = join(root, "workspace");
  await mkdir(home, { recursive: true });
  await mkdir(cwd);
  const requests = [];
  const env = {
    MEMORAX_CODE_HOME: home,
    MEMORAX_CODE_MEMORAX_API_KEY: "synthetic-memory-key",
    MEMORAX_CODE_MEMORAX_USER_ID: "synthetic-user",
    MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "false",
    MEMORAX_CODE_DSH_TRACE_ENABLED: "false",
    MEMORAX_CODE_CODEX_TRACE_ENABLED: "false",
    MEMORAX_CODE_JEV_ENABLED: "true",
    MEMORAX_CODE_JEV_API_KEY: "synthetic-jev-key",
  };
  const memoryService = createMemoryService({
    env,
    memoraxCodeHome: home,
    fetchImpl: async (url, init) => {
      assert.equal(String(url), "https://api.typesafe.ai/v1/systemone");
      requests.push(JSON.parse(init.body));
      return Response.json({
        model: "jev-1.13.0",
        answers: { search_needed: { type: "noul", noul: 0.8 } },
      });
    },
  });
  const dependencies = {
    memoryService,
    memoryReminderTraceRecorder: createMemoryReminderTraceRecorder({ env, memoraxCodeHome: home }),
  };
  const server = createServer((req, res) => {
    void handleMemoryHookRequest(dependencies, new URL(req.url, "http://localhost"), req, res)
      .then((handled) => { if (!handled) { res.statusCode = 404; res.end(); } })
      .catch(() => { res.statusCode = 500; res.end(); });
  });
  const url = await listen(server);
  const post = async (path, body) => {
    const response = await fetch(url + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 200, path);
    return response.json();
  };
  const interval = dshTurnInterval({ cwd, sessionId: "shared-session", turn: 1 });
  const first = {
    version: 1, client: "dsh", sessionId: interval.sessionId, turn: 1,
    startSeq: interval.startSeq, cwd, prompt: "Implement the DSH adapter.",
  };
  const next = {
    ...first, turn: 2, startSeq: interval.endSeq + 1, prompt: "Continue with the remaining verification.",
  };
  try {
    const capability = await fetch(url + "/memory/search-guidance");
    assert.equal(capability.status, 200);
    assert.deepEqual(await capability.json(), { enabled: true });
    assert.equal((await post("/memory/turn-start", first)).ok, true);
    const completion = await post("/memory/writeback", { version: 1, client: "dsh", ...interval });
    assert.equal(completion.scheduled, false);
    assert.equal(requests.length, 0, "turn materialization and disabled Add must not query either provider");

    assert.equal((await post("/memory/turn-start", next)).ok, true);
    const decision = await post("/memory/search-guidance", next);
    assert.equal(decision.ok, true);
    assert.equal(decision.decision, "search");
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].state, {
      current_prompt: next.prompt,
      previous_turn: { user: first.prompt, assistant: "The adapter is ready." },
    });
    assert.doesNotMatch(JSON.stringify(requests[0]), /I will inspect|recalled memory|private tool result/);

    const codexPrompt = "An independent task in another client.";
    const transcriptPath = await writeRollout(home, interval.sessionId, [{
      turnId: "2", prompt: codexPrompt, reply: "Independent final answer.",
    }]);
    const codex = {
      version: 1, client: "codex", sessionId: interval.sessionId, turnId: "2",
      cwd, transcriptPath, prompt: codexPrompt,
    };
    assert.equal((await post("/memory/turn-start", codex)).ok, true);
    const incompleteCodex = { ...codex };
    delete incompleteCodex.cwd;
    assert.deepEqual(await post("/memory/search-guidance", incompleteCodex), { ok: false, reason: "context_unavailable" });
    assert.equal(requests.length, 1, "omitting the registered cwd must not send cached conversation text");
    assert.equal((await post("/memory/search-guidance", codex)).ok, true);
    assert.deepEqual(requests[1].state, { current_prompt: codexPrompt });
    assert.deepEqual(await post("/memory/search-guidance", incompleteCodex), { ok: false, reason: "context_unavailable" });
    assert.equal(requests.length, 2, "cached decisions retain the same reference requirements");

    const third = { ...next, turn: 3, startSeq: next.startSeq + 11, prompt: "Start a different task." };
    assert.equal((await post("/memory/turn-start", third)).ok, true);
    const late = dshTurnInterval({
      cwd, sessionId: interval.sessionId, turn: 2, startSeq: next.startSeq,
    });
    late.events[1].data.content[0].text = next.prompt;
    await post("/memory/writeback", { version: 1, client: "dsh", ...late });
    assert.equal((await post("/memory/search-guidance", third)).ok, true);
    assert.deepEqual(requests[2].state, { current_prompt: third.prompt },
      "a late superseded completion must not replace the next prompt's context");
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await memoryService.drain();
    memoryService.close();
    await rm(root, { recursive: true, force: true });
  }
});
