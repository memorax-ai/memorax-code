import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const otherClients = ["codex", "dsh", "opencode", "codebuddy", "workbuddy", "trae", "cursor"];
export const fixtureKey = `sk_${"E".repeat(43)}`;
export const fixtureUser = "native-fixture-user";
export const fixtureModel = "memorax-native-fixture";
export const searchResult = "NATIVE_MEMORY_SEARCH_RESULT";

export function check(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { nativeCode: code });
}

export async function createNativeHarness({ packageRoot, claudeCommand, label = "native", writeback = true, expectedVersion }) {
  packageRoot = resolve(packageRoot);
  claudeCommand = resolve(claudeCommand);
  const { resolveWindowsCliInvocation } = await import(pathToFileURL(join(packageRoot, "lib", "windows-cli-invocation.mjs")));
  const root = await mkdtemp(join(tmpdir(), `memorax-claude-${label}-`));
  const home = join(root, "user home");
  const workspace = join(root, "project-alpha");
  const stateHome = join(home, ".memorax-code");
  const claudeHome = join(home, ".claude");
  const productEntrypoint = join(packageRoot, "bin", "memorax-code.mjs");
  const memoryEntrypoint = join(packageRoot, "bin", "memorax-cli.mjs");
  const modelRequests = [], memoryRequests = [], serverErrors = [];
  const children = new Set(), backendPids = new Set();
  let modelHandler, nativeVersion, beforeClose, setupStarted = false, closePromise, modelPreflightRequests = 0;
  let memoryServer, modelServer, backendPort, env;
  try {
    for (const directory of [workspace, stateHome, claudeHome, join(root, "tmp")]) await mkdir(directory, { recursive: true });
    memoryServer = await listen(async (request, response) => {
      const body = await requestJson(request);
      const isSearch = request.url === "/v1/memories/search";
      check(request.method === "POST" && (isSearch || request.url === "/v1/memories/add"), "UNEXPECTED_MEMORY_REQUEST");
      memoryRequests.push({ method: request.method, path: request.url, authorization: request.headers.authorization, body });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: true, data: isSearch
        ? { task_id: "native-search", status: "completed", data: [{ id: "fixture-memory", memory: searchResult,
          score: 0.95, metadata: { memory_type: "procedural" } }] }
        : { task_id: `native-add-${memoryRequests.length}`, status: "queued" } }));
    }, serverErrors);
    modelServer = await listen(async (request, response) => {
      const path = new URL(request.url, "http://127.0.0.1").pathname;
      if (request.method === "HEAD" && path === "/api/hello") {
        modelPreflightRequests++;
        response.writeHead(200);
        response.end();
        return;
      }
      check(request.method === "POST" && ["/v1/messages", "/v1/messages/count_tokens"].includes(path), "UNEXPECTED_MODEL_REQUEST");
      const body = await requestJson(request);
      check(request.headers["x-api-key"] === "native-model-fixture", "NATIVE_MODEL_CREDENTIAL_MISMATCH");
      check(body.model === fixtureModel, "NATIVE_MODEL_ID_MISMATCH");
      if (path === "/v1/messages/count_tokens") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ input_tokens: 100 }));
        return;
      }
      modelRequests.push({ method: request.method, path, body });
      check(typeof modelHandler === "function", "MODEL_HANDLER_NOT_SET");
      response.nativeStream = body.stream === true;
      const result = await modelHandler(body, response, modelRequests.length);
      if (!response.writableEnded && result !== undefined) sendMessages(response, typeof result === "string" ? { text: result } : result);
      check(response.writableEnded, "MODEL_HANDLER_DID_NOT_COMPLETE");
    }, serverErrors);
    backendPort = await freePort();
    env = isolatedEnv({ root, home, stateHome, claudeHome, claudeCommand, packageRoot, backendPort,
      modelUrl: modelServer.url, memoryUrl: memoryServer.url, writeback });
    if (process.platform === "win32") {
      const gitBash = join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe");
      check(await stat(gitBash).then((info) => info.isFile(), () => false), "NATIVE_WINDOWS_GIT_BASH_MISSING");
      env.CLAUDE_CODE_GIT_BASH_PATH = gitBash;
      env.PATH += `${delimiter}${dirname(gitBash)}${delimiter}${resolve(dirname(gitBash), "../cmd")}`;
    }
    await writeFile(join(stateHome, "config.toml"), ["[clients]", "claude = true",
      ...otherClients.map((client) => `${client} = false`), "[jev]", "enabled = false", ""].join("\n"), { mode: 0o600 });
    await writeFile(join(claudeHome, "settings.json"), JSON.stringify({ model: fixtureModel,
      env: { ANTHROPIC_BASE_URL: modelServer.url, ANTHROPIC_API_KEY: "native-model-fixture" },
      permissions: { deny: ["WebSearch", "WebFetch"] }, skipWebFetchPreflight: true,
    }), { mode: 0o600 });
  } catch (error) {
    await memoryServer?.close();
    await modelServer?.close();
    await rm(root, { recursive: true, force: true });
    throw error;
  }

  // Keep exited leaders: a tool can leave descendants in its owned process group.
  function track(child) { children.add(child); return child; }
  async function run(command, args, options = {}) {
    check(!closePromise || options.cleanup === true, "NATIVE_HARNESS_IS_CLOSING");
    const childEnv = { ...env, ...options.env };
    const invocation = resolveWindowsCliInvocation(command, args, { env: childEnv });
    const child = track(spawn(invocation.command, invocation.args, { cwd: options.cwd ?? workspace,
      env: childEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" }));
    let timer, stopping;
    const pending = new Promise((done, reject) => {
      const output = { stdout: "", stderr: "" }, sizes = { stdout: 0, stderr: 0 };
      for (const name of ["stdout", "stderr"]) {
        child[name].setEncoding("utf8");
        child[name].on("data", (text) => {
          sizes[name] += Buffer.byteLength(text);
          if (sizes[name] > 16 * 1024 * 1024) {
            reject(Object.assign(new Error("NATIVE_OUTPUT_LIMIT"), { nativeCode: "NATIVE_OUTPUT_LIMIT" }));
          } else output[name] += text;
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
  async function runClaude(prompt, options = {}) {
    const args = Array.isArray(prompt) ? prompt : ["-p", prompt, "--output-format", "stream-json", "--verbose",
      "--model", fixtureModel, "--permission-mode", "dontAsk", "--setting-sources", "user",
      "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {} }),
      ...(options.sessionId ? ["--resume", options.sessionId] : []), ...(options.args ?? [])];
    const result = await run(claudeCommand, args, options);
    if (Array.isArray(prompt)) return result;
    const events = result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    const completed = events.findLast((event) => event.type === "result");
    check(completed?.is_error === false && completed.subtype === "success", "NATIVE_CLAUDE_TURN_FAILED");
    return { ...result, events, sessionId: completed.session_id, text: completed.result };
  }
  async function setup() {
    const version = (await run(claudeCommand, ["--version"])).stdout.trim().match(/^(\d+\.\d+\.\d+) \(Claude Code\)$/);
    check(version, "NATIVE_CLAUDE_VERSION_INVALID");
    nativeVersion = version[1];
    if (expectedVersion) check(nativeVersion === expectedVersion, "NATIVE_CLAUDE_VERSION_MISMATCH");
    setupStarted = true;
    await runProduct(["setup", "--existing-account", "--non-interactive"], { input: `${fixtureKey}\n` });
    const status = JSON.parse((await runProduct(["status", "--clients", "claude", "--json"])).stdout);
    check(status.ok === true && status.backend?.ok === true && status.claudeAdapter?.ok === true, "NATIVE_SETUP_NOT_READY");
    const pid = JSON.parse(await readFile(join(stateHome, "runtime", "backend", "backend.pid.json"), "utf8")).pid;
    check(Number.isInteger(pid) && pid > 0, "NATIVE_BACKEND_PID_INVALID");
    backendPids.add(pid);
    return status;
  }
  function spawnClaude(args, options = {}) {
    check(!closePromise, "NATIVE_HARNESS_IS_CLOSING");
    const invocation = resolveWindowsCliInvocation(claudeCommand, args, { env });
    return track(spawn(invocation.command, invocation.args, { cwd: options.cwd ?? workspace, env,
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" }));
  }
  function close() { return closePromise ??= closeResources(); }
  async function closeResources() {
    let cleanupError;
    try { await beforeClose?.(); }
    catch (error) { cleanupError = error; }
    try {
      for (const child of children) await stopTree(child, env);
      const pidPath = join(stateHome, "runtime", "backend", "backend.pid.json");
      const current = await readFile(pidPath, "utf8").then(JSON.parse).catch((error) => {
        if (error.code === "ENOENT") return undefined; throw error;
      });
      if (Number.isInteger(current?.pid) && current.pid > 0) backendPids.add(current.pid);
      if (setupStarted || backendPids.size) {
        const stopped = JSON.parse((await runProduct(["stop", "--clients", "claude", "--json"], { timeout: 15_000, cleanup: true })).stdout);
        check(stopped.ok === true, "NATIVE_BACKEND_STOP_FAILED");
        for (const pid of backendPids) await waitFor(() => !processAlive(pid), "NATIVE_BACKEND_PROCESS_REMAINS");
        check(await stat(pidPath).then(() => false, (error) => error.code === "ENOENT"), "NATIVE_BACKEND_RECORD_REMAINS");
        const probe = createTcpServer();
        await new Promise((done, reject) => { probe.once("error", reject); probe.listen(backendPort, "127.0.0.1", done); });
        await new Promise((done) => probe.close(done));
      }
    } catch (error) {
      cleanupError ??= error;
      for (const child of children) await stopTree(child, env).catch(() => {});
      for (const pid of backendPids) if (processAlive(pid)) await stopTree({ pid }, env).catch(() => {});
    } finally {
      try {
        await memoryServer.close();
        await modelServer.close();
        if (!cleanupError) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch (error) { cleanupError ??= error; }
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
  return { root, home, workspace, stateHome, claudeHome, env, packageRoot, claudeCommand,
    get claudeVersion() { return nativeVersion; }, memoryEntrypoint, productEntrypoint,
    get modelPreflightRequests() { return modelPreflightRequests; },
    modelUrl: modelServer.url, memoryUrl: memoryServer.url, modelRequests, memoryRequests, serverErrors,
    setup, close, runProduct, runClaude, spawnClaude,
    runMemory: (args, options) => run(process.execPath, [memoryEntrypoint, ...args], options),
    setBeforeClose(handler) {
      check(!closePromise, "NATIVE_HARNESS_IS_CLOSING");
      check(typeof handler === "function", "NATIVE_CLEANUP_HANDLER_INVALID");
      beforeClose = handler;
    },
    setModelHandler(handler) { modelHandler = handler; } };
}

let messageSequence = 0;
export function sendMessages(response, { text, toolCalls = [] } = {}) {
  const content = [...(text === undefined ? [] : [{ type: "text", text }]),
    ...toolCalls.map(({ id, name, input }) => ({ type: "tool_use", id, name, input }))];
  const message = { id: `msg_native_${++messageSequence}`, type: "message", role: "assistant", model: fixtureModel,
    content, stop_reason: toolCalls.length ? "tool_use" : "end_turn", stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } };
  if (response.nativeStream === false) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(message));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const event = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  event("message_start", { message: { ...message, content: [], stop_reason: null, usage: { ...message.usage, output_tokens: 0 } } });
  for (const [index, block] of content.entries()) {
    const tool = block.type === "tool_use";
    event("content_block_start", { index, content_block: tool ? { ...block, input: {} } : { type: "text", text: "" } });
    event("content_block_delta", { index, delta: tool ? { type: "input_json_delta", partial_json: JSON.stringify(block.input) }
      : { type: "text_delta", text: block.text } });
    event("content_block_stop", { index });
  }
  event("message_delta", { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } });
  event("message_stop", {});
  response.end();
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
    if (child.exitCode != null || child.signalCode != null) return;
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
export { stopTree as stopNativeProcessTree };
async function requestJson(request) {
  let text = "";
  for await (const chunk of request) { text += chunk; check(text.length <= 2 * 1024 * 1024, "NATIVE_REQUEST_TOO_LARGE"); }
  return JSON.parse(text);
}
async function listen(handler, errors) {
  const server = createServer((request, response) => {
    handler(request, response).catch((error) => {
      errors.push(error.nativeCode ?? "NATIVE_RECEIVER_FAILED");
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
function isolatedEnv({ root, home, stateHome, claudeHome, claudeCommand, packageRoot, backendPort, modelUrl, memoryUrl, writeback }) {
  const windowsRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  const systemPaths = process.platform === "win32" ? [join(windowsRoot, "System32"), windowsRoot,
    join(windowsRoot, "System32", "Wbem"), join(windowsRoot, "System32", "WindowsPowerShell", "v1.0")]
    : ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const packageBin = process.platform === "win32" ? resolve(packageRoot, "../../..") : resolve(packageRoot, "../../../..", "bin");
  const env = {
    HOME: home, USERPROFILE: home, USER: "native-fixture", LOGNAME: "native-fixture", LANG: "en_US.UTF-8",
    PATH: [dirname(process.execPath), dirname(claudeCommand), packageBin, ...systemPaths].join(delimiter),
    APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
    TMPDIR: join(root, "tmp"), TMP: join(root, "tmp"), TEMP: join(root, "tmp"),
    npm_config_cache: join(root, "npm-cache"), XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"), XDG_STATE_HOME: join(home, ".local", "state"), XDG_CACHE_HOME: join(home, ".cache"),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, "missing-git-config"), GIT_TERMINAL_PROMPT: "0",
    CLAUDE_CONFIG_DIR: claudeHome, CLAUDE_HOME: claudeHome, MEMORAX_CODE_CLAUDE_COMMAND: claudeCommand,
    ANTHROPIC_BASE_URL: modelUrl, ANTHROPIC_API_KEY: "native-model-fixture", ANTHROPIC_MODEL: fixtureModel,
    ANTHROPIC_DEFAULT_OPUS_MODEL: fixtureModel, ANTHROPIC_DEFAULT_SONNET_MODEL: fixtureModel,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: fixtureModel, ANTHROPIC_SMALL_FAST_MODEL: fixtureModel,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1", CLAUDE_CODE_DISABLE_1M_CONTEXT: "1", CLAUDE_CODE_DISABLE_THINKING: "1",
    MEMORAX_CODE_HOME: stateHome, MEMORAX_CODE_AUTO_UPDATE: "false", MEMORAX_CODE_INSTALL_WATCHDOG: "0",
    MEMORAX_CODE_BACKEND_HOST: "127.0.0.1", MEMORAX_CODE_BACKEND_PORT: String(backendPort),
    MEMORAX_CODE_MEMORAX_ENDPOINT: memoryUrl, MEMORAX_CODE_MEMORAX_API_KEY: fixtureKey,
    MEMORAX_CODE_MEMORAX_USER_ID: fixtureUser, MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: String(writeback),
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false", MEMORAX_CODE_MEMORY_WRITEBACK_CHUNK_ENABLED: "false",
    MEMORAX_CODE_JEV_ENABLED: "false", MEMORAX_CODE_CLAUDE_TRACE_ENABLED: "true", MEMORAX_CODE_SKIP_CODEX_PLUGIN_INSTALL: "1",
    CODEX_HOME: join(home, ".codex"), DSH_HOME: join(home, ".dsh"), OPENCODE_CONFIG_DIR: join(home, ".config", "opencode"),
    CODEBUDDY_HOME: join(home, ".codebuddy"), CODEBUDDY_CONFIG_DIR: join(home, ".codebuddy"),
    WORKBUDDY_HOME: join(home, ".workbuddy"), WORKBUDDY_CONFIG_DIR: join(home, ".workbuddy"),
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
