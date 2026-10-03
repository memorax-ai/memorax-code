import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const scripts = dirname(fileURLToPath(import.meta.url));
const entry = join(scripts, "workbuddy-e2e.mjs");
const guard = join(scripts, "workbuddy-bundled-command-check.mjs");
const wrapper = join(scripts, "codebuddy-install-check.sh");
const runtimeVersion = "2.137.1";
const posixOnly = { skip: process.platform === "win32" };

test("WorkBuddy entry help states the implemented and excluded suites", async () => {
  await fixture(async ({ run }) => {
    for (const option of ["--help", "-h"]) {
      const result = await run(process.execPath, [entry, option]);
      assert.equal(result.code, 0);
      assert.match(result.stdout, /installation lifecycle, setup interruption, native Memory\/Skill, four permission cases and Repo Memory worker checks/);
      assert.match(result.stdout, /excludes the two explicit runtime interrupt diagnostics, valid Repo Memory generation and desktop UI/);
    }
  });
});

test("WorkBuddy entry rejects missing, extra and nonexact version arguments", async () => {
  await fixture(async ({ root, run }) => {
    for (const args of [[], [root, "missing"], [root, "missing", "latest"],
      [root, "missing", runtimeVersion, "0.1.18-beta.1"], [root, "missing", runtimeVersion, "0.1.18", "extra"]]) {
      const result = await run(process.execPath, [entry, ...args]);
      assert.equal(result.code, 1);
      assert.match(result.stderr, /^Usage:/);
    }
  });
});

test("the bundle guard accepts only existing files at a canonical desktop bundle path", async () => {
  await fixture(async ({ root, run, bundle }) => {
    const command = await bundle();
    assert.equal((await run(process.execPath, [guard, command])).code, 0);
    const standalone = join(root, "codebuddy");
    await writeFile(standalone, "// Never executed.\n");
    assert.equal((await run(process.execPath, [guard, standalone])).code, 1);
    assert.equal((await run(process.execPath, [guard, command, "extra"])).code, 1);
    await rm(command);
    await mkdir(command);
    assert.equal((await run(process.execPath, [guard, command])).code, 1);
  });
});

test("the bundle guard rejects a named bundle path escaping through a symlink", async () => {
  await fixture(async ({ root, run, bundle }) => {
    const command = await bundle();
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "codebuddy"), "// Never executed.\n");
    await rm(dirname(command), { recursive: true });
    await symlink(outside, dirname(command), process.platform === "win32" ? "junction" : "dir");
    assert.equal((await run(process.execPath, [guard, command])).code, 1);
  });
});

test("WorkBuddy entry delegates resolved paths and selected client to the POSIX wrapper", posixOnly, async () => {
  await fixture(async ({ root, run, spy, calls }) => {
    await spy("bash");
    const result = await run(process.execPath, [entry, "tarballs", "bundle/codebuddy", runtimeVersion]);
    assert.equal(result.code, 0);
    assert.deepEqual(await calls(), [{ command: "bash", args: [wrapper, join(root, "tarballs"), runtimeVersion,
      "0.1.18", "workbuddy", join(root, "bundle/codebuddy")] }]);
  });
});

test("the POSIX wrapper rejects invalid client or bundle before npm mutation", posixOnly, async () => {
  await fixture(async ({ root, run, spy, calls, bundle }) => {
    await spy("npm");
    await spy("node");
    const command = await bundle();
    const standalone = join(root, "standalone-codebuddy");
    await writeFile(standalone, "// Never executed.\n");
    for (const [client, path] of [["claude", command], ["codebuddy", command], ["workbuddy", standalone]]) {
      const result = await run("/bin/bash", [wrapper, root, runtimeVersion, "0.1.18", client, path]);
      assert.equal(result.code, 1);
      assert.deepEqual(await calls(), []);
    }
  });
});

for (const client of ["codebuddy", "workbuddy"]) {
  test("the POSIX " + client + " wrapper selects its suites, package and isolated home", posixOnly, async () => {
    await fixture(async ({ root, run, spy, calls, bundle }) => {
      await spy("npm");
      await spy("node");
      const command = await bundle(true);
      const tarball = join(root, "memorax-memorax-code-0.1.19.tgz");
      await writeFile(tarball, "Synthetic artifact; never installed.\n");
      const args = [wrapper, root, runtimeVersion];
      if (client === "workbuddy") args.push("0.1.18", client, command);
      const result = await run("/bin/bash", args);
      assert.equal(result.code, 0, result.stderr);
      const observed = await calls();
      const installs = observed.filter((call) => call.command === "npm");
      assert.equal(installs.length, 2);
      assert.equal(installs[0].marker, client + "-install-check\n");
      assert.equal(installs[0].args.includes("@tencent-ai/codebuddy-code@" + runtimeVersion), client === "codebuddy");
      assert.equal(installs[0].args.at(-1), tarball);
      assert.equal(installs[1].args.at(-1), "node-pty@1.1.0");
      const suites = observed.filter((call) => call.command.endsWith("-check.mjs"));
      assert.deepEqual(suites.map((call) => call.command), ["codebuddy-lifecycle-check.mjs",
        "codebuddy-install-interruption-check.mjs", client + "-native-check.mjs",
        "codebuddy-background-check.mjs", "codebuddy-permissions-check.mjs"]);
      for (const index of [0, 1, 3, 4]) assert.equal(suites[index].args.at(-1), client);
      for (const index of [3, 4]) assert.equal(suites[index].args.length, 4);
      assert.doesNotMatch(result.stdout, /coverage (?:is|are) not implemented/);
      for (const call of suites) {
        assert.equal(call.args[1], client === "workbuddy" ? command : join(dirname(call.home), "npm", "bin", "codebuddy"));
        assert.equal(call.configDir, join(dirname(call.home), client));
        if (client === "workbuddy") {
          assert.equal(call.workbuddyHome, call.configDir);
          assert.equal(call.workbuddyConfigDir, call.configDir);
          assert.equal(call.codebuddyHome, join(call.home, ".codebuddy"));
          assert.notEqual(call.codebuddyHome, call.workbuddyHome);
        }
      }
    });
  });
}

for (const failedSuite of ["codebuddy-background-check.mjs", "codebuddy-permissions-check.mjs"]) {
  test("WorkBuddy wrapper propagates " + failedSuite + " failure and cleans up its selected client", posixOnly, async () => {
    await fixture(async ({ root, run, spy, calls, bundle }) => {
      await spy("npm");
      await spy("node");
      const command = await bundle(true);
      await writeFile(join(root, "memorax-memorax-code-0.1.19.tgz"), "Synthetic artifact; never installed.\n");
      const result = await run("/bin/bash", [wrapper, root, runtimeVersion, "0.1.18", "workbuddy", command]);
      assert.equal(result.code, 23);
      const checks = (await calls()).filter((call) => call.command.endsWith(".mjs"));
      assert.equal(checks.at(-2).command, failedSuite);
      assert.equal(checks.at(-1).command, "codebuddy-install-cleanup.mjs");
      assert.equal(checks.at(-1).args.at(-1), "workbuddy");
      if (failedSuite === "codebuddy-background-check.mjs") {
        assert.equal(checks.some((call) => call.command === "codebuddy-permissions-check.mjs"), false);
      }
    }, { failedSuite });
  });
}

async function fixture(callback, { failedSuite } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "workbuddy-install-entry-")));
  const bin = join(root, "bin"), log = join(root, "calls.jsonl");
  try {
    await Promise.all([bin, join(root, "home"), join(root, "tmp")].map((path) => mkdir(path)));
    const env = { PATH: [bin, dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
      HOME: join(root, "home"), USERPROFILE: join(root, "home"), TMPDIR: join(root, "tmp"),
      TMP: join(root, "tmp"), TEMP: join(root, "tmp"), MEMORAX_CODE_HOME: join(root, "state") };
    for (const name of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) {
      if (process.env[name]) env[name] = process.env[name];
    }
    const run = async (command, args) => {
      try { return { code: 0, ...await execute(command, args, { cwd: root, env, timeout: 20_000, maxBuffer: 256 * 1024 }) }; }
      catch (error) {
        if (typeof error.code !== "number") throw error;
        return { code: error.code, stdout: error.stdout, stderr: error.stderr };
      }
    };
    const source = `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const command = path.basename(process.argv[1]);
const args = process.argv.slice(2);
const log = ${JSON.stringify(log)};
function record(value) { fs.appendFileSync(log, JSON.stringify(value) + "\\n"); }
if (command === "node") {
  if (path.basename(args[0]) === "workbuddy-bundled-command-check.mjs") {
    const result = require("node:child_process").spawnSync(${JSON.stringify(process.execPath)}, args, { stdio: "inherit", env: process.env });
    process.exit(result.status ?? 1);
  }
  record({ command: path.basename(args[0]), args: args.slice(1), home: process.env.HOME,
    configDir: process.env.CODEBUDDY_CONFIG_DIR, codebuddyHome: process.env.CODEBUDDY_HOME,
    workbuddyHome: process.env.WORKBUDDY_HOME, workbuddyConfigDir: process.env.WORKBUDDY_CONFIG_DIR });
  if (path.basename(args[0]) === ${JSON.stringify(failedSuite)}) process.exit(23);
} else if (command === "npm") {
  const prefix = args[args.indexOf("--prefix") + 1];
  const marker = args.includes("--global") ? fs.readFileSync(path.join(prefix, ".memorax-code-ci-owned"), "utf8") : undefined;
  record({ command, args, marker });
  if (args.includes("--global")) {
    fs.mkdirSync(path.join(prefix, "bin"), { recursive: true });
    for (const name of ["memorax-code", "memorax-cli", "codebuddy"]) {
      fs.copyFileSync(process.argv[1], path.join(prefix, "bin", name));
      fs.chmodSync(path.join(prefix, "bin", name), 0o700);
    }
  }
} else if (command === "codebuddy") {
  if (args.length !== 1 || args[0] !== "--version") process.exit(1);
  console.log(${JSON.stringify(runtimeVersion)});
} else if (command === "bash") record({ command, args });
`;
    const spy = async (name) => { const path = join(bin, name); await writeFile(path, source); await chmod(path, 0o700); };
    const bundle = async (executable = false) => {
      const command = join(root, "bundle with spaces", "WorkBuddy.app", "Contents", "Resources", "app.asar.unpacked", "cli", "bin", "codebuddy");
      await mkdir(dirname(command), { recursive: true });
      await writeFile(command, executable ? source : "// Never executed.\n");
      if (executable) await chmod(command, 0o700);
      return command;
    };
    const calls = async () => {
      try { return (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
      catch (error) { if (error.code === "ENOENT") return []; throw error; }
    };
    await callback({ root, run, spy, calls, bundle });
  } finally { await rm(root, { recursive: true, force: true }); }
}
