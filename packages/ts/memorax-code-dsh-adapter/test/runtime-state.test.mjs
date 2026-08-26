import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildDshCommand,
  requireDshRuntimeAuthority,
  requireEnabledDshRuntime,
} from "../src/runtime-state.mjs";

test("re-reads durable DSH authority without pinning the host version", (t) => {
  const root = mkdtempSync(join(tmpdir(), "memorax-code-dsh-state-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const pluginRoot = join(root, "profile", "node_modules", "@memorax-code", "dsh-memorax-code");
  const sourceAdapterRoot = join(root, "installed-package", "lib", "memorax-code-dsh-adapter");
  const memoraxCodeHome = join(root, "memorax-home");
  const runtimeBundleRoot = join(
    memoraxCodeHome,
    "adapters",
    "dsh",
    "runtime",
    "generations",
    "generation-1",
  );
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
    dshVersion: "0.1.0-rc.6",
    sourceAdapterRoot,
    runtimeBundleRoot,
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
    runtimeBundleRoot,
    memoraxCodeCommand: metadata.memoraxCodeCommand,
    dshCommand: metadata.dshCommand,
    dshVersion: metadata.dshVersion,
    profiles: ["web"],
    updatedAt: "2026-08-15T12:00:00.000Z",
  };
  writeJson(statePath, state);

  assert.deepEqual(requireEnabledDshRuntime(pluginRoot), {
    memoraxCodeCommand: metadata.memoraxCodeCommand,
    memoraxCodeHome,
    dshCommand: metadata.dshCommand,
    dshHome,
    dshVersion: metadata.dshVersion,
    profiles: ["web"],
    revision: state.updatedAt,
  });

  writeJson(statePath, { ...state, enabled: false });
  assert.equal(requireDshRuntimeAuthority(pluginRoot).enabled, false);
  assert.throws(
    () => requireEnabledDshRuntime(pluginRoot),
    (error) => error?.code === "MEMORAX_CODE_DSH_DISABLED",
  );

  writeJson(statePath, state);
  writeJson(statePath, { ...state, dshVersion: "0.1.0-rc.7" });
  assert.throws(
    () => requireEnabledDshRuntime(pluginRoot),
    (error) => error?.code === "MEMORAX_CODE_DSH_DISABLED",
  );

  const updatedMetadata = { ...metadata, dshVersion: "0.1.0-rc.7" };
  const updatedState = { ...state, dshVersion: "0.1.0-rc.7" };
  writeJson(join(pluginRoot, ".memorax-code-package.json"), updatedMetadata);
  writeJson(statePath, updatedState);
  assert.equal(requireEnabledDshRuntime(pluginRoot).dshVersion, "0.1.0-rc.7");
  assert.throws(
    () => buildDshCommand("npx", ["@deepseek-ai/dsh", "--version"]),
    (error) => error?.code === "MEMORAX_CODE_DSH_DISABLED",
  );
});

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}
