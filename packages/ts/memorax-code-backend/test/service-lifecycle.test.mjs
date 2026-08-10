import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  isProcessAlive,
  readBackendServiceRecordState,
  readBackendServiceState,
  startBackendService,
  stopBackendService,
  terminateProcessTree,
} from "../dist/lifecycle/backend/service.js";
import { removeBackendServiceStateIfOwnedAtPath } from "../dist/lifecycle/backend/record.js";
import { backendShutdownRequestPath } from "../dist/lifecycle/backend/shutdown-request.js";

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
    assert.equal(spawned, false);
    const stop = await stopBackendService({ home, timeoutMs: 50 });
    assert.equal(stop.ok, false);
    assert.equal(stop.errorCode, "BACKEND_SERVICE_STATE_INVALID");

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
    const result = await startBackendService({ home, port, timeoutMs: 200 });
    assert.equal(result.ok, false);
    assert.match(result.error, /did not become healthy/);
    assert.equal(readBackendServiceState({ home }), undefined);
  } finally {
    await new Promise((resolve) => occupied.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test("service spawn error and missing PID fail before writing state", async (t) => {
  for (const [name, emit] of [
    ["spawn error", (child) => child.emit("error", new Error("spawn denied"))],
    ["missing PID", (child) => child.emit("spawn")],
  ]) {
    await t.test(name, async () => {
      const home = await mkdtemp(join(tmpdir(), "memorax-code-backend-spawn-failure-"));
      try {
        const child = new EventEmitter();
        child.pid = undefined;
        child.unref = () => undefined;
        const result = await startBackendService({ home, timeoutMs: 50 }, {
          spawnProcess: () => {
            process.nextTick(() => emit(child));
            return child;
          },
        });
        assert.equal(result.ok, false);
        assert.match(result.error, /failed to spawn Backend process/);
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
    assert.match(result.error, /refusing to stop unverified process/);
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
      const occupied = createServer((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true,"service":"not-memorax-code"}');
      });
      const port = await listen(occupied);
      try {
        const result = await startBackendService(
          { home, port, timeoutMs: 100 },
          { terminateProcessTree, isProcessAlive: () => true },
        );
        assert.equal(result.ok, false);
        assert.match(result.error, /cleanup failed and PID state was retained/);
        assert.equal(readBackendServiceState({ home })?.pid, result.state?.pid);
      } finally {
        await new Promise((resolve) => occupied.close(resolve));
        await rm(home, { recursive: true, force: true });
      }
    });
  }
});
