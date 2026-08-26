import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const adapterCommonRoot = join(packageRoot, "..", "..", "ts", "memorax-code-adapter-common", "src");
const transitionRelativePath = join("runtime", "install", "package-transition.json");
const pidRelativePath = join("runtime", "backend", "backend.pid.json");
const dshStateRelativePath = join("adapters", "dsh", "state.json");

test("fresh install and configured-but-stopped install are lifecycle no-ops", async (t) => {
  for (const name of ["fresh", "configured-but-stopped"]) {
    await t.test(name, async () => {
      const fixture = await createFixture();
      try {
        if (name === "configured-but-stopped") {
          await mkdir(fixture.home, { recursive: true });
          await writeFile(join(fixture.home, "config.toml"), "[clients]\ncodex = true\n");
        }
        assert.equal((await runEntry(fixture, "preinstall")).code, 0);
        assert.equal((await runEntry(fixture, "postinstall")).code, 0);
        assert.equal(await pathExists(fixture.logPath), false);
        assert.equal(await pathExists(join(fixture.home, "runtime", "install")), false);
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

test("dead or malformed PID authority is cleaned without scheduling a restart", async (t) => {
  for (const [name, pidOptions] of [
    ["dead", { pid: 2_147_483_647 }],
    ["malformed", { pidText: "{not-json\n" }],
  ]) {
    await t.test(name, async () => {
      const fixture = await createFixture(pidOptions);
      try {
        assert.equal((await runEntry(fixture, "preinstall")).code, 0);
        assert.equal(await pathExists(fixture.transitionPath), false);
        assert.equal((await runEntry(fixture, "postinstall")).code, 0);
        const calls = await readCalls(fixture);
        assert.deepEqual(calls.map((call) => call.command), ["stop"]);
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

test("a live Backend is retired before replacement and restored once afterward", async () => {
  const fixture = await createFixture({ pid: process.pid });
  try {
    const preinstall = await runEntry(fixture, "preinstall");
    assert.equal(preinstall.code, 0, preinstall.stderr);
    const retired = JSON.parse(await readFile(fixture.transitionPath, "utf8"));
    assert.equal(retired.state, "retired");
    const stopCall = (await readCalls(fixture))[0];
    assert.deepEqual(stopCall.args, ["stop", "--home", fixture.home, "--clients", "none", "--json"]);
    assert.equal(stopCall.transitionState, "retiring");
    assert.equal(stopCall.packageReplacement, true);

    const postinstall = await runEntry(fixture, "postinstall");
    assert.equal(postinstall.code, 0, postinstall.stderr);
    const calls = await readCalls(fixture);
    assert.deepEqual(calls.slice(1).map((call) => call.args), [
      ["start", "--home", fixture.home, "--json"],
      ["status", "--home", fixture.home, "--json"],
    ]);
    const lifecycleCwd = await realpath(join(fixture.home, "runtime", "install"));
    assert.ok(calls.every((call) => call.cwd === lifecycleCwd));
    assert.equal(calls[1].packageReplacement, true);
    assert.equal(calls[2].packageReplacement, false);
    assert.ok(calls.slice(1).every((call) => !call.args.includes("--clients")));
    assert.equal(await pathExists(fixture.transitionPath), false);
    assert.equal(await pathExists(fixture.completionPath), false);

    assert.equal((await runEntry(fixture, "postinstall")).code, 0);
    assert.equal((await readCalls(fixture)).length, 3);
  } finally {
    await fixture.cleanup();
  }
});

test("relative MEMORAX_CODE_HOME is resolved before lifecycle commands change cwd", async () => {
  const fixture = await createFixture({ pid: process.pid });
  try {
    const options = { cwd: fixture.root, memoraxCodeHome: "memorax-code-home" };
    const preinstall = await runEntry(fixture, "preinstall", options);
    assert.equal(preinstall.code, 0, preinstall.stderr);
    const postinstall = await runEntry(fixture, "postinstall", options);
    assert.equal(postinstall.code, 0, postinstall.stderr);

    const calls = await readCalls(fixture);
    const resolvedHome = await realpath(fixture.home);
    assert.ok(calls.every((call) => call.args.includes(resolvedHome)));
    assert.ok(calls.every((call) => call.cwd === join(resolvedHome, "runtime", "install")));
  } finally {
    await fixture.cleanup();
  }
});

test("managed DSH state is quiesced and restored without Backend PID authority", async () => {
  const fixture = await createFixture({ withDshState: true });
  try {
    assert.equal((await runEntry(fixture, "preinstall")).code, 0);
    assert.equal(JSON.parse(await readFile(fixture.transitionPath, "utf8")).state, "retired");
    const stopCall = (await readCalls(fixture))[0];
    assert.equal(stopCall.command, "stop");
    assert.equal(stopCall.packageReplacement, true);

    assert.equal((await runEntry(fixture, "postinstall")).code, 0);
    assert.deepEqual((await readCalls(fixture)).map((call) => call.command), ["stop", "start", "status"]);
  } finally {
    await fixture.cleanup();
  }
});

test("stop failure, residual PID authority, and timeout retain retiring state", async (t) => {
  for (const scenario of [
    { name: "exit failure", stopMode: "fail" },
    { name: "residual PID", stopMode: "keep-pid" },
    { name: "timeout", stopMode: "hang", timeoutMs: 50 },
  ]) {
    await t.test(scenario.name, async () => {
      const fixture = await createFixture({
        pid: process.pid,
        stopMode: scenario.stopMode,
        timeoutMs: scenario.timeoutMs,
      });
      try {
        const startedAt = Date.now();
        const result = await runEntry(fixture, "preinstall");
        assert.equal(result.code, 1);
        if (scenario.timeoutMs) assert.ok(Date.now() - startedAt < 2_000);
        assert.equal(JSON.parse(await readFile(fixture.transitionPath, "utf8")).state, "retiring");
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

test("postinstall rejects invalid and unsupported transition records without consuming them", async (t) => {
  const scenarios = [
    ["malformed", "{not-json\n"],
    ["invalid version", recordText({ version: 0 })],
    ["unsupported version", recordText({ version: 2 })],
    ["unknown fields", recordText({ extra: true })],
  ];
  for (const [name, text] of scenarios) {
    await t.test(name, async () => {
      const fixture = await createFixture({ transitionText: text });
      try {
        const result = await runEntry(fixture, "postinstall");
        assert.equal(result.code, 1);
        assert.equal(await readFile(fixture.transitionPath, "utf8"), text);
        assert.equal(await pathExists(fixture.logPath), false);
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

test("postinstall rejects stale retired and unfinished retiring transitions", async (t) => {
  const old = new Date(Date.now() - 16 * 60 * 1_000).toISOString();
  for (const [name, record] of [
    ["stale", validTransition({ startedAt: old, retiredAt: old })],
    ["retiring", validTransition({ state: "retiring" })],
  ]) {
    await t.test(name, async () => {
      const fixture = await createFixture({ transitionText: `${JSON.stringify(record, null, 2)}\n` });
      try {
        assert.equal((await runEntry(fixture, "postinstall")).code, 1);
        assert.equal(await pathExists(fixture.transitionPath), true);
        assert.equal(await pathExists(fixture.logPath), false);
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

test("start failures retain retired state and do not run status", async (t) => {
  for (const mode of ["fail", "invalid-json", "not-ok"]) {
    await t.test(mode, async () => {
      const fixture = await createFixture({ transitionText: recordText(), startMode: mode });
      try {
        assert.equal((await runEntry(fixture, "postinstall")).code, 1);
        assert.equal(JSON.parse(await readFile(fixture.transitionPath, "utf8")).state, "retired");
        assert.deepEqual((await readCalls(fixture)).map((call) => call.command), ["start"]);
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

test("status failures retain retired state", async (t) => {
  for (const mode of ["fail", "invalid-json", "not-ok"]) {
    await t.test(mode, async () => {
      const fixture = await createFixture({ transitionText: recordText(), statusMode: mode });
      try {
        assert.equal((await runEntry(fixture, "postinstall")).code, 1);
        assert.equal(JSON.parse(await readFile(fixture.transitionPath, "utf8")).state, "retired");
        assert.deepEqual((await readCalls(fixture)).map((call) => call.command), ["start", "status"]);
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

test("postinstall leaves setup completion exclusively to foreground setup", async (t) => {
  for (const [name, completionText] of [
    ["absent", undefined],
    ["existing invalid record", "{not-json\n"],
  ]) {
    await t.test(name, async () => {
      const fixture = await createFixture({ transitionText: recordText(), completionText });
      try {
        assert.equal((await runEntry(fixture, "postinstall")).code, 0);
        assert.equal(await pathExists(fixture.transitionPath), false);
        if (completionText === undefined) {
          assert.equal(await pathExists(fixture.completionPath), false);
        } else {
          assert.equal(await readFile(fixture.completionPath, "utf8"), completionText);
        }
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

test("transition records use private POSIX permissions", {
  skip: process.platform === "win32",
}, async () => {
  const fixture = await createFixture({ pid: process.pid });
  try {
    assert.equal((await runEntry(fixture, "preinstall")).code, 0);
    assert.equal((await stat(fixture.transitionPath)).mode & 0o777, 0o600);
    assert.equal((await stat(dirname(fixture.transitionPath))).mode & 0o777, 0o700);
    assert.equal((await runEntry(fixture, "postinstall")).code, 0);
    assert.equal(await pathExists(fixture.transitionPath), false);
  } finally {
    await fixture.cleanup();
  }
});

test("absent postinstall never waits for an open stdin pipe", { timeout: 3_000 }, async () => {
  const fixture = await createFixture();
  try {
    const result = await runEntry(fixture, "postinstall", { keepStdinOpen: true });
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.elapsedMs < 2_000, `postinstall took ${result.elapsedMs} ms`);
  } finally {
    await fixture.cleanup();
  }
});

async function createFixture({
  pid,
  pidText,
  transitionText,
  completionText,
  stopMode = "ok",
  startMode = "ok",
  statusMode = "ok",
  timeoutMs,
  withDshState = false,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-package-transition-"));
  const home = join(root, "memorax-code-home");
  const logPath = join(root, "commands.jsonl");
  const transitionPath = join(home, transitionRelativePath);
  const completionPath = join(home, "runtime", "setup", "setup-completion.json");
  const pidPath = join(home, pidRelativePath);
  const dshStatePath = join(home, dshStateRelativePath);
  for (const relativePath of [
    "bin/memorax-code-npm-preinstall.mjs",
    "bin/memorax-code-plugin-postinstall.mjs",
    "lib/node-version.mjs",
    "lib/package-transition.mjs",
  ]) {
    const target = join(root, relativePath);
    await mkdir(dirname(target), { recursive: true });
    let source = await readFile(join(packageRoot, relativePath), "utf8");
    if (relativePath === "lib/package-transition.mjs" && timeoutMs) {
      source = source.replace(
        "export const PACKAGE_TRANSITION_COMMAND_TIMEOUT_MS = 45_000;",
        `export const PACKAGE_TRANSITION_COMMAND_TIMEOUT_MS = ${timeoutMs};`,
      );
    }
    await writeFile(target, source);
  }
  for (const relativePath of ["config-utils.mjs", "runtime-record.mjs"]) {
    const target = join(root, "lib", "memorax-code-adapter-common", "src", relativePath);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(adapterCommonRoot, relativePath), target);
  }
  await writeFile(join(root, "package.json"), `${JSON.stringify({
    name: "@memorax/memorax-code-transition-test",
    version: "9.8.7-test",
    type: "module",
  }, null, 2)}\n`);
  await writeFile(join(root, "bin", "memorax-code.mjs"), fakeCliSource({ logPath }), { mode: 0o755 });
  await chmod(join(root, "bin", "memorax-code.mjs"), 0o755);
  if (pid !== undefined || pidText !== undefined) {
    await mkdir(dirname(pidPath), { recursive: true });
    await writeFile(pidPath, pidText ?? `${JSON.stringify({ pid })}\n`);
  }
  if (transitionText !== undefined) {
    await mkdir(dirname(transitionPath), { recursive: true });
    await writeFile(transitionPath, transitionText);
  }
  if (completionText !== undefined) {
    await mkdir(dirname(completionPath), { recursive: true });
    await writeFile(completionPath, completionText);
  }
  if (withDshState) {
    await mkdir(dirname(dshStatePath), { recursive: true });
    await writeFile(dshStatePath, "{}\n");
  }
  return {
    root,
    home,
    logPath,
    transitionPath,
    completionPath,
    pidPath,
    env: {
      MEMORAX_CODE_TEST_STOP_MODE: stopMode,
      MEMORAX_CODE_TEST_START_MODE: startMode,
      MEMORAX_CODE_TEST_STATUS_MODE: statusMode,
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function fakeCliSource({ logPath }) {
  return `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const command = args[0];
const homeIndex = args.indexOf("--home");
const home = homeIndex >= 0 ? args[homeIndex + 1] : process.env.MEMORAX_CODE_HOME;
const transitionPath = join(home, "runtime", "install", "package-transition.json");
const pidPath = join(home, "runtime", "backend", "backend.pid.json");
let transitionState;
try { transitionState = JSON.parse(readFileSync(transitionPath, "utf8")).state; } catch {}
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({
  command,
  args,
  cwd: process.cwd(),
  transitionState,
  packageReplacement: process.env.MEMORAX_CODE_PACKAGE_REPLACEMENT === "1",
}) + "\\n");
const mode = process.env["MEMORAX_CODE_TEST_" + command.toUpperCase() + "_MODE"] ?? "ok";
if (mode === "hang") setInterval(() => {}, 1000);
if (mode === "fail") { console.log(JSON.stringify({ ok: false })); process.exit(7); }
if (mode === "invalid-json") { console.log("not-json"); process.exit(0); }
if (mode === "not-ok") { console.log(JSON.stringify({ ok: false })); process.exit(0); }
if (command === "stop" && mode !== "keep-pid") rmSync(pidPath, { force: true });
console.log(JSON.stringify({ ok: true, command, pidExisted: existsSync(pidPath) }));
`;
}

async function runEntry(fixture, entry, {
  keepStdinOpen = false,
  cwd,
  memoraxCodeHome = fixture.home,
} = {}) {
  const filename = entry === "preinstall"
    ? "memorax-code-npm-preinstall.mjs"
    : "memorax-code-plugin-postinstall.mjs";
  return await new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [join(fixture.root, "bin", filename)], {
      cwd,
      env: { ...process.env, ...fixture.env, MEMORAX_CODE_HOME: memoraxCodeHome },
      stdio: [keepStdinOpen ? "pipe" : "ignore", "pipe", "pipe"],
    });
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

async function readCalls(fixture) {
  if (!await pathExists(fixture.logPath)) return [];
  return (await readFile(fixture.logPath, "utf8")).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

function validTransition(overrides = {}) {
  const state = overrides.state ?? "retired";
  const startedAt = overrides.startedAt ?? new Date(Date.now() - 1_000).toISOString();
  const record = {
    version: 1,
    state,
    transitionId: "123e4567-e89b-42d3-a456-426614174000",
    startedAt,
    sourceVersion: "1.2.3-old",
  };
  if (state === "retired") record.retiredAt = overrides.retiredAt ?? new Date().toISOString();
  return { ...record, ...overrides };
}

function recordText(overrides = {}) {
  return `${JSON.stringify(validTransition(overrides), null, 2)}\n`;
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
