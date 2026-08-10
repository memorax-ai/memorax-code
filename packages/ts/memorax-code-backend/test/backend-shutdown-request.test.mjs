import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  backendShutdownRequestPath,
  startBackendShutdownRequestWatcher,
  writeBackendShutdownRequest,
} from "../dist/lifecycle/backend/shutdown-request.js";

test("shutdown request watcher ignores stale instances and consumes the current instance", async () => {
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-backend-shutdown-request-"));
  const requestPath = backendShutdownRequestPath(memoraxCodeHome);
  let resolveShutdown;
  const shutdownRequested = new Promise((resolve) => {
    resolveShutdown = resolve;
  });
  try {
    writeBackendShutdownRequest(memoraxCodeHome, {
      pid: 100,
      instanceId: "stale-instance",
    });
    const staleRecord = JSON.parse(await readFile(requestPath, "utf8"));
    assert.deepEqual(
      {
        version: staleRecord.version,
        pid: staleRecord.pid,
        instanceId: staleRecord.instanceId,
        requestedAt: typeof staleRecord.requestedAt,
      },
      {
        version: 1,
        pid: 100,
        instanceId: "stale-instance",
        requestedAt: "string",
      },
    );

    const watcher = startBackendShutdownRequestWatcher({
      memoraxCodeHome,
      pid: 200,
      instanceId: "current-instance",
      onShutdown() {
        resolveShutdown();
      },
    });
    try {
      await assert.rejects(readFile(requestPath, "utf8"), { code: "ENOENT" });
      writeBackendShutdownRequest(memoraxCodeHome, {
        pid: 200,
        instanceId: "current-instance",
      });
      await shutdownRequested;
      await assert.rejects(readFile(requestPath, "utf8"), { code: "ENOENT" });
    } finally {
      watcher.close();
    }
  } finally {
    await rm(memoraxCodeHome, { recursive: true, force: true });
  }
});

test("closing the shutdown request watcher removes an unconsumed request", async () => {
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-backend-shutdown-close-"));
  const requestPath = backendShutdownRequestPath(memoraxCodeHome);
  try {
    const watcher = startBackendShutdownRequestWatcher({
      memoraxCodeHome,
      pid: 300,
      instanceId: "current-instance",
      onShutdown() {
        assert.fail("shutdown should not be requested");
      },
    });
    writeBackendShutdownRequest(memoraxCodeHome, {
      pid: 301,
      instanceId: "next-instance",
    });
    watcher.close();
    await assert.rejects(readFile(requestPath, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(memoraxCodeHome, { recursive: true, force: true });
  }
});
