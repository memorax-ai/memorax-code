import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  ensureClaudeCommandEnv,
  resolveClaudeCommand,
  resolveWindowsClaudeDesktopCodeCommand,
} from "../lib/resolve-claude-command.mjs";

async function executable(path) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, 0o755);
  return path;
}

test("Claude command resolution preserves an explicit command and PATH CLI precedence", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-command-path-"));
  try {
    const bin = join(root, "bin");
    await executable(join(bin, "claude"));

    assert.deepEqual(resolveClaudeCommand({
      env: { PATH: bin, MEMORAX_CODE_CLAUDE_COMMAND: "/custom/claude" },
      homeDir: root,
      platform: "darwin",
    }), { command: "/custom/claude", source: "configured" });
    assert.deepEqual(resolveClaudeCommand({
      env: { PATH: bin },
      homeDir: root,
      platform: "darwin",
    }), { command: "claude", source: "path" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude command resolution uses the newest macOS Claude Desktop Code runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-command-desktop-"));
  try {
    const desktopRoot = join(root, "Library", "Application Support", "Claude", "claude-code");
    await executable(join(desktopRoot, "2.9.0", "claude.app", "Contents", "MacOS", "claude"));
    const expected = await executable(join(
      desktopRoot,
      "2.10.0",
      "claude.app",
      "Contents",
      "MacOS",
      "claude",
    ));
    await mkdir(join(desktopRoot, "99.0.0"), { recursive: true });

    const env = { PATH: join(root, "empty-bin") };
    const resolved = ensureClaudeCommandEnv({
      env,
      homeDir: root,
      platform: "darwin",
      arch: "arm64",
      desktopCodeRoots: [desktopRoot],
      desktopCodeProbe: () => ({ status: 0, stdout: "2.10.0\n", stderr: "" }),
      vscodeExtensionRoots: [],
    });

    assert.deepEqual(resolved, { command: expected, source: "app-bundled" });
    assert.equal(env.MEMORAX_CODE_CLAUDE_COMMAND, expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude command resolution finds a macOS Claude Desktop runtime under a build directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-command-desktop-build-"));
  try {
    const desktopRoot = join(root, "Library", "Application Support", "Claude", "claude-code");
    await mkdir(join(desktopRoot, "2.10.0", "not-a-runtime"), { recursive: true });
    const expected = await executable(join(
      desktopRoot,
      "2.10.0",
      "0123abcd",
      "claude.app",
      "Contents",
      "MacOS",
      "claude",
    ));

    const resolved = ensureClaudeCommandEnv({
      env: { PATH: join(root, "empty-bin") },
      homeDir: root,
      platform: "darwin",
      arch: "arm64",
      desktopCodeRoots: [desktopRoot],
      desktopCodeProbe: () => ({ status: 0, stdout: "2.10.0\n", stderr: "" }),
      vscodeExtensionRoots: [],
    });

    assert.deepEqual(resolved, { command: expected, source: "app-bundled" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude command resolution uses the newest Windows Claude Desktop Code runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-command-windows-desktop-"));
  try {
    const appData = join(root, "Roaming");
    const desktopRoot = join(appData, "Claude", "claude-code");
    await executable(join(desktopRoot, "2.9.0", "claude.exe"));
    const expected = await executable(join(desktopRoot, "2.10.0", "claude.exe"));
    await mkdir(join(desktopRoot, "99.0.0"), { recursive: true });

    const env = {
      APPDATA: appData,
      LOCALAPPDATA: join(root, "Local"),
      PATH: join(root, "empty-bin"),
      PATHEXT: ".EXE;.CMD;.BAT;.COM",
    };
    const resolved = ensureClaudeCommandEnv({
      env,
      homeDir: root,
      platform: "win32",
      arch: "x64",
      desktopCodeProbe: () => ({ status: 0, stdout: "2.10.0\r\n", stderr: "" }),
      vscodeExtensionRoots: [],
      windowsAppQuery() {
        throw new Error("the AppX query should not run when the AppData runtime exists");
      },
    });

    assert.deepEqual(resolved, { command: expected, source: "app-bundled" });
    assert.equal(env.MEMORAX_CODE_CLAUDE_COMMAND, expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude Desktop resolution skips runtimes that fail the version probe", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-command-probe-"));
  try {
    const desktopRoot = join(root, "Claude", "claude-code");
    const older = await executable(join(desktopRoot, "2.9.0", "claude.exe"));
    const newest = await executable(join(desktopRoot, "2.10.0", "claude.exe"));
    const calls = [];

    const resolved = resolveClaudeCommand({
      env: {
        PATH: join(root, "empty-bin"),
        PATHEXT: ".EXE;.CMD;.BAT;.COM",
      },
      homeDir: root,
      platform: "win32",
      arch: "x64",
      desktopCodeRoots: [desktopRoot],
      desktopCodeProbe(command, args, options) {
        calls.push({ command, args, options });
        if (command === newest) {
          return {
            status: null,
            stdout: "",
            stderr: "",
            error: Object.assign(new Error("spawn EPERM"), { code: "EPERM" }),
          };
        }
        return { status: 0, stdout: "2.9.0\r\n", stderr: "" };
      },
      vscodeExtensionRoots: [],
      windowsAppPackageFamilies: [],
    });

    assert.deepEqual(resolved, { command: older, source: "app-bundled" });
    assert.deepEqual(calls.map(({ command }) => command), [newest, older]);
    assert.deepEqual(calls[0].args, ["--version"]);
    assert.equal(calls[0].options.timeout, 10_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude command resolution falls back to VS Code when App runtimes fail the version probe", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-command-probe-fallback-"));
  try {
    const desktopRoot = join(root, "Claude", "claude-code");
    const broken = await executable(join(desktopRoot, "2.10.0", "claude.exe"));
    const extensions = join(root, ".vscode", "extensions");
    const expected = await vscodeExtension(extensions, "anthropic.claude-code-2.10.0-win32-x64", {
      publisher: "Anthropic",
      name: "claude-code",
      version: "2.10.0",
      targetPlatform: "win32-x64",
      executableName: "claude.exe",
    });

    const resolved = resolveClaudeCommand({
      env: {
        PATH: join(root, "empty-bin"),
        PATHEXT: ".EXE;.CMD;.BAT;.COM",
      },
      homeDir: root,
      platform: "win32",
      arch: "x64",
      desktopCodeRoots: [desktopRoot],
      desktopCodeProbe: (command) => ({
        status: 1,
        stdout: "",
        stderr: command === broken ? "corrupt runtime" : "unexpected runtime",
      }),
      vscodeExtensionRoots: [extensions],
      windowsAppPackageFamilies: [],
    });

    assert.deepEqual(resolved, { command: expected, source: "vscode-bundled" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude command resolution uses the MSIX-local Windows Desktop Code runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-command-windows-msix-"));
  try {
    const family = "Claude_pzs8sxrjxfjjc";
    const localAppData = join(root, "Local");
    const desktopRoot = join(
      localAppData,
      "Packages",
      family,
      "LocalCache",
      "Roaming",
      "Claude",
      "claude-code",
    );
    const expected = await executable(join(desktopRoot, "2.10.0", "claude.exe"));
    const calls = [];
    const env = {
      APPDATA: join(root, "Roaming"),
      LOCALAPPDATA: localAppData,
      PATH: join(root, "empty-bin"),
      PATHEXT: ".EXE;.CMD;.BAT;.COM",
      SystemRoot: "C:\\Windows",
    };
    const resolved = ensureClaudeCommandEnv({
      env,
      homeDir: root,
      platform: "win32",
      arch: "x64",
      desktopCodeProbe: () => ({ status: 0, stdout: "2.10.0\r\n", stderr: "" }),
      vscodeExtensionRoots: [],
      windowsAppQuery(command, args, options) {
        calls.push({ command, args, options });
        return { status: 0, stdout: `\uFEFF${family}\r\n${family}\r\n`, stderr: "" };
      },
    });

    assert.deepEqual(resolved, { command: expected, source: "app-bundled" });
    assert.equal(env.MEMORAX_CODE_CLAUDE_COMMAND, expected);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    assert.deepEqual(calls[0].args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
    assert.match(calls[0].args[4], /Get-AppxPackage -Name 'Claude'/);
    assert.match(calls[0].args[4], /\$_\.PackageFamilyName/);
    assert.equal(calls[0].options.timeout, 10_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows Claude Desktop resolution ignores failed and malformed package queries", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-command-windows-query-"));
  try {
    const malformedRuntime = join(
      root,
      "Packages",
      "Claude",
      "escape",
      "LocalCache",
      "Roaming",
      "Claude",
      "claude-code",
      "2.10.0",
      "claude.exe",
    );
    await executable(malformedRuntime);
    const common = {
      env: { LOCALAPPDATA: root, SystemRoot: "C:\\Windows" },
      homeDir: root,
      platform: "win32",
    };

    assert.equal(resolveWindowsClaudeDesktopCodeCommand({
      ...common,
      spawnSyncImpl: () => ({ status: 1, stdout: "", stderr: "failed" }),
    }), undefined);
    assert.equal(resolveWindowsClaudeDesktopCodeCommand({
      ...common,
      spawnSyncImpl: () => ({ status: 0, stdout: "Claude/escape\r\n", stderr: "" }),
    }), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an installed Windows Claude App without a downloaded Code runtime remains unavailable", () => {
  assert.deepEqual(resolveClaudeCommand({
    env: {
      APPDATA: "C:\\Users\\tester\\AppData\\Roaming",
      LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
      PATH: "C:\\missing-bin",
      PATHEXT: ".EXE;.CMD;.BAT;.COM",
    },
    homeDir: "C:\\Users\\tester",
    platform: "win32",
    arch: "x64",
    desktopCodeRoots: [],
    vscodeExtensionRoots: [],
    windowsAppQuery: () => ({
      status: 0,
      stdout: "Claude_pzs8sxrjxfjjc\r\n",
      stderr: "",
    }),
  }), { command: "claude", source: "unavailable" });
});

test("Claude command resolution uses the newest matching VS Code bundled runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-claude-command-vscode-"));
  try {
    const extensions = join(root, ".vscode", "extensions");
    await vscodeExtension(extensions, "anthropic.claude-code-2.9.0-darwin-arm64", {
      publisher: "Anthropic",
      name: "claude-code",
      version: "2.9.0",
      targetPlatform: "darwin-arm64",
    });
    const expected = await vscodeExtension(extensions, "anthropic.claude-code-2.10.0-darwin-arm64", {
      publisher: "Anthropic",
      name: "claude-code",
      version: "2.10.0",
      targetPlatform: "darwin-arm64",
    });
    await vscodeExtension(extensions, "anthropic.claude-code-99.0.0-linux-x64", {
      publisher: "Anthropic",
      name: "claude-code",
      version: "99.0.0",
      targetPlatform: "linux-x64",
    });

    const env = { PATH: join(root, "empty-bin") };
    const resolved = ensureClaudeCommandEnv({
      env,
      homeDir: root,
      platform: "darwin",
      arch: "arm64",
      vscodeExtensionRoots: [extensions],
    });

    assert.deepEqual(resolved, { command: expected, source: "vscode-bundled" });
    assert.equal(env.MEMORAX_CODE_CLAUDE_COMMAND, expected);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude command resolution reports unavailable when neither runtime exists", () => {
  assert.deepEqual(resolveClaudeCommand({
    env: { PATH: "/missing" },
    homeDir: "/missing-home",
    platform: "darwin",
    vscodeExtensionRoots: ["/missing-extensions"],
  }), { command: "claude", source: "unavailable" });
});

async function vscodeExtension(extensionsRoot, directory, {
  publisher,
  name,
  version,
  targetPlatform,
  executableName = "claude",
}) {
  const extensionRoot = join(extensionsRoot, directory);
  await mkdir(join(extensionRoot, "resources", "native-binary"), { recursive: true });
  await writeFile(join(extensionRoot, "package.json"), `${JSON.stringify({
    publisher,
    name,
    version,
    __metadata: { targetPlatform },
  })}\n`);
  return await executable(join(extensionRoot, "resources", "native-binary", executableName));
}
