import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import {
  printLifecycleResult,
  printMemoraxCodeStatus,
} from "../../dist/entrypoints/backend-cli.js";

const readyAdapter = { ok: true, installed: true, enabled: true, integration: "hooks" };
const backend = { ok: true, action: "start", url: "http://127.0.0.1:8787" };

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
  { key: "codebuddyAdapter", name: "CodeBuddy/WorkBuddy", label: "CodeBuddy" },
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

test("adapter report output preserves all six client labels and summary fields", (t) => {
  const output = captureReport(t, printMemoraxCodeStatus, {
    ok: true,
    action: "status",
    backend,
    codexAdapter: { ...readyAdapter, codexSkills: { status: "ok" } },
    claudeAdapter: { ...readyAdapter, claudeSkills: { status: "ok" } },
    dshAdapter: { ...readyAdapter, integration: "plugin", version: "1.0.0", dshVersionTested: false },
    opencodeAdapter: { ...readyAdapter, integration: "plugin", opencodeSkills: { status: "ok" } },
    codebuddyAdapter: { ...readyAdapter, codebuddySkills: { status: "ok" }, codebuddyHooks: { status: "observed" } },
    traeAdapter: { ...readyAdapter, traeSkills: { status: "installed" }, traeHooks: { status: "unverified" } },
  });
  assert.deepEqual(output.split("\n").filter((line) => line.includes(" adapter:")), [
    "[MemoraX Code Backend]: Codex adapter: ok integration=hooks skills=ok",
    "[MemoraX Code Backend]: Claude adapter: ok integration=hooks skills=ok",
    "[MemoraX Code Backend]: DSH adapter: ok integration=plugin version=1.0.0 tested=false",
    "[MemoraX Code Backend]: OpenCode adapter: ok integration=plugin skills=ok",
    "[MemoraX Code Backend]: CodeBuddy adapter: ok integration=hooks skills=ok hook-runtime=observed",
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
