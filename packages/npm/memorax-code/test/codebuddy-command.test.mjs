import assert from "node:assert/strict";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";

const packageRoot = await mkdtemp(join(tmpdir(), "memorax-codebuddy-resolver-"));
after(() => rm(packageRoot, { recursive: true, force: true }));
const commonRoot = join(packageRoot, "memorax-code-adapter-common", "src", "clients");
await mkdir(commonRoot, { recursive: true });
for (const name of ["resolve-codebuddy-command.mjs", "vscode-extension-command.mjs"]) {
  await copyFile(new URL(`../lib/${name}`, import.meta.url), join(packageRoot, name));
}
await copyFile(
  new URL("../../../ts/memorax-code-adapter-common/src/clients/codebuddy-command.mjs", import.meta.url),
  join(commonRoot, "codebuddy-command.mjs"),
);
const {
  defaultCodeBuddyHome,
  defaultWorkBuddyHome,
  resolveCodeBuddyCommand,
  resolveWorkBuddyCommand,
  ensureCodeBuddyCommandEnv,
  ensureWorkBuddyCommandEnv,
} = await import(
  pathToFileURL(join(packageRoot, "resolve-codebuddy-command.mjs")).href
);
const common = await import(pathToFileURL(join(commonRoot, "codebuddy-command.mjs")).href);

test("CodeBuddy resolver honors an explicit command", () => {
  assert.deepEqual(resolveCodeBuddyCommand({
    env: { MEMORAX_CODE_CODEBUDDY_COMMAND: "/custom/codebuddy", PATH: "" },
  }), { command: "/custom/codebuddy", source: "configured" });
  const env = {
    CODEBUDDY_CLI_PATH: "/custom/codebuddy",
    WORKBUDDY_CODEBUDDY_PATH: "/custom/workbuddy",
    PATH: "",
  };
  assert.equal(ensureCodeBuddyCommandEnv({ env }).command, "/custom/codebuddy");
  assert.equal(ensureWorkBuddyCommandEnv({ env }).command, "/custom/workbuddy");
  assert.equal(env.MEMORAX_CODE_CODEBUDDY_COMMAND, "/custom/codebuddy");
  assert.equal(env.MEMORAX_CODE_WORKBUDDY_COMMAND, "/custom/workbuddy");
});

test("WorkBuddy resolver discovers its macOS bundle independently of CodeBuddy CLI", async () => {
  const root = join(packageRoot, "Applications");
  const command = join(root, "WorkBuddy.app", "Contents", "Resources", "app.asar.unpacked", "cli", "bin", "codebuddy");
  await mkdir(join(root, "WorkBuddy.app", "Contents", "Resources", "app.asar.unpacked", "cli", "bin"), { recursive: true });
  await writeFile(command, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await chmod(command, 0o755);
  assert.deepEqual(resolveWorkBuddyCommand({
    env: { PATH: "" },
    homeDir: root,
    applicationRoots: [root],
    platform: "darwin",
  }), { command, source: "app-bundled" });
  assert.equal(resolveCodeBuddyCommand({ env: { PATH: "", WORKBUDDY_CODEBUDDY_PATH: command } }).source, "unavailable");
  const cliRoot = join(packageRoot, "bin");
  await mkdir(cliRoot);
  await writeFile(join(cliRoot, "codebuddy"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  assert.deepEqual(resolveCodeBuddyCommand({ env: { PATH: cliRoot }, platform: "darwin" }), {
    command: join(cliRoot, "codebuddy"), source: "path",
  });
  assert.deepEqual(resolveWorkBuddyCommand({ env: { PATH: cliRoot }, applicationRoots: [root], platform: "darwin" }), {
    command, source: "app-bundled",
  });
});

test("CodeBuddy and WorkBuddy resolvers do not fall back to each other", () => {
  assert.equal(resolveCodeBuddyCommand({
    env: { PATH: "" },
    homeDir: "/nonexistent/memorax-codebuddy-home",
    applicationRoots: ["/nonexistent/Applications"],
    platform: "darwin",
  }).source, "unavailable");
  assert.equal(resolveWorkBuddyCommand({
    env: { MEMORAX_CODE_CODEBUDDY_COMMAND: "/custom/codebuddy", PATH: "" },
    applicationRoots: [],
    windowsRoots: [],
  }).source, "unavailable");
});

test("WorkBuddy resolver finds the Windows bundled script under LocalAppData Programs", () => {
  const root = "C:\\Users\\tester\\AppData\\Local\\Programs\\WorkBuddy";
  const command = `${root}\\resources\\app.asar.unpacked\\cli\\bin\\codebuddy`;
  assert.deepEqual(resolveWorkBuddyCommand({
    env: { PATH: "" },
    platform: "win32",
    windowsRoots: [root],
    pathExists: (candidate) => candidate === command,
  }), { command, source: "app-bundled" });
  assert.equal(resolveCodeBuddyCommand({ env: { PATH: "", WORKBUDDY_CODEBUDDY_PATH: command } }).source, "unavailable");
});

test("CodeBuddy resolver shares home selection with the adapter runtime", () => {
  assert.equal(defaultCodeBuddyHome, common.defaultCodeBuddyHome);
  assert.equal(defaultWorkBuddyHome, common.defaultWorkBuddyHome);
});
