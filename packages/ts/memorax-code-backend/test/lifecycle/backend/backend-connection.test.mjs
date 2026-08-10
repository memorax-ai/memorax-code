import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  backendConnectionPath,
  backendTokenPath,
  localBackendRecoveryArguments,
  readBackendConnectionAuthority,
  readBackendTokenRecordState,
  resolveBackendConnection,
  writeBackendConnectionAuthority,
  writeBackendTokenRecord,
} from "../../../../memorax-code-adapter-common/src/backend-connection.mjs";
import {
  ensurePrivateDirectory,
  writePrivateJsonRecord,
} from "../../../../memorax-code-adapter-common/src/runtime-record.mjs";
import { isAdapterReady } from "../../../dist/lifecycle/orchestrator.js";
import { runBackendTokenCommand } from "../../../dist/entrypoints/backend-cli.js";
import {
  backendServiceEndpoint,
  readBackendServiceState,
  readBackendToken,
  startBackendService,
  stopBackendService,
  writeBackendToken,
} from "../../../dist/lifecycle/backend/service.js";
import { runBackendStatus } from "../../../dist/lifecycle/backend/status.js";
import { freePort } from "../../support/helpers.mjs";

test("automatic Backend recovery only targets loopback lifecycle endpoints", () => {
  assert.deepEqual(localBackendRecoveryArguments({
    url: "http://127.0.0.1:8787",
    source: "default",
  }), []);
  assert.deepEqual(localBackendRecoveryArguments({
    url: "http://[::1]:8877",
    source: "environment",
  }), ["--host", "::1", "--port", "8877"]);
  assert.equal(localBackendRecoveryArguments({
    url: "http://backend.example:8877",
    source: "environment",
  }), undefined);
  assert.equal(localBackendRecoveryArguments({
    url: "https://127.0.0.1:8877",
    source: "environment",
  }), undefined);
});

test("runtime records use a private durable replace without stale temporary files", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-runtime-record-"));
  const recordPath = join(home, "runtime", "backend", "record.json");
  try {
    writePrivateJsonRecord(
      recordPath,
      { version: 1, value: "first" },
      { durableBoundary: home },
    );
    writePrivateJsonRecord(
      recordPath,
      { version: 1, value: "second" },
      { durableBoundary: home },
    );

    assert.deepEqual(JSON.parse(await readFile(recordPath, "utf8")), {
      version: 1,
      value: "second",
    });
    assert.deepEqual(await readdir(join(home, "runtime", "backend")), ["record.json"]);
    if (process.platform !== "win32") {
      assert.equal((await stat(recordPath)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("runtime record reports post-rename directory sync failure as an uncertain commit", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-runtime-record-uncertain-"));
  const recordPath = join(home, "runtime", "backend", "record.json");
  try {
    const result = writePrivateJsonRecord(
      recordPath,
      { version: 1, value: "installed" },
      {
        durableBoundary: home,
        syncDirectory() {
          const error = new Error("directory sync unavailable");
          error.code = "EINVAL";
          throw error;
        },
      },
    );

    assert.deepEqual(result, {
      path: recordPath,
      record: { version: 1, value: "installed" },
      durability: "uncertain",
      durabilityErrorCode: "EINVAL",
    });
    assert.deepEqual(JSON.parse(await readFile(recordPath, "utf8")), result.record);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("runtime record tightens a pre-existing private state directory", {
  skip: process.platform === "win32",
}, async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-runtime-record-mode-"));
  const runtime = join(home, "runtime", "backend");
  const recordPath = join(runtime, "record.json");
  try {
    await mkdir(runtime, { recursive: true });
    await chmod(runtime, 0o777);

    const result = writePrivateJsonRecord(
      recordPath,
      { version: 1 },
      { durableBoundary: home },
    );

    assert.equal(result.durability, "confirmed");
    assert.equal((await stat(runtime)).mode & 0o777, 0o700);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("private directory durability retries through its boundary without crossing it", {
  skip: process.platform === "win32",
}, async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-runtime-directory-retry-"));
  const runtime = join(home, "runtime", "backend");
  const expectedChain = [runtime, join(home, "runtime"), home];
  const firstAttempt = [];
  const secondAttempt = [];
  try {
    assert.throws(
      () => ensurePrivateDirectory(runtime, {
        durableBoundary: home,
        syncDirectory(path) {
          firstAttempt.push(path);
          if (path === home) {
            const error = new Error("ancestor sync failed");
            error.code = "EIO";
            throw error;
          }
        },
      }),
      (error) => error?.code === "EIO",
    );
    assert.deepEqual(firstAttempt, expectedChain);

    ensurePrivateDirectory(runtime, {
      durableBoundary: home,
      syncDirectory(path) {
        secondAttempt.push(path);
      },
    });
    assert.deepEqual(secondAttempt, expectedChain);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("private directory durability requires a containing ownership boundary", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-runtime-directory-boundary-"));
  const runtime = join(home, "runtime", "backend");
  try {
    assert.throws(
      () => ensurePrivateDirectory(runtime, {}),
      /requires an explicit durable boundary/,
    );
    assert.throws(
      () => ensurePrivateDirectory(runtime, {
        durableBoundary: join(home, "other-owner"),
      }),
      /must be contained by its durable boundary/,
    );
    await assert.rejects(stat(runtime), (error) => error?.code === "ENOENT");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("successful service start surfaces uncertain PID, token, and connection commits", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-runtime-record-service-warning-"));
  const port = await freePort();
  let started;
  try {
    started = await startBackendService({
      home,
      port,
      authToken: "runtime-record-warning-token",
      timeoutMs: 5000,
    }, {
      recordWriteRuntime: {
        syncDirectory() {
          const error = new Error("directory sync unavailable");
          error.code = "EIO";
          throw error;
        },
      },
    });

    assert.equal(started.ok, true, started.error);
    assert.equal(started.degraded, true);
    assert.deepEqual(started.warnings?.map((warning) => warning.record), [
      "pid",
      "token",
      "connection",
    ]);
    assert(started.warnings?.every((warning) =>
      warning.code === "BACKEND_RUNTIME_RECORD_DURABILITY_UNCERTAIN"
      && warning.errorCode === "EIO"));
    assert.equal(readBackendServiceState({ home })?.pid, started.state?.pid);
    assert.equal(readBackendToken({ home })?.token, "runtime-record-warning-token");
    assert.equal(readBackendConnectionAuthority(home).status, "valid");
  } finally {
    await stopBackendService({ home, port, timeoutMs: 3000 });
    await rm(home, { recursive: true, force: true });
  }
});

test("token rotation reports an uncertain installed record as degraded", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-runtime-record-token-warning-"));
  try {
    const result = await runBackendTokenCommand(
      { home },
      ["node", "memorax-code", "token", "--rotate"],
      {
        syncDirectory() {
          const error = new Error("directory sync unavailable");
          error.code = "EINVAL";
          throw error;
        },
      },
    );

    assert.equal(result.ok, true);
    assert.equal(result.degraded, true);
    assert.deepEqual(result.warnings, [{
      code: "BACKEND_RUNTIME_RECORD_DURABILITY_UNCERTAIN",
      record: "token",
      errorCode: "EINVAL",
      message: "Backend token record was installed, but crash durability could not be confirmed",
    }]);
    assert.equal(readBackendToken({ home })?.token, result.token);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("connection authority distinguishes absent invalid and unsupported records", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-backend-connection-state-"));
  const authorityPath = backendConnectionPath(home);
  try {
    assert.deepEqual(readBackendConnectionAuthority(home), { status: "absent" });
    assert.equal(resolveBackendConnection({ memoraxCodeHome: home, env: {} }).source, "default");

    await mkdir(join(home, "runtime", "backend"), { recursive: true });
    await writeFile(authorityPath, "{not-json\n");
    assert.deepEqual(readBackendConnectionAuthority(home), {
      status: "invalid",
      reason: "malformed_json",
    });
    assert.throws(
      () => resolveBackendConnection({ memoraxCodeHome: home, env: {} }),
      (error) => error?.code === "BACKEND_CONNECTION_AUTHORITY_INVALID"
        && error?.authorityStatus === "invalid",
    );

    const explicitOverride = resolveBackendConnection({
      memoraxCodeHome: home,
      backendUrl: "http://127.0.0.1:9988",
      env: {},
    });
    assert.equal(explicitOverride.source, "option");
    assert.equal(explicitOverride.url, "http://127.0.0.1:9988");
    assert.equal(explicitOverride.authority, undefined);
    assert.equal(explicitOverride.token, undefined);

    await writeFile(authorityPath, `${JSON.stringify({
      version: 2,
      url: "http://127.0.0.1:8877",
    })}\n`);
    assert.deepEqual(readBackendConnectionAuthority(home), {
      status: "unsupported",
      version: 2,
    });
    assert.throws(
      () => resolveBackendConnection({ memoraxCodeHome: home, env: {} }),
      (error) => error?.code === "BACKEND_CONNECTION_AUTHORITY_UNSUPPORTED"
        && error?.authorityStatus === "unsupported",
    );

    await writeFile(authorityPath, `${JSON.stringify({
      version: 1,
      url: "http://127.0.0.1:8877",
      tokenPath: join(home, "not-the-canonical-token.json"),
    })}\n`);
    assert.deepEqual(readBackendConnectionAuthority(home), {
      status: "invalid",
      reason: "invalid_token_path",
    });

    await writeFile(authorityPath, `${JSON.stringify({
      version: 1,
      url: "http://127.0.0.1:8877",
      unexpectedEndpoint: "http://127.0.0.1:8787",
    })}\n`);
    assert.deepEqual(readBackendConnectionAuthority(home), {
      status: "invalid",
      reason: "unknown_fields",
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("token record distinguishes valid invalid and unsupported state", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-backend-token-state-"));
  const tokenPath = backendTokenPath(home);
  try {
    assert.deepEqual(readBackendTokenRecordState(home), { status: "absent" });

    await mkdir(join(home, "runtime", "backend"), { recursive: true });
    await writeFile(tokenPath, `${JSON.stringify({
      version: 1,
      token: "current-token",
      createdAt: "2026-07-26T00:00:00.000Z",
    })}\n`, { mode: 0o600 });
    assert.deepEqual(readBackendTokenRecordState(home), {
      status: "valid",
      record: {
        version: 1,
        token: "current-token",
        createdAt: "2026-07-26T00:00:00.000Z",
      },
    });

    await writeFile(tokenPath, `${JSON.stringify({
      version: 1,
      token: "closed-schema-token",
      createdAt: "2026-07-26T00:00:00.000Z",
      unexpectedToken: "must-not-be-accepted",
    })}\n`, { mode: 0o600 });
    assert.deepEqual(readBackendTokenRecordState(home), {
      status: "invalid",
      reason: "unknown_fields",
    });

    await writeFile(tokenPath, "{not-json\n", { mode: 0o600 });
    assert.deepEqual(readBackendTokenRecordState(home), {
      status: "invalid",
      reason: "malformed_json",
    });
    writeBackendConnectionAuthority({
      memoraxCodeHome: home,
      url: "http://127.0.0.1:8877",
      tokenPath,
    });
    assert.throws(
      () => resolveBackendConnection({ memoraxCodeHome: home, env: {} }),
      (error) => error?.code === "BACKEND_TOKEN_RECORD_INVALID"
        && error?.recordStatus === "invalid",
    );

    await rm(tokenPath, { force: true });
    assert.throws(
      () => resolveBackendConnection({ memoraxCodeHome: home, env: {} }),
      (error) => error?.code === "BACKEND_TOKEN_RECORD_ABSENT"
        && error?.recordStatus === "absent",
    );

    await writeFile(tokenPath, `${JSON.stringify({
      version: 2,
      token: "future-token",
      createdAt: "2026-07-26T00:00:00.000Z",
    })}\n`, { mode: 0o600 });
    assert.deepEqual(readBackendTokenRecordState(home), {
      status: "unsupported",
      version: 2,
    });

    await rm(tokenPath, { force: true });
    const written = writeBackendTokenRecord({
      memoraxCodeHome: home,
      token: "current-token",
      createdAt: "2026-07-27T00:00:00.000Z",
    });
    assert.deepEqual(written.record, {
      version: 1,
      token: "current-token",
      createdAt: "2026-07-27T00:00:00.000Z",
    });
    assert.deepEqual(JSON.parse(await readFile(tokenPath, "utf8")), written.record);
    if (process.platform !== "win32") {
      assert.equal((await stat(tokenPath)).mode & 0o777, 0o600);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("implicit service start rejects an invalid authority while an explicit bind repairs it", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-backend-connection-repair-"));
  const port = await freePort();
  try {
    await mkdir(join(home, "runtime", "backend"), { recursive: true });
    await writeFile(backendConnectionPath(home), "{not-json\n");

    assert.throws(
      () => backendServiceEndpoint({ home }),
      (error) => error?.code === "BACKEND_CONNECTION_AUTHORITY_INVALID",
    );
    const refused = await startBackendService({ home, timeoutMs: 200 });
    assert.equal(refused.ok, false);
    assert.match(refused.error ?? "", /Backend connection authority is invalid/);
    assert.equal(readBackendServiceState({ home }), undefined);

    assert.deepEqual(backendServiceEndpoint({ home, port }), {
      host: "127.0.0.1",
      port,
      url: `http://127.0.0.1:${port}`,
    });
    const started = await startBackendService({ home, port, timeoutMs: 5000 });
    assert.equal(started.ok, true, started.error);
    assert.deepEqual(readBackendConnectionAuthority(home), {
      status: "valid",
      authority: {
        version: 1,
        url: `http://127.0.0.1:${port}`,
      },
    });
  } finally {
    await stopBackendService({ home, timeoutMs: 5000 });
    await rm(home, { recursive: true, force: true });
  }
});

test("persistent Backend connection resolves URL and token without leaking the token to an override", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-backend-connection-"));
  const tokenPath = backendTokenPath(home);
  try {
    await mkdir(join(home, "runtime", "backend"), { recursive: true });
    await writeFile(tokenPath, `${JSON.stringify({
      version: 1,
      token: "persisted-token",
      createdAt: "2026-07-26T00:00:00.000Z",
    })}\n`, { mode: 0o600 });
    const written = writeBackendConnectionAuthority({
      memoraxCodeHome: home,
      url: "http://127.0.0.1:8877/",
      tokenPath,
    });

    assert.equal(written.path, backendConnectionPath(home));
    assert.deepEqual(readBackendConnectionAuthority(home), {
      status: "valid",
      authority: {
        version: 1,
        url: "http://127.0.0.1:8877",
        tokenPath,
      },
    });
    assert.deepEqual(resolveBackendConnection({
      memoraxCodeHome: home,
      env: {},
    }), {
      memoraxCodeHome: home,
      authorityPath: backendConnectionPath(home),
      authority: {
        version: 1,
        url: "http://127.0.0.1:8877",
        tokenPath,
      },
      url: "http://127.0.0.1:8877",
      source: "authority",
      host: "127.0.0.1",
      port: 8877,
      token: "persisted-token",
      tokenSource: "authority-file",
    });

    const overridden = resolveBackendConnection({
      memoraxCodeHome: home,
      backendUrl: "http://127.0.0.1:9988",
      env: {},
    });
    assert.equal(overridden.url, "http://127.0.0.1:9988");
    assert.equal(overridden.token, undefined);
    assert.equal(overridden.tokenSource, "none");

    const environmentToken = resolveBackendConnection({
      memoraxCodeHome: home,
      env: {
        MEMORAX_CODE_BACKEND_URL: "http://127.0.0.1:8877",
        MEMORAX_CODE_BACKEND_TOKEN: "environment-token",
      },
    });
    assert.equal(environmentToken.url, "http://127.0.0.1:8877");
    assert.equal(environmentToken.token, "environment-token");
    assert.equal(environmentToken.tokenSource, "environment");

    const hostPortOverride = resolveBackendConnection({
      memoraxCodeHome: home,
      env: {
        MEMORAX_CODE_BACKEND_HOST: "127.0.0.1",
        MEMORAX_CODE_BACKEND_PORT: "9989",
      },
    });
    assert.equal(hostPortOverride.url, "http://127.0.0.1:9989");
    assert.equal(hostPortOverride.token, undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("successful service start persists a custom endpoint and token for restart", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-backend-restart-connection-"));
  const port = await freePort();
  const previousLoopbackAuth = process.env.MEMORAX_CODE_BACKEND_LOOPBACK_AUTH;
  process.env.MEMORAX_CODE_BACKEND_LOOPBACK_AUTH = "1";
  try {
    const token = writeBackendToken({ home });
    const started = await startBackendService({ home, port, timeoutMs: 5000 });
    assert.equal(started.ok, true, started.error);
    assert.deepEqual(readBackendConnectionAuthority(home), {
      status: "valid",
      authority: {
        version: 1,
        url: `http://127.0.0.1:${port}`,
        tokenPath: token.tokenPath,
      },
    });
    assert.equal(readBackendToken({ home })?.token, token.token);

    const stopped = await stopBackendService({ home, timeoutMs: 5000 });
    assert.equal(stopped.ok, true, stopped.error);
    assert.equal(readBackendConnectionAuthority(home).authority?.url, `http://127.0.0.1:${port}`);

    const restarted = await startBackendService({ home, timeoutMs: 5000 });
    assert.equal(restarted.ok, true, restarted.error);
    assert.equal(restarted.state?.port, port);
    const state = readBackendServiceState({ home });
    const mismatchedStatus = await runBackendStatus(
      `http://127.0.0.1:${port}`,
      token.token,
      1000,
      {
        url: "http://127.0.0.1:8787",
        instanceId: state?.instanceId,
        sessionHome: home,
      },
    );
    assert.equal(mismatchedStatus.ok, false);
    assert.deepEqual(mismatchedStatus.identity, {
      urlMatches: false,
      instanceIdMatches: true,
      sessionHomeMatches: true,
    });
  } finally {
    await stopBackendService({ home, timeoutMs: 5000 });
    if (previousLoopbackAuth === undefined) delete process.env.MEMORAX_CODE_BACKEND_LOOPBACK_AUTH;
    else process.env.MEMORAX_CODE_BACKEND_LOOPBACK_AUTH = previousLoopbackAuth;
    await rm(home, { recursive: true, force: true });
  }
});

test("explicitly disabling loopback auth clears the active token reference without deleting the token", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-backend-disable-loopback-auth-"));
  const port = await freePort();
  const previousLoopbackAuth = process.env.MEMORAX_CODE_BACKEND_LOOPBACK_AUTH;
  try {
    const token = writeBackendToken({ home });
    process.env.MEMORAX_CODE_BACKEND_LOOPBACK_AUTH = "1";
    const authenticated = await startBackendService({ home, port, timeoutMs: 5000 });
    assert.equal(authenticated.ok, true, authenticated.error);
    assert.equal((await runBackendStatus(`http://127.0.0.1:${port}`)).authRequired, true);
    assert.equal((await stopBackendService({ home, timeoutMs: 5000 })).ok, true);

    process.env.MEMORAX_CODE_BACKEND_LOOPBACK_AUTH = "0";
    const unauthenticated = await startBackendService({ home, timeoutMs: 5000 });
    assert.equal(unauthenticated.ok, true, unauthenticated.error);
    assert.equal((await runBackendStatus(`http://127.0.0.1:${port}`)).authRequired, false);
    assert.deepEqual(readBackendConnectionAuthority(home), {
      status: "valid",
      authority: {
        version: 1,
        url: `http://127.0.0.1:${port}`,
      },
    });
    assert.equal(readBackendToken({ home })?.token, token.token);
  } finally {
    await stopBackendService({ home, timeoutMs: 5000 });
    if (previousLoopbackAuth === undefined) delete process.env.MEMORAX_CODE_BACKEND_LOOPBACK_AUTH;
    else process.env.MEMORAX_CODE_BACKEND_LOOPBACK_AUTH = previousLoopbackAuth;
    await rm(home, { recursive: true, force: true });
  }
});

test("failed service start preserves the last successful connection and token", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-backend-failed-connection-"));
  const oldToken = "last-successful-token";
  const tokenPath = backendTokenPath(home);
  const occupied = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true,"service":"not-memorax-code"}');
  });
  try {
    await mkdir(join(home, "runtime", "backend"), { recursive: true });
    await writeFile(tokenPath, `${JSON.stringify({
      version: 1,
      token: oldToken,
      createdAt: "2026-07-26T00:00:00.000Z",
    })}\n`, { mode: 0o600 });
    writeBackendConnectionAuthority({
      memoraxCodeHome: home,
      url: "http://127.0.0.1:8877",
      tokenPath,
    });
    await new Promise((resolve, reject) => {
      occupied.once("error", reject);
      occupied.listen(0, "127.0.0.1", resolve);
    });
    const address = occupied.address();
    assert(address && typeof address === "object");

    const failed = await startBackendService({
      home,
      port: address.port,
      authToken: "replacement-token",
      timeoutMs: 200,
    });
    assert.equal(failed.ok, false);
    assert.equal(readBackendToken({ home })?.token, oldToken);
    assert.deepEqual(readBackendConnectionAuthority(home), {
      status: "valid",
      authority: {
        version: 1,
        url: "http://127.0.0.1:8877",
        tokenPath,
      },
    });
  } finally {
    await new Promise((resolve) => occupied.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test("adapter readiness fails closed when its endpoint differs from the Backend authority", () => {
  assert.equal(isAdapterReady({
    ok: true,
    installed: true,
    enabled: true,
    integration: "hooks",
    backendUrlMatches: false,
    codexSkills: { ok: true, status: "plugin-managed" },
  }), false);
});
