import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { recordWorkspaceEvidence } from "../../memorax-code-adapter-common/src/hooks/capture-cwd-hook.mjs";
import { readOpenCodeWorkspaceStatus } from "../src/diagnostics.mjs";
import { ensureOpenCodePluginInstalled } from "../src/plugin-install.mjs";

const cliPath = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

test("OpenCode workspace evidence honors the explicit MemoraX Code home", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-opencode-workspace-evidence-"));
  const memoraxCodeHome = join(root, "explicit-home");
  const environmentHome = join(root, "environment-home");
  const pluginData = join(root, "plugin-data");
  const workspace = join(root, "workspace");
  const previousHome = process.env.MEMORAX_CODE_HOME;
  const previousPluginData = process.env.PLUGIN_DATA;
  try {
    await mkdir(workspace, { recursive: true });
    const canonicalWorkspace = await realpath(workspace);
    process.env.MEMORAX_CODE_HOME = environmentHome;
    process.env.PLUGIN_DATA = pluginData;
    recordWorkspaceEvidence({
      adapterDir: "opencode",
      memoraxCodeHome,
      runtime: "opencode",
      sessionKeyPrefix: "opencode",
    }, {
      event: "plugin.load",
      cwd: workspace,
    });

    const status = readOpenCodeWorkspaceStatus({ memoraxCodeHome });
    assert.equal(status.ok, true);
    assert.equal(status.captured, true);
    assert.equal(status.latest.event, "plugin.load");
    assert.equal(status.latest.cwd, canonicalWorkspace);
    await assert.rejects(
      readFile(join(environmentHome, "adapters", "opencode", "workspaces.json")),
      /ENOENT/,
    );
    await assert.rejects(readFile(join(pluginData, "workspaces.json")), /ENOENT/);
    await assert.rejects(
      readFile(join(memoraxCodeHome, "adapters", "opencode", "session-registry.json")),
      /ENOENT/,
    );
  } finally {
    if (previousHome === undefined) delete process.env.MEMORAX_CODE_HOME;
    else process.env.MEMORAX_CODE_HOME = previousHome;
    if (previousPluginData === undefined) delete process.env.PLUGIN_DATA;
    else process.env.PLUGIN_DATA = previousPluginData;
    await rm(root, { recursive: true, force: true });
  }
});

test("memorax-code-opencode reports managed status and runtime doctor evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-opencode-doctor-"));
  const memoraxCodeHome = join(root, "memorax-code-home");
  const openCodeConfigDir = join(root, "opencode-config");
  const workspace = join(root, "workspace");
  const backendUrl = "http://127.0.0.1:9";
  try {
    await mkdir(workspace, { recursive: true });
    const installed = ensureOpenCodePluginInstalled({
      memoraxCodeHome,
      openCodeConfigDir,
      backendUrl,
    });
    assert.equal(installed.ok, true);
    recordWorkspaceEvidence({
      adapterDir: "opencode",
      memoraxCodeHome,
      runtime: "opencode",
      sessionKeyPrefix: "opencode",
    }, {
      event: "plugin.load",
      cwd: workspace,
    });

    const commonArgs = [
      "--memorax-code-home", memoraxCodeHome,
      "--opencode-config-dir", openCodeConfigDir,
      "--backend-url", backendUrl,
      "--json",
    ];
    const statusRun = await runCli(["status", ...commonArgs]);
    assert.equal(statusRun.code, 0, statusRun.stderr);
    const status = JSON.parse(statusRun.stdout);
    assert.equal(status.ok, true);
    assert.equal(status.action, "status");
    assert.equal(status.current, true);

    const doctorRun = await runCli(["doctor", ...commonArgs]);
    assert.equal(doctorRun.code, 1, doctorRun.stderr);
    const doctor = JSON.parse(doctorRun.stdout);
    assert.equal(doctor.action, "doctor");
    assert.equal(doctor.status.ok, true);
    assert.equal(doctor.workspace.captured, true);
    assert.equal(doctor.backend.ok, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      resolve({ code: signal ? 1 : code, signal, stdout, stderr });
    });
  });
}
