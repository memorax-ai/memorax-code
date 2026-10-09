import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join, parse, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { check, createNativeHarness, describeSafeError } from "./opencode-native-support.mjs";
import { createInitializationLayoutPlan } from "./opencode-initialization-layouts.mjs";

// This function is evaluated inside the unmodified native client's inspector.
export function installNpmTimingObserver() {
  const allowed = new Set([
    "reify", "reify:loadTrees", "reify:diffTrees", "reify:retireShallow", "reify:createSparse",
    "reify:loadShrinkwraps", "reify:loadBundles", "reify:audit", "reify:unpack", "reify:unretire",
    "reify:build", "reify:trash", "reify:save", "reify:rollback:retireShallow", "reify:rollback:createSparse",
    "idealTree", "idealTree:init", "idealTree:userRequests", "idealTree:inflate", "idealTree:buildDeps",
    "idealTree:fixDepFlags", "build", "build:deps", "build:links", "build:queue", "build:link",
  ]);
  const packages = new Map([
    ["node_modules/@opencode-ai/plugin", "package:opencode-plugin"],
    ["node_modules/@opencode-ai/sdk", "package:opencode-sdk"],
    ["node_modules/@ai-sdk/provider", "package:ai-sdk-provider"],
    ["node_modules/@standard-schema/spec", "package:standard-schema-spec"],
    ["node_modules/@msgpackr-extract/msgpackr-extract-win32-x64", "package:msgpackr-extract-win32-x64"],
    ...["zod", "effect", "ini", "toml", "uuid", "yaml", "msgpackr", "msgpackr-extract", "fast-check",
      "pure-rand", "multipasta", "find-my-way-ts", "kubernetes-types", "json-schema", "cross-spawn",
      "which", "path-key", "shebang-command", "shebang-regex", "isexe", "node-gyp-build-optional-packages",
      "detect-libc"].map((name) => [`node_modules/${name}`, `package:${name}`]),
  ]);
  const phases = new Map();
  const logCounts = Object.fromEntries(["error", "notice", "warn", "info", "verbose", "http", "silly", "timing"]
    .map((level) => [level, 0]));
  const observedAt = performance.now();
  const effectTarball = "https://registry\\.npmjs\\.org/effect/-/effect-4\\.0\\.0-beta\\.83\\.tgz";
  // Registry success logs follow body end; pacote's cache log only opens the stream.
  const registryFetch = new RegExp(`^GET ([23][0-9]{2}) ${effectTarball} ([0-9]+)ms(?: attempt #[0-9]+)?(?: \\(cache (hit|miss|stale|revalidated|updated|skip)\\))?$`);
  const registryCache = new RegExp(`^${effectTarball} ([0-9]+)ms(?: attempt #[0-9]+)? \\(cache hit\\)$`);
  const pacoteCache = new RegExp(`^effect@(?:${effectTarball}|4\\.0\\.0-beta\\.83) ([0-9]+)ms \\(cache hit\\)$`);
  const effectHttp = {
    registryBodyEnd: { count: 0, lastStatus: null, lastCacheStatus: null, lastDurationMs: null, lastObservedAfterMs: null },
    pacoteCacheStreamStart: { count: 0, lastDurationMs: null, lastObservedAfterMs: null },
  };
  process.on("time", (action, name) => {
    let phase = allowed.has(name) ? name : undefined;
    if (!phase && typeof name === "string" && name.startsWith("reifyNode:")) {
      const location = name.slice("reifyNode:".length).replaceAll("\\", "/");
      for (const [suffix, label] of packages) if (location === suffix || location.endsWith(`/${suffix}`)) phase = label;
    }
    if (!phase || (action !== "start" && action !== "end")) return;
    const state = phases.get(phase) ?? { started: 0, completed: 0, active: 0, overlapping: false,
      startedAt: 0, completedDurationMs: 0, lastDurationMs: null, unmatchedEnds: 0 };
    phases.set(phase, state);
    const now = performance.now();
    if (action === "start") {
      if (state.active) state.overlapping = true; else state.startedAt = now;
      state.started++; state.active++;
    } else if (state.active) {
      state.completed++; state.active--;
      if (!state.active) {
        state.lastDurationMs = Math.max(0, Math.round(now - state.startedAt));
        state.completedDurationMs += state.lastDurationMs;
      }
    } else state.unmatchedEnds++;
  });
  process.on("log", (level, scope, message) => {
    if (typeof level === "string" && Object.hasOwn(logCounts, level)) logCounts[level]++;
    if (level !== "http" || typeof message !== "string" || message.length > 512) return;
    const fetchMatch = scope === "fetch" && registryFetch.exec(message);
    const cacheMatch = scope === "cache" && registryCache.exec(message);
    const pacoteMatch = scope === "cache" && pacoteCache.exec(message);
    const duration = fetchMatch ? Number(fetchMatch[2]) : Number((cacheMatch || pacoteMatch)?.[1]);
    if (!Number.isSafeInteger(duration) || duration < 0) return;
    const state = pacoteMatch ? effectHttp.pacoteCacheStreamStart : effectHttp.registryBodyEnd;
    state.count++;
    state.lastDurationMs = duration;
    state.lastObservedAfterMs = Math.max(0, Math.round(performance.now() - observedAt));
    if (!pacoteMatch) {
      state.lastStatus = fetchMatch ? Number(fetchMatch[1]) : null;
      state.lastCacheStatus = fetchMatch ? fetchMatch[3] ?? "none" : "hit";
    }
  });
  globalThis.__memoraxNpmInitializationDiagnostic = () => ({
    phases: [...phases].map(([phase, state]) => ({ phase, started: state.started, completed: state.completed,
      active: state.active, overlapping: state.overlapping, unmatchedEnds: state.unmatchedEnds,
      activeDurationMs: state.active ? Math.max(0, Math.round(performance.now() - state.startedAt)) : null,
      completedDurationMs: state.overlapping ? null : state.completedDurationMs,
      lastDurationMs: state.overlapping ? null : state.lastDurationMs })),
    logCounts: { ...logCounts }, effectHttp: { registryBodyEnd: { ...effectHttp.registryBodyEnd },
      pacoteCacheStreamStart: { ...effectHttp.pacoteCacheStreamStart } },
    noopPluginInvoked: globalThis.__memoraxNoopPluginInvoked === true,
  });
  return true;
}

export function assertInitializationComplete(result) {
  const phases = result?.npmTiming?.phases;
  const milestones = result?.nativeServerInitialization?.milestones;
  const dependencies = result?.nativeServerInitialization?.dependencies;
  check(result?.npmTiming?.noopPluginInvoked === true && Array.isArray(phases)
    && ["reify", "reify:unpack", "package:effect"].every((name) => {
      const matches = phases.filter((phase) => phase?.phase === name);
      return matches.length === 1 && matches[0].started === 1 && matches[0].completed === 1 && matches[0].active === 0;
    }) && milestones?.postPluginReached === true && milestones?.dependencyInstallFailed === false
    && dependencies?.packageJson === true && dependencies?.nodeModules === true
    && dependencies?.pluginPackage === true && dependencies?.packageLock === true && dependencies?.npmInstallLock === false
    && result?.dependencyVersionsMatch?.plugin === true && result?.dependencyVersionsMatch?.effect === true,
  "INIT_DIAG_DEPENDENCY_INSTALL_INCOMPLETE");
}

export async function connectDiagnosticInspector(url) {
  check(typeof WebSocket === "function", "INIT_DIAG_NATIVE_WEBSOCKET_UNAVAILABLE");
  const parsed = new URL(url);
  check(parsed.protocol === "ws:" && parsed.hostname === "127.0.0.1", "INIT_DIAG_INSPECTOR_NOT_LOOPBACK");
  const socket = new WebSocket(url);
  const pending = new Map();
  let sequence = 0;
  const failPending = () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(Object.assign(new Error("INIT_DIAG_INSPECTOR_CLOSED"), { nativeCode: "INIT_DIAG_INSPECTOR_CLOSED" }));
    }
    pending.clear();
  };
  socket.addEventListener("close", failPending);
  socket.addEventListener("error", failPending);
  socket.addEventListener("message", (event) => {
    let packet;
    try { packet = JSON.parse(String(event.data)); } catch { return; }
    const entry = pending.get(packet.id);
    if (!entry) return;
    pending.delete(packet.id); clearTimeout(entry.timer);
    if (packet.error || packet.result?.wasThrown) {
      entry.reject(Object.assign(new Error("INIT_DIAG_EVALUATION_FAILED"), { nativeCode: "INIT_DIAG_EVALUATION_FAILED" }));
    } else entry.resolve(packet.result?.result?.value);
  });
  try {
    await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(Object.assign(new Error("INIT_DIAG_INSPECTOR_CONNECT_TIMEOUT"),
        { nativeCode: "INIT_DIAG_INSPECTOR_CONNECT_TIMEOUT" })), 5000);
      socket.addEventListener("open", () => { clearTimeout(timer); done(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer);
        reject(Object.assign(new Error("INIT_DIAG_INSPECTOR_CONNECT_FAILED"), { nativeCode: "INIT_DIAG_INSPECTOR_CONNECT_FAILED" }));
      }, { once: true });
    });
  } catch (error) { socket.close(); throw error; }
  return {
    evaluate(expression) {
      return new Promise((done, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(Object.assign(new Error("INIT_DIAG_INSPECTOR_REQUEST_TIMEOUT"), { nativeCode: "INIT_DIAG_INSPECTOR_REQUEST_TIMEOUT" }));
        }, 5000);
        pending.set(id, { resolve: done, reject, timer });
        try { socket.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } })); }
        catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    },
    async close() {
      if (socket.readyState === WebSocket.CLOSED) return;
      await new Promise((done, reject) => {
        const timer = setTimeout(() => reject(Object.assign(new Error("INIT_DIAG_INSPECTOR_CLOSE_TIMEOUT"),
          { nativeCode: "INIT_DIAG_INSPECTOR_CLOSE_TIMEOUT" })), 5000);
        socket.addEventListener("close", () => { clearTimeout(timer); done(); }, { once: true });
        socket.close();
      });
    },
  };
}

async function freePort() {
  const server = createServer();
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const port = server.address().port;
  await new Promise((done) => server.close(done));
  return port;
}

async function runTrial(packageRoot, openCodeCommand, layout, round, offline) {
  const result = { layout: layout.id, round, offline, kind: "noop", status: "FAIL",
    stage: "harness creation", sessionCreated: false };
  let harness, server, inspector;
  try {
    await mkdir(layout.tempDirectory, { recursive: true });
    const tempEnvironment = Object.fromEntries(["TEMP", "TMP", "TMPDIR"].map((key) => [key, process.env[key]]));
    try {
      for (const key of Object.keys(tempEnvironment)) process.env[key] = layout.tempDirectory;
      harness = await createNativeHarness({ packageRoot, openCodeCommand, label: "server" });
    } finally {
      for (const [key, value] of Object.entries(tempEnvironment)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
    check(harness.openCodeConfigDir.startsWith(`${layout.tempDirectory}${sep}`), "INIT_DIAG_TEMP_LAYOUT_NOT_APPLIED");
    result.configDirectoryCharacters = harness.openCodeConfigDir.length;
    result.stage = "plugin setup";
    const version = (await harness.runCommand(openCodeCommand, ["--version"])).stdout.trim();
    check(version === "1.18.18", "INIT_DIAG_VERSION_INVALID");
    result.openCodeVersion = version;
    await mkdir(join(harness.openCodeConfigDir, "plugins"), { recursive: true });
    await writeFile(join(harness.openCodeConfigDir, "plugins", "fixture.js"),
      "export default async () => { globalThis.__memoraxNoopPluginInvoked = true; return {}; };\n", { mode: 0o600 });
    result.stage = "native server startup";
    const inspectorAddress = `127.0.0.1:${await freePort()}/memorax-diag`;
    server = await harness.startOpenCodeServer({ env: { BUN_INSPECT: inspectorAddress,
      npm_config_offline: String(offline) } });
    result.stage = "inspector attachment";
    inspector = await connectDiagnosticInspector(`ws://${inspectorAddress}`);
    result.stage = "npm observer installation";
    check(await inspector.evaluate(`(${installNpmTimingObserver.toString()})()`) === true, "INIT_DIAG_OBSERVER_NOT_INSTALLED");
    result.stage = "native parent session creation";
    const started = performance.now();
    try {
      const parent = await server.request("/session", { method: "POST", body: { title: "Initialization diagnostic" } });
      check(typeof parent?.id === "string" && parent.id.length > 0, "INIT_DIAG_SESSION_ID_MISSING");
      result.sessionCreated = true;
    } finally { result.sessionRequestMs = Math.round(performance.now() - started); }
    result.status = "PASS";
  } catch (error) {
    result.error = error.nativeCode ?? "INIT_DIAG_PRIVATE_ERROR_SUPPRESSED";
    result.errorDetails = describeSafeError(error);
  } finally {
    if (inspector) {
      try {
        result.npmTiming = await inspector.evaluate("globalThis.__memoraxNpmInitializationDiagnostic?.()");
        check(result.npmTiming && Array.isArray(result.npmTiming.phases), "INIT_DIAG_SNAPSHOT_MISSING");
        if (result.sessionCreated) {
          check(result.npmTiming.noopPluginInvoked === true, "INIT_DIAG_NOOP_PLUGIN_NOT_LOADED");
        }
      } catch (error) {
        result.status = "FAIL";
        result.diagnosticError = error.nativeCode ?? "INIT_DIAG_PRIVATE_ERROR_SUPPRESSED";
        result.diagnosticErrorDetails = describeSafeError(error);
      }
    }
    if (server) {
      try {
        result.nativeServerInitialization = await server.diagnostics();
        result.dependencyVersionsMatch = {};
        for (const [label, name, version] of [["plugin", "@opencode-ai/plugin", "1.18.18"], ["effect", "effect", "4.0.0-beta.83"]]) {
          result.dependencyVersionsMatch[label] = await readFile(join(harness.openCodeConfigDir, "node_modules", name, "package.json"), "utf8")
            .then(JSON.parse).then((pkg) => pkg.version === version).catch(() => false);
        }
        if (result.sessionCreated) {
          assertInitializationComplete(result);
          result.installationComplete = true;
        }
      }
      catch (error) {
        result.status = "FAIL";
        result.stateDiagnosticError = error.nativeCode ?? "INIT_DIAG_STATE_SNAPSHOT_FAILED";
        result.stateDiagnosticErrorDetails = describeSafeError(error);
      }
    }
    if (harness) {
      result.modelRequests = harness.modelRequests.length;
      result.memoryRequests = harness.memoryRequests.length;
      result.receiverErrors = [...harness.serverErrors];
    }
    result.cleanup = "PASS";
    for (const [operation, resource] of [["inspector", inspector], ["harness", harness]]) {
      try { await resource?.close(); }
      catch (error) {
        result.status = "FAIL"; result.cleanup = "FAIL";
        (result.cleanupErrors ??= []).push({ operation, error: error.nativeCode ?? "INIT_DIAG_PRIVATE_CLEANUP_ERROR_SUPPRESSED",
          details: describeSafeError(error) });
      }
    }
  }
  return result;
}

async function main() {
  const report = { status: "FAIL", suite: "native_opencode_initialization_diagnostic", platform: process.platform, trials: [] };
  const ownedRoots = [];
  let retainRoots = false;
  try {
    check(process.argv.length === 6, "INIT_DIAG_EXPECTED_PACKAGE_OPENCODE_AND_TEMP_PATHS");
    check(process.platform === "win32", "INIT_DIAG_REQUIRES_WINDOWS");
    check(typeof WebSocket === "function", "INIT_DIAG_NATIVE_WEBSOCKET_UNAVAILABLE");
    check(Boolean(process.env.MEMORAX_CODE_TEST_NPM_CACHE), "INIT_DIAG_SHARED_CACHE_REQUIRED");
    const packageRoot = resolve(process.argv[2]), openCodeCommand = resolve(process.argv[3]);
    for (const base of process.argv.slice(4)) ownedRoots.push(await mkdtemp(join(resolve(base), "mx-init-")));
    const { layouts, rounds } = createInitializationLayoutPlan(...ownedRoots);
    report.locationsShareVolume = parse(ownedRoots[0]).root.toLowerCase() === parse(ownedRoots[1]).root.toLowerCase();
    report.layouts = layouts.map(({ id, tempDirectory }) => ({ id, temporaryDirectoryCharacters: tempDirectory.length }));
    report.warmup = await runTrial(packageRoot, openCodeCommand, layouts.find((layout) => layout.id === "runner-short"), 0, false);
    console.log(JSON.stringify({ initializationWarmup: { status: report.warmup.status,
      sessionCreated: report.warmup.sessionCreated, sessionRequestMs: report.warmup.sessionRequestMs,
      cleanup: report.warmup.cleanup } }));
    retainRoots = report.warmup.cleanup !== "PASS";
    check(!retainRoots, "INIT_DIAG_CLEANUP_FAILED");
    check(report.warmup.installationComplete === true, "INIT_DIAG_CACHE_WARMUP_FAILED");
    for (const [index, round] of rounds.entries()) {
      for (const layout of round) {
        const trial = await runTrial(packageRoot, openCodeCommand, layout, index + 1, true);
        report.trials.push(trial);
        console.log(JSON.stringify({ initializationTrial: { layout: trial.layout, round: trial.round,
          status: trial.status, sessionCreated: trial.sessionCreated, sessionRequestMs: trial.sessionRequestMs,
          activePhases: trial.npmTiming?.phases.filter((phase) => phase.active).map((phase) => phase.phase),
          cleanup: trial.cleanup } }));
        retainRoots = trial.cleanup !== "PASS";
        check(!retainRoots, "INIT_DIAG_CLEANUP_FAILED");
      }
    }
    if (report.warmup.status === "PASS" && report.trials.every((trial) => trial.status === "PASS")) report.status = "PASS";
  } catch (error) {
    report.error = error.nativeCode ?? "INIT_DIAG_PRIVATE_ERROR_SUPPRESSED";
    report.errorDetails = describeSafeError(error);
  } finally {
    report.temporaryStateRetained = retainRoots;
    for (const root of ownedRoots) {
      if (retainRoots) continue;
      try { await rm(root, { recursive: true, force: true }); }
      catch (error) {
        report.status = "FAIL";
        report.temporaryStateRetained = true;
        (report.cleanupErrors ??= []).push(describeSafeError(error));
      }
    }
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.status !== "PASS") process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
