import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stopWrapperBackend } from "./codebuddy-install-cleanup.mjs";

async function fixture(callback) {
  const root = await mkdtemp(join(tmpdir(), "codebuddy-wrapper-cleanup-"));
  const stateHome = join(root, "state");
  const pidPath = join(stateHome, "runtime", "backend", "backend.pid.json");
  const previous = process.cwd();
  try {
    await mkdir(join(stateHome, "runtime", "backend"), { recursive: true });
    process.chdir(root);
    await callback({ root, stateHome, pidPath });
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  }
}

test("wrapper cleanup without a Backend record does not start a command", async () => {
  await fixture(async ({ root, stateHome }) => {
    await stopWrapperBackend(stateHome, join(root, "must-not-execute"));
  });
});

test("wrapper cleanup uses the public stop command and confirms process and record removal", { skip: process.platform === "win32" }, async () => {
  await fixture(async ({ root, stateHome, pidPath }) => {
    const backend = spawn(process.execPath, ["-e", 'process.send("ready"); setInterval(() => {}, 1000);'],
      { stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const exited = once(backend, "exit");
    try {
      await once(backend, "message");
      await writeFile(pidPath, JSON.stringify({ pid: backend.pid }));
      // Node is the synthetic executable; its stop script models a public CLI.
      await writeFile(join(root, "stop"), `
        const fs = require("node:fs");
        require("node:assert/strict").deepEqual(process.argv.slice(2), ["--clients", "codebuddy", "--json"]);
        const path = ${JSON.stringify(pidPath)};
        process.kill(JSON.parse(fs.readFileSync(path, "utf8")).pid, "SIGTERM");
        fs.unlinkSync(path);
        fs.writeFileSync("stop-called", "yes");
        console.log(JSON.stringify({ ok: true }));
      `);
      await stopWrapperBackend(stateHome, process.execPath);
      await exited;
      assert.equal(await readFile(join(root, "stop-called"), "utf8"), "yes");
      await assert.rejects(stat(pidPath), { code: "ENOENT" });
    } finally {
      if (backend.exitCode === null && backend.signalCode === null) backend.kill("SIGKILL");
      await exited;
    }
  });
});

test("failed public stop remains a failure and retains the Backend record", { skip: process.platform === "win32" }, async () => {
  await fixture(async ({ root, stateHome, pidPath }) => {
    const record = JSON.stringify({ pid: 2147483647 });
    await writeFile(pidPath, record);
    await writeFile(join(root, "stop"), 'console.log(JSON.stringify({ ok: false }));\n');
    await assert.rejects(stopWrapperBackend(stateHome, process.execPath), { testCode: "WRAPPER_PUBLIC_STOP_FAILED" });
    assert.equal(await readFile(pidPath, "utf8"), record);
    assert.equal((await stat(root)).isDirectory(), true);
  });
});
