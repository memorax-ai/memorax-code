import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { freePort } from "../support/helpers.mjs";
import { pathExists, runCli } from "./support/backend-service-fixtures.mjs";

test("OpenCode lifecycle installs, reports healthy status, and uninstalls", { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-opencode-lifecycle-home-"));
  const openCodeConfigDir = await mkdtemp(join(tmpdir(), "memorax-code-opencode-lifecycle-config-"));
  const port = await freePort();
  const cliPath = fileURLToPath(new URL("../../dist/memorax-code.js", import.meta.url));
  const commonArgs = [
    "--home", home,
    "--port", String(port),
    "--opencode-config-dir", openCodeConfigDir,
  ];
  const statePath = join(home, "adapters", "opencode", "state.json");
  const activeClientsPath = join(home, "runtime", "backend", "managed-clients.json");
  const pluginPath = join(openCodeConfigDir, "plugins", "memorax-code.js");
  const skillPath = join(openCodeConfigDir, "skills", "memorax-code", "SKILL.md");
  try {
    const started = await runCli(cliPath, [
      "start", "--json", ...commonArgs, "--clients", "opencode",
    ]);
    assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`);
    const startReport = JSON.parse(started.stdout);
    assert.equal(startReport.opencodeAdapter.enabled, true);
    assert.equal(startReport.opencodeAdapter.backendUrlMatches, true);
    assert.equal(startReport.opencodeAdapter.opencodeSkills.ok, true);
    assert.equal(await pathExists(pluginPath), true);
    assert.equal(await pathExists(skillPath), true);
    assert.deepEqual(JSON.parse(await readFile(activeClientsPath, "utf8")), {
      codex: false,
      claude: false,
      opencode: true,
    });

    const status = await runCli(cliPath, [
      "status", "--json", ...commonArgs, "--clients", "opencode",
    ]);
    assert.equal(status.code, 0, `${status.stdout}\n${status.stderr}`);
    const statusReport = JSON.parse(status.stdout);
    assert.equal(statusReport.ok, true);
    assert.equal(statusReport.opencodeAdapter.enabled, true);

    const uninstalled = await runCli(cliPath, [
      "uninstall", "--json", ...commonArgs,
      "--clients", "opencode",
      "--no-npm-uninstall",
    ]);
    assert.equal(uninstalled.code, 0, `${uninstalled.stdout}\n${uninstalled.stderr}`);
    const uninstallReport = JSON.parse(uninstalled.stdout);
    assert.equal(uninstallReport.opencodeAdapter.pluginRemove.ok, true);
    assert.equal(await pathExists(pluginPath), false);
    assert.equal(await pathExists(skillPath), false);
    assert.equal(await pathExists(statePath), false);
    assert.equal(await pathExists(activeClientsPath), false);
  } finally {
    await runCli(cliPath, ["stop", "--json", ...commonArgs, "--clients", "none"]);
    await rm(home, { recursive: true, force: true });
    await rm(openCodeConfigDir, { recursive: true, force: true });
  }
});
