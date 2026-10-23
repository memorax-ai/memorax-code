#!/usr/bin/env node
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
assert.ok(process.argv[2], "An installed npm package root is required");
const packageRoot = resolve(process.argv[2]);
const entrypoint = join(packageRoot, "bin", "memorax-cli.mjs");
const packageVersion = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")).version;
const root = await mkdtemp(join(tmpdir(), "memorax-code-cli-diagnostics-e2e-"));
const home = join(root, "user");
const state = join(root, "state");
const workspace = join(root, "private-workspace-canary");
const diagnosticsRoot = join(state, "runtime", "diagnostics");
const query = "private-query-canary-for-installed-cli";
const memory = "private-memory-canary-for-installed-cli";
const reason = "private-reason-canary-for-installed-cli";
const apiKey = "synthetic-api-key-canary-for-installed-cli";
const responseCanary = "private-response-body-canary-for-installed-cli";
const sessionId = "private-session-canary-for-installed-cli";
const missingQueryFile = join(root, "private-query-file-canary.txt");
const documentPath = join(root, "private-document-canary.pdf");
const documentBytes = Buffer.from([37, 80, 68, 70, 45, 49, 46, 55, 10, 0, 255, 13, 10, 128]);
const documentId = "travel-policy";
const documentInputId = "12345678-1234-4234-8234-123456789abc";
const documentItem = { content: "Travel requires advance approval.", content_type: "document",
  metadata: { document_id: documentId, document_revision: 1, record_kind: "document_chunk", chunk_index: 0, chunk_count: 1 } };
const requests = [];
let responseMode;

const server = createServer(async (request, response) => {
  const mode = responseMode;
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  const multipart = /^multipart\/form-data\b/i.test(request.headers["content-type"] ?? "");
  let body;
  let file;
  if (multipart) {
    const form = await new Request("http://127.0.0.1", { method: "POST", headers: request.headers, body: bytes }).formData();
    body = JSON.parse(form.get("request"));
    const uploaded = form.get("file");
    file = { name: uploaded.name, type: uploaded.type, bytes: Buffer.from(await uploaded.arrayBuffer()) };
  } else body = bytes.length ? JSON.parse(bytes.toString("utf8")) : {};
  requests.push({ method: request.method, url: request.url, headers: request.headers, body, ...(file ? { file } : {}) });
  if (mode === "timeout") return;
  response.writeHead(mode === "http" ? 503 : mode === "document" ? 202 : 200, {
    "content-type": "application/json",
    ...(mode === "http" ? { "retry-after": "2" } : {}),
  });
  response.end(mode === "json" ? "{" + responseCanary : JSON.stringify(
    mode === "http" ? { error: responseCanary }
      : mode === "shape" ? { data: { unexpected: responseCanary } }
        : mode === "add" ? { success: true, data: { task_id: "installed-cli-add", status: "queued" } }
          : mode === "document" ? { success: true, data: { task_id: "installed-cli-document", status: "accepted",
            document_id: documentId, input_id: documentInputId, revision: null } }
            : { success: true, data: { data: mode === "document-search" ? [documentItem] : [] } },
  ));
});

try {
  await Promise.all([home, state, workspace, join(root, "tmp"), join(root, "bin")]
    .map((path) => mkdir(path, { recursive: true })));
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const env = isolatedEnv(`http://127.0.0.1:${server.address().port}`);
  // Command overrides stop wrapper discovery before any native app is probed.
  assert.equal(env.MEMORAX_CODE_BACKEND_DEBUG_REQUESTS, undefined);
  const recorded = [];
  for (const scenario of [
    { mode: "http", operation: "search", code: "MEMORAX_HTTP_ERROR", stage: "request" },
    { mode: "timeout", operation: "add", code: "MEMORAX_TIMEOUT", stage: "request" },
    { mode: "json", operation: "search", code: "MEMORAX_INVALID_JSON", stage: "response" },
    { mode: "shape", operation: "search", code: "MEMORAX_INVALID_RESPONSE", stage: "response" },
  ]) {
    const output = await runCli(scenario.operation, scenario.mode, env);
    assert.equal(output.code, 1, scenario.mode);
    assert.equal(output.stderr, "", "JSON failures must remain machine-readable with default debug off");
    const result = JSON.parse(output.stdout);
    assert.equal(result.ok, false);
    assert.equal(result.action, `memory.${scenario.operation}`);
    assert.equal(result.errorCode, scenario.code);
    assert.equal(result.stage, scenario.stage);
    if (scenario.mode === "http") {
      assert.equal(result.httpStatus, 503);
      assert.equal(result.retryAfterMs, 2000);
    }
    recorded.push(await assertDiagnostic(result));
  }

  const refusedServer = createServer();
  await new Promise((done) => refusedServer.listen(0, "127.0.0.1", done));
  const refusedEndpoint = `http://127.0.0.1:${refusedServer.address().port}`;
  await new Promise((done) => refusedServer.close(done));
  const refused = await runCli("search", "empty", {
    ...env, MEMORAX_CODE_MEMORAX_ENDPOINT: refusedEndpoint,
  }, true, { expectedRequestCount: 0 });
  assert.equal(refused.code, 1);
  assert.equal(refused.stderr, "");
  const refusedResult = JSON.parse(refused.stdout);
  assert.equal(refusedResult.ok, false);
  assert.equal(refusedResult.action, "memory.search");
  assert.equal(refusedResult.errorCode, "MEMORAX_TRANSPORT_ERROR");
  assert.equal(refusedResult.systemCode, "ECONNREFUSED");
  assert.equal(refusedResult.stage, "request");
  recorded.push(await assertDiagnostic(refusedResult));

  const missingInput = await runCli("search", "empty", env, true, {
    args: ["search", "--query-file", missingQueryFile], expectedRequestCount: 0,
  });
  assert.equal(missingInput.code, 1);
  assert.equal(missingInput.stderr, "");
  const missingResult = JSON.parse(missingInput.stdout);
  assert.equal(missingResult.ok, false);
  assert.equal(missingResult.action, "memory.search");
  assert.equal(missingResult.errorCode, "MEMORY_INPUT_UNREADABLE");
  assert.equal(missingResult.systemCode, "ENOENT");
  assert.equal(missingResult.stage, "input");
  recorded.push(await assertDiagnostic(missingResult, "The memory command input file could not be read."));

  const beforeSuccess = (await readdir(diagnosticsRoot)).sort();
  const empty = await runCli("search", "empty", env);
  assert.equal(empty.code, 0);
  assert.equal(empty.stderr, "");
  const emptyResult = JSON.parse(empty.stdout);
  assert.equal(emptyResult.ok, true);
  assert.deepEqual(emptyResult.items, []);
  assert.equal(emptyResult.answer, "");
  assert.equal(emptyResult.diagnostic, undefined);
  const emptyText = await runCli("search", "empty", env, false);
  assert.equal(emptyText.code, 0);
  assert.equal(emptyText.stdout.trim(), "No memory context returned.");
  assert.equal(emptyText.stderr, "");
  const added = await runCli("add", "add", env);
  assert.equal(added.code, 0);
  assert.equal(added.stderr, "");
  const addResult = JSON.parse(added.stdout);
  assert.equal(addResult.ok, true);
  assert.equal(addResult.receipt.accepted, true);
  assert.equal(addResult.diagnostic, undefined);
  assert.deepEqual((await readdir(diagnosticsRoot)).sort(), beforeSuccess, "Successful commands must not write failure diagnostics");

  const human = await runCli("add", "http", env, false);
  assert.equal(human.code, 1);
  assert.equal(human.stdout, "");
  assert.match(human.stderr, /\[MEMORAX_HTTP_ERROR\]/);
  const humanFiles = (await readdir(diagnosticsRoot)).filter((name) => !beforeSuccess.includes(name));
  assert.equal(humanFiles.length, 1);
  const humanPath = join(diagnosticsRoot, humanFiles[0]);
  const humanRecord = JSON.parse(await readFile(humanPath, "utf8"));
  recorded.push(await assertDiagnostic({
    ...humanRecord,
    action: humanRecord.operation,
    diagnostic: { id: humanRecord.id, recorded: true, path: humanPath },
  }));
  for (const field of ["error", "impact", "userAction", "id"]) {
    assert.ok(human.stderr.includes(humanRecord[field]), `Human output must include ${field}`);
  }
  assert.ok(human.stderr.includes(humanPath), "Human output must locate the actual diagnostic record");
  assertContentFree(human.stderr);

  const blockedState = join(root, "blocked-state");
  await mkdir(join(blockedState, "runtime"), { recursive: true });
  await writeFile(join(blockedState, "runtime", "diagnostics"), "not a directory\n");
  const blocked = await runCli("search", "http", { ...env, MEMORAX_CODE_HOME: blockedState });
  assert.equal(blocked.code, 1);
  assert.equal(blocked.stderr, "");
  const blockedResult = JSON.parse(blocked.stdout);
  assert.equal(blockedResult.errorCode, "MEMORAX_HTTP_ERROR");
  assert.equal(blockedResult.httpStatus, 503);
  assert.equal(blockedResult.diagnostic.recorded, false);
  assert.ok(blockedResult.diagnostic.recordingError);
  assert.equal(await readFile(join(blockedState, "runtime", "diagnostics"), "utf8"), "not a directory\n");

  await writeFile(documentPath, documentBytes);
  const documentArgs = ["add", "--document-file", documentPath, "--document-id", documentId,
    "--input-id", documentInputId, "--expected-revision", "0"];
  const uploaded = await runCli("add", "document", env, true, { args: documentArgs, includeSessionId: false });
  assert.equal(uploaded.code, 0);
  assert.equal(uploaded.stderr, "");
  const uploadResult = JSON.parse(uploaded.stdout);
  assert.equal(uploadResult.ok, true);
  assert.equal(uploadResult.action, "memory.add");
  assert.deepEqual(uploadResult.receipt, { document_id: documentId, input_id: documentInputId, expected_revision: 0,
    revision: null, status: "accepted", pending: true, task_id: "installed-cli-document" });
  const uploadRequest = requests.at(-1);
  assert.equal(uploadRequest.method, "POST");
  assert.equal(uploadRequest.url, "/v1/memories/add");
  assert.match(uploadRequest.headers["content-type"], /^multipart\/form-data; boundary=/);
  assert.equal(uploadRequest.headers["x-request-id"], documentInputId);
  assert.deepEqual(uploadRequest.file, { name: "private-document-canary.pdf", type: "application/pdf", bytes: documentBytes });
  assert.deepEqual(uploadRequest.body, { user_id: "installed-cli-user@private-workspace-canary", document_id: documentId,
    input_id: documentInputId, expected_revision: 0, memory_output_language: "zh", content_type: "document", async_mode: true });

  const searchedDocument = await runCli("search", "document-search", env, true, {
    args: ["search", "--query", query, "--sources", "document", "--document-id", documentId],
  });
  assert.equal(searchedDocument.code, 0);
  assert.equal(searchedDocument.stderr, "");
  const documentSearchResult = JSON.parse(searchedDocument.stdout);
  assert.deepEqual(documentSearchResult.items, [documentItem]);
  assert.match(documentSearchResult.answer, /travel-policy/);
  assert.deepEqual(requests.at(-1).body.sources, ["document"]);
  assert.deepEqual(requests.at(-1).body.document_ids, [documentId]);

  for (const flags of [["--wait"], ["--wait-timeout-ms", "1000"], ["--poll-interval-ms", "1"]]) {
    const removed = await runCli("add", "document", env, true, {
      args: [...documentArgs, ...flags], includeSessionId: false, expectedRequestCount: 0,
    });
    assert.equal(removed.code, 1);
    assert.equal(removed.stderr, "");
    const result = JSON.parse(removed.stdout);
    assert.equal(result.ok, false);
    assert.equal(result.errorCode, "MEMORY_INPUT_INVALID");
    assert.equal(result.stage, "input");
    assert.match(result.error, /unsupported add flag/);
    recorded.push(await assertDiagnostic(result, "The memory command arguments are invalid."));
  }
  const removedStatus = await runCli("add-status", "document", env, true, {
    args: ["add-status", "--task-id", "installed-cli-document"], includeSessionId: false, expectedRequestCount: 0,
  });
  assert.equal(removedStatus.code, 1);
  assert.equal(removedStatus.stderr, "");
  const removedStatusResult = JSON.parse(removedStatus.stdout);
  assert.equal(removedStatusResult.ok, false);
  assert.match(removedStatusResult.error, /unknown memory command: add-status/);

  const help = await runCli("help", "empty", env, false, {
    args: ["--help"], includeSessionId: false, expectedRequestCount: 0,
  });
  assert.equal(help.code, 0);
  assert.equal(help.stderr, "");
  assert.match(help.stdout, /--document-file/);
  assert.match(help.stdout, /--sources/);
  assert.doesNotMatch(help.stdout, /add-status|--wait|--poll-interval-ms/);

  await assert.rejects(readdir(join(state, "debug", "traces")), { code: "ENOENT" });
  for (const request of requests) {
    assert.equal(request.method, "POST");
    assert.equal(request.headers.authorization, `Token ${apiKey}`);
    const payload = JSON.stringify(request.body);
    for (const value of [root, apiKey, responseCanary, ...recorded.map((record) => record.id)]) {
      assert.equal(payload.includes(value), false, "Local diagnostics and provenance must not enter the provider payload");
    }
    if (request.url === "/v1/memories/search") assert.equal(request.body.query, query);
    else {
      assert.equal(request.url, "/v1/memories/add");
      if (request.file) {
        assert.equal(request.body.content_type, "document");
        assert.deepEqual(request.file.bytes, documentBytes);
      } else assert.ok(payload.includes(memory));
    }
  }
  console.log("Installed memory CLI diagnostics and Work E2E passed (debug off, trace off, local mock only).");
} finally {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  await rm(root, { recursive: true, force: true });
}

function isolatedEnv(endpoint) {
  const env = {
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    PATH: join(root, "bin"),
    TMPDIR: join(root, "tmp"),
    TMP: join(root, "tmp"),
    TEMP: join(root, "tmp"),
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"),
    XDG_CACHE_HOME: join(home, ".cache"),
    MEMORAX_CODE_HOME: state,
    MEMORAX_CODE_MEMORAX_ENDPOINT: endpoint,
    MEMORAX_CODE_MEMORAX_API_KEY: apiKey,
    MEMORAX_CODE_MEMORAX_USER_ID: "installed-cli-user",
    MEMORAX_CODE_MEMORAX_TIMEOUT_MS: "1000",
    MEMORAX_CODE_MEMORAX_ADD_TIMEOUT_MS: "1000",
    MEMORAX_CODE_MEMORAX_UPLOAD_TIMEOUT_MS: "1000",
    MEMORAX_CODE_AUTO_UPDATE: "false",
    CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CLAUDE_HOME: join(home, ".claude"),
    DSH_HOME: join(home, ".dsh"),
    OPENCODE_CONFIG_DIR: join(home, ".config", "opencode"),
    CODEBUDDY_HOME: join(home, ".codebuddy"),
    CODEBUDDY_CONFIG_DIR: join(home, ".codebuddy"),
    WORKBUDDY_HOME: join(home, ".workbuddy"),
    WORKBUDDY_CONFIG_DIR: join(home, ".workbuddy"),
    TRAE_CN_HOME: join(home, ".trae-cn"),
    TRAE_HOME: join(home, ".trae-cn"),
  };
  for (const client of ["CODEX", "CLAUDE", "CODEBUDDY", "WORKBUDDY"]) {
    env[`MEMORAX_CODE_${client}_COMMAND`] = join(root, "bin", "unused-synthetic-client");
  }
  for (const client of ["CODEX", "CLAUDE", "DSH", "OPENCODE", "CODEBUDDY", "WORKBUDDY", "TRAE"]) {
    env[`MEMORAX_CODE_${client}_TRACE_ENABLED`] = "false";
  }
  for (const key of ["SystemRoot", "WINDIR"]) {
    if (process.platform === "win32" && process.env[key]) env[key] = process.env[key];
  }
  return env;
}

async function runCli(operation, mode, env, json = true, options = {}) {
  responseMode = mode;
  const count = requests.length;
  const args = [...(options.args ?? (operation === "search" ? ["search", "--query", query]
    : ["add", "--memory", memory, "--type", "procedural", "--reason", reason]))];
  if (options.includeSessionId !== false) args.push("--session-id", sessionId);
  if (json) args.push("--json");
  let output;
  try {
    output = { ...await execFileAsync(process.execPath, [entrypoint, ...args], {
      cwd: workspace, env, timeout: 15_000, encoding: "utf8",
    }), code: 0 };
  } catch (error) {
    if (error.code !== 1) throw error;
    output = { stdout: error.stdout, stderr: error.stderr, code: error.code };
  }
  assert.equal(requests.length, count + (options.expectedRequestCount ?? 1), "Unexpected number of requests to the local provider");
  return output;
}

async function assertDiagnostic(result, expectedError = result.error) {
  assert.equal(result.diagnostic.recorded, true);
  assert.ok(result.diagnostic.id);
  assert.equal(result.diagnostic.path, join(diagnosticsRoot, `${result.diagnostic.id}.json`));
  const text = await readFile(result.diagnostic.path, "utf8");
  assertContentFree(text);
  const record = JSON.parse(text);
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.id, result.diagnostic.id);
  assert.equal(record.source, "memorax-cli");
  assert.equal(record.operation, result.action);
  assert.equal(record.version, packageVersion);
  assert.equal(record.platform, process.platform);
  assert.ok(record.runtimeVersion);
  assert.ok(Number.isFinite(Date.parse(record.timestamp)));
  assert.ok(record.error);
  assert.equal(record.error, expectedError);
  for (const field of ["errorCode", "stage", "impact", "userAction"]) {
    assert.ok(record[field]);
    assert.equal(record[field], result[field]);
  }
  for (const field of ["httpStatus", "retryAfterMs", "systemCode"]) assert.equal(record[field], result[field]);
  if (process.platform !== "win32") assert.equal((await stat(result.diagnostic.path)).mode & 0o777, 0o600);
  return record;
}

function assertContentFree(text) {
  for (const value of [workspace, missingQueryFile, documentPath, query, memory, reason, apiKey, responseCanary, sessionId]) {
    assert.equal(text.includes(value), false, "Diagnostics must not expose input, response content, credentials, or workspace paths");
  }
  assert.equal(text.includes("[memorax-code-backend:debug]"), false);
}
