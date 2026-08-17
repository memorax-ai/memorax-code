import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  createTrialMacHash,
  deriveTrialPluginIdentity,
  deriveTrialPluginMark,
  generateTrialPluginIdentity,
  generateTrialPluginMark,
} from "../lib/trial-plugin-mark.mjs";

const FIELDS = Object.freeze({
  appSalt: "@memorax/memorax-code@0.1.2",
  machineId: "8de277067b3544d4b65c267d0edab928",
  hostname: "Developer-Laptop",
  platform: "Linux",
  arch: "X64",
  macHash: "39d902aba3f789635208452e37cfacc66f2b3673eb4f23a98f1457b832d78a2a",
});

test("plugin identity matches the service material golden vector", () => {
  assert.deepEqual(deriveTrialPluginIdentity(FIELDS), {
    appSalt: "@memorax/memorax-code@0.1.2",
    machineIdHash: "9c68dde752b9d1abaa475e2cd895eb0fbc8e29b05e3cab1430c01cc964c38c3d",
    hostname: "developer-laptop",
    platform: "linux",
    arch: "x64",
    macHash: "39d902aba3f789635208452e37cfacc66f2b3673eb4f23a98f1457b832d78a2a",
    pluginMark: "mk_8eddbf5e4d57a29b783ababa63bd16b8",
  });
});

test("plugin mark has the required format and every field affects it", () => {
  const baseline = deriveTrialPluginMark(FIELDS);
  assert.match(baseline, /^mk_[0-9a-f]{32}$/);

  for (const field of Object.keys(FIELDS)) {
    assert.notEqual(
      deriveTrialPluginMark({ ...FIELDS, [field]: `${FIELDS[field]}changed` }),
      baseline,
      field,
    );
  }
});

test("machine fields are trimmed and lowercased while app salt keeps package casing", () => {
  assert.equal(
    deriveTrialPluginMark({
      ...FIELDS,
      machineId: `  ${FIELDS.machineId.toUpperCase()}  `,
      hostname: `  ${FIELDS.hostname.toUpperCase()}  `,
      platform: "  LINUX  ",
      arch: "  x64  ",
      macHash: `  ${FIELDS.macHash.toUpperCase()}  `,
    }),
    deriveTrialPluginMark(FIELDS),
  );
  assert.notEqual(
    deriveTrialPluginMark({ ...FIELDS, appSalt: FIELDS.appSalt.toUpperCase() }),
    deriveTrialPluginMark(FIELDS),
  );
});

test("MAC hashing ignores internal and invalid entries, then deduplicates and sorts", () => {
  const entries = [
    { internal: false, mac: " AA:BB:CC:DD:EE:FF " },
    { internal: false, mac: "11-22-33-44-55-66" },
    { internal: false, mac: "aa-bb-cc-dd-ee-ff" },
    { internal: true, mac: "22:22:22:22:22:22" },
    { internal: false, mac: "00:00:00:00:00:00" },
    { internal: false, mac: "not-a-mac" },
  ];
  const expected = createHash("sha256")
    .update("112233445566aabbccddeeff", "utf8")
    .digest("hex");

  assert.equal(createTrialMacHash(entries), expected);
  assert.equal(createTrialMacHash([...entries].reverse()), expected);
  assert.equal(createTrialMacHash([]), "");
});

test("runtime generation returns only normalized provision inputs", () => {
  const identity = generateTrialPluginIdentity();
  assert.match(identity.pluginMark, /^mk_[0-9a-f]{32}$/);
  assert.match(identity.machineIdHash, /^(?:|[0-9a-f]{64})$/);
  assert.equal(Object.hasOwn(identity, "machineId"), false);
  assert.equal(generateTrialPluginMark().startsWith("mk_"), true);
});
