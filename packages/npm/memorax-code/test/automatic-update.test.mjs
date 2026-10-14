import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const commonRoot = join(packageRoot, "..", "..", "ts", "memorax-code-adapter-common", "src");

test("automatic update checks once per successful eight-hour window", async (t) => {
  const { api, memoraxCodeHome } = await fixture(t);
  const calls = [];
  const handlers = {
    resolveTargetVersion: async () => record(calls, "check", "0.1.9"),
    installVersion: async () => record(calls, "install", true),
    reconcile: async () => record(calls, "reconcile", true),
  };
  const first = await api.runAutomaticUpdateCore(options(memoraxCodeHome, "08:00:00", handlers));
  const throttled = await api.runAutomaticUpdateCore(options(memoraxCodeHome, "15:59:59", {
    ...handlers,
    resolveTargetVersion: async () => record(calls, "check", "0.1.10"),
  }));

  assert.equal(first.disposition, "up-to-date");
  assert.equal(throttled.disposition, "throttled");
  assert.deepEqual(calls, ["check"]);
  const state = await readState(api, memoraxCodeHome);
  assert.deepEqual(Object.keys(state).sort(), ["installedVersion", "nextCheckAt", "version"]);
  assert.equal(state.nextCheckAt, "2026-08-30T16:00:00.000Z");
});

test("automatic update installs an exact target and reconciles configured clients", async (t) => {
  const { api, memoraxCodeHome } = await fixture(t);
  const calls = [];
  const result = await api.runAutomaticUpdateCore(options(memoraxCodeHome, "08:00:00", {
    resolveTargetVersion: async (channel) => record(calls, ["check", channel], "0.1.10"),
    installVersion: async (version) => record(calls, ["install", version], true),
    reconcile: async (version) => record(calls, ["reconcile", version], true),
  }));

  assert.equal(result.disposition, "updated");
  assert.deepEqual(calls, [
    ["check", "latest"],
    ["install", "0.1.10"],
    ["reconcile", "0.1.10"],
  ]);
  const state = await readState(api, memoraxCodeHome);
  assert.equal(state.installedVersion, "0.1.10");
  assert.deepEqual(Object.keys(state).sort(), ["installedVersion", "nextCheckAt", "version"]);
});

test("automatic update passes restored Backend state to reconciliation", async (t) => {
  const { api, memoraxCodeHome } = await fixture(t);
  let setupOptions;
  const result = await api.runAutomaticUpdateCore(options(memoraxCodeHome, "08:00:00", {
    resolveTargetVersion: async () => "0.1.10",
    installVersion: async () => ({ exitCode: 0, restored: true }),
    reconcile: async (_version, value) => {
      setupOptions = value;
      return true;
    },
  }));

  assert.equal(result.disposition, "updated");
  assert.deepEqual(setupOptions, { reuseRestoredBackend: true });
});

test("automatic update retries failures after fifteen minutes and repairs stale setup", async (t) => {
  const { api, diagnostics, memoraxCodeHome } = await fixture(t);
  let checks = 0;
  let reconciles = 0;
  const base = {
    installedVersion: "0.1.10",
    completedByVersion: "0.1.9",
    resolveTargetVersion: async () => {
      checks += 1;
      return "0.1.10";
    },
    reconcile: async () => {
      reconciles += 1;
      return true;
    },
  };
  const failed = await api.runAutomaticUpdateCore(options(memoraxCodeHome, "08:00:00", {
    ...base,
    resolveTargetVersion: async () => {
      checks += 1;
      throw Object.assign(new Error("private-registry-canary"), { cause: Object.assign(new Error("private-cause-canary"), { code: "ENOTFOUND" }) });
    },
  }));
  assert.equal(failed.error.code, "UPDATE_VERSION_CHECK_FAILED");
  assert.equal(failed.error.stage, "version_check");
  assert.equal(failed.error.systemCode, "ENOTFOUND");
  const recorded = diagnostics.reportUpdateFailure(failed.error, { home: memoraxCodeHome, write() {} });
  const text = await readFile(recorded.diagnostic.path, "utf8");
  assert.doesNotMatch(text, /private-registry-canary|private-cause-canary/);
  assert.equal(text.includes(memoraxCodeHome), false);
  const throttled = await api.runAutomaticUpdateCore(options(memoraxCodeHome, "08:14:59", base));
  const repaired = await api.runAutomaticUpdateCore(options(memoraxCodeHome, "08:15:00", base));

  assert.deepEqual(
    [failed.reason, throttled.disposition, repaired.disposition, checks, reconciles],
    ["check_failed", "throttled", "reconciled", 2, 1],
  );
});

test("a failed retry-state write preserves the original version-check failure", async (t) => {
  const { api, diagnostics, memoraxCodeHome } = await fixture(t);
  let primary;
  await assert.rejects(api.runAutomaticUpdateCore(options(memoraxCodeHome, "08:00:00", {
    resolveTargetVersion: async () => {
      await mkdir(api.automaticUpdateStatePath(memoraxCodeHome));
      throw Object.assign(new Error("private-version-check-canary"), { code: "ENOTFOUND" });
    },
  })), (error) => {
    assert.equal(error.code, "UPDATE_VERSION_CHECK_FAILED");
    assert.equal(error.systemCode, "ENOTFOUND");
    assert.equal(error.recovery.code, "UPDATE_STATE_WRITE_FAILED");
    assert.equal(error.recovery.stage, "update_state");
    primary = error;
    return true;
  });
  const recorded = diagnostics.reportUpdateFailure(primary, { home: memoraxCodeHome, write() {} });
  const text = await readFile(recorded.diagnostic.path, "utf8");
  assert.doesNotMatch(text, /private-version-check-canary/);
  const record = JSON.parse(text);
  assert.equal(record.errorCode, "UPDATE_VERSION_CHECK_FAILED");
  assert.equal(record.recoveryErrorCode, "UPDATE_STATE_WRITE_FAILED");
});

test("automatic update preserves invalid and unsupported setup authority codes", async (t) => {
  const { api, root, memoraxCodeHome } = await fixture(t);
  const path = join(memoraxCodeHome, "runtime", "setup", "setup-completion.json");
  await mkdir(dirname(path), { recursive: true });
  for (const [text, code, reason] of [
    ["{private-malformed-record-canary", "SETUP_COMPLETION_RECORD_INVALID", "malformed_json"],
    [JSON.stringify({ version: 2 }), "SETUP_COMPLETION_RECORD_UNSUPPORTED", undefined],
  ]) {
    await writeFile(path, text);
    const result = await api.runAutomaticUpdate({
      memoraxCodeHome, packageRoot: root, packageName: "@memorax/test", packageVersion: "0.1.9", env: {},
    });
    assert.equal(result.reason, "setup_completion_invalid");
    assert.equal(result.error.code, code);
    assert.equal(result.error.stage, "setup_state");
    assert.equal(result.error.recordReason, reason);
    assert.doesNotMatch(JSON.stringify(result), /private-malformed-record-canary/);
  }
});

test("npm registry JSON preserves recognized causes without retaining response text", async (t) => {
  const { diagnostics } = await fixture(t);
  assert.deepEqual(diagnostics.npmRegistryFailureFields(JSON.stringify({
    error: { code: "E401", detail: "private-npm-response-canary" },
  })), { systemCode: "E401", httpStatus: 401 });
  assert.deepEqual(diagnostics.npmRegistryFailureFields(JSON.stringify({
    error: { code: "ENOTFOUND", detail: "private-npm-response-canary" },
  })), { systemCode: "ENOTFOUND" });
  assert.deepEqual(diagnostics.npmRegistryFailureFields(JSON.stringify({
    error: { code: "private-npm-code-canary", detail: "E401" },
  })), {});
});

test("update diagnostics relay all eight client failures including Cursor within the input bound", async (t) => {
  const { diagnostics, memoraxCodeHome } = await fixture(t);
  const clients = ["codex", "claude", "dsh", "opencode", "codebuddy", "workbuddy", "trae", "cursor"];
  const clientFailures = clients.map((client, index) => ({
    client,
    failure: { errorCode: "CLIENT_HOOKS_WRITE_FAILED", stage: "hooks-write", systemCode: "EACCES",
      error: "private-client-failure-canary" },
    diagnostic: { id: `mc-1000000000000-11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`, recorded: true },
  }));
  const failure = new diagnostics.UpdateFailure("UPDATE_RECONCILE_FAILED", "reconcile", {
    commandResult: { exitCode: 7, stdout: JSON.stringify({
      backend: { ok: true }, clientFailures: [...clientFailures, clientFailures[0]],
    }) },
  });
  assert.deepEqual(failure.children.map(child => child.fields.client), clients);
  assert.deepEqual(failure.children.map(child => child.diagnostic.id), clientFailures.map(child => child.diagnostic.id));
  const output = [];
  diagnostics.reportUpdateFailure(failure, { home: memoraxCodeHome, write: line => output.push(line) });
  assert.equal(output.filter(line => line.startsWith("Diagnostic:")).length, clients.length);
  assert.match(output.join("\n"), /CLIENT_HOOKS_WRITE_FAILED.*cursor\.hooks-write/);
  assert.doesNotMatch(output.join("\n"), /private-client-failure-canary|UPDATE_RECONCILE_FAILED/);
});

test("automatic setup reuses a child diagnostic and deduplicates IPC messages", async (t) => {
  const { api, diagnostics, root, memoraxCodeHome } = await fixture(t);
  const completionPath = join(memoraxCodeHome, "runtime", "setup", "setup-completion.json");
  await mkdir(dirname(completionPath), { recursive: true });
  await writeFile(completionPath, JSON.stringify({
    version: 1, state: "complete", completedAt: "2026-08-30T08:00:00.000Z", completedByVersion: "0.1.9",
  }));
  await mkdir(join(root, "bin"));
  await writeFile(join(root, "bin", "memorax-code-setup.mjs"), [
    'import { reportSetupFailure } from "../lib/setup-diagnostics.mjs";',
    'const result = reportSetupFailure("credential", {',
    '  home: process.env.MEMORAX_CODE_HOME, version: "0.1.9", write() {},',
    '  details: { errorCode: "TRIAL_PROVISION_CLIENT_FAILED", stage: "provision", failureReason: "rate_limit_exceeded", httpStatus: 429, retryAfterMs: 3000 },',
    '});',
    'const message = { type: "memorax-code-diagnostic", version: 1, fields: result.failure, diagnostic: result.diagnostic };',
    'process.send({ ...message, fields: { errorCode: "private-ipc-canary", stage: "private-ipc-canary" } });',
    'process.send(message);',
    'process.send(message, () => process.exit(7));',
  ].join("\n"));
  let failure;
  await assert.rejects(api.runAutomaticSetup({
    env: process.env, memoraxCodeHome, packageRoot: root, targetVersion: "0.1.10",
  }), (error) => {
    failure = error;
    assert.equal(error.commandExitCode, 7);
    assert.equal(error.children.length, 1);
    assert.equal(error.children[0].fields.httpStatus, 429);
    assert.equal(error.children[0].fields.retryAfterMs, 3000);
    return true;
  });
  const output = [];
  diagnostics.reportUpdateFailure(failure, { home: memoraxCodeHome, write: (line) => output.push(line) });
  const records = await readdir(join(memoraxCodeHome, "runtime", "diagnostics"));
  assert.equal(records.length, 1);
  assert.ok(output.join("\n").includes(failure.children[0].diagnostic.id));
  assert.match(output.join("\n"), /TRIAL_PROVISION_CLIENT_FAILED.*credential\.provision/);
  assert.match(output.join("\n"), /Retry after: 3000 ms/);
  assert.doesNotMatch(output.join("\n"), /private-ipc-canary|UPDATE_RECONCILE_FAILED/);
});

test("offline npm lifecycle relay preserves original failures and ignores successful install diagnostics", async (t) => {
  const { diagnostics, root, memoraxCodeHome } = await fixture(t);
  const { runNpmCommand } = await import(pathToFileURL(join(root, "lib", "npm-invocation.mjs")).href);
  for (const [phase, exitCode] of [["preinstall", 7], ["postinstall", 7], ["postinstall", 0]]) {
    const prefix = join(root, `${phase}-${exitCode}`);
    const home = join(memoraxCodeHome, `${phase}-${exitCode}`);
    const backendExited = phase === "postinstall" && exitCode !== 0;
    await mkdir(prefix);
    await writeFile(join(prefix, "package.json"), JSON.stringify({
      name: "memorax-offline-diagnostic-fixture", version: "1.0.0", private: true,
      scripts: { [phase]: "node lifecycle.mjs" },
    }));
    await writeFile(join(prefix, "lifecycle.mjs"), [
      'import { appendFileSync, readFileSync } from "node:fs";',
      'import { UpdateFailure, reportUpdateFailure } from "../lib/update-diagnostics.mjs";',
      'import { writeDiagnosticRecord } from "../lib/memorax-code-adapter-common/src/diagnostic-record.mjs";',
      'const backendFailure = { errorCode: "BACKEND_EXITED_BEFORE_READY", stage: "health", processState: "stopped" };',
      backendExited
        ? 'const diagnostic = writeDiagnosticRecord(process.env.MEMORAX_CODE_HOME, { source: "memorax-code", operation: "backend.start", ...backendFailure });'
        : '',
      backendExited
        ? 'const failure = new UpdateFailure("PACKAGE_TRANSITION_COMMAND_FAILED", "restore", { commandResult: { stdout: JSON.stringify({ backend: { ok: false }, failure: backendFailure, diagnostic }) } });'
        : 'const failure = new UpdateFailure("PACKAGE_TRANSITION_COMMAND_FAILED", "retire", { systemCode: "EACCES" });',
      'reportUpdateFailure(failure, {',
      '  home: process.env.MEMORAX_CODE_HOME, operation: "install.retire", version: "1.0.0",',
      '});',
      'const path = process.env.MEMORAX_CODE_UPDATE_DIAGNOSTIC_PATH;',
      'const message = JSON.parse(readFileSync(path, "utf8").trimEnd().split("\\n")[1]);',
      'const unrelated = { ...message, nonce: "0".repeat(64), diagnostic: { id: "mc-1000000000000-11111111-1111-4111-8111-111111111111", recorded: true } };',
      'const invalid = { ...message, fields: { ...message.fields, errorCode: "private-relay-canary", error: "private-relay-canary" } };',
      'appendFileSync(path, [message, unrelated, invalid].map(value => JSON.stringify(value)).join("\\n") + "\\n");',
      `process.exit(${exitCode});`,
    ].join("\n"));
    let relayPath;
    const { result, failure } = await diagnostics.runUpdateInstallWithDiagnostics(async (env) => {
      relayPath = env.MEMORAX_CODE_UPDATE_DIAGNOSTIC_PATH;
      return await runNpmCommand(["install", "--prefix", prefix, "--offline", "--no-audit", "--no-fund", "--package-lock=false"], {
        env: { ...env, MEMORAX_CODE_HOME: home, npm_config_cache: join(root, "npm-cache"), npm_config_update_notifier: "false" },
        stdio: "ignore",
      });
    });
    assert.equal(result.exitCode, exitCode === 0 ? 0 : 7);
    if (exitCode !== 0) {
      assert.equal(failure.children.length, 1);
      assert.equal(failure.children[0].fields.errorCode, backendExited ? "BACKEND_EXITED_BEFORE_READY" : "PACKAGE_TRANSITION_COMMAND_FAILED");
      assert.equal(failure.children[0].fields.systemCode, backendExited ? undefined : "EACCES");
      const output = [];
      diagnostics.reportUpdateFailure(failure, { home, write: (line) => output.push(line) });
      assert.equal(output.filter((line) => line.startsWith("Diagnostic:")).length, 1);
      assert.ok(output.join("\n").includes(failure.children[0].diagnostic.id));
      assert.doesNotMatch(output.join("\n"), /UPDATE_INSTALL_FAILED|private-relay-canary/);
    } else {
      assert.equal(failure, undefined);
    }
    assert.equal((await readdir(join(home, "runtime", "diagnostics"))).length, 1);
    await assert.rejects(readdir(dirname(relayPath)), { code: "ENOENT" });
  }
});

test("a lock-release failure keeps the first follow-up failure", async (t) => {
  const { diagnostics } = await fixture(t);
  const primary = new diagnostics.UpdateFailure("UPDATE_VERSION_CHECK_FAILED", "version_check", { systemCode: "ENOTFOUND" });
  primary.recovery = new diagnostics.UpdateFailure("UPDATE_STATE_WRITE_FAILED", "update_state", { systemCode: "EACCES" });
  const release = Object.assign(new Error("private-lock-canary"), { code: "JSON_FILE_LOCK_RELEASE_FAILED" });
  const aggregate = Object.assign(new AggregateError([primary, release], "private-aggregate-canary", { cause: primary }), { code: "JSON_FILE_LOCK_RELEASE_FAILED" });
  const failure = diagnostics.updateFailure(aggregate, "UPDATE_FAILED", "update_lock");
  assert.equal(failure, primary);
  assert.equal(failure.recovery.code, "UPDATE_STATE_WRITE_FAILED");
  assert.equal(failure.recovery.systemCode, "EACCES");
  assert.doesNotMatch(JSON.stringify(failure), /private-lock-canary|private-aggregate-canary/);
});

test("unavailable and oversized npm diagnostic relays preserve the command failure", async (t) => {
  const { diagnostics, root } = await fixture(t);
  const blockedTemp = join(root, "not-a-directory");
  await writeFile(blockedTemp, "private-relay-canary");
  const previous = new Map(["TMPDIR", "TEMP", "TMP"].map((key) => [key, process.env[key]]));
  try {
    for (const key of previous.keys()) process.env[key] = blockedTemp;
    const { result, failure } = await diagnostics.runUpdateInstallWithDiagnostics(async (env) => {
      assert.equal(env.MEMORAX_CODE_UPDATE_DIAGNOSTIC_PATH, undefined);
      assert.equal(env.MEMORAX_CODE_UPDATE_DIAGNOSTIC_NONCE, undefined);
      return { exitCode: 19 };
    });
    assert.equal(result.exitCode, 19);
    assert.equal(failure.code, "UPDATE_INSTALL_FAILED");
    assert.equal(failure.commandExitCode, 19);
    assert.equal(failure.children, undefined);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  let relayPath;
  const { result, failure } = await diagnostics.runUpdateInstallWithDiagnostics(async (env) => {
    relayPath = env.MEMORAX_CODE_UPDATE_DIAGNOSTIC_PATH;
    await writeFile(relayPath, "x".repeat(256 * 1024 + 1));
    return { exitCode: 23 };
  });
  assert.equal(result.exitCode, 23);
  assert.equal(failure.commandExitCode, 23);
  assert.equal(failure.children, undefined);
  await assert.rejects(readdir(dirname(relayPath)), { code: "ENOENT" });
});

test("pending recovery bypasses the successful-check throttle and schedules a retry", async (t) => {
  const { api, memoraxCodeHome } = await fixture(t);
  const calls = [];
  await api.runAutomaticUpdateCore(options(memoraxCodeHome, "08:00:00"));
  const result = await api.runAutomaticUpdateCore(options(memoraxCodeHome, "09:00:00", {
    checkPending: () => { throw Object.assign(new Error("pending transition"), { code: "PACKAGE_TRANSITION_PENDING" }); },
    resolveTargetVersion: async () => record(calls, "check", "0.1.10"),
    installVersion: async () => record(calls, "install", true),
    reconcile: async () => record(calls, "reconcile", true),
  }));
  assert.equal(result.reason, "recovery_required");
  assert.equal(result.ok, false);
  assert.deepEqual(calls, []);
  assert.equal(result.error.code, "PACKAGE_TRANSITION_PENDING");
  assert.equal(result.error.stage, "transition_read");
  assert.equal((await readState(api, memoraxCodeHome)).nextCheckAt, "2026-08-30T09:15:00.000Z");
});


test("recovery diagnostics retain only recognized outcomes and causes", async (t) => {
  const { diagnostics, memoraxCodeHome } = await fixture(t);
  const original = new diagnostics.UpdateFailure("UPDATE_INSTALL_FAILED", "install", {
    error: Object.assign(new Error("private-update-canary"), { code: "ETIMEDOUT" }),
    commandResult: { exitCode: 23, stderr: "private-update-canary" },
  });
  original.recoveryStatus = "restored";
  original.installedVersion = "0.1.10";
  original.targetVersion = "private-update-canary";
  original.causeDiagnosticId = "mc-1000000000000-11111111-1111-4111-8111-111111111111";
  original.causeErrorCode = "PRIVATE_UPDATE_CANARY";
  original.causeStage = "restore";
  const output = [];
  const recorded = diagnostics.reportUpdateFailure(original, {
    home: memoraxCodeHome, version: "0.1.9", write: (line) => output.push(line),
  });
  const record = JSON.parse(await readFile(recorded.diagnostic.path, "utf8"));
  assert.equal(record.commandExitCode, 23);
  assert.equal(record.recoveryStatus, "restored");
  assert.equal(record.installedVersion, "0.1.10");
  assert.equal(record.causeDiagnosticId, undefined);
  assert.match(record.impact, /update remains incomplete/);
  assert.doesNotMatch(JSON.stringify(record) + output.join("\n"), /private.update.canary/i);
  const relayed = diagnostics.projectUpdateDiagnosticMessage({
    type: "memorax-code-diagnostic", version: 1, fields: recorded.failure, diagnostic: recorded.diagnostic,
  });
  assert.equal(relayed.fields.recoveryStatus, "restored");
  const invalid = diagnostics.projectUpdateDiagnosticMessage({
    type: "memorax-code-diagnostic", version: 1, diagnostic: recorded.diagnostic,
    fields: { ...recorded.failure, recoveryStatus: "private-update-canary",
      causeDiagnosticId: original.causeDiagnosticId, causeErrorCode: "PRIVATE_UPDATE_CANARY", causeStage: "restore" },
  });
  assert.equal(invalid.fields.recoveryStatus, undefined);
  assert.equal(invalid.fields.causeDiagnosticId, undefined);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-automatic-update-"));
  const files = [
    ...["automatic-update", "package-update", "package-transition"]
      .map((name) => [join(packageRoot, "lib", name + ".mjs"), "lib/" + name + ".mjs"]),
    [join(packageRoot, "lib", "update-diagnostics.mjs"), "lib/update-diagnostics.mjs"],
    [join(packageRoot, "lib", "setup-diagnostics.mjs"), "lib/setup-diagnostics.mjs"],
    [join(packageRoot, "lib", "npm-invocation.mjs"), "lib/npm-invocation.mjs"],
    ...["config-utils.mjs", "diagnostic-record.mjs", "deployment-failure.mjs", "automatic-update-state.mjs", "runtime-record.mjs", "windows-directory-retry.mjs", "package-recovery.mjs", "setup-completion.mjs"]
      .map((name) => [join(commonRoot, name), `lib/memorax-code-adapter-common/src/${name}`]),
  ];
  await Promise.all(files.map(async ([source, relativeTarget]) => {
    const target = join(root, relativeTarget);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target);
  }));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    root,
    api: await import(pathToFileURL(join(root, "lib", "automatic-update.mjs")).href),
    diagnostics: await import(pathToFileURL(join(root, "lib", "update-diagnostics.mjs")).href),
    memoraxCodeHome: join(root, "home"),
  };
}

function options(memoraxCodeHome, time, overrides = {}) {
  return {
    memoraxCodeHome,
    installedVersion: "0.1.9",
    completedByVersion: "0.1.9",
    channel: "latest",
    now: () => Date.parse(`2026-08-30T${time}.000Z`),
    resolveTargetVersion: async () => "0.1.9",
    installVersion: async () => true,
    reconcile: async () => true,
    ...overrides,
  };
}

async function readState(api, memoraxCodeHome) {
  return JSON.parse(await readFile(api.automaticUpdateStatePath(memoraxCodeHome), "utf8"));
}

function record(calls, entry, result) {
  calls.push(entry);
  return result;
}
