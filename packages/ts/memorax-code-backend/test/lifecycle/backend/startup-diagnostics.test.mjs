import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createBackendStartupDiagnostics,
  projectBackendStartupDiagnostics,
  reportBackendStartupPhase,
} from "../../../dist/lifecycle/backend/startup-diagnostics.js";
import { diagnoseLifecycleReport } from "../../../dist/lifecycle/cli-diagnostics.js";
import { readDiagnosticHistory } from "../../../dist/lifecycle/diagnostic-history.js";
import { runCli } from "../support/backend-service-fixtures.mjs";
import { fileURLToPath } from "node:url";

test("startup observations are bounded, ordered and content-free; a broken channel cannot change the result", () => {
  const tracker = createBackendStartupDiagnostics(50);
  const child = new EventEmitter();
  let unreferenced = false;
  child.channel = { unref: () => { unreferenced = true; } };
  child.connected = true;
  child.disconnect = () => { throw new Error("already closed"); };
  tracker.attach(child);
  const send = (phase, event, elapsedMs, extra = {}) => child.emit("message", {
    type: "memorax-code.backend-startup", version: 1, phase, event, elapsedMs, ...extra,
  });
  send("listen", "complete", 1);
  send("runtime_import", "start", -1);
  send("runtime_import", "start", 0, { version: 99 });
  const phases = ["runtime_import", "state_creation", "plugin_preparation", "server_creation", "listen"];
  for (const [index, phase] of phases.entries()) {
    send(phase, "start", index * 2, { token: "private-token", path: "private-path" });
    send(phase, "start", index * 2);
    send(phase, "complete", index * 2 + 1);
  }
  for (let index = 0; index < 20; index++) send("listen", "complete", 10 + index);
  const result = tracker.finish({ ok: true, action: "start" });
  assert.equal(result.ok, true);
  assert.equal(result.startup.child.phases.length, 10);
  assert.equal(result.startup.healthCheckCount, 0);
  assert.equal(result.startup.lastHealthCheck, undefined);
  assert.equal(result.startup.child.exitObserved, false);
  assert.doesNotMatch(JSON.stringify(result.startup), /private-token|private-path/);
  assert.equal(unreferenced, true);
  assert.doesNotThrow(() => tracker.close());
  assert.equal(child.listenerCount("message"), 0);
});

test("child reporting ignores a disconnected or failed diagnostic channel", (t) => {
  const sendDescriptor = Object.getOwnPropertyDescriptor(process, "send");
  const connectedDescriptor = Object.getOwnPropertyDescriptor(process, "connected");
  t.after(() => {
    for (const [key, descriptor] of [["send", sendDescriptor], ["connected", connectedDescriptor]]) {
      if (descriptor) Object.defineProperty(process, key, descriptor);
      else delete process[key];
    }
  });
  let calls = 0;
  Object.defineProperty(process, "send", { configurable: true, value: () => { calls++; throw new Error("closed"); } });
  Object.defineProperty(process, "connected", { configurable: true, value: false });
  reportBackendStartupPhase("runtime_import", "start");
  assert.equal(calls, 0);
  Object.defineProperty(process, "connected", { configurable: true, value: true });
  assert.doesNotThrow(() => reportBackendStartupPhase("runtime_import", "start"));
  assert.equal(calls, 1);
});

test("startup diagnostics survive CLI persistence and history without arbitrary child fields", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-startup-diagnostics-"));
  const tracker = createBackendStartupDiagnostics(5000);
  tracker.phase("spawn");
  const result = tracker.finish({
    ok: false, action: "start", errorCode: "BACKEND_SPAWN_FAILED",
    stage: "spawn", processState: "not-started", systemCode: "EACCES",
  });
  result.startup.secret = "private-credential";
  result.startup.child.secret = "private-credential";
  try {
    const report = diagnoseLifecycleReport({ ok: false, action: "start", backend: result }, { home });
    const path = report.diagnostic.path;
    const saved = JSON.parse(await readFile(path, "utf8"));
    assert.equal(saved.startup.healthTimeoutMs, 5000);
    assert.doesNotMatch(JSON.stringify(saved), /private-credential/);
    saved.startup.child.untrusted = "private-credential";
    await writeFile(path, JSON.stringify(saved));
    const history = readDiagnosticHistory(home, { id: report.diagnostic.id });
    assert.equal(history.ok, true);
    assert.doesNotMatch(JSON.stringify(history), /private-credential/);
    const cli = fileURLToPath(new URL("../../../dist/memorax-code.js", import.meta.url));
    const printed = await runCli(cli, ["logs", "--home", home, "--id", report.diagnostic.id]);
    assert.equal(printed.code, 0, printed.stderr);
    assert.match(printed.stdout, /health budget 5000ms; 0 health checks/);
    assert.match(printed.stdout, /Child startup: no phase observed/);
    saved.startup.phases[0].phase = "private-credential";
    await writeFile(path, JSON.stringify(saved));
    assert.equal(readDiagnosticHistory(home, { id: report.diagnostic.id }).errorCode, "DIAGNOSTIC_RECORD_INVALID");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("startup history rejects invalid, oversized and out-of-order observations", () => {
  const valid = {
    version: 1, elapsedMs: 100, healthTimeoutMs: 5000, healthCheckCount: 1,
    phases: [{ phase: "health", elapsedMs: 100, durationMs: 90 }],
    lastHealthCheck: { outcome: "transport", elapsedMs: 99, durationMs: 1, systemCode: "ECONNREFUSED" },
    child: { pid: 4242, exitObserved: false, phases: [{ phase: "runtime_import", event: "start", elapsedMs: 0 }] },
  };
  assert.deepEqual(projectBackendStartupDiagnostics(valid), valid);
  for (const mutate of [
    (value) => { value.version = 2; },
    (value) => { value.elapsedMs = -1; },
    (value) => { value.healthCheckCount = Infinity; },
    (value) => { value.phases[0].durationMs = 101; },
    (value) => { value.phases = Array(12).fill(value.phases[0]); },
    (value) => { value.child.phases[0].phase = "listen"; },
    (value) => { value.child.phases.push({ phase: "runtime_import", event: "complete", elapsedMs: -1 }); },
    (value) => { value.child.signal = "private-signal"; },
    (value) => { value.lastHealthCheck.systemCode = "private-error"; },
    (value) => { value.lastHealthCheck.outcome = "private-error"; },
    (value) => { value.lastHealthCheck.httpStatus = 1000; },
  ]) {
    const invalid = structuredClone(valid);
    mutate(invalid);
    assert.equal(projectBackendStartupDiagnostics(invalid), undefined);
  }
});
