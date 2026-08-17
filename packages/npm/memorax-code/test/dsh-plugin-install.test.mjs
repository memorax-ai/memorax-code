import assert from "node:assert/strict";
import test from "node:test";
import {
  collectDshAdapterStatus,
  discoverDshProfiles,
  withDshPluginLifecycleLock,
} from "../lib/dsh-plugin-install.mjs";

test("DSH install wrapper loads the source lifecycle during repository tests", () => {
  assert.equal(typeof collectDshAdapterStatus, "function");
  assert.equal(typeof discoverDshProfiles, "function");
  assert.equal(typeof withDshPluginLifecycleLock, "function");
});
