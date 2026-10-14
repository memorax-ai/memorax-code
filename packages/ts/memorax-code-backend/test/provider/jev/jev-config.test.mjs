import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { jevConfigFromEnv, jevConfigStatus } from "../../../dist/provider/jev/config.js";

const enabledConfig = { jev: { enabled: true, api_key: "fixture-file-key" } };

test("Jev requires explicit enablement and a key, with content-free configuration status", (t) => {
  const fetch = t.mock.method(globalThis, "fetch", () => { throw new Error("status must not contact Jev"); });
  assert.deepEqual(jevConfigStatus({}, {}), { enabled: false, state: "disabled" });
  assert.deepEqual(jevConfigFromEnv({}, { jev: { api_key: "fixture-file-key" } }), { ok: false, reason: "disabled" });
  assert.deepEqual(jevConfigStatus({ MEMORAX_CODE_JEV_API_KEY: "fixture-env-key" }, {}), { enabled: false, state: "disabled" });
  assert.deepEqual(jevConfigStatus({}, { jev: { enabled: true } }), { enabled: true, state: "missing_key" });
  assert.deepEqual(jevConfigStatus({}, enabledConfig), { enabled: true, state: "configured" });
  assert.deepEqual(jevConfigFromEnv({ MEMORAX_CODE_JEV_ENABLED: "false" }, enabledConfig), { ok: false, reason: "disabled" });
  assert.equal(fetch.mock.callCount(), 0);
  assert.doesNotMatch(JSON.stringify(jevConfigStatus({}, enabledConfig)), /fixture|apiKey|api_key/);
});

test("Jev environment overrides cannot turn malformed enablement into permission", () => {
  assert.deepEqual(jevConfigFromEnv({
    MEMORAX_CODE_JEV_ENABLED: " TRUE ",
    MEMORAX_CODE_JEV_API_KEY: " fixture-env-key ",
  }, { jev: { enabled: false, api_key: "fixture-file-key" } }), {
    ok: true, config: { apiKey: "fixture-env-key" },
  });
  for (const value of ["", "truthy", "1"]) {
    assert.deepEqual(jevConfigFromEnv({ MEMORAX_CODE_JEV_ENABLED: value }, enabledConfig), {
      ok: false, reason: "invalid_config",
    });
  }
  assert.deepEqual(jevConfigStatus({ MEMORAX_CODE_JEV_ENABLED: "invalid" }, enabledConfig), {
    enabled: false, state: "invalid_config",
  });
});

test("Jev reloads its private config for disablement and key rotation without logging malformed source", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-jev-config-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const configPath = join(home, "config.toml");
  const env = { MEMORAX_CODE_HOME: home };
  const warnings = t.mock.method(console, "warn", () => {});
  assert.deepEqual(jevConfigStatus(env), { enabled: false, state: "disabled" });
  await assert.rejects(readFile(configPath), { code: "ENOENT" });

  await writeFile(configPath, '[jev]\nenabled = true\napi_key = "fixture-first-key"\n');
  assert.deepEqual(jevConfigFromEnv(env), { ok: true, config: { apiKey: "fixture-first-key" } });
  await writeFile(configPath, '[jev]\nenabled = true\napi_key = "fixture-rotated-key"\n');
  assert.deepEqual(jevConfigFromEnv(env), { ok: true, config: { apiKey: "fixture-rotated-key" } });
  await writeFile(configPath, '[jev]\nenabled = false\napi_key = "fixture-rotated-key"\n');
  assert.deepEqual(jevConfigFromEnv(env), { ok: false, reason: "disabled" });

  await writeFile(configPath, '[jev]\nenabled = "true"\napi_key = "fixture-rotated-key"\n');
  assert.deepEqual(jevConfigFromEnv(env), { ok: false, reason: "disabled" });
  await writeFile(configPath, '[jev]\nenabled = true\napi_key = "fixture-secret-must-not-leak\n');
  assert.deepEqual(jevConfigFromEnv(env), { ok: false, reason: "invalid_config" });
  assert.deepEqual(jevConfigStatus(env), { enabled: false, state: "invalid_config" });
  assert.equal(warnings.mock.callCount(), 0);
});
