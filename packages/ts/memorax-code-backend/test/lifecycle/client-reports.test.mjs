import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { test } from "node:test";
import {
  LIFECYCLE_CLIENTS,
  isAdapterReady,
  lifecycleAdapterReports,
  summarizeAdapterReport,
} from "../../dist/lifecycle/client-reports.js";

const clients = [
  { id: "codex", name: "Codex", reportKey: "codexAdapter", skillKey: "codexSkills" },
  { id: "claude", name: "Claude Code", reportKey: "claudeAdapter", skillKey: "claudeSkills" },
  { id: "dsh", name: "DSH", reportKey: "dshAdapter" },
  { id: "opencode", name: "OpenCode", reportKey: "opencodeAdapter", skillKey: "opencodeSkills" },
  { id: "codebuddy", name: "CodeBuddy/WorkBuddy", reportKey: "codebuddyAdapter", skillKey: "codebuddySkills", hookKey: "codebuddyHooks" },
  { id: "trae", name: "Trae", reportKey: "traeAdapter", skillKey: "traeSkills", hookKey: "traeHooks" },
];

function installedAdapter(client) {
  return {
    ok: true,
    installed: true,
    enabled: true,
    integration: "plugin",
    backendUrlMatches: true,
    ...(client.skillKey ? { [client.skillKey]: { ok: true, status: "installed" } } : {}),
    ...(client.hookKey ? { [client.hookKey]: { ok: true, status: "unverified", configured: true, runtimeObserved: false } } : {}),
  };
}

test("lifecycle client catalog covers every Backend client without duplicate report keys", async () => {
  assert.equal(new Set(LIFECYCLE_CLIENTS.map(({ reportKey }) => reportKey)).size, LIFECYCLE_CLIENTS.length);
  assert.equal(LIFECYCLE_CLIENTS.every(({ name }) => typeof name === "string" && name.length > 0), true);
  const entries = await readdir(new URL("../../src/clients/", import.meta.url), { withFileTypes: true });
  assert.deepEqual(
    LIFECYCLE_CLIENTS.map(({ id }) => id).sort(),
    entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort(),
  );
});

test("lifecycle reports include only present clients in catalog order and retain raw reports", () => {
  const trae = Object.freeze({ ok: false, reason: "not-installed", globalHooksActivationRequired: true });
  const codex = Object.freeze({ ok: true, installed: true });
  const dsh = Object.freeze({ optional: true, skipped: true, reason: "not-detected" });
  const raw = Object.freeze({ traeAdapter: trae, unknownAdapter: {}, codexAdapter: codex, claudeAdapter: undefined, dshAdapter: dsh });
  const before = JSON.stringify(raw);
  const selected = lifecycleAdapterReports(raw);
  assert.deepEqual(selected.map(({ client }) => client.id), ["codex", "dsh", "trae"]);
  assert.equal(selected[0].report, codex);
  assert.equal(selected[1].report, dsh);
  assert.equal(selected[2].report, trae);
  assert.equal(JSON.stringify(raw), before);
  assert.deepEqual(lifecycleAdapterReports({}), []);
});

for (const client of clients) {
  test(`${client.name} report summary preserves readiness and native status fields`, () => {
    const raw = installedAdapter(client);
    const before = structuredClone(raw);
    const summary = summarizeAdapterReport(raw);
    assert.equal(summary.ready, true);
    assert.equal(summary.installed, true);
    assert.equal(summary.enabled, true);
    assert.equal(isAdapterReady(raw), true);
    assert.equal(summary.integration, "plugin");
    assert.equal(summary.skillStatus, client.skillKey ? "installed" : undefined);
    assert.equal(summary.hookStatus, client.hookKey ? "unverified" : undefined);
    assert.equal(summary.configured, client.hookKey ? true : undefined);
    assert.equal(summary.runtimeObserved, client.hookKey ? false : undefined);
    assert.equal(summary.activationRequired, false);
    assert.deepEqual(raw, before);

    for (const patch of [
      { ok: false },
      { installed: false },
      { enabled: false },
      { backendUrlMatches: false },
      { integration: "unsupported" },
    ]) {
      const failed = { ...raw, ...patch };
      assert.equal(isAdapterReady(failed), false, JSON.stringify(patch));
      assert.equal(summarizeAdapterReport(failed).ready, false, JSON.stringify(patch));
    }

    for (const key of [client.skillKey, client.hookKey].filter(Boolean)) {
      for (const status of ["missing", "invalid"]) {
        const failed = { ...raw, [key]: { ok: false, status } };
        assert.equal(isAdapterReady(failed), false, `${key} ${status}`);
        const failedSummary = summarizeAdapterReport(failed);
        assert.equal(failedSummary.ready, false, `${key} ${status}`);
        assert.equal(key === client.skillKey ? failedSummary.skillStatus : failedSummary.hookStatus, status);
      }
    }
  });
}

test("readiness preserves optional report fields and nested integration without inferring installation", () => {
  const legacy = { installed: true, enabled: true, state: { integration: "hooks" } };
  assert.equal(isAdapterReady(legacy), true);
  assert.equal(summarizeAdapterReport(legacy).integration, "hooks");
  assert.equal(isAdapterReady({ ...legacy, integration: "unsupported" }), false);
  assert.equal(isAdapterReady({ installed: true, enabled: true }), false);
  assert.equal(summarizeAdapterReport({ installed: true, enabled: true }).integration, undefined);
  assert.equal(summarizeAdapterReport({}).installed, false);
  assert.equal(summarizeAdapterReport({}).enabled, false);
  assert.equal(isAdapterReady({ integration: "hooks", enabled: true }), false);
  assert.equal(isAdapterReady({ integration: "hooks", installed: true }), false);
  assert.equal(isAdapterReady({ state: { integration: "hooks", enabled: true }, installed: true }), false);
});

test("configured Hooks and observed runtime remain separate from installation readiness", () => {
  for (const client of clients.filter(({ hookKey }) => hookKey)) {
    const raw = installedAdapter(client);
    const configured = summarizeAdapterReport(raw);
    assert.equal(configured.ready, true);
    assert.equal(configured.configured, true);
    assert.equal(configured.runtimeObserved, false);

    const observed = summarizeAdapterReport({
      ...raw,
      [client.hookKey]: { ok: true, status: "observed", configured: true, runtimeObserved: true },
    });
    assert.equal(observed.ready, true);
    assert.equal(observed.configured, true);
    assert.equal(observed.runtimeObserved, true);
    assert.equal(observed.hookStatus, "observed");
  }
});

test("Trae Global Hooks activation requirement is retained without becoming a readiness blocker", () => {
  const raw = Object.freeze({
    ...installedAdapter(clients.find(({ id }) => id === "trae")),
    traeHooks: Object.freeze({ ok: true, status: "unverified", configured: true, runtimeObserved: false }),
    globalHooksActivationRequired: true,
  });
  const summary = summarizeAdapterReport(raw);
  assert.equal(summary.ready, true);
  assert.equal(summary.activationRequired, true);
  assert.equal(summary.configured, true);
  assert.equal(summary.runtimeObserved, false);
  assert.equal(raw.globalHooksActivationRequired, true);
  assert.equal(Object.hasOwn(raw, "activationRequired"), false);
});
