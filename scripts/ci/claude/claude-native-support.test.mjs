import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  check, createNativeHarness, fixtureKey, fixtureModel, fixtureUser, searchResult, sendMessages, waitFor,
} from "./claude-native-support.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const packageRoot = join(repoRoot, "packages/npm/memorax-code");

async function createHarness(t, options = {}) {
  const harness = await createNativeHarness({ packageRoot, claudeCommand: process.execPath, label: "support-test", ...options });
  t.after(() => harness.close());
  return harness;
}

function captureResponse(nativeStream = true) {
  return {
    nativeStream, chunks: [], writableEnded: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    write(value) { this.chunks.push(value); },
    end(value) { if (value !== undefined) this.chunks.push(value); this.writableEnded = true; },
  };
}

function parseEvents(text) {
  return text.trim().split("\n\n").map((frame) => {
    const [eventLine, dataLine] = frame.split("\n");
    assert.match(eventLine, /^event: /);
    assert.match(dataLine, /^data: /);
    const data = JSON.parse(dataLine.slice(6));
    assert.equal(data.type, eventLine.slice(7));
    return data;
  });
}

async function postModel(harness, body = {}, options = {}) {
  return fetch(`${harness.modelUrl}${options.path ?? "/v1/messages"}`, {
    method: "POST", headers: { "content-type": "application/json", "x-api-key": "native-model-fixture", ...options.headers },
    body: JSON.stringify({ model: fixtureModel, messages: [{ role: "user", content: "synthetic prompt" }], ...body }),
  });
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; if (error.code === "EPERM") return true; throw error; }
}

async function expectStoppedCommand(harness, name, source, code, timeout) {
  const pidPath = join(harness.workspace, `${name}.pid`);
  let pid;
  try {
    await assert.rejects(harness.runClaude(["-e", `
      require("node:fs").writeFileSync(process.argv[1], String(process.pid));
      ${source}
    `, pidPath], { timeout }), { nativeCode: code });
    pid = Number(await readFile(pidPath, "utf8"));
    assert.equal(Number.isSafeInteger(pid) && pid > 0, true);
    await waitFor(() => !processAlive(pid), "FIXTURE_COMMAND_SURVIVED_FAILURE", 5_000);
  } finally {
    pid ??= Number(await readFile(pidPath, "utf8").catch(() => ""));
    if (Number.isSafeInteger(pid) && pid > 0 && processAlive(pid)) {
      try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      await waitFor(() => !processAlive(pid), "FIXTURE_COMMAND_CLEANUP_FAILED", 5_000);
    }
  }
}

test("Anthropic text SSE has complete native event order and final usage", () => {
  const response = captureResponse();
  const text = "Complete fixture answer \u4e2d\u6587\nsecond line";
  sendMessages(response, { text });
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "text/event-stream");
  assert.equal(response.writableEnded, true);
  const events = parseEvents(response.chunks.join(""));
  assert.deepEqual(events.map((event) => event.type), ["message_start", "content_block_start", "content_block_delta",
    "content_block_stop", "message_delta", "message_stop"]);
  const message = events[0].message;
  assert.match(message.id, /^msg_native_\d+$/);
  assert.equal(message.type, "message");
  assert.equal(message.role, "assistant");
  assert.equal(message.model, fixtureModel);
  assert.deepEqual(message.content, []);
  assert.equal(message.stop_reason, null);
  assert.equal(message.usage.output_tokens, 0);
  assert.deepEqual(events[1], { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
  assert.deepEqual(events[2], { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
  assert.deepEqual(events[3], { type: "content_block_stop", index: 0 });
  assert.deepEqual(events[4], { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 10 } });
});

test("Anthropic tool SSE keeps block indexes, tool identities and full JSON input", () => {
  const response = captureResponse();
  const tools = [
    { id: "tool_fixture_one", name: "Bash", input: { command: "printf fixture", options: { values: [1, "\u4e2d\u6587"] } } },
    { id: "tool_fixture_two", name: "Read", input: { file_path: "synthetic-fixture.txt" } },
  ];
  sendMessages(response, { text: "Tool preamble", toolCalls: tools });
  const events = parseEvents(response.chunks.join(""));
  const starts = events.filter((event) => event.type === "content_block_start");
  const deltas = events.filter((event) => event.type === "content_block_delta");
  assert.deepEqual(starts.map((event) => event.index), [0, 1, 2]);
  assert.deepEqual(events.filter((event) => event.type === "content_block_stop").map((event) => event.index), [0, 1, 2]);
  for (const [index, tool] of tools.entries()) {
    assert.deepEqual(starts[index + 1].content_block, { type: "tool_use", id: tool.id, name: tool.name, input: {} });
    assert.equal(deltas[index + 1].index, index + 1);
    assert.equal(deltas[index + 1].delta.type, "input_json_delta");
    assert.deepEqual(JSON.parse(deltas[index + 1].delta.partial_json), tool.input);
  }
  assert.equal(events.at(-2).delta.stop_reason, "tool_use");
  assert.equal(events.at(-1).type, "message_stop");
});

test("nonstreaming Anthropic responses are JSON messages, including tool-only results", () => {
  const response = captureResponse(false);
  const tool = { id: "tool_json", name: "Bash", input: { command: "printf native" } };
  sendMessages(response, { toolCalls: [tool] });
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "application/json");
  assert.equal(response.writableEnded, true);
  const message = JSON.parse(response.chunks.join(""));
  assert.equal(message.role, "assistant");
  assert.equal(message.model, fixtureModel);
  assert.deepEqual(message.content, [{ type: "tool_use", ...tool }]);
  assert.equal(message.stop_reason, "tool_use");
  assert.equal(message.usage.output_tokens, 10);
});

test("native harness replaces inherited credentials, providers and client homes with isolated fixtures", async (t) => {
  const marker = "inherited-synthetic-value-must-not-leak";
  const names = ["PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "ANTHROPIC_MODEL", "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "CLAUDE_CONFIG_DIR", "CLAUDE_HOME",
    "CODEX_HOME", "DSH_HOME", "OPENCODE_CONFIG_DIR", "CODEBUDDY_HOME", "CODEBUDDY_CONFIG_DIR",
    "WORKBUDDY_HOME", "WORKBUDDY_CONFIG_DIR", "TRAE_HOME", "TRAE_CN_HOME", "CURSOR_HOME",
    "MEMORAX_CODE_HOME", "MEMORAX_CODE_BACKEND_URL", "MEMORAX_CODE_BACKEND_TOKEN", "MEMORAX_CODE_CLAUDE_COMMAND",
    "MEMORAX_CODE_MEMORAX_ENDPOINT", "MEMORAX_CODE_MEMORAX_API_KEY", "MEMORAX_CODE_MEMORAX_USER_ID",
    "MEMORAX_CODE_CODEX_COMMAND", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY",
    "GIT_CONFIG_COUNT", "GIT_CONFIG_GLOBAL", "npm_config_userconfig", "npm_config_cache"];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  let harness;
  try {
    for (const name of names) process.env[name] = marker;
    harness = await createHarness(t, { writeback: false });
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
  assert.equal(Object.values(harness.env).some((value) => value.includes(marker)), false);
  for (const name of ["ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY", "MEMORAX_CODE_BACKEND_URL", "MEMORAX_CODE_BACKEND_TOKEN", "NODE_OPTIONS",
    "NODE_EXTRA_CA_CERTS", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "GIT_CONFIG_COUNT", "npm_config_userconfig"]) {
    assert.equal(harness.env[name], undefined, name);
  }
  for (const name of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "CLAUDE_CONFIG_DIR", "CLAUDE_HOME",
    "CODEX_HOME", "DSH_HOME", "OPENCODE_CONFIG_DIR", "CODEBUDDY_HOME", "CODEBUDDY_CONFIG_DIR", "WORKBUDDY_HOME",
    "WORKBUDDY_CONFIG_DIR", "TRAE_HOME", "TRAE_CN_HOME", "CURSOR_HOME", "MEMORAX_CODE_HOME", "TMP", "TEMP", "TMPDIR"]) {
    assert.equal(harness.env[name].startsWith(`${harness.root}/`) || harness.env[name].startsWith(`${harness.root}\\`), true, name);
  }
  assert.equal(harness.env.ANTHROPIC_BASE_URL, harness.modelUrl);
  assert.equal(harness.env.ANTHROPIC_API_KEY, "native-model-fixture");
  for (const name of ["ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_SMALL_FAST_MODEL"]) assert.equal(harness.env[name], fixtureModel);
  assert.equal(harness.env.MEMORAX_CODE_MEMORAX_ENDPOINT, harness.memoryUrl);
  assert.equal(harness.env.MEMORAX_CODE_MEMORAX_API_KEY, fixtureKey);
  assert.equal(harness.env.MEMORAX_CODE_MEMORAX_USER_ID, fixtureUser);
  assert.equal(harness.env.MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED, "false");
  assert.equal(harness.env.MEMORAX_CODE_JEV_ENABLED, "false");
  for (const url of [harness.modelUrl, harness.memoryUrl]) assert.equal(new URL(url).hostname, "127.0.0.1");
  const settings = JSON.parse(await readFile(join(harness.claudeHome, "settings.json"), "utf8"));
  assert.equal(settings.model, fixtureModel);
  assert.equal(settings.env.ANTHROPIC_BASE_URL, harness.modelUrl);
  assert.equal(settings.env.ANTHROPIC_API_KEY, "native-model-fixture");
  assert.deepEqual(settings.permissions.deny, ["WebSearch", "WebFetch"]);
  const config = await readFile(join(harness.stateHome, "config.toml"), "utf8");
  assert.match(config, /\[clients\]\nclaude = true\n/);
  for (const client of ["codex", "dsh", "opencode", "codebuddy", "workbuddy", "trae", "cursor"]) {
    assert.equal(config.includes(`${client} = false\n`), true);
    assert.equal(harness.env[`MEMORAX_CODE_${client.toUpperCase()}_COMMAND`], join(harness.root, "unused-client"));
  }
});

test("model receiver supports streaming, JSON and token counting without hosted models", async (t) => {
  const harness = await createHarness(t);
  const observed = [];
  harness.setModelHandler((body, response, index) => { observed.push({ body, index }); return "fixture reply"; });
  const streamed = await postModel(harness, { stream: true });
  assert.equal(streamed.status, 200);
  assert.equal(streamed.headers.get("content-type"), "text/event-stream");
  assert.equal(parseEvents(await streamed.text())[2].delta.text, "fixture reply");
  const json = await postModel(harness, { stream: false });
  assert.equal(json.status, 200);
  assert.deepEqual((await json.json()).content, [{ type: "text", text: "fixture reply" }]);
  const counted = await postModel(harness, {}, { path: "/v1/messages/count_tokens" });
  assert.equal(counted.status, 200);
  assert.deepEqual(await counted.json(), { input_tokens: 100 });
  assert.deepEqual(observed.map(({ index }) => index), [1, 2]);
  assert.equal(harness.modelRequests.length, 2);
  assert.deepEqual(harness.serverErrors, []);
});

test("native connectivity preflight is counted separately and accepts only its exact method and path", async (t) => {
  const harness = await createHarness(t);
  assert.equal(harness.modelPreflightRequests, 0);
  for (let index = 0; index < 2; index++) {
    const response = await fetch(`${harness.modelUrl}/api/hello`, { method: "HEAD" });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "");
  }
  assert.equal(harness.modelPreflightRequests, 2);
  assert.deepEqual(harness.modelRequests, []);
  assert.deepEqual(harness.serverErrors, []);
  for (const [path, method] of [["/api/not-supported", "HEAD"], ["/api/hello", "GET"]]) {
    const response = await fetch(`${harness.modelUrl}${path}`, { method });
    assert.equal(response.status, 500);
    assert.equal(await response.text(), "");
  }
  assert.equal(harness.modelPreflightRequests, 2);
  assert.deepEqual(harness.modelRequests, []);
  assert.deepEqual(harness.serverErrors, ["UNEXPECTED_MODEL_REQUEST", "UNEXPECTED_MODEL_REQUEST"]);
});

test("model receiver rejects unknown routes, inherited credentials and wrong model IDs", async (t) => {
  const harness = await createHarness(t);
  harness.setModelHandler(() => "must not be returned");
  const invalid = [
    [{}, { path: "/v1/not-supported" }, "UNEXPECTED_MODEL_REQUEST"],
    [{}, { headers: { "x-api-key": "wrong-synthetic-key" } }, "NATIVE_MODEL_CREDENTIAL_MISMATCH"],
    [{ model: "wrong-synthetic-model" }, {}, "NATIVE_MODEL_ID_MISMATCH"],
  ];
  for (const [body, options, code] of invalid) {
    const response = await postModel(harness, body, options);
    assert.equal(response.status, 500);
    assert.equal(await response.text(), "");
    assert.equal(harness.serverErrors.at(-1), code);
  }
  assert.equal(harness.modelRequests.length, 0);
  assert.equal(harness.serverErrors.length, invalid.length);
});

test("model receiver fails closed when its deterministic response handler is absent or incomplete", async (t) => {
  const harness = await createHarness(t);
  const absent = await postModel(harness);
  assert.equal(absent.status, 500);
  await absent.text();
  assert.equal(harness.serverErrors.at(-1), "MODEL_HANDLER_NOT_SET");
  harness.setModelHandler(() => undefined);
  const incomplete = await postModel(harness);
  assert.equal(incomplete.status, 500);
  await incomplete.text();
  assert.equal(harness.serverErrors.at(-1), "MODEL_HANDLER_DID_NOT_COMPLETE");
});

test("memory receiver records synthetic Add and Search and rejects other endpoints", async (t) => {
  const harness = await createHarness(t);
  for (const operation of ["search", "add"]) {
    const response = await fetch(`${harness.memoryUrl}/v1/memories/${operation}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${fixtureKey}` },
      body: JSON.stringify({ user_id: fixtureUser, query: "fixture query" }),
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.success, true);
    if (operation === "search") assert.equal(result.data.data[0].memory, searchResult);
    else assert.equal(result.data.status, "queued");
  }
  assert.deepEqual(harness.memoryRequests.map(({ path }) => path), ["/v1/memories/search", "/v1/memories/add"]);
  assert.equal(harness.memoryRequests.every(({ authorization }) => authorization === `Bearer ${fixtureKey}`), true);
  const invalid = await fetch(`${harness.memoryUrl}/v1/not-supported`, { method: "POST", body: "{}" });
  assert.equal(invalid.status, 500);
  await invalid.text();
  assert.equal(harness.memoryRequests.length, 2);
  assert.deepEqual(harness.serverErrors, ["UNEXPECTED_MEMORY_REQUEST"]);
});

test("cleanup is idempotent, removes owned state and ports, and prevents new processes", async (t) => {
  const initialSignalCounts = ["SIGINT", "SIGTERM"].map((signal) => process.listenerCount(signal));
  const harness = await createHarness(t);
  const first = harness.close();
  assert.equal(harness.close(), first);
  assert.throws(() => harness.spawnClaude(["--version"]), { nativeCode: "NATIVE_HARNESS_IS_CLOSING" });
  await assert.rejects(harness.runProduct(["--help"]), { nativeCode: "NATIVE_HARNESS_IS_CLOSING" });
  await assert.rejects(harness.runMemory(["--help"]), { nativeCode: "NATIVE_HARNESS_IS_CLOSING" });
  await first;
  await assert.rejects(stat(harness.root), { code: "ENOENT" });
  for (const url of [harness.modelUrl, harness.memoryUrl]) {
    const probe = createServer();
    try {
      await new Promise((done, reject) => {
        probe.once("error", reject);
        probe.listen(Number(new URL(url).port), "127.0.0.1", done);
      });
    } finally { await new Promise((done) => probe.close(done)); }
  }
  assert.deepEqual(["SIGINT", "SIGTERM"].map((signal) => process.listenerCount(signal)), initialSignalCounts);
  assert.equal(harness.close(), first);
});

test("native cleanup runs its quiesce callback once before removing owned state", async (t) => {
  const harness = await createHarness(t);
  let calls = 0;
  assert.throws(() => harness.setBeforeClose(null), { nativeCode: "NATIVE_CLEANUP_HANDLER_INVALID" });
  harness.setBeforeClose(async () => {
    calls++;
    assert.equal((await stat(harness.root)).isDirectory(), true);
  });
  await harness.close();
  await harness.close();
  assert.equal(calls, 1);
  assert.throws(() => harness.setBeforeClose(() => {}), { nativeCode: "NATIVE_HARNESS_IS_CLOSING" });
});

test("a failed quiesce callback preserves state but still stops newly recorded Backend and receiver ports", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "claude-native-close-test-"));
  let harness, backend;
  try {
    await mkdir(join(fixture, "lib"));
    await mkdir(join(fixture, "bin"));
    await writeFile(join(fixture, "lib", "windows-cli-invocation.mjs"),
      "export const resolveWindowsCliInvocation = (command, args) => ({ command, args });\n");
    await writeFile(join(fixture, "bin", "memorax-code.mjs"), `
      import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      const path = join(process.env.MEMORAX_CODE_HOME, "runtime/backend/backend.pid.json");
      const { pid } = JSON.parse(readFileSync(path, "utf8"));
      try { process.kill(pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      unlinkSync(path);
      writeFileSync(join(process.env.MEMORAX_CODE_HOME, "stop-observed"), "yes");
      console.log(JSON.stringify({ ok: true }));
    `);
    harness = await createNativeHarness({ packageRoot: fixture, claudeCommand: process.execPath, label: "close-test" });
    backend = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    await new Promise((done, reject) => { backend.once("spawn", done); backend.once("error", reject); });
    const failure = Object.assign(new Error("FIXTURE_QUIESCE_FAILED"), { nativeCode: "FIXTURE_QUIESCE_FAILED" });
    harness.setBeforeClose(async () => {
      const directory = join(harness.stateHome, "runtime", "backend");
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "backend.pid.json"), JSON.stringify({ pid: backend.pid }));
      throw failure;
    });
    await assert.rejects(harness.close(), (error) => error === failure);
    assert.equal(processAlive(backend.pid), false);
    assert.equal((await stat(harness.root)).isDirectory(), true);
    assert.equal(await readFile(join(harness.stateHome, "stop-observed"), "utf8"), "yes");
    await assert.rejects(stat(join(harness.stateHome, "runtime", "backend", "backend.pid.json")), { code: "ENOENT" });
    for (const url of [harness.modelUrl, harness.memoryUrl]) {
      const probe = createServer();
      await new Promise((done, reject) => {
        probe.once("error", reject);
        probe.listen(Number(new URL(url).port), "127.0.0.1", done);
      });
      await new Promise((done) => probe.close(done));
    }
  } finally {
    if (backend?.pid && processAlive(backend.pid)) backend.kill("SIGKILL");
    if (backend?.pid) await waitFor(() => !processAlive(backend.pid), "FIXTURE_BACKEND_CLEANUP_FAILED");
    await harness?.close().catch(() => {});
    if (harness) await rm(harness.root, { recursive: true, force: true });
    await rm(fixture, { recursive: true, force: true });
  }
});

test("command runner preserves stdin and split UTF-8 stdout and stderr", async (t) => {
  const harness = await createHarness(t);
  const input = "\u4e2d\u6587 \ud83d\udca1\nfixture input\r\n";
  const result = await harness.runClaude(["-e", `
    const input = require("node:fs").readFileSync(0, "utf8");
    const bytes = Buffer.from(input);
    process.stdout.write(bytes.subarray(0, 1));
    process.stderr.write(bytes.subarray(0, 2));
    setTimeout(() => {
      process.stdout.write(bytes.subarray(1));
      process.stderr.write(bytes.subarray(2));
    }, 20);
  `], { input, timeout: 10_000 });
  assert.equal(result.stdout, input);
  assert.equal(result.stderr, input);
});

test("command runner retains nonzero exit codes without exposing raw child output", async (t) => {
  const harness = await createHarness(t);
  await assert.rejects(harness.runClaude(["-e", `
    process.stdout.write("synthetic stdout");
    process.stderr.write("synthetic stderr");
    process.exitCode = 17;
  `]), (error) => {
    assert.equal(error.nativeCode, "NATIVE_COMMAND_FAILED");
    assert.equal(error.code, 17);
    assert.equal(error.message, "NATIVE_COMMAND_FAILED");
    assert.equal(error.stdout, undefined);
    assert.equal(error.stderr, undefined);
    return true;
  });
});

test("command timeout terminates the owned process before rejecting", async (t) => {
  const harness = await createHarness(t);
  await expectStoppedCommand(harness, "timeout", "setTimeout(() => {}, 60_000);", "NATIVE_COMMAND_TIMEOUT", 2_000);
});

test("command output limits count UTF-8 bytes and terminate both stdout and stderr offenders", async (t) => {
  const harness = await createHarness(t);
  for (const stream of ["stdout", "stderr"]) {
    await expectStoppedCommand(harness, `output-limit-${stream}`, `
      process.${stream}.write("\\u4e2d".repeat(Math.floor(16 * 1024 * 1024 / 3) + 1));
      setTimeout(() => {}, 60_000);
    `, "NATIVE_OUTPUT_LIMIT", 10_000);
  }
});

test("POSIX cleanup stops an owned descendant after its process group leader exits", {
  skip: process.platform === "win32" ? "POSIX process group ownership" : false,
  timeout: 30_000,
}, async (t) => {
  const harness = await createHarness(t);
  let childPid;
  try {
    const result = await harness.runClaude(["-e", `
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], { stdio: "ignore" });
      child.unref();
      process.stdout.write(JSON.stringify({ parentPid: process.pid, childPid: child.pid }));
    `], { timeout: 10_000 });
    const processIds = JSON.parse(result.stdout);
    childPid = processIds.childPid;
    assert.equal(Number.isSafeInteger(childPid) && childPid > 0, true);
    assert.equal(processAlive(processIds.parentPid), false);
    assert.equal(processAlive(childPid), true);
    await harness.close();
    await waitFor(() => !processAlive(childPid), "FIXTURE_CHILD_SURVIVED_CLEANUP", 5_000);
    await assert.rejects(stat(harness.root), { code: "ENOENT" });
  } finally {
    if (Number.isSafeInteger(childPid) && childPid > 0 && processAlive(childPid)) {
      try { process.kill(childPid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
      await waitFor(() => !processAlive(childPid), "FIXTURE_CHILD_CLEANUP_FAILED", 5_000);
    }
  }
});

test("waitFor returns the actual accepted value and waits for asynchronous predicates", async () => {
  const value = { ready: true };
  assert.equal(await waitFor(() => value), value);
  let attempts = 0;
  assert.equal(await waitFor(async () => ++attempts === 2 ? value : false, "UNUSED_TIMEOUT", 500), value);
  assert.equal(attempts, 2);
});

test("waitFor reports a fixed timeout code and preserves predicate failures", async () => {
  await assert.rejects(waitFor(() => false, "FIXTURE_TIMEOUT", 1), { nativeCode: "FIXTURE_TIMEOUT", message: "FIXTURE_TIMEOUT" });
  const failure = new Error("synthetic predicate failure");
  await assert.rejects(waitFor(() => { throw failure; }), (error) => error === failure);
  assert.throws(() => check(false, "FIXTURE_CHECK_FAILED"), { nativeCode: "FIXTURE_CHECK_FAILED" });
});
