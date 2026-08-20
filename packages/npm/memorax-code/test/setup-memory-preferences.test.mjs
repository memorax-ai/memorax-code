import assert from "node:assert/strict";
import test from "node:test";
import { detectSetupMemoryPreferences } from "../lib/setup-memory-preferences.mjs";

test("setup preferences use the macOS account and preferred UI language", () => {
  const calls = [];
  const preferences = detectSetupMemoryPreferences({
    platform: "darwin",
    env: { LANG: "C.UTF-8" },
    readUserInfo: () => ({ uid: 501, username: " local-user " }),
    runCommand: (command, args) => {
      calls.push({ command, args });
      return { status: 0, stdout: '(\n    "zh-Hans-CN",\n    "en-CN"\n)\n' };
    },
    readIntlLocale: () => "en-US",
  });

  assert.deepEqual(preferences, { userId: "local-user", outputLanguage: "zh" });
  assert.deepEqual(calls, [{
    command: "/usr/bin/defaults",
    args: ["read", "-g", "AppleLanguages"],
  }]);
});

test("setup preferences use the Linux message locale without running a command", () => {
  const preferences = detectSetupMemoryPreferences({
    platform: "linux",
    env: { LANG: "zh_CN.UTF-8", LC_MESSAGES: "en_GB.UTF-8" },
    readUserInfo: () => ({ uid: 1000, username: "developer" }),
    runCommand: () => assert.fail("Linux locale detection must not spawn a command"),
    readIntlLocale: () => "zh-CN",
  });

  assert.deepEqual(preferences, { userId: "developer", outputLanguage: "en" });
});

test("setup preferences use the Windows UI culture", () => {
  let invocation;
  const preferences = detectSetupMemoryPreferences({
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    readUserInfo: () => ({ uid: -1, username: "Alice" }),
    runCommand: (command, args) => {
      invocation = { command, args };
      return { status: 0, stdout: "zh-TW\r\n" };
    },
    readIntlLocale: () => "en-US",
  });

  assert.deepEqual(preferences, { userId: "Alice", outputLanguage: "zh" });
  assert.equal(invocation.command, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(invocation.args.slice(0, 3), ["-NoLogo", "-NoProfile", "-NonInteractive"]);
});

test("setup preferences leave elevated or unavailable values for interactive fallback", () => {
  const preferences = detectSetupMemoryPreferences({
    platform: "linux",
    env: {},
    readUserInfo: () => ({ uid: 0, username: "root" }),
    readIntlLocale: () => "",
  });

  assert.deepEqual(preferences, { userId: undefined, outputLanguage: undefined });
});
