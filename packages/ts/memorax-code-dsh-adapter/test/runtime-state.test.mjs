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
  const dshPackageRoot = join(root, "node_modules", "@deepseek-ai", "dsh");
  const hostEntrypoint = join(dshPackageRoot, "lib", "bin.js");
  const statePath = join(memoraxCodeHome, "adapters", "dsh", "state.json");
  mkdirSync(pluginRoot, { recursive: true });
  mkdirSync(join(memoraxCodeHome, "adapters", "dsh"), { recursive: true });
  mkdirSync(join(dshPackageRoot, "lib"), { recursive: true });
  writeFileSync(hostEntrypoint, "#!/usr/bin/env node\n");
  writeJson(join(dshPackageRoot, "package.json"), {
    name: "@deepseek-ai/dsh",
    version: "0.1.0-rc.6",
  });
  const metadata = {
    version: 1,
    memoraxCodeCommand: join(root, "memorax-code.mjs"),
    memoraxCodeHome,
    dshCommand: "dsh",
    dshHome,
    dshVersion: "0.1.0-rc.6",
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
    dshVersion: metadata.dshVersion,
    updatedAt: "2026-08-15T12:00:00.000Z",
  };
  writeJson(statePath, state);

  assert.deepEqual(requireEnabledDshRuntime(pluginRoot, { hostEntrypoint }), {
    memoraxCodeCommand: metadata.memoraxCodeCommand,
    memoraxCodeHome,
    dshCommand: metadata.dshCommand,
    dshHome,
    revision: state.updatedAt,
  });

  writeJson(statePath, { ...state, enabled: false });
  assert.throws(
    () => requireEnabledDshRuntime(pluginRoot, { hostEntrypoint }),
    (error) => error?.code === "MEMORAX_CODE_DSH_DISABLED",
  );

  writeJson(statePath, state);
  writeJson(join(dshPackageRoot, "package.json"), {
    name: "@deepseek-ai/dsh",
    version: "0.1.0-rc.7",
  });
  assert.throws(
    () => requireEnabledDshRuntime(pluginRoot, { hostEntrypoint }),
    (error) => error?.code === "MEMORAX_CODE_DSH_DISABLED",
  );

  writeJson(join(dshPackageRoot, "package.json"), {
    name: "@deepseek-ai/dsh",
    version: "0.1.0-rc.6",
  });
  writeJson(join(dshPackageRoot, "lib", "package.json"), {
    name: "not-the-dsh-host",
    version: "0.1.0-rc.6",
  });
  assert.throws(
    () => requireEnabledDshRuntime(pluginRoot, { hostEntrypoint }),
    (error) => error?.code === "MEMORAX_CODE_DSH_DISABLED",
  );

  rmSync(join(dshPackageRoot, "lib", "package.json"));
  writeJson(statePath, { ...state, dshVersion: "0.1.0-rc.7" });
  assert.throws(
    () => requireEnabledDshRuntime(pluginRoot, { hostEntrypoint }),
    (error) => error?.code === "MEMORAX_CODE_DSH_DISABLED",
  );
});

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}
