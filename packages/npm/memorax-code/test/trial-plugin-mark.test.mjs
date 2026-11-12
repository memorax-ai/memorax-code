import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import test from "node:test";
import {
  createTrialMacHash,
  deriveTrialPluginIdentity,
  generateTrialPluginIdentity,
  TRIAL_APP_SALT,
  TRIAL_MARK_VERSION,
} from "../lib/trial-plugin-mark.mjs";

const DEVICE = Object.freeze({
  markVersion: 1,
  appSalt: "memorax-plugin-v1",
  machineId: "550e8400-e29b-41d4-a716-446655440000",
  hostname: "DESKTOP-DEMO",
  platform: "windows",
  arch: "x86_64",
  macHash: "b".repeat(64),
});
const GOLDEN_MARK_ID = "mk_e07c335dfbdd06d4752cf8a17e7d4f82555bf4828d82a8efa7cc5b527d4c858e";

test("trial identity tolerates a slow Windows machine ID query", (t) => {
  t.mock.method(os, "platform", () => "win32");
  t.mock.method(os, "hostname", () => DEVICE.hostname);
  t.mock.method(os, "networkInterfaces", () => ({}));
  t.mock.method(childProcess, "spawnSync", (command, args, options) => {
    assert.equal(command, "reg.exe");
    assert.deepEqual(args, ["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"]);
    // Simulate a valid query finishing after the old one-second deadline.
    if (options.timeout < 1_500) return { status: null, error: { code: "ETIMEDOUT" } };
    return { status: 0, stdout: `    MachineGuid    REG_SZ    ${DEVICE.machineId}\r\n` };
  });
  syncBuiltinESMExports();
  try {
    assert.equal(generateTrialPluginIdentity().machineId, DEVICE.machineId);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("trial identity matches the backend v1 golden vector", () => {
  assert.deepEqual(deriveTrialPluginIdentity(DEVICE), {
    ...DEVICE,
    markId: GOLDEN_MARK_ID,
  });
  assert.equal(TRIAL_MARK_VERSION, 1);
  assert.equal(TRIAL_APP_SALT, "memorax-plugin-v1");
});

test("trial identity normalizes Node platform and architecture names", () => {
  const identity = deriveTrialPluginIdentity({
    ...DEVICE,
    platform: "win32",
    arch: "x64",
  });
  assert.equal(identity.platform, "windows");
  assert.equal(identity.arch, "x86_64");
  assert.equal(identity.markId, GOLDEN_MARK_ID);
});

test("MAC hashing is stable and always returns a SHA-256 value", () => {
  const entries = [
    { internal: false, mac: "BB:00:00:00:00:02" },
    { internal: false, mac: "aa:00:00:00:00:01" },
    { internal: false, mac: "BB:00:00:00:00:02" },
    { internal: true, mac: "cc:00:00:00:00:03" },
  ];
  assert.equal(createTrialMacHash(entries), createTrialMacHash([...entries].reverse()));
  assert.equal(
    createTrialMacHash([]),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
});
