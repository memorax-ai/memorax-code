import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { test } from "node:test";
import {
  defaultTraeHome,
  traeInstallationDetected,
} from "../src/adapter-paths.mjs";
import {
  defaultWindowsPowerShellPath,
  disableTraeAdapter,
  enableTraeAdapter,
  readTraeAdapterStatus,
  removeTraeAdapterInstallation,
  traeHookCommand,
} from "../src/config.mjs";
import { writeTraeRuntimeObservation } from "../src/runtime-observation.mjs";

test("Trae home and application discovery honor explicit and platform locations", () => {
  assert.equal(defaultTraeHome({ TRAE_CN_HOME: "/custom/trae" }, "/home/user"), "/custom/trae");
  assert.equal(defaultTraeHome({}, "/home/user"), "/home/user/.trae-cn");
  assert.equal(traeInstallationDetected({
    env: {},
    home: "/home/user",
    platform: "darwin",
    pathExists: (path) => path === "/Applications/Trae CN.app",
  }), true);
  assert.equal(traeInstallationDetected({
    env: {},
    home: "/home/user",
    platform: "linux",
    pathExists: () => false,
  }), false);
});

test("Trae Hook command hides Windows paths from the sandbox command-line wrapper", () => {
  const command = traeHookCommand(
    win32.join("C:\\", "Users", "Test User", ".memorax-code", "runtime-hook.mjs"),
    "win32",
    win32.join("C:\\", "Program Files", "nodejs", "node.exe"),
    win32.join("C:\\", "Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  );
  assert.match(command, /^C:\/Windows\/System32\/WindowsPowerShell\/v1\.0\/powershell\.exe -NoLogo /);
  assert.equal(command.includes('"'), false);
  assert.equal(command.includes("Program Files"), false);
  assert.equal(command.includes("Test User"), false);
  assert.equal(command.includes("--memorax-code-trae-hook-v1"), false);
  const script = decodePowerShellCommand(command);
  assert.ok(script.includes("$start.FileName='C:\\Program Files\\nodejs\\node.exe'"));
  assert.ok(script.includes(
    "$start.Arguments='\"C:\\Users\\Test User\\.memorax-code\\runtime-hook.mjs\" \"--memorax-code-trae-hook-v1\"'",
  ));
  assert.ok(script.includes("[Console]::In.ReadToEnd()"));
  assert.ok(script.includes("$start.RedirectStandardInput=$true"));
  assert.ok(script.includes("$start.RedirectStandardOutput=$true"));
  assert.ok(script.includes("$start.RedirectStandardError=$true"));
  assert.ok(script.includes("exit $process.ExitCode"));
  assert.equal(
    defaultWindowsPowerShellPath({ SystemRoot: "D:\\Windows" }),
    "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  assert.match(
    traeHookCommand("C:\\runtime.mjs", "win32", "C:\\node.exe", "C:\\Windows Directory\\powershell.exe"),
    /^powershell\.exe /,
  );
});

test("Trae Windows Hook lifecycle recognizes and removes the encoded ownership marker", async () => {
  const fixture = await createFixture("windows-command");
  try {
    const legacy = await enableTraeAdapter({
      ...fixture.options,
      platform: "linux",
      nodePath: fixture.nodePath,
    });
    assert.equal(legacy.ok, true);
    assert.equal(legacy.changed, true);
    const options = {
      ...fixture.options,
      platform: "win32",
      nodePath: fixture.nodePath,
      powershellPath: win32.join("C:\\", "Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    };
    const installed = await enableTraeAdapter(options);
    assert.equal(installed.ok, true);
    assert.equal(installed.changed, true);
    assert.equal(installed.traeHooks.configured, true);
    const hooks = JSON.parse(await readFile(join(fixture.traeHome, "hooks.json"), "utf8"));
    for (const event of ["SessionStart", "UserPromptSubmit", "Stop"]) {
      const commands = hooks.hooks[event]
        .flatMap((group) => group.hooks ?? [])
        .map((hook) => hook.command)
        .filter((command) => command?.includes("-EncodedCommand"));
      assert.equal(commands.length, 1);
      const [command] = commands;
      assert.match(command, / -EncodedCommand [A-Za-z0-9+/=]+$/);
      assert.ok(decodePowerShellCommand(command).includes("--memorax-code-trae-hook-v1"));
    }
    assert.equal(JSON.stringify(hooks).includes("--memorax-code-trae-hook-v1"), false);

    const disabled = await disableTraeAdapter(options);
    assert.equal(disabled.ok, true);
    const disabledHooks = JSON.parse(await readFile(join(fixture.traeHome, "hooks.json"), "utf8"));
    assert.equal(JSON.stringify(disabledHooks).includes("-EncodedCommand"), false);
    assert.equal(disabledHooks.hooks.UserPromptSubmit[0].hooks[0].command, "user-command");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Trae install merges managed Hooks and Skill without changing user Hooks", async () => {
  const fixture = await createFixture("install");
  try {
    const installed = await enableTraeAdapter(fixture.options);
    assert.equal(installed.ok, true);
    assert.equal(installed.installed, true);
    assert.equal(installed.enabled, true);
    assert.equal(installed.changed, true);
    assert.equal(installed.traeHooks.configured, true);
    assert.equal(installed.traeHooks.runtimeObserved, false);
    assert.equal(installed.globalHooksActivationRequired, true);
    assert.equal(await readFile(join(installed.skillPath, "SKILL.md"), "utf8"), "# MemoraX Code\n");

    const hooks = JSON.parse(await readFile(join(fixture.traeHome, "hooks.json"), "utf8"));
    assert.deepEqual(hooks.custom, { preserved: true });
    assert.equal(hooks.hooks.UserPromptSubmit[0].hooks[0].command, "user-command");
    for (const event of ["SessionStart", "UserPromptSubmit", "Stop"]) {
      const managed = hooks.hooks[event]
        .flatMap((group) => group.hooks ?? [])
        .filter((hook) => hook.command?.includes("--memorax-code-trae-hook-v1"));
      assert.equal(managed.length, 1);
    }

    const unchanged = await enableTraeAdapter(fixture.options);
    assert.equal(unchanged.ok, true);
    assert.equal(unchanged.changed, false);

    const state = JSON.parse(await readFile(unchanged.statePath, "utf8"));
    await writeTraeRuntimeObservation({
      memoraxCodeHome: fixture.memoraxCodeHome,
      traeHome: fixture.traeHome,
      runtimeDigest: state.runtimeDigest,
    });
    const observed = await readTraeAdapterStatus(fixture.options);
    assert.equal(observed.traeHooks.runtimeObserved, true);
    assert.equal(observed.globalHooksActivationRequired, false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Trae disable and removal delete only MemoraX-managed content", async () => {
  const fixture = await createFixture("remove");
  try {
    const installed = await enableTraeAdapter(fixture.options);
    assert.equal(installed.ok, true);
    const unrelatedSkill = join(fixture.traeHome, "skills", "user-skill", "SKILL.md");
    await mkdir(join(fixture.traeHome, "skills", "user-skill"), { recursive: true });
    await writeFile(unrelatedSkill, "# User Skill\n");

    const disabled = await disableTraeAdapter(fixture.options);
    assert.equal(disabled.ok, true);
    assert.equal(disabled.enabled, false);
    const disabledHooks = JSON.parse(await readFile(join(fixture.traeHome, "hooks.json"), "utf8"));
    assert.equal(JSON.stringify(disabledHooks).includes("--memorax-code-trae-hook-v1"), false);
    assert.equal(disabledHooks.hooks.UserPromptSubmit[0].hooks[0].command, "user-command");
    assert.equal(await readFile(join(installed.skillPath, "SKILL.md"), "utf8"), "# MemoraX Code\n");

    const removed = await removeTraeAdapterInstallation(fixture.options);
    assert.equal(removed.ok, true);
    assert.equal(removed.removed, true);
    await assert.rejects(readFile(join(installed.skillPath, "SKILL.md")), /ENOENT/);
    assert.equal(await readFile(unrelatedSkill, "utf8"), "# User Skill\n");
    const finalHooks = JSON.parse(await readFile(join(fixture.traeHome, "hooks.json"), "utf8"));
    assert.equal(finalHooks.hooks.UserPromptSubmit[0].hooks[0].command, "user-command");
    assert.deepEqual(finalHooks.custom, { preserved: true });
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Trae install refuses to overwrite an unmanaged memorax-code Skill", async () => {
  const fixture = await createFixture("skill-conflict");
  try {
    const target = join(fixture.traeHome, "skills", "memorax-code");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "SKILL.md"), "# User-owned Skill\n");

    const result = await enableTraeAdapter(fixture.options);

    assert.equal(result.ok, false);
    assert.equal(result.reason, "skill_conflict");
    assert.equal(await readFile(join(target, "SKILL.md"), "utf8"), "# User-owned Skill\n");
    const hooks = JSON.parse(await readFile(join(fixture.traeHome, "hooks.json"), "utf8"));
    assert.equal(JSON.stringify(hooks).includes("--memorax-code-trae-hook-v1"), false);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("Trae install fails closed for an invalid user Hook manifest", async () => {
  const fixture = await createFixture("invalid-hooks");
  try {
    const hooksPath = join(fixture.traeHome, "hooks.json");
    await writeFile(hooksPath, "{ invalid json\n");

    const result = await enableTraeAdapter(fixture.options);

    assert.equal(result.ok, false);
    assert.equal(result.reason, "hooks_invalid");
    assert.equal(await readFile(hooksPath, "utf8"), "{ invalid json\n");
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

async function createFixture(name) {
  const root = await mkdtemp(join(tmpdir(), `memorax-code-trae-${name}-`));
  const traeHome = join(root, "Trae Home With Spaces");
  const memoraxCodeHome = join(root, "MemoraX Home");
  const sourceRoot = join(root, "sources");
  const runtimeHookSourcePath = join(sourceRoot, "runtime-hook.mjs");
  const runtimeObservationSourcePath = join(sourceRoot, "runtime-observation.mjs");
  const commonSourcePath = join(sourceRoot, "common");
  const skillSourcePath = join(sourceRoot, "skill");
  const memoraxCodeCommand = join(root, "Package With Spaces", "bin", "memorax-code.mjs");
  const nodePath = join(root, "Program Files", "nodejs", "node.exe");
  await mkdir(traeHome, { recursive: true });
  await mkdir(commonSourcePath, { recursive: true });
  await mkdir(join(skillSourcePath, "references"), { recursive: true });
  await mkdir(join(root, "Package With Spaces", "bin"), { recursive: true });
  await mkdir(join(root, "Program Files", "nodejs"), { recursive: true });
  await writeFile(runtimeHookSourcePath, "console.log('runtime');\n");
  await writeFile(runtimeObservationSourcePath, "export const observation = true;\n");
  await writeFile(join(commonSourcePath, "shared.mjs"), "export const shared = true;\n");
  await writeFile(join(skillSourcePath, "SKILL.md"), "# MemoraX Code\n");
  await writeFile(join(skillSourcePath, "references", "search.md"), "search\n");
  await writeFile(memoraxCodeCommand, "#!/usr/bin/env node\n");
  await writeFile(nodePath, "node fixture\n");
  await writeFile(join(traeHome, "hooks.json"), `${JSON.stringify({
    custom: { preserved: true },
    hooks: {
      UserPromptSubmit: [{ matcher: "user", hooks: [{ type: "command", command: "user-command", timeout: 5 }] }],
      Notification: [{ hooks: [{ type: "command", command: "notify-user", timeout: 5 }] }],
    },
  }, null, 2)}\n`);
  return {
    root,
    traeHome,
    memoraxCodeHome,
    nodePath,
    options: {
      traeHome,
      memoraxCodeHome,
      runtimeHookSourcePath,
      runtimeObservationSourcePath,
      commonSourcePath,
      skillSourcePath,
      memoraxCodeCommand,
    },
  };
}

function decodePowerShellCommand(command) {
  const encoded = / -EncodedCommand ([A-Za-z0-9+/=]+)$/.exec(command)?.[1];
  assert.ok(encoded, command);
  return Buffer.from(encoded, "base64").toString("utf16le");
}
