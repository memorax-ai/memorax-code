import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  codexCodingSessionTurnFromJsonLines,
  codexRolloutTurnFromJsonLines,
  readCodexArchiveSource,
  readCodexCodingSessionTurn,
} from "../../../dist/clients/codex/rollout-turn.js";

const identity = { sessionId: "session-search", turnId: "turn-search" };
const user = { type: "message", role: "user", content: [{ type: "input_text", text: "Find a reference and its tool." }] };
const final = { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "The reference and tool are ready." }] };

function transcript(items) {
  return [
    { type: "session_meta", payload: { id: identity.sessionId } },
    { type: "turn_context", payload: { turn_id: identity.turnId } },
    { type: "response_item", payload: user },
    ...items.map((payload) => ({ type: "response_item", payload })),
    { type: "response_item", payload: final },
    { type: "event_msg", timestamp: "2026-09-01T00:00:00.000Z", payload: { type: "task_complete", turn_id: identity.turnId } },
  ].map((record) => JSON.stringify(record)).join("\n") + "\n";
}

test("Codex v2 preserves web actions and server/client tool discovery in native order", () => {
  const items = [
    { type: "web_search_call", id: "web-search", status: "completed", action: { type: "search", query: "Synthetic reference", queries: ["Synthetic reference", "Synthetic API"], domains: ["example.test"] } },
    { type: "web_search_call", action: { type: "open_page", url: "https://example.test/reference" } },
    { type: "web_search_call", id: "web-find", action: { type: "find_in_page", url: "https://example.test/reference", pattern: "Synthetic API" } },
    { type: "tool_search_call", id: "server-search", status: "completed", execution: "server", call_id: null, arguments: { query: "Find a lookup tool", limit: 2, hints: ["reference", null] } },
    { type: "tool_search_output", id: "server-output", execution: "server", call_id: null, tools: [{ type: "function", name: "lookup", description: "Read a synthetic reference", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false } }] },
    { type: "function_call", call_id: "lookup-call", name: "lookup", arguments: ' { "query": "Synthetic API" }\n' },
    { type: "function_call_output", call_id: "lookup-call", output: "Synthetic API found." },
    { type: "tool_search_call", execution: "client", call_id: "client-search", arguments: ' { "query": "Find a renderer", "limit": 1 }\n' },
    { type: "tool_search_output", status: "completed", execution: "client", call_id: "client-search", tools: [{ type: "function", name: "render", parameters: { type: "object", properties: {} } }] },
    { type: "tool_search_call", execution: "server", arguments: { query: "Optional server identity" } },
    { type: "tool_search_output", execution: "server", tools: [] },
  ];
  const input = transcript(items.map((item) => ({
    ...item,
    internal_metadata: { private: "not an archive field" },
    internal_chat_message_metadata_passthrough: { turn_id: identity.turnId },
    reasoning: "Hidden native reasoning",
  })));
  const result = codexCodingSessionTurnFromJsonLines(input, { ...identity, projectionVersion: 2 });
  assert.equal(result.ok, true);
  assert.deepEqual(result.turn.items, [user, ...items, final]);
  assert.equal(result.turn.sessionTurnIndex, 1);
  const { items: _items, closedAt: _closedAt, sessionTurnIndex: _index, ...qa } = result.turn;
  assert.deepEqual(qa, codexRolloutTurnFromJsonLines(input, identity).turn);
  assert.doesNotMatch(JSON.stringify(result.turn.items), /internal_metadata|internal_chat_message_metadata_passthrough|Hidden native reasoning/);
  assert.deepEqual(codexCodingSessionTurnFromJsonLines(input, identity), result);
});

test("Codex search items reject malformed native fields without relaxing function call identity", () => {
  const invalid = [
    { type: "web_search_call" },
    { type: "web_search_call", action: [] },
    { type: "tool_search_call", execution: "client", arguments: {} },
    { type: "tool_search_call", execution: "client", call_id: null, arguments: {} },
    { type: "tool_search_output", execution: "client", call_id: " ", tools: [] },
    { type: "tool_search_call", execution: "server", call_id: 1, arguments: {} },
    { type: "tool_search_call", execution: "unknown", arguments: {} },
    { type: "tool_search_call", execution: "server" },
    { type: "tool_search_output", execution: "server", tools: {} },
    { type: "tool_search_output", execution: "server", tools: [null] },
    { type: "function_call", id: "not-a-call-id", name: "lookup", arguments: "{}" },
    { type: "custom_tool_call", id: "not-a-call-id", name: "lookup", input: "query" },
    { type: "function_call_output", output: "Missing identity." },
    { type: "custom_tool_call_output", call_id: null, output: "Missing identity." },
  ];
  for (const projectionVersion of [1, 2]) {
    const result = codexCodingSessionTurnFromJsonLines(transcript(invalid), { ...identity, projectionVersion });
    assert.equal(result.ok, true);
    assert.deepEqual(result.turn.items, [user, final]);
  }
});

test("Codex v1 projection retains its exact item bytes when newer native search items exist", () => {
  const functionItems = [
    { type: "function_call", id: "function-id", call_id: "call-id", name: "lookup", namespace: "functions", arguments: ' { "z": 1, "a": 2 }\n' },
    { type: "function_call_output", id: "output-id", call_id: "call-id", output: { z: "last", a: "first" } },
  ];
  const searchItems = [
    { type: "web_search_call", action: { type: "search", query: "Synthetic reference" } },
    { type: "tool_search_call", execution: "server", call_id: null, arguments: { query: "Synthetic tool" } },
    { type: "tool_search_output", execution: "server", call_id: null, tools: [] },
  ];
  const result = codexCodingSessionTurnFromJsonLines(transcript([...searchItems, ...functionItems]), { ...identity, projectionVersion: 1 });
  const oldInput = codexCodingSessionTurnFromJsonLines(transcript(functionItems), { ...identity, projectionVersion: 1 });
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result), JSON.stringify(oldInput));
  assert.equal(JSON.stringify(result.turn.items), JSON.stringify([
    user,
    { type: "function_call", call_id: "call-id", name: "lookup", arguments: ' { "z": 1, "a": 2 }\n', namespace: "functions", id: "function-id" },
    { type: "function_call_output", call_id: "call-id", output: '{"a":"first","z":"last"}', id: "output-id" },
    final,
  ]));
});

test("Codex archive rereads default old references to v1 and honor explicit v2", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-codex-search-items-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "rollout.jsonl");
  const search = { type: "web_search_call", action: { type: "search", query: "Synthetic reference" } };
  const input = transcript([search]);
  await writeFile(path, input);
  const ref = {
    ...identity, client: "codex", turnIndex: 1, outcome: "completed", closedAt: "2026-09-01T00:00:00.000Z",
    source: { transcriptPath: path, endBytes: Buffer.byteLength(input, "utf8") },
  };
  const unversioned = await readCodexArchiveSource(ref);
  const legacy = await readCodexArchiveSource({ ...ref, projectionVersion: 1 });
  const current = await readCodexArchiveSource({ ...ref, projectionVersion: 2 });
  assert.deepEqual(unversioned.items, [user, final]);
  assert.equal(JSON.stringify(unversioned.items), JSON.stringify(legacy.items));
  assert.deepEqual(current.items, [user, search, final]);
  assert.deepEqual((await readCodexCodingSessionTurn({ transcriptPath: path, ...identity })).turn.items, current.items);
  assert.deepEqual((await readCodexCodingSessionTurn({ transcriptPath: path, ...identity, projectionVersion: 1 })).turn.items, legacy.items);
});
