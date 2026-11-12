import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripVTControlCharacters } from "node:util";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { startCursorSetupInterruption } from "./cursor-lifecycle-interruption.mjs";

const source = await readFile(new URL("./cursor-lifecycle-interruption.mjs", import.meta.url), "utf8");
const terminalSource = source.slice(source.indexOf("export function startCursorInterruptionTerminal("),
  source.indexOf("\nfunction failure(")).replace(/^export /, "");
function check(value, suffix) {
  if (!value) throw Object.assign(new Error(suffix), { testCode: `CURSOR_LIFECYCLE_INTERRUPTION_${suffix}` });
}

function terminalFixture({ cancelCase = false, stopError } = {}) {
  const writes = [], stages = [], spawns = [], env = { FIXTURE: "isolated" };
  let emit, stops = 0;
  const child = { onData(callback) { emit = callback; }, write(value) { writes.push(value); } };
  const start = runInNewContext(`(${terminalSource})`, {
    Buffer, stripVTControlCharacters, check, process: { execPath: "/fixture/node" },
    trackLifecycleTerminal(actualChild, actualEnv) {
      assert.equal(actualChild, child); assert.equal(actualEnv, env);
      return { child, exited: Promise.resolve({ exitCode: 1 }), async stop() { stops++; if (stopError) throw stopError; } };
    },
  }, { timeout: 100 });
  const terminal = start({ pty: { spawn(command, args, options) { spawns.push({ command, args, options }); return child; } },
    entrypoint: "/fixture/installed.mjs", workspace: "/fixture/workspace", env, cancelCase,
    onStage(event) { stages.push(event); } });
  return { terminal, writes, stages, spawns, env, emit: (chunk) => emit(chunk), stops: () => stops };
}

test("Cursor interruption terminal spawns only setup with the supplied isolated environment", () => {
  for (const cancelCase of [false, true]) {
    const fixture = terminalFixture({ cancelCase });
    assert.equal(fixture.spawns.length, 1);
    const [{ command, args, options }] = fixture.spawns;
    assert.equal(command, "/fixture/node");
    assert.deepEqual(Array.from(args), ["/fixture/installed.mjs", "setup", ...(cancelCase ? ["--existing-account"] : [])]);
    assert.equal(options.cwd, "/fixture/workspace");
    assert.equal(options.env, fixture.env);
    assert.equal(options.name, "xterm-256color");
    assert.equal(options.cols, 120); assert.equal(options.rows, 40);
  }
});

test("Cursor cancellation terminal answers a fragmented username once and never supplies an API key", () => {
  const fixture = terminalFixture({ cancelCase: true });
  fixture.emit("\x1b[36mUser"); fixture.emit("name (saved account)");
  assert.deepEqual(fixture.writes, []);
  fixture.emit(":\x1b[0m"); fixture.emit("\nUsername (saved account):");
  assert.deepEqual(fixture.writes, ["\r"]);
  fixture.emit("\nMemoraX API ");
  assert.deepEqual(fixture.stages, []);
  fixture.emit("key:"); fixture.emit("\nMemoraX API key: private-key-canary");
  assert.deepEqual(fixture.stages, ["key-prompt"]);
  assert.deepEqual(fixture.writes, ["\r"]);
  assert.equal(fixture.stops(), 0);
  fixture.terminal.verify();
});

test("Cursor interruption terminal recognizes the actual fragmented backend-start event once", () => {
  const fixture = terminalFixture();
  fixture.emit("Unrelated backend text\nStarting back");
  fixture.emit("end with `memorax-code ");
  assert.deepEqual(fixture.stages, []);
  fixture.emit("start`"); fixture.emit("\nStarting backend with `memorax-code start`");
  assert.deepEqual(fixture.stages, ["starting-backend"]);
  assert.deepEqual(fixture.writes, []);
  fixture.terminal.verify();
});

test("Cursor saved-account interruption fails closed on every unexpected input prompt", () => {
  for (const prompt of ["Username (saved account):", "MemoraX API key:", "Preferred language [ZH/en]",
    "Connect MemoraX Code to MemoraX now", "Use the saved connection and memory preferences"]) {
    const fixture = terminalFixture();
    fixture.emit(prompt.slice(0, -1));
    fixture.terminal.verify();
    fixture.emit(prompt.slice(-1));
    assert.throws(() => fixture.terminal.verify(), { testCode: "CURSOR_LIFECYCLE_INTERRUPTION_SAVED_ACCOUNT_INPUT_REQUESTED" });
    fixture.emit("\nMemoraX API key:");
    assert.deepEqual(fixture.writes, []);
    assert.deepEqual(fixture.stages, []);
    assert.equal(fixture.stops(), 1);
  }
});

test("Cursor interruption terminal bounds cursor-query replies and output bytes", () => {
  const queries = terminalFixture({ cancelCase: true });
  queries.emit("\x1b["); queries.emit("6n"); queries.emit("\x1b[6n".repeat(20));
  assert.deepEqual(queries.writes, Array(16).fill("\x1b[1;1R"));
  queries.terminal.verify();

  const fixture = terminalFixture();
  fixture.emit("x".repeat(2 * 1024 * 1024));
  fixture.terminal.verify();
  fixture.emit("x");
  assert.throws(() => fixture.terminal.verify(), { testCode: "CURSOR_LIFECYCLE_INTERRUPTION_TERMINAL_OUTPUT_LIMIT" });
  assert.equal(fixture.terminal.output().length, 2 * 1024 * 1024);
  assert.equal(fixture.stops(), 1);

  const multibyte = terminalFixture();
  multibyte.emit("\u4e2d".repeat(1024 * 1024));
  assert.throws(() => multibyte.terminal.verify(), { testCode: "CURSOR_LIFECYCLE_INTERRUPTION_TERMINAL_OUTPUT_LIMIT" });
  assert.equal(multibyte.terminal.output(), "");
});

test("Cursor interruption terminal retains an owned cleanup failure", async () => {
  const failure = Object.assign(new Error("fixture cleanup failed"), { cleanupFailed: true });
  const fixture = terminalFixture({ stopError: failure });
  fixture.emit("MemoraX API key:");
  await Promise.resolve();
  assert.throws(() => fixture.terminal.verify(), (error) => error === failure);
  assert.deepEqual(fixture.writes, []);
});

test("Cursor setup interruption rejects unknown phases before touching installed state", async () => {
  const operation = startCursorSetupInterruption({ phase: "unsupported", packageRoot: "/fixture/package",
    env: { MEMORAX_CODE_HOME: "/fixture/state" }, verifyPreserved() { assert.fail("Unexpected state access"); } });
  await assert.rejects(operation.result, { testCode: "CURSOR_LIFECYCLE_INTERRUPTION_PHASE_INVALID" });
  await operation.stop();
});

test("Cursor interruption absence oracles reject null, false and zero records", async () => {
  for (const suffix of ["COMPLETED_BEFORE_INTERRUPTION", "BACKEND_STARTED_EARLY", "COMPLETION_REMAINS"]) {
    const statement = source.split("\n").find((line) => line.includes(`"${suffix}"`));
    assert.ok(statement);
    for (const value of [undefined, null, false, 0]) {
      const probe = runInNewContext(`(async () => { ${statement} })`, {
        phase: "before-backend-start", completionPath: "/fixture/completion", pidPath: "/fixture/pid",
        readJsonIfPresent: async () => value, check,
      }, { timeout: 100 });
      if (value === undefined) await probe();
      else await assert.rejects(probe(), { testCode: `CURSOR_LIFECYCLE_INTERRUPTION_${suffix}` });
    }
  }
  const gate = source.split("\n").find((line) => line.includes("let gated ="));
  assert.ok(gate);
  for (const backend of [undefined, null, false, 0]) {
    assert.equal(runInNewContext(`(() => { ${gate} return gated; })()`, {
      phase: "after-config-write", call: { args: ["start"] }, backend,
    }, { timeout: 100 }), backend === undefined);
  }
});

test("Cursor interruption cleanup continues releasing owned resources after a stop or lock failure", async () => {
  const body = source.split("  async function clean() {\n")[1]?.split("\n  }\n}\n\nexport function startCursorInterruptionTerminal")[0];
  assert.ok(body);
  for (const failedAt of [undefined, "stop", "lock"]) {
    const calls = [], failure = new Error("controlled cleanup failure"), heldLock = Promise.resolve();
    const responses = new Set([{ destroyed: false, writableEnded: false, writeHead(status) {
      assert.equal(status, 503); calls.push("reject-gate"); return { end() {} };
    } }]);
    const clean = runInNewContext(`(async function clean() {${body}\n})`, {
      terminal: { async stop() { calls.push("stop"); if (failedAt === "stop") throw failure; } },
      responses, releaseLock() { calls.push("release-lock"); }, heldLock,
      async deadline(promise) { if (promise === heldLock) { calls.push("lock"); if (failedAt === "lock") throw failure; } return await promise; },
      server: { listening: true, closeAllConnections() { calls.push("close-connections"); }, close(done) { calls.push("close-server"); done(); } },
      dependencies: new Set(["owned-fixture"]), alive(value) { assert.equal(value, "owned-fixture"); calls.push("verify-dependencies"); return false; },
      check, setTimeout,
    }, { timeout: 100 });
    if (failedAt) await assert.rejects(clean(), (error) => error === failure && error.cleanupFailed === true);
    else await clean();
    assert.deepEqual(calls, ["stop", "reject-gate", "release-lock", "lock", "close-connections", "close-server", "verify-dependencies"]);
    assert.equal(responses.size, 0);
  }
});
