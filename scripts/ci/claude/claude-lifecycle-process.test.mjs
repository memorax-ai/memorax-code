import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { startLifecycleCommand, trackLifecycleTerminal } from "./claude-lifecycle-process.mjs";

const posix = process.platform !== "win32";
const fixtureEnv = process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, PATH: process.env.SystemRoot } : {};
const nodeArgs = ["--input-type=module", "-e"];

function run(script, options = {}) {
  return startLifecycleCommand(process.execPath, [...nodeArgs, script], { env: fixtureEnv, timeoutMs: 5000, ...options });
}
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}
async function waitFor(predicate) {
  const deadline = Date.now() + 10_000;
  while (!(await predicate())) {
    assert.ok(Date.now() < deadline, "Owned fixture did not reach the expected state");
    await new Promise((done) => setTimeout(done, 20));
  }
}
function identities(output) {
  const result = JSON.parse(output.stdout.split(/\r?\n/)[0]);
  assert.ok(Number.isInteger(result.pid) && result.pid > 1 && result.pid !== process.pid);
  assert.ok(Number.isInteger(result.child) && result.child > 1 && result.child !== process.pid);
  return result;
}
function spawnFixture({ detached = false, after = "process.exit(0);", marker } = {}) {
  return [
    'import { spawn } from "node:child_process";',
    'import { writeFileSync } from "node:fs";',
    `const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { detached: ${detached}, stdio: "ignore" });`,
    'child.unref();',
    'const identity = JSON.stringify({ pid: process.pid, child: child.pid });',
    marker ? `writeFileSync(${JSON.stringify(marker)}, identity);` : 'console.log(identity);',
    after,
  ].join("\n");
}
async function stopFixture(identity) {
  // These two PIDs come only from this test's immediate fixture, which cannot
  // spawn additional descendants. Always clean them even if group checks fail.
  for (const pid of [identity.child, identity.pid]) {
    if (!alive(pid)) continue;
    process.kill(pid, "SIGKILL");
    await waitFor(() => !alive(pid));
  }
}

test("lifecycle command preserves bounded stdout, stderr and input", { timeout: 15_000 }, async () => {
  const operation = run('let input = ""; for await (const part of process.stdin) input += part; console.log(input); console.error("diagnostic");',
    { input: "fixture input" });
  assert.deepEqual(await operation.result, { stdout: "fixture input\n", stderr: "diagnostic\n" });
  await operation.stop();
});

test("lifecycle command reports a failed spawn without retaining a process", { timeout: 15_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-lifecycle-process-"));
  try {
    const operation = startLifecycleCommand(join(root, "missing-command"), [], { env: fixtureEnv });
    await assert.rejects(operation.result, (error) => error.code === "ENOENT" && !error.cleanupFailed);
    await operation.stop();
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const code of [0, 7]) {
  test(`POSIX lifecycle command reaps a same-group child after leader exit ${code}`,
    { skip: !posix, timeout: 20_000 }, async () => {
      const operation = run(spawnFixture({ after: `process.exit(${code});` }));
      let result, identity;
      try {
        try { result = await operation.result; }
        catch (error) {
          identity = identities(error);
          assert.equal(code, 7);
          assert.equal(error.code, code);
          assert.notEqual(error.cleanupFailed, true);
          result = error;
        }
        identity = identities(result);
        assert.equal(alive(identity.pid), false);
        assert.equal(alive(identity.child), false);
        assert.equal(alive(-identity.pid), false);
        await operation.stop();
      } finally {
        await operation.stop().catch(() => {});
        if (identity) await stopFixture(identity);
      }
    });
}

for (const [label, after, options, expected] of [
  ["timeout", 'setTimeout(() => {}, 60000);', { timeoutMs: 1000 }, "INSTALL_COMMAND_TIMEOUT"],
  ["output limit", 'setTimeout(() => { process.stdout.write("x".repeat(8192)); }, 100); setTimeout(() => {}, 60000);',
    { maxOutputBytes: 1024 }, "INSTALL_COMMAND_OUTPUT_LIMIT"],
]) {
  test(`POSIX lifecycle ${label} removes its owned child and leader`, { skip: !posix, timeout: 20_000 }, async () => {
    const operation = run(spawnFixture({ after }), options);
    let identity;
    try {
      await assert.rejects(operation.result, (error) => {
        identity = identities(error);
        assert.equal(error.testCode, expected);
        assert.notEqual(error.cleanupFailed, true);
        assert.equal(alive(identity.pid), false);
        assert.equal(alive(identity.child), false);
        assert.equal(alive(-identity.pid), false);
        return true;
      });
    } finally {
      await operation.stop().catch(() => {});
      if (identity) await stopFixture(identity);
    }
  });
}

test("POSIX explicit stop cleans the current command process group", { skip: !posix, timeout: 20_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "claude-lifecycle-process-"));
  const marker = join(root, "started.json");
  const operation = run(spawnFixture({ marker, after: 'setTimeout(() => {}, 60000);' }));
  const result = operation.result.then(() => undefined, (error) => error);
  let identity;
  try {
    await waitFor(async () => {
      const text = await readFile(marker, "utf8").catch((error) => { if (error.code === "ENOENT") return ""; throw error; });
      if (!text) return false;
      identity = JSON.parse(text);
      return true;
    });
    await operation.stop();
    const error = await result;
    assert.equal(error.testCode, "INSTALL_COMMAND_STOPPED");
    assert.notEqual(error.cleanupFailed, true);
    assert.equal(alive(identity.pid), false);
    assert.equal(alive(identity.child), false);
    assert.equal(alive(-identity.pid), false);
  } finally {
    await operation.stop().catch(() => {});
    if (identity) await stopFixture(identity);
    await rm(root, { recursive: true, force: true });
  }
});

test("POSIX successful command leaves its independent Backend-style session alive",
  { skip: !posix, timeout: 20_000 }, async () => {
    const operation = run(spawnFixture({ detached: true }));
    let identity;
    try {
      try { identity = identities(await operation.result); }
      catch (error) { identity = identities(error); throw error; }
      assert.equal(alive(-identity.pid), false);
      assert.equal(alive(identity.child), true);
      await operation.stop();
      assert.equal(alive(identity.child), true);
    } finally {
      await operation.stop().catch(() => {});
      if (identity) await stopFixture(identity);
    }
  });

test("POSIX interrupted terminal captures a live parent's separate session before cleanup",
  { skip: !posix, timeout: 20_000 }, async () => {
    const operation = run(spawnFixture({ detached: true, after: 'setTimeout(() => {}, 60000);' }),
      { terminal: true, timeoutMs: 1000 });
    let identity;
    try {
      await assert.rejects(operation.result, (error) => {
        identity = identities(error);
        assert.equal(error.testCode, "INSTALL_COMMAND_TIMEOUT");
        assert.notEqual(error.cleanupFailed, true);
        assert.equal(alive(-identity.pid), false);
        assert.equal(alive(-identity.child), false);
        return true;
      });
    } finally {
      await operation.stop().catch(() => {});
      if (identity) await stopFixture(identity);
    }
  });

test("failed terminal with an exited leader cannot claim separate-session cleanup", { timeout: 15_000 }, async () => {
  const operation = run('process.exit(9);', { terminal: true });
  await assert.rejects(operation.result, (error) => error.testCode === "INSTALL_TERMINAL_CLEANUP_UNVERIFIED"
    && error.cleanupFailed === true);
  await assert.rejects(operation.stop(), (error) => error.testCode === "INSTALL_TERMINAL_CLEANUP_UNVERIFIED");
});

test("POSIX descendant-group cleanup failure still terminates the owned leader and rejects within a bound",
  { skip: !posix, timeout: 20_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-lifecycle-process-"));
    const marker = join(root, "started.json");
    const operation = run(spawnFixture({ detached: true, marker, after: 'setTimeout(() => {}, 60000);' }),
      { terminal: true, timeoutMs: 1000 });
    const result = operation.result.then(() => undefined, (error) => error);
    const originalKill = process.kill;
    let identity, refused = false;
    try {
      await waitFor(async () => {
        const text = await readFile(marker, "utf8").catch((error) => { if (error.code === "ENOENT") return ""; throw error; });
        if (!text) return false;
        identity = JSON.parse(text);
        return true;
      });
      process.kill = function (pid, signal) {
        if (pid === -identity.child) {
          if (signal === 0) return true;
          refused = true;
          throw Object.assign(new Error("Synthetic owned-group signal failure"), { code: "EIO" });
        }
        return originalKill.call(process, pid, signal);
      };
      const started = Date.now();
      const error = await result;
      assert.equal(refused, true);
      assert.equal(error.cleanupFailed, true);
      assert.equal(error.code, "EIO");
      assert.equal(alive(identity.pid), false);
      assert.ok(Date.now() - started < 16_000);
    } finally {
      process.kill = originalKill;
      await operation.stop().catch(() => {});
      if (identity) await stopFixture(identity);
      await rm(root, { recursive: true, force: true });
    }
  });

test("POSIX group SIGKILL EPERM remains a cleanup failure after the owned leader exits",
  { skip: !posix, timeout: 15_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), "claude-lifecycle-process-"));
    const marker = join(root, "started.json");
    const operation = run(`import {writeFileSync} from "node:fs"; writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setTimeout(() => {}, 60000);`);
    const result = operation.result.then(() => undefined, (error) => error);
    const originalKill = process.kill;
    let pid, denied = false;
    try {
      await waitFor(async () => {
        const value = await readFile(marker, "utf8").catch((error) => { if (error.code === "ENOENT") return ""; throw error; });
        if (!value) return false;
        pid = Number(value);
        assert.ok(Number.isInteger(pid) && pid > 1 && pid !== process.pid);
        return true;
      });
      process.kill = function (target, signal) {
        if (target === -pid && signal === "SIGKILL") {
          denied = true;
          throw Object.assign(new Error("Synthetic owned-group permission failure"), { code: "EPERM" });
        }
        return originalKill.call(process, target, signal);
      };
      await assert.rejects(operation.stop(), (error) => error.code === "EPERM");
      const error = await result;
      assert.equal(denied, true);
      assert.equal(error.code, "EPERM");
      assert.equal(error.cleanupFailed, true);
      assert.equal(alive(pid), false);
    } finally {
      process.kill = originalKill;
      await operation.stop().catch(() => {});
      if (pid && alive(pid)) { process.kill(pid, "SIGKILL"); await waitFor(() => !alive(pid)); }
      await rm(root, { recursive: true, force: true });
    }
  });

function terminalFixture(script) {
  const child = spawn(process.execPath, [...nodeArgs, script], {
    env: fixtureEnv, detached: posix, windowsHide: true, stdio: ["ignore", "pipe", "ignore"],
  });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (text) => { stdout += text; });
  const terminal = trackLifecycleTerminal({ pid: child.pid,
    onExit: (callback) => child.once("exit", (exitCode, signal) => callback({ exitCode, signal })),
    kill: (signal) => child.kill(signal),
  }, fixtureEnv);
  return { terminal, async identity() {
    await waitFor(() => stdout.includes("\n"));
    return identities({ stdout });
  } };
}

test("terminal tracker rejects an unowned process identity without signalling", () => {
  assert.throws(() => trackLifecycleTerminal({ pid: 1, onExit() {}, kill() {} }),
    (error) => error.testCode === "INSTALL_TERMINAL_IDENTITY_INVALID" && error.cleanupFailed === true);
});

test("Windows terminal disposal calls node-pty kill without a signal after exit", async () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  let reportExit;
  const calls = [];
  try {
    Object.defineProperty(process, "platform", { ...platform, value: "win32" });
    const terminal = trackLifecycleTerminal({ pid: 2147483647,
      onExit(callback) { reportExit = callback; },
      kill(...args) {
        calls.push(args);
        if (args[0]) throw new Error("Signals not supported on windows.");
      },
    }, {});
    // An already-exited synthetic PTY exercises handle disposal without any
    // taskkill invocation or real process identity being signalled.
    reportExit({ exitCode: 0, signal: 0 });
    await terminal.exited;
    await terminal.stop();
    await terminal.stop();
    assert.deepEqual(calls, [[]]);
  } finally { Object.defineProperty(process, "platform", platform); }
});

for (const after of ["setTimeout(() => {}, 60000);", "process.exit(0);"]) {
  test(`terminal stop removes its owned ${posix ? "group" : "tree"} when the leader ${after.startsWith("setTimeout") ? "is live" : "has exited"}`,
    { skip: !posix && after.startsWith("process.exit"), timeout: 20_000 }, async () => {
      const fixture = terminalFixture(spawnFixture({ after }));
      let identity;
      try {
        identity = await fixture.identity();
        if (after.startsWith("process.exit")) await fixture.terminal.exited;
        await fixture.terminal.stop();
        await fixture.terminal.exited;
        assert.equal(alive(identity.pid), false);
        assert.equal(alive(identity.child), false);
        if (posix) assert.equal(alive(-identity.pid), false);
        await fixture.terminal.stop();
      } finally {
        await fixture.terminal.stop().catch(() => {});
        if (identity) await stopFixture(identity);
      }
    });
}

test("POSIX terminal disposal preserves the independent Backend-style session",
  { skip: !posix, timeout: 20_000 }, async () => {
    const fixture = terminalFixture(spawnFixture({ detached: true }));
    let identity;
    try {
      identity = await fixture.identity();
      const exited = await fixture.terminal.exited;
      assert.equal(exited.exitCode, 0);
      await fixture.terminal.stop();
      assert.equal(alive(-identity.pid), false);
      assert.equal(alive(identity.child), true);
    } finally {
      await fixture.terminal.stop().catch(() => {});
      if (identity) await stopFixture(identity);
    }
  });

test("POSIX terminal group signal failure is retained after its leader is stopped",
  { skip: !posix, timeout: 15_000 }, async () => {
    const fixture = terminalFixture(spawnFixture({ detached: true, after: "setTimeout(() => {}, 60000);" }));
    const originalKill = process.kill;
    let identity;
    try {
      identity = await fixture.identity();
      process.kill = function (pid, signal) {
        if (pid === -identity.pid && signal === "SIGKILL") {
          throw Object.assign(new Error("Synthetic owned-terminal signal failure"), { code: "EPERM" });
        }
        return originalKill.call(process, pid, signal);
      };
      await assert.rejects(fixture.terminal.stop(), (error) => error.code === "EPERM" && error.cleanupFailed === true);
      assert.equal(alive(identity.pid), false);
      assert.equal(alive(identity.child), true);
    } finally {
      process.kill = originalKill;
      await fixture.terminal.stop().catch(() => {});
      if (identity) await stopFixture(identity);
    }
  });
