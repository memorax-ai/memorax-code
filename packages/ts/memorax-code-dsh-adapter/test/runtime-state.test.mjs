import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildDshCommand,
  dshCommandEnvironment,
  inspectDshDesktopCommand,
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
  const desktopRuntime = {
    version: 1, command: join(root, "Desktop", "dsh"), dshVersion: "0.2.0-rc.2",
  };
  const desktopMetadata = { ...metadata, desktopRuntime };
  const desktopState = { ...state, desktopRuntime };
  writeJson(join(pluginRoot, ".memorax-code-package.json"), desktopMetadata);
  writeJson(statePath, desktopState);
  assert.deepEqual(requireEnabledDshRuntime(pluginRoot).desktopRuntime, desktopRuntime);
  for (const invalid of [
    undefined,
    null,
    { ...desktopRuntime, version: 2 },
    { ...desktopRuntime, command: "dsh" },
    { ...desktopRuntime, command: join(root, "different", "dsh") },
    { ...desktopRuntime, dshVersion: "0.2.1-alpha.4" },
  ]) {
    writeJson(statePath, { ...desktopState, desktopRuntime: invalid });
    assert.throws(() => requireEnabledDshRuntime(pluginRoot), (error) => (
      error?.code === "MEMORAX_CODE_DSH_DISABLED"
    ));
  }

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

test("Windows Desktop expands only its native launcher without shell argument interpretation", (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "memorax-code-dsh-desktop-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const resources = join(root, "DeepSeek Harness", "resources");
  const executable = join(root, "DeepSeek Harness", "DeepSeek Harness.exe");
  const command = join(resources, "runtime", "cli", "bin", "dsh.cmd");
  mkdirSync(join(resources, "runtime", "cli", "bin"), { recursive: true });
  writeFileSync(command, "@echo off\r\n");
  writeFileSync(executable, "");
  writeFileSync(join(resources, "app.asar"), "");
  const args = ["plugin", "--profile", "desktop", "add", "file:C:\\with spaces & symbols\\plugin"];
  const options = { platform: "win32" };
  assert.deepEqual(buildDshCommand(command, args, options), [
    executable,
    "--expose-internals",
    join(resources, "app.asar", "dsh", "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "cli.js"),
    ...args,
  ]);
  assert.deepEqual(dshCommandEnvironment(command, options), { ELECTRON_RUN_AS_NODE: "1" });
  assert.equal(inspectDshDesktopCommand(command, options).command, command);
  rmSync(join(resources, "app.asar"));
  assert.equal(inspectDshDesktopCommand(command, options), undefined);
  assert.deepEqual(dshCommandEnvironment(command, options), {});
});

test("macOS Desktop discovery pins the physical native launcher behind a PATH link", (t) => {
  if (process.platform === "win32") return;
  const root = realpathSync(mkdtempSync(join(tmpdir(), "memorax-code-dsh-desktop-link-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const contents = join(root, "DeepSeek Harness.app", "Contents");
  const resources = join(contents, "Resources");
  const command = join(resources, "runtime", "cli", "bin", "dsh");
  mkdirSync(join(resources, "runtime", "cli", "bin"), { recursive: true });
  mkdirSync(join(contents, "MacOS"), { recursive: true });
  writeFileSync(command, "#!/bin/sh\n");
  writeFileSync(join(contents, "MacOS", "DeepSeek Harness"), "");
  writeFileSync(join(resources, "app.asar"), "");
  const link = join(root, "dsh");
  symlinkSync(command, link);
  assert.equal(inspectDshDesktopCommand(link, { platform: "darwin" }).command, command);
  assert.deepEqual(buildDshCommand(command, ["plugin", "--profile", "desktop", "list"]), [
    command, "plugin", "--profile", "desktop", "list",
  ]);
});

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}
