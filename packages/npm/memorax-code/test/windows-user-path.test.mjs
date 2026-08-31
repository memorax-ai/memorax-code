import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureWindowsNpmGlobalPath,
  resolveWindowsNpmGlobalPrefix,
  updateWindowsUserPath,
} from "../lib/windows-user-path.mjs";

const NPM_GLOBAL_BIN = "C:\\Users\\tester\\AppData\\Roaming\\npm";
const SYSTEM_PATH = "C:\\Windows\\System32";

test("Windows setup adds the verified npm global bin to process and user PATH", () => {
  const env = { Path: SYSTEM_PATH };
  const calls = [];

  const result = ensureWindowsNpmGlobalPath({
    env,
    platform: "win32",
    resolveGlobalPrefix: () => NPM_GLOBAL_BIN,
    existsSync: (candidate) => candidate === `${NPM_GLOBAL_BIN}\\memorax-code.cmd`
      || candidate === `${NPM_GLOBAL_BIN}\\memorax-cli.cmd`,
    updateUserPath(globalBin) {
      calls.push(globalBin);
      return { changed: true };
    },
  });

  assert.equal(env.Path, `${NPM_GLOBAL_BIN};${SYSTEM_PATH}`);
  assert.deepEqual(calls, [NPM_GLOBAL_BIN]);
  assert.deepEqual(result, {
    status: "updated",
    processPathChanged: true,
    userPathChanged: true,
    restartRecommended: true,
  });
});

test("Windows setup recognizes an existing PATH entry case-insensitively", () => {
  const env = { PATH: `${SYSTEM_PATH};${NPM_GLOBAL_BIN.toUpperCase()}\\` };

  const result = ensureWindowsNpmGlobalPath({
    env,
    platform: "win32",
    resolveGlobalPrefix: () => NPM_GLOBAL_BIN,
    existsSync: () => true,
    updateUserPath: () => ({ changed: false }),
  });

  assert.equal(env.PATH, `${SYSTEM_PATH};${NPM_GLOBAL_BIN.toUpperCase()}\\`);
  assert.deepEqual(result, {
    status: "unchanged",
    processPathChanged: false,
    userPathChanged: false,
    restartRecommended: false,
  });
});

test("Windows setup repairs a stale process even when the user PATH is current", () => {
  const env = { PATH: SYSTEM_PATH };

  const result = ensureWindowsNpmGlobalPath({
    env,
    platform: "win32",
    resolveGlobalPrefix: () => NPM_GLOBAL_BIN,
    existsSync: () => true,
    updateUserPath: () => ({ changed: false }),
  });

  assert.equal(env.PATH, `${NPM_GLOBAL_BIN};${SYSTEM_PATH}`);
  assert.deepEqual(result, {
    status: "updated",
    processPathChanged: true,
    userPathChanged: false,
    restartRecommended: true,
  });
});

test("Windows setup is idempotent across repeated repairs", () => {
  const env = { Path: SYSTEM_PATH };
  let userPathChanged = true;
  const options = {
    env,
    platform: "win32",
    resolveGlobalPrefix: () => NPM_GLOBAL_BIN,
    existsSync: () => true,
    updateUserPath: () => {
      const changed = userPathChanged;
      userPathChanged = false;
      return { changed };
    },
  };

  assert.equal(ensureWindowsNpmGlobalPath(options).status, "updated");
  assert.equal(ensureWindowsNpmGlobalPath(options).status, "unchanged");
  assert.equal(env.Path, `${NPM_GLOBAL_BIN};${SYSTEM_PATH}`);
});

test("Windows setup keeps the process repair when the persistent update fails", () => {
  const env = { PATH: SYSTEM_PATH };

  const result = ensureWindowsNpmGlobalPath({
    env,
    platform: "win32",
    resolveGlobalPrefix: () => NPM_GLOBAL_BIN,
    existsSync: () => true,
    updateUserPath: () => {
      throw new Error("registry denied");
    },
  });

  assert.equal(env.PATH, `${NPM_GLOBAL_BIN};${SYSTEM_PATH}`);
  assert.deepEqual(result, {
    status: "warning",
    reason: "user_path_update_failed",
    processPathChanged: true,
    userPathChanged: false,
    restartRecommended: false,
  });
});

test("Windows setup does not change PATH when global shims are incomplete", () => {
  const env = { PATH: SYSTEM_PATH };
  let updateCalled = false;

  const result = ensureWindowsNpmGlobalPath({
    env,
    platform: "win32",
    resolveGlobalPrefix: () => NPM_GLOBAL_BIN,
    existsSync: (candidate) => candidate.endsWith("memorax-code.cmd"),
    updateUserPath: () => {
      updateCalled = true;
      return { changed: true };
    },
  });

  assert.equal(env.PATH, SYSTEM_PATH);
  assert.equal(updateCalled, false);
  assert.deepEqual(result, {
    status: "warning",
    reason: "global_shims_missing",
    processPathChanged: false,
    userPathChanged: false,
    restartRecommended: false,
  });
});

test("non-Windows setup leaves PATH and user settings untouched", () => {
  const env = { PATH: "/usr/bin" };
  let resolveCalled = false;

  const result = ensureWindowsNpmGlobalPath({
    env,
    platform: "linux",
    resolveGlobalPrefix: () => {
      resolveCalled = true;
      return "/usr/local";
    },
    updateUserPath: () => {
      throw new Error("must not run");
    },
  });

  assert.equal(resolveCalled, false);
  assert.equal(env.PATH, "/usr/bin");
  assert.deepEqual(result, {
    status: "skipped",
    reason: "unsupported_platform",
    processPathChanged: false,
    userPathChanged: false,
    restartRecommended: false,
  });
});

test("Windows npm prefix resolution uses the npm JavaScript entrypoint", () => {
  const npmCli = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
  const calls = [];

  const prefix = resolveWindowsNpmGlobalPrefix({
    env: { MEMORAX_CODE_NPM_EXEC_PATH: npmCli },
    platform: "win32",
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    existsSync: (candidate) => candidate === npmCli,
    spawnSync(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, signal: null, stdout: `${NPM_GLOBAL_BIN}\r\n`, stderr: "" };
    },
  });

  assert.equal(prefix, NPM_GLOBAL_BIN);
  assert.equal(calls[0].command, "C:\\Program Files\\nodejs\\node.exe");
  assert.deepEqual(calls[0].args, [npmCli, "prefix", "-g"]);
  assert.equal(calls[0].options.windowsHide, true);
});

test("Windows user PATH update passes the global bin without command interpolation", () => {
  const calls = [];
  const systemRoot = "C:\\Windows";
  const powerShell = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;

  const result = updateWindowsUserPath(NPM_GLOBAL_BIN, {
    env: { SystemRoot: systemRoot, Path: SYSTEM_PATH },
    existsSync: (candidate) => candidate === powerShell,
    spawnSync(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, signal: null, stdout: '{"changed":true}', stderr: "" };
    },
  });

  assert.deepEqual(result, { changed: true });
  assert.equal(calls[0].command, powerShell);
  assert.ok(calls[0].args.includes("-EncodedCommand"));
  assert.equal(calls[0].options.env.MEMORAX_CODE_WINDOWS_NPM_GLOBAL_BIN, NPM_GLOBAL_BIN);
  assert.doesNotMatch(calls[0].args.join(" "), /tester|AppData|Roaming/);
});
