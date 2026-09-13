import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
  printLifecycleResult,
  printMemoraxCodeStatus,
} from "../../dist/entrypoints/backend-cli.js";
import { diagnoseLifecycleReport } from "../../dist/lifecycle/cli-diagnostics.js";

const readyAdapter = { ok: true, installed: true, enabled: true, integration: "hooks" };
const backend = { ok: true, action: "start", url: "http://127.0.0.1:8787" };

test("Backend failure projection retains safe primary and cleanup evidence without recording raw reports", (t) => {
  const home = mkdtempSync(join(tmpdir(), "memorax-backend-diagnostic-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const rawError = `private-canary-token at ${home}`;
  const diagnosed = diagnoseLifecycleReport({
    ok: false,
    action: "restart",
    backend: {
      ok: false, action: "start", error: rawError,
      errorCode: "BACKEND_HEALTH_NOT_READY", stage: "health",
      failureReason: "http_error", httpStatus: 503,
      processState: "unknown", cleanupErrorCode: "BACKEND_TERMINATE_FAILED", cleanupSystemCode: "EPERM",
    },
  }, { home });
  assert.equal(diagnosed.backend.error, rawError);
  const text = readFileSync(diagnosed.diagnostic.path, "utf8");
  const record = JSON.parse(text);
  assert.equal(record.operation, "backend.restart");
  assert.equal(record.errorCode, "BACKEND_HEALTH_NOT_READY");
  assert.equal(record.failureReason, "http_error");
  assert.equal(record.httpStatus, 503);
  assert.equal(record.processState, "unknown");
  assert.equal(record.cleanupErrorCode, "BACKEND_TERMINATE_FAILED");
  assert.equal(record.cleanupSystemCode, "EPERM");
  assert.equal(text.includes(home), false);
  assert.equal(text.includes("private-canary-token"), false);
  const stderr = [];
  t.mock.method(console, "log", () => {});
  t.mock.method(console, "error", (line) => stderr.push(line));
  const suppression = process.env.MEMORAX_CODE_BACKEND_SUPPRESS_GUIDANCE;
  t.after(() => {
    if (suppression === undefined) delete process.env.MEMORAX_CODE_BACKEND_SUPPRESS_GUIDANCE;
    else process.env.MEMORAX_CODE_BACKEND_SUPPRESS_GUIDANCE = suppression;
  });
  process.env.MEMORAX_CODE_BACKEND_SUPPRESS_GUIDANCE = "1";
  printLifecycleResult(diagnosed);
  assert.match(stderr.join("\n"), /BACKEND_HEALTH_NOT_READY.*backend.restart/);
  assert.match(stderr.join("\n"), /Last observation:.*HTTP 503/);
  assert.match(stderr.join("\n"), /Cleanup also failed: BACKEND_TERMINATE_FAILED \(EPERM\)/);
  for (const report of [
    { ok: true, action: "start", backend },
    { ok: false, action: "start", backend, traeAdapter: { ok: false } },
    { ok: false, action: "uninstall", backend: { ok: false } },
  ]) assert.equal(diagnoseLifecycleReport(report, { home }), report);
  assert.equal(readdirSync(join(home, "runtime", "diagnostics")).length, 1);
});

function captureReport(t, print, report) {
  const lines = [];
  const logger = t.mock.method(console, "log", (line) => lines.push(line));
  const suppression = process.env.MEMORAX_CODE_BACKEND_SUPPRESS_GUIDANCE;
  delete process.env.MEMORAX_CODE_BACKEND_SUPPRESS_GUIDANCE;
  try {
    print(report);
    return stripVTControlCharacters(lines.join("\n"));
  } finally {
    logger.mock.restore();
    if (suppression === undefined) delete process.env.MEMORAX_CODE_BACKEND_SUPPRESS_GUIDANCE;
    else process.env.MEMORAX_CODE_BACKEND_SUPPRESS_GUIDANCE = suppression;
  }
}

for (const { key, name, label } of [
  { key: "codebuddyAdapter", name: "CodeBuddy CLI", label: "CodeBuddy" },
  { key: "workbuddyAdapter", name: "WorkBuddy", label: "WorkBuddy" },
  { key: "traeAdapter", name: "Trae", label: "Trae" },
]) {
  test(`${name}-only lifecycle guidance describes the changed integration`, (t) => {
    const started = captureReport(t, printLifecycleResult, {
      ok: true,
      action: "start",
      backend,
      [key]: readyAdapter,
    });
    assert.ok(started.includes(`${label} adapter: ok integration=hooks`));
    assert.match(started, /available client integrations are enabled/);
    assert.doesNotMatch(started, /Adapters were not changed|New DSH sessions|stable plugin shell/);

    const stopped = captureReport(t, printLifecycleResult, {
      ok: true,
      action: "stop",
      backend: { ok: true, action: "stop", skipped: true, reason: "active_clients_remaining" },
      [key]: { ...readyAdapter, enabled: false },
    });
    assert.match(stopped, /Backend remains running for the other active client integrations/);
    assert.ok(stopped.includes(`${name} Hook integration is stopped; provider config was not changed.`));

    const removed = captureReport(t, printLifecycleResult, {
      ok: true,
      action: "uninstall",
      [key]: { ok: true, removed: true },
    });
    assert.ok(removed.includes(`MemoraX Code has been uninstalled from ${name}.`));
  });

  test(`${name} failure is included in mixed-client start and status guidance`, (t) => {
    const report = {
      ok: false,
      backend,
      codexAdapter: readyAdapter,
      [key]: { ...readyAdapter, enabled: false },
    };
    const started = captureReport(t, printLifecycleResult, { ...report, action: "start" });
    assert.match(started, /one or more adapters are not enabled/);
    assert.doesNotMatch(started, /available client integrations are enabled|Adapters were not changed/);

    const status = captureReport(t, printMemoraxCodeStatus, { ...report, action: "status" });
    assert.ok(status.includes(`${label} adapter is not enabled.`));
    assert.doesNotMatch(status, /MemoraX Code needs attention/);
  });
}

test("Trae activation remains explicit before a Hook has been observed", (t) => {
  const traeAdapter = {
    ...readyAdapter,
    traeSkills: { ok: true, status: "installed" },
    traeHooks: { ok: true, status: "unverified", configured: true, runtimeObserved: false },
    globalHooksActivationRequired: true,
  };
  for (const action of ["start", "restart", "status"]) {
    const output = captureReport(t, action === "status" ? printMemoraxCodeStatus : printLifecycleResult, {
      ok: true,
      action,
      backend,
      traeAdapter,
    });
    assert.match(output, /Trae adapter: ok integration=hooks skills=installed hook-runtime=unverified/);
    assert.match(output, /open Trae Settings and enable Global Hooks, then start a new Trae session/);
  }
  const observed = captureReport(t, printMemoraxCodeStatus, {
    ok: true,
    action: "status",
    backend,
    traeAdapter: {
      ...traeAdapter,
      traeHooks: { ok: true, status: "observed", configured: true, runtimeObserved: true },
      globalHooksActivationRequired: false,
    },
  });
  assert.match(observed, /hook-runtime=observed/);
  assert.doesNotMatch(observed, /requires one manual step/);
});

test("optional DSH with Trae retains both unavailable and activation guidance", (t) => {
  const report = {
    ok: true,
    degraded: true,
    backend,
    dshAdapter: { ok: false, optional: true, reason: "not-detected" },
    traeAdapter: { ...readyAdapter, globalHooksActivationRequired: true },
  };
  for (const action of ["start", "status"]) {
    const output = captureReport(t, action === "status" ? printMemoraxCodeStatus : printLifecycleResult, {
      ...report,
      action,
    });
    assert.match(output, /DSH adapter: unavailable not-detected/);
    assert.match(output, /DSH integration is unavailable: not-detected/);
    assert.match(output, /open Trae Settings and enable Global Hooks/);
    assert.doesNotMatch(output, /ready for new DSH sessions|New DSH sessions/);
  }
});

test("adapter report output preserves all supported client labels and summary fields", (t) => {
  const output = captureReport(t, printMemoraxCodeStatus, {
    ok: true,
    action: "status",
    backend,
    codexAdapter: { ...readyAdapter, codexSkills: { status: "ok" } },
    claudeAdapter: { ...readyAdapter, claudeSkills: { status: "ok" } },
    dshAdapter: { ...readyAdapter, integration: "plugin", version: "1.0.0", dshVersionTested: false },
    opencodeAdapter: { ...readyAdapter, integration: "plugin", opencodeSkills: { status: "ok" } },
    codebuddyAdapter: { ...readyAdapter, codebuddySkills: { status: "ok" }, codebuddyHooks: { status: "observed" } },
    workbuddyAdapter: { ...readyAdapter, codebuddySkills: { status: "ok" }, codebuddyHooks: { status: "observed" } },
    traeAdapter: { ...readyAdapter, traeSkills: { status: "installed" }, traeHooks: { status: "unverified" } },
  });
  assert.deepEqual(output.split("\n").filter((line) => line.includes(" adapter:")), [
    "[MemoraX Code Backend]: Codex adapter: ok integration=hooks skills=ok",
    "[MemoraX Code Backend]: Claude adapter: ok integration=hooks skills=ok",
    "[MemoraX Code Backend]: DSH adapter: ok integration=plugin version=1.0.0 tested=false",
    "[MemoraX Code Backend]: OpenCode adapter: ok integration=plugin skills=ok",
    "[MemoraX Code Backend]: CodeBuddy adapter: ok integration=hooks skills=ok hook-runtime=observed",
    "[MemoraX Code Backend]: WorkBuddy adapter: ok integration=hooks skills=ok hook-runtime=observed",
    "[MemoraX Code Backend]: Trae adapter: ok integration=hooks skills=installed hook-runtime=unverified",
  ]);
});

test("optional Claude and DSH reports retain their status exceptions", (t) => {
  const output = captureReport(t, printMemoraxCodeStatus, {
    ok: false,
    action: "status",
    backend,
    codexAdapter: readyAdapter,
    claudeAdapter: { ok: true, installed: false, reason: "not-configured" },
    dshAdapter: { ok: false, optional: true, reason: "not-detected" },
    codebuddyAdapter: { ...readyAdapter, enabled: false },
  });
  assert.match(output, /Claude adapter: skipped not-configured/);
  assert.match(output, /DSH adapter: unavailable not-detected/);
  assert.match(output, /CodeBuddy adapter is not enabled/);
  assert.doesNotMatch(output, /Claude adapter is not enabled|DSH adapter is not enabled/);
});
