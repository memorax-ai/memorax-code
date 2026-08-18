import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const preinstallPath = fileURLToPath(new URL("../bin/memorax-code-npm-preinstall.mjs", import.meta.url));
const nodeVersionPath = fileURLToPath(new URL("../lib/node-version.mjs", import.meta.url));

test("npm preinstall retires only the managed Backend and verifies PID cleanup", async () => {
  const fixture = await createFixture();
  try {
    const result = await runPreinstall(fixture);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      await readFile(fixture.logPath, "utf8"),
      `stop --home ${fixture.memoraxCodeHome} --clients none --json\n`,
    );
    assert.match(result.stderr, /Existing managed Backend stopped/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("npm preinstall quiesces managed DSH state without Backend PID authority", async () => {
  const fixture = await createFixture({ withPid: false, withDshState: true });
  try {
    const result = await runPreinstall(fixture);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      await readFile(fixture.logPath, "utf8"),
      `stop --home ${fixture.memoraxCodeHome} --clients none --json\n`,
    );
    assert.match(result.stderr, /Existing managed Backend stopped/);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("npm preinstall fails package setup when Backend retirement fails", async () => {
  const fixture = await createFixture({ failStop: true });
  try {
    const result = await runPreinstall(fixture);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /could not be retired safely/);
    assert.equal(await readFile(fixture.pidPath, "utf8"), "{}\n");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("npm preinstall is a no-op without managed PID authority", async () => {
  const fixture = await createFixture({ withPid: false });
  try {
    const result = await runPreinstall(fixture);
    assert.equal(result.code, 0, result.stderr);
    await assert.rejects(readFile(fixture.logPath, "utf8"), { code: "ENOENT" });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("npm preinstall fails closed when Backend retirement exceeds its total budget", {
  timeout: 3_000,
}, async () => {
  const fixture = await createFixture({ hangStop: true, timeoutMs: 50 });
  try {
    const result = await runPreinstall(fixture);
    assert.equal(result.code, 1);
    assert.ok(result.elapsedMs < 2_000, `preinstall took ${result.elapsedMs} ms`);
    assert.match(result.stderr, /memorax-code stop timed out after 50 ms/);
    assert.equal(await readFile(fixture.pidPath, "utf8"), "{}\n");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function createFixture({
  failStop = false,
  hangStop = false,
  timeoutMs,
  withPid = true,
  withDshState = false,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-npm-preinstall-"));
  const binDir = join(root, "bin");
  const libDir = join(root, "lib");
  const memoraxCodeHome = join(root, "memorax-code-home");
  const pidPath = join(memoraxCodeHome, "runtime", "backend", "backend.pid.json");
  const dshStatePath = join(memoraxCodeHome, "adapters", "dsh", "state.json");
  const logPath = join(root, "commands.log");
  await mkdir(binDir, { recursive: true });
  await mkdir(libDir, { recursive: true });
  await cp(nodeVersionPath, join(libDir, "node-version.mjs"));
  const preinstallSource = (await readFile(preinstallPath, "utf8")).replace(
    "const PREINSTALL_STOP_TIMEOUT_MS = 45_000;",
    `const PREINSTALL_STOP_TIMEOUT_MS = ${timeoutMs ?? "45_000"};`,
  );
  await writeFile(join(binDir, "memorax-code-npm-preinstall.mjs"), preinstallSource);
  await writeFile(join(binDir, "memorax-code.mjs"), [
    "#!/usr/bin/env node",
    "import { appendFileSync, rmSync } from 'node:fs';",
    `appendFileSync(${JSON.stringify(logPath)}, process.argv.slice(2).join(" ") + "\\n");`,
    "if (process.env.MEMORAX_CODE_PACKAGE_REPLACEMENT !== '1') process.exit(9);",
    ...(hangStop
      ? ["setInterval(() => {}, 1_000);"]
      : failStop
      ? ["console.error('simulated stop failure');", "process.exit(7);"]
      : [
          `rmSync(${JSON.stringify(pidPath)}, { force: true });`,
          "process.exit(0);",
        ]),
    "",
  ].join("\n"));
  await chmod(join(binDir, "memorax-code.mjs"), 0o755);
  if (withPid) {
    await mkdir(dirname(pidPath), { recursive: true });
    await writeFile(pidPath, "{}\n");
  }
  if (withDshState) {
    await mkdir(dirname(dshStatePath), { recursive: true });
    await writeFile(dshStatePath, "{}\n");
  }
  return { root, memoraxCodeHome, pidPath, dshStatePath, logPath };
}

async function runPreinstall(fixture) {
  return await new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(
      process.execPath,
      [join(fixture.root, "bin", "memorax-code-npm-preinstall.mjs")],
      {
        env: { ...process.env, MEMORAX_CODE_HOME: fixture.memoraxCodeHome },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (code) => resolve({
      code,
      stdout,
      stderr,
      elapsedMs: Date.now() - startedAt,
    }));
  });
}
