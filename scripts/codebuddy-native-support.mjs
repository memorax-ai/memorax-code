import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const otherClients = ["codex", "claude", "dsh", "opencode", "workbuddy", "trae", "cursor"];
export const fixtureKey = `sk_${"E".repeat(43)}`;
export const fixtureUser = "native-fixture-user";
export const fixtureModel = "memorax-codebuddy-fixture";
export const searchResult = "NATIVE_MEMORY_SEARCH_RESULT";

export function check(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { nativeCode: code });
}

export async function createNativeHarness({ packageRoot, codebuddyCommand, label = "native", writeback = true, expectedVersion }) {
  packageRoot = resolve(packageRoot);
  codebuddyCommand = resolve(codebuddyCommand);
  const { resolveWindowsCliInvocation } = await import(pathToFileURL(join(packageRoot, "lib", "windows-cli-invocation.mjs")));
  const root = await mkdtemp(join(tmpdir(), `memorax-codebuddy-${label}-`));
  const home = join(root, "user home");
  const workspace = join(root, "project-alpha");
  const stateHome = join(home, ".memorax-code");
  const codebuddyHome = join(home, ".codebuddy");
  const productEntrypoint = join(packageRoot, "bin", "memorax-code.mjs");
  const memoryEntrypoint = join(packageRoot, "bin", "memorax-cli.mjs");
  const modelRequests = [], memoryRequests = [], serverErrors = [], modelRequestRejections = [];
  const children = new Set(), backendPids = new Set();
  let modelHandler, nativeVersion, beforeClose, setupStarted = false, closePromise;
  let memoryServer, modelServer, backendPort, env;
  try {
    for (const directory of [workspace, stateHome, codebuddyHome, join(root, "tmp")]) await mkdir(directory, { recursive: true });
    memoryServer = await listen(async (request, response) => {
      const isSearch = request.url === "/v1/memories/search";
      check(request.method === "POST" && (isSearch || request.url === "/v1/memories/add"), "UNEXPECTED_MEMORY_REQUEST");
      const body = await requestJson(request);
      memoryRequests.push({ method: request.method, path: request.url, authorization: request.headers.authorization, body });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: true, data: isSearch
        ? { task_id: "native-search", status: "completed", data: [{ id: "fixture-memory", memory: searchResult,
          score: 0.95, metadata: { memory_type: "procedural" } }] }
        : { task_id: `native-add-${memoryRequests.length}`, status: "queued" } }));
    }, serverErrors);
    modelServer = await listen(async (request, response) => {
      if ((request.method !== "POST" || request.url !== "/v1/chat/completions") && modelRequestRejections.length < 8) {
        modelRequestRejections.push(summarizeModelRoute(request));
      }
      check(request.method === "POST" && request.url === "/v1/chat/completions", "UNEXPECTED_MODEL_REQUEST");
      check(request.headers.authorization === "Bearer native-model-fixture", "NATIVE_MODEL_CREDENTIAL_MISMATCH");
      const body = await requestJson(request);
      check(body?.model === fixtureModel, "NATIVE_MODEL_ID_MISMATCH");
      check(Array.isArray(body.messages) && body.messages.length > 0
        && (body.stream === undefined || typeof body.stream === "boolean"), "NATIVE_MODEL_REQUEST_INVALID");
      modelRequests.push({ method: request.method, path: request.url, body });
      check(typeof modelHandler === "function", "MODEL_HANDLER_NOT_SET");
      response.nativeStream = body.stream === true;
      const result = await modelHandler(body, response, modelRequests.length);
      if (!response.writableEnded && result !== undefined) sendChatCompletion(response, typeof result === "string" ? { text: result } : result);
      check(response.writableEnded, "MODEL_HANDLER_DID_NOT_COMPLETE");
    }, serverErrors);
    backendPort = await freePort();
    env = isolatedEnv({ root, home, stateHome, codebuddyHome, codebuddyCommand, packageRoot, backendPort,
      modelUrl: modelServer.url, memoryUrl: memoryServer.url, writeback });
    if (process.platform === "win32") {
      const gitBash = join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe");
      check(await stat(gitBash).then((info) => info.isFile(), () => false), "NATIVE_WINDOWS_GIT_BASH_MISSING");
      env.CODEBUDDY_CODE_GIT_BASH_PATH = gitBash;
      env.PATH += `${delimiter}${dirname(gitBash)}${delimiter}${resolve(dirname(gitBash), "../cmd")}`;
    }
    await writeFile(join(stateHome, "config.toml"), ["[clients]", "codebuddy = true",
      ...otherClients.map((client) => `${client} = false`), "[jev]", "enabled = false", ""].join("\n"), { mode: 0o600 });
    await writeFile(join(codebuddyHome, "settings.json"), JSON.stringify({ model: fixtureModel,
      env: { CODEBUDDY_BASE_URL: modelServer.url, CODEBUDDY_API_KEY: "native-model-fixture" },
      permissions: { deny: ["WebSearch", "WebFetch"] },
    }), { mode: 0o600 });
    await writeFile(join(codebuddyHome, "models.json"), JSON.stringify({ models: [{ id: fixtureModel,
      name: "Native CodeBuddy fixture", vendor: "OpenAI", apiKey: "native-model-fixture",
      url: `${modelServer.url}/v1/chat/completions`, maxInputTokens: 128000, maxOutputTokens: 4096,
      supportsToolCall: true, supportsImages: false,
      relatedModels: Object.fromEntries(["lite", "reasoning", "vision", "longContext", "subagent"].map((kind) => [kind, fixtureModel])),
    }], availableModels: [fixtureModel] }), { mode: 0o600 });
  } catch (error) {
    await memoryServer?.close();
    await modelServer?.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }

  // Retain exited leaders until their owned process group is confirmed absent.
  async function run(command, args, options = {}) {
    check(!closePromise || options.cleanup === true, "NATIVE_HARNESS_IS_CLOSING");
    const childEnv = { ...env, ...options.env };
    const invocation = resolveWindowsCliInvocation(command, args, { env: childEnv });
    const child = spawn(invocation.command, invocation.args, { cwd: options.cwd ?? workspace,
      env: childEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
    children.add(child);
    let timer, stopping;
    const pending = new Promise((done, reject) => {
      const output = { stdout: "", stderr: "" }, sizes = { stdout: 0, stderr: 0 };
      for (const name of ["stdout", "stderr"]) {
        child[name].setEncoding("utf8");
        child[name].on("data", (text) => {
          sizes[name] += Buffer.byteLength(text);
          if (sizes[name] > 16 * 1024 * 1024) reject(Object.assign(new Error("NATIVE_OUTPUT_LIMIT"), { nativeCode: "NATIVE_OUTPUT_LIMIT" }));
          else output[name] += text;
        });
      }
      child.once("error", reject);
      child.once("close", (code) => {
        if (code === 0) done(output);
        else reject(Object.assign(new Error("NATIVE_COMMAND_FAILED"), { code, nativeCode: "NATIVE_COMMAND_FAILED" }));
      });
      timer = setTimeout(() => reject(Object.assign(new Error("NATIVE_COMMAND_TIMEOUT"),
        { nativeCode: "NATIVE_COMMAND_TIMEOUT" })), options.timeout ?? 90_000);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
    try { return await pending; }
    catch (error) {
      stopping = stopTree(child, childEnv);
      error.nativeCode ??= "NATIVE_COMMAND_FAILED";
      throw error;
    } finally { clearTimeout(timer); if (stopping) await stopping; }
  }
  const runProduct = (args, options) => run(process.execPath, [productEntrypoint, ...args], options);
  async function runCodeBuddy(prompt, options = {}) {
    const args = Array.isArray(prompt) ? prompt : ["-p", prompt, "--output-format", "stream-json", "--verbose",
      "--model", fixtureModel, "--setting-sources", "user", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
      ...(options.sessionId ? ["--resume", options.sessionId] : []), ...(options.args ?? [])];
    const result = await run(codebuddyCommand, args, options);
    if (Array.isArray(prompt)) return result;
    const events = result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const completed = events.filter((event) => event.type === "result");
    check(completed.length === 1 && completed[0].is_error === false && completed[0].subtype === "success"
      && completed[0].terminal_reason === undefined,
      "NATIVE_CODEBUDDY_TURN_FAILED");
    check(typeof completed[0].session_id === "string" && completed[0].session_id.length > 0
      && typeof completed[0].result === "string", "NATIVE_CODEBUDDY_RESULT_INVALID");
    return { ...result, events, sessionId: completed[0].session_id, text: completed[0].result };
  }
  async function setup() {
    const version = (await run(codebuddyCommand, ["--version"])).stdout.trim()
      .match(/^(\d+\.\d+\.\d+)$/);
    check(version, "NATIVE_CODEBUDDY_VERSION_INVALID");
    nativeVersion = version[1];
    if (expectedVersion) check(nativeVersion === expectedVersion, "NATIVE_CODEBUDDY_VERSION_MISMATCH");
    setupStarted = true;
    await runProduct(["setup", "--existing-account", "--non-interactive"], { input: `${fixtureKey}\n` });
    const status = JSON.parse((await runProduct(["status", "--clients", "codebuddy", "--json"])).stdout);
    check(status.ok === true && status.backend?.ok === true && status.codebuddyAdapter?.ok === true, "NATIVE_SETUP_NOT_READY");
    const record = JSON.parse(await readFile(join(stateHome, "runtime", "backend", "backend.pid.json"), "utf8"));
    check(Number.isInteger(record.pid) && record.pid > 1
      && record.url === `http://127.0.0.1:${backendPort}`, "NATIVE_BACKEND_PID_INVALID");
    backendPids.add(record.pid);
    return status;
  }
  function startCodeBuddy(args, options = {}) {
    check(!closePromise, "NATIVE_HARNESS_IS_CLOSING");
    const childEnv = { ...env, ...options.env };
    const invocation = resolveWindowsCliInvocation(codebuddyCommand, args, { env: childEnv });
    const child = spawn(invocation.command, invocation.args, { cwd: options.cwd ?? workspace, env: childEnv,
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
    children.add(child);
    return child;
  }
  function close() { return closePromise ??= closeResources(); }
  async function closeResources() {
    let cleanupError;
    const attempt = async (operation) => {
      try { return await operation(); } catch (error) { cleanupError ??= error; }
    };
    try {
      await attempt(async () => beforeClose?.());
      for (const child of children) await attempt(() => stopTree(child, env));
      const pidPath = join(stateHome, "runtime", "backend", "backend.pid.json");
      let backendRecordPresent = false;
      await attempt(async () => {
        const raw = await readFile(pidPath, "utf8").catch((error) => {
          if (error.code === "ENOENT") return undefined; throw error;
        });
        if (raw === undefined) return;
        backendRecordPresent = true;
        const current = JSON.parse(raw);
        check(Number.isInteger(current?.pid) && current.pid > 1, "NATIVE_BACKEND_PID_INVALID");
        backendPids.add(current.pid);
      });
      if (setupStarted || backendRecordPresent || backendPids.size) {
        await attempt(async () => {
          const stopped = JSON.parse((await runProduct(["stop", "--clients", "codebuddy", "--json"], { timeout: 15_000, cleanup: true })).stdout);
          check(stopped.ok === true, "NATIVE_BACKEND_STOP_FAILED");
        });
        for (const pid of backendPids) await attempt(() => waitFor(() => !processAlive(pid), "NATIVE_BACKEND_PROCESS_REMAINS"));
        await attempt(async () => check(await stat(pidPath).then(() => false, (error) => error.code === "ENOENT"),
          "NATIVE_BACKEND_RECORD_REMAINS"));
        await attempt(async () => {
          const probe = createTcpServer();
          try {
            await new Promise((done, reject) => { probe.once("error", reject); probe.listen(backendPort, "127.0.0.1", done); });
          } finally { if (probe.listening) await new Promise((done) => probe.close(done)); }
        });
      }
    } finally {
      await attempt(() => memoryServer.close());
      await attempt(() => modelServer.close());
      if (!cleanupError) await attempt(() => rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
      for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    }
    if (cleanupError) { cleanupError.nativeCode ??= "NATIVE_CLEANUP_FAILED"; throw cleanupError; }
  }
  let stoppingForSignal = false;
  function onSignal(signal) {
    if (stoppingForSignal) return;
    stoppingForSignal = true;
    const exit = signal === "SIGINT" ? 130 : 143;
    const deadline = setTimeout(() => process.exit(exit), 45_000);
    void close().then(() => { clearTimeout(deadline); process.exit(exit); }, () => { clearTimeout(deadline); process.exit(exit); });
  }
  const signalHandlers = new Map(["SIGINT", "SIGTERM"].map((signal) => [signal, () => onSignal(signal)]));
  for (const [signal, handler] of signalHandlers) process.on(signal, handler);
  return { root, home, workspace, stateHome, codebuddyHome, env, packageRoot, codebuddyCommand,
    get codebuddyVersion() { return nativeVersion; }, memoryEntrypoint, productEntrypoint,
    modelUrl: modelServer.url, memoryUrl: memoryServer.url, modelRequests, memoryRequests, serverErrors, modelRequestRejections,
    setup, close, runProduct, runCodeBuddy, startCodeBuddy,
    runMemory: (args, options) => run(process.execPath, [memoryEntrypoint, ...args], options),
    setBeforeClose(handler) {
      check(!closePromise, "NATIVE_HARNESS_IS_CLOSING");
      check(typeof handler === "function", "NATIVE_CLEANUP_HANDLER_INVALID");
      beforeClose = handler;
    },
    setModelHandler(handler) { modelHandler = handler; } };
}

export function summarizeModelRoute(request) {
  const methods = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"];
  const segments = new Set(["v1", "v2", "v3", "api", "codebuddy", "chat", "completions", "responses", "messages",
    "models", "tokenize", "tokens", "count_tokens", "conversation", "session", "auth", "user", "info", "config", "health"]);
  let url;
  try { url = new URL(request.url, "http://127.0.0.1"); } catch {}
  const parts = url?.pathname.split("/").filter(Boolean);
  return { method: methods.includes(request.method) ? request.method : "other",
    route: parts && parts.length <= 8 && parts.every((part) => segments.has(part)) ? url.pathname : "other",
    queryPresent: Boolean(url?.search) };
}

let responseSequence = 0;
export function sendChatCompletion(response, { text, toolCalls = [] } = {}) {
  check(text === undefined || typeof text === "string", "MODEL_RESPONSE_TEXT_MISSING");
  check(Array.isArray(toolCalls) && toolCalls.every((tool) => typeof tool.id === "string" && tool.id.length > 0
    && typeof tool.name === "string" && tool.name.length > 0 && tool.input && typeof tool.input === "object"
    && !Array.isArray(tool.input)) && new Set(toolCalls.map((tool) => tool.id)).size === toolCalls.length,
  "MODEL_RESPONSE_TOOL_INVALID");
  check(typeof text === "string" || toolCalls.length > 0, "MODEL_RESPONSE_TEXT_MISSING");
  const calls = toolCalls.map(({ id, name, input }) => ({ id, type: "function", function: { name, arguments: JSON.stringify(input) } }));
  const finish = calls.length ? "tool_calls" : "stop";
  const common = { id: `native-chat-${++responseSequence}`, model: fixtureModel, created: Math.floor(Date.now() / 1000) };
  const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
  if (response.nativeStream === false) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ...common, object: "chat.completion", usage,
      choices: [{ index: 0, message: { role: "assistant", content: text ?? null,
        ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: finish }] }));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const deltas = [{ role: "assistant" }, ...(text === undefined ? [] : [{ content: text }]),
    ...calls.map((call, index) => ({ tool_calls: [{ index, ...call }] }))];
  for (const delta of deltas) response.write(`data: ${JSON.stringify({ ...common,
    object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ ...common, object: "chat.completion.chunk", usage,
    choices: [{ index: 0, delta: {}, finish_reason: finish }] })}\n\n`);
  response.end("data: [DONE]\n\n");
}

export async function waitFor(predicate, code = "NATIVE_WAIT_TIMEOUT", timeout = 15_000) {
  const deadline = Date.now() + timeout;
  do { const value = await predicate(); if (value) return value;
    await new Promise((done) => setTimeout(done, 50)); } while (Date.now() < deadline);
  check(false, code);
}
function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; if (error.code === "EPERM") return true; throw error; }
}
async function stopTree(child, env) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    if (!processAlive(child.pid)) return;
    await execFileAsync(join(env.SystemRoot, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"],
      { env, windowsHide: true, timeout: 10_000 }).catch((error) => { if (processAlive(child.pid)) throw error; });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
      if (error.code !== "ESRCH") throw error;
      if (processAlive(child.pid)) process.kill(child.pid, "SIGKILL");
    }
  }
  await waitFor(() => !processAlive(child.pid)
    && (process.platform === "win32" || !processAlive(-child.pid)), "NATIVE_CHILD_PROCESS_REMAINS", 10_000);
}
async function requestJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    check(bytes <= 2 * 1024 * 1024, "NATIVE_REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { check(false, "NATIVE_REQUEST_JSON_INVALID"); }
}
async function listen(handler, errors) {
  const server = createServer((request, response) => {
    handler(request, response).catch((error) => {
      errors.push(/^[A-Z][A-Z0-9_]+$/.test(error.nativeCode ?? "") ? error.nativeCode : "NATIVE_RECEIVER_FAILED");
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: async () => {
    server.closeAllConnections(); await new Promise((done) => server.close(done));
  } };
}
async function freePort() {
  const server = createTcpServer();
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
function isolatedEnv({ root, home, stateHome, codebuddyHome, codebuddyCommand, packageRoot, backendPort, modelUrl, memoryUrl, writeback }) {
  const windowsRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  const systemPaths = process.platform === "win32" ? [join(windowsRoot, "System32"), windowsRoot,
    join(windowsRoot, "System32", "Wbem"), join(windowsRoot, "System32", "WindowsPowerShell", "v1.0")]
    : ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const packageBin = process.platform === "win32" ? resolve(packageRoot, "../../..") : resolve(packageRoot, "../../../..", "bin");
  const env = {
    HOME: home, USERPROFILE: home, USER: "native-fixture", LOGNAME: "native-fixture", LANG: "en_US.UTF-8",
    PATH: [dirname(codebuddyCommand), packageBin, dirname(process.execPath), ...systemPaths].join(delimiter),
    APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
    TMPDIR: join(root, "tmp"), TMP: join(root, "tmp"), TEMP: join(root, "tmp"),
    npm_config_cache: join(root, "npm-cache"), XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"), XDG_STATE_HOME: join(home, ".local", "state"), XDG_CACHE_HOME: join(home, ".cache"),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, "missing-git-config"), GIT_TERMINAL_PROMPT: "0",
    CODEBUDDY_HOME: codebuddyHome, CODEBUDDY_CONFIG_DIR: codebuddyHome, MEMORAX_CODE_CODEBUDDY_COMMAND: codebuddyCommand,
    CODEBUDDY_BASE_URL: modelUrl, CODEBUDDY_API_KEY: "native-model-fixture", CODEBUDDY_MODEL: fixtureModel,
    CODEBUDDY_SMALL_FAST_MODEL: fixtureModel, CODEBUDDY_BIG_SLOW_MODEL: fixtureModel, CODEBUDDY_CODE_SUBAGENT_MODEL: fixtureModel,
    DISABLE_TELEMETRY: "1", DISABLE_ERROR_REPORTING: "1", DISABLE_AUTOUPDATER: "1", DISABLE_FEEDBACK_COMMAND: "1",
    CODEBUDDY_SKIP_BUILTIN_MARKETPLACE: "1", CODEBUDDY_AUTO_UPDATE_THIRD_PARTY_MARKETPLACES: "false",
    CODEBUDDY_DISABLE_AUTO_MEMORY: "1", CODEBUDDY_DISABLE_SHELL_SNAPSHOT: "1",
    CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS: "1", CODEBUDDY_BASH_AUTO_BACKGROUND_DISABLED: "1",
    MEMORAX_CODE_HOME: stateHome, MEMORAX_CODE_AUTO_UPDATE: "false", MEMORAX_CODE_INSTALL_WATCHDOG: "0",
    MEMORAX_CODE_BACKEND_HOST: "127.0.0.1", MEMORAX_CODE_BACKEND_PORT: String(backendPort),
    MEMORAX_CODE_MEMORAX_ENDPOINT: memoryUrl, MEMORAX_CODE_MEMORAX_API_KEY: fixtureKey,
    MEMORAX_CODE_MEMORAX_USER_ID: fixtureUser, MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: String(writeback),
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false", MEMORAX_CODE_MEMORY_WRITEBACK_CHUNK_ENABLED: "false",
    MEMORAX_CODE_JEV_ENABLED: "false", MEMORAX_CODE_CODEBUDDY_TRACE_ENABLED: "true", MEMORAX_CODE_SKIP_CODEX_PLUGIN_INSTALL: "1",
    CODEX_HOME: join(home, ".codex"), CLAUDE_HOME: join(home, ".claude"), CLAUDE_CONFIG_DIR: join(home, ".claude"),
    DSH_HOME: join(home, ".dsh"), OPENCODE_CONFIG_DIR: join(home, ".config", "opencode"),
    // CodeBuddy's model loader prefers WORKBUDDY_CONFIG_DIR even in CodeBuddy.
    // Leave that alias unset; WorkBuddy's default home is still isolated.
    WORKBUDDY_HOME: join(home, ".workbuddy"),
    TRAE_HOME: join(home, ".trae-cn"), TRAE_CN_HOME: join(home, ".trae-cn"), CURSOR_HOME: join(home, ".cursor"),
  };
  if (process.platform === "win32") Object.assign(env, { SystemRoot: windowsRoot, WINDIR: windowsRoot,
    ComSpec: join(windowsRoot, "System32", "cmd.exe"), PATHEXT: ".COM;.EXE;.BAT;.CMD", USERNAME: "native-fixture" });
  for (const client of otherClients) {
    env[`MEMORAX_CODE_${client.toUpperCase()}_COMMAND`] = join(root, "unused-client");
    env[`MEMORAX_CODE_${client.toUpperCase()}_TRACE_ENABLED`] = "false";
    env[`MEMORAX_CODE_SKIP_${client.toUpperCase()}_ADAPTER_INSTALL`] = "1";
  }
  return env;
}
