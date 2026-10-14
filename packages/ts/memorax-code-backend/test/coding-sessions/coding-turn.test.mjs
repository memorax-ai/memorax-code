import assert from "node:assert/strict";
import { homedir } from "node:os";
import { test } from "node:test";
import {
  CODING_TURN_MAX_BYTES,
  codingEventText,
  codingToolOutputText,
  prepareCodingSessionTurn,
} from "../../dist/coding-sessions/coding-turn.js";

test("archive messages retain short commands and redacted-only QA for every supported client", () => {
  for (const client of ["codex", "claude-code", "opencode", "codebuddy", "workbuddy"]) {
    const tool = { type: "function_call", call_id: "call-pwd", name: "shell", arguments: '{"command":"pwd"}' };
    const turn = prepareCodingSessionTurn({
      client, sessionId: "session-1", turnId: "turn-1", turnIndex: 1,
      outcome: "completed", closedAt: "2026-08-30T08:00:00Z",
      items: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "pwd" }] },
        { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "export" }] },
        tool,
        { type: "function_call_output", call_id: "call-pwd", output: homedir() },
        { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: homedir() }] },
      ],
    });
    assert.ok(turn, client);
    assert.deepEqual(turn.items, [
      { type: "message", role: "user", content: [{ type: "input_text", text: "pwd" }] },
      { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text: "export" }] },
      tool,
      { type: "function_call_output", call_id: "call-pwd", output: "[REDACTED:LOCAL_PATH]" },
      { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "[REDACTED:LOCAL_PATH]" }] },
    ]);
    assert.equal(turn.truncation, undefined);
  }
});

test("archive text blocks are retained without judging their content", () => {
  for (const text of ["", " \n\t", "...", "[REDACTED:CREDENTIAL]", "password: synthetic-passphrase"]) {
    const items = [
      { type: "message", role: "user", content: [{ type: "input_text", text }] },
      { type: "message", role: "assistant", phase: "commentary", content: [{ type: "output_text", text }] },
      { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text }] },
    ];
    const turn = prepareCodingSessionTurn({
      client: "codex", sessionId: "session-1", turnId: "turn-1", turnIndex: 1,
      outcome: "completed", closedAt: "2026-08-30T08:00:00Z", items,
    });
    assert.ok(turn);
    const expected = text === "password: synthetic-passphrase" ? "password: [REDACTED:CREDENTIAL]" : text;
    assert.deepEqual(turn.items, items.map((item) => ({ ...item, content: [{ ...item.content[0], text: expected }] })));
    assert.equal(turn.truncation, undefined);
  }
});

test("archive QA still requires supported text blocks and valid message roles and phases", () => {
  const source = {
    client: "codex", sessionId: "session-1", turnId: "turn-1", turnIndex: 1,
    outcome: "completed", closedAt: "2026-08-30T08:00:00Z",
    items: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "pwd" }] },
      { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "..." }] },
    ],
  };
  for (const [index, replacement] of [
    [0, { ...source.items[0], content: [] }],
    [0, { ...source.items[0], content: [{ type: "output_text", text: "pwd" }] }],
    [0, { ...source.items[0], role: "system" }],
    [1, { ...source.items[1], content: [] }],
    [1, { ...source.items[1], content: [{ type: "input_text", text: "..." }] }],
    [1, { ...source.items[1], phase: "unknown" }],
  ]) {
    const items = source.items.with(index, replacement);
    assert.equal(prepareCodingSessionTurn({ ...source, items }), undefined);
  }
});

test("archive byte fitting preserves text blocks without applying content screening", () => {
  const turn = prepareCodingSessionTurn({
    client: "codex", sessionId: "session-1", turnId: "turn-1", turnIndex: 1,
    outcome: "completed", closedAt: "2026-08-30T08:00:00Z",
    items: [
      { type: "message", role: "user", content: [
        ...Array.from({ length: 3 }, () => ({ type: "input_text", text: "\u0001".repeat(128_000) })),
        { type: "input_text", text: "Inspect the project." },
      ] },
      { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Done." }] },
    ],
  });
  assert.ok(turn);
  assert.equal(turn.items.length, 2);
  assert.ok(turn.items[0].content.length > 0);
  assert.ok(turn.items[0].content.every(({ text }) => /^\u0001*$/.test(text)));
  assert.equal(turn.items[1].content[0].text, "Done.");
  assert.ok(turn.truncation.truncated_text_fields > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(turn), "utf8") <= CODING_TURN_MAX_BYTES);
});

test("tool projection preserves string formatting and structured output", () => {
  for (const value of [' { "z": 1, "a": 2 }\n', '  build failed\n', '\n']) {
    assert.equal(codingEventText(value), value);
  }
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

test("function arguments redact decoded strings without breaking JSON escapes or containers", () => {
  const args = {
    command: 'printf "first@example.test"\nAuthorization: synthetic-header-secret',
    nested: [{ contact: '"second@example.test"', keep: [null, false, 7] }],
    'third@example.test': 'value with \\ and "quotes"',
  };
  const original = structuredClone(args);
  const prepared = prepareWithTools([{
    type: "function_call", call_id: "call-1", name: "inspect", arguments: JSON.stringify(args),
  }]);
  const decoded = JSON.parse(prepared.items[1].arguments);
  assert.deepEqual(decoded, {
    command: 'printf "[REDACTED:EMAIL]"\nAuthorization: [REDACTED:AUTH_TOKEN]',
    nested: [{ contact: '"[REDACTED:EMAIL]"', keep: [null, false, 7] }],
    '[REDACTED:EMAIL]': 'value with \\ and "quotes"',
  });
  assert.deepEqual(args, original);
  assert.equal(prepared.truncation, undefined);
});

test("function argument JSON retains credential, numeric, local-path, and binary redaction", () => {
  const args = {
    password: "synthetic-password", token: 12345, secret: true,
    headers: { Authorization: "synthetic-auth-value", Cookie: "session=synthetic-cookie-value" },
    access_token: ["synthetic-array-secret", 6789],
    client_secret: { nested: "synthetic-object-secret" },
    path: homedir() + "/private/file", contactNumber: 123456789012,
    quoted: '{"password":"synthetic-quoted-secret"}',
    image: "data:image/png;base64,AAAA", bytes: { type: "Buffer", data: [1, 2] },
    keep: [null, false, 42], placeholder: "[REDACTED:EMAIL]",
  };
  const prepared = prepareWithTools([{
    type: "function_call", call_id: "call-1", name: "inspect", arguments: JSON.stringify(args),
  }]);
  const decoded = JSON.parse(prepared.items[1].arguments);
  assert.equal(decoded.password, "[REDACTED:CREDENTIAL]");
  assert.equal(decoded.token, "[REDACTED:CREDENTIAL]");
  assert.equal(decoded.secret, "[REDACTED:CREDENTIAL]");
  assert.equal(decoded.client_secret, "[REDACTED:CREDENTIAL]");
  assert.deepEqual(decoded.headers, { Authorization: "[REDACTED:AUTH_TOKEN]", Cookie: "[REDACTED:COOKIE]" });
  assert.deepEqual(decoded.access_token, ["[REDACTED:CREDENTIAL]", "[REDACTED:CREDENTIAL]"]);
  assert.equal(decoded.path, "[REDACTED:LOCAL_PATH]/private/file");
  assert.equal(decoded.contactNumber, "[REDACTED:LONG_NUMBER]");
  assert.equal(decoded.image, "[BINARY_CONTENT_OMITTED]");
  assert.equal(decoded.bytes, "[BINARY_CONTENT_OMITTED]");
  assert.deepEqual(decoded.keep, [null, false, 42]);
  assert.equal(decoded.placeholder, "[REDACTED:EMAIL]");
  assert.doesNotMatch(prepared.items[1].arguments, /synthetic-(?:password|auth-value|cookie-value|array-secret|object-secret|quoted-secret)|123456789012|base64,AAAA/);
});

test("sensitive argument values remain redacted when the field name is also redacted", () => {
  for (const value of ["synthetic-passphrase", { nested: "synthetic-passphrase" }, ["synthetic-passphrase"]]) {
    const prepared = prepareWithTools([{
      type: "function_call", call_id: "call-1", name: "inspect",
      arguments: JSON.stringify({ "account-123456789-password": value }),
    }]);
    const decoded = JSON.parse(prepared.items[1].arguments);
    assert.deepEqual(decoded, {
      "account-[REDACTED:LONG_NUMBER]-password": Array.isArray(value) ? ["[REDACTED:CREDENTIAL]"] : "[REDACTED:CREDENTIAL]",
    });
    assert.doesNotMatch(prepared.items[1].arguments, /synthetic-passphrase/);
  }
});

test("function argument JSON preserves root types and unchanged native formatting", () => {
  for (const text of [' { "z": 1, "a": 2 }\n', ' [true, null, 7] ', ' "plain text" ', ' false ', ' null ', ' 12 ']) {
    const prepared = prepareWithTools([{ type: "function_call", call_id: "call-1", name: "inspect", arguments: text }]);
    assert.equal(prepared.items[1].arguments, text);
    assert.deepEqual(JSON.parse(prepared.items[1].arguments), JSON.parse(text));
  }
  for (const [args, expected] of [[123456789012, "[REDACTED:LONG_NUMBER]"], ['"first@example.test"', '"[REDACTED:EMAIL]"']]) {
    const prepared = prepareWithTools([{ type: "function_call", call_id: "call-1", name: "inspect", arguments: JSON.stringify(args) }]);
    assert.equal(JSON.parse(prepared.items[1].arguments), expected);
  }
});

test("large integer argument literals remain redacted after numeric parsing", () => {
  for (const text of ['1000000000000000000000000000000', '{"value":1000000000000000000000000000000}', '1e400']) {
    const prepared = prepareWithTools([{ type: "function_call", call_id: "call-1", name: "inspect", arguments: text }]);
    const decoded = JSON.parse(prepared.items[1].arguments);
    assert.deepEqual(decoded, text.startsWith("{") ? { value: "[REDACTED:LONG_NUMBER]" } : "[REDACTED:LONG_NUMBER]");
  }
});

test("discarded duplicate argument values cannot bypass raw credential or path redaction", () => {
  const inputs = [
    ['{"password":"synthetic-passphrase","password":"<password>"}', { password: "<password>" }],
    ['{"path":' + JSON.stringify(homedir() + '/private') + ',"path":"public"}', { path: "public" }],
  ];
  for (const [text, expected] of inputs) {
    const prepared = prepareWithTools([{ type: "function_call", call_id: "call-1", name: "inspect", arguments: text }]);
    assert.deepEqual(JSON.parse(prepared.items[1].arguments), expected);
    assert.doesNotMatch(prepared.items[1].arguments, /synthetic-passphrase/);
    assert.equal(prepared.items[1].arguments.includes(homedir()), false);
  }
});

test("underflowed argument exponents cannot bypass raw numeric redaction", () => {
  const prepared = prepareWithTools([{
    type: "function_call", call_id: "call-1", name: "inspect", arguments: '{"value":1e-123456789}',
  }]);
  assert.deepEqual(JSON.parse(prepared.items[1].arguments), { value: 0 });
  assert.doesNotMatch(prepared.items[1].arguments, /123456789/);
});

test("malformed native function arguments retain redacted text without inventing JSON", () => {
  const prepared = prepareWithTools([{
    type: "function_call", call_id: "call-1", name: "inspect", arguments: 'email=first@example.test; {unfinished',
  }]);
  assert.equal(prepared.items[1].arguments, 'email=[REDACTED:EMAIL]; {unfinished');
});

test("function arguments exceeding the text limit are omitted whole with QA and results retained", () => {
  for (const args of [{ payload: "x".repeat(128_001) }, { left: "x".repeat(64_000), right: "y".repeat(64_000) }]) {
    const output = { type: "function_call_output", call_id: "call-1", output: "Inspection complete." };
    const prepared = prepareWithTools([
      { type: "function_call", call_id: "call-1", name: "inspect", arguments: JSON.stringify(args) }, output,
    ]);
    assert.deepEqual(prepared.items.map((item) => item.type), ["message", "function_call_output", "message"]);
    assert.deepEqual(prepared.items[1], output);
    assert.deepEqual(prepared.truncation, { original_item_count: 4, truncated_text_fields: 1 });
  }
});

test("function arguments are not sliced into invalid JSON under Turn byte pressure", () => {
  const outputs = Array.from({ length: 5 }, (_, index) => ({
    type: "function_call_output", call_id: "call-" + index, output: "中".repeat(128_000),
  }));
  const prepared = prepareWithTools([
    { type: "function_call", call_id: "call-0", name: "inspect", arguments: JSON.stringify({ payload: "文".repeat(100_000) }) },
    ...outputs,
  ]);
  assert.deepEqual(prepared.items.slice(1, -1), outputs);
  assert.deepEqual(prepared.truncation, { original_item_count: 8, truncated_text_fields: 0 });
  assert.ok(Buffer.byteLength(JSON.stringify(prepared), "utf8") <= CODING_TURN_MAX_BYTES);
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
