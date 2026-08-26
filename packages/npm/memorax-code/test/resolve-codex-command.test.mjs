import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, win32 } from "node:path";
import test from "node:test";
import {
  ensureCodexCommandEnv,
  resolveCodexCommand,
  resolveWindowsCodexAppCommand,
} from "../lib/resolve-codex-command.mjs";

async function executable(path) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, 0o755);
  return path;
}

test("Codex command resolution preserves explicit overrides and PATH CLI precedence", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-command-path-"));
  try {
    const bin = join(root, "bin");
    await mkdir(bin, { recursive: true });
    await executable(join(bin, "codex"));
    const appCommand = await executable(join(root, "Applications", "ChatGPT.app", "Contents", "Resources", "codex"));

    assert.deepEqual(resolveCodexCommand({
      env: { PATH: bin, MEMORAX_CODE_CODEX_COMMAND: "/custom/npm-codex" },
      homeDir: root,
      platform: "darwin",
      applicationRoots: [join(root, "Applications")],
    }), { command: "/custom/npm-codex", source: "npm-override" });
    assert.deepEqual(resolveCodexCommand({
      env: { PATH: bin, CODEX_CLI_PATH: "/custom/codex" },
      homeDir: root,
      platform: "darwin",
      applicationRoots: [join(root, "Applications")],
    }), { command: "/custom/codex", source: "configured" });
    assert.deepEqual(resolveCodexCommand({
      env: { PATH: `${bin}${delimiter}/missing` },
      homeDir: root,
      platform: "darwin",
      applicationRoots: [join(root, "Applications")],
    }), { command: "codex", source: "path" });
    assert.ok(appCommand.replaceAll("\\", "/").endsWith("ChatGPT.app/Contents/Resources/codex"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex command resolution uses the desktop App bundled runtime without a PATH CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-command-app-"));
  try {
    const appCommand = await executable(join(root, "Applications", "ChatGPT.app", "Contents", "Resources", "codex"));
    const extensions = join(root, ".vscode", "extensions");
    await vscodeExtension(extensions, "openai.chatgpt-9.9.9-darwin-arm64", {
      publisher: "openai",
      name: "chatgpt",
      version: "9.9.9",
      targetPlatform: "darwin-arm64",
    });
    const env = { PATH: join(root, "empty-bin") };
    const resolved = ensureCodexCommandEnv({
      env,
      homeDir: root,
      platform: "darwin",
      arch: "arm64",
      applicationRoots: [join(root, "Applications")],
      vscodeExtensionRoots: [extensions],
    });

    assert.deepEqual(resolved, { command: appCommand, source: "app-bundled" });
    assert.equal(env.CODEX_CLI_PATH, appCommand);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex command resolution uses the runnable Windows App plugin runtime", () => {
  const appCommand = win32.join(
    "C:\\Users\\tester\\.codex",
    "plugins",
    ".plugin-appserver",
    "codex.exe",
  );
  const calls = [];
  const env = {
    PATH: "C:\\missing-bin",
    PATHEXT: ".EXE;.CMD;.BAT;.COM",
  };
  const resolved = ensureCodexCommandEnv({
    env,
    homeDir: "C:\\Users\\tester",
    platform: "win32",
    arch: "x64",
    vscodeExtensionRoots: [],
    windowsAppProbe(command, args, options) {
      calls.push({ command, args, options });
      return { status: 0, stdout: "codex-cli 0.146.0-test\r\n", stderr: "" };
    },
    windowsPathExists: (candidate, platform) => candidate === appCommand && platform === "win32",
  });

  assert.deepEqual(resolved, { command: appCommand, source: "app-bundled" });
  assert.equal(env.CODEX_CLI_PATH, appCommand);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, appCommand);
  assert.deepEqual(calls[0].args, ["--version"]);
  assert.equal(calls[0].options.timeout, 2_000);
});

test("Codex command resolution falls back from an inaccessible Windows PATH alias", () => {
  const pathCommand = "C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps\\codex.exe";
  const appCommand = "C:\\Users\\tester\\.codex\\plugins\\.plugin-appserver\\codex.exe";
  const pathCalls = [];
  const appCalls = [];
  const env = {
    PATH: "C:\\Users\\tester\\AppData\\Local\\Microsoft\\WindowsApps",
    PATHEXT: ".EXE;.CMD;.BAT;.COM",
  };
  const resolved = resolveCodexCommand({
    env,
    homeDir: "C:\\Users\\tester",
    platform: "win32",
    arch: "x64",
    pathCommandAvailable: () => true,
    vscodeExtensionRoots: [],
    windowsAppProbe(command, args, options) {
      appCalls.push({ command, args, options });
      return { status: 0, stdout: "codex-cli 0.146.0-test\r\n", stderr: "" };
    },
    windowsAppRuntimePaths: [appCommand],
    windowsPathExists: (candidate) => candidate === appCommand,
    windowsPathProbe(command, args, options) {
      pathCalls.push({ command, args, options });
      if (command === "where.exe") {
        return { status: 0, stdout: `${pathCommand}\r\n`, stderr: "" };
      }
      return {
        status: null,
        stdout: "",
        stderr: "",
        error: Object.assign(new Error("spawn EPERM"), { code: "EPERM" }),
      };
    },
  });

  assert.deepEqual(resolved, { command: appCommand, source: "app-bundled" });
  assert.equal(pathCalls.length, 2);
  assert.equal(pathCalls[0].command, "where.exe");
  assert.deepEqual(pathCalls[0].args, ["codex"]);
  assert.equal(pathCalls[1].command, pathCommand);
  assert.deepEqual(pathCalls[1].args, ["--version"]);
  assert.equal(pathCalls[1].options.timeout, 2_000);
  assert.equal(appCalls.length, 1);
  assert.equal(appCalls[0].command, appCommand);
});

test("Codex command resolution keeps a runnable Windows PATH command ahead of the App runtime", () => {
  const pathCommand = "C:\\tools\\codex.exe";
  const pathCalls = [];
  let appProbeCount = 0;
  const resolved = resolveCodexCommand({
    env: {
      PATH: "C:\\tools",
      PATHEXT: ".EXE;.CMD;.BAT;.COM",
    },
    homeDir: "C:\\Users\\tester",
    platform: "win32",
    arch: "x64",
    pathCommandAvailable: () => true,
    vscodeExtensionRoots: [],
    windowsAppProbe() {
      appProbeCount += 1;
      return { status: 0, stdout: "codex-cli app-test\r\n", stderr: "" };
    },
    windowsAppRuntimePaths: ["C:\\Users\\tester\\.codex\\plugins\\.plugin-appserver\\codex.exe"],
    windowsPathExists: () => true,
    windowsPathProbe(command, args, options) {
      pathCalls.push({ command, args, options });
      if (command === "where.exe") {
        return { status: 0, stdout: `${pathCommand}\r\n`, stderr: "" };
      }
      return { status: 0, stdout: "codex-cli path-test\r\n", stderr: "" };
    },
  });

  assert.deepEqual(resolved, { command: "codex", source: "path" });
  assert.equal(pathCalls.length, 2);
  assert.equal(pathCalls[1].command, pathCommand);
  assert.equal(pathCalls[1].options.timeout, 2_000);
  assert.equal(appProbeCount, 0);
});

test("Windows Codex App resolution rejects inaccessible and failing plugin runtimes", () => {
  const appCommand = "C:\\Users\\tester\\.codex\\plugins\\.plugin-appserver\\codex.exe";
  const common = {
    env: {},
    platform: "win32",
    runtimePaths: [appCommand],
    pathExists: () => true,
  };
  assert.equal(resolveWindowsCodexAppCommand({
    ...common,
    spawnSyncImpl: () => ({
      status: null,
      stdout: "",
      stderr: "",
      error: Object.assign(new Error("spawn EPERM"), { code: "EPERM" }),
    }),
  }), undefined);
  assert.equal(resolveWindowsCodexAppCommand({
    ...common,
    spawnSyncImpl: () => ({ status: 7, stdout: "", stderr: "failed" }),
  }), undefined);
  assert.equal(resolveWindowsCodexAppCommand({
    ...common,
    spawnSyncImpl: () => { throw new Error("spawn failed"); },
  }), undefined);
});

test("Codex command resolution uses the newest matching VS Code bundled runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-command-vscode-"));
  try {
    const extensions = join(root, ".vscode", "extensions");
    await vscodeExtension(extensions, "openai.chatgpt-1.9.0-darwin-arm64", {
      publisher: "openai",
      name: "chatgpt",
      version: "1.9.0",
      targetPlatform: "darwin-arm64",
    });
    const expected = await vscodeExtension(extensions, "openai.chatgpt-1.10.0-darwin-arm64", {
      publisher: "openai",
      name: "chatgpt",
      version: "1.10.0",
      targetPlatform: "darwin-arm64",
    });
    await vscodeExtension(extensions, "openai.chatgpt-9.0.0-linux-x64", {
      publisher: "openai",
      name: "chatgpt",
      version: "9.0.0",
      targetPlatform: "linux-x64",
    });
    await vscodeExtension(extensions, "lookalike.chatgpt-99.0.0-darwin-arm64", {
      publisher: "lookalike",
      name: "chatgpt",
      version: "99.0.0",
      targetPlatform: "darwin-arm64",
    });

    const env = { PATH: join(root, "empty-bin") };
    const resolved = ensureCodexCommandEnv({
      env,
      homeDir: root,
      platform: "darwin",
      arch: "arm64",
      applicationRoots: [join(root, "Applications")],
      vscodeExtensionRoots: [extensions],
    });

    assert.deepEqual(resolved, { command: expected, source: "vscode-bundled" });
    assert.equal(env.CODEX_CLI_PATH, expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex command resolution reports unavailable when neither client runtime exists", () => {
  assert.deepEqual(resolveCodexCommand({
    env: { PATH: "/missing" },
    homeDir: "/missing-home",
    platform: "darwin",
    applicationRoots: ["/missing-applications"],
    vscodeExtensionRoots: ["/missing-extensions"],
  }), { command: "codex", source: "unavailable" });
});

async function vscodeExtension(extensionsRoot, directory, {
  publisher,
  name,
  version,
  targetPlatform,
}) {
  const extensionRoot = join(extensionsRoot, directory);
  await mkdir(extensionRoot, { recursive: true });
  await writeFile(join(extensionRoot, "package.json"), `${JSON.stringify({
    publisher,
    name,
    version,
    __metadata: { targetPlatform },
  })}\n`);
  return await executable(join(extensionRoot, "bin", "macos-aarch64", "codex"));
}
