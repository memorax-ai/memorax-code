import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  evaluateJevSearch,
  JEV_ENDPOINT,
  JEV_MAX_TEXT_CHARS,
  JEV_MODEL,
} from "../../../dist/provider/jev/adapter.js";

const apiKey = "fixture-typesafe-key-123456";
const input = {
  currentPrompt: "Continue investigating the earlier Windows locking regression.",
  previousTurn: { user: "The Windows test failed again.", assistant: "We should check the previous fix." },
};

function answer(probability) {
  return { model: JEV_MODEL, answers: { search_needed: { type: "noul", noul: probability } } };
}

async function configuration(t, contents = `[jev]\nenabled = true\napi_key = "${apiKey}"\n`) {
  const home = await mkdtemp(join(tmpdir(), "memorax-jev-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, "config.toml");
  await writeFile(path, contents);
  return { env: { MEMORAX_CODE_HOME: home }, path };
}

async function mockApi(t, handler) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({ headers: request.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
    handler(response, requests.length);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  return {
    requests,
    fetchImpl: (url, options) => {
      assert.equal(url, JEV_ENDPOINT);
      assert.equal(options.redirect, "error");
      return fetch(`http://127.0.0.1:${server.address().port}/v1/systemone`, options);
    },
  };
}

test("Jev reads private configuration and preserves bounded conversation text", async (t) => {
  const config = await configuration(t);
  const remote = await mockApi(t, (response) => response.end(JSON.stringify(answer(0.9))));
  const options = { env: config.env, fetchImpl: remote.fetchImpl };
  const currentPrompt = `${input.currentPrompt}\napi_key = "literal-fixture-example"\n${apiKey}`;
  const result = await evaluateJevSearch({
    ...input,
    currentPrompt,
    previousTurn: { ...input.previousTurn, assistant: "A".repeat(JEV_MAX_TEXT_CHARS + 100) },
    transcriptPath: "/private/fixture/transcript.jsonl",
    sessionId: "private-session-id",
  }, options);
  assert.deepEqual(result, { ok: true, decision: "search", probability: 0.9, model: JEV_MODEL });
  assert.equal(remote.requests[0].headers.authorization, `Bearer ${apiKey}`);
  const request = remote.requests[0].body;
  assert.equal(request.model, JEV_MODEL);
  assert.deepEqual(Object.keys(request.state).sort(), ["current_prompt", "previous_turn"]);
  assert.equal(request.state.previous_turn.user, input.previousTurn.user);
  assert.equal(request.state.previous_turn.assistant.length, JEV_MAX_TEXT_CHARS);
  assert.equal(request.state.current_prompt, currentPrompt);
  assert.doesNotMatch(JSON.stringify(request), /transcript\.jsonl|private-session-id/);
  assert.equal(request.questions.search_needed.type, "noul");
  await writeFile(config.path, `[jev]\nenabled = false\napi_key = "${apiKey}"\n`);
  assert.deepEqual(await evaluateJevSearch(input, options), { ok: false, reason: "disabled" });
  await writeFile(config.path, "[jev]\nenabled = true\n");
  assert.deepEqual(await evaluateJevSearch(input, options), { ok: false, reason: "missing_key" });
  assert.equal(remote.requests.length, 1);
});

test("Jev valid probabilities produce a binary decision at the 0.5 boundary", async (t) => {
  const config = await configuration(t);
  const cases = [[0, "skip"], [0.49, "skip"], [0.5, "search"], [0.51, "search"], [1, "search"]];
  const remote = await mockApi(t, (response, count) => response.end(JSON.stringify(answer(cases[count - 1][0]))));
  for (const [probability, decision] of cases) {
    assert.deepEqual(await evaluateJevSearch(input, { env: config.env, fetchImpl: remote.fetchImpl }), {
      ok: true, decision, probability, model: JEV_MODEL,
    });
  }
  assert.equal(remote.requests.length, cases.length);
});

test("Jev rejects unusable input locally and supports a first prompt without a prior turn", async (t) => {
  const config = await configuration(t);
  const remote = await mockApi(t, (response) => response.end(JSON.stringify(answer(0.1))));
  const options = { env: config.env, fetchImpl: remote.fetchImpl };
  for (const invalid of [null, { currentPrompt: " " }, { currentPrompt: "x".repeat(128_001) }, {
    currentPrompt: "Continue", previousTurn: { user: "Earlier task", assistant: "" },
  }]) {
    assert.deepEqual(await evaluateJevSearch(invalid, options), { ok: false, reason: "invalid_input" });
  }
  assert.equal(remote.requests.length, 0);
  assert.equal((await evaluateJevSearch({ currentPrompt: "Hello" }, options)).decision, "skip");
  assert.deepEqual(remote.requests[0].body.state, { current_prompt: "Hello" });
});

test("Jev failures return safe reasons without response bodies, exception text, or retries", async (t) => {
  const config = await configuration(t);
  const responses = [
    ...[401, 429, 529].map((status) => ({ status, body: apiKey })),
    { body: `invalid JSON ${apiKey}` },
    { body: JSON.stringify(answer(2)) },
    { body: JSON.stringify({ ...answer(0.1), model: apiKey }) },
    { body: "x".repeat(17_000) },
  ];
  const remote = await mockApi(t, (response, count) => {
    const fixture = responses[count - 1];
    response.writeHead(fixture.status ?? 200);
    response.end(fixture.body);
  });
  for (const fixture of responses) {
    assert.deepEqual(await evaluateJevSearch(input, { env: config.env, fetchImpl: remote.fetchImpl }), {
      ok: false, reason: fixture.status ? "http_error" : "invalid_response",
      ...(fixture.status ? { httpStatus: fixture.status } : {}),
    });
  }
  assert.equal(remote.requests.length, responses.length);
  const failedTransport = await evaluateJevSearch(input, {
    env: config.env, fetchImpl: async () => { throw new Error(`private request ${apiKey}`); },
  });
  assert.deepEqual(failedTransport, { ok: false, reason: "transport_error" });
});

test("Jev deadline includes a stalled response body and caller cancellation", async (t) => {
  const config = await configuration(t);
  const remote = await mockApi(t, (response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.write('{"model":');
  });
  const options = { env: config.env, fetchImpl: remote.fetchImpl };
  assert.deepEqual(await evaluateJevSearch(input, options), { ok: false, reason: "timeout" });
  assert.deepEqual(await evaluateJevSearch(input, { ...options, signal: AbortSignal.abort() }), {
    ok: false, reason: "cancelled",
  });
  assert.equal(remote.requests.length, 1);
  assert.deepEqual(await evaluateJevSearch(input, { ...options, signal: AbortSignal.timeout(30) }), {
    ok: false, reason: "cancelled",
  });
});
