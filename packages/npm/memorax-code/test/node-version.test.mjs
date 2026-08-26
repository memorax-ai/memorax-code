import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  MINIMUM_NODE_MAJOR,
  unsupportedNodeVersionMessage,
} from "../lib/node-version.mjs";

test("published Node engine matches the enforced runtime minimum", async () => {
  const manifest = JSON.parse(await readFile(
    new URL("../package.json", import.meta.url),
    "utf8",
  ));
  assert.equal(manifest.engines?.node, `>=${MINIMUM_NODE_MAJOR}`);
});

test("runtime version guard accepts Node 20 and newer", () => {
  assert.equal(unsupportedNodeVersionMessage("20.0.0"), undefined);
  assert.equal(unsupportedNodeVersionMessage("24.1.0"), undefined);
});

test("runtime version guard rejects older or unreadable versions", () => {
  assert.match(
    unsupportedNodeVersionMessage("19.11.1") ?? "",
    /requires Node\.js 20 or newer.*Node\.js 19\.11\.1/,
  );
  assert.match(
    unsupportedNodeVersionMessage("unknown") ?? "",
    /requires Node\.js 20 or newer.*Node\.js unknown/,
  );
});
