import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import vm from "node:vm";
import { assertInitializationComplete, installNpmTimingObserver } from "./opencode-initialization-diagnostic.mjs";

function fixture() {
  let now = 0;
  const process = new EventEmitter();
  const context = vm.createContext({ process, performance: { now: () => now } });
  assert.equal(vm.runInContext(`(${installNpmTimingObserver.toString()})()`, context), true);
  return { process, context, advance: (milliseconds) => { now += milliseconds; },
    snapshot: () => JSON.parse(JSON.stringify(context.__memoraxNpmInitializationDiagnostic())) };
}

test("npm diagnostic captures real proc-log start/end signatures and active durations", () => {
  const { process, advance, snapshot } = fixture();
  process.emit("time", "start", "reify");
  advance(3);
  process.emit("time", "start", "reify:unpack");
  advance(11);
  assert.deepEqual(snapshot().phases[1], { phase: "reify:unpack", started: 1, completed: 0, active: 1,
    overlapping: false, unmatchedEnds: 0, activeDurationMs: 11, completedDurationMs: 0, lastDurationMs: null });
  process.emit("time", "end", "reify:unpack");
  advance(5);
  process.emit("time", "end", "reify");
  assert.equal(snapshot().phases[0].completedDurationMs, 19);
  assert.equal(snapshot().phases[1].lastDurationMs, 11);
  assert.equal(snapshot().phases.every((phase) => phase.active === 0), true);
});

test("npm diagnostic reports overlapping timers without claiming exact paired durations", () => {
  const { process, advance, snapshot } = fixture();
  process.emit("time", "start", "reify:unpack");
  advance(3);
  process.emit("time", "start", "reify:unpack");
  advance(4);
  process.emit("time", "end", "reify:unpack");
  assert.equal(snapshot().phases[0].active, 1);
  process.emit("time", "end", "reify:unpack");
  process.emit("time", "end", "reify:unpack");
  assert.deepEqual(snapshot().phases[0], { phase: "reify:unpack", started: 2, completed: 2, active: 0,
    overlapping: true, unmatchedEnds: 1, activeDurationMs: null, completedDurationMs: null, lastDurationMs: null });
});

test("npm diagnostic recognizes all 27 public Windows dependency package names", () => {
  const { process, advance, snapshot } = fixture();
  const packages = [
    ["@opencode-ai/plugin", "opencode-plugin"], ["@opencode-ai/sdk", "opencode-sdk"],
    ["@ai-sdk/provider", "ai-sdk-provider"], ["@standard-schema/spec", "standard-schema-spec"],
    ["@msgpackr-extract/msgpackr-extract-win32-x64", "msgpackr-extract-win32-x64"],
    ...["zod", "effect", "ini", "toml", "uuid", "yaml", "msgpackr", "msgpackr-extract", "fast-check",
      "pure-rand", "multipasta", "find-my-way-ts", "kubernetes-types", "json-schema", "cross-spawn",
      "which", "path-key", "shebang-command", "shebang-regex", "isexe", "node-gyp-build-optional-packages",
      "detect-libc"].map((name) => [name, name]),
  ];
  const canary = "PRIVATE_DEPENDENCY_PATH_CANARY";
  for (const [index, [name]] of packages.entries()) {
    const path = index % 2 ? `/tmp/${canary}/node_modules/${name}`
      : `C:\\Users\\${canary}\\node_modules\\${name.replaceAll("/", "\\")}`;
    process.emit("time", "start", `reifyNode:${path}`);
    advance(3);
    process.emit("time", "end", `reifyNode:${path}`);
  }
  const result = snapshot();
  assert.equal(result.phases.length, 27);
  assert.deepEqual(result.phases.map((phase) => phase.phase), packages.map(([, label]) => `package:${label}`));
  assert.equal(result.phases.every((phase) => phase.started === 1 && phase.completed === 1
    && phase.active === 0 && phase.lastDurationMs === 3), true);
  assert.equal(JSON.stringify(result).includes(canary), false);
});

test("npm diagnostic classifies only public package names and never retains paths or log arguments", () => {
  const { process, snapshot } = fixture();
  const canary = "PRIVATE_NPM_DIAGNOSTIC_CANARY";
  for (const path of [
    `C:\\Users\\${canary}\\node_modules\\@opencode-ai\\plugin`,
    `/tmp/${canary}/node_modules/@opencode-ai/sdk`, "node_modules/zod",
  ]) process.emit("time", "start", `reifyNode:${path}`);
  for (const name of [`reifyNode:/tmp/${canary}/node_modules/private-package`,
    `reifyNode:node_modules/effect-${canary}`, `reifyNode:private-node_modules/effect`,
    `reifyNode:node_modules/@ai-sdk/provider-${canary}`, `idealTree:${canary}`, canary]) {
    process.emit("time", "start", name);
  }
  process.emit("time", "private-action", "reify");
  process.emit("log", "warn", { token: canary, path: `C:\\Users\\${canary}` }, canary);
  process.emit("log", canary, canary);
  process.emit("log", { toString() { throw new Error("Do not coerce log payloads"); } });
  const result = snapshot();
  assert.deepEqual(result.phases.map((phase) => phase.phase), ["package:opencode-plugin", "package:opencode-sdk", "package:zod"]);
  assert.equal(result.logCounts.warn, 1);
  assert.equal(Object.values(result.logCounts).reduce((total, count) => total + count, 0), 1);
  for (const forbidden of [canary, "C:\\Users", "/tmp/", "private-package", "private-action"]) {
    assert.equal(JSON.stringify(result).includes(forbidden), false);
  }
});

test("npm diagnostic reports explicit noop invocation instead of inferring it from session success", () => {
  const { context, snapshot } = fixture();
  assert.equal(snapshot().noopPluginInvoked, false);
  context.__memoraxNoopPluginInvoked = "private truthy value";
  assert.equal(snapshot().noopPluginInvoked, false);
  context.__memoraxNoopPluginInvoked = true;
  assert.equal(snapshot().noopPluginInvoked, true);
});

test("effect HTTP diagnostics distinguish registry body end from pacote cache stream creation", () => {
  const { process, advance, snapshot } = fixture();
  const url = "https://registry.npmjs.org/effect/-/effect-4.0.0-beta.83.tgz";
  advance(7);
  process.emit("log", "http", "cache", `effect@${url} 0ms (cache hit)`);
  assert.deepEqual(snapshot().effectHttp.pacoteCacheStreamStart,
    { count: 1, lastDurationMs: 0, lastObservedAfterMs: 7 });
  assert.equal(snapshot().effectHttp.registryBodyEnd.count, 0);
  advance(19);
  process.emit("log", "http", "fetch", `GET 200 ${url} 18ms attempt #2 (cache miss)`);
  assert.deepEqual(snapshot().effectHttp.registryBodyEnd,
    { count: 1, lastStatus: 200, lastCacheStatus: "miss", lastDurationMs: 18, lastObservedAfterMs: 26 });
  advance(3);
  process.emit("log", "http", "cache", `${url} 2ms (cache hit)`);
  assert.deepEqual(snapshot().effectHttp.registryBodyEnd,
    { count: 2, lastStatus: null, lastCacheStatus: "hit", lastDurationMs: 2, lastObservedAfterMs: 29 });
  process.emit("log", "http", "cache", "effect@4.0.0-beta.83 1ms (cache hit)");
  assert.equal(snapshot().effectHttp.pacoteCacheStreamStart.count, 2);
});

test("effect HTTP diagnostics reject errors, other URLs, private payloads, and invalid timing", () => {
  const { process, snapshot } = fixture();
  const canary = "PRIVATE_HTTP_DIAGNOSTIC_CANARY";
  const url = "https://registry.npmjs.org/effect/-/effect-4.0.0-beta.83.tgz";
  for (const message of [
    `GET 404 ${url} 1ms (cache miss)`, `GET 500 ${url} 1ms`,
    `GET 200 ${url}?token=${canary} 1ms`, `GET 200 ${url}/${canary} 1ms`,
    `GET 200 ${url.replace("registry.npmjs.org", `${canary}.example`)} 1ms`,
    `GET 200 ${url.replace("beta.83", "beta.84")} 1ms`,
    `GET 200 ${url} 9007199254740992ms`, `GET 200 ${url} -1ms`,
    `GET 200 ${url} 1ms (cache ${canary})`, `GET 200 ${url} 1ms ${canary}`,
    `${canary} GET 200 ${url} 1ms`, "x".repeat(513),
  ]) process.emit("log", "http", "fetch", message);
  process.emit("log", "http", "cache", `${canary}@${url} 0ms (cache hit)`);
  process.emit("log", "http", "cache", `effect@${url} 0ms (cache hit) ${canary}`);
  process.emit("log", "http", "cache", { toString() { throw new Error("Do not coerce HTTP payloads"); } });
  const result = snapshot();
  assert.equal(result.effectHttp.registryBodyEnd.count, 0);
  assert.equal(result.effectHttp.pacoteCacheStreamStart.count, 0);
  for (const forbidden of [canary, url, "registry.npmjs.org"]) assert.equal(JSON.stringify(result).includes(forbidden), false);
});

function completedInitialization() {
  return {
    sessionCreated: true,
    npmTiming: { noopPluginInvoked: true, phases: ["reify", "reify:unpack", "package:effect"]
      .map((phase) => ({ phase, started: 1, completed: 1, active: 0 })) },
    nativeServerInitialization: {
      milestones: { postPluginReached: true, dependencyInstallFailed: false },
      dependencies: { packageJson: true, nodeModules: true, pluginPackage: true, packageLock: true, npmInstallLock: false },
    },
    dependencyVersionsMatch: { plugin: true, effect: true },
    private: { token: "PRIVATE_INSTALL_DIAGNOSTIC_CANARY", path: "C:\\Users\\PRIVATE_INSTALL_DIAGNOSTIC_CANARY" },
  };
}

test("initialization completion accepts the complete evidence without mutating it", () => {
  const result = completedInitialization();
  const before = structuredClone(result);
  assert.doesNotThrow(() => assertInitializationComplete(result));
  assert.deepEqual(result, before);
});

test("initialization completion rejects every missing or incorrect requirement with a fixed error", () => {
  const paths = [
    ["npmTiming", "noopPluginInvoked"],
    ...[0, 1, 2].flatMap((index) => ["started", "completed", "active"]
      .map((key) => ["npmTiming", "phases", index, key])),
    ["nativeServerInitialization", "milestones", "postPluginReached"],
    ["nativeServerInitialization", "milestones", "dependencyInstallFailed"],
    ...["packageJson", "nodeModules", "pluginPackage", "packageLock", "npmInstallLock"]
      .map((key) => ["nativeServerInitialization", "dependencies", key]),
    ["dependencyVersionsMatch", "plugin"], ["dependencyVersionsMatch", "effect"],
  ];
  for (const path of paths) {
    const complete = completedInitialization();
    const expected = path.reduce((value, key) => value[key], complete);
    for (const invalid of [undefined, null, typeof expected === "boolean" ? !expected : expected + 1,
      String(expected), "PRIVATE_INSTALL_DIAGNOSTIC_CANARY"]) {
      const result = completedInitialization();
      const target = path.slice(0, -1).reduce((value, key) => value[key], result);
      if (invalid === undefined) delete target[path.at(-1)]; else target[path.at(-1)] = invalid;
      assert.throws(() => assertInitializationComplete(result), (error) => {
        assert.equal(error.message, "INIT_DIAG_DEPENDENCY_INSTALL_INCOMPLETE");
        assert.equal(error.nativeCode, "INIT_DIAG_DEPENDENCY_INSTALL_INCOMPLETE");
        assert.deepEqual(Object.keys(error), ["nativeCode"]);
        assert.equal(JSON.stringify(error).includes("PRIVATE_INSTALL_DIAGNOSTIC_CANARY"), false);
        return true;
      }, path.join("."));
    }
  }
});

test("initialization completion rejects missing containers and absent or duplicate native phases", () => {
  const code = { nativeCode: "INIT_DIAG_DEPENDENCY_INSTALL_INCOMPLETE" };
  for (const value of [undefined, null, {}, { sessionCreated: true }]) {
    assert.throws(() => assertInitializationComplete(value), code);
  }
  for (const key of ["npmTiming", "nativeServerInitialization", "dependencyVersionsMatch"]) {
    const result = completedInitialization();
    delete result[key];
    assert.throws(() => assertInitializationComplete(result), code);
  }
  for (const phases of [undefined, null, {}, []]) {
    const result = completedInitialization();
    result.npmTiming.phases = phases;
    assert.throws(() => assertInitializationComplete(result), code);
  }
  for (const index of [0, 1, 2]) {
    for (const change of ["missing", "unknown", "duplicate"]) {
      const result = completedInitialization();
      if (change === "missing") result.npmTiming.phases.splice(index, 1);
      if (change === "unknown") result.npmTiming.phases[index].phase = "PRIVATE_INSTALL_DIAGNOSTIC_CANARY";
      if (change === "duplicate") result.npmTiming.phases.push({ ...result.npmTiming.phases[index] });
      assert.throws(() => assertInitializationComplete(result), code);
    }
  }
});
