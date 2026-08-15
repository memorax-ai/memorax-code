import assert from "node:assert/strict";
import test from "node:test";

import { createDshUserMessage } from "../src/dsh-message.mjs";

test("creates a detached and deeply frozen DSH UserMessage", () => {
  const input = {
    content: [{ type: "text", text: "memory" }],
    source: { kind: "plugin", plugin: "memorax-code-dsh", form: "recall" },
  };
  const message = createDshUserMessage(input);

  assert.match(message.id, /^[0-9a-f-]{36}$/);
  assert.equal(message.role, "user");
  assert.deepEqual(message.content, input.content);
  assert.notEqual(message.content, input.content);
  assert.equal(Object.isFrozen(message), true);
  assert.equal(Object.isFrozen(message.content), true);
  assert.equal(Object.isFrozen(message.content[0]), true);
  input.content[0].text = "changed";
  assert.equal(message.content[0].text, "memory");
});
