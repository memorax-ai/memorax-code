import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse } from "../../../ts/memorax-code-backend/node_modules/smol-toml/dist/index.js";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const adapterCommonRoot = join(packageRoot, "..", "..", "ts", "memorax-code-adapter-common", "src");
const transitionRelativePath = join("runtime", "install", "package-transition.json");
const pidRelativePath = join("runtime", "backend", "backend.pid.json");
const dshStateRelativePath = join("adapters", "dsh", "state.json");

test("fresh install and configured-but-stopped install are lifecycle no-ops", async (t) => {
  for (const name of ["fresh", "configured-but-stopped"]) {
    await t.test(name, async () => {
      const fixture = await createFixture();
      const path = join(fixture.home, "config.toml");
      const original = "[clients]\ncodex = true\n";
      try {
        if (name === "configured-but-stopped") {
          await mkdir(fixture.home, { recursive: true });
          await writeFile(path, original);
        }
        assert.equal((await runEntry(fixture, "preinstall")).code, 0);
        if (name === "configured-but-stopped") assert.equal(await readFile(path, "utf8"), original);
        assert.equal((await runEntry(fixture, "postinstall")).code, 0);
        if (name === "fresh") {
          assert.equal(await pathExists(fixture.home), false);
        } else {
          const updated = await readFile(path, "utf8");
          assert.equal(updated.startsWith(original), true);
          assert.deepEqual(parse(updated), { ...parse(original), jev: { enabled: false, api_key: "" } });
          const after = await stat(path);
          assert.equal((await runEntry(fixture, "preinstall")).code, 0);
          assert.equal((await runEntry(fixture, "postinstall")).code, 0);
          assert.equal(await readFile(path, "utf8"), updated);
          const repeated = await stat(path);
          assert.equal(repeated.ino, after.ino);
          assert.equal(repeated.mtimeMs, after.mtimeMs);
        }
        assert.equal(await pathExists(fixture.logPath), false);
        assert.equal(await pathExists(join(fixture.home, "runtime", "install")), false);
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

test("postinstall preserves malformed config and reports a content-free migration failure", async () => {
  const fixture = await createFixture();
  const path = join(fixture.home, "config.toml");
  const original = '[memorax]\napi_key = "malformed-config-key-canary"\nbroken = [\n';
  try {
    await mkdir(fixture.home, { recursive: true });
    await writeFile(path, original);
    assert.equal((await runEntry(fixture, "preinstall")).code, 0);
    const { runUpdateInstallWithDiagnostics } = await import(pathToFileURL(join(fixture.root, "lib", "update-diagnostics.mjs")).href);
    let result;
    const installation = await runUpdateInstallWithDiagnostics(async (env) => {
      result = await runEntry({ ...fixture, env: { ...fixture.env, ...env } }, "postinstall");
      return { exitCode: result.code, signal: null };
    }, {});
    assert.equal(result.code, 1);
    assert.equal(await readFile(path, "utf8"), original);
    assert.match(result.stderr, /INSTALL_CONFIG_MIGRATION_FAILED.*config:/);
    assert.doesNotMatch(result.stdout + result.stderr, /malformed-config-key-canary|broken =|api_key/);
    const diagnostics = await readDiagnostics(fixture);
    assert.equal(diagnostics.length, 1);
    assert.equal(diagnostics[0].errorCode, "INSTALL_CONFIG_MIGRATION_FAILED");
    assert.equal(diagnostics[0].stage, "config");
    assert.equal(diagnostics[0].recordReason, "invalid_toml");
    assert.equal(diagnostics[0].configStage, "parse_existing");
    assert.equal(diagnostics[0].configState, "preserved");
    assert.equal(diagnostics[0].operation, "install.config");
    assert.equal(installation.failure.children.length, 1);
    assert.equal(installation.failure.children[0].fields.configStage, "parse_existing");
    assert.equal(installation.failure.children[0].fields.configState, "preserved");
    assert.doesNotMatch(JSON.stringify(diagnostics), /malformed-config-key-canary|broken =|api_key/);
    assert.equal(await pathExists(fixture.logPath), false);
  } finally {
    await fixture.cleanup();
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

    const transition = await import(pathToFileURL(join(fixture.root, "lib", "package-transition.mjs")).href);
    for (const commandTimeoutMs of [undefined, 75_000]) {
      await writeFile(fixture.pidPath, JSON.stringify({ pid: process.pid }));
      const budgets = [];
      const options = {
        memoraxCodeHome: fixture.home,
        memoraxCodeBin: join(fixture.root, "bin", "memorax-code.mjs"),
        packageVersion: "9.8.7-test",
        env: fixture.env,
        commandTimeoutMs,
        spawnSyncImpl: (command, args, spawnOptions) => {
          budgets.push([args[1], spawnOptions.timeout]);
          return spawnSync(command, args, spawnOptions);
        },
      };
      transition.runNpmPreinstallPackageTransition(options);
      await transition.runNpmPostinstallPackageTransition(options);
      assert.deepEqual(budgets, [
        ["stop", commandTimeoutMs ?? 45_000],
        ["start", commandTimeoutMs ?? 45_000],
        ["status", commandTimeoutMs ?? 45_000],
      ]);
      assert.equal(await pathExists(fixture.transitionPath), false);
    }
  } finally {
    await fixture.cleanup();
  }
});

test("postinstall publishes a one-shot marker when an update parent requests it", async () => {
  const fixture = await createFixture({ transitionText: recordText() });
  try {
    const transition = await import(pathToFileURL(join(fixture.root, "lib", "package-transition.mjs")).href);
    await transition.runNpmPostinstallPackageTransition({
      memoraxCodeHome: fixture.home,
      memoraxCodeBin: join(fixture.root, "bin", "memorax-code.mjs"),
      writeRestoreMarker: true,
    });
    assert.equal(
      transition.consumePackageRestoreMarker(fixture.home, "123e4567-e89b-42d3-a456-426614174000"),
      true,
    );
    assert.equal(
      transition.consumePackageRestoreMarker(fixture.home, "123e4567-e89b-42d3-a456-426614174000"),
      false,
    );
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
  const path = join(fixture.home, "config.toml");
  const original = "[clients]\ncodex = false\n";
  try {
    await writeFile(path, original);
    assert.equal((await runEntry(fixture, "preinstall")).code, 0);
    assert.equal(await readFile(path, "utf8"), original);
    assert.equal(JSON.parse(await readFile(fixture.transitionPath, "utf8")).state, "retired");
    const stopCall = (await readCalls(fixture))[0];
    assert.equal(stopCall.command, "stop");
    assert.equal(stopCall.packageReplacement, true);

    assert.equal((await runEntry(fixture, "postinstall")).code, 0);
    assert.deepEqual((await readCalls(fixture)).map((call) => call.command), ["stop", "start", "status"]);
    const updated = await readFile(path, "utf8");
    assert.equal(updated.startsWith(original), true);
    assert.deepEqual(parse(updated), { ...parse(original), jev: { enabled: false, api_key: "" } });
    assert.equal(await pathExists(fixture.transitionPath), false);
  } finally {
    await fixture.cleanup();
  }
});

test("explicit update recovery resumes a failed DSH transition and consumes it only after verification", async () => {
  const fixture = await createFixture({ withDshState: true, statusMode: "fail", publicUpdate: true });
  try {
    assert.equal((await runEntry(fixture, "preinstall")).code, 0);
    assert.equal((await runEntry(fixture, "postinstall")).code, 1);
    const retired = await readFile(fixture.transitionPath, "utf8");
    const reinstall = await runEntry(fixture, "preinstall");
    assert.equal(reinstall.code, 1);
    assert.match(reinstall.stderr, /\[PACKAGE_TRANSITION_PENDING\] transition_read:/);
    assert.equal((await runEntry(fixture, "recover")).code, 1);
    assert.equal(await readFile(fixture.transitionPath, "utf8"), retired);

    fixture.env.MEMORAX_CODE_TEST_STATUS_MODE = "ok";
    const recovery = await runEntry(fixture, "recover");
    assert.equal(recovery.code, 0, recovery.stderr);
    assert.match(recovery.stderr, /restored and verified/);
    assert.deepEqual((await readCalls(fixture)).map((call) => call.command), [
      "stop", "start", "status", "status", "start", "status", "start", "status",
    ]);
    assert.equal(await pathExists(fixture.transitionPath), false);
    assert.equal(await pathExists(fixture.completionPath), false);
    assert.equal(await pathExists(join(fixture.home, dshStateRelativePath)), true);

    const repeated = await runEntry(fixture, "recover");
    assert.equal(repeated.code, 0, repeated.stderr);
    assert.match(repeated.stderr, /no pending package transition/);
    assert.equal((await readCalls(fixture)).length, 8);
  } finally {
    await fixture.cleanup();
  }
});

test("manual update restores its failed transition while preserving failure and permits the next update", async () => {
  const fixture = await createFixture({ publicUpdate: true, npmMode: "restore-failure", withDshState: true, statusMode: "fail-once" });
  try {
    const failed = await runEntry(fixture, "update");
    assert.equal(failed.code, 23, failed.stderr);
    assert.match(failed.stderr, /restored and verified/);
    assert.equal(await pathExists(fixture.transitionPath), false);
    const records = await readDiagnostics(fixture);
    const result = records.find((record) => record.operation === "update" && record.errorCode === "UPDATE_INSTALL_FAILED");
    assert.equal(result.commandExitCode, 23);
    assert.equal(result.causeStage, "verify");
    assert.equal(records.find((record) => record.id === result.causeDiagnosticId).commandExitCode, 7);
    assert.equal(result.recoveryStatus, "restored");
    assert.match(result.impact, /update remains incomplete/);
    assert.equal(await pathExists(join(fixture.home, "runtime", "install", "update-result.json")), false);
    assert.deepEqual((await readCalls(fixture)).map((call) => call.command), ["stop", "start", "status", "start", "status"]);

    fixture.env.MEMORAX_CODE_TEST_NPM_MODE = "success";
    const next = await runEntry(fixture, "update");
    assert.equal(next.code, 0, next.stderr);
    assert.equal(await pathExists(fixture.transitionPath), false);
    assert.equal((await readFile(fixture.npmLogPath, "utf8")).trim().split("\n").length, 2);
  } finally {
    await fixture.cleanup();
  }
});

test("failed same-attempt recovery keeps the original failure and retired record", async () => {
  const fixture = await createFixture({ publicUpdate: true, npmMode: "restore-failure", withDshState: true, statusMode: "fail" });
  try {
    assert.equal((await runEntry(fixture, "update")).code, 23);
    const retired = JSON.parse(await readFile(fixture.transitionPath, "utf8"));
    const records = await readDiagnostics(fixture);
    const result = records.find((record) => record.operation === "update" && record.errorCode === "UPDATE_INSTALL_FAILED");
    assert.equal(retired.state, "retired");
    assert.equal(result.causeStage, "verify");
    assert.equal(records.find((record) => record.id === result.causeDiagnosticId).commandExitCode, 7);
    assert.equal(result.recoveryStatus, "failed");
    assert.equal(result.recoveryErrorCode, "PACKAGE_TRANSITION_COMMAND_FAILED");
    assert.equal(result.recoveryStage, "verify");
    assert.equal((await runEntry(fixture, "update")).code, 1);
    assert.equal((await readFile(fixture.npmLogPath, "utf8")).trim().split("\n").length, 1);
  } finally {
    await fixture.cleanup();
  }
});

test("failed npm never restores a transition replaced by another update", async () => {
  const fixture = await createFixture({ publicUpdate: true, npmMode: "foreign-transition", withDshState: true });
  try {
    assert.equal((await runEntry(fixture, "update")).code, 23);
    const result = (await readDiagnostics(fixture)).find((record) => record.operation === "update");
    assert.equal(result.recoveryStatus, "not-attempted");
    assert.equal(JSON.parse(await readFile(fixture.transitionPath, "utf8")).transitionId, "123e4567-e89b-42d3-a456-426614174000");
    assert.deepEqual((await readCalls(fixture)).map((call) => call.command), ["stop"]);
  } finally {
    await fixture.cleanup();
  }
});

test("failed replacement preserves retired state when npm restores an older package without recovery support", async () => {
  const fixture = await createFixture({ publicUpdate: true, npmMode: "restore-failure", withDshState: true, statusMode: "fail-once" });
  try {
    const path = join(fixture.root, "package.json");
    const metadata = JSON.parse(await readFile(path, "utf8"));
    delete metadata.memoraxCode;
    await writeFile(path, JSON.stringify(metadata));
    assert.equal((await runEntry(fixture, "update")).code, 23);
    const result = (await readDiagnostics(fixture)).find((record) => record.operation === "update");
    assert.equal(result.recoveryStatus, "unsupported-package");
    assert.equal(JSON.parse(await readFile(fixture.transitionPath, "utf8")).state, "retired");
    assert.deepEqual((await readCalls(fixture)).map((call) => call.command), ["stop", "start", "status"]);
  } finally {
    await fixture.cleanup();
  }
});

test("pending transitions without PID authority reject npm and preinstall before any command", async () => {
  const text = recordText();
  const fixture = await createFixture({ publicUpdate: true, npmMode: "success", transitionText: text });
  try {
    assert.equal((await runEntry(fixture, "preinstall")).code, 1);
    const update = await runEntry(fixture, "update");
    assert.equal(update.code, 1);
    assert.match(update.stderr, /update --recover/);
    assert.equal(await pathExists(fixture.npmLogPath), false);
    assert.equal(await pathExists(fixture.logPath), false);
    assert.equal(await readFile(fixture.transitionPath, "utf8"), text);
  } finally {
    await fixture.cleanup();
  }
});

test("postinstall never restores another update's transition when npm carries an attempt identity", async () => {
  const text = recordText();
  const fixture = await createFixture({ transitionText: text });
  fixture.env.MEMORAX_CODE_PACKAGE_TRANSITION_ID = "123e4567-e89b-42d3-a456-426614174001";
  try {
    const result = await runEntry(fixture, "postinstall");
    assert.equal(result.code, 1);
    assert.match(result.stderr, /PACKAGE_TRANSITION_REPLACED.*transition_read/);
    assert.equal(await pathExists(fixture.logPath), false);
    assert.equal(await readFile(fixture.transitionPath, "utf8"), text);
  } finally {
    await fixture.cleanup();
  }
});


test("a recovered restoration is recorded without repeating the successful start", async () => {
  const fixture = await createFixture({ transitionText: recordText(), statusMode: "fail-once" });
  try {
    const result = await runEntry(fixture, "postinstall");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await pathExists(fixture.transitionPath), false);
    assert.deepEqual((await readCalls(fixture)).map((call) => call.command), ["start", "status", "status"]);
    const [record] = await readDiagnostics(fixture);
    assert.equal(record.errorCode, "PACKAGE_TRANSITION_COMMAND_FAILED");
    assert.equal(record.stage, "verify");
    assert.equal(record.commandExitCode, 7);
    assert.equal(record.recoveryStatus, "restored");
    assert.match(result.stderr, /restored and verified/);
  } finally {
    await fixture.cleanup();
  }
});

test("postinstall retries only the failed stage and preserves the first failure across stages", async () => {
  const fixture = await createFixture({ transitionText: recordText() });
  try {
    const api = await import(pathToFileURL(join(fixture.root, "lib", "package-transition.mjs")).href);
    const calls = [];
    await assert.rejects(api.runNpmPostinstallPackageTransition({
      memoraxCodeHome: fixture.home,
      memoraxCodeBin: join(fixture.root, "bin", "memorax-code.mjs"),
      retryRestore: true,
      spawnSyncImpl: (_command, args) => {
        calls.push(args[1]);
        if (calls.length === 1) return { status: null, error: { code: "ETIMEDOUT" }, stdout: "" };
        if (args[1] === "status") return { status: 7, stdout: JSON.stringify({ ok: false }) };
        return { status: 0, stdout: JSON.stringify({ ok: true }) };
      },
    }), (error) => {
      assert.equal(error.code, "PACKAGE_TRANSITION_COMMAND_FAILED");
      assert.equal(error.stage, "restore");
      assert.equal(error.systemCode, "ETIMEDOUT");
      assert.equal(error.recoveryStatus, "failed");
      assert.equal(error.recovery.stage, "verify");
      assert.equal(error.recovery.commandExitCode, 7);
      return true;
    });
    assert.deepEqual(calls, ["start", "start", "status", "status"]);
    assert.equal(JSON.parse(await readFile(fixture.transitionPath, "utf8")).state, "retired");
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
        const [diagnostic] = await readDiagnostics(fixture);
        assert.equal(diagnostic.stage, "retire");
        assert.equal(diagnostic.errorCode, scenario.stopMode === "keep-pid"
          ? "PACKAGE_TRANSITION_PID_REMAINS" : "PACKAGE_TRANSITION_COMMAND_FAILED");
        if (scenario.stopMode === "fail") assert.equal(diagnostic.commandExitCode, 7);
        if (scenario.timeoutMs) assert.equal(diagnostic.systemCode, "ETIMEDOUT");
        assert.ok(result.stderr.includes(diagnostic.id));
        assert.equal(JSON.stringify(diagnostic).includes(fixture.home), false);
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
      const fixture = await createFixture({ transitionText: text, publicUpdate: true });
      const path = join(fixture.home, "config.toml");
      const original = "[clients]\ncodex = false\n";
      try {
        await writeFile(path, original);
        const result = await runEntry(fixture, "postinstall");
        assert.equal(result.code, 1);
        assert.equal(await readFile(path, "utf8"), original);
        const [diagnostic] = await readDiagnostics(fixture);
        assert.equal(diagnostic.stage, "transition_read");
        assert.equal(diagnostic.errorCode, name === "unsupported version"
          ? "PACKAGE_TRANSITION_RECORD_UNSUPPORTED" : "PACKAGE_TRANSITION_RECORD_INVALID");
        if (name === "malformed") assert.equal(diagnostic.recordReason, "malformed_json");
        assert.equal((await runEntry(fixture, "recover")).code, 1);
        assert.equal(await readFile(fixture.transitionPath, "utf8"), text);
        assert.equal(await pathExists(fixture.logPath), false);
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

test("only explicit recovery permits expired retired transitions", async (t) => {
  const old = new Date(Date.now() - 16 * 60 * 1_000).toISOString();
  const future = new Date(Date.now() + 60_000).toISOString();
  for (const [name, record] of [
    ["stale", validTransition({ startedAt: old, retiredAt: old })],
    ["retiring", validTransition({ state: "retiring" })],
    ["future", validTransition({ startedAt: future, retiredAt: future })],
  ]) {
    await t.test(name, async () => {
      const text = `${JSON.stringify(record, null, 2)}\n`;
      const fixture = await createFixture({ transitionText: text, publicUpdate: true });
      try {
        assert.equal((await runEntry(fixture, "postinstall")).code, 1);
        assert.equal(await readFile(fixture.transitionPath, "utf8"), text);
        assert.equal(await pathExists(fixture.logPath), false);
        const recovery = await runEntry(fixture, "recover");
        if (name === "stale") {
          assert.equal(recovery.code, 0, recovery.stderr);
          assert.equal(await pathExists(fixture.transitionPath), false);
          assert.deepEqual((await readCalls(fixture)).map((call) => call.command), ["start", "status"]);
        } else {
          assert.equal(recovery.code, 1);
          assert.equal(await readFile(fixture.transitionPath, "utf8"), text);
          assert.equal(await pathExists(fixture.logPath), false);
        }
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
        assert.deepEqual((await readCalls(fixture)).map((call) => call.command),
          mode === "invalid-json" ? ["start"] : ["start", "start"]);
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

test("restoration reuses Backend and client diagnostic IDs without leaking child output", async (t) => {
  for (const mode of ["backend-diagnostic", "backend-exited-diagnostic", "client-diagnostic"]) {
    await t.test(mode, async () => {
      const fixture = await createFixture({ transitionText: recordText(), startMode: mode });
      try {
        const result = await runEntry(fixture, "postinstall");
        assert.equal(result.code, 1);
        const records = await readDiagnostics(fixture);
        const originals = records.filter((record) => record.source === "memorax-code");
        assert.equal(originals.length, mode === "client-diagnostic" ? 1 : 2);
        for (const original of originals) {
          assert.ok(result.stderr.includes(`Diagnostic: ${original.id}`));
          assert.ok(result.stderr.includes(original.errorCode));
          assert.ok(result.stderr.includes(original.stage));
          assert.ok(result.stderr.includes(original.systemCode));
        }
        if (mode !== "client-diagnostic") {
          const summary = records.find((record) => record.source === "memorax-code-update");
          assert.equal(summary.recoveryStatus, "failed");
          assert.ok(originals.some((record) => record.id === summary.causeDiagnosticId));
          assert.ok(originals.some((record) => record.id === summary.recoveryDiagnosticId));
        } else {
          assert.equal(records.length, 1, "non-retryable client failures reuse the original diagnostic");
        }
        assert.doesNotMatch(result.stderr, /private-child-error-canary|private-child-action-canary/);
        assert.equal(JSON.parse(await readFile(fixture.transitionPath, "utf8")).state, "retired");
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
        assert.deepEqual((await readCalls(fixture)).map((call) => call.command),
          mode === "invalid-json" ? ["start", "status"] : ["start", "status", "status"]);
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
  publicUpdate = false,
  npmMode,
} = {}) {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-package-transition-"));
  const home = join(root, "memorax-code-home");
  const logPath = join(root, "commands.jsonl");
  const npmLogPath = join(root, "npm-calls.jsonl");
  const transitionPath = join(home, transitionRelativePath);
  const completionPath = join(home, "runtime", "setup", "setup-completion.json");
  const pidPath = join(home, pidRelativePath);
  const dshStatePath = join(home, dshStateRelativePath);
  for (const relativePath of [
    "bin/memorax-code-npm-preinstall.mjs",
    "bin/memorax-code-plugin-postinstall.mjs",
    "lib/node-version.mjs",
    "lib/package-transition.mjs",
    "lib/package-update.mjs",
    "lib/update-diagnostics.mjs",
    "lib/setup-diagnostics.mjs",
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
  for (const relativePath of ["config-utils.mjs", "diagnostic-record.mjs", "deployment-failure.mjs", "runtime-record.mjs", "windows-directory-retry.mjs", "package-recovery.mjs", "memorax-code-config-file.mjs", "jev-config-defaults.mjs"]) {
    const target = join(root, "lib", "memorax-code-adapter-common", "src", relativePath);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(adapterCommonRoot, relativePath), target);
  }
  await cp(join(packageRoot, "..", "..", "ts", "memorax-code-backend", "node_modules", "smol-toml"), join(root, "node_modules", "smol-toml"), { recursive: true });
  if (publicUpdate) {
    // Exercise the shipped update CLI and transition module against a fake lifecycle CLI.
    await cp(join(packageRoot, "bin", "memorax-code.mjs"), join(root, "bin", "update-cli.mjs"));
    for (const name of [
      "automatic-update", "client-hook-runtime", "npm-invocation", "run-entrypoint", "setup-api-key-input",
      "resolve-claude-command", "resolve-codex-command", "resolve-codebuddy-command",
      "windows-cli-invocation", "windows-user-path", "vscode-extension-command",
    ]) {
      await cp(join(packageRoot, "lib", `${name}.mjs`), join(root, "lib", `${name}.mjs`));
    }
    for (const name of ["automatic-update-state.mjs", "setup-completion.mjs", "clients/codebuddy-command.mjs"]) {
      const target = join(root, "lib", "memorax-code-adapter-common", "src", name);
      await mkdir(dirname(target), { recursive: true });
      await cp(join(adapterCommonRoot, name), target);
    }
    // Any accidental npm invocation must fail locally instead of changing the installation.
    await writeFile(join(root, "lib", "npm-invocation.mjs"), [
      'export function runNpmCommand() { throw new Error("Unexpected npm invocation during recovery"); }',
      'export { runNpmCommand as resolveNpmInvocation, runNpmCommand as resolveNpmExecPath,',
      '  runNpmCommand as npmCommandCwd, runNpmCommand as waitForChildProcess };',
      '',
    ].join("\n"));
  }
  if (npmMode) await writeFile(join(root, "lib", "npm-invocation.mjs"), fakeNpmSource({ root, npmLogPath }));
  await writeFile(join(root, "package.json"), `${JSON.stringify({
    name: "@memorax/memorax-code-transition-test",
    version: "9.8.7-test",
    memoraxCode: { updateRecoveryProtocol: 1 },
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
    npmLogPath,
    transitionPath,
    completionPath,
    pidPath,
    env: {
      MEMORAX_CODE_TEST_NPM_MODE: npmMode,
      MEMORAX_CODE_TEST_STOP_MODE: stopMode,
      MEMORAX_CODE_TEST_START_MODE: startMode,
      MEMORAX_CODE_TEST_STATUS_MODE: statusMode,
    },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

function fakeNpmSource({ root, npmLogPath }) {
  const runner = [
    'import { readFileSync, writeFileSync } from "node:fs";',
    'import { join } from "node:path";',
    `import { runNpmPreinstallPackageTransition, runNpmPostinstallPackageTransition } from ${JSON.stringify(pathToFileURL(join(root, "lib", "package-transition.mjs")).href)};`,
    `import { reportUpdateFailure } from ${JSON.stringify(pathToFileURL(join(root, "lib", "update-diagnostics.mjs")).href)};`,
    `const options = { memoraxCodeHome: process.env.MEMORAX_CODE_HOME, env: process.env, memoraxCodeBin: ${JSON.stringify(join(root, "bin", "memorax-code.mjs"))}, packageVersion: "9.8.7-test" };`,
    'runNpmPreinstallPackageTransition(options);',
    'if (process.env.MEMORAX_CODE_TEST_NPM_MODE === "foreign-transition") {',
    '  const path = join(options.memoraxCodeHome, "runtime", "install", "package-transition.json");',
    '  const record = JSON.parse(readFileSync(path, "utf8"));',
    '  writeFileSync(path, JSON.stringify({ ...record, transitionId: "123e4567-e89b-42d3-a456-426614174000" }));',
    '  process.exit(23);',
    '}',
    'try { await runNpmPostinstallPackageTransition(options); }',
    'catch (error) {',
    '  reportUpdateFailure(error, { home: options.memoraxCodeHome, operation: "install.restore" });',
    '  process.exit(23);',
    '}',
  ].join("\n");
  return `import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
export async function runNpmCommand(args, { env, stdio }) {
  appendFileSync(${JSON.stringify(npmLogPath)}, JSON.stringify(args) + "\\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", ${JSON.stringify(runner)}], {
    env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  });
  if (stdio === "inherit") process.stderr.write(result.stderr ?? "");
  return { exitCode: result.status ?? 1, signal: result.signal };
}
export function resolveNpmInvocation() { throw new Error("Unexpected registry lookup"); }
export { resolveNpmInvocation as resolveNpmExecPath, resolveNpmInvocation as npmCommandCwd,
  resolveNpmInvocation as waitForChildProcess };
`;
}

function fakeCliSource({ logPath }) {
  return `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeDiagnosticRecord } from "../lib/memorax-code-adapter-common/src/diagnostic-record.mjs";
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
if (mode === "backend-diagnostic" || mode === "backend-exited-diagnostic" || mode === "client-diagnostic") {
  const client = mode === "client-diagnostic";
  const failure = client
    ? { errorCode: "CLIENT_SKILL_PUBLISH_FAILED", stage: "skill-publish", systemCode: "EPERM", processState: "running" }
    : { errorCode: mode === "backend-exited-diagnostic" ? "BACKEND_EXITED_BEFORE_READY" : "BACKEND_HEALTH_NOT_READY", stage: "health", systemCode: "ECONNREFUSED", processState: "stopped" };
  const diagnostic = writeDiagnosticRecord(home, { source: "memorax-code", operation: client ? "client.start" : "backend.start", ...failure });
  const displayFailure = { ...failure, error: "private-child-error-canary", userAction: "private-child-action-canary" };
  console.log(JSON.stringify(client
    ? { ok: false, backend: { ok: true }, clientFailures: [{ client: "codex", failure: displayFailure, diagnostic }] }
    : { ok: false, backend: { ok: false }, failure: displayFailure, diagnostic }));
  process.exit(7);
}
if (mode === "hang") setInterval(() => {}, 1000);
if (mode === "fail-once" && readFileSync(${JSON.stringify(logPath)}, "utf8").trim().split("\\n").map(JSON.parse).filter((call) => call.command === command).length === 1) { console.log(JSON.stringify({ ok: false })); process.exit(7); }
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
    : entry === "recover" || entry === "update" ? "update-cli.mjs" : "memorax-code-plugin-postinstall.mjs";
  return await new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, [join(fixture.root, "bin", filename),
      ...(entry === "recover" || entry === "update"
        ? ["update", ...(entry === "recover" ? ["--recover"] : []), "--home", memoraxCodeHome] : []),
    ], {
      cwd,
      env: {
        ...process.env,
        ...fixture.env,
        MEMORAX_CODE_HOME: entry === "recover" ? join(fixture.root, "unrelated-home") : memoraxCodeHome,
      },
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

async function readDiagnostics(fixture) {
  const directory = join(fixture.home, "runtime", "diagnostics");
  return await Promise.all((await readdir(directory)).map(async (name) => JSON.parse(await readFile(join(directory, name), "utf8"))));
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
