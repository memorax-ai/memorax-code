import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  check, createNativeHarness, fixtureKey, fixtureModel, fixtureUser, searchResult, sendChatCompletion, summarizeModelRoute, waitFor,
} from "./codebuddy-native-support.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageRoot = join(repoRoot, "packages/npm/memorax-code");

async function createHarness(t, options = {}) {
  const harness = await createNativeHarness({ packageRoot, codebuddyCommand: process.execPath, label: "support-test", ...options });
  t.after(() => harness.close());
  return harness;
}
function captureResponse(nativeStream = true) {
  return { nativeStream, chunks: [], writableEnded: false,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    write(value) { this.chunks.push(value); },
    end(value) { if (value !== undefined) this.chunks.push(value); this.writableEnded = true; } };
}
function parseEvents(text) {
  return text.trim().split("\n\n").map((frame) => {
    assert.match(frame, /^data: /);
    return frame === "data: [DONE]" ? "[DONE]" : JSON.parse(frame.slice(6));
  });
}
async function postModel(harness, body = {}, options = {}) {
  return fetch(`${harness.modelUrl}${options.path ?? "/v1/chat/completions"}`, {
    method: "POST", headers: { "content-type": "application/json", authorization: "Bearer native-model-fixture", ...options.headers },
    body: JSON.stringify({ model: fixtureModel, messages: [{ role: "user", content: "synthetic prompt" }], ...body }),
  });
}
function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; if (error.code === "EPERM") return true; throw error; }
}
async function killFixture(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || !processAlive(pid)) return;
  try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  await waitFor(() => !processAlive(pid), "FIXTURE_PROCESS_CLEANUP_FAILED", 5_000);
}

test("OpenAI text SSE preserves the model, full text, finish reason and usage", () => {
  const response = captureResponse();
  const text = "Complete fixture \u4e2d\u6587 \ud83e\uddea\nSecond paragraph";
  sendChatCompletion(response, { text });
  assert.equal(response.status, 200);
  assert.equal(response.headers["content-type"], "text/event-stream");
  assert.equal(response.writableEnded, true);
  const events = parseEvents(response.chunks.join(""));
  assert.equal(events.length, 4);
  assert.equal(events.at(-1), "[DONE]");
  for (const event of events.slice(0, -1)) {
    assert.equal(event.object, "chat.completion.chunk");
    assert.equal(event.model, fixtureModel);
    assert.equal(event.id, events[0].id);
    assert.equal(Number.isInteger(event.created), true);
    assert.equal(event.choices[0].index, 0);
  }
  assert.deepEqual(events[0].choices[0].delta, { role: "assistant" });
  assert.deepEqual(events[1].choices[0].delta, { content: text });
  assert.equal(events[1].choices[0].finish_reason, null);
  assert.deepEqual(events[2].choices[0], { index: 0, delta: {}, finish_reason: "stop" });
  assert.deepEqual(events[2].usage, { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 });
});

test("rejected model routes reveal only allowlisted static segments and query presence", async (t) => {
  const harness = await createHarness(t);
  const response = await fetch(`${harness.modelUrl}/chat/completions?private=PRIVATE_ROUTE_CANARY`, { method: "POST" });
  assert.equal(response.status, 500);
  assert.deepEqual(harness.modelRequestRejections, [{ method: "POST", route: "/chat/completions", queryPresent: true }]);
  for (const request of [
    { method: "PRIVATE_ROUTE_CANARY", url: "/private/PRIVATE_ROUTE_CANARY?token=PRIVATE_ROUTE_CANARY" },
    { method: "POST", url: "/v1/chat/completions/PRIVATE_ROUTE_CANARY" },
    { method: "GET", url: "/v1/../PRIVATE_ROUTE_CANARY" },
  ]) {
    const summary = summarizeModelRoute(request);
    assert.equal(summary.route, "other");
    assert.equal(JSON.stringify(summary).includes("PRIVATE_ROUTE_CANARY"), false);
  }
  assert.deepEqual(summarizeModelRoute({ method: "POST", url: "/v1/chat/completions/chat/completions" }),
    { method: "POST", route: "/v1/chat/completions/chat/completions", queryPresent: false });
});

test("nonstreaming OpenAI responses use the same complete text and reject missing responses", () => {
  const response = captureResponse(false);
  sendChatCompletion(response, { text: "Complete JSON fixture" });
  assert.equal(response.headers["content-type"], "application/json");
  const body = JSON.parse(response.chunks.join(""));
  assert.equal(body.object, "chat.completion");
  assert.equal(body.model, fixtureModel);
  assert.deepEqual(body.choices, [{ index: 0, message: { role: "assistant", content: "Complete JSON fixture" }, finish_reason: "stop" }]);
  assert.equal(body.usage.total_tokens, 110);
  assert.throws(() => sendChatCompletion(captureResponse(), {}), { nativeCode: "MODEL_RESPONSE_TEXT_MISSING" });
});

test("OpenAI tool responses preserve call IDs, names, arguments and tool completion reasons", () => {
  const toolCalls = [{ id: "call-one", name: "Read", input: { file_path: "synthetic/reference.md" } },
    { id: "call-two", name: "Bash", input: { command: "synthetic command" } }];
  const response = captureResponse();
  sendChatCompletion(response, { toolCalls });
  const events = parseEvents(response.chunks.join(""));
  assert.equal(events.at(-2).choices[0].finish_reason, "tool_calls");
  assert.deepEqual(events.slice(1, 3).map((event) => event.choices[0].delta.tool_calls[0]), toolCalls.map((tool, index) => ({
    index, id: tool.id, type: "function", function: { name: tool.name, arguments: JSON.stringify(tool.input) },
  })));
  const json = captureResponse(false);
  sendChatCompletion(json, { toolCalls });
  const result = JSON.parse(json.chunks.join(""));
  assert.equal(result.choices[0].finish_reason, "tool_calls");
  assert.equal(result.choices[0].message.content, null);
  assert.deepEqual(result.choices[0].message.tool_calls.map((tool) => JSON.parse(tool.function.arguments)), toolCalls.map((tool) => tool.input));
  for (const tools of [null, [{ id: "", name: "Read", input: {} }], [{ id: "x", name: "Read", input: "{}" }], [toolCalls[0], toolCalls[0]]]) {
    assert.throws(() => sendChatCompletion(captureResponse(), { toolCalls: tools }), { nativeCode: "MODEL_RESPONSE_TOOL_INVALID" });
  }
});

test("interactive CodeBuddy commands remain owned and before-close cleanup runs once", async (t) => {
  const harness = await createHarness(t);
  const child = harness.startCodeBuddy(["-e", 'process.stdout.write("ready");setInterval(()=>{},1000);']);
  let output = "", closed = 0;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (text) => { output += text; });
  await waitFor(() => output === "ready");
  harness.setBeforeClose(() => { closed += 1; assert.equal(processAlive(child.pid), true); });
  await harness.close();
  await harness.close();
  assert.equal(closed, 1);
  assert.equal(processAlive(child.pid), false);
  assert.throws(() => harness.startCodeBuddy(["--version"]), { nativeCode: "NATIVE_HARNESS_IS_CLOSING" });
});

test("before-close failure still terminates owned commands and listeners but retains isolated state", async () => {
  const harness = await createNativeHarness({ packageRoot, codebuddyCommand: process.execPath, label: "before-close-test" });
  let child;
  try {
    child = harness.startCodeBuddy(["-e", 'process.stdout.write("ready");setInterval(()=>{},1000);']);
    let ready = false;
    child.stdout.on("data", () => { ready = true; });
    await waitFor(() => ready);
    harness.setBeforeClose(() => check(false, "FIXTURE_BEFORE_CLOSE_FAILED"));
    await assert.rejects(harness.close(), { nativeCode: "FIXTURE_BEFORE_CLOSE_FAILED" });
    assert.equal(processAlive(child.pid), false);
    assert.equal((await stat(harness.root)).isDirectory(), true);
    await assert.rejects(fetch(harness.modelUrl));
    await assert.rejects(fetch(harness.memoryUrl));
  } finally {
    await harness.close().catch(() => {});
    if (child?.pid) await killFixture(child.pid);
    await rm(harness.root, { recursive: true, force: true });
  }
});

test("CodeBuddy harness replaces inherited credentials, all client homes and network settings", async (t) => {
  const canary = "inherited-synthetic-value-must-not-leak";
  const names = ["PATH", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "CODEBUDDY_API_KEY", "CODEBUDDY_AUTH_TOKEN",
    "CODEBUDDY_BASE_URL", "CODEBUDDY_MODEL", "CODEBUDDY_HOME", "CODEBUDDY_CONFIG_DIR", "CODEBUDDY_PLUGIN_DIRS",
    "CODEBUDDY_ENV_FILE", "CODEBUDDY_CUSTOM_HEADERS", "WORKBUDDY_HOME", "WORKBUDDY_CONFIG_DIR", "CODEX_HOME",
    "CLAUDE_CONFIG_DIR", "CLAUDE_HOME", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY",
    "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "DSH_HOME", "OPENCODE_CONFIG_DIR", "TRAE_HOME", "TRAE_CN_HOME", "CURSOR_HOME",
    "MEMORAX_CODE_HOME", "MEMORAX_CODE_BACKEND_URL", "MEMORAX_CODE_BACKEND_TOKEN", "MEMORAX_CODE_CODEBUDDY_COMMAND",
    "MEMORAX_CODE_MEMORAX_ENDPOINT", "MEMORAX_CODE_MEMORAX_API_KEY", "MEMORAX_CODE_MEMORAX_USER_ID", "MEMORAX_CODE_WORKBUDDY_COMMAND",
    "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "OTEL_EXPORTER_OTLP_ENDPOINT",
    "GIT_CONFIG_COUNT", "GIT_CONFIG_GLOBAL", "npm_config_userconfig", "npm_config_cache"];
  const previous = new Map(names.map((name) => [name, process.env[name]]));
  let harness;
  try {
    for (const name of names) process.env[name] = canary;
    harness = await createHarness(t, { writeback: false, codebuddyCommand: join(packageRoot, "fixture bin", "codebuddy") });
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
  assert.equal(Object.values(harness.env).some((value) => value.includes(canary)), false);
  const packageBin = process.platform === "win32" ? resolve(packageRoot, "../../..") : resolve(packageRoot, "../../../..", "bin");
  assert.deepEqual(harness.env.PATH.split(delimiter).slice(0, 3),
    [dirname(harness.codebuddyCommand), packageBin, dirname(process.execPath)]);
  for (const name of ["CODEBUDDY_AUTH_TOKEN", "CODEBUDDY_PLUGIN_DIRS", "CODEBUDDY_ENV_FILE", "CODEBUDDY_CUSTOM_HEADERS",
    "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "OPENAI_API_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY",
    "MEMORAX_CODE_BACKEND_URL", "MEMORAX_CODE_BACKEND_TOKEN", "NODE_OPTIONS", "NODE_EXTRA_CA_CERTS", "HTTP_PROXY",
    "HTTPS_PROXY", "ALL_PROXY", "OTEL_EXPORTER_OTLP_ENDPOINT", "GIT_CONFIG_COUNT", "npm_config_userconfig", "WORKBUDDY_CONFIG_DIR"]) {
    assert.equal(harness.env[name], undefined, name);
  }
  for (const name of ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "CODEBUDDY_HOME", "CODEBUDDY_CONFIG_DIR",
    "WORKBUDDY_HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_HOME", "CODEX_HOME", "DSH_HOME", "OPENCODE_CONFIG_DIR",
    "TRAE_HOME", "TRAE_CN_HOME", "CURSOR_HOME", "MEMORAX_CODE_HOME", "TMP", "TEMP", "TMPDIR"]) {
    assert.equal(harness.env[name].startsWith(`${harness.root}/`) || harness.env[name].startsWith(`${harness.root}\\`), true, name);
  }
  assert.equal(harness.env.CODEBUDDY_API_KEY, "native-model-fixture");
  assert.equal(harness.env.CODEBUDDY_BASE_URL, harness.modelUrl);
  for (const name of ["CODEBUDDY_MODEL", "CODEBUDDY_SMALL_FAST_MODEL", "CODEBUDDY_BIG_SLOW_MODEL", "CODEBUDDY_CODE_SUBAGENT_MODEL"]) {
    assert.equal(harness.env[name], fixtureModel);
  }
  for (const name of ["DISABLE_TELEMETRY", "DISABLE_ERROR_REPORTING", "DISABLE_AUTOUPDATER", "CODEBUDDY_SKIP_BUILTIN_MARKETPLACE",
    "CODEBUDDY_DISABLE_AUTO_MEMORY", "CODEBUDDY_DISABLE_SHELL_SNAPSHOT"]) assert.equal(harness.env[name], "1");
  assert.equal(harness.env.MEMORAX_CODE_MEMORAX_ENDPOINT, harness.memoryUrl);
  assert.equal(harness.env.MEMORAX_CODE_MEMORAX_API_KEY, fixtureKey);
  assert.equal(harness.env.MEMORAX_CODE_MEMORAX_USER_ID, fixtureUser);
  assert.equal(harness.env.MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED, "false");
  assert.equal(harness.env.MEMORAX_CODE_JEV_ENABLED, "false");
  for (const url of [harness.modelUrl, harness.memoryUrl]) assert.equal(new URL(url).hostname, "127.0.0.1");
  const settings = JSON.parse(await readFile(join(harness.codebuddyHome, "settings.json"), "utf8"));
  assert.equal(settings.model, fixtureModel);
  assert.equal(settings.env.CODEBUDDY_BASE_URL, harness.modelUrl);
  assert.equal(settings.env.CODEBUDDY_API_KEY, "native-model-fixture");
  assert.deepEqual(settings.permissions.deny, ["WebSearch", "WebFetch"]);
  const models = JSON.parse(await readFile(join(harness.codebuddyHome, "models.json"), "utf8"));
  assert.deepEqual(models.availableModels, [fixtureModel]);
  assert.equal(models.models.length, 1);
  assert.equal(models.models[0].id, fixtureModel);
  assert.equal(models.models[0].apiKey, "native-model-fixture");
  assert.equal(models.models[0].url, `${harness.modelUrl}/v1/chat/completions`);
  assert.deepEqual(Object.values(models.models[0].relatedModels), Array(5).fill(fixtureModel));
  const config = await readFile(join(harness.stateHome, "config.toml"), "utf8");
  assert.match(config, /\[clients\]\ncodebuddy = true\n/);
  for (const client of ["codex", "claude", "dsh", "opencode", "workbuddy", "trae", "cursor"]) {
    assert.equal(config.includes(`${client} = false\n`), true);
    assert.equal(harness.env[`MEMORAX_CODE_${client.toUpperCase()}_COMMAND`], join(harness.root, "unused-client"));
  }
});

test("model receiver supports streaming and JSON using only the configured synthetic model", async (t) => {
  const harness = await createHarness(t);
  const indexes = [];
  harness.setModelHandler((_body, _response, index) => { indexes.push(index); return { text: "fixture reply" }; });
  const streamed = await postModel(harness, { stream: true });
  assert.equal(streamed.status, 200);
  assert.equal(parseEvents(await streamed.text())[1].choices[0].delta.content, "fixture reply");
  const json = await postModel(harness, { stream: false });
  assert.equal(json.status, 200);
  assert.equal((await json.json()).choices[0].message.content, "fixture reply");
  assert.deepEqual(indexes, [1, 2]);
  assert.equal(harness.modelRequests.length, 2);
  assert.deepEqual(harness.serverErrors, []);
});

test("model receiver fails closed on unknown routes, inherited credentials, wrong models and malformed requests", async (t) => {
  const harness = await createHarness(t);
  harness.setModelHandler(() => "must not be returned");
  for (const [body, options, code] of [
    [{}, { path: "/v1/chat/completions?private-query-canary" }, "UNEXPECTED_MODEL_REQUEST"],
    [{}, { path: "/v1/models" }, "UNEXPECTED_MODEL_REQUEST"],
    [{}, { headers: { authorization: "Bearer inherited-credential-canary" } }, "NATIVE_MODEL_CREDENTIAL_MISMATCH"],
    [{ model: "retired-or-foreign-model" }, {}, "NATIVE_MODEL_ID_MISMATCH"],
    [{ messages: [] }, {}, "NATIVE_MODEL_REQUEST_INVALID"],
    [{ stream: "true" }, {}, "NATIVE_MODEL_REQUEST_INVALID"],
  ]) {
    const response = await postModel(harness, body, options);
    assert.equal(response.status, 500);
    assert.equal(await response.text(), "");
    assert.equal(harness.serverErrors.at(-1), code);
  }
  const wrongMethod = await fetch(`${harness.modelUrl}/v1/chat/completions`);
  assert.equal(wrongMethod.status, 500);
  assert.equal(harness.serverErrors.at(-1), "UNEXPECTED_MODEL_REQUEST");
  const malformed = await fetch(`${harness.modelUrl}/v1/chat/completions`, {
    method: "POST", headers: { authorization: "Bearer native-model-fixture" }, body: "private-malformed-json-canary",
  });
  assert.equal(malformed.status, 500);
  assert.equal(harness.serverErrors.at(-1), "NATIVE_REQUEST_JSON_INVALID");
  assert.equal(harness.modelRequests.length, 0);
  assert.equal(JSON.stringify(harness.serverErrors).includes("canary"), false);
});

test("model receiver requires the scripted response handler to finish a response", async (t) => {
  const harness = await createHarness(t);
  assert.equal((await postModel(harness)).status, 500);
  assert.equal(harness.serverErrors.at(-1), "MODEL_HANDLER_NOT_SET");
  harness.setModelHandler(() => undefined);
  assert.equal((await postModel(harness)).status, 500);
  assert.equal(harness.serverErrors.at(-1), "MODEL_HANDLER_DID_NOT_COMPLETE");
  harness.setModelHandler(() => ({}));
  assert.equal((await postModel(harness)).status, 500);
  assert.equal(harness.serverErrors.at(-1), "MODEL_RESPONSE_TEXT_MISSING");
});

test("memory receiver records synthetic requests and rejects other endpoints", async (t) => {
  const harness = await createHarness(t);
  for (const operation of ["search", "add"]) {
    const body = { user_id: `${fixtureUser}@project-alpha`, query: "fixture query", messages: [] };
    const response = await fetch(`${harness.memoryUrl}/v1/memories/${operation}`, { method: "POST",
      headers: { authorization: `Token ${fixtureKey}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.success, true);
    if (operation === "search") assert.equal(result.data.data[0].memory, searchResult);
    assert.deepEqual(harness.memoryRequests.at(-1), { method: "POST", path: `/v1/memories/${operation}`,
      authorization: `Token ${fixtureKey}`, body });
  }
  const unexpected = await fetch(`${harness.memoryUrl}/unexpected-private-path`, { method: "POST", body: "{}" });
  assert.equal(unexpected.status, 500);
  assert.equal(harness.memoryRequests.length, 2);
  assert.deepEqual(harness.serverErrors, ["UNEXPECTED_MEMORY_REQUEST"]);
});

test("cleanup removes isolated state and receiver ports once and prevents new commands", async (t) => {
  const harness = await createHarness(t);
  const closed = harness.close();
  assert.equal(harness.close(), closed);
  await closed;
  await assert.rejects(stat(harness.root), { code: "ENOENT" });
  for (const url of [harness.modelUrl, harness.memoryUrl]) {
    const probe = createServer();
    await new Promise((done, reject) => {
      probe.once("error", reject);
      probe.listen(Number(new URL(url).port), "127.0.0.1", done);
    });
    await new Promise((done) => probe.close(done));
  }
  await assert.rejects(harness.runCodeBuddy(["--version"]), { nativeCode: "NATIVE_HARNESS_IS_CLOSING" });
});

test("command runner preserves stdin and split UTF-8 stdout and stderr", async (t) => {
  const harness = await createHarness(t);
  const input = "\u4e2d\u6587 \ud83e\uddea\nfixture input\r\n";
  const result = await harness.runCodeBuddy(["-e", `
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => {
      const buffer = Buffer.concat(chunks);
      for (const byte of buffer) { process.stdout.write(Buffer.from([byte])); process.stderr.write(Buffer.from([byte])); }
    });
  `], { input });
  assert.equal(result.stdout, input);
  assert.equal(result.stderr, input);
});

for (const [name, source, code, timeout] of [
  ["timeout", "setTimeout(() => {}, 60000);", "NATIVE_COMMAND_TIMEOUT", 1000],
  ["output", 'process.stdout.write("x".repeat(17 * 1024 * 1024)); setTimeout(() => {}, 60000);', "NATIVE_OUTPUT_LIMIT", 5000],
  ["nonzero", "process.exit(7);", "NATIVE_COMMAND_FAILED", 5000],
]) {
  test(`command ${name} failure is bounded and terminates the owned process`, async (t) => {
    const harness = await createHarness(t);
    const path = join(harness.workspace, `${name}.pid`);
    let pid;
    try {
      await assert.rejects(harness.runCodeBuddy(["-e", `
        require("node:fs").writeFileSync(process.argv[1], String(process.pid)); ${source}
      `, path], { timeout }), { nativeCode: code });
      pid = Number(await readFile(path, "utf8"));
      assert.equal(Number.isSafeInteger(pid) && pid > 1, true);
      await waitFor(() => !processAlive(pid), "FIXTURE_COMMAND_SURVIVED_FAILURE", 5000);
    } finally {
      pid ??= Number(await readFile(path, "utf8").catch(() => ""));
      await killFixture(pid);
    }
  });
}

test("cleanup keeps POSIX group ownership after an unref leader exits", { skip: process.platform === "win32" }, async (t) => {
  const harness = await createHarness(t);
  let childPid;
  try {
    const result = await harness.runCodeBuddy(["-e", `
      const child = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"],
        { stdio: "ignore" });
      child.unref(); console.log(JSON.stringify({ leader: process.pid, child: child.pid }));
    `]);
    const identity = JSON.parse(result.stdout);
    childPid = identity.child;
    assert.equal(processAlive(identity.leader), false);
    assert.equal(processAlive(childPid), true);
    await harness.close();
    assert.equal(processAlive(childPid), false);
    assert.equal(processAlive(-identity.leader), false);
  } finally { await killFixture(childPid); }
});

test("cleanup failure retains isolated state while closing model and memory listeners", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "codebuddy-native-failed-close-"));
  let harness;
  try {
    await mkdir(join(fixture, "lib"));
    await mkdir(join(fixture, "bin"));
    await writeFile(join(fixture, "lib", "windows-cli-invocation.mjs"),
      "export const resolveWindowsCliInvocation = (command, args) => ({ command, args });\n");
    await writeFile(join(fixture, "bin", "memorax-code.mjs"), "console.log(JSON.stringify({ ok: false }));\n");
    harness = await createNativeHarness({ packageRoot: fixture, codebuddyCommand: process.execPath, label: "failed-close" });
    await mkdir(join(harness.stateHome, "runtime", "backend"), { recursive: true });
    await writeFile(join(harness.stateHome, "runtime", "backend", "backend.pid.json"), JSON.stringify({ pid: 2147483647 }));
    await assert.rejects(harness.close(), { nativeCode: "NATIVE_BACKEND_STOP_FAILED" });
    assert.equal((await stat(harness.root)).isDirectory(), true);
    for (const url of [harness.modelUrl, harness.memoryUrl]) {
      await assert.rejects(fetch(url));
    }
  } finally {
    await harness?.close().catch(() => {});
    if (harness) await rm(harness.root, { recursive: true, force: true });
    await rm(fixture, { recursive: true, force: true });
  }
});

test("child cleanup failure still reads the current Backend record and calls public stop", { skip: process.platform === "win32" }, async () => {
  const fixture = await mkdtemp(join(tmpdir(), "codebuddy-native-close-order-"));
  const originalKill = process.kill;
  let harness, childPid;
  try {
    await mkdir(join(fixture, "lib"));
    await mkdir(join(fixture, "bin"));
    await writeFile(join(fixture, "lib", "windows-cli-invocation.mjs"),
      "export const resolveWindowsCliInvocation = (command, args) => ({ command, args });\n");
    await writeFile(join(fixture, "bin", "memorax-code.mjs"), `
      import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      if (process.argv.slice(2).join(" ") !== "stop --clients codebuddy --json") process.exit(9);
      const path = join(process.env.MEMORAX_CODE_HOME, "runtime", "backend", "backend.pid.json");
      const { pid } = JSON.parse(readFileSync(path, "utf8"));
      writeFileSync(join(process.env.MEMORAX_CODE_HOME, "public-stop-called"), String(pid));
      unlinkSync(path);
      console.log(JSON.stringify({ ok: true }));
    `);
    harness = await createNativeHarness({ packageRoot: fixture, codebuddyCommand: process.execPath, label: "close-order" });
    childPid = Number((await harness.runCodeBuddy(["-e", "console.log(process.pid)"])).stdout);
    await mkdir(join(harness.stateHome, "runtime", "backend"), { recursive: true });
    await writeFile(join(harness.stateHome, "runtime", "backend", "backend.pid.json"), JSON.stringify({ pid: 2147483647 }));
    process.kill = (pid, signal) => {
      if (pid === -childPid && signal === "SIGKILL") throw Object.assign(new Error("fixture signal failure"), { code: "EPERM" });
      return originalKill(pid, signal);
    };
    await assert.rejects(harness.close(), { code: "EPERM", nativeCode: "NATIVE_CLEANUP_FAILED" });
    assert.equal(await readFile(join(harness.stateHome, "public-stop-called"), "utf8"), "2147483647");
    await assert.rejects(stat(join(harness.stateHome, "runtime", "backend", "backend.pid.json")), { code: "ENOENT" });
    assert.equal((await stat(harness.root)).isDirectory(), true);
    for (const url of [harness.modelUrl, harness.memoryUrl]) await assert.rejects(fetch(url));
  } finally {
    process.kill = originalKill;
    await harness?.close().catch(() => {});
    if (harness) await rm(harness.root, { recursive: true, force: true });
    await rm(fixture, { recursive: true, force: true });
  }
});

test("public stop failure never bypasses Backend ownership with a direct signal", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "codebuddy-native-stop-authority-"));
  const originalKill = process.kill;
  let harness, backend;
  const signals = [];
  try {
    await mkdir(join(fixture, "lib"));
    await mkdir(join(fixture, "bin"));
    await writeFile(join(fixture, "lib", "windows-cli-invocation.mjs"),
      "export const resolveWindowsCliInvocation = (command, args) => ({ command, args });\n");
    await writeFile(join(fixture, "bin", "memorax-code.mjs"), "console.log(JSON.stringify({ ok: false }));\n");
    harness = await createNativeHarness({ packageRoot: fixture, codebuddyCommand: process.execPath, label: "stop-authority" });
    backend = spawn(process.execPath, ["-e", "setTimeout(() => {}, 500)"], { stdio: "ignore" });
    await new Promise((done, reject) => { backend.once("spawn", done); backend.once("error", reject); });
    await mkdir(join(harness.stateHome, "runtime", "backend"), { recursive: true });
    await writeFile(join(harness.stateHome, "runtime", "backend", "backend.pid.json"), JSON.stringify({ pid: backend.pid }));
    process.kill = (pid, signal) => {
      if (Math.abs(pid) === backend.pid && signal !== 0) signals.push(signal);
      return originalKill(pid, signal);
    };
    await assert.rejects(harness.close(), { nativeCode: "NATIVE_BACKEND_STOP_FAILED" });
    assert.deepEqual(signals, []);
    assert.equal((await stat(harness.root)).isDirectory(), true);
  } finally {
    process.kill = originalKill;
    await killFixture(backend?.pid);
    await harness?.close().catch(() => {});
    if (harness) await rm(harness.root, { recursive: true, force: true });
    await rm(fixture, { recursive: true, force: true });
  }
});

test("waitFor and check fail with fixed diagnostic codes", async () => {
  assert.throws(() => check(false, "SYNTHETIC_CHECK_FAILED"), { nativeCode: "SYNTHETIC_CHECK_FAILED" });
  assert.equal(await waitFor(() => "ready", "UNUSED", 50), "ready");
  await assert.rejects(waitFor(() => false, "SYNTHETIC_WAIT_TIMEOUT", 1), { nativeCode: "SYNTHETIC_WAIT_TIMEOUT" });
});
