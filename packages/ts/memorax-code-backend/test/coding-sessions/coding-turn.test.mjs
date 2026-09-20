import assert from "node:assert/strict";
import { homedir } from "node:os";
import { test } from "node:test";
import {
  CODING_TURN_MAX_BYTES,
  codingEventText,
  codingToolOutputText,
  prepareCodingSessionTurn,
} from "../../dist/coding-sessions/coding-turn.js";

test("tool projection preserves string formatting while legacy replay retains its original encoding", () => {
  for (const value of [' { "z": 1, "a": 2 }\n', '  build failed\n', '\n']) {
    assert.equal(codingEventText(value), value);
  }
  assert.equal(codingEventText(' { "z": 1, "a": 2 }\n', 1), '{"a":2,"z":1}');
  assert.equal(codingEventText('  build failed\n', 1), 'build failed');
  assert.equal(codingEventText('\n', 1), '');
  const structured = [{ type: "text", text: "  tool output\n", exit_code: 1 }, { error: "failed", details: [1, 2] }];
  assert.deepEqual(JSON.parse(codingEventText(structured)), structured);
  assert.equal(codingEventText(undefined), "");
  assert.equal(codingEventText(' { "image": "data:image/png;base64,AAAA" } '), '{"image":"[BINARY_CONTENT_OMITTED]"}');
});

test("tool status wrappers preserve redaction of native strings before JSON escaping", () => {
  const sensitive = '{"password":"synthetic-passphrase"}\nAuthorization: native-auth-value';
  for (const value of [
    { content: sensitive, is_error: true },
    { output: sensitive, status: "error" },
    { status: "error", error: sensitive, output: [{ text: sensitive, type: "text" }] },
  ]) {
    const output = codingToolOutputText(value);
    assert.doesNotMatch(output, /synthetic-passphrase|native-auth-value/);
    assert.match(output, /REDACTED:CREDENTIAL/);
    assert.match(output, /REDACTED:AUTH_TOKEN/);
    assert.deepEqual(Object.keys(JSON.parse(output)).sort(), Object.keys(value).sort());
  }
  const plain = { output: ' { "z": 1, "a": 2 }\n', status: "completed" };
  assert.deepEqual(JSON.parse(codingToolOutputText(plain)), plain);
  assert.equal(codingToolOutputText("  result\n"), "  result\n");
  assert.equal(codingToolOutputText(undefined), "");
});

test("session Items retain their wire shape and redact local data", () => {
  const turn = prepareCodingSessionTurn({
    client: "codex",
    sessionId: "session-1",
    turnId: "turn-1",
    turnIndex: 1,
    items: [
      { type: "message", role: "user", content: [{ type: "input_text", text: `Inspect ${homedir()}/private.` }] },
      {
        type: "function_call",
        call_id: "call-1",
        name: "exec_command",
        arguments: codingEventText({ token: "sk-test-secret-1234567890", cmd: "npm test" }),
      },
      {
        type: "function_call_output",
        call_id: "call-1",
        output: codingEventText({
          result: "tests passed",
          preview: "data:image/png;base64,AAAA",
        }),
      },
      { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Done." }] },
    ],
    outcome: "completed",
    closedAt: "2026-08-30T08:00:00Z",
    repositorySlug: "memorax-code",
  });

  assert.ok(turn);
  assert.equal(turn.truncation, undefined);
  assert.deepEqual(turn.items.map((item) => item.type), ["message", "function_call", "function_call_output", "message"]);
  assert.match(turn.items[0].content[0].text, /\[REDACTED:LOCAL_PATH\]\/private/);
  assert.equal(turn.items[1].arguments.startsWith('{"cmd":"npm test","token":'), true);
  assert.doesNotMatch(turn.items[1].arguments, /sk-test-secret/);
  assert.doesNotMatch(turn.items[2].output, /base64,AAAA/);
  assert.match(turn.items[2].output, /BINARY_CONTENT_OMITTED/);
});

test("native text blocks and tool strings retain formatting without retaining binary attachments", () => {
  const content = ["```", "\n", "const answer = 42;", "\n```"].map((text) => ({ type: "output_text", text }));
  const argumentsText = ' { "z": 1, "a": 2 }\n';
  const turn = prepareCodingSessionTurn({
    client: "codex", sessionId: "session-1", turnId: "turn-1", turnIndex: 1,
    outcome: "completed", closedAt: "2026-08-30T08:00:00Z",
    items: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect the project." }] },
      { type: "function_call", call_id: "call-1", name: "inspect", arguments: argumentsText },
      {
        type: "function_call_output", call_id: "call-1",
        output: JSON.stringify({
          result: "ok", preview: "data:image/png;base64,AAAA",
          buffer: { type: "Buffer", data: [1, 2, 3] },
          attachment: { type: "audio", data: "AAAA" },
        }),
      },
      { type: "message", role: "assistant", phase: "final_answer", content },
    ],
  });
  assert.ok(turn);
  assert.equal(turn.items[1].arguments, argumentsText);
  assert.deepEqual(JSON.parse(turn.items[2].output), {
    result: "ok", preview: "[BINARY_CONTENT_OMITTED]", buffer: "[BINARY_CONTENT_OMITTED]",
    attachment: { type: "audio", data: "[BINARY_CONTENT_OMITTED]" },
  });
  assert.deepEqual(turn.items[3].content, content);
  assert.equal(turn.truncation, undefined);
});

test("truncation metadata counts each native text block only once", () => {
  const turn = prepareCodingSessionTurn({
    client: "codex", sessionId: "session-1", turnId: "turn-1", turnIndex: 1,
    outcome: "completed", closedAt: "2026-08-30T08:00:00Z",
    items: [
      {
        type: "message", role: "user", content: [
          { type: "input_text", text: "a".repeat(128_001) },
          { type: "input_text", text: "b".repeat(128_001) },
        ],
      },
      { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Done." }] },
    ],
  });
  assert.deepEqual(turn.truncation, { original_item_count: 2, truncated_text_fields: 2 });
  assert.deepEqual(turn.items[0].content.map((part) => part.text.length), [128_000, 128_000]);
});

test("coding Turn bounds keep QA and recent tool content with explicit loss metadata", () => {
  const source = {
    client: "codex",
    sessionId: "session-1",
    turnId: "turn-1",
    turnIndex: 1,
    items: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect the project." }] },
      ...Array.from({ length: 600 }, (_, index) => ({
        type: "function_call_output", call_id: `call-${index}`, output: "Read file.",
      })),
      { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Inspection complete." }] },
    ],
    outcome: "completed",
    closedAt: "2026-08-30T08:00:00Z",
  };
  const countBounded = prepareCodingSessionTurn(source);
  assert.equal(countBounded.items.length, 512);
  assert.equal(countBounded.items[1].call_id, "call-90");
  assert.deepEqual(countBounded.truncation, {
    original_item_count: 602, truncated_text_fields: 0,
  });

  for (const item of source.items.slice(-5, -1)) item.output = "字\u0001".repeat(80_000);
  const byteBounded = prepareCodingSessionTurn(source);
  assert.ok(Buffer.byteLength(JSON.stringify(byteBounded), "utf8") <= CODING_TURN_MAX_BYTES);
  assert.deepEqual(byteBounded.items.map((item) => item.type), [
    "message", "function_call_output", "function_call_output",
    "function_call_output", "function_call_output", "message",
  ]);
  assert.equal(byteBounded.items[1].call_id, "call-596");
  assert.ok(byteBounded.items[1].output.length < 128_000);
  assert.deepEqual(byteBounded.truncation, {
    original_item_count: 602, truncated_text_fields: 4,
  });
});

test("coding Turn byte budget includes large QA, escaped identities, and truncation metadata", () => {
  const turn = prepareCodingSessionTurn({
    client: "codex",
    sessionId: '"'.repeat(255),
    turnId: "\\".repeat(255),
    turnIndex: Number.MAX_SAFE_INTEGER,
    items: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "中".repeat(160_000) }] },
      { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "完🙂\u0001".repeat(40_000) }] },
    ],
    outcome: "completed",
    closedAt: "2026-08-30T08:00:00Z",
    repositorySlug: "仓".repeat(255),
  });
  assert.ok(turn);
  assert.ok(Buffer.byteLength(JSON.stringify(turn), "utf8") <= CODING_TURN_MAX_BYTES);
  assert.equal(turn.items.length, 2);
  assert.ok(turn.items[0].content[0].text.startsWith("中"));
  assert.ok(turn.items[1].content[0].text.startsWith("完🙂"));
  assert.equal(turn.items[1].content[0].text.isWellFormed(), true);
  assert.deepEqual(turn.truncation, {
    original_item_count: 2, truncated_text_fields: 2,
  });
});

test("search items retain structured native fields and nullable hosted call identity", () => {
  const tools = [{
    type: "namespace", name: "catalog", tools: [{
      type: "function", name: "lookup", description: "  Find a record.\n", defer_loading: true,
      parameters: { type: "object", properties: { limit: { type: "integer", default: 3 } }, additionalProperties: false },
    }],
  }];
  const items = [
    { type: "web_search_call", id: "ws-1", status: "completed", action: { type: "search", queries: ["project docs"], sources: [{ type: "url", url: "https://example.com/docs" }] } },
    { type: "tool_search_call", execution: "server", call_id: null, status: "completed", arguments: { paths: ["catalog"] } },
    { type: "tool_search_output", execution: "server", call_id: null, status: "completed", tools },
    { type: "tool_search_call", execution: "client", call_id: "search-1", arguments: ' { "goal": "lookup" }\n' },
    { type: "tool_search_output", execution: "client", call_id: "search-1", tools },
    { type: "tool_search_call", arguments: { paths: [] } },
  ];
  const prepared = prepareWithTools(items);
  assert.deepEqual(prepared.items.slice(1, -1), items);
  assert.equal(prepared.truncation, undefined);
});

test("structured search fields use nested redaction and binary omission without JSON string wrapping", () => {
  const items = [{
    type: "tool_search_call", execution: "server", call_id: null,
    arguments: {
      paths: [`${homedir()}/private/project`], password: "synthetic-password", token: 12345,
      note: '  Request failed\nAuthorization: synthetic-auth-value\n',
      quoted: '{"password":"synthetic-quoted-secret"}',
      headers: { Authorization: "synthetic-header-secret", "Proxy-Authorization": "synthetic-proxy-secret",
        Cookie: "session=synthetic-cookie-secret", "Set-Cookie": "session=synthetic-set-cookie-secret" },
      access_token: ["synthetic-array-secret", 6789],
      image: "data:image/png;base64,AAAA", bytes: { type: "Buffer", data: [1, 2] },
      attachment: { type: "audio", data: "AAAA" },
      keep: [false, null, 42],
    },
  }, {
    type: "web_search_call", action: { type: "open_page", url: "https://example.com/?token=synthetic-url-secret" },
  }, {
    type: "tool_search_output", tools: [{ type: "function", name: "lookup", description: `Read ${homedir()}/private.` }],
  }];
  const original = structuredClone(items);
  const prepared = prepareWithTools(items);
  const argumentsValue = prepared.items[1].arguments;
  assert.equal(typeof argumentsValue, "object");
  assert.deepEqual(argumentsValue.keep, [false, null, 42]);
  assert.equal(argumentsValue.password, "[REDACTED:CREDENTIAL]");
  assert.equal(argumentsValue.token, "[REDACTED:CREDENTIAL]");
  assert.deepEqual(argumentsValue.headers, {
    Authorization: "[REDACTED:AUTH_TOKEN]", "Proxy-Authorization": "[REDACTED:AUTH_TOKEN]",
    Cookie: "[REDACTED:COOKIE]", "Set-Cookie": "[REDACTED:COOKIE]",
  });
  assert.deepEqual(argumentsValue.access_token, ["[REDACTED:CREDENTIAL]", "[REDACTED:CREDENTIAL]"]);
  assert.equal(argumentsValue.image, "[BINARY_CONTENT_OMITTED]");
  assert.equal(argumentsValue.bytes, "[BINARY_CONTENT_OMITTED]");
  assert.deepEqual(argumentsValue.attachment, { type: "audio", data: "[BINARY_CONTENT_OMITTED]" });
  assert.match(argumentsValue.note, /REDACTED:AUTH_TOKEN/);
  assert.match(argumentsValue.quoted, /REDACTED:CREDENTIAL/);
  assert.equal(prepared.items[2].action.url, "https://example.com/?token=[REDACTED:CREDENTIAL]");
  assert.equal(prepared.items[3].tools[0].description, "Read [REDACTED:LOCAL_PATH]/private.");
  assert.doesNotMatch(JSON.stringify(prepared), /synthetic-(?:password|auth-value|quoted-secret|url-secret)|base64,AAAA/);
  assert.equal(JSON.stringify(prepared).includes(homedir()), false);
  assert.deepEqual(items, original);
});

test("nested search strings are bounded and counted independently", () => {
  const prepared = prepareWithTools([{
    type: "tool_search_output", tools: [{
      type: "function", name: "lookup", description: "x".repeat(128_001),
      parameters: { type: "object", properties: { query: { type: "string", description: "中".repeat(128_001) } } },
    }],
  }]);
  assert.equal(prepared.items[1].tools[0].description.length, 128_000);
  assert.equal(prepared.items[1].tools[0].parameters.properties.query.description.length, 128_000);
  assert.deepEqual(prepared.truncation, { original_item_count: 3, truncated_text_fields: 2 });
});

test("oversized structured search records are omitted whole within the existing Turn budget", () => {
  const recent = { type: "web_search_call", action: { type: "find_in_page", url: "https://example.com/docs", pattern: "result" } };
  const prepared = prepareWithTools([{
    type: "tool_search_output", tools: Array.from({ length: 8 }, (_, index) => ({
      type: "function", name: `lookup_${index}`, description: "中".repeat(128_000),
    })),
  }, recent]);
  assert.deepEqual(prepared.items.slice(1, -1), [recent]);
  assert.deepEqual(prepared.truncation, { original_item_count: 4, truncated_text_fields: 0 });
  assert.ok(Buffer.byteLength(JSON.stringify(prepared)) <= CODING_TURN_MAX_BYTES);
});

test("client tool search still requires call identity and cannot turn into a hosted search", () => {
  const prepared = prepareWithTools([
    { type: "tool_search_call", execution: "client", call_id: null, arguments: {} },
    { type: "tool_search_output", execution: "client", tools: [] },
    { type: "tool_search_call", execution: "server", call_id: " ", arguments: {} },
    { type: "tool_search_output", execution: "unknown", tools: [] },
  ]);
  assert.deepEqual(prepared.items.map((item) => item.type), ["message", "message"]);
  assert.deepEqual(prepared.truncation, { original_item_count: 6, truncated_text_fields: 0 });
});

function prepareWithTools(items) {
  return prepareCodingSessionTurn({
    client: "codex", sessionId: "session-1", turnId: "turn-1", turnIndex: 1,
    outcome: "completed", closedAt: "2026-08-30T08:00:00Z",
    items: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "Inspect the project." }] },
      ...items,
      { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Inspection complete." }] },
    ],
  });
}
