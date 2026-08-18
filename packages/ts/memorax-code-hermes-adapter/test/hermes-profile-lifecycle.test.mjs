import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  collectHermesAdapterStatus,
  withHermesPluginLifecycleLock,
} from "../src/profile-lifecycle.mjs";

const ADAPTER_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function testedHermesRun() {
  return (invocation) => {
    if (invocation.args.length === 1 && invocation.args[0] === "--version") {
      return { status: 0, stdout: "Hermes Agent v0.20.3 (2026.8.16.2)\n", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: `unexpected invocation: ${invocation.command} ${invocation.args.join(" ")}` };
  };
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "mx-hermes-lifecycle-"));
  const memoraxCodeHome = join(root, "memorax-home");
  const hermesHome = join(root, "hermes-home");
  mkdirSync(hermesHome, { recursive: true });
  const configPath = join(hermesHome, "config.yaml");
  const allowlistPath = join(hermesHome, "shell-hooks-allowlist.json");
  const statePath = join(memoraxCodeHome, "adapters", "hermes", "state.json");
  writeFileSync(configPath, "model: claude-sonnet-4\nsandbox: true\n");
  const options = {
    homeDir: join(root, "fake-home"),
    memoraxCodeHome,
    hermesHome,
    adapterRoot: ADAPTER_ROOT,
    env: { ...process.env, HERMES_HOME: "", MEMORAX_CODE_HERMES_COMMAND: "" },
    runHermes: testedHermesRun(),
  };
  return {
    root,
    options,
    configPath,
    allowlistPath,
    statePath,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function lifecycle(options, operation) {
  return withHermesPluginLifecycleLock(options, operation);
}

test("status skips with no existing profiles when config is absent", async () => {
  const env = setup();
  const { cleanup, options } = env;
  try {
    rmSync(env.configPath, { force: true });
    const report = collectHermesAdapterStatus(options);
    assert.equal(report.ok, true);
    assert.equal(report.skipped, true);
    assert.equal(report.reason, "no_existing_profiles");
    assert.equal(report.managed, false);
    assert.equal(report.installed, false);
    assert.equal(report.profiles[0].exists, false);
  } finally {
    cleanup();
  }
});

test("status skips as not managed when Hermes exists but state does not", async () => {
  const env = setup();
  try {
    const report = collectHermesAdapterStatus(env.options);
    assert.equal(report.ok, true);
    assert.equal(report.skipped, true);
    assert.equal(report.reason, "not_managed");
    assert.equal(report.compatible, true);
    assert.equal(report.version, "0.20.3");
    assert.equal(report.hermesVersionTested, true);
    assert.ok(report.testedHermesVersions.includes("0.20.3"));
  } finally {
    env.cleanup();
  }
});

test("status reports hermes_version_unavailable when hermes cannot run", async () => {
  const env = setup();
  try {
    env.options.runHermes = () => ({ status: 1, stdout: "", stderr: "command not found" });
    const report = collectHermesAdapterStatus(env.options);
    assert.equal(report.ok, false);
    assert.equal(report.reason, "hermes_version_unavailable");
    assert.equal(report.compatible, false);
  } finally {
    env.cleanup();
  }
});

test("ensureInstalled installs config, allowlist, state and runtime bundle", async () => {
  const env = setup();
  try {
    const result = await lifecycle(env.options, (api) => api.ensureInstalled());
    assert.equal(result.ok, true);
    assert.equal(result.installed, true);
    assert.equal(result.enabled, true);
    assert.equal(result.compatible, true);
    assert.equal(result.version, "0.20.3");
    assert.equal(result.detectedProfiles.length, 1);

    assert.ok(existsSync(env.statePath));
    const state = JSON.parse(readFileSync(env.statePath, "utf8"));
    assert.equal(state.runtime, "hermes");
    assert.equal(state.enabled, true);
    assert.equal(state.version, 1);
    assert.ok(existsSync(join(state.runtimeBundleRoot, "hooks", "memorax-code-hermes-hook.mjs")));
    assert.ok(existsSync(join(state.runtimeBundleRoot, ".memorax-code-package.json")));
    assert.ok(existsSync(join(state.runtimeBundleRoot, "src", "profile-lifecycle.mjs")));

    const config = readFileSync(env.configPath, "utf8");
    assert.match(config, /^hooks:\n/m);
    assert.match(config, /^  pre_llm_call:\n/m);
    assert.match(config, /^  on_session_end:\n/m);
    assert.equal((config.match(/memorax-code-hermes-hook\.mjs/g) ?? []).length, 2);
    assert.ok(config.includes(state.command));

    const approvals = JSON.parse(readFileSync(env.allowlistPath, "utf8")).approvals;
    assert.deepEqual(approvals.map((entry) => entry.event).sort(), ["on_session_end", "pre_llm_call"]);
    assert.ok(approvals.every((entry) => entry.command === state.command));

    const status = collectHermesAdapterStatus(env.options);
    assert.equal(status.ok, true);
    assert.equal(status.installed, true);
    assert.equal(status.enabled, true);
    assert.equal(status.managed, true);
    assert.equal(status.hermesVersionTested, true);
    assert.equal(status.revision, state.updatedAt);
  } finally {
    env.cleanup();
  }
});

test("ensureInstalled is idempotent", async () => {
  const env = setup();
  try {
    const first = await lifecycle(env.options, (api) => api.ensureInstalled());
    const configAfterFirst = readFileSync(env.configPath, "utf8");
    const second = await lifecycle(env.options, (api) => api.ensureInstalled());
    assert.equal(second.ok, true);
    assert.equal(readFileSync(env.configPath, "utf8"), configAfterFirst);
    assert.equal(second.command, first.command);
    assert.equal(second.runtimeBundleRoot, first.runtimeBundleRoot);
  } finally {
    env.cleanup();
  }
});

test("ensureInstalled with enabled false leaves installation disabled", async () => {
  const env = setup();
  try {
    const result = await lifecycle(env.options, (api) => api.ensureInstalled({ enabled: false }));
    assert.equal(result.ok, true);
    assert.equal(result.enabled, false);
    const status = collectHermesAdapterStatus(env.options);
    assert.equal(status.enabled, false);
    assert.equal(status.reason, "disabled");
  } finally {
    env.cleanup();
  }
});

test("activate and quiesce toggle enabled state", async () => {
  const env = setup();
  try {
    await lifecycle(env.options, (api) => api.ensureInstalled({ enabled: false }));
    const activated = await lifecycle(env.options, (api) => api.activate());
    assert.equal(activated.ok, true);
    assert.equal(activated.enabled, true);
    const quiesced = await lifecycle(env.options, (api) => api.quiesce());
    assert.equal(quiesced.ok, true);
    assert.equal(quiesced.enabled, false);
    const status = collectHermesAdapterStatus(env.options);
    assert.equal(status.enabled, false);
  } finally {
    env.cleanup();
  }
});

test("disable removes hooks from config and allowlist but keeps state", async () => {
  const env = setup();
  try {
    await lifecycle(env.options, (api) => api.ensureInstalled());
    const result = await lifecycle(env.options, (api) => api.disable());
    assert.equal(result.ok, true);
    assert.equal(result.installed, false);
    assert.equal(result.removed, false);
    assert.ok(!readFileSync(env.configPath, "utf8").includes("memorax-code-hermes-hook"));
    assert.deepEqual(JSON.parse(readFileSync(env.allowlistPath, "utf8")).approvals, []);
    assert.ok(existsSync(env.statePath));
    const status = collectHermesAdapterStatus(env.options);
    assert.equal(status.managed, true);
    assert.equal(status.installed, false);
  } finally {
    env.cleanup();
  }
});

test("remove deletes state and runtime while restoring config", async () => {
  const env = setup();
  try {
    await lifecycle(env.options, (api) => api.ensureInstalled());
    const result = await lifecycle(env.options, (api) => api.remove());
    assert.equal(result.ok, true);
    assert.equal(result.removed, true);
    assert.ok(!existsSync(env.statePath));
    assert.ok(!readFileSync(env.configPath, "utf8").includes("memorax-code-hermes-hook"));
    const status = collectHermesAdapterStatus(env.options);
    assert.equal(status.managed, false);
    assert.equal(status.skipped, true);
    assert.equal(status.reason, "not_managed");
  } finally {
    env.cleanup();
  }
});

test("install preserves unrelated user hooks", async () => {
  const env = setup();
  try {
    writeFileSync(env.configPath, [
      "hooks:",
      "  pre_tool_call:",
      '    - command: "echo user-hook"',
      "",
    ].join("\n"));
    const result = await lifecycle(env.options, (api) => api.ensureInstalled());
    assert.equal(result.ok, true);
    const config = readFileSync(env.configPath, "utf8");
    assert.match(config, /echo user-hook/);
    assert.equal((config.match(/pre_llm_call:/g) ?? []).length, 1);
    const removed = await lifecycle(env.options, (api) => api.remove());
    assert.equal(removed.ok, true);
    assert.match(readFileSync(env.configPath, "utf8"), /echo user-hook/);
  } finally {
    env.cleanup();
  }
});

test("status detects profile drift when the config entry disappears", async () => {
  const env = setup();
  try {
    await lifecycle(env.options, (api) => api.ensureInstalled());
    const config = readFileSync(env.configPath, "utf8");
    const withoutHooks = config
      .replace(/^  pre_llm_call:\n    - command: '[^']*'\n/m, "")
      .replace(/^  on_session_end:\n    - command: '[^']*'\n/m, "");
    writeFileSync(env.configPath, withoutHooks);
    const status = collectHermesAdapterStatus(env.options);
    assert.equal(status.ok, true);
    assert.equal(status.installed, false);
    assert.equal(status.reason, "profile_drift");
  } finally {
    env.cleanup();
  }
});

test("status reports state_invalid for corrupted state", async () => {
  const env = setup();
  try {
    await lifecycle(env.options, (api) => api.ensureInstalled());
    writeFileSync(env.statePath, "{ not json");
    const status = collectHermesAdapterStatus(env.options);
    assert.equal(status.ok, false);
    assert.equal(status.reason, "state_unreadable");
    writeFileSync(env.statePath, JSON.stringify({ version: 999, runtime: "hermes" }));
    const stale = collectHermesAdapterStatus(env.options);
    assert.equal(stale.ok, false);
    assert.equal(stale.reason, "state_invalid");
  } finally {
    env.cleanup();
  }
});

test("ensureInstalled fails cleanly on malformed user hooks layout", async () => {
  const env = setup();
  try {
    writeFileSync(env.configPath, "hooks:\n  pre_llm_call: |\n    echo block\n");
    const result = await lifecycle(env.options, (api) => api.ensureInstalled());
    assert.equal(result.ok, false);
    assert.equal(result.reason, "hermes_hooks_unexpected_format");
    assert.ok(!existsSync(env.statePath));
  } finally {
    env.cleanup();
  }
});

test("hermesHome persists in state across calls without env override", async () => {
  const env = setup();
  try {
    const result = await lifecycle(env.options, (api) => api.ensureInstalled());
    assert.equal(result.ok, true);
    const status = collectHermesAdapterStatus({ ...env.options, hermesHome: undefined });
    assert.equal(status.ok, true);
    assert.equal(status.installed, true);
    assert.equal(status.managed, true);
  } finally {
    env.cleanup();
  }
});

test("MEMORAX_CODE_HERMES_COMMAND overrides resolved command", async () => {
  const env = setup();
  try {
    let invoked = [];
    env.options.runHermes = (invocation) => {
      invoked.push(invocation.command);
      return testedHermesRun()(invocation);
    };
    env.options.env = {
      ...process.env,
      HERMES_HOME: "",
      MEMORAX_CODE_HERMES_COMMAND: "custom-hermes",
    };
    env.options.windowsCliResolution = {
      spawnSync: () => ({ status: 0, stdout: "C:\\Tools\\custom-hermes.exe\n" }),
      existsSync: () => true,
    };
    const result = await lifecycle(env.options, (api) => api.ensureInstalled());
    assert.equal(result.ok, true);
    assert.ok(invoked.some((command) => command.includes("custom-hermes.exe")));
  } finally {
    env.cleanup();
  }
});

test("runtime bundle generations rotate on source change", async () => {
  const env = setup();
  try {
    const first = await lifecycle(env.options, (api) => api.ensureInstalled());
    const hookPath = join(ADAPTER_ROOT, "hooks", "memorax-code-hermes-hook.mjs");
    const original = readFileSync(hookPath, "utf8");
    writeFileSync(hookPath, `${original}\n// generation bump\n`);
    try {
      const second = await lifecycle(env.options, (api) => api.ensureInstalled());
      assert.notEqual(second.hookPath, first.hookPath);
      const generations = join(dirname(dirname(dirname(first.hookPath))));
      const entries = await (await import("node:fs/promises")).readdir(generations);
      assert.ok(entries.length <= 1);
    } finally {
      writeFileSync(hookPath, original);
    }
  } finally {
    env.cleanup();
  }
});

test("state path is stable for concurrent status reads", () => {
  const env = setup();
  try {
    const first = collectHermesAdapterStatus(env.options);
    const second = collectHermesAdapterStatus(env.options);
    assert.equal(first.reason, second.reason);
    assert.equal(first.skipped, true);
  } finally {
    env.cleanup();
  }
});

test("ensureInstalled without existing config skips cleanly", async () => {
  const env = setup();
  try {
    rmSync(env.configPath, { force: true });
    const result = await lifecycle(env.options, (api) => api.ensureInstalled());
    assert.equal(result.ok, true);
    assert.equal(result.skipped, true);
    assert.equal(result.reason, "no_existing_profiles");
  } finally {
    env.cleanup();
  }
});

test("lock serializes concurrent lifecycle operations", async () => {
  const env = setup();
  try {
    const [a, b] = await Promise.all([
      lifecycle(env.options, (api) => api.ensureInstalled()),
      lifecycle(env.options, (api) => api.ensureInstalled()),
    ]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    const config = readFileSync(env.configPath, "utf8");
    assert.equal((config.match(/memorax-code-hermes-hook\.mjs/g) ?? []).length, 2);
  } finally {
    env.cleanup();
  }
});

test("reinstall replaces stale hook entries from previous generations", async () => {
  const env = setup();
  try {
    const first = await lifecycle(env.options, (api) => api.ensureInstalled());
    const hookPath = join(ADAPTER_ROOT, "hooks", "memorax-code-hermes-hook.mjs");
    const original = readFileSync(hookPath, "utf8");
    writeFileSync(hookPath, `${original}\n// generation bump 2\n`);
    try {
      const second = await lifecycle(env.options, (api) => api.ensureInstalled());
      assert.notEqual(second.hookPath, first.hookPath);
      const config = readFileSync(env.configPath, "utf8");
      assert.equal((config.match(/memorax-code-hermes-hook\.mjs/g) ?? []).length, 2);
      assert.ok(config.includes(second.hookPath), "new generation command present");
      assert.ok(!config.includes(first.hookPath), "stale generation command removed");
      assert.equal(second.enabled, true);
      const status = collectHermesAdapterStatus(env.options);
      assert.equal(status.installed, true);
      assert.equal(status.enabled, true);
    } finally {
      writeFileSync(hookPath, original);
    }
  } finally {
    env.cleanup();
  }
});

test("reinstall keeps user hook entries untouched", async () => {
  const env = setup();
  try {
    const first = await lifecycle(env.options, (api) => api.ensureInstalled());
    writeFileSync(env.configPath, `${readFileSync(env.configPath, "utf8")}  pre_tool_call:\n    - command: 'echo user-hook'\n`);
    const hookPath = join(ADAPTER_ROOT, "hooks", "memorax-code-hermes-hook.mjs");
    const original = readFileSync(hookPath, "utf8");
    writeFileSync(hookPath, `${original}\n// generation bump 3\n`);
    try {
      const second = await lifecycle(env.options, (api) => api.ensureInstalled());
      assert.notEqual(second.hookPath, first.hookPath);
      const config = readFileSync(env.configPath, "utf8");
      assert.ok(config.includes("echo user-hook"), "user entry preserved");
      assert.ok(config.includes(second.hookPath));
      assert.ok(!config.includes(first.hookPath));
    } finally {
      writeFileSync(hookPath, original);
    }
  } finally {
    env.cleanup();
  }
});
