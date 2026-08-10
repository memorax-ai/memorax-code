import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveWindowsCliInvocation,
  resolveWindowsNpmInvocation,
  selectWindowsCommandCandidate,
} from "../../dist/windows-cli-invocation.js";

test("Backend Windows command discovery selects safe executable forms", () => {
  assert.equal(
    selectWindowsCommandCandidate(
      "codex",
      "C:\\bin\\codex\r\nC:\\bin\\codex.cmd\r\nC:\\bin\\codex.ps1\r\n",
    ),
    "C:\\bin\\codex.cmd",
  );
  assert.throws(
    () => selectWindowsCommandCandidate(
      "codex",
      "C:\\bin\\codex\r\nC:\\bin\\codex.ps1\r\n",
    ),
    /did not return a safe executable or command shim/,
  );
});

test("Backend resolves a Windows Codex shim through its Node entrypoint", () => {
  const cli = "C:\\npm\\node_modules\\@openai\\codex\\bin\\codex.js";
  assert.deepEqual(resolveWindowsCliInvocation("codex", ["app-server", "--stdio"], {
    platform: "win32",
    resolvedCommand: "C:\\npm\\codex.cmd",
    nodePath: "C:\\node.exe",
    env: {},
    existsSync: (candidate) => candidate === cli,
  }), {
    command: "C:\\node.exe",
    args: [cli, "app-server", "--stdio"],
  });
});

test("Backend resolves Windows npm through the current Node executable", () => {
  const npmCli = "C:\\node\\node_modules\\npm\\bin\\npm-cli.js";
  assert.deepEqual(resolveWindowsNpmInvocation(
    ["uninstall", "-g", "@memorax/memorax-code"],
    { npm_execpath: npmCli },
    {
      platform: "win32",
      nodePath: "C:\\node\\node.exe",
      existsSync: (candidate) => candidate === npmCli,
    },
  ), {
    command: "C:\\node\\node.exe",
    args: [npmCli, "uninstall", "-g", "@memorax/memorax-code"],
  });
});

test("Backend Windows npm resolution fails closed without a JavaScript entrypoint", () => {
  assert.throws(
    () => resolveWindowsNpmInvocation(
      ["uninstall", "-g", "@memorax/memorax-code"],
      { npm_execpath: "C:\\node\\npm.cmd" },
      {
        platform: "win32",
        nodePath: "C:\\node\\node.exe",
        existsSync: (candidate) => candidate.endsWith("npm.cmd"),
      },
    ),
    /npm CLI JavaScript entrypoint.*MEMORAX_CODE_NPM_EXEC_PATH.*npm_execpath.*NPM_CLI_JS/,
  );
});
