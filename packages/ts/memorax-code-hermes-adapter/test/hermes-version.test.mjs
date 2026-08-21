import test from "node:test";
import assert from "node:assert/strict";

import {
  HERMES_TESTED_VERSIONS,
  isTestedHermesVersion,
  parseHermesVersion,
} from "../src/hermes-version.mjs";

test("parseHermesVersion parses tested version banner", () => {
  assert.equal(parseHermesVersion("Hermes Agent v0.20.3 (2026.8.16.2)"), "0.20.3");
});

test("parseHermesVersion parses bare version", () => {
  assert.equal(parseHermesVersion("0.20.3"), "0.20.3");
});

test("parseHermesVersion rejects non-version output", () => {
  assert.equal(parseHermesVersion("usage: hermes [command]"), undefined);
  assert.equal(parseHermesVersion(""), undefined);
  assert.equal(parseHermesVersion(undefined), undefined);
  assert.equal(parseHermesVersion("v1.2.3 (2026)"), "1.2.3");
});

test("HERMES_TESTED_VERSIONS covers the current tested release", () => {
  assert.ok(HERMES_TESTED_VERSIONS.includes("0.20.3"));
  assert.equal(isTestedHermesVersion("0.20.3"), true);
  assert.equal(isTestedHermesVersion("0.99.0"), false);
});
