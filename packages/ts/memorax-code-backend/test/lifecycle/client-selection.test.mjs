import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  clearActiveManagedClients,
  readActiveManagedClients,
  writeActiveManagedClients,
} from "../../dist/lifecycle/active-clients.js";
import {
  loadManagedClientsConfig,
  parseManagedClients,
  resolveManagedClients,
} from "../../dist/lifecycle/client-selection.js";

test("managed clients default to all integrations", () => {
  assert.deepEqual(resolveManagedClients([], {}), { codex: true, claude: true, opencode: true });
});

test("managed clients use persisted config", () => {
  assert.deepEqual(resolveManagedClients([], { clients: { codex: true, claude: false } }), {
    codex: true,
    claude: false,
    opencode: false,
  });
  assert.deepEqual(resolveManagedClients([], { clients: { codex: false, claude: true, opencode: true } }), {
    codex: false,
    claude: true,
    opencode: true,
  });
});

test("--clients overrides persisted config", () => {
  assert.deepEqual(resolveManagedClients([
    "--clients", "claude",
  ], { clients: { codex: true, claude: false } }), {
    codex: false,
    claude: true,
    opencode: false,
  });
});

test("--clients accepts exact client sets", () => {
  assert.deepEqual(parseManagedClients("codex"), { codex: true, claude: false, opencode: false });
  assert.deepEqual(parseManagedClients("claude"), { codex: false, claude: true, opencode: false });
  assert.deepEqual(parseManagedClients("opencode"), { codex: false, claude: false, opencode: true });
  assert.deepEqual(parseManagedClients("codex,opencode"), { codex: true, claude: false, opencode: true });
  assert.deepEqual(parseManagedClients("codex,claude,opencode"), { codex: true, claude: true, opencode: true });
  assert.deepEqual(parseManagedClients("all"), { codex: true, claude: true, opencode: true });
  assert.deepEqual(parseManagedClients("none"), { codex: false, claude: false, opencode: false });
});

test("--clients rejects missing and unknown values", () => {
  assert.throws(() => resolveManagedClients(["--clients"], {}), /invalid --clients value/);
  assert.throws(() => parseManagedClients("codex,other"), /invalid --clients value/);
});

test("managed clients config accepts legal TOML table comments and quoted names", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-client-selection-"));
  try {
    await writeFile(join(home, "config.toml"), [
      '["clients"] # Keep Claude outside this lifecycle.',
      "codex = true",
      "claude = false",
      "",
    ].join("\n"));
    assert.deepEqual(loadManagedClientsConfig(home), {
      clients: { codex: true, claude: false },
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("managed clients config rejects invalid lifecycle TOML", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-client-selection-invalid-"));
  try {
    await writeFile(join(home, "config.toml"), [
      "[clients]",
      "codex = false",
      "claude = false",
      "",
      "broken = [",
      "",
    ].join("\n"));
    assert.throws(
      () => loadManagedClientsConfig(home),
      /failed to parse MemoraX Code lifecycle config/,
    );

    await writeFile(join(home, "config.toml"), [
      "[clients]",
      'codex = "true"',
      "claude = false",
      "",
    ].join("\n"));
    assert.throws(
      () => loadManagedClientsConfig(home),
      /clients\.codex must be a boolean/,
    );

    await writeFile(join(home, "config.toml"), 'model = "not-a-table"\n');
    assert.deepEqual(loadManagedClientsConfig(home), {});

  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("active managed clients persist and clear independently of config", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-active-client-selection-"));
  try {
    assert.equal(readActiveManagedClients(home), undefined);
    writeActiveManagedClients(home, { codex: false, claude: true, opencode: true });
    assert.deepEqual(readActiveManagedClients(home), { codex: false, claude: true, opencode: true });
    assert.deepEqual(
      JSON.parse(await readFile(join(home, "runtime", "backend", "managed-clients.json"), "utf8")),
      { codex: false, claude: true, opencode: true },
    );
    clearActiveManagedClients(home);
    assert.equal(readActiveManagedClients(home), undefined);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("active managed clients migrate legacy state without OpenCode to disabled", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-active-client-selection-legacy-"));
  try {
    const stateDir = join(home, "runtime", "backend");
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "managed-clients.json"), JSON.stringify({
      codex: true,
      claude: false,
    }));
    assert.deepEqual(readActiveManagedClients(home), {
      codex: true,
      claude: false,
      opencode: false,
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
