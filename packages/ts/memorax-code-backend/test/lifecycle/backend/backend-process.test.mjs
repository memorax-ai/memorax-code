import assert from "node:assert/strict";
import test from "node:test";
import {
  managedServiceCommandLine,
  probeProcessCommandLine,
} from "../../../dist/lifecycle/backend/process.js";

const MANAGED_COMMAND = [
  '"C:\\Program Files\\nodejs\\node.exe"',
  '"C:\\package\\memorax-code-backend\\dist\\service-entrypoint.js"',
  "--memorax-code-backend-instance",
  "expected-instance",
].join(" ");

test("Windows process command probes use a bounded ten-second budget", () => {
  let invocation;
  const result = probeProcessCommandLine(4242, {
    env: { SystemRoot: "C:\\Windows" },
    platform: "win32",
    spawnSync: (command, args, options) => {
      invocation = { command, args, options };
      return {
        status: 0,
        signal: null,
        stdout: MANAGED_COMMAND,
      };
    },
  });

  assert.deepEqual(result, {
    status: "ok",
    commandLine: MANAGED_COMMAND,
  });
  assert.match(invocation.command, /powershell\.exe$/i);
  assert.equal(invocation.options.timeout, 10_000);
  assert.equal(invocation.options.killSignal, "SIGKILL");
  assert.equal(managedServiceCommandLine(result.commandLine, "expected-instance"), true);
});

test("process command probes preserve inconclusive failure reasons", async (t) => {
  const cases = [
    {
      name: "timeout",
      spawnResult: {
        status: null,
        signal: "SIGKILL",
        stdout: "",
        error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
      },
      expected: {
        status: "inconclusive",
        reason: "timeout",
        timeoutMs: 10_000,
        code: "ETIMEDOUT",
        signal: "SIGKILL",
      },
    },
    {
      name: "spawn error",
      spawnResult: {
        status: null,
        signal: null,
        stdout: "",
        error: Object.assign(new Error("missing executable"), { code: "ENOENT" }),
      },
      expected: {
        status: "inconclusive",
        reason: "spawn_error",
        timeoutMs: 10_000,
        code: "ENOENT",
      },
    },
    {
      name: "nonzero exit",
      spawnResult: {
        status: 3,
        signal: null,
        stdout: "",
      },
      expected: {
        status: "inconclusive",
        reason: "nonzero_exit",
        timeoutMs: 10_000,
        exitCode: 3,
      },
    },
    {
      name: "terminated",
      spawnResult: {
        status: null,
        signal: "SIGTERM",
        stdout: "",
      },
      expected: {
        status: "inconclusive",
        reason: "terminated",
        timeoutMs: 10_000,
        signal: "SIGTERM",
      },
    },
    {
      name: "empty output",
      spawnResult: {
        status: 0,
        signal: null,
        stdout: " \r\n",
      },
      expected: {
        status: "not_found",
      },
    },
  ];

  for (const entry of cases) {
    await t.test(entry.name, () => {
      const result = probeProcessCommandLine(4242, {
        env: { SystemRoot: "C:\\Windows" },
        platform: "win32",
        spawnSync: () => entry.spawnResult,
      });
      assert.deepEqual(result, entry.expected);
    });
  }
});

test("Windows process command probes report unavailable PowerShell without spawning", () => {
  let spawned = false;
  const result = probeProcessCommandLine(4242, {
    env: {},
    platform: "win32",
    spawnSync: () => {
      spawned = true;
      throw new Error("must not spawn");
    },
  });

  assert.deepEqual(result, {
    status: "inconclusive",
    reason: "powershell_unavailable",
    timeoutMs: 10_000,
  });
  assert.equal(spawned, false);
});

test("POSIX process command probes retain the two-second budget", () => {
  let timeout;
  const result = probeProcessCommandLine(4242, {
    platform: "linux",
    spawnSync: (_command, _args, options) => {
      timeout = options.timeout;
      return {
        status: 0,
        signal: null,
        stdout: "/usr/bin/node /package/memorax-code-backend/dist/service-entrypoint.js --memorax-code-backend-instance expected-instance",
      };
    },
  });

  assert.equal(result.status, "ok");
  assert.equal(timeout, 2_000);
});
