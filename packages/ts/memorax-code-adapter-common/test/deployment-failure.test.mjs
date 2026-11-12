import assert from "node:assert/strict";
import { test } from "node:test";
import { attachDeploymentFailure, deploymentFailure, projectDeploymentFailure } from "../src/deployment-failure.mjs";

test("deployment diagnostics distinguish command failures without retaining output or paths", () => {
  for (const [code, reason] of [["ENOENT", "not_found"], ["ENOEXEC", "not_runnable"], ["ETIMEDOUT", "timeout"]]) {
    const error = Object.assign(new Error("private-command-canary"), { code, path: "private-path-canary" });
    const result = deploymentFailure(error, "plugin-install", { commandResult: { error, status: null, stderr: "private-output-canary" } });
    assert.equal(result.failureReason, reason);
    assert.equal(result.systemCode, code);
    assert.doesNotMatch(JSON.stringify(result), /canary/);
  }
  assert.deepEqual(deploymentFailure(undefined, "plugin-register", { commandResult: { status: 7 } }), {
    stage: "plugin-register", errorCode: "CLIENT_PLUGIN_REGISTER_FAILED", commandExitCode: 7, failureReason: "exit_status",
  });
  assert.equal(projectDeploymentFailure({ stage: "private-canary", errorCode: "CLIENT_PRIVATE_CANARY_FAILED" }), undefined);
});

test("deployment cleanup preserves the original filesystem failure and thrown object", () => {
  const original = Object.assign(new Error("private-canary"), { code: "ENOSPC" });
  assert.equal(attachDeploymentFailure(original, "skill-stage"), original);
  const release = Object.assign(new Error("private-lock-canary", { cause: Object.assign(new Error(), { code: "EPERM" }) }), { code: "JSON_FILE_LOCK_RELEASE_FAILED" });
  const error = Object.assign(new AggregateError([original, release], "private-canary", { cause: original }), { code: "JSON_FILE_LOCK_RELEASE_FAILED" });
  const result = deploymentFailure(error, "lock");
  assert.equal(result.stage, "skill-stage");
  assert.equal(result.systemCode, "ENOSPC");
  assert.equal(result.cleanupSystemCode, "EPERM");
  assert.equal(result.cleanupErrorCode, "CLIENT_CLEANUP_FAILED");
  assert.doesNotMatch(JSON.stringify(result), /canary/);
});
