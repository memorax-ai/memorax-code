import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runBackendStatus } from "../../../dist/lifecycle/backend/status.js";
import { backendServiceLogs, isProcessAlive, readBackendToken, startBackendService, stopBackendService, terminateProcessTree, writeBackendToken } from "../../../dist/lifecycle/backend/service.js";
import { freePort, listen } from "../../support/helpers.mjs";
import { writeActiveManagedClients } from "../../../dist/lifecycle/active-clients.js";

import {
  pathExists,
  restoreEnv,
  runCli,
  waitForProcessExit,
} from "../support/backend-service-fixtures.mjs";

test("Backend service manager can start, report logs, and stop a local Backend", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-service-home-"));
  const port = await freePort();
  try {
    const started = await startBackendService({ home, port, timeoutMs: 5000 });
    assert.equal(started.ok, true);
    assert.equal(started.state?.port, port);
    const pidPath = join(home, "runtime", "backend", "backend.pid.json");
    assert.equal(JSON.parse(await readFile(pidPath, "utf8")).version, 1);
    if (process.platform !== "win32") {
      assert.equal((await stat(pidPath)).mode & 0o777, 0o600);
    }
    const status = await runBackendStatus(`http://127.0.0.1:${port}`);
    assert.equal(status.ok, true);
    const logs = backendServiceLogs({ home });
    assert.equal(logs.ok, true);
    assert.match(logs.text ?? "", /memorax-code-backend listening/);
  } finally {
    const stopped = await stopBackendService({ home, port, timeoutMs: 5000 });
    assert.equal(stopped.ok, true);
  }
});

test("Backend service keeps Claude native Viewer enrichment behind the live managed-client gate", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-service-claude-viewer-home-"));
  const claudeHome = await mkdtemp(join(tmpdir(), "memorax-code-service-claude-viewer-config-"));
  const workspace = join(home, "workspace", "Claude-Repo");
  const projectsRoot = join(claudeHome, "projects");
  const transcriptDirectory = join(projectsRoot, "encoded-project");
  const port = await freePort();
  try {
    await Promise.all([
      mkdir(join(workspace, ".git"), { recursive: true }),
      mkdir(transcriptDirectory, { recursive: true }),
    ]);
    await writeFile(
      join(transcriptDirectory, "native-session.jsonl"),
      `${[
        {
          type: "user",
          userType: "external",
          sessionId: "native-session",
          uuid: "native-user-record",
          promptId: "native-turn",
          cwd: workspace,
          timestamp: new Date().toISOString(),
          message: { role: "user", content: "private managed Claude prompt" },
        },
        {
          type: "assistant",
          sessionId: "native-session",
          uuid: "native-tool-use",
          parentUuid: "native-user-record",
          cwd: workspace,
          timestamp: new Date().toISOString(),
          message: {
            role: "assistant",
            stop_reason: "tool_use",
            content: [{
              type: "tool_use",
              id: "native-memory-search",
              name: "Bash",
              input: {
                command: "memorax-cli search --query private-managed-query",
              },
            }],
          },
        },
        {
          type: "user",
          userType: "external",
          sessionId: "native-session",
          uuid: "native-tool-result",
          parentUuid: "native-tool-use",
          cwd: workspace,
          timestamp: new Date().toISOString(),
          message: {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: "native-memory-search",
              content: [
                "<memories>",
                "  <facts memory_type=\"core\">",
                "   - private managed result",
                "  </facts>",
                "</memories>",
              ].join("\n"),
            }],
          },
        },
        {
          type: "assistant",
          sessionId: "native-session",
          uuid: "native-final-answer",
          parentUuid: "native-tool-result",
          cwd: workspace,
          timestamp: new Date(Date.now() + 1_000).toISOString(),
          message: {
            role: "assistant",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "private managed final answer" }],
          },
        },
      ].map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );
    const traceDirectory = join(home, "debug", "traces", "claude", "sessions", "native-session");
    await mkdir(traceDirectory, { recursive: true });
    await writeFile(join(traceDirectory, "events.jsonl"), `${JSON.stringify({
      type: "turn_start",
      event_id: "managed-hook-start",
      timestamp: new Date().toISOString(),
      trace: {
        client: "claude",
        session_id: "native-session",
        turn_id: "native-turn",
        cwd: workspace,
      },
      operation: "query",
      request: { prompt: "Hook managed Claude prompt." },
    })}\n`, "utf8");
    writeActiveManagedClients(home, { codex: false, claude: true, opencode: false });
    const started = await startBackendService({
      home,
      port,
      timeoutMs: 5000,
      claudeProjectsRoot: projectsRoot,
    });
    assert.equal(started.ok, true);
    const endpoint = `http://127.0.0.1:${port}/memory-viewer/api/summary?client=claude-code`;
    const enabled = await fetch(endpoint).then((response) => response.json());
    assert.equal(enabled.summary.searchOperationCount, 1);
    assert.doesNotMatch(JSON.stringify(enabled), /private managed/);

    writeActiveManagedClients(home, { codex: false, claude: false, opencode: false });
    const disabled = await fetch(endpoint).then((response) => response.json());
    assert.equal(disabled.summary.searchOperationCount, 0);
    assert.doesNotMatch(JSON.stringify(disabled), /private managed/);

    writeActiveManagedClients(home, { codex: false, claude: true, opencode: false });
    const reenabled = await fetch(endpoint).then((response) => response.json());
    assert.equal(reenabled.summary.searchOperationCount, 1);
    assert.doesNotMatch(JSON.stringify(reenabled), /private managed/);
  } finally {
    await stopBackendService({ home, port, timeoutMs: 5000 });
    await rm(home, { recursive: true, force: true });
    await rm(claudeHome, { recursive: true, force: true });
  }
});

test("memorax-code lifecycle serializes concurrent starts without losing PID authority", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-concurrent-start-home-"));
  const port = await freePort();
  const runtimeDir = join(home, "runtime", "backend");
  const pidPath = join(runtimeDir, "backend.pid.json");
  const cliPath = fileURLToPath(new URL("../../../dist/memorax-code.js", import.meta.url));
  const observedPids = new Set();
  try {
    const args = [
      "start",
      "--json",
      "--home", home,
      "--port", String(port),
      "--clients", "none",
    ];
    const starts = await Promise.all([
      runCli(cliPath, args),
      runCli(cliPath, args),
    ]);
    for (const started of starts) {
      assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`);
      const report = JSON.parse(started.stdout);
      if (Number.isSafeInteger(report.backend?.state?.pid)) {
        observedPids.add(report.backend.state.pid);
      }
    }
    const state = JSON.parse(await readFile(pidPath, "utf8"));
    observedPids.add(state.pid);
    assert.equal(state.version, 1);
    assert.equal(typeof state.instanceId, "string");
    const health = await fetch(`http://127.0.0.1:${port}/health`).then((response) => response.json());
    assert.equal(health.instanceId, state.instanceId);
    assert.equal(isProcessAlive(state.pid), true);

    const stopped = await runCli(cliPath, [
      "stop",
      "--json",
      "--home", home,
      "--clients", "none",
    ]);
    assert.equal(stopped.code, 0, `${stopped.stdout}\n${stopped.stderr}`);
    assert.equal(await pathExists(pidPath), false);
    assert.equal(isProcessAlive(state.pid), false);
  } finally {
    await runCli(cliPath, ["stop", "--json", "--home", home, "--clients", "none"]);
    for (const pid of observedPids) {
      if (!isProcessAlive(pid)) continue;
      terminateProcessTree(pid);
      await waitForProcessExit(pid);
    }
    await rm(home, { recursive: true, force: true });
  }
});

test("Backend service rejects an unrelated healthy server and clears its pid file", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-service-health-identity-home-"));
  const unrelated = createServer((_, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, service: "unrelated-service" }));
  });
  const url = await listen(unrelated);
  try {
    const status = await runBackendStatus(url);
    assert.equal(status.ok, false);
    const started = await startBackendService({ home, port: Number(new URL(url).port), timeoutMs: 300 });

    assert.equal(started.ok, false);
    assert.match(started.error, /did not become healthy/);
    assert.equal(await pathExists(join(home, "runtime", "backend", "backend.pid.json")), false);
  } finally {
    await new Promise((resolve) => unrelated.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test("Backend service rejects a healthy MemoraX Code Backend for another session home", async () => {
  const expectedHome = await mkdtemp(join(tmpdir(), "memorax-code-service-expected-home-"));
  const otherHome = await mkdtemp(join(tmpdir(), "memorax-code-service-other-home-"));
  const otherBackend = createServer((_, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      ok: true,
      service: "memorax-code-backend",
      state: { sessionHome: otherHome },
    }));
  });
  const url = await listen(otherBackend);
  try {
    const started = await startBackendService({
      home: expectedHome,
      port: Number(new URL(url).port),
      timeoutMs: 300,
    });

    assert.equal(started.ok, false);
    assert.match(started.error, /did not become healthy/);
    assert.equal(await pathExists(join(expectedHome, "runtime", "backend", "backend.pid.json")), false);
  } finally {
    await new Promise((resolve) => otherBackend.close(resolve));
    await rm(expectedHome, { recursive: true, force: true });
    await rm(otherHome, { recursive: true, force: true });
  }
});

test("Backend health probes bound response consumption to the total timeout budget", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-service-health-timeout-home-"));
  const timers = new Set();
  const slowBackend = createServer((_, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.flushHeaders();
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!response.destroyed) {
        response.end(JSON.stringify({
          ok: true,
          service: "memorax-code-backend",
          state: { sessionHome: home },
        }));
      }
    }, 800);
    timers.add(timer);
    response.on("close", () => {
      clearTimeout(timer);
      timers.delete(timer);
    });
  });
  const url = await listen(slowBackend);
  try {
    const statusStartedAt = Date.now();
    const status = await runBackendStatus(url, undefined, 100);
    const statusElapsedMs = Date.now() - statusStartedAt;

    const startStartedAt = Date.now();
    const started = await startBackendService({
      home,
      port: Number(new URL(url).port),
      timeoutMs: 100,
    });
    const startElapsedMs = Date.now() - startStartedAt;

    assert.equal(status.ok, false);
    assert.ok(statusElapsedMs < 500, `status probe exceeded budget: ${statusElapsedMs}ms`);
    assert.equal(started.ok, false);
    assert.ok(startElapsedMs < 500, `service health check exceeded budget: ${startElapsedMs}ms`);
    assert.equal(await pathExists(join(home, "runtime", "backend", "backend.pid.json")), false);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    slowBackend.closeAllConnections?.();
    await new Promise((resolve) => slowBackend.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test("Backend service can use persisted local token", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-service-token-home-"));
  const port = await freePort();
  const token = writeBackendToken({ home });
  assert.equal(readBackendToken({ home })?.token, token.token);
  const rotated = writeBackendToken({ home }, true);
  assert.notEqual(rotated.token, token.token);
  assert.equal(readBackendToken({ home })?.token, rotated.token);
  const previousLoopbackAuth = process.env.MEMORAX_CODE_BACKEND_LOOPBACK_AUTH;
  process.env.MEMORAX_CODE_BACKEND_LOOPBACK_AUTH = "1";

  try {
    const started = await startBackendService({ home, port, timeoutMs: 5000 });
    assert.equal(started.ok, true);
    const status = await runBackendStatus(`http://127.0.0.1:${port}`);
    assert.equal(status.ok, true);
    assert.equal(status.authRequired, true);
    const cliPath = fileURLToPath(new URL("../../../dist/memorax-code.js", import.meta.url));
    const blockedRotation = await runCli(cliPath, ["token", "--rotate", "--home", home]);
    assert.equal(blockedRotation.code, 1);
    assert.match(blockedRotation.stdout, /stop the managed Backend before rotating its token/);
    assert.equal(readBackendToken({ home })?.token, rotated.token);

    const memoryHookUrl = new URL("/memory/turn-start", `http://127.0.0.1:${port}`);
    const memoryHookBody = JSON.stringify({
      version: 1,
      client: "codex",
      sessionId: "authenticated-memory-hook",
      prompt: "Authenticate this memory Hook command.",
      transcriptPath: "/tmp/authenticated-memory-hook.jsonl",
    });
    const rejected = await fetch(memoryHookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: memoryHookBody,
    });
    assert.equal(rejected.status, 401);
    const authorized = await fetch(memoryHookUrl, {
      method: "POST",
      headers: {
        authorization: `Bearer ${rotated.token}`,
        "content-type": "application/json",
      },
      body: memoryHookBody,
    });
    assert.equal(authorized.status, 200);
    const canonicalHeader = await fetch(memoryHookUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-memorax-code-backend-token": rotated.token,
      },
      body: memoryHookBody,
    });
    assert.equal(canonicalHeader.status, 200);
  } finally {
    const stopped = await stopBackendService({ home, port, timeoutMs: 5000 });
    restoreEnv("MEMORAX_CODE_BACKEND_LOOPBACK_AUTH", previousLoopbackAuth);
    assert.equal(stopped.ok, true);
  }
});
