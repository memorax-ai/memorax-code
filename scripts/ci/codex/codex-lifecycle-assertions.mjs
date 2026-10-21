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

const replacementFlags = ["beforePidValid", "afterPidValid", "pidChanged", "beforeInstanceValid", "afterInstanceValid",
  "instanceChanged", "endpointMatches", "healthResponded", "healthOk", "healthServiceMatches", "healthInstanceMatches"];
const replacementProcessStates = ["alive", "exited", "permission_denied", "unknown"];
const validPid = (value) => Number.isSafeInteger(value) && value > 0;
const validInstance = (value) => typeof value === "string" && value.trim().length > 0;

export function projectBackendReplacementDiagnostic(value) {
  return {
    ...Object.fromEntries(replacementFlags.map((key) => [key, typeof value?.[key] === "boolean" ? value[key] : "unknown"])),
    ...Object.fromEntries(["previousProcess", "currentProcess"].map((key) => [key,
      replacementProcessStates.includes(value?.[key]) ? value[key] : "unknown"])),
  };
}

export function assertBackendReplacement(before, after, health, observation = {}) {
  assert.ok(validPid(before?.pid) && validPid(after?.pid), "BACKEND_REPLACEMENT_PID_INVALID");
  assert.ok(observation.currentProcess === "alive", "BACKEND_REPLACEMENT_NEW_PROCESS_NOT_ALIVE");
  assert.ok(["alive", "exited"].includes(observation.previousProcess), "BACKEND_REPLACEMENT_OLD_PROCESS_UNKNOWN");
  if (after.pid !== before.pid) {
    assert.ok(observation.previousProcess === "exited", "BACKEND_REPLACEMENT_OLD_PROCESS_ALIVE");
  }
  assert.ok(validInstance(before?.instanceId) && validInstance(after?.instanceId), "BACKEND_REPLACEMENT_INSTANCE_INVALID");
  assert.ok(after.instanceId !== before.instanceId, "BACKEND_REPLACEMENT_INSTANCE_UNCHANGED");
  assert.ok(observation.endpointMatches === true, "BACKEND_REPLACEMENT_ENDPOINT_MISMATCH");
  assert.ok(observation.healthResponded === true, "BACKEND_REPLACEMENT_HEALTH_RESPONSE_FAILED");
  assert.ok(health?.ok === true, "BACKEND_REPLACEMENT_UNHEALTHY");
  assert.ok(health?.service === "memorax-code-backend", "BACKEND_REPLACEMENT_WRONG_SERVICE");
  assert.ok(health?.instanceId === after.instanceId, "BACKEND_REPLACEMENT_HEALTH_IDENTITY_MISMATCH");
}

export async function verifyBackendReplacementState(before, {
  readAfter, expectedUrl, observe, probe = (pid) => process.kill(pid, 0),
  fetchHealth = (url) => fetch(new URL("/health", url), { signal: AbortSignal.timeout(5000) }),
}) {
  const diagnostic = projectBackendReplacementDiagnostic();
  if (before !== undefined) {
    diagnostic.beforePidValid = validPid(before?.pid);
    diagnostic.beforeInstanceValid = validInstance(before?.instanceId);
  }
  let after, health;
  const failures = [];
  try {
    after = await readAfter();
    diagnostic.afterPidValid = validPid(after?.pid);
    diagnostic.afterInstanceValid = validInstance(after?.instanceId);
    if (diagnostic.beforePidValid === true && diagnostic.afterPidValid === true) diagnostic.pidChanged = before.pid !== after.pid;
    if (diagnostic.beforeInstanceValid === true && diagnostic.afterInstanceValid === true) diagnostic.instanceChanged = before.instanceId !== after.instanceId;
    for (const [key, pid] of [["previousProcess", before?.pid], ["currentProcess", after?.pid]]) {
      if (!validPid(pid)) continue;
      try { probe(pid); diagnostic[key] = "alive"; }
      catch (error) {
        diagnostic[key] = error?.code === "ESRCH" ? "exited" : error?.code === "EPERM" ? "permission_denied" : "unknown";
        if (error?.code !== "ESRCH") failures.push(error);
      }
    }
    if (typeof after?.url === "string") diagnostic.endpointMatches = after.url === expectedUrl;
    if (diagnostic.endpointMatches === true) {
      const response = await fetchHealth(after.url);
      if (typeof response?.ok === "boolean") diagnostic.healthResponded = response.ok;
      if (response?.ok === true) {
        health = await response.json();
        if (typeof health?.ok === "boolean") diagnostic.healthOk = health.ok;
        if (typeof health?.service === "string") diagnostic.healthServiceMatches = health.service === "memorax-code-backend";
        if (validInstance(health?.instanceId) && diagnostic.afterInstanceValid) diagnostic.healthInstanceMatches = health.instanceId === after.instanceId;
      }
    }
  } catch (error) { failures.push(error); }
  // Record only typed comparisons before any functional failure can unwind into cleanup.
  try { await observe?.(projectBackendReplacementDiagnostic(diagnostic)); } catch {}
  if (failures.length) throw failures[0];
  assertBackendReplacement(before, after, health, diagnostic);
  return after;
}
