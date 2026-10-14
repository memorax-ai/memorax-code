import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";

const accountFields = ["user_id", "api_key", "endpoint"];
const protectedSettings = ["memory.writeback.enabled", "memory.cli.add_enabled", "jev.enabled"];

function readSetting(config, path) {
  return path.split(".").reduce((value, key) => value?.[key], config);
}

// Only fields intentionally configured by the fixture are protected. Runtime
// paths and other managed defaults may migrate; newly discovered clients may appear.
export function snapshotProtectedConfiguration(config) {
  const account = {};
  for (const field of accountFields) {
    const value = config?.memorax?.[field];
    assert.ok(typeof value === "string" && value.trim().length > 0,
      `PROTECTED_ACCOUNT_FIXTURE_INVALID_${field.toUpperCase()}`);
    account[field] = value;
  }
  return {
    account,
    clients: Object.fromEntries(Object.entries(config.clients ?? {}).filter(([, value]) => typeof value === "boolean")),
    settings: Object.fromEntries(protectedSettings.filter((path) => typeof readSetting(config, path) === "boolean")
      .map((path) => [path, readSetting(config, path)])),
  };
}

export function assertProtectedConfiguration(actual, expected) {
  // Use boolean assertions so failures cannot print credentials as expected/actual.
  for (const field of accountFields) {
    assert.ok(actual?.memorax?.[field] === expected.account[field],
      `PROTECTED_ACCOUNT_CHANGED_${field.toUpperCase()}`);
  }
  for (const [client, enabled] of Object.entries(expected.clients)) {
    assert.ok(actual?.clients?.[client] === enabled, "PROTECTED_CLIENT_CHOICE_CHANGED");
  }
  for (const [path, value] of Object.entries(expected.settings)) {
    assert.ok(readSetting(actual, path) === value, "PROTECTED_FEATURE_CHOICE_CHANGED");
  }
}

export function assertSetupInputRejection(result) {
  assert.equal(result.code, 2, "SETUP_INPUT_REJECTION_EXIT_MISMATCH");
  assert.ok(!result.signal && !result.killed, "SETUP_INPUT_REJECTION_INTERRUPTED");
  assert.equal(stripVTControlCharacters(result.stderr ?? "").trim(),
    "memorax-code setup: stdin must contain one non-empty API Key",
    "SETUP_INPUT_REJECTION_DIAGNOSTIC_MISMATCH");
  assert.match(result.stdout ?? "", /^Usage: memorax-code setup /,
    "SETUP_INPUT_REJECTION_HELP_MISSING");
}

export function assertCredentialNotEchoed(output, credential) {
  assert.ok(typeof credential === "string" && credential.length > 0, "EMPTY_CREDENTIAL_CANARY");
  assert.ok(!output.includes(credential) && !stripVTControlCharacters(output).includes(credential),
    "TERMINAL_DISCLOSED_FIXTURE_CREDENTIAL");
}

export function assertBackendReplacement(before, after, health, oldProcessAlive) {
  assert.ok(Number.isSafeInteger(before.pid) && before.pid > 0
    && Number.isSafeInteger(after.pid) && after.pid > 0, "BACKEND_REPLACEMENT_PID_INVALID");
  assert.notEqual(after.pid, before.pid, "BACKEND_REPLACEMENT_PID_UNCHANGED");
  assert.equal(oldProcessAlive, false, "BACKEND_REPLACEMENT_OLD_PROCESS_ALIVE");
  assert.ok(typeof before.instanceId === "string" && before.instanceId.length > 0
    && typeof after.instanceId === "string" && after.instanceId.length > 0,
    "BACKEND_REPLACEMENT_INSTANCE_INVALID");
  assert.notEqual(after.instanceId, before.instanceId, "BACKEND_REPLACEMENT_INSTANCE_UNCHANGED");
  assert.equal(health.ok, true, "BACKEND_REPLACEMENT_UNHEALTHY");
  assert.equal(health.service, "memorax-code-backend", "BACKEND_REPLACEMENT_WRONG_SERVICE");
  assert.equal(health.instanceId, after.instanceId, "BACKEND_REPLACEMENT_HEALTH_IDENTITY_MISMATCH");
}
