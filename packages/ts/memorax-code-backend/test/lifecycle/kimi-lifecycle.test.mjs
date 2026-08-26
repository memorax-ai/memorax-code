import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { freePort } from "../support/helpers.mjs";
import { pathExists, runCli } from "./support/backend-service-fixtures.mjs";

test("Kimi participates in lifecycle selection and manages native Hooks", { timeout: 30_000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-code-kimi-lifecycle-home-"));
  const kimiHome = await mkdtemp(join(tmpdir(), "memorax-code-kimi-lifecycle-config-"));
  const port = await freePort();
  const cliPath = fileURLToPath(new URL("../../dist/memorax-code.js", import.meta.url));
  const commonArgs = [
    "--home", home,
    "--port", String(port),
    "--kimi-home", kimiHome,
    "--kimi-command", process.execPath,
  ];
  const statePath = join(home, "adapters", "kimi", "state.json");
  const skillPath = join(kimiHome, "skills", "memorax-code", "SKILL.md");
  const activeClientsPath = join(home, "runtime", "backend", "managed-clients.json");
  const configPath = join(kimiHome, "config.toml");
  try {
    await writeFile(configPath, "[providers.example]\nmodel = \"local\"\n");
    const started = await runCli(cliPath, ["start", "--json", ...commonArgs, "--clients", "kimi"]);
    assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`);
    const startReport = JSON.parse(started.stdout);
    assert.equal(startReport.kimiAdapter.enabled, true);
    assert.equal((await readFile(configPath, "utf8")).match(/# MemoraX Code Kimi Adapter/g)?.length, 6);
    assert.match(await readFile(skillPath, "utf8"), /memorax-cli/);
    assert.deepEqual(JSON.parse(await readFile(activeClientsPath, "utf8")), {
      codex: false, claude: false, dsh: false, opencode: false, kimi: true,
    });

    const status = await runCli(cliPath, ["status", "--json", ...commonArgs, "--clients", "kimi"]);
    assert.equal(status.code, 0, `${status.stdout}\n${status.stderr}`);
    assert.equal(JSON.parse(status.stdout).kimiAdapter.enabled, true);

    const stopped = await runCli(cliPath, ["stop", "--json", ...commonArgs, "--clients", "kimi"]);
    assert.equal(stopped.code, 0, `${stopped.stdout}\n${stopped.stderr}`);
    assert.equal(JSON.parse(stopped.stdout).kimiAdapter.enabled, false);
    assert.doesNotMatch(await readFile(configPath, "utf8"), /MemoraX Code Kimi Adapter/);
    assert.equal(await pathExists(skillPath), true);

    const uninstalled = await runCli(cliPath, ["uninstall", "--json", ...commonArgs, "--clients", "kimi", "--no-npm-uninstall"]);
    assert.equal(uninstalled.code, 0, `${uninstalled.stdout}\n${uninstalled.stderr}`);
    assert.equal(await pathExists(statePath), false);
    assert.equal(await pathExists(skillPath), false);
  } finally {
    await runCli(cliPath, ["stop", "--json", ...commonArgs, "--clients", "none"]);
    await rm(home, { recursive: true, force: true });
    await rm(kimiHome, { recursive: true, force: true });
  }
});
