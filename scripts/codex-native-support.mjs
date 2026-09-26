import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const otherClients = ["claude", "dsh", "opencode", "codebuddy", "workbuddy", "trae", "cursor"];
export const fixtureKey = `sk_${"E".repeat(43)}`;
export const fixtureUser = "native-fixture-user";
export const searchResult = "NATIVE_MEMORY_SEARCH_RESULT";

export function check(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { nativeCode: code });
}

export async function createNativeHarness({ packageRoot, codexCommand, label = "native", writeback = true }) {
  packageRoot = resolve(packageRoot);
  codexCommand = resolve(codexCommand);
  const { resolveWindowsCliInvocation } = await import(pathToFileURL(join(packageRoot, "lib", "windows-cli-invocation.mjs")));
  const root = await mkdtemp(join(tmpdir(), `memorax-codex-${label}-`));
  const home = join(root, "user home");
  const workspace = join(root, "project-alpha");
  const stateHome = join(home, ".memorax-code");
  const codexHome = join(home, ".codex");
  const productEntrypoint = join(packageRoot, "bin", "memorax-code.mjs");
  const memoryEntrypoint = join(packageRoot, "bin", "memorax-cli.mjs");
  const modelRequests = [], memoryRequests = [], serverErrors = [];
  const children = new Set(), backendPids = new Set();
  let modelHandler, setupStarted = false, closed = false;
  let memoryServer, modelServer, backendPort, env;
  try {
    await Promise.all([workspace, stateHome, codexHome, join(root, "tmp")].map((path) => mkdir(path, { recursive: true })));
    memoryServer = await listen(async (request, response) => {
      const body = await requestJson(request);
      memoryRequests.push({ method: request.method, path: request.url, authorization: request.headers.authorization, body });
      const isSearch = request.url === "/v1/memories/search";
      check(request.method === "POST" && (isSearch || request.url === "/v1/memories/add"), "UNEXPECTED_MEMORY_REQUEST");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ success: true, data: isSearch
        ? { task_id: "native-search", status: "completed", data: [{ id: "fixture-memory", memory: searchResult,
          score: 0.95, metadata: { memory_type: "procedural" } }] }
        : { task_id: `native-add-${memoryRequests.length}`, status: "queued" } }));
    }, serverErrors);
    modelServer = await listen(async (request, response) => {
      const body = await requestJson(request);
      modelRequests.push({ method: request.method, path: request.url, body });
      check(request.method === "POST" && request.url === "/responses", "UNEXPECTED_MODEL_REQUEST");
      check(typeof modelHandler === "function", "MODEL_HANDLER_NOT_SET");
      await modelHandler(body, response, modelRequests.length);
      check(response.writableEnded, "MODEL_HANDLER_DID_NOT_COMPLETE");
    }, serverErrors);
    backendPort = await freePort();
    env = isolatedEnv({ root, home, stateHome, codexHome, codexCommand, packageRoot, backendPort,
      memoryUrl: memoryServer.url, writeback });
    await writeFile(join(stateHome, "config.toml"), ["[clients]", "codex = true",
      ...otherClients.map((client) => `${client} = false`), "[jev]", "enabled = false", ""].join("\n"), { mode: 0o600 });
    await writeFile(join(codexHome, "config.toml"), [
      'model = "gpt-5.4"', 'model_provider = "local_native"', 'model_reasoning_effort = "low"',
      'cli_auth_credentials_store = "file"', 'approval_policy = "never"', 'sandbox_mode = "danger-full-access"',
      'web_search = "disabled"', 'project_doc_max_bytes = 0',
      "[features]", "shell_snapshot = false", "remote_models = false", "responses_websockets = false",
      "responses_websockets_v2 = false", "respect_system_proxy = false", "hooks = true", "plugins = true",
      "[model_providers.local_native]", 'name = "Local native test"', `base_url = ${JSON.stringify(modelServer.url)}`,
      'wire_api = "responses"', 'env_key = "NATIVE_MODEL_KEY"', "requires_openai_auth = false",
      "supports_websockets = false", "request_max_retries = 0", "stream_max_retries = 0", "stream_idle_timeout_ms = 15000", "",
    ].join("\n"), { mode: 0o600 });
  } catch (error) {
    await Promise.all([memoryServer?.close(), modelServer?.close()]);
    await rm(root, { recursive: true, force: true });
    throw error;
  }

  function track(child) { children.add(child); child.once("exit", () => children.delete(child)); return child; }
  function spawnCodex(args, options = {}) {
    const invocation = resolveWindowsCliInvocation(codexCommand, args, { env });
    return track(spawn(invocation.command, invocation.args, { cwd: options.cwd ?? workspace, env,
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" }));
  }
  async function run(command, args, options = {}) {
    const invocation = resolveWindowsCliInvocation(command, args, { env });
    const pending = execFileAsync(invocation.command, invocation.args, {
      cwd: options.cwd ?? workspace, env, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
      windowsHide: true, detached: process.platform !== "win32",
    });
    track(pending.child);
    pending.child.stdin.on("error", () => {});
    pending.child.stdin.end(options.input ?? "");
    let timedOut = false, stopping;
    const timer = setTimeout(() => { timedOut = true; stopping = stopTree(pending.child, env); }, options.timeout ?? 90_000);
    try { const result = await pending; check(!timedOut, "NATIVE_COMMAND_TIMEOUT"); return result; }
    catch (error) { stopping ??= stopTree(pending.child, env); check(!timedOut, "NATIVE_COMMAND_TIMEOUT"); throw error; }
    finally { clearTimeout(timer); if (stopping) await stopping; }
  }
  const runProduct = (args, options) => run(process.execPath, [productEntrypoint, ...args], options);
  async function setup() {
    check((await run(codexCommand, ["--version"])).stdout.trim() === "codex-cli 0.147.0", "NATIVE_CODEX_VERSION_MISMATCH");
    setupStarted = true;
    await runProduct(["setup", "--existing-account", "--non-interactive"], { input: `${fixtureKey}\n` });
    const status = JSON.parse((await runProduct(["status", "--clients", "codex", "--json"])).stdout);
    check(status.ok === true && status.backend?.ok === true && status.codexAdapter?.ok === true, "NATIVE_SETUP_NOT_READY");
    const trust = JSON.parse((await runProduct(["codex-plugin", "trust-hooks", "--check", "--json"])).stdout);
    check(trust.ok === true && trust.hooks?.length === 0 && trust.requiresFullReview === false, "NATIVE_HOOKS_NOT_TRUSTED");
    const pid = JSON.parse(await readFile(join(stateHome, "runtime", "backend", "backend.pid.json"), "utf8")).pid;
    check(Number.isInteger(pid) && pid > 0, "NATIVE_BACKEND_PID_INVALID");
    backendPids.add(pid);
    return status;
  }
  async function close() {
    if (closed) return;
    closed = true;
    let cleanupError;
    try {
      await Promise.all([...children].map((child) => stopTree(child, env)));
      if (setupStarted) {
        const pidPath = join(stateHome, "runtime", "backend", "backend.pid.json");
        const current = await readFile(pidPath, "utf8").then(JSON.parse).catch(() => undefined);
        if (Number.isInteger(current?.pid) && current.pid > 0) backendPids.add(current.pid);
        const stopped = JSON.parse((await runProduct(["stop", "--clients", "codex", "--json"])).stdout);
        check(stopped.ok === true, "NATIVE_BACKEND_STOP_FAILED");
        for (const pid of backendPids) check(!isAlive(pid), "NATIVE_BACKEND_PROCESS_REMAINS");
        check(await stat(pidPath).then(() => false, (error) => error.code === "ENOENT"), "NATIVE_BACKEND_RECORD_REMAINS");
        const probe = createTcpServer();
        await new Promise((done, reject) => { probe.once("error", reject); probe.listen(backendPort, "127.0.0.1", done); });
        await new Promise((done) => probe.close(done));
      }
    } catch (error) {
      cleanupError = error;
      for (const pid of backendPids) if (isAlive(pid)) await stopTree({ pid, kill: () => process.kill(pid, "SIGKILL") }, env);
    } finally {
      await Promise.all([memoryServer.close(), modelServer.close()]);
      await rm(root, { recursive: true, force: true });
    }
    if (cleanupError) throw cleanupError;
  }
  return { root, home, workspace, stateHome, codexHome, env, packageRoot, codexCommand,
    memoryEntrypoint, modelUrl: modelServer.url, memoryUrl: memoryServer.url,
    modelRequests, memoryRequests, serverErrors, setup, close, spawnCodex, runProduct,
    runCodex: (args, options) => run(codexCommand, args, options),
    runMemory: (args, options) => run(process.execPath, [memoryEntrypoint, ...args], options),
    setModelHandler(handler) { modelHandler = handler; } };
}

// The minimal SSE form used by Codex's pinned native Responses tests.
let responseSequence = 0;
export function sendResponses(response, { output, usage } = {}) {
  const id = `native-response-${++responseSequence}`;
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const events = [{ type: "response.created", response: { id } },
    ...output.map((item) => ({ type: "response.output_item.done", item })),
    { type: "response.completed", response: { id, usage: usage ?? {
      input_tokens: 100, input_tokens_details: { cached_tokens: 0 }, output_tokens: 10,
      output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 110,
    } } }];
  response.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
}

export async function waitFor(predicate, code, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  do { if (await predicate()) return; await new Promise((done) => setTimeout(done, 50)); } while (Date.now() < deadline);
  check(false, code);
}

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
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
function isAlive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } }
async function stopTree(child, env) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    await execFileAsync(join(env.SystemRoot, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"],
      { env, windowsHide: true, timeout: 10_000 }).catch(() => { child.kill(); });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
      if (error.code !== "ESRCH") throw error;
      if (isAlive(child.pid)) child.kill();
    }
  }
}
function isolatedEnv({ root, home, stateHome, codexHome, codexCommand, packageRoot, backendPort, memoryUrl, writeback }) {
  const windowsRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  const systemPaths = process.platform === "win32" ? [join(windowsRoot, "System32"), windowsRoot,
    join(windowsRoot, "System32", "Wbem"), join(windowsRoot, "System32", "WindowsPowerShell", "v1.0")] : ["/usr/bin", "/bin"];
  const packageBin = process.platform === "win32" ? resolve(packageRoot, "../../..") : resolve(packageRoot, "../../../..", "bin");
  const env = {
    HOME: home, USERPROFILE: home, USER: "native-fixture", LOGNAME: "native-fixture", LANG: "en_US.UTF-8",
    PATH: [dirname(process.execPath), dirname(codexCommand), packageBin, ...systemPaths].join(delimiter),
    APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
    TMPDIR: join(root, "tmp"), TMP: join(root, "tmp"), TEMP: join(root, "tmp"),
    XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"), XDG_CACHE_HOME: join(home, ".cache"),
    CODEX_HOME: codexHome, CODEX_CLI_PATH: codexCommand, MEMORAX_CODE_CODEX_COMMAND: codexCommand,
    MEMORAX_CODE_HOME: stateHome, MEMORAX_CODE_AUTO_UPDATE: "false", MEMORAX_CODE_INSTALL_WATCHDOG: "0",
    MEMORAX_CODE_BACKEND_HOST: "127.0.0.1", MEMORAX_CODE_BACKEND_PORT: String(backendPort),
    MEMORAX_CODE_MEMORAX_ENDPOINT: memoryUrl, MEMORAX_CODE_MEMORAX_API_KEY: fixtureKey,
    MEMORAX_CODE_MEMORAX_USER_ID: fixtureUser, MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: String(writeback),
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false", MEMORAX_CODE_MEMORY_WRITEBACK_CHUNK_ENABLED: "false",
    MEMORAX_CODE_JEV_ENABLED: "false", MEMORAX_CODE_CODEX_TRACE_ENABLED: "false", NATIVE_MODEL_KEY: "native-model-fixture",
    DSH_HOME: join(home, ".dsh"), CLAUDE_CONFIG_DIR: join(home, ".claude"), CLAUDE_HOME: join(home, ".claude"),
    OPENCODE_CONFIG_DIR: join(home, ".config", "opencode"), CODEBUDDY_HOME: join(home, ".codebuddy"),
    CODEBUDDY_CONFIG_DIR: join(home, ".codebuddy"), WORKBUDDY_HOME: join(home, ".workbuddy"),
    WORKBUDDY_CONFIG_DIR: join(home, ".workbuddy"), TRAE_HOME: join(home, ".trae-cn"), TRAE_CN_HOME: join(home, ".trae-cn"),
    CURSOR_HOME: join(home, ".cursor"),
  };
  if (process.platform === "win32") Object.assign(env, { SystemRoot: windowsRoot, WINDIR: windowsRoot,
    ComSpec: join(windowsRoot, "System32", "cmd.exe"), PATHEXT: ".COM;.EXE;.BAT;.CMD", USERNAME: "native-fixture" });
  for (const client of otherClients) {
    env[`MEMORAX_CODE_${client.toUpperCase()}_COMMAND`] = join(root, "unused-client");
    env[`MEMORAX_CODE_${client.toUpperCase()}_TRACE_ENABLED`] = "false";
  }
  return env;
}
