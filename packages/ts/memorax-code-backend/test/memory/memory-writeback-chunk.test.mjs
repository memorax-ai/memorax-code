import assert from "node:assert/strict";
import { test } from "node:test";
import {
  memoryWritebackAddParts,
  writebackMessagesContentChars,
} from "../../dist/memory/writeback-chunk.js";

test("memory writeback chunking emits structured lineage without repeating user context", () => {
  const parts = memoryWritebackAddParts({
    idempotencyKey: "automatic:session:turn",
    messages: [
      { role: "user", content: "short user" },
      { role: "assistant", content: "abcdefghijklmnopqrst" },
    ],
  }, {
    MEMORAX_CODE_MEMORY_WRITEBACK_CHUNK_ENABLED: "true",
    MEMORAX_CODE_MEMORY_WRITEBACK_CHUNK_MAX_CHARS: "12",
    MEMORAX_CODE_MEMORY_WRITEBACK_CHUNK_OVERLAP_RATIO: "0.25",
  });

  assert.equal(parts.length, 2);
  assert.deepEqual(parts.map((part) => part.idempotencyKey), [
    "automatic:session:turn:part:0",
    "automatic:session:turn:part:1",
  ]);
  assert.deepEqual(parts.map((part) => part.messages.map((message) => message.role)), [
    ["user", "assistant"],
    ["assistant"],
  ]);
  assert.deepEqual(parts.map((part) => part.messages.map((message) => message.content)), [
    ["short user", "abcdefghijkl"],
    ["jklmnopqrst"],
  ]);
  assert.deepEqual(parts.map((part) => part.chunk), [
    {
      group_id: "memory-writeback-chunk:v1:bb770f2bb3aeecbf5406fa4db7607d055ffc94bf690da8affb7f82e9bf4ffc2d",
      index: 0,
      count: 2,
    },
    {
      group_id: "memory-writeback-chunk:v1:bb770f2bb3aeecbf5406fa4db7607d055ffc94bf690da8affb7f82e9bf4ffc2d",
      index: 1,
      count: 2,
    },
  ]);
});

test("memory writeback chunking pairs the final long user fragment with the first assistant fragment", () => {
  const parts = memoryWritebackAddParts({
    idempotencyKey: "automatic:session:long-turn",
    messages: [
      { role: "user", content: "abcdefghijklmnopqrstuvwxyz" },
      { role: "assistant", content: "ABCDEFGHIJKLMNOPQRSTUVWXYZ" },
    ],
  }, {
    MEMORAX_CODE_MEMORY_WRITEBACK_CHUNK_ENABLED: "true",
    MEMORAX_CODE_MEMORY_WRITEBACK_CHUNK_MAX_CHARS: "10",
    MEMORAX_CODE_MEMORY_WRITEBACK_CHUNK_OVERLAP_RATIO: "0.2",
  });

  assert.deepEqual(parts.map((part) => part.messages), [
    [{ role: "user", content: "abcdefghij" }],
    [{ role: "user", content: "ijklmnopqr" }],
    [
      { role: "user", content: "qrstuvwxyz" },
      { role: "assistant", content: "ABCDEFGHIJ" },
    ],
    [{ role: "assistant", content: "IJKLMNOPQR" }],
    [{ role: "assistant", content: "QRSTUVWXYZ" }],
  ]);
  assert.equal(parts.every((part) => (
    part.messages.every((message) => message.content.length <= 10)
  )), true);
});

test("memory writeback chunking uses a bounded opaque group id", () => {
  const idempotencyKey = `automatic:${"session".repeat(100)}:turn`;
  const parts = memoryWritebackAddParts({
    idempotencyKey,
    messages: [
      { role: "user", content: "short user" },
      { role: "assistant", content: "abcdefghijklmnopqrst" },
    ],
  }, {
    MEMORAX_CODE_MEMORY_WRITEBACK_CHUNK_ENABLED: "true",
    MEMORAX_CODE_MEMORY_WRITEBACK_CHUNK_MAX_CHARS: "12",
    MEMORAX_CODE_MEMORY_WRITEBACK_CHUNK_OVERLAP_RATIO: "0.25",
  });

  const groupIds = parts.map((part) => part.chunk.group_id);
  assert.equal(new Set(groupIds).size, 1);
  assert.match(groupIds[0], /^memory-writeback-chunk:v1:[0-9a-f]{64}$/);
  assert.ok(groupIds[0].length <= 512);
  assert.notEqual(groupIds[0], idempotencyKey);
});

test("memory writeback chunking can be disabled", () => {
  const messages = [
    { role: "user", content: "short user" },
    { role: "assistant", content: "abcdefghijklmnopqrst" },
  ];

  assert.deepEqual(memoryWritebackAddParts({
    idempotencyKey: "automatic:session:turn",
    messages,
  }, {
    MEMORAX_CODE_MEMORY_WRITEBACK_CHUNK_ENABLED: "false",
    MEMORAX_CODE_MEMORY_WRITEBACK_CHUNK_MAX_CHARS: "12",
  }), [{
    idempotencyKey: "automatic:session:turn",
    messages,
  }]);
  assert.equal(writebackMessagesContentChars(messages), 30);
});
