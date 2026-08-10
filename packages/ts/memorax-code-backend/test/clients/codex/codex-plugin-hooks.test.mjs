import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../../../dist/memorax-code.js", import.meta.url));
const pluginId = "memorax-code-codex-adapter@memorax-code";

async function runMemoraxCode(args, env, { timeoutMs = 4000 } = {}) {
  return await new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr, durationMs: Date.now() - startedAt, timedOut: Date.now() - startedAt >= timeoutMs });
    });
  });
}

async function createFakeCodex(root) {
  const path = join(root, "fake-codex.mjs");
  await writeFile(path, `#!/usr/bin/env node
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

if (process.argv[2] !== "app-server" || process.argv[3] !== "--stdio") process.exit(2);
const hooks = JSON.parse(process.env.TEST_CODEX_HOOKS ?? "[]");
const largeHookHashBytes = Number(process.env.TEST_CODEX_LARGE_HOOK_HASH_BYTES ?? "0");
if (largeHookHashBytes > 0 && hooks[0]) hooks[0].currentHash = "x".repeat(largeHookHashBytes);
const rpcLog = process.env.TEST_CODEX_RPC_LOG;
const userConfig = JSON.parse(process.env.TEST_CODEX_USER_CONFIG_JSON ?? "{}");
const configPath = join(process.env.CODEX_HOME, "config.toml");
const baseUserLayer = {
  name: { type: "user", file: configPath, profile: null },
  version: "sha256:config-before",
  config: userConfig
};
let configLayers = [baseUserLayer];
if (process.env.TEST_CODEX_CONFIG_LAYER_MODE === "missing-profile") {
  delete baseUserLayer.name.profile;
} else if (process.env.TEST_CODEX_CONFIG_LAYER_MODE === "profile-only") {
  baseUserLayer.name.profile = "review";
} else if (process.env.TEST_CODEX_CONFIG_LAYER_MODE === "no-user") {
  configLayers = [{ ...baseUserLayer, name: { type: "system", file: configPath } }];
} else if (process.env.TEST_CODEX_CONFIG_LAYER_MODE === "multiple-base") {
  configLayers.push({
    ...baseUserLayer,
    name: { type: "user", file: configPath + ".other", profile: null }
  });
} else if (process.env.TEST_CODEX_CONFIG_LAYER_MODE === "invalid-config") {
  baseUserLayer.config = null;
}
if (process.env.TEST_CODEX_IGNORE_SIGTERM === "1") {
  process.on("SIGTERM", () => {});
  setInterval(() => {}, 1000);
}
const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (rpcLog) appendFileSync(rpcLog, JSON.stringify(message) + "\\n");
  if (message.method === "initialize") {
    console.log(JSON.stringify({ id: message.id, result: { ok: true } }));
  } else if (message.method === "hooks/list") {
    if (process.env.TEST_CODEX_MALFORMED_HOOKS === "missing-data") {
      console.log(JSON.stringify({ id: message.id, result: {} }));
    } else {
      console.log(JSON.stringify({ id: message.id, result: {
        data: [{ cwd: process.cwd(), hooks, errors: [], warnings: [] }]
      } }));
    }
  } else if (message.method === "config/read") {
    console.log(JSON.stringify({ id: message.id, result: {
      config: {},
      origins: {},
      layers: configLayers
    } }));
    if (process.env.TEST_CODEX_CLOSE_STDIN_AFTER_CONFIG_READ === "1") {
      process.stdin.destroy();
      setTimeout(() => process.exit(0), 100);
    }
  } else if (message.method === "config/batchWrite") {
    if (process.env.TEST_CODEX_CONFIG_METHOD_MISSING === "1") {
      console.log(JSON.stringify({ id: message.id, error: { code: -32601, message: "Method not found" } }));
      return;
    }
    if (process.env.TEST_CODEX_CONFIG_CONFLICT === "1") {
      console.log(JSON.stringify({ id: message.id, error: {
        code: -32600,
        message: "Configuration was modified since last read. Fetch latest version and retry.",
        data: { config_write_error_code: "configVersionConflict" }
      } }));
      return;
    }
    if (process.env.TEST_CODEX_POST_WRITE_UNTRUSTED !== "1") {
      for (const edit of message.params.edits) {
        for (const hook of hooks) {
          if (edit.value === hook.currentHash && edit.keyPath.endsWith(".trusted_hash")) hook.trustStatus = "trusted";
        }
      }
    }
    console.log(JSON.stringify({ id: message.id, result: {
      status: "ok",
      version: "sha256:config-after",
      filePath: configPath,
      overriddenMetadata: null
    } }));
  }
});
`);
  await chmod(path, 0o755);
  return path;
}

function hook(name, hash, trustStatus = "untrusted", overrides = {}) {
  return {
    pluginId,
    key: `${pluginId}:hooks/hooks.json:${name}`,
    currentHash: hash,
    trustStatus,
    handlerType: "command",
    eventName: "sessionStart",
    command: `node "$PLUGIN_ROOT/hooks/${name}.mjs"`,
    statusMessage: `Running ${name}`,
    ...overrides,
  };
}

test("codex-plugin hooks preserves Codex trust and command metadata", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-hooks-inspect-"));
  const home = join(root, "home");
  const codexHome = join(home, "codex");
  try {
    await mkdir(codexHome, { recursive: true });
    const fakeCodex = await createFakeCodex(root);
    const current = hook("new-hook", "sha256:new");
    const result = await runMemoraxCode([
      "codex-plugin", "hooks", "--codex-command", fakeCodex, "--workspace", root, "--json",
    ], {
      HOME: home,
      CODEX_HOME: codexHome,
      TEST_CODEX_HOOKS: JSON.stringify([current, {
        ...current,
        pluginId: "unrelated-plugin@marketplace",
        key: "unrelated-plugin@marketplace:hooks/hooks.json:other",
      }]),
    });

    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.action, "codex-plugin-hooks");
    assert.deepEqual(report.hooks, [current]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("codex-plugin trust-hooks check returns only new and hash-changed hooks", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-hooks-check-"));
  const home = join(root, "home");
  const codexHome = join(home, "codex");
  try {
    await mkdir(codexHome, { recursive: true });
    const fakeCodex = await createFakeCodex(root);
    const current = [
      hook("trusted-unchanged", "sha256:same", "trusted"),
      hook("managed", "sha256:managed", "managed"),
      hook("declined-unchanged", "sha256:declined"),
      hook("changed", "sha256:after"),
      hook("new", "sha256:new"),
    ];
    const previous = [
      hook("trusted-unchanged", "sha256:same", "trusted"),
      hook("managed", "sha256:managed", "managed"),
      hook("declined-unchanged", "sha256:declined"),
      hook("changed", "sha256:before", "trusted"),
    ];
    const result = await runMemoraxCode([
      "codex-plugin", "trust-hooks", "--check", "--codex-command", fakeCodex, "--workspace", root, "--json",
    ], {
      HOME: home,
      CODEX_HOME: codexHome,
      TEST_CODEX_HOOKS: JSON.stringify(current),
      MEMORAX_CODE_CODEX_PREVIOUS_HOOKS_JSON: JSON.stringify(previous),
    });

    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.checkedOnly, true);
    assert.equal(report.requiresFullReview, false);
    assert.deepEqual(report.hooks.map((item) => item.key), [current[3].key, current[4].key]);
    assert.equal(report.trustedHooks, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("codex-plugin trust-hooks batch-writes only the reviewed Hook selection", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-hooks-trust-"));
  const home = join(root, "home");
  const codexHome = join(home, "codex");
  try {
    await mkdir(codexHome, { recursive: true });
    const fakeCodex = await createFakeCodex(root);
    const changed = hook("changed", "sha256:after");
    const added = hook('new-"quoted"\\path', "sha256:new");
    const second = hook("second", "sha256:second");
    const rpcLog = join(root, "rpc.log");
    const result = await runMemoraxCode([
      "codex-plugin", "trust-hooks", "--yes", "--codex-command", fakeCodex, "--workspace", root, "--json",
    ], {
      HOME: home,
      CODEX_HOME: codexHome,
      TEST_CODEX_HOOKS: JSON.stringify([changed, added, second]),
      TEST_CODEX_RPC_LOG: rpcLog,
      TEST_CODEX_USER_CONFIG_JSON: JSON.stringify({
        provider_api_key: "must-not-leak",
        hooks: { state: { "another-plugin@external:hooks/hooks.json:existing": { trusted_hash: "sha256:existing" } } },
      }),
      MEMORAX_CODE_CODEX_HOOK_TRUST_SELECTION_JSON: JSON.stringify([added, second]),
    });

    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(result.stdout);
    assert.equal(report.trustedHooks, 2);
    assert.deepEqual(report.hooks.map((item) => item.key), [added.key, second.key]);
    const requests = (await readFile(rpcLog, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    const batch = requests.find((request) => request.method === "config/batchWrite");
    assert(batch);
    assert.equal(batch.params.filePath, join(codexHome, "config.toml"));
    assert.equal(batch.params.expectedVersion, "sha256:config-before");
    assert.equal(batch.params.reloadUserConfig, true);
    assert.deepEqual(batch.params.edits, [
      {
        keyPath: `hooks.state."${added.key.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}".trusted_hash`,
        value: added.currentHash,
        mergeStrategy: "upsert",
      },
      {
        keyPath: `hooks.state."${second.key}".trusted_hash`,
        value: second.currentHash,
        mergeStrategy: "upsert",
      },
    ]);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /must-not-leak/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("codex-plugin trust-hooks rejects a Hook that changed after review", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-hooks-race-"));
  const home = join(root, "home");
  const codexHome = join(home, "codex");
  try {
    await mkdir(codexHome, { recursive: true });
    const fakeCodex = await createFakeCodex(root);
    const current = hook("changed-again", "sha256:after");
    const configPath = join(codexHome, "config.toml");
    await writeFile(configPath, 'model = "unchanged"\n');
    const result = await runMemoraxCode([
      "codex-plugin", "trust-hooks", "--yes", "--codex-command", fakeCodex, "--workspace", root, "--json",
    ], {
      HOME: home,
      CODEX_HOME: codexHome,
      TEST_CODEX_HOOKS: JSON.stringify([current]),
      MEMORAX_CODE_CODEX_HOOK_TRUST_SELECTION_JSON: JSON.stringify([{ ...current, currentHash: "sha256:reviewed" }]),
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /hook changed after review/i);
    assert.equal(await readFile(configPath, "utf8"), 'model = "unchanged"\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("codex-plugin hooks rejects malformed hooks/list payloads", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-hooks-malformed-"));
  const home = join(root, "home");
  const codexHome = join(home, "codex");
  try {
    await mkdir(codexHome, { recursive: true });
    const fakeCodex = await createFakeCodex(root);
    const missingData = await runMemoraxCode([
      "codex-plugin", "hooks", "--codex-command", fakeCodex, "--workspace", root, "--json",
    ], {
      HOME: home,
      CODEX_HOME: codexHome,
      TEST_CODEX_MALFORMED_HOOKS: "missing-data",
    });
    assert.equal(missingData.code, 1);
    assert.match(missingData.stderr, /invalid result\.data/i);

    const incompleteHook = hook("incomplete", "sha256:incomplete");
    delete incompleteHook.currentHash;
    const incomplete = await runMemoraxCode([
      "codex-plugin", "hooks", "--codex-command", fakeCodex, "--workspace", root, "--json",
    ], {
      HOME: home,
      CODEX_HOME: codexHome,
      TEST_CODEX_HOOKS: JSON.stringify([incompleteHook]),
    });
    assert.equal(incomplete.code, 1);
    assert.match(incomplete.stderr, /incomplete MemoraX Code hook metadata/i);

    for (const field of ["handlerType", "eventName", "command"]) {
      const missingReviewField = hook(`missing-${field}`, `sha256:missing-${field}`);
      delete missingReviewField[field];
      const missing = await runMemoraxCode([
        "codex-plugin", "hooks", "--codex-command", fakeCodex, "--workspace", root, "--json",
      ], {
        HOME: home,
        CODEX_HOME: codexHome,
        TEST_CODEX_HOOKS: JSON.stringify([missingReviewField]),
      });
      assert.equal(missing.code, 1, field);
      assert.match(missing.stderr, /incomplete MemoraX Code hook metadata/i, field);
    }

    const unknownTrustStatus = hook("unknown-trust", "sha256:unknown-trust", "future-status");
    const unknownTrust = await runMemoraxCode([
      "codex-plugin", "hooks", "--codex-command", fakeCodex, "--workspace", root, "--json",
    ], {
      HOME: home,
      CODEX_HOME: codexHome,
      TEST_CODEX_HOOKS: JSON.stringify([unknownTrustStatus]),
    });
    assert.equal(unknownTrust.code, 1);
    assert.match(unknownTrust.stderr, /incomplete MemoraX Code hook metadata/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const { mode, expected } of [
  { mode: "missing-profile", expected: /invalid user config layer/i },
  { mode: "profile-only", expected: /0 base user config layers/i },
  { mode: "no-user", expected: /0 base user config layers/i },
  { mode: "multiple-base", expected: /2 base user config layers/i },
  { mode: "invalid-config", expected: /invalid base user config layer/i },
]) {
  test(`codex-plugin trust-hooks rejects ambiguous or malformed base user config layers: ${mode}`, async () => {
    const root = await mkdtemp(join(tmpdir(), `memorax-code-codex-hooks-layer-${mode}-`));
    const home = join(root, "home");
    const codexHome = join(home, "codex");
    const rpcLog = join(root, "rpc.log");
    try {
      await mkdir(codexHome, { recursive: true });
      const fakeCodex = await createFakeCodex(root);
      const selected = hook(`layer-${mode}`, `sha256:layer-${mode}`);
      const result = await runMemoraxCode([
        "codex-plugin", "trust-hooks", "--yes", "--codex-command", fakeCodex, "--workspace", root, "--json",
      ], {
        HOME: home,
        CODEX_HOME: codexHome,
        TEST_CODEX_HOOKS: JSON.stringify([selected]),
        TEST_CODEX_RPC_LOG: rpcLog,
        TEST_CODEX_CONFIG_LAYER_MODE: mode,
        MEMORAX_CODE_CODEX_HOOK_TRUST_SELECTION_JSON: JSON.stringify([selected]),
      });
      assert.equal(result.code, 1, result.stderr);
      assert.match(result.stderr, expected);
      const requests = (await readFile(rpcLog, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
      assert.equal(requests.some((request) => request.method === "config/batchWrite"), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("codex-plugin trust-hooks fails closed on config version conflicts without retrying", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-hooks-conflict-"));
  const home = join(root, "home");
  const codexHome = join(home, "codex");
  const rpcLog = join(root, "rpc.log");
  try {
    await mkdir(codexHome, { recursive: true });
    const fakeCodex = await createFakeCodex(root);
    const selected = hook("conflict", "sha256:conflict");
    const result = await runMemoraxCode([
      "codex-plugin", "trust-hooks", "--yes", "--codex-command", fakeCodex, "--workspace", root, "--json",
    ], {
      HOME: home,
      CODEX_HOME: codexHome,
      TEST_CODEX_HOOKS: JSON.stringify([selected]),
      TEST_CODEX_RPC_LOG: rpcLog,
      TEST_CODEX_CONFIG_CONFLICT: "1",
      MEMORAX_CODE_CODEX_HOOK_TRUST_SELECTION_JSON: JSON.stringify([selected]),
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /modified since last read/i);
    const requests = (await readFile(rpcLog, "utf8")).trim().split(/\r?\n/).map((line) => JSON.parse(line));
    assert.equal(requests.filter((request) => request.method === "config/batchWrite").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("codex-plugin trust-hooks does not fall back when config/batchWrite is unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-hooks-method-"));
  const home = join(root, "home");
  const codexHome = join(home, "codex");
  const configPath = join(codexHome, "config.toml");
  try {
    await mkdir(codexHome, { recursive: true });
    await writeFile(configPath, 'model = "preserved"\n');
    const fakeCodex = await createFakeCodex(root);
    const selected = hook("method-missing", "sha256:method");
    const result = await runMemoraxCode([
      "codex-plugin", "trust-hooks", "--yes", "--codex-command", fakeCodex, "--workspace", root, "--json",
    ], {
      HOME: home,
      CODEX_HOME: codexHome,
      TEST_CODEX_HOOKS: JSON.stringify([selected]),
      TEST_CODEX_CONFIG_METHOD_MISSING: "1",
      MEMORAX_CODE_CODEX_HOOK_TRUST_SELECTION_JSON: JSON.stringify([selected]),
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Method not found/);
    assert.equal(await readFile(configPath, "utf8"), 'model = "preserved"\n');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("codex-plugin trust-hooks verifies the selected Hooks after batch writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-hooks-verify-"));
  const home = join(root, "home");
  const codexHome = join(home, "codex");
  try {
    await mkdir(codexHome, { recursive: true });
    const fakeCodex = await createFakeCodex(root);
    const selected = hook("not-reloaded", "sha256:not-reloaded");
    const result = await runMemoraxCode([
      "codex-plugin", "trust-hooks", "--yes", "--codex-command", fakeCodex, "--workspace", root, "--json",
    ], {
      HOME: home,
      CODEX_HOME: codexHome,
      TEST_CODEX_HOOKS: JSON.stringify([selected]),
      TEST_CODEX_POST_WRITE_UNTRUSTED: "1",
      MEMORAX_CODE_CODEX_HOOK_TRUST_SELECTION_JSON: JSON.stringify([selected]),
    });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /trust could not be verified/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("codex-plugin trust-hooks handles app-server stdin errors without crashing", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-hooks-broken-pipe-"));
  const home = join(root, "home");
  const codexHome = join(home, "codex");
  try {
    await mkdir(codexHome, { recursive: true });
    const fakeCodex = await createFakeCodex(root);
    const selected = hook("broken-pipe", "sha256:placeholder");
    const result = await runMemoraxCode([
      "codex-plugin", "trust-hooks", "--yes", "--codex-command", fakeCodex, "--workspace", root, "--json",
    ], {
      HOME: home,
      CODEX_HOME: codexHome,
      TEST_CODEX_HOOKS: JSON.stringify([selected]),
      TEST_CODEX_LARGE_HOOK_HASH_BYTES: String(8 * 1024 * 1024),
      TEST_CODEX_CLOSE_STDIN_AFTER_CONFIG_READ: "1",
    }, { timeoutMs: 8000 });
    assert.equal(result.code, 1);
    assert.equal(result.timedOut, false);
    assert.doesNotMatch(result.stderr, /Unhandled 'error' event/);
    assert.match(result.stderr, /EPIPE|broken pipe|exited before completing|request was closed/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("codex-plugin hooks exits within a fixed bound when app-server ignores SIGTERM", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-hooks-stubborn-"));
  const home = join(root, "home");
  const codexHome = join(home, "codex");
  try {
    await mkdir(codexHome, { recursive: true });
    const fakeCodex = await createFakeCodex(root);
    const current = hook("stubborn", "sha256:stubborn");
    const result = await runMemoraxCode([
      "codex-plugin", "hooks", "--codex-command", fakeCodex, "--workspace", root, "--json",
    ], {
      HOME: home,
      CODEX_HOME: codexHome,
      TEST_CODEX_HOOKS: JSON.stringify([current]),
      TEST_CODEX_IGNORE_SIGTERM: "1",
    });
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(result.timedOut, false);
    assert(result.durationMs < 2500, `command took ${result.durationMs}ms`);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
