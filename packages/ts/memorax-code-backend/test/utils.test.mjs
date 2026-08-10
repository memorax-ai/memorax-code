import assert from "node:assert/strict";
import { test } from "node:test";
import { isRecord } from "../dist/shared/record.js";

test("isRecord accepts plain records and rejects arrays or nullish values", () => {
  assert.equal(isRecord({ key: "value" }), true);
  assert.equal(isRecord(Object.create(null)), true);
  assert.equal(isRecord([]), false);
  assert.equal(isRecord(null), false);
  assert.equal(isRecord("text"), false);
});
