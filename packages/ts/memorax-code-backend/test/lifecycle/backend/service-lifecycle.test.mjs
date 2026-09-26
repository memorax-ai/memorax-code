import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs, { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  BackendServiceStateError,
  isProcessAlive,
  readBackendServiceRecordState,
  readBackendServiceState,
  startBackendService,
  stopBackendService,
  terminateProcessTree,
} from "../../../dist/lifecycle/backend/service.js";
import { removeBackendServiceStateIfOwnedAtPath } from "../../../dist/lifecycle/backend/record.js";
import { backendServiceFailureFields } from "../../../dist/lifecycle/backend/result.js";
import { diagnoseLifecycleReport, lifecycleDiagnosticLines } from "../../../dist/lifecycle/cli-diagnostics.js";
import { backendShutdownRequestPath } from "../../../dist/lifecycle/backend/shutdown-request.js";

function successfulProcessProbe(commandLine) {
  return { status: "ok", commandLine };
}

function timedOutProcessProbe() {
  return {
    status: "inconclusive",
    reason: "timeout",
    timeoutMs: 10_000,
    code: "ETIMEDOUT",
    signal: "SIGKILL",
  };
}

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return address.port;
}

test("service start fails closed for a current PID record without instance provenance", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-backend-unverified-state-"));
  const runtime = join(home, "runtime", "backend");
  try {
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, "backend.pid.json"), JSON.stringify({
      version: 1,
      pid: process.pid,
      host: "127.0.0.1",
      port: 1,
      url: "http://127.0.0.1:1",
      logPath: join(runtime, "backend.log"),
      startedAt: "2026-07-15T00:00:00.000Z",
    }));
    let spawned = false;
    const result = await startBackendService({ home, timeoutMs: 50 }, {
      spawnProcess: () => {
        spawned = true;
        throw new Error("must not spawn");
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "BACKEND_SERVICE_STATE_INVALID");
    assert.equal(result.stage, "read_state");
    assert.equal(result.processState, "unknown");
    assert.match(result.error, /missing_instance_id/);
    assert.equal(spawned, false);
    assert.deepEqual(readBackendServiceRecordState({ home }), {
      status: "invalid",
      reason: "missing_instance_id",
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("service state record distinguishes valid invalid and unsupported state", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-backend-service-state-"));
  const runtime = join(home, "runtime", "backend");
  const statePath = join(runtime, "backend.pid.json");
  try {
    assert.deepEqual(readBackendServiceRecordState({ home }), { status: "absent" });

    await mkdir(runtime, { recursive: true });
    await writeFile(statePath, `${JSON.stringify({
      version: 1,
      pid: 4242,
      instanceId: "current-instance",
      host: "127.0.0.1",
      port: 18789,
      url: "http://127.0.0.1:18789",
      logPath: join(runtime, "backend.log"),
      startedAt: "2026-07-26T00:00:00.000Z",
    })}\n`);
    const current = readBackendServiceRecordState({ home });
    assert.equal(current.status, "valid");
    assert.equal(current.record.version, 1);
    assert.equal(current.record.pid, 4242);

    await writeFile(statePath, `${JSON.stringify({
      version: 1,
      pid: 4242,
      host: "127.0.0.1",
      port: 18789,
      url: "http://127.0.0.1:18789",
      logPath: join(runtime, "backend.log"),
      startedAt: "2026-07-26T00:00:00.000Z",
    })}\n`);
    assert.deepEqual(readBackendServiceRecordState({ home }), {
      status: "invalid",
      reason: "missing_instance_id",
    });

    await writeFile(statePath, `${JSON.stringify({
      version: 1,
      pid: 4242,
      instanceId: "closed-schema-instance",
      host: "127.0.0.1",
      port: 18789,
      url: "http://127.0.0.1:18789",
      logPath: join(runtime, "backend.log"),
      startedAt: "2026-07-26T00:00:00.000Z",
      unexpectedMode: "native",
    })}\n`);
    assert.deepEqual(readBackendServiceRecordState({ home }), {
      status: "invalid",
      reason: "unknown_fields",
    });

    await writeFile(statePath, "{not-json\n");
    assert.deepEqual(readBackendServiceRecordState({ home }), {
      status: "invalid",
      reason: "malformed_json",
    });
    let spawned = false;
    const start = await startBackendService({ home, timeoutMs: 50 }, {
      spawnProcess: () => {
        spawned = true;
        throw new Error("must not spawn");
      },
    });
    assert.equal(start.ok, false);
    assert.equal(start.errorCode, "BACKEND_SERVICE_STATE_INVALID");
    assert.equal(start.recordReason, "malformed_json");
    assert.equal(spawned, false);
    const stop = await stopBackendService({ home, timeoutMs: 50 });
    assert.equal(stop.ok, false);
    assert.equal(stop.errorCode, "BACKEND_SERVICE_STATE_INVALID");
    assert.equal(stop.recordReason, "malformed_json");

    await writeFile(statePath, `${JSON.stringify({
      version: 2,
      pid: 4242,
      instanceId: "future-instance",
      host: "127.0.0.1",
      port: 18789,
      url: "http://127.0.0.1:18789",
      logPath: join(runtime, "backend.log"),
      startedAt: "2026-07-26T00:00:00.000Z",
    })}\n`);
    assert.deepEqual(readBackendServiceRecordState({ home }), {
      status: "unsupported",
      version: 2,
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("service state cleanup removes only the expected Backend instance", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-backend-service-state-cas-"));
  const runtime = join(home, "runtime", "backend");
  const statePath = join(runtime, "backend.pid.json");
  const replacement = {
    version: 1,
    pid: 5252,
    instanceId: "replacement-instance",
    host: "127.0.0.1",
    port: 18789,
    url: "http://127.0.0.1:18789",
    logPath: join(runtime, "backend.log"),
    startedAt: "2026-07-27T00:00:00.000Z",
  };
  try {
    await mkdir(runtime, { recursive: true });
    await writeFile(statePath, `${JSON.stringify(replacement)}\n`);
    assert.deepEqual(removeBackendServiceStateIfOwnedAtPath(statePath, {
      pid: 4242,
      instanceId: "superseded-instance",
    }), { disposition: "not_owned", reason: "replacement" });
    assert.deepEqual(JSON.parse(await readFile(statePath, "utf8")), replacement);
    assert.deepEqual(removeBackendServiceStateIfOwnedAtPath(statePath, replacement), {
      disposition: "removed",
    });
    assert.equal(readBackendServiceState({ home }), undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("stop reports PID authority cleanup IO failure after stopping the process", {
  skip: process.platform === "win32" || process.getuid?.() === 0,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-backend-stop-cleanup-io-"));
  const runtime = join(home, "runtime", "backend");
  const reservation = createServer();
  const port = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  let started;
  try {
    started = await startBackendService({ home, port, timeoutMs: 3000 });
    assert.equal(started.ok, true, started.error);
    await chmod(runtime, 0o500);

    const stopped = await stopBackendService({ home, port, timeoutMs: 3000 });

    assert.equal(stopped.ok, false);
    assert.equal(stopped.errorCode, "BACKEND_SERVICE_STATE_CLEANUP_FAILED");
    assert.equal(stopped.stage, "cleanup_pid");
    assert.equal(stopped.processState, "stopped");
    assert.equal(stopped.systemCode, "EACCES");
    assert.match(stopped.error, /Backend process stopped; failed to claim Backend service state/);
    assert.equal(isProcessAlive(started.state.pid), false);
    assert.equal(JSON.parse(await readFile(join(runtime, "backend.pid.json"), "utf8")).pid, started.state.pid);
  } finally {
    await chmod(runtime, 0o700).catch(() => undefined);
    await stopBackendService({ home, port, timeoutMs: 1000 }).catch(() => undefined);
    await rm(home, { recursive: true, force: true });
  }
});

test("failed health startup terminates the spawned process and removes PID state", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-backend-health-timeout-"));
  const occupied = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true,"service":"not-memorax-code"}');
  });
  const port = await listen(occupied);
  try {
    const result = await startBackendService({ home, port, timeoutMs: 200 }, {
      // Keep the child alive so this exercises deadline cleanup, not early exit.
      spawnProcess: (_command, _args, options) => spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], options),
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /did not become healthy/);
    assert.equal(result.errorCode, "BACKEND_HEALTH_NOT_READY");
    assert.equal(result.stage, "health");
    assert.equal(result.failureReason, "identity_mismatch");
    assert.equal(result.httpStatus, 200);
    assert.equal(result.processState, "stopped");
    assert.equal(readBackendServiceState({ home }), undefined);
  } finally {
    await new Promise((resolve) => occupied.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test("startup expires the default five-second health deadline and cleans up its process", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-startup-deadline-"));
  const now = Date.now;
  let elapsedMs = 0;
  const clock = t.mock.method(Date, "now", () => now() + elapsedMs);
  let alive = true;
  let probes = 0;
  let terminated = false;
  try {
    const result = await startBackendService({ home }, {
      spawnProcess: () => {
        const child = new EventEmitter();
        child.pid = 4242;
        child.unref = () => undefined;
        process.nextTick(() => child.emit("spawn"));
        return child;
      },
      isProcessAlive: () => alive,
      terminateProcessTree: () => { terminated = true; alive = false; return true; },
      fetch: async () => {
        probes += 1;
        // Advance only the deadline clock; no real slow process is needed.
        elapsedMs += 6_000;
        throw Object.assign(new Error("still starting"), { code: "ECONNREFUSED" });
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "BACKEND_HEALTH_NOT_READY");
    assert.equal(result.systemCode, "ECONNREFUSED");
    assert.equal(probes, 1);
    assert.equal(terminated, true);
    assert.equal(result.processState, "stopped");
    assert.equal(readBackendServiceState({ home }), undefined);
  } finally {
    clock.mock.restore();
    await rm(home, { recursive: true, force: true });
  }
});

test("startup reports an exited child promptly without terminating its former PID", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-exited-startup-"));
  const child = new EventEmitter();
  child.pid = 4242;
  child.exitCode = null;
  child.signalCode = null;
  child.unref = () => undefined;
  let probes = 0;
  let terminated = false;
  try {
    const result = await startBackendService({ home, timeoutMs: 50 }, {
      spawnProcess: () => {
        process.nextTick(() => child.emit("spawn"));
        return child;
      },
      isProcessAlive: () => false,
      terminateProcessTree: () => { terminated = true; return true; },
      fetch: async () => {
        probes += 1;
        // Exit during the final retry delay, when the health budget also expires.
        setImmediate(() => { child.exitCode = 1; });
        return new Response("private-startup-failure", { status: 503 });
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "BACKEND_EXITED_BEFORE_READY");
    assert.equal(result.stage, "health");
    assert.equal(result.failureReason, "http_error");
    assert.equal(result.httpStatus, 503);
    assert.equal(result.systemCode, undefined);
    assert.equal(result.processState, "stopped");
    assert.equal(probes, 1);
    assert.equal(terminated, false);
    assert.equal(readBackendServiceState({ home }), undefined);
    assert.doesNotMatch(JSON.stringify(result), /private-startup-failure/);
    const diagnosed = diagnoseLifecycleReport({ ok: false, action: "start", backend: result }, { home });
    assert.equal(diagnosed.failure.error, "Backend process exited before becoming ready.");
    assert.match(lifecycleDiagnosticLines(diagnosed).join("\n"), /BACKEND_EXITED_BEFORE_READY/);
    const record = JSON.parse(await readFile(diagnosed.diagnostic.path, "utf8"));
    assert.equal(record.errorCode, "BACKEND_EXITED_BEFORE_READY");
    assert.equal(record.processState, "stopped");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("service spawn error and missing PID fail before writing state", async (t) => {
  for (const [name, emit] of [
    ["spawn error", (child) => child.emit("error", Object.assign(new Error("spawn denied"), { code: "EACCES" }))],
    ["missing PID", (child) => child.emit("spawn")],
  ]) {
    await t.test(name, async () => {
      const home = await mkdtemp(join(tmpdir(), "memorax-code-backend-spawn-failure-"));
      try {
        const child = new EventEmitter();
        child.pid = undefined;
        child.unref = () => undefined;
        let spawnOptions;
        const result = await startBackendService({ home, timeoutMs: 50 }, {
          spawnProcess: (_command, _args, options) => {
            spawnOptions = options;
            process.nextTick(() => emit(child));
            return child;
          },
        });
        assert.equal(result.ok, false);
        assert.match(result.error, /failed to spawn Backend process/);
        assert.equal(result.errorCode, name === "spawn error" ? "BACKEND_SPAWN_FAILED" : "BACKEND_SPAWN_PID_MISSING");
        assert.equal(result.stage, "spawn");
        assert.equal(result.systemCode, name === "spawn error" ? "EACCES" : undefined);
        assert.equal(result.processState, name === "spawn error" ? "not-started" : "unknown");
        assert.equal(spawnOptions.cwd, join(home, "runtime", "backend"));
        assert.equal(readBackendServiceState({ home }), undefined);
        if (process.platform !== "win32") {
          assert.equal((await stat(join(home, "runtime", "backend"))).mode & 0o777, 0o700);
        }
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });
  }
});

test("process guards reject zero, negative, and unsafe PIDs", () => {
  assert.equal(isProcessAlive(0), false);
  assert.equal(isProcessAlive(-1), false);
  assert.equal(isProcessAlive(Number.MAX_SAFE_INTEGER + 1), false);
  assert.equal(terminateProcessTree(0), false);
  assert.equal(terminateProcessTree(-1), false);
  assert.equal(terminateProcessTree(Number.MAX_SAFE_INTEGER + 1), false);
});

test("service start accepts matching health when the process probe is inconclusive", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-backend-health-owned-start-"));
  const runtime = join(home, "runtime", "backend");
  let probed = 0;
  let spawned = false;
  try {
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, "backend.pid.json"), JSON.stringify({
      version: 1,
      pid: 4242,
      instanceId: "expected-instance",
      host: "127.0.0.1",
      port: 18789,
      url: "http://127.0.0.1:18789",
      logPath: join(runtime, "backend.log"),
      startedAt: "2026-07-15T00:00:00.000Z",
    }));
    const result = await startBackendService({ home, timeoutMs: 100 }, {
      fetch: async () => new Response(JSON.stringify({
        ok: true,
        service: "memorax-code-backend",
        instanceId: "expected-instance",
        state: { sessionHome: home },
      }), { status: 200, headers: { "content-type": "application/json" } }),
      isProcessAlive: () => true,
      probeProcessCommandLine: () => {
        probed += 1;
        return timedOutProcessProbe();
      },
      spawnProcess: () => {
        spawned = true;
        throw new Error("must not spawn");
      },
    });

    assert.equal(result.ok, true, result.error);
    assert.equal(result.alreadyRunning, true);
    assert.equal(probed, 1);
    assert.equal(spawned, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("service start rejects explicit process conflicts despite matching health", async (t) => {
  for (const entry of [
    {
      name: "mismatched command",
      probe: successfulProcessProbe("C:\\Windows\\System32\\unrelated.exe"),
      error: /process command identity does not match/,
    },
    {
      name: "process not found",
      probe: { status: "not_found" },
      error: /recorded process was not found/,
    },
  ]) {
    await t.test(entry.name, async () => {
      const home = await mkdtemp(join(tmpdir(), "memorax-code-backend-health-process-conflict-"));
      const runtime = join(home, "runtime", "backend");
      let spawned = false;
      try {
        await mkdir(runtime, { recursive: true });
        await writeFile(join(runtime, "backend.pid.json"), JSON.stringify({
          version: 1,
          pid: 4242,
          instanceId: "expected-instance",
          host: "127.0.0.1",
          port: 18789,
          url: "http://127.0.0.1:18789",
          logPath: join(runtime, "backend.log"),
          startedAt: "2026-07-15T00:00:00.000Z",
        }));
        const result = await startBackendService({ home, timeoutMs: 100 }, {
          fetch: async () => new Response(JSON.stringify({
            ok: true,
            service: "memorax-code-backend",
            instanceId: "expected-instance",
            state: { sessionHome: home },
          }), { status: 200, headers: { "content-type": "application/json" } }),
          isProcessAlive: () => true,
          probeProcessCommandLine: () => entry.probe,
          spawnProcess: () => {
            spawned = true;
            throw new Error("must not spawn");
          },
        });

        assert.equal(result.ok, false);
        assert.match(result.error, entry.error);
        assert.equal(result.errorCode, "BACKEND_OWNERSHIP_UNVERIFIED");
        assert.equal(result.stage, "verify_ownership");
        assert.equal(result.failureReason, entry.name === "mismatched command" ? "process_mismatch" : "process_not_found");
        assert.equal(result.processState, "unknown");
        assert.equal(spawned, false);
        assert.equal(readBackendServiceState({ home })?.pid, 4242);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });
  }
});

test("Backend provenance health fetch is bounded for an unresponsive endpoint", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-backend-unresponsive-"));
  const runtime = join(home, "runtime", "backend");
  const unresponsive = createServer(() => undefined);
  const port = await listen(unresponsive);
  try {
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, "backend.pid.json"), JSON.stringify({
      version: 1,
      pid: process.pid,
      instanceId: "expected-instance",
      host: "127.0.0.1",
      port,
      url: `http://127.0.0.1:${port}`,
      logPath: join(runtime, "backend.log"),
      startedAt: "2026-07-15T00:00:00.000Z",
    }));
    const started = Date.now();
    let terminated = false;
    const result = await stopBackendService({ home, timeoutMs: 100 }, {
      isProcessAlive: () => true,
      probeProcessCommandLine: () => successfulProcessProbe(
        `${process.execPath} /tmp/memorax-code-backend/dist/service-entrypoint.js --memorax-code-backend-instance expected-instance`,
      ),
      terminateProcessTree: () => {
        terminated = true;
        return false;
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /failed to terminate verified Backend/);
    assert.equal(terminated, true);
    assert(Date.now() - started < 1000);
  } finally {
    await new Promise((resolve) => unresponsive.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test("Windows managed stop requests graceful shutdown before forced termination", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-backend-windows-graceful-stop-"));
  const runtime = join(home, "runtime", "backend");
  const requestPath = backendShutdownRequestPath(home);
  let alive = true;
  let observedRequest;
  let forced = false;
  let probed = 0;
  try {
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, "backend.pid.json"), JSON.stringify({
      version: 1,
      pid: 4242,
      instanceId: "windows-instance",
      host: "127.0.0.1",
      port: 18789,
      url: "http://127.0.0.1:18789",
      logPath: join(runtime, "backend.log"),
      startedAt: "2026-07-26T00:00:00.000Z",
    }));
    const result = await stopBackendService({ home, timeoutMs: 100 }, {
      platform: "win32",
      fetch: async () => new Response(JSON.stringify({
        ok: true,
        service: "memorax-code-backend",
        instanceId: "windows-instance",
        state: { sessionHome: home },
      }), { status: 200, headers: { "content-type": "application/json" } }),
      isProcessAlive: () => {
        if (!alive) return false;
        try {
          observedRequest = JSON.parse(readFileSync(requestPath, "utf8"));
          alive = false;
        } catch {
          // The graceful request has not been written yet.
        }
        return alive;
      },
      probeProcessCommandLine: () => {
        probed += 1;
        return timedOutProcessProbe();
      },
      terminateProcessTree: () => {
        forced = true;
        return true;
      },
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(forced, false);
    assert.equal(probed, 0);
    assert.deepEqual(
      {
        version: observedRequest?.version,
        pid: observedRequest?.pid,
        instanceId: observedRequest?.instanceId,
      },
      {
        version: 1,
        pid: 4242,
        instanceId: "windows-instance",
      },
    );
    assert.equal(readBackendServiceState({ home }), undefined);
    await assert.rejects(readFile(requestPath, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Windows managed stop refuses taskkill when the final process probe is inconclusive", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-backend-windows-inconclusive-force-stop-"));
  const runtime = join(home, "runtime", "backend");
  let forced = false;
  try {
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, "backend.pid.json"), JSON.stringify({
      version: 1,
      pid: 4292,
      instanceId: "windows-instance",
      host: "127.0.0.1",
      port: 18789,
      url: "http://127.0.0.1:18789",
      logPath: join(runtime, "backend.log"),
      startedAt: "2026-07-26T00:00:00.000Z",
    }));
    const result = await stopBackendService({ home, timeoutMs: 10 }, {
      platform: "win32",
      fetch: async () => new Response(JSON.stringify({
        ok: true,
        service: "memorax-code-backend",
        instanceId: "windows-instance",
        state: { sessionHome: home },
      }), { status: 200, headers: { "content-type": "application/json" } }),
      isProcessAlive: () => true,
      probeProcessCommandLine: () => timedOutProcessProbe(),
      terminateProcessTree: () => {
        forced = true;
        return true;
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /ownership probe timed out after 10000ms/);
    assert.equal(result.errorCode, "BACKEND_OWNERSHIP_UNVERIFIED");
    assert.equal(result.stage, "verify_ownership");
    assert.equal(result.failureReason, "process_probe_inconclusive");
    assert.equal(result.systemCode, "ETIMEDOUT");
    assert.equal(result.processState, "unknown");
    assert.match(result.error, /refusing to force-stop process 4292/);
    assert.equal(forced, false);
    assert.equal(readBackendServiceState({ home })?.pid, 4292);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Windows managed stop refuses taskkill when final health conflicts", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-backend-windows-health-conflict-"));
  const runtime = join(home, "runtime", "backend");
  let forced = false;
  try {
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, "backend.pid.json"), JSON.stringify({
      version: 1,
      pid: 4312,
      instanceId: "windows-instance",
      host: "127.0.0.1",
      port: 18789,
      url: "http://127.0.0.1:18789",
      logPath: join(runtime, "backend.log"),
      startedAt: "2026-07-26T00:00:00.000Z",
    }));
    const result = await stopBackendService({ home, timeoutMs: 10 }, {
      platform: "win32",
      fetch: async () => new Response(JSON.stringify({
        ok: true,
        service: "memorax-code-backend",
        instanceId: "other-instance",
        state: { sessionHome: home },
      }), { status: 200, headers: { "content-type": "application/json" } }),
      isProcessAlive: () => true,
      probeProcessCommandLine: () => successfulProcessProbe(
        `${process.execPath} C:\\memorax-code-backend\\dist\\service-entrypoint.js --memorax-code-backend-instance windows-instance`,
      ),
      terminateProcessTree: () => {
        forced = true;
        return true;
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /Backend health identity conflicts/);
    assert.equal(result.failureReason, "health_conflict");
    assert.equal(forced, false);
    assert.equal(readBackendServiceState({ home })?.pid, 4312);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Windows managed stop falls back to taskkill after the graceful deadline", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-backend-windows-force-stop-"));
  const runtime = join(home, "runtime", "backend");
  let alive = true;
  let forced = false;
  try {
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, "backend.pid.json"), JSON.stringify({
      version: 1,
      pid: 4343,
      instanceId: "windows-instance",
      host: "127.0.0.1",
      port: 18789,
      url: "http://127.0.0.1:18789",
      logPath: join(runtime, "backend.log"),
      startedAt: "2026-07-26T00:00:00.000Z",
    }));
    const result = await stopBackendService({ home, timeoutMs: 10 }, {
      platform: "win32",
      fetch: async () => new Response(JSON.stringify({
        ok: true,
        service: "memorax-code-backend",
        instanceId: "windows-instance",
        state: { sessionHome: home },
      }), { status: 200, headers: { "content-type": "application/json" } }),
      isProcessAlive: () => alive,
      probeProcessCommandLine: () => successfulProcessProbe(
        `${process.execPath} C:\\memorax-code-backend\\dist\\service-entrypoint.js --memorax-code-backend-instance windows-instance`,
      ),
      terminateProcessTree: () => {
        forced = true;
        alive = false;
        return true;
      },
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(forced, true);
    assert.equal(readBackendServiceState({ home }), undefined);
    await assert.rejects(
      readFile(backendShutdownRequestPath(home), "utf8"),
      { code: "ENOENT" },
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Windows managed stop does not force-kill a reused PID after the graceful deadline", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-backend-windows-reused-pid-"));
  const runtime = join(home, "runtime", "backend");
  let healthReads = 0;
  let owner = "backend";
  let killedOwner;
  try {
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, "backend.pid.json"), JSON.stringify({
      version: 1,
      pid: 4444,
      instanceId: "windows-instance",
      host: "127.0.0.1",
      port: 18789,
      url: "http://127.0.0.1:18789",
      logPath: join(runtime, "backend.log"),
      startedAt: "2026-07-26T00:00:00.000Z",
    }));
    const result = await stopBackendService({ home, timeoutMs: 10 }, {
      platform: "win32",
      fetch: async () => {
        healthReads += 1;
        owner = "unrelated";
        return new Response(JSON.stringify({
          ok: true,
          service: "memorax-code-backend",
          instanceId: "windows-instance",
          state: { sessionHome: home },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
      isProcessAlive: () => true,
      probeProcessCommandLine: () => successfulProcessProbe(owner === "backend"
        ? `${process.execPath} C:\\memorax-code-backend\\dist\\service-entrypoint.js --memorax-code-backend-instance windows-instance`
        : "C:\\Windows\\System32\\unrelated.exe"),
      terminateProcessTree: () => {
        killedOwner = owner;
        return true;
      },
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /refusing to force-stop process/);
    assert.equal(healthReads, 1);
    assert.equal(killedOwner, undefined);
    assert.equal(readBackendServiceState({ home })?.pid, 4444);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("current Backend health instance mismatch fails closed despite a matching process marker", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-backend-instance-mismatch-"));
  const runtime = join(home, "runtime", "backend");
  try {
    await mkdir(runtime, { recursive: true });
    await writeFile(join(runtime, "backend.pid.json"), JSON.stringify({
      version: 1,
      pid: process.pid,
      instanceId: "expected-instance",
      host: "127.0.0.1",
      port: 18789,
      url: "http://127.0.0.1:18789",
      logPath: join(runtime, "backend.log"),
      startedAt: "2026-07-15T00:00:00.000Z",
    }));
    let terminated = false;
    const result = await stopBackendService({ home, timeoutMs: 50 }, {
      fetch: async () => new Response(JSON.stringify({
        ok: true,
        service: "memorax-code-backend",
        instanceId: "other-instance",
        state: { sessionHome: home },
      }), { status: 200 }),
      isProcessAlive: () => true,
      probeProcessCommandLine: () => successfulProcessProbe(
        `${process.execPath} /tmp/memorax-code-backend/dist/service-entrypoint.js --memorax-code-backend-instance expected-instance`,
      ),
      terminateProcessTree: () => {
        terminated = true;
        return true;
      },
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /refusing to (?:stop unverified process|force-stop process .*health identity conflicts)/);
    assert.equal(terminated, false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("stop retains verified Backend state when termination fails or the PID remains alive", async (t) => {
  for (const [name, terminateProcessTree] of [
    ["termination failure", () => false],
    ["still alive", () => true],
  ]) {
    await t.test(name, async () => {
      const home = await mkdtemp(join(tmpdir(), "memorax-code-backend-stop-failure-"));
      const runtime = join(home, "runtime", "backend");
      try {
        await mkdir(runtime, { recursive: true });
        await writeFile(join(runtime, "backend.pid.json"), JSON.stringify({
          version: 1,
          pid: process.pid,
          instanceId: "verified-instance",
          host: "127.0.0.1",
          port: 18789,
          url: "http://127.0.0.1:18789",
          logPath: join(runtime, "backend.log"),
          startedAt: "2026-07-15T00:00:00.000Z",
        }));
        const result = await stopBackendService({ home, timeoutMs: 10 }, {
          fetch: async () => new Response(JSON.stringify({
            ok: true,
            service: "memorax-code-backend",
            instanceId: "verified-instance",
            state: { sessionHome: home },
          }), { status: 200, headers: { "content-type": "application/json" } }),
          isProcessAlive: () => true,
          probeProcessCommandLine: () => successfulProcessProbe(
            `${process.execPath} /tmp/memorax-code-backend/dist/service-entrypoint.js --memorax-code-backend-instance verified-instance`,
          ),
          terminateProcessTree,
        });
        assert.equal(result.ok, false);
        assert.match(result.error, name === "termination failure" ? /failed to terminate/ : /did not stop/);
        assert.equal(result.errorCode, name === "termination failure" ? "BACKEND_TERMINATE_FAILED" : "BACKEND_STOP_TIMEOUT");
        assert.equal(result.stage, name === "termination failure" ? "terminate" : "wait_stopped");
        assert.equal(result.processState, name === "termination failure" ? "unknown" : "running");
        assert.equal(readBackendServiceState({ home })?.pid, process.pid);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });
  }
});

test("failed startup retains PID state when cleanup fails or the PID remains alive", async (t) => {
  for (const [name, terminateProcessTree] of [
    ["termination failure", () => false],
    ["still alive", () => true],
  ]) {
    await t.test(name, async () => {
      const home = await mkdtemp(join(tmpdir(), "memorax-code-backend-cleanup-failure-"));
      let healthProbes = 0;
      let child;
      let childClosed;
      try {
        const result = await startBackendService(
          { home, port: 18789, timeoutMs: 100 },
          {
            // This case tests cleanup after an identity failure, not HTTP timing.
            fetch: async () => {
              healthProbes += 1;
              return new Response('{"ok":true,"service":"not-memorax-code"}', {
                status: 200, headers: { "content-type": "application/json" },
              });
            },
            terminateProcessTree,
            isProcessAlive: () => true,
            spawnProcess: (_command, _args, options) => {
              child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], options);
              childClosed = new Promise((resolve) => child.once("close", resolve));
              return child;
            },
          },
        );
        assert.ok(healthProbes > 0);
        assert.equal(result.ok, false);
        assert.match(result.error, /cleanup failed and PID state was retained/);
        assert.equal(result.errorCode, "BACKEND_HEALTH_NOT_READY");
        assert.equal(result.stage, "health");
        assert.equal(result.failureReason, "identity_mismatch");
        assert.equal(result.httpStatus, 200);
        assert.equal(result.cleanupErrorCode, name === "termination failure" ? "BACKEND_TERMINATE_FAILED" : "BACKEND_STOP_TIMEOUT");
        assert.equal(result.processState, name === "termination failure" ? "unknown" : "running");
        assert.equal(readBackendServiceState({ home })?.pid, result.state?.pid);
      } finally {
        // The injected termination functions do not stop the real fixture process.
        if (child && child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
        }
        await childClosed;
        await rm(home, { recursive: true, force: true });
      }
    });
  }
});

test("failed startup clears PID state when the child exits during termination", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-startup-exited-during-cleanup-"));
  let alive = true;
  try {
    const result = await startBackendService({ home, timeoutMs: 0 }, {
      isProcessAlive: () => alive,
      terminateProcessTree: () => { alive = false; return false; },
      spawnProcess: () => {
        const child = new EventEmitter();
        child.pid = 4242;
        child.unref = () => undefined;
        process.nextTick(() => child.emit("spawn"));
        return child;
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "BACKEND_HEALTH_NOT_READY");
    assert.equal(result.processState, "stopped");
    assert.equal(result.cleanupErrorCode, undefined);
    assert.equal(readBackendServiceState({ home }), undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Backend service failure fields keep only allowlisted machine evidence", () => {
  const secret = "private-token-and-command-output";
  const cause = Object.assign(new Error(secret), { code: "EACCES" });
  const error = Object.assign(new Error(secret, { cause }), { code: secret });
  cause.cause = error;
  assert.deepEqual(backendServiceFailureFields(error, "BACKEND_SPAWN_FAILED", "spawn", "not-started"), {
    errorCode: "BACKEND_SPAWN_FAILED",
    stage: "spawn",
    processState: "not-started",
    systemCode: "EACCES",
  });
  const unknown = Object.assign(new Error(secret), { code: secret });
  unknown.cause = unknown;
  unknown.reason = "malformed_json";
  assert.deepEqual(backendServiceFailureFields(unknown, "BACKEND_SPAWN_FAILED", "spawn"), {
    errorCode: "BACKEND_SPAWN_FAILED",
    stage: "spawn",
    processState: "unknown",
  });
  const malformed = new BackendServiceStateError({ status: "invalid", reason: "malformed_json" }, "/test/record");
  assert.equal(backendServiceFailureFields(malformed, "UNUSED", "read_state").recordReason, "malformed_json");
  const custom = new BackendServiceStateError({ status: "invalid", reason: secret }, "/test/record");
  assert.equal(backendServiceFailureFields(custom, "UNUSED", "read_state").recordReason, undefined);
});

test("startup identifies runtime preparation and PID, token, or connection persistence failures", async (t) => {
  for (const [stage, filename, errorCode, directoryOpen] of [
    ["prepare_runtime", "backend.log", "BACKEND_SERVICE_PREPARE_FAILED", 1],
    ["prepare_runtime", "backend.log", "BACKEND_SERVICE_PREPARE_FAILED", 2],
    ["persist_pid", "backend.pid.json", "BACKEND_SERVICE_STATE_WRITE_FAILED"],
    ["persist_token", "backend-token.json", "BACKEND_TOKEN_WRITE_FAILED"],
    ["persist_connection", "backend-connection.json", "BACKEND_CONNECTION_WRITE_FAILED"],
  ]) {
    await t.test(directoryOpen ? `${stage}: log descriptor ${directoryOpen}` : stage, async (t) => {
      const home = await mkdtemp(join(tmpdir(), "memorax-code-startup-persistence-diagnostic-"));
      const directory = join(home, "runtime", "backend");
      const blockedPath = join(directory, filename);
      let alive = false;
      let spawned = false;
      let instanceId;
      let renameMock;
      let openMock;
      const logDescriptors = [];
      try {
        if (stage === "prepare_runtime") {
          await mkdir(blockedPath, { recursive: true });
          await writeFile(join(blockedPath, "keep.txt"), "existing directory content");
          const open = fs.openSync;
          let logOpen = 0;
          openMock = t.mock.method(fs, "openSync", (path, flags, ...args) => {
            if (path !== blockedPath) return open(path, flags, ...args);
            // Windows can open a directory for append; exercise that path on every platform.
            const fd = ++logOpen === directoryOpen
              ? open(path, "r", ...args)
              : open(join(directory, "regular.log"), flags, ...args);
            logDescriptors.push(fd);
            return fd;
          });
          syncBuiltinESMExports();
        }
        if (stage === "persist_token") {
          const rename = fs.renameSync;
          renameMock = t.mock.method(fs, "renameSync", (source, target) => {
            if (target === blockedPath) throw Object.assign(new Error("token publish denied"), { code: "EPERM" });
            return rename(source, target);
          });
          syncBuiltinESMExports();
        }
        const result = await startBackendService({ home, timeoutMs: 10, ...(stage === "persist_token" ? { authToken: "test-token" } : {}) }, {
          isProcessAlive: () => alive,
          terminateProcessTree: () => { alive = false; return true; },
          spawnProcess: (_command, args) => {
            spawned = true;
            alive = true;
            instanceId = args[2];
            if (stage === "persist_pid") mkdirSync(blockedPath);
            const child = new EventEmitter();
            child.pid = 4242;
            child.unref = () => undefined;
            process.nextTick(() => child.emit("spawn"));
            return child;
          },
          fetch: async () => {
            if (stage !== "persist_token") mkdirSync(blockedPath);
            return new Response(JSON.stringify({
              ok: true,
              service: "memorax-code-backend",
              instanceId,
              state: { sessionHome: home },
            }));
          },
        });
        assert.equal(result.ok, false);
        assert.equal(result.errorCode, errorCode);
        assert.equal(result.stage, stage);
        assert.ok(["EISDIR", "EEXIST", "EPERM", "EACCES"].includes(result.systemCode), result.systemCode);
        assert.equal(result.processState, stage === "prepare_runtime" ? "not-started" : "stopped");
        assert.equal(spawned, stage !== "prepare_runtime");
        assert.equal(alive, false);
        assert.equal(result.cleanupErrorCode, undefined);
        if (stage === "prepare_runtime") {
          assert.equal(result.systemCode, "EISDIR");
          assert.equal(readBackendServiceState({ home }), undefined);
          assert.equal(await readFile(join(blockedPath, "keep.txt"), "utf8"), "existing directory content");
          assert.ok(logDescriptors.length > 0);
          for (const fd of logDescriptors) assert.throws(() => fs.fstatSync(fd), { code: "EBADF" });
        }
        if (stage === "persist_token" || stage === "persist_connection") assert.equal(readBackendServiceState({ home }), undefined);
      } finally {
        renameMock?.mock.restore();
        openMock?.mock.restore();
        syncBuiltinESMExports();
        for (const fd of logDescriptors) {
          try { fs.closeSync(fd); } catch (error) { if (error.code !== "EBADF") throw error; }
        }
        await rm(home, { recursive: true, force: true });
      }
    });
  }
});

test("failed health startup retains its primary diagnostic through process or PID cleanup failure", async (t) => {
  for (const cleanup of ["termination error", "replacement PID record"]) {
    await t.test(cleanup, async () => {
      const home = await mkdtemp(join(tmpdir(), "memorax-code-startup-cleanup-diagnostic-"));
      const statePath = join(home, "runtime", "backend", "backend.pid.json");
      let alive = true;
      try {
        const result = await startBackendService({ home, timeoutMs: 10 }, {
          isProcessAlive: () => alive,
          spawnProcess: () => {
            const child = new EventEmitter();
            child.pid = 4242;
            child.unref = () => undefined;
            process.nextTick(() => child.emit("spawn"));
            return child;
          },
          fetch: async () => {
            throw new TypeError("private-health-response", {
              cause: Object.assign(new Error("private-health-response"), { code: "ECONNREFUSED" }),
            });
          },
          terminateProcessTree: () => {
            if (cleanup === "termination error") {
              throw Object.assign(new Error("private-termination-error"), { code: "EPERM" });
            }
            alive = false;
            const state = JSON.parse(readFileSync(statePath, "utf8"));
            writeFileSync(statePath, JSON.stringify({ ...state, pid: 4243, instanceId: "replacement-instance" }));
            return true;
          },
        });
        assert.equal(result.ok, false);
        assert.equal(result.errorCode, "BACKEND_HEALTH_NOT_READY");
        assert.equal(result.stage, "health");
        assert.equal(result.failureReason, "transport");
        assert.equal(result.httpStatus, undefined);
        assert.equal(result.systemCode, "ECONNREFUSED");
        assert.equal(result.processState, cleanup === "termination error" ? "unknown" : "stopped");
        assert.equal(result.cleanupErrorCode, cleanup === "termination error" ? "BACKEND_TERMINATE_FAILED" : "BACKEND_SERVICE_STATE_CLEANUP_FAILED");
        assert.equal(result.cleanupSystemCode, cleanup === "termination error" ? "EPERM" : undefined);
        assert.equal(readBackendServiceState({ home })?.pid, cleanup === "termination error" ? 4242 : 4243);
        assert.doesNotMatch(JSON.stringify(result), /private-health-response|private-termination-error/);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });
  }
});

test("health startup diagnostics preserve the last observed failure category without guessing its cause", async (t) => {
  for (const [name, failureReason, httpStatus, systemCode] of [
    ["HTTP failure", "http_error", 503, undefined],
    ["invalid JSON", "invalid_response", 200, undefined],
    ["other instance", "identity_mismatch", 200, undefined],
    ["transport", "transport", undefined, "ECONNREFUSED"],
    ["HTTP after transport", "http_error", 503, undefined],
  ]) {
    await t.test(name, async () => {
      const home = await mkdtemp(join(tmpdir(), "memorax-code-health-failure-category-"));
      let instanceId;
      let alive = false;
      let attempts = 0;
      try {
        const result = await startBackendService({
          home,
          timeoutMs: name === "HTTP after transport" ? 250 : 10,
        }, {
          spawnProcess: (_command, args) => {
            instanceId = args[2];
            alive = true;
            const child = new EventEmitter();
            child.pid = 4242;
            child.unref = () => undefined;
            process.nextTick(() => child.emit("spawn"));
            return child;
          },
          isProcessAlive: () => alive,
          terminateProcessTree: () => { alive = false; return true; },
          fetch: async () => {
            attempts += 1;
            if (name === "transport" || (name === "HTTP after transport" && attempts === 1)) {
              throw new TypeError("private-health-content", {
                cause: Object.assign(new Error("private-health-content"), { code: "ECONNREFUSED" }),
              });
            }
            if (name === "HTTP failure" || name === "HTTP after transport") {
              return new Response("private-health-content", { status: 503 });
            }
            if (name === "invalid JSON") return new Response("private-health-content");
            return new Response(JSON.stringify({
              ok: true,
              service: "memorax-code-backend",
              instanceId: name === "other instance" ? "another-instance" : instanceId,
              state: { sessionHome: home },
            }));
          },
        });
        assert.equal(result.ok, false);
        assert.equal(result.errorCode, "BACKEND_HEALTH_NOT_READY");
        assert.equal(result.stage, "health");
        assert.equal(result.failureReason, failureReason);
        assert.equal(result.httpStatus, httpStatus);
        assert.equal(result.systemCode, systemCode);
        assert.equal(result.processState, "stopped");
        assert.doesNotMatch(JSON.stringify(result), /private-health-content|another-service|another-instance/);
        if (name === "HTTP after transport") assert.ok(attempts > 1);
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });
  }
});
