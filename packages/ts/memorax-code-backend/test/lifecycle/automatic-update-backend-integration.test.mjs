import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const serviceEntrypoint = fileURLToPath(new URL("../../dist/service-entrypoint.js", import.meta.url));

test("running managed Backend dispatches an overdue update without a client Session event", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-backend-update-integration-"));
  const memoraxCodeHome = join(root, "memorax-code-home");
  const packageRoot = join(root, "installed-package");
  const updateRecordPath = join(root, "update-dispatched.json");
  const packageCommand = join(packageRoot, "bin", "memorax-code.mjs");
  const instanceId = "automatic-update-integration";
  const port = await availablePort();
  let backend;
  try {
    await writeSetupCompletion(memoraxCodeHome);
    await writeOverdueUpdateState(memoraxCodeHome);
    await mkdir(dirname(packageCommand), { recursive: true });
    await writeFile(join(packageRoot, "package.json"), `${JSON.stringify({
      name: "@memorax/memorax-code",
      version: "0.1.9",
      type: "module",
    })}\n`);
    await writeFile(packageCommand, [
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'import { dirname, join } from "node:path";',
      'const home = process.env.MEMORAX_CODE_HOME;',
      'const now = Date.now();',
      'const statePath = join(home, "runtime", "install", "automatic-update.json");',
      'mkdirSync(dirname(statePath), { recursive: true });',
      'writeFileSync(statePath, `${JSON.stringify({',
      '  version: 1,',
      '  installedVersion: "0.1.9",',
      '  nextCheckAt: new Date(now + 8 * 60 * 60 * 1000).toISOString(),',
      '})}\\n`);',
      'writeFileSync(process.env.MEMORAX_CODE_TEST_UPDATE_RECORD, `${JSON.stringify({',
      '  args: process.argv.slice(2),',
      '  automaticUpdateProcess: process.env.MEMORAX_CODE_AUTOMATIC_UPDATE_PROCESS,',
      '})}\\n`);',
      "",
    ].join("\n"));

    backend = spawn(process.execPath, [
      serviceEntrypoint,
      "--memorax-code-backend-instance",
      instanceId,
    ], {
      env: {
        ...process.env,
        MEMORAX_CODE_AUTOMATIC_UPDATE_PROCESS: "",
        MEMORAX_CODE_AUTO_UPDATE: "1",
        MEMORAX_CODE_BACKEND_HOST: "127.0.0.1",
        MEMORAX_CODE_BACKEND_INSTANCE_ID: instanceId,
        MEMORAX_CODE_BACKEND_PORT: String(port),
        MEMORAX_CODE_HOME: memoraxCodeHome,
        MEMORAX_CODE_INSTALL_WATCHDOG: "0",
        MEMORAX_CODE_NPM_PACKAGE_ROOT: packageRoot,
        MEMORAX_CODE_NPM_PACKAGE_VERSION: "0.1.9",
        MEMORAX_CODE_TEST_UPDATE_RECORD: updateRecordPath,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const dispatched = await waitForJson(updateRecordPath, backend);
    assert.deepEqual(dispatched.args, [
      "update",
      "--automatic",
      "--home",
      memoraxCodeHome,
    ]);
    assert.equal(dispatched.automaticUpdateProcess, "1");
  } finally {
    if (backend && backend.exitCode === null) {
      backend.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => backend.once("close", resolve)),
        delay(2_000, undefined, { ref: false }),
      ]);
    }
    await rm(root, { recursive: true, force: true });
  }
});

async function writeSetupCompletion(memoraxCodeHome) {
  const path = join(memoraxCodeHome, "runtime", "setup", "setup-completion.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({
    version: 1,
    state: "complete",
    completedAt: "2026-08-30T07:00:00.000Z",
    completedByVersion: "0.1.9",
  })}\n`);
}

async function writeOverdueUpdateState(memoraxCodeHome) {
  const path = join(memoraxCodeHome, "runtime", "install", "automatic-update.json");
  await mkdir(dirname(path), { recursive: true });
  const now = Date.now();
  await writeFile(path, `${JSON.stringify({
    version: 1,
    installedVersion: "0.1.9",
    nextCheckAt: new Date(now - 60 * 60 * 1_000).toISOString(),
  })}\n`);
}

async function waitForJson(path, child) {
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Backend exited before dispatching the update: ${stderr}`);
    }
    try {
      return JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await delay(25);
    }
  }
  throw new Error(`timed out waiting for Backend update dispatch: ${stderr}`);
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : undefined;
  await new Promise((resolve) => server.close(resolve));
  assert.ok(port);
  return port;
}
