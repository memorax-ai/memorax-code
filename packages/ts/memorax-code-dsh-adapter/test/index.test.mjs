import assert from "node:assert/strict";
import { test } from "node:test";
import { apply, name } from "../src/index.mjs";

function recordingCtx() {
  const handlers = {};
  return {
    handlers,
    on(event, handler) {
      handlers[event] = handler;
    },
  };
}

test("apply tolerates a null or missing plugin config", () => {
  for (const config of [null, undefined, {}]) {
    const ctx = recordingCtx();
    assert.doesNotThrow(() => apply(ctx, config));
    assert.equal(typeof ctx.handlers["session/created"], "function");
    assert.equal(typeof ctx.handlers["session/event"], "function");
    assert.equal(typeof ctx.handlers["session/disposed"], "function");
  }
});

test("the DSH adapter exposes the memorax-dsh plugin name", () => {
  assert.equal(name, "memorax-dsh");
});
