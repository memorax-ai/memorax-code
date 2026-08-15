import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { requireEnabledDshRuntime } from "../src/runtime-state.mjs";

test("re-reads the durable DSH enablement authority", (t) => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-dsh-state-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pluginRoot = join(root, "adapter");
  const sourceAdapterRoot = join(root, "installed-package", "lib", "memorax-code-dsh-adapter");
  const memoraxCodeHome = join(root, "memorax-home");
  const dshHome = join(root, "dsh-home");
  const statePath = join(memoraxCodeHome, "adapters", "dsh", "state.json");
  mkdirSync(pluginRoot, { recursive: true });
  mkdirSync(join(memoraxCodeHome, "adapters", "dsh"), { recursive: true });
  const metadata = {
    version: 1,
    memoraxCodeCommand: join(root, "memorax-code.mjs"),
    memoraxCodeHome,
    dshCommand: "dsh",
    dshHome,
    sourceAdapterRoot,
  };
  writeJson(join(pluginRoot, ".memorax-code-package.json"), metadata);
  const state = {
    version: 1,
    runtime: "dsh",
    integration: "plugin",
    enabled: true,
    memoraxCodeHome,
    dshHome,
    adapterRoot: sourceAdapterRoot,
    memoraxCodeCommand: metadata.memoraxCodeCommand,
    dshCommand: metadata.dshCommand,
    updatedAt: "2026-08-15T12:00:00.000Z",
  };
  writeJson(statePath, state);

  assert.deepEqual(requireEnabledDshRuntime(pluginRoot), {
    memoraxCodeCommand: metadata.memoraxCodeCommand,
    memoraxCodeHome,
    dshCommand: metadata.dshCommand,
    dshHome,
    revision: state.updatedAt,
  });

  writeJson(statePath, { ...state, enabled: false });
  assert.throws(
    () => requireEnabledDshRuntime(pluginRoot),
    (error) => error?.code === "MEMORAX_CODE_DSH_DISABLED",
  );
});

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}
