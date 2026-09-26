import assert from "node:assert/strict";
import test from "node:test";
import { assertBackendReplacement, assertCredentialNotEchoed, assertSetupInputRejection } from "./codex-lifecycle-assertions.mjs";

test("invalid setup input requires the public rejection, not an arbitrary process failure", () => {
  const expected = { code: 2, signal: null, killed: false,
    stderr: "memorax-code setup: stdin must contain one non-empty API Key\n",
    stdout: "Usage: memorax-code setup [--existing-account | --reconfigure]\n" };
  assert.doesNotThrow(() => assertSetupInputRejection(expected));
  for (const unexpected of [
    { code: 1, stderr: "TypeError: cannot read properties of undefined\n" },
    { code: 2, stderr: "memorax-code setup: Cannot read properties of undefined\n" },
    { code: 2, signal: "SIGTERM" },
    { code: 2, killed: true },
    { code: 0 },
    { stdout: "" },
  ]) assert.throws(() => assertSetupInputRejection({ ...expected, ...unexpected }));
});

test("masked prompts cannot hide a credential echoed through ANSI styling or repainting", () => {
  const key = "sk_fixture_credential_canary";
  assert.doesNotThrow(() => assertCredentialNotEchoed(`API key: ${"*".repeat(key.length)}\r\n`, key));
  for (const leaked of [key, `${key.slice(0, 8)}\x1b[0m${key.slice(8)}`,
    [...key].join("\x1b[32m"), `${key.slice(0, 8)}\x1b[1C${key.slice(8)}`]) {
    assert.throws(() => assertCredentialNotEchoed(`${"*".repeat(key.length)}\n${leaked}`, key),
      /TERMINAL_DISCLOSED_FIXTURE_CREDENTIAL/);
  }
});

test("package replacement requires a new live identity and retirement of the previous process", () => {
  const before = { pid: 101, instanceId: "old-instance" };
  const after = { pid: 202, instanceId: "new-instance" };
  const health = { ok: true, service: "memorax-code-backend", instanceId: "new-instance" };
  assert.doesNotThrow(() => assertBackendReplacement(before, after, health, false));
  for (const [current, response, alive] of [
    [before, { ...health, instanceId: "old-instance" }, true],
    [{ ...after, instanceId: "old-instance" }, health, false],
    [after, health, true],
    [after, { ...health, instanceId: "old-instance" }, false],
    [after, { ...health, ok: false }, false],
    [after, { ...health, service: "unrelated-service" }, false],
  ]) assert.throws(() => assertBackendReplacement(before, current, response, alive));
});
