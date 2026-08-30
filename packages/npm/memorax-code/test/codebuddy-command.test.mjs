import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  defaultCodeBuddyHome,
  resolveCodeBuddyCommand,
} from "../lib/resolve-codebuddy-command.mjs";

test("CodeBuddy resolver honors an explicit command", () => {
  assert.deepEqual(resolveCodeBuddyCommand({
    env: { MEMORAX_CODE_CODEBUDDY_COMMAND: "/custom/codebuddy", PATH: "" },
  }), { command: "/custom/codebuddy", source: "configured" });
});

test("CodeBuddy resolver finds the WorkBuddy macOS bundled CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-codebuddy-command-"));
  const command = join(root, "WorkBuddy.app", "Contents", "Resources", "app.asar.unpacked", "cli", "bin", "codebuddy");
  await mkdir(join(root, "WorkBuddy.app", "Contents", "Resources", "app.asar.unpacked", "cli", "bin"), { recursive: true });
  await writeFile(command, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(command, 0o755);
  assert.deepEqual(resolveCodeBuddyCommand({
    env: { PATH: "" },
    homeDir: root,
    applicationRoots: [root],
    platform: "darwin",
  }), { command, source: "app-bundled" });
});

test("CodeBuddy resolver reports unavailable without a runtime", () => {
  assert.equal(resolveCodeBuddyCommand({
    env: { PATH: "" },
    homeDir: "/nonexistent/memorax-codebuddy-home",
    applicationRoots: ["/nonexistent/Applications"],
    platform: "darwin",
  }).source, "unavailable");
});

test("CodeBuddy resolver finds the Windows WorkBuddy script under LocalAppData Programs", () => {
  const root = "C:\\Users\\tester\\AppData\\Local\\Programs\\WorkBuddy";
  const command = `${root}\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy`;
  assert.deepEqual(resolveCodeBuddyCommand({
    env: { PATH: "" },
    platform: "win32",
    windowsRoots: [root],
    pathExists: (candidate) => candidate === command,
  }), { command, source: "app-bundled" });
});

test("CodeBuddy resolver defaults Windows plugin state to .codebuddy", () => {
  assert.equal(
    defaultCodeBuddyHome({}, "C:\\Users\\tester", "win32"),
    "C:\\Users\\tester\\.codebuddy",
  );
});
