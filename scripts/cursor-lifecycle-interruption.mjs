import { chmod, readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";
import { assertCredentialNotEchoed } from "./codex-lifecycle-assertions.mjs";
import { trackLifecycleTerminal } from "./claude-lifecycle-process.mjs";

export const cursorInterruptionPhases = ["after-config-write", "before-backend-start", "after-backend-start", "saved-account-key-cancel"];

export function startCursorSetupInterruption({ phase, packageRoot, ptyRoot, workspace, env, key, verifyPreserved }) {
  let terminal, server, heldLock, releaseLock, cancelled = false, cleanupPromise;
  const dependencies = new Set(), responses = new Set();
  const stateHome = env.MEMORAX_CODE_HOME, entrypoint = join(packageRoot, "bin/memorax-code.mjs");
  const configPath = join(stateHome, "config.toml"), completionPath = join(stateHome, "runtime/setup/setup-completion.json");
  const pidPath = join(stateHome, "runtime/backend/backend.pid.json");
  const result = run();
  return { result, async stop() {
    cancelled = true;
    if (terminal) await terminal.stop();
    try { await result; } catch (error) { if (error.cleanupFailed) throw error; }
  } };

  async function run() {
    try {
      check(cursorInterruptionPhases.includes(phase), "PHASE_INVALID");
      const initialConfig = await readFile(configPath, "utf8");
      const require = createRequire(join(ptyRoot, "package.json"));
      check(require("node-pty/package.json").version === "1.1.0", "PTY_VERSION");
      if (process.platform === "darwin") {
        const helper = join(dirname(require.resolve("node-pty/package.json")), "prebuilds", `darwin-${process.arch}`, "spawn-helper");
        const info = await stat(helper);
        check(info.isFile(), "PTY_HELPER_INVALID");
        if (!(info.mode & 0o100)) await chmod(helper, info.mode | 0o100);
      }
      let reached;
      const gateReached = new Promise((done) => { reached = done; });
      server = createServer((request, response) => {
        void (async () => {
          let raw = "";
          for await (const chunk of request) { raw += chunk; check(Buffer.byteLength(raw) < 32768, "GATE_REQUEST_SIZE"); }
          const call = JSON.parse(raw);
          check(request.method === "POST" && request.url === "/" && Number.isSafeInteger(call.pid) && call.pid > 1
            && Array.isArray(call.args) && call.args.every((arg) => typeof arg === "string")
            && ["start", "status"].includes(call.args[0]), "GATE_REQUEST_INVALID");
          const backend = await readJsonIfPresent(pidPath);
          let gated = phase === "after-config-write" && call.args[0] === "start" && backend === undefined;
          if (phase === "after-backend-start" && call.args[0] === "status" && backend) {
            check(backend.url === `http://127.0.0.1:${env.MEMORAX_CODE_BACKEND_PORT}`
              && Number.isSafeInteger(backend.pid) && backend.pid > 1 && typeof backend.instanceId === "string",
            "BACKEND_RECORD_INVALID");
            const health = await fetch(new URL("/health", backend.url), { signal: AbortSignal.timeout(5000) });
            const body = await health.json();
            gated = health.ok && body.ok === true && body.instanceId === backend.instanceId;
          }
          if (gated && !cancelled && !cleanupPromise) {
            dependencies.add(call.pid); responses.add(response);
            reached({ kind: "test-preload-pauses-real-installed-cli-child", command: call.args[0],
              backendHealthy: phase === "after-backend-start" });
          } else response.writeHead(cancelled ? 503 : 200).end();
        })().catch(() => { if (!response.destroyed) response.writeHead(500).end(); });
      });
      await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
      if (phase === "before-backend-start") {
        const { withBackendLifecycleLock } = await import(pathToFileURL(join(packageRoot, "lib/memorax-code-backend/dist/lifecycle/lock.js")));
        let lockReady;
        const ready = new Promise((done) => { lockReady = done; });
        const release = new Promise((done) => { releaseLock = done; });
        heldLock = withBackendLifecycleLock({ home: stateHome }, () => { lockReady(); return release; });
        await deadline(Promise.race([ready, heldLock]), 10000, "LOCK_NOT_ACQUIRED");
      }
      check(!cancelled, "CANCELLED");
      const terminalEnv = { ...env, TERM: "xterm-256color",
        NODE_OPTIONS: `--import=${pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "cursor-lifecycle-interruption-driver.mjs")).href}`,
        MEMORAX_TEST_CURSOR_GATE_URL: `http://127.0.0.1:${server.address().port}`,
        MEMORAX_TEST_GATED_ENTRYPOINT: entrypoint };
      delete terminalEnv.MEMORAX_CODE_SETUP_ASSUME_INTERACTIVE;
      terminal = startCursorInterruptionTerminal({ pty: require("node-pty"), entrypoint, workspace, env: terminalEnv,
        cancelCase: phase === "saved-account-key-cancel", onStage(event) {
          if (phase === "before-backend-start" && event === "starting-backend") {
            reached({ kind: "held-native-lifecycle-lock", backendHealthy: false });
          }
          if (phase === "saved-account-key-cancel" && event === "key-prompt") {
            reached({ kind: "native-masked-key-prompt", backendHealthy: false });
          }
        } });
      const evidence = await deadline(Promise.race([gateReached, terminal.exited.then(() => { throw failure("EARLY_EXIT"); })]),
        110000, "STAGE_NOT_REACHED");
      terminal.verify();
      check(!cancelled, "CANCELLED");
      check(await readJsonIfPresent(completionPath) === undefined, "COMPLETED_BEFORE_INTERRUPTION");
      await verifyPreserved();
      if (phase !== "after-backend-start") check(await readJsonIfPresent(pidPath) === undefined, "BACKEND_STARTED_EARLY");
      if (phase === "after-config-write") check(await readFile(configPath, "utf8") !== initialConfig, "CONFIG_NOT_PUBLISHED");
      if (phase === "saved-account-key-cancel") terminal.child.write("\x03");
      else await terminal.stop();
      const exit = await deadline(terminal.exited, 15000, "SETUP_DID_NOT_EXIT");
      terminal.verify();
      check(exit.exitCode !== 0 || exit.signal > 0, "INTERRUPTED_SETUP_SUCCEEDED");
      assertCredentialNotEchoed(terminal.output(), key);
      await cleanup();
      check(!cancelled, "CANCELLED");
      check(await readJsonIfPresent(completionPath) === undefined, "COMPLETION_REMAINS");
      await verifyPreserved();
      return { stageReached: true, stageEvidence: evidence, completionAbsentAfterInterruption: true,
        interruptedSetupFailed: true, setupProcessesStopped: true };
    } finally { await cleanup(); }
  }
  function cleanup() { return cleanupPromise ??= clean(); }
  async function clean() {
    let error;
    const attempt = async (operation) => { try { await operation(); } catch (cause) { error ??= cause; } };
    await attempt(async () => { if (terminal) await terminal.stop(); });
    for (const response of responses) if (!response.destroyed && !response.writableEnded) response.writeHead(503).end();
    responses.clear();
    releaseLock?.();
    await attempt(async () => { if (heldLock) await deadline(heldLock, 10000, "LOCK_RELEASE_TIMEOUT"); });
    await attempt(async () => {
      if (server?.listening) {
        server.closeAllConnections();
        await deadline(new Promise((done) => server.close(done)), 5000, "GATE_CLOSE_TIMEOUT");
      }
    });
    await attempt(async () => {
      const end = Date.now() + 10000;
      while ([...dependencies].some(alive)) {
        check(Date.now() < end, "DEPENDENCY_REMAINS");
        await new Promise((done) => setTimeout(done, 25));
      }
    });
    if (error) { error.cleanupFailed = true; throw error; }
  }
}

export function startCursorInterruptionTerminal({ pty, entrypoint, workspace, env, cancelCase, onStage }) {
  const child = pty.spawn(process.execPath, [entrypoint, "setup", ...(cancelCase ? ["--existing-account"] : [])],
    { name: "xterm-256color", cols: 120, rows: 40, cwd: workspace, env });
  let output = "", bytes = 0, terminalError, answered = false, keySeen = false, startSeen = false, queriesAnswered = 0;
  const terminal = { ...trackLifecycleTerminal(child, env), output: () => output,
    verify() { if (terminalError) throw terminalError; } };
  child.onData((chunk) => {
    try {
      if (terminalError) return;
      bytes += Buffer.byteLength(chunk);
      check(bytes <= 2 * 1024 * 1024, "TERMINAL_OUTPUT_LIMIT");
      output += chunk;
      const queries = output.split("\x1b[6n").length - 1;
      while (queriesAnswered < queries && queriesAnswered < 16) { queriesAnswered++; child.write("\x1b[1;1R"); }
      const visible = stripVTControlCharacters(output), username = /Username[^\r\n]*:/.test(visible);
      const keyPrompt = visible.includes("MemoraX API key:");
      check(cancelCase || !(username || keyPrompt || visible.includes("Preferred language [ZH/en]")
        || visible.includes("Connect MemoraX Code to MemoraX now")
        || visible.includes("Use the saved connection and memory preferences")), "SAVED_ACCOUNT_INPUT_REQUESTED");
      if (cancelCase && username && !answered) { answered = true; child.write("\r"); }
      if (cancelCase && keyPrompt && !keySeen) { keySeen = true; onStage("key-prompt"); }
      if (!startSeen && visible.includes("Starting backend with `memorax-code start`")) {
        startSeen = true; onStage("starting-backend");
      }
    } catch (error) {
      terminalError ??= error;
      void terminal.stop().catch((cleanupError) => { terminalError = cleanupError; });
    }
  });
  return terminal;
}

function failure(suffix) { const code = `CURSOR_LIFECYCLE_INTERRUPTION_${suffix}`; return Object.assign(new Error(code), { testCode: code }); }
function check(value, suffix) { if (!value) throw failure(suffix); }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } }
async function readJsonIfPresent(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}
async function deadline(promise, ms, suffix) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(failure(suffix)), ms); })]); }
  finally { clearTimeout(timer); }
}
