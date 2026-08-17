import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { recordWorkspaceEvidence } from "../../memorax-code-adapter-common/src/hooks/capture-cwd-hook.mjs";
import { ensureOpenCodePluginInstalled } from "../src/plugin-install.mjs";

const cliPath = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));

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
