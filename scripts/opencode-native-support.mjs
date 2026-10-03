import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const otherClients = ["codex", "claude", "dsh", "codebuddy", "workbuddy", "trae", "cursor"];
const signalCleanups = new Set();
const signalHandlers = new Map(["SIGINT", "SIGTERM"].map((signal) => [signal, () => handleSignal(signal)]));
const safeErrorNames = new Set(["Error", "TypeError", "RangeError", "SyntaxError", "AbortError", "TimeoutError", "AggregateError"]);
const safeErrorCodes = new Set([
  "ABORT_ERR", "ENOENT", "ENOEXEC", "EACCES", "EPERM", "EINVAL", "ETIMEDOUT", "ECONNREFUSED", "ECONNRESET",
  "ECONNABORTED", "EPIPE", "EADDRINUSE", "EADDRNOTAVAIL", "ENOTFOUND", "EAI_AGAIN", "EBUSY", "ENOTEMPTY",
  "ENOTDIR", "EISDIR", "EMFILE", "ENFILE", "ENOSPC", "EIO", "EROFS", "ESRCH", "ERR_INVALID_ARG_TYPE",
  "ERR_INVALID_URL", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "UND_ERR_ABORTED", "UND_ERR_DESTROYED", "UND_ERR_CLOSED",
]);
const safeOperations = new Set([
  "SDK_REQUEST", "SDK_RESPONSE_READ", "SDK_RESPONSE_JSON", "BEFORE_CLOSE", "BACKEND_PID_READ", "REPO_JOBS_READ",
  "REPO_JOB_READ", "REPO_WORKER_STOP", "NATIVE_SERVER_STOP", "NATIVE_SERVER_PORT_RELEASE", "CHILD_PROCESS_STOP",
  "BACKEND_STOP", "BACKEND_PROCESS_EXIT", "BACKEND_RECORD_REMOVAL", "BACKEND_PORT_RELEASE", "RECEIVERS",
  "TEMPORARY_STATE", "PROCESS_ALIVE", "TASKKILL", "PROCESS_SIGNAL", "PROCESS_EXIT",
]);
let receivedSignal;
export const openCodeVersion = "1.18.18";
export const fixtureKey = `sk_${"E".repeat(43)}`;
export const fixtureUser = "native-fixture-user";
export const fixtureProvider = "local_native";
export const fixtureModel = "memorax-native-fixture";
export const searchResult = "NATIVE_MEMORY_SEARCH_RESULT";

export function check(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { nativeCode: code });
}

export function describeSafeError(error) {
  const result = {};
  const safeCode = (value) => safeErrorCodes.has(value) || (Number.isInteger(value) && value >= 0 && value <= 255);
  if (safeErrorNames.has(error?.name)) result.name = error.name;
  if (safeCode(error?.code)) result.code = error.code;
  if (safeCode(error?.cause?.code)) result.causeCode = error.cause.code;
  if (safeOperations.has(error?.nativeOperation)) result.operation = error.nativeOperation;
  if (safeOperations.has(error?.cleanupOperation)) result.cleanupOperation = error.cleanupOperation;
  return result;
}

export function createServerInitializationDiagnostics({ configDir, stateDir, pid, version }) {
  const milestones = { configDirectoryReached: false, dependencyInstallFailed: false, postPluginReached: false };
  const markers = new Map([
    ["loading config from OPENCODE_CONFIG_DIR", "configDirectoryReached"],
    ["background dependency install failed", "dependencyInstallFailed"],
    ["all LSPs are disabled", "postPluginReached"],
    ["all formatters are disabled", "postPluginReached"],
  ]);
  const listeningMessage = "opencode server listening on";
  let listeningSeen = false, stdoutTail = "", stderrLine = "", discardLine = false;
  const lock = join(stateDir, "locks", `${createHash("sha1").update(`npm-install:${configDir}`).digest("hex")}.lock`);
  return {
    get listeningSeen() { return listeningSeen; },
    stdout(chunk) {
      if (listeningSeen) return;
      const text = stdoutTail + chunk;
      listeningSeen = text.includes(listeningMessage);
      stdoutTail = listeningSeen ? "" : text.slice(-(listeningMessage.length - 1));
    },
    stderr(chunk) {
      const lines = String(chunk).split("\n");
      for (let index = 0; index < lines.length; index++) {
        if (!discardLine) {
          if (Buffer.byteLength(stderrLine) + Buffer.byteLength(lines[index]) > 8192) { stderrLine = ""; discardLine = true; }
          else stderrLine += lines[index];
        }
        if (index === lines.length - 1) continue;
        if (!discardLine) {
          // Upstream emits logfmt; only its leading message field can identify a milestone.
          const match = /^timestamp=\S+ level=\S+ run=\S+ message=("(?:[^"\\]|\\.)*"|[^\s]+)(?:\s|$)/.exec(stderrLine);
          if (match) {
            try {
              const marker = markers.get(match[1].startsWith('"') ? JSON.parse(match[1]) : match[1]);
              if (marker) milestones[marker] = true;
            } catch {}
          }
        }
        stderrLine = ""; discardLine = false;
      }
    },
    async snapshot() {
      const plugin = await diagnosticJson(join(configDir, "node_modules", "@opencode-ai", "plugin", "package.json"));
      const packageLock = await diagnosticJson(join(configDir, "package-lock.json"));
      const lockMeta = await diagnosticJson(join(lock, "meta.json"));
      const matchesVersion = (file, actual) => file.present === false ? false
        : typeof version === "string" && typeof actual === "string" ? actual === version : "unknown";
      return { milestones: { ...milestones }, dependencies: {
        packageJson: await diagnosticExists(join(configDir, "package.json")),
        nodeModules: await diagnosticExists(join(configDir, "node_modules"), true),
        pluginPackage: plugin.present,
        pluginVersionMatches: matchesVersion(plugin, plugin.value?.version),
        packageLock: packageLock.present,
        lockPluginVersionMatches: matchesVersion(packageLock, packageLock.value?.packages?.["node_modules/@opencode-ai/plugin"]?.version),
        npmInstallLock: await diagnosticExists(lock, true),
        npmInstallLockOwnedByServer: lockMeta.present === false ? false
          : Number.isInteger(lockMeta.value?.pid) && Number.isInteger(pid) ? lockMeta.value.pid === pid : "unknown",
      } };
    },
  };
}

async function diagnosticExists(path, directory = false) {
  try { const info = await stat(path); return directory ? info.isDirectory() : info.isFile(); }
  catch (error) { return error.code === "ENOENT" ? false : "unknown"; }
}
async function diagnosticJson(path) {
  let text;
  try { text = await readFile(path, "utf8"); }
  catch (error) { return { present: error.code === "ENOENT" ? false : "unknown" }; }
  try { return { present: true, value: JSON.parse(text) }; }
  catch { return { present: true }; }
}

export function assertNoSensitivePayload(body, forbidden) {
  const payload = JSON.stringify(body);
  for (const value of forbidden) {
    check(typeof value === "string" && value.length > 0, "SENSITIVE_FIXTURE_INVALID");
    check(!payload.includes(JSON.stringify(value).slice(1, -1)), "SENSITIVE_FIXTURE_IN_MEMORY_PAYLOAD");
  }
}

export async function createNativeHarness({ packageRoot, openCodeCommand, label = "native", writeback = true, expectedVersion, ripgrepCommand }) {
  check(!receivedSignal, "NATIVE_PROCESS_IS_STOPPING");
  const npmCache = process.env.MEMORAX_CODE_TEST_NPM_CACHE;
  check(npmCache === undefined || isAbsolute(npmCache), "NATIVE_TEST_NPM_CACHE_NOT_ABSOLUTE");
  packageRoot = resolve(packageRoot);
  openCodeCommand = resolve(openCodeCommand);
  const { resolveWindowsCliInvocation } = await import(pathToFileURL(join(packageRoot, "lib", "windows-cli-invocation.mjs")));
  const root = await mkdtemp(join(tmpdir(), `memorax-opencode-${label}-`));
  const home = join(root, "user home");
  const workspace = join(root, "project-alpha");
  const stateHome = join(home, ".memorax-code");
  const openCodeConfigDir = join(home, ".config", "opencode");
  const productEntrypoint = join(packageRoot, "bin", "memorax-code.mjs");
  const memoryEntrypoint = join(packageRoot, "bin", "memorax-cli.mjs");
  const modelRequests = [], memoryRequests = [], serverErrors = [];
  const children = new Set(), backendPids = new Set();
  const nativeServers = new Set();
  let modelHandler, nativeVersion, beforeClose, setupStarted = false, closePromise;
  let memoryServer, modelServer, backendPort, env, defaultServer;
  try {
    await Promise.all([workspace, stateHome, openCodeConfigDir, join(root, "tmp")]
      .map((path) => mkdir(path, { recursive: true })));
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
      check(request.method === "POST" && request.url === "/v1/chat/completions", "UNEXPECTED_MODEL_REQUEST");
      check(typeof modelHandler === "function", "MODEL_HANDLER_NOT_SET");
      response.nativeStream = body.stream === true;
      const result = await modelHandler(body, response, modelRequests.length);
      if (!response.writableEnded && result !== undefined) {
        sendChatCompletion(response, typeof result === "string" ? { text: result } : result);
      }
      check(response.writableEnded, "MODEL_HANDLER_DID_NOT_COMPLETE");
    }, serverErrors);
    backendPort = await freePort();
    env = isolatedEnv({ root, home, stateHome, openCodeConfigDir, openCodeCommand, backendPort,
      memoryUrl: memoryServer.url, writeback, npmCache });
    const rg = ripgrepCommand ? resolve(ripgrepCommand) : await findExecutable(process.platform === "win32" ? "rg.exe" : "rg");
    check(rg && await stat(rg).then((info) => info.isFile(), () => false), "NATIVE_RIPGREP_MISSING");
    env.PATH += `${delimiter}${dirname(rg)}`;
    if (process.platform === "win32") {
      const gitBash = join(process.env.ProgramFiles ?? "C:\\Program Files", "Git", "bin", "bash.exe");
      check(await stat(gitBash).then((info) => info.isFile(), () => false), "NATIVE_WINDOWS_GIT_BASH_MISSING");
      env.OPENCODE_GIT_BASH_PATH = gitBash;
      env.SHELL = gitBash;
      env.PATH += `${delimiter}${dirname(gitBash)}${delimiter}${resolve(dirname(gitBash), "../cmd")}`;
    } else {
      env.SHELL = "/bin/bash";
    }
    await writeFile(join(stateHome, "config.toml"), ["[clients]", "opencode = true",
      ...otherClients.map((client) => `${client} = false`), "[jev]", "enabled = false", ""].join("\n"), { mode: 0o600 });
    await writeFile(join(openCodeConfigDir, "opencode.json"), JSON.stringify({
      formatter: false, lsp: false, share: "disabled", autoupdate: false,
      model: `${fixtureProvider}/${fixtureModel}`, small_model: `${fixtureProvider}/${fixtureModel}`,
      enabled_providers: [fixtureProvider], permission: "allow",
      provider: { [fixtureProvider]: {
        name: "Local native fixture", id: fixtureProvider, env: [], npm: "@ai-sdk/openai-compatible",
        models: { [fixtureModel]: { id: fixtureModel, name: "Native fixture", attachment: false,
          reasoning: false, temperature: false, tool_call: true, release_date: "2026-01-01",
          limit: { context: 100_000, output: 10_000 }, cost: { input: 0, output: 0 } } },
        options: { apiKey: "native-model-fixture", baseURL: `${modelServer.url}/v1` },
      } },
    }, null, 2), { mode: 0o600 });
  } catch (error) {
    await Promise.all([memoryServer?.close(), modelServer?.close()]);
    await rm(root, { recursive: true, force: true });
    throw error;
  }

  function track(child) { children.add(child); child.once("exit", () => children.delete(child)); return child; }
  function spawnOpenCode(args, options = {}) {
    check(!closePromise && !receivedSignal, "NATIVE_HARNESS_IS_CLOSING");
    const childEnv = { ...env, ...options.env };
    const invocation = resolveWindowsCliInvocation(openCodeCommand, args, { env: childEnv });
    return track(spawn(invocation.command, invocation.args, { cwd: options.cwd ?? workspace, env: childEnv,
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" }));
  }
  async function run(command, args, options = {}) {
    check((!closePromise && !receivedSignal) || options.cleanup === true, "NATIVE_HARNESS_IS_CLOSING");
    const childEnv = { ...env, ...options.env };
    const invocation = resolveWindowsCliInvocation(command, args, { env: childEnv });
    const pending = execFileAsync(invocation.command, invocation.args, { cwd: options.cwd ?? workspace,
      env: childEnv, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
      windowsHide: true, detached: process.platform !== "win32" });
    track(pending.child);
    pending.child.stdin.on("error", () => {});
    pending.child.stdin.end(options.input ?? "");
    let timedOut = false, stopping;
    const timer = setTimeout(() => { timedOut = true; stopping = stopNativeProcessTree(pending.child, childEnv); },
      options.timeoutMs ?? options.timeout ?? 90_000);
    try { const result = await pending; check(!timedOut, "NATIVE_COMMAND_TIMEOUT"); return result; }
    catch (error) { stopping ??= stopNativeProcessTree(pending.child, childEnv); check(!timedOut, "NATIVE_COMMAND_TIMEOUT"); throw error; }
    finally { clearTimeout(timer); if (stopping) await stopping; }
  }
  const runProduct = (args, options) => run(process.execPath, [productEntrypoint, ...args], options);
  async function runOpenCode(promptOrArgs, options = {}) {
    const args = Array.isArray(promptOrArgs) ? promptOrArgs : ["run", "--format=json",
      ...(options.sessionId ? [`--session=${options.sessionId}`] : []),
      ...(options.server ? [`--attach=${options.server.url ?? options.server}`] : []), promptOrArgs];
    const result = await run(openCodeCommand, args, options);
    const events = result.stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    return { ...result, events, sessionId: events.find((event) => typeof event.sessionID === "string")?.sessionID,
      text: events.filter((event) => event.type === "text").map((event) => event.part?.text ?? "").join("\n").trim() };
  }
  async function setup() {
    nativeVersion = (await run(openCodeCommand, ["--version"])).stdout.trim();
    check(/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(nativeVersion), "NATIVE_OPENCODE_VERSION_INVALID");
    if (expectedVersion) check(nativeVersion === expectedVersion, "NATIVE_OPENCODE_VERSION_MISMATCH");
    setupStarted = true;
    await runProduct(["setup", "--existing-account", "--non-interactive"], { input: `${fixtureKey}\n` });
    const status = JSON.parse((await runProduct(["status", "--clients", "opencode", "--json"])).stdout);
    check(status.ok === true && status.backend?.ok === true && status.opencodeAdapter?.ok === true, "NATIVE_SETUP_NOT_READY");
    const pid = JSON.parse(await readFile(join(stateHome, "runtime", "backend", "backend.pid.json"), "utf8")).pid;
    check(Number.isInteger(pid) && pid > 0, "NATIVE_BACKEND_PID_INVALID");
    backendPids.add(pid);
    return status;
  }
  async function startOpenCodeServer(options = {}) {
    const port = await freePort();
    const child = spawnOpenCode(["serve", "--hostname=127.0.0.1", `--port=${port}`, "--print-logs", "--log-level=DEBUG"], options);
    child.stdin.end();
    const diagnostics = createServerInitializationDiagnostics({ configDir: openCodeConfigDir,
      stateDir: join(env.XDG_STATE_HOME, "opencode"), pid: child.pid, version: nativeVersion });
    child.stdout.on("data", diagnostics.stdout);
    child.stderr.on("data", diagnostics.stderr);
    const url = `http://127.0.0.1:${port}`;
    const headers = { authorization: `Basic ${Buffer.from(`${env.OPENCODE_SERVER_USERNAME}:${env.OPENCODE_SERVER_PASSWORD}`).toString("base64")}` };
    const server = { url, baseUrl: url, headers, process: child, cwd: options.cwd ?? workspace,
      diagnostics: diagnostics.snapshot,
      async close() {
        let operation = "NATIVE_SERVER_STOP";
        try {
          await stopNativeProcessTree(child, env);
          operation = "NATIVE_SERVER_PORT_RELEASE";
          await assertPortReleased(port);
          nativeServers.delete(server);
        } catch (error) { error.nativeOperation ??= operation; throw error; }
      },
      async request(path, requestOptions) { return sdkRequest(path, { ...requestOptions, server }); } };
    server.stop = server.close;
    nativeServers.add(server);
    defaultServer = server;
    await waitFor(async () => {
      check(child.exitCode === null && child.signalCode === null, "NATIVE_OPENCODE_SERVER_EXITED");
      if (!diagnostics.listeningSeen) return false;
      return fetch(`${url}/global/health`, { headers, signal: AbortSignal.timeout(1000) })
        .then((response) => response.ok, () => false);
    }, "NATIVE_OPENCODE_SERVER_START_TIMEOUT", 30_000);
    return server;
  }
  async function sdkRequest(path, options = {}) {
    const server = options.server ?? defaultServer;
    check(server, "NATIVE_OPENCODE_SERVER_MISSING");
    const url = new URL(path, server.url ?? server);
    check(url.hostname === "127.0.0.1" && url.protocol === "http:", "NATIVE_SDK_NOT_LOOPBACK");
    if (!url.searchParams.has("directory")) url.searchParams.set("directory", options.cwd ?? server.cwd ?? workspace);
    let operation = "SDK_REQUEST";
    try {
      const response = await fetch(url, { method: options.method ?? "GET",
        headers: { ...server.headers, ...(options.body === undefined ? {} : { "content-type": "application/json" }), ...options.headers },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 60_000) });
      if (options.raw) return response;
      check(response.ok, `NATIVE_SDK_HTTP_${response.status}`);
      operation = "SDK_RESPONSE_READ";
      const text = await response.text();
      operation = "SDK_RESPONSE_JSON";
      return text ? JSON.parse(text) : undefined;
    } catch (error) { error.nativeOperation ??= operation; throw error; }
  }
  function close() {
    return closePromise ??= closeResources();
  }
  async function closeResources() {
    let cleanupError;
    let cleanupStage = "BEFORE_CLOSE";
    try { await beforeClose?.(); }
    catch (error) {
      error.nativeCode ??= "NATIVE_BEFORE_CLOSE_FAILED";
      error.cleanupOperation ??= cleanupStage;
      cleanupError = error;
    }
    try {
      cleanupStage = "BACKEND_PID_READ";
      const current = await readFile(join(stateHome, "runtime", "backend", "backend.pid.json"), "utf8")
        .then(JSON.parse).catch((error) => { if (error.code === "ENOENT") return undefined; throw error; });
      if (Number.isInteger(current?.pid) && current.pid > 0) backendPids.add(current.pid);
      cleanupStage = "REPO_JOBS_READ";
      const jobFiles = await readdir(join(stateHome, "repo-memory-jobs"), { recursive: true }).catch((error) => {
        if (error.code === "ENOENT") return []; throw error;
      });
      for (const file of jobFiles.filter((file) => file.endsWith("job.json"))) {
        cleanupStage = "REPO_JOB_READ";
        const job = JSON.parse(await readFile(join(stateHome, "repo-memory-jobs", file), "utf8"));
        cleanupStage = "REPO_WORKER_STOP";
        for (const pid of [job.workerPid, job.childPid]) if (Number.isInteger(pid) && pid > 0 && processAlive(pid)) {
          await stopNativeProcessTree({ pid }, env);
        }
      }
      cleanupStage = "NATIVE_SERVER_STOP";
      await Promise.all([...nativeServers].map((server) => server.close()));
      cleanupStage = "CHILD_PROCESS_STOP";
      await Promise.all([...children].map((child) => stopNativeProcessTree(child, env)));
      if (setupStarted || backendPids.size) {
        cleanupStage = "BACKEND_PID_READ";
        const pidPath = join(stateHome, "runtime", "backend", "backend.pid.json");
        const current = await readFile(pidPath, "utf8").then(JSON.parse).catch((error) => {
          if (error.code === "ENOENT") return undefined; throw error;
        });
        if (Number.isInteger(current?.pid) && current.pid > 0) backendPids.add(current.pid);
        cleanupStage = "BACKEND_STOP";
        const stopped = JSON.parse((await runProduct(["stop", "--clients", "opencode", "--json"],
          { timeoutMs: 15_000, cleanup: true })).stdout);
        check(stopped.ok === true, "NATIVE_BACKEND_STOP_FAILED");
        cleanupStage = "BACKEND_PROCESS_EXIT";
        for (const pid of backendPids) check(!processAlive(pid), "NATIVE_BACKEND_PROCESS_REMAINS");
        cleanupStage = "BACKEND_RECORD_REMOVAL";
        check(await stat(pidPath).then(() => false, (error) => error.code === "ENOENT"), "NATIVE_BACKEND_RECORD_REMAINS");
        cleanupStage = "BACKEND_PORT_RELEASE";
        await assertPortReleased(backendPort);
      }
    } catch (error) {
      error.nativeCode ??= `NATIVE_CLEANUP_${cleanupStage}_FAILED`;
      error.cleanupOperation ??= cleanupStage;
      cleanupError ??= error;
      for (const child of children) {
        try { await stopNativeProcessTree(child, env); } catch (failure) { cleanupError ??= failure; }
      }
      for (const server of nativeServers) {
        try { await server.close(); } catch (failure) { cleanupError ??= failure; }
      }
      for (const pid of backendPids) {
        try { if (processAlive(pid)) await stopNativeProcessTree({ pid }, env); }
        catch (failure) { cleanupError ??= failure; }
      }
    } finally {
      try {
        cleanupStage = "RECEIVERS";
        await Promise.all([memoryServer.close(), modelServer.close()]);
        cleanupStage = "TEMPORARY_STATE";
        if (!cleanupError) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch (error) {
        error.nativeCode ??= `NATIVE_CLEANUP_${cleanupStage}_FAILED`;
        error.cleanupOperation ??= cleanupStage;
        cleanupError ??= error;
      }
      unregisterSignalCleanup();
    }
    if (cleanupError) throw cleanupError;
  }
  const unregisterSignalCleanup = registerSignalCleanup(close);
  return { root, home, workspace, stateHome, openCodeConfigDir, env, packageRoot, openCodeCommand,
    get openCodeVersion() { return nativeVersion; }, memoryEntrypoint, productEntrypoint,
    modelUrl: `${modelServer.url}/v1`, memoryUrl: memoryServer.url,
    modelRequests, memoryRequests, serverErrors, setup, close, spawnOpenCode, runProduct, runOpenCode,
    startOpenCodeServer, sdkRequest, runCommand: run,
    runMemory: (args, options) => run(process.execPath, [memoryEntrypoint, ...args], options),
    setBeforeClose(handler) {
      check(!closePromise && typeof handler === "function", "NATIVE_CLEANUP_HANDLER_INVALID");
      beforeClose = handler;
    },
    setModelHandler(handler) { modelHandler = handler; } };
}
export { createNativeHarness as createOpenCodeHarness };

function registerSignalCleanup(close) {
  if (!signalCleanups.size) for (const [signal, handler] of signalHandlers) process.on(signal, handler);
  signalCleanups.add(close);
  return () => {
    signalCleanups.delete(close);
    if (!signalCleanups.size && !receivedSignal) {
      for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    }
  };
}
function handleSignal(signal) {
  if (receivedSignal) return;
  receivedSignal = signal;
  const exitCode = signal === "SIGINT" ? 130 : 143;
  const timeout = setTimeout(() => {
    console.error(JSON.stringify({ status: "FAIL", signal, cleanup: "NATIVE_SIGNAL_CLEANUP_TIMEOUT" }));
    process.exit(exitCode);
  }, 60_000);
  void Promise.allSettled([...signalCleanups].map((close) => close())).then((results) => {
    clearTimeout(timeout);
    const failure = results.find((result) => result.status === "rejected");
    console.error(JSON.stringify({ status: "FAIL", signal,
      cleanup: failure ? failure.reason?.nativeCode ?? "NATIVE_SIGNAL_CLEANUP_FAILED" : "PASS",
      ...(failure ? { cleanupErrorDetails: describeSafeError(failure.reason) } : {}) }));
    for (const [name, handler] of signalHandlers) process.off(name, handler);
    process.exit(exitCode);
  });
}

let responseSequence = 0;
export function sendChatCompletion(response, { text, toolCalls = [], reasoning } = {}) {
  const id = `native-chat-${++responseSequence}`;
  if (response.nativeStream === false) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id, object: "chat.completion", model: fixtureModel, created: Math.floor(Date.now() / 1000),
      choices: [{ index: 0, message: { role: "assistant", content: text ?? "", ...(toolCalls.length ? {
        tool_calls: toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name,
          arguments: typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments) } })),
      } : {}) }, finish_reason: toolCalls.length ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const deltas = [{ role: "assistant" }];
  if (reasoning) deltas.push({ reasoning_content: reasoning });
  if (text !== undefined) deltas.push({ content: text });
  if (toolCalls.length) deltas.push({ tool_calls: toolCalls.map((call, index) => ({ index, id: call.id,
    type: "function", function: { name: call.name, arguments: typeof call.arguments === "string"
      ? call.arguments : JSON.stringify(call.arguments) } })) });
  for (const delta of deltas) response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk",
    choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", choices: [{ index: 0, delta: {},
    finish_reason: toolCalls.length ? "tool_calls" : "stop" }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } })}\n\n`);
  response.end("data: [DONE]\n\n");
}

export async function waitFor(predicate, code = "NATIVE_WAIT_TIMEOUT", timeout = 15_000) {
  const deadline = Date.now() + timeout;
  do { const result = await predicate(); if (result) return result;
    await new Promise((done) => setTimeout(done, 50)); } while (Date.now() < deadline);
  check(false, code);
}
export function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error.code === "ESRCH") return false;
    error.nativeOperation ??= "PROCESS_ALIVE";
    throw error;
  }
}
export async function stopNativeProcessTree(child, env) {
  if (!child.pid) return;
  let operation = "TASKKILL";
  try {
    if (process.platform === "win32") {
      if (child.exitCode != null || child.signalCode != null) return;
      if (!processAlive(child.pid)) return;
      await execFileAsync(join(env.SystemRoot, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"],
        { env, windowsHide: true, timeout: 10_000 }).catch((error) => { if (processAlive(child.pid)) throw error; });
    } else {
      operation = "PROCESS_SIGNAL";
      try { process.kill(-child.pid, "SIGKILL"); } catch (error) {
        if (error.code !== "ESRCH") throw error;
        if (processAlive(child.pid)) process.kill(child.pid, "SIGKILL");
      }
    }
    operation = "PROCESS_EXIT";
    await waitFor(() => !processAlive(child.pid), "NATIVE_CHILD_PROCESS_REMAINS", 10_000);
  } catch (error) { error.nativeOperation ??= operation; throw error; }
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
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}
async function assertPortReleased(port) {
  const probe = createTcpServer();
  await new Promise((done, reject) => { probe.once("error", reject); probe.listen(port, "127.0.0.1", done); });
  await new Promise((done) => probe.close(done));
}
async function findExecutable(name) {
  for (const entry of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(entry, name);
    if (await stat(candidate).then((info) => info.isFile(), () => false)) return candidate;
  }
  return undefined;
}
function isolatedEnv({ root, home, stateHome, openCodeConfigDir, openCodeCommand, backendPort, memoryUrl, writeback, npmCache }) {
  const windowsRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
  const systemPaths = process.platform === "win32" ? [join(windowsRoot, "System32"), windowsRoot,
    join(windowsRoot, "System32", "Wbem"), join(windowsRoot, "System32", "WindowsPowerShell", "v1.0")]
    : ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const env = {
    HOME: home, USERPROFILE: home, USER: "native-fixture", LOGNAME: "native-fixture", LANG: "en_US.UTF-8",
    PATH: [dirname(process.execPath), dirname(openCodeCommand), ...systemPaths].join(delimiter),
    APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
    TMPDIR: join(root, "tmp"), TMP: join(root, "tmp"), TEMP: join(root, "tmp"),
    npm_config_cache: npmCache ?? join(root, "npm-cache"),
    XDG_CONFIG_HOME: join(home, ".config"), XDG_DATA_HOME: join(home, ".local", "share"),
    XDG_STATE_HOME: join(home, ".local", "state"), XDG_CACHE_HOME: join(home, ".cache"),
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(home, "missing-git-config"), GIT_TERMINAL_PROMPT: "0",
    OPENCODE_CONFIG_DIR: openCodeConfigDir, MEMORAX_CODE_OPENCODE_COMMAND: openCodeCommand,
    OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_DISABLE_SHARE: "1", OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_CLAUDE_CODE: "1",
    OPENCODE_SERVER_USERNAME: "native-fixture", OPENCODE_SERVER_PASSWORD: "native-server-fixture",
    MEMORAX_CODE_HOME: stateHome, MEMORAX_CODE_AUTO_UPDATE: "false", MEMORAX_CODE_INSTALL_WATCHDOG: "0",
    MEMORAX_CODE_BACKEND_HOST: "127.0.0.1", MEMORAX_CODE_BACKEND_PORT: String(backendPort),
    MEMORAX_CODE_MEMORAX_ENDPOINT: memoryUrl, MEMORAX_CODE_MEMORAX_API_KEY: fixtureKey,
    MEMORAX_CODE_MEMORAX_USER_ID: fixtureUser, MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: String(writeback),
    MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false", MEMORAX_CODE_MEMORY_WRITEBACK_CHUNK_ENABLED: "false",
    MEMORAX_CODE_JEV_ENABLED: "false", MEMORAX_CODE_OPENCODE_TRACE_ENABLED: "true",
    MEMORAX_CODE_SKIP_CODEX_PLUGIN_INSTALL: "1",
    CODEX_HOME: join(home, ".codex"), DSH_HOME: join(home, ".dsh"), CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CLAUDE_HOME: join(home, ".claude"), CODEBUDDY_HOME: join(home, ".codebuddy"),
    CODEBUDDY_CONFIG_DIR: join(home, ".codebuddy"), WORKBUDDY_HOME: join(home, ".workbuddy"),
    WORKBUDDY_CONFIG_DIR: join(home, ".workbuddy"), TRAE_HOME: join(home, ".trae-cn"), TRAE_CN_HOME: join(home, ".trae-cn"),
    CURSOR_HOME: join(home, ".cursor"),
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
