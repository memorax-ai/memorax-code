import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { backendTokenPath, writeBackendConnectionAuthority, writeBackendTokenRecord } from "../src/backend-connection.mjs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_ENSURE_BACKEND_START_TIMEOUT_MS,
  ensureBackendAvailable,
} from "../src/hooks/ensure-backend-runner.mjs";

test("ensure-backend process ceiling leaves room for lifecycle lock wait and recovery", () => {
  assert.equal(DEFAULT_ENSURE_BACKEND_START_TIMEOUT_MS, 90000);
});

test("shared Backend recovery passes caller-supplied internal environment", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-ensure-runner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const memoraxCodeHome = join(root, "memorax-code-home");
  await mkdir(memoraxCodeHome, { recursive: true });
  const recordPath = join(root, "recovery.json");
  const command = join(root, "recovery-memorax-code.mjs");
  await writeFile(command, [
    'import { writeFileSync } from "node:fs";',
    'writeFileSync(process.env.MEMORAX_CODE_TEST_RECORD_PATH, JSON.stringify({',
    '  marker: process.env.MEMORAX_CODE_DSH_ADAPTER_RECOVERY,',
    '  revision: process.env.MEMORAX_CODE_DSH_ADAPTER_EXPECTED_REVISION,',
    '}));',
  ].join("\n"));

  await ensureBackendAvailable({
    backendConnection: {
      memoraxCodeHome,
      url: "http://127.0.0.1:9",
      source: "environment",
    },
    healthTimeoutValue: "50",
    memoraxCodeCommand: command,
    nodePath: process.execPath,
    resolveHomes: () => ({ memoraxCodeHome }),
    buildStartArgs: () => ["start"],
    recoveryEnv: {
      MEMORAX_CODE_TEST_RECORD_PATH: recordPath,
      MEMORAX_CODE_DSH_ADAPTER_RECOVERY: "1",
      MEMORAX_CODE_DSH_ADAPTER_EXPECTED_REVISION: "revision-1",
    },
  });

  assert.deepEqual(JSON.parse(await readFile(recordPath, "utf8")), {
    marker: "1",
    revision: "revision-1",
  });
});

test("concurrent client Hooks share one recovery and refresh its rotated connection token", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-concurrent-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const memoraxCodeHome = join(root, "memorax-code-home");
  let starts = 0;
  let healthy = false;
  const initialHealthResponses = [];
  const turns = new Set();
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    if (request.url === "/health") {
      if (!healthy && initialHealthResponses.length < 2) {
        initialHealthResponses.push(response);
        if (initialHealthResponses.length === 2) {
          for (const pending of initialHealthResponses) pending.writeHead(503).end();
        }
        return;
      }
      const authorized = healthy && request.headers["x-memorax-code-backend-token"] === "rotated-token";
      response.writeHead(authorized ? 200 : 503, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: authorized, service: "memorax-code-backend" }));
      return;
    }
    if (request.url === "/start") {
      starts += 1;
      turns.clear();
      writeBackendTokenRecord({ memoraxCodeHome, token: "rotated-token", createdAt: new Date().toISOString() });
      healthy = true;
      response.end("started");
      return;
    }
    if (request.url === "/memory/turn-start") {
      const authorized = healthy && request.headers["x-memorax-code-backend-token"] === "rotated-token";
      if (authorized) turns.add(JSON.parse(text).client);
      response.writeHead(authorized ? 200 : 401).end();
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  writeBackendTokenRecord({ memoraxCodeHome, token: "initial-token", createdAt: new Date().toISOString() });
  writeBackendConnectionAuthority({ memoraxCodeHome, url, tokenPath: backendTokenPath(memoraxCodeHome) });
  const command = join(root, "recover.mjs");
  await writeFile(command, `await fetch(${JSON.stringify(`${url}/start`)}, { method: "POST" });\n`);
  const hook = join(root, "hook.mjs");
  await writeFile(hook, `
import { ensureBackendAvailable } from ${JSON.stringify(new URL("../src/hooks/ensure-backend-runner.mjs", import.meta.url).href)};
import { resolveBackendConnection } from ${JSON.stringify(new URL("../src/backend-connection.mjs", import.meta.url).href)};
const client = process.argv[2];
const memoraxCodeHome = ${JSON.stringify(memoraxCodeHome)};
const connection = resolveBackendConnection({ memoraxCodeHome });
if (client === "claude") connection.source = "option";
await ensureBackendAvailable({
  backendConnection: connection,
  healthTimeoutValue: "3000",
  startTimeoutValue: "10000",
  memoraxCodeCommand: ${JSON.stringify(command)},
  resolveHomes: () => ({ memoraxCodeHome }),
  buildStartArgs: () => ["start"],
});
const current = resolveBackendConnection({ memoraxCodeHome });
const response = await fetch(new URL("/memory/turn-start", current.url), {
  method: "POST",
  headers: { "x-memorax-code-backend-token": current.token, "content-type": "application/json" },
  body: JSON.stringify({ client }),
});
if (!response.ok) throw new Error("turn start was rejected");
`);
  const env = {
    ...process.env,
    MEMORAX_CODE_HOME: memoraxCodeHome,
    MEMORAX_CODE_BACKEND_URL: "",
    MEMORAX_CODE_BACKEND_HOST: "",
    MEMORAX_CODE_BACKEND_PORT: "",
    MEMORAX_CODE_BACKEND_TOKEN: "",
  };
  const children = ["codex", "claude"].map((client) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [hook, client], { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stderr }));
  }));
  for (const result of await Promise.all(children)) assert.equal(result.code, 0, result.stderr);
  assert.equal(starts, 1);
  assert.deepEqual([...turns].sort(), ["claude", "codex"]);
});

test("Hook recovery records invalid connection authority without Debug or a Backend start", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-ensure-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "runtime", "backend"), { recursive: true });
  await writeFile(join(root, "runtime", "backend", "backend-connection.json"), "invalid authority /private/secret");
  const previous = {};
  for (const key of ["MEMORAX_CODE_BACKEND_URL", "MEMORAX_CODE_BACKEND_HOST", "MEMORAX_CODE_BACKEND_PORT", "MEMORAX_CODE_BACKEND_TOKEN"]) {
    previous[key] = process.env[key];
    delete process.env[key];
  }
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  await ensureBackendAvailable({
    client: "trae",
    resolveHomes: () => ({ memoraxCodeHome: root }),
    buildStartArgs: () => { throw new Error("must not start"); },
  }, { session_id: "private-session", turn_id: "private-turn" });
  const [record] = await recoveryDiagnostics(root);
  assert.equal(record.errorCode, "HOOK_BACKEND_CONNECTION_INVALID");
  assert.equal(record.client, "trae");
  assert.match(record.sessionHash, /^[a-f0-9]{24}$/);
  assert.equal(JSON.stringify(record).includes("private"), false);
  assert.equal((await recoveryDiagnostics(root)).length, 1);
});

test("Hook recovery records a failed start once and keeps its existing best-effort return", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-ensure-start-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }));
  let starts = 0;
  const result = await ensureBackendAvailable({
    client: "workbuddy",
    backendConnection: { url: "http://127.0.0.1:9", source: "environment" },
    memoraxCodeCommand: process.execPath,
    resolveHomes: () => ({ memoraxCodeHome: root }),
    buildStartArgs: () => { starts += 1; return ["-e", "process.stderr.write('private stderr'); process.exit(7)", "--"]; },
  });
  assert.equal(result, undefined);
  assert.equal(starts, 1);
  const [record] = await recoveryDiagnostics(root);
  assert.equal(record.errorCode, "HOOK_BACKEND_START_FAILED");
  assert.equal(record.commandExitCode, 7);
  assert.equal(record.client, "workbuddy");
  assert.equal(JSON.stringify(record).includes("private stderr"), false);
  assert.equal((await recoveryDiagnostics(root)).length, 1);
});

test("Hook recovery lock failure is recorded while normal skips and healthy checks remain quiet", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-ensure-lock-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let healthy = true;
  t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify({ ok: healthy, service: "memorax-code-backend" })));
  const options = {
    client: "dsh",
    backendConnection: { url: "http://127.0.0.1:9", source: "environment" },
    memoraxCodeCommand: process.execPath,
    resolveHomes: () => ({ memoraxCodeHome: root }),
    buildStartArgs: () => { throw new Error("must not start"); },
  };
  await ensureBackendAvailable(options);
  healthy = false;
  await ensureBackendAvailable({ ...options, ensureBackendValue: "0" });
  await ensureBackendAvailable({ ...options, memoraxCodeCommand: join(root, "removed-command") });
  assert.deepEqual(await recoveryDiagnostics(root), []);
  await mkdir(join(root, "runtime"));
  await writeFile(join(root, "runtime", "backend"), "blocked");
  await ensureBackendAvailable(options);
  assert.equal((await recoveryDiagnostics(root))[0].errorCode, "HOOK_BACKEND_RECOVERY_FAILED");
});

async function recoveryDiagnostics(home) {
  const directory = join(home, "runtime", "diagnostics");
  const files = await readdir(directory).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
  return await Promise.all(files.map(async (name) => JSON.parse(await readFile(join(directory, name), "utf8"))));
}

test("Hook recovery retains timeout, spawn errno, and termination signal without changing its return", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }));
  const cases = [
    { name: "timeout", script: "setInterval(() => {}, 1000)", timeout: "100", code: "HOOK_BACKEND_START_TIMEOUT", exit: 124 },
    { name: "spawn", script: "", code: "HOOK_BACKEND_START_SPAWN_FAILED", exit: 127, systemCode: "ENOENT" },
    ...(process.platform === "win32" ? [] : [{ name: "signal", script: "process.kill(process.pid, 'SIGTERM')", code: "HOOK_BACKEND_START_INTERRUPTED", exit: 0, signal: "SIGTERM" }]),
  ];
  for (const entry of cases) {
    const root = await mkdtemp(join(tmpdir(), "memorax-code-ensure-process-failure-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const command = entry.name === "spawn" ? join(root, "recovery.mjs") : process.execPath;
    if (entry.name === "spawn") await writeFile(command, "");
    const result = await ensureBackendAvailable({
      client: "codex",
      backendConnection: { url: "http://127.0.0.1:9", source: "environment" },
      memoraxCodeCommand: command,
      nodePath: join(root, "private-missing-node"),
      startTimeoutValue: entry.timeout ?? "3000",
      resolveHomes: () => ({ memoraxCodeHome: root }),
      buildStartArgs: () => ["-e", entry.script, "--"],
    });
    assert.equal(result, undefined);
    const records = await recoveryDiagnostics(root);
    assert.equal(records.length, 1, entry.name);
    assert.equal(records[0].errorCode, entry.code);
    assert.equal(records[0].commandExitCode, entry.exit);
    assert.equal(records[0].systemCode, entry.systemCode);
    assert.equal(records[0].commandSignal, entry.signal);
    assert.equal(JSON.stringify(records).includes("private-missing-node"), false);
  }
});

test("Hook recovery reuses saved child diagnostics and falls back for unusable bounded JSON output", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response(null, { status: 503 }));
  const id = "mc-1760000000000-00000000-0000-4000-8000-000000000000";
  for (const kind of ["saved", "unsaved", "invalid", "oversized", "mixed", "malformed", "omitted-adapter", "missing-backend", "duplicate-client"]) {
    const root = await mkdtemp(join(tmpdir(), "memorax-code-ensure-child-diagnostic-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const writerUrl = new URL("../src/diagnostic-record.mjs", import.meta.url).href;
    const report = { action: "start", ok: false, backend: { ok: false }, diagnostic: { id: kind === "invalid" ? "private-invalid-id" : id, recorded: kind !== "unsaved" } };
    if (["mixed", "omitted-adapter", "duplicate-client"].includes(kind)) report.codexAdapter = { ok: false };
    if (kind === "mixed") report.clientFailures = [{ client: "codex", diagnostic: { id, recorded: false } }];
    if (kind === "malformed") report.clientFailures = {};
    if (kind === "missing-backend") delete report.backend.ok;
    if (kind === "duplicate-client") report.clientFailures = [{ client: "codex", diagnostic: { id, recorded: true } }, { client: "codex", diagnostic: { id, recorded: true } }];
    const script = kind === "saved"
      ? "const { writeDiagnosticRecord } = await import(" + JSON.stringify(writerUrl) + "); const diagnostic = writeDiagnosticRecord(" + JSON.stringify(root) + ", { source: 'memorax-code', operation: 'backend.start', errorCode: 'BACKEND_START_FAILED' }); console.log(JSON.stringify({ action: 'start', ok: false, backend: { ok: false }, diagnostic })); process.exit(1);"
      : "process.stdout.write(" + (kind === "oversized" ? "' '.repeat(70 * 1024)" : "''") + " + JSON.stringify(" + JSON.stringify(report) + ")); process.exit(1);";
    await ensureBackendAvailable({
      client: "claude-code",
      backendConnection: { url: "http://127.0.0.1:9", source: "environment" },
      memoraxCodeCommand: process.execPath,
      resolveHomes: () => ({ memoraxCodeHome: root }),
      buildStartArgs: () => ["--input-type=module", "-e", script, "--"],
    });
    const records = await recoveryDiagnostics(root);
    assert.equal(records.length, 1, kind);
    assert.equal(records[0].source, kind === "saved" ? "memorax-code" : "client-hook");
    assert.equal(records[0].errorCode, kind === "saved" ? "BACKEND_START_FAILED" : "HOOK_BACKEND_START_FAILED");
    assert.equal(JSON.stringify(records).includes("private-invalid-id"), false);
  }
});
