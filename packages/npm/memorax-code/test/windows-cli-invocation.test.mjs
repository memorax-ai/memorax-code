import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveWindowsCliInvocation,
  selectWindowsCommandCandidate,
} from "../lib/windows-cli-invocation.mjs";
import {
  resolveWindowsCliInvocation as resolveAdapterCommonCliInvocation,
  selectWindowsCommandCandidate as selectAdapterCommonCommand,
} from "../../../ts/memorax-code-adapter-common/src/windows-cli-invocation.mjs";

test("Windows Codex npm shim resolves to its Node entrypoint without a shell", () => {
  const shim = "C:\\MemoraX Code 中文\\bin\\codex.cmd";
  const cli = "C:\\MemoraX Code 中文\\bin\\node_modules\\@openai\\codex\\bin\\codex.js";
  const options = {
    platform: "win32",
    resolvedCommand: shim,
    nodePath: "C:\\node.exe",
    env: { MEMORAX_CODE_CODEX_CLI_JS: cli },
    existsSync: (candidate) => candidate === cli,
  };
  const expected = { command: "C:\\node.exe", args: [cli, "--version"] };
  assert.deepEqual(resolveWindowsCliInvocation("codex", ["--version"], options), expected);
  assert.deepEqual(resolveAdapterCommonCliInvocation("codex", ["--version"], options), expected);
});

test("Windows Claude npm shim resolves the official global CLI entrypoint", () => {
  const shim = "C:\\MemoraX Code 中文\\bin\\claude.cmd";
  const cli = "C:\\MemoraX Code 中文\\bin\\node_modules\\@anthropic-ai\\claude-code\\cli.js";
  assert.deepEqual(resolveWindowsCliInvocation("claude", ["plugin", "list", "--json"], {
    platform: "win32",
    resolvedCommand: shim,
    nodePath: "C:\\node.exe",
    env: {},
    existsSync: (candidate) => candidate === cli,
  }), {
    command: "C:\\node.exe",
    args: [cli, "plugin", "list", "--json"],
  });
});

test("Windows Claude npm shim resolves the official native executable", () => {
  const exe = "C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe";
  assert.deepEqual(resolveWindowsCliInvocation("claude", ["-p", "hello"], {
    platform: "win32",
    resolvedCommand: "C:\\npm\\claude.cmd",
    env: {},
    existsSync: (candidate) => candidate === exe,
  }), { command: exe, args: ["-p", "hello"] });
});

test("Windows DSH npm shim resolves the official Node entrypoint", () => {
  const shim = "C:\\MemoraX Code 中文\\bin\\dsh.cmd";
  const cli = "C:\\MemoraX Code 中文\\bin\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js";
  assert.deepEqual(resolveAdapterCommonCliInvocation("dsh", ["--version"], {
    platform: "win32",
    resolvedCommand: shim,
    nodePath: "C:\\node.exe",
    env: {},
    existsSync: (candidate) => candidate === cli,
  }), {
    command: "C:\\node.exe",
    args: [cli, "--version"],
  });
});

test("Windows command discovery prefers cmd after a bare npm shim", () => {
  const output = "C:\\bin\\codex\r\nC:\\bin\\codex.cmd\r\nC:\\bin\\codex.ps1\r\n";
  assert.equal(selectWindowsCommandCandidate("codex", output), "C:\\bin\\codex.cmd");
  assert.equal(selectAdapterCommonCommand("codex", output), "C:\\bin\\codex.cmd");
});

test("Windows command discovery rejects bare and PowerShell-only shims", () => {
  const output = "C:\\bin\\codex\r\nC:\\bin\\codex.ps1\r\n";
  assert.throws(
    () => selectWindowsCommandCandidate("codex", output),
    /did not return a safe executable or command shim/,
  );
  assert.throws(
    () => selectAdapterCommonCommand("codex", output),
    /did not return a safe executable or command shim/,
  );
});

test("Windows client shims fail closed without trusted entrypoints", () => {
  assert.throws(() => resolveWindowsCliInvocation("codex", [], {
    platform: "win32",
    resolvedCommand: "C:\\bin\\codex.cmd",
    env: {},
    existsSync: () => false,
  }), /refusing to execute codex\.cmd.*MEMORAX_CODE_CODEX_CLI_JS/);
  assert.throws(() => resolveWindowsCliInvocation("claude", [], {
    platform: "win32",
    resolvedCommand: "C:\\bin\\claude.cmd",
    env: {},
    existsSync: () => false,
  }), /refusing to execute claude\.cmd.*MEMORAX_CODE_CLAUDE_CLI_JS/);
  assert.throws(() => resolveAdapterCommonCliInvocation("dsh", [], {
    platform: "win32",
    resolvedCommand: "C:\\bin\\dsh.cmd",
    env: {},
    existsSync: () => false,
  }), /refusing to execute dsh\.cmd.*MEMORAX_CODE_DSH_CLI_JS/);
});

test("native Windows executable invocation remains unchanged", () => {
  assert.deepEqual(resolveWindowsCliInvocation("C:\\bin\\codex.exe", ["exec"], {
    platform: "win32",
  }), { command: "C:\\bin\\codex.exe", args: ["exec"] });
});
