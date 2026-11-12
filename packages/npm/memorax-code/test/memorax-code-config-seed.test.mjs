import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import * as nodeFs from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "../../../ts/memorax-code-backend/node_modules/smol-toml/dist/index.js";
import { appendMissingJevConfig } from "../../../ts/memorax-code-adapter-common/src/jev-config-defaults.mjs";
import {
  CONFIG_UPDATE_WARNING,
  updateConfigFileAtomically,
  updateConfigFileWithLock,
} from "../../../ts/memorax-code-adapter-common/src/memorax-code-config-file.mjs";

test("Jev defaults preserve existing definitions and append missing defaults without rewriting text", () => {
  for (const original of [
    '[jev]\nenabled = true\napi_key = "existing-key"\nfuture_option = "keep"\n',
    '[jev]\nenabled = false # Intentionally disabled.\n',
    '[jev]\napi_key = "existing-key"\n',
    'jev = { enabled = true, api_key = "existing-key" }\n',
    'jev.enabled = true\njev.api_key = "existing-key"\n',
    '["jev"]\nenabled = true\n',
    'jev = "invalid but user-owned"\n',
  ]) {
    assert.equal(appendMissingJevConfig(original, parse(original)), original);
  }
  for (const original of ["", '[memorax]\napi_key = "keep"', '# Keep comments.\r\n[memorax]\r\napi_key = "keep"\r\n']) {
    const updated = appendMissingJevConfig(original, parse(original));
    assert.ok(updated.startsWith(original));
    assert.deepEqual(parse(updated), { ...parse(original), jev: { enabled: false, api_key: "" } });
    assert.equal(appendMissingJevConfig(updated, parse(updated)), updated);
    if (original.includes("\r\n")) assert.doesNotMatch(updated, /(?<!\r)\n/);
  }
});

test("existing-only config migration does not create an absent home", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-config-absent-"));
  try {
    const path = join(root, "absent", "config.toml");
    assert.equal(updateConfigFileWithLock({ path, parseToml: parse, transform: (text) => text }), "unchanged");
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent config migration and preference update retain both changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-config-concurrent-"));
  const path = join(root, "config.toml");
  const releasePath = join(root, "release");
  const children = [];
  const configModule = new URL("../../../ts/memorax-code-adapter-common/src/memorax-code-config-file.mjs", import.meta.url).href;
  const defaultsModule = new URL("../../../ts/memorax-code-adapter-common/src/jev-config-defaults.mjs", import.meta.url).href;
  const tomlModule = new URL("../../../ts/memorax-code-backend/node_modules/smol-toml/dist/index.js", import.meta.url).href;
  function start(transform) {
    const child = spawn(process.execPath, ["--input-type=module", "-e", [
      'import * as fs from "node:fs";',
      `import { updateConfigFileWithLock } from ${JSON.stringify(configModule)};`,
      `import { appendMissingJevConfig } from ${JSON.stringify(defaultsModule)};`,
      `import { parse } from ${JSON.stringify(tomlModule)};`,
      'process.send("started");',
      `const result = updateConfigFileWithLock({path: ${JSON.stringify(path)}, parseToml: parse, transform: ${transform}});`,
      'process.exit(result === "updated" ? 0 : 1);',
    ].join("\n")], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
    children.push(child);
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const done = new Promise((resolve, reject) => {
      child.on("error", reject);
      child.on("exit", (code) => resolve({ code, stderr }));
    });
    const entered = new Promise((resolve) => child.on("message", (message) => {
      if (message === "entered") resolve();
    }));
    const started = new Promise((resolve) => child.once("message", resolve));
    return { done, entered, started };
  }
  try {
    await writeFile(path, '[memorax]\napi_key = "preserved-secret"\n');
    const preference = start(`(text) => {
      process.send("entered");
      const deadline = Date.now() + 3000;
      while (!fs.existsSync(${JSON.stringify(releasePath)})) {
        if (Date.now() >= deadline) throw new Error("test barrier timed out");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
      return text + '\\n[memory.add]\\noutput_language = "en"\\n';
    }`);
    await Promise.race([preference.entered, preference.done.then((result) => {
      throw new Error(`preference writer exited before reading config: ${result.stderr}`);
    })]);
    const migration = start("appendMissingJevConfig");
    await migration.started;
    await new Promise((resolve) => setTimeout(resolve, 100));
    await writeFile(releasePath, "release");
    for (const result of await Promise.all([preference.done, migration.done])) {
      assert.equal(result.code, 0, result.stderr);
    }
    assert.deepEqual(parse(await readFile(path, "utf8")), {
      memorax: { api_key: "preserved-secret" },
      memory: { add: { output_language: "en" } },
      jev: { enabled: false, api_key: "" },
    });
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill();
    await rm(root, { recursive: true, force: true });
  }
});

const configUpdateBlock = [
  "[feature.sample]",
  "enabled = true",
  'label = "sample"',
  "",
].join("\n");

function appendConfigBlock(text) {
  return `${text}${text.endsWith("\n") ? "" : "\n"}\n${configUpdateBlock}`;
}

function updateOptions(path, overrides = {}) {
  return {
    path,
    defaultText: configUpdateBlock,
    transform: appendConfigBlock,
    parseToml: parse,
    warn: () => undefined,
    ...overrides,
  };
}

test("locked config updates preserve the primary failure when lock release also fails", async (t) => {
  for (const [name, verificationFails, rollbackFails] of [
    ["verification and rollback fail", true, true],
    ["verification fails and rollback succeeds", true, false],
    ["only lock release fails after a successful update", false, false],
  ]) {
    await t.test(name, async () => {
      const root = await mkdtemp(join(tmpdir(), "memorax-code-config-unlock-failure-"));
      const path = join(root, "config.toml");
      const original = '[memorax]\nuser_id = "preserved-user"\n';
      const originalRead = fs.readFileSync;
      const failures = [];
      const warnings = [];
      let readCalls = 0;
      let renameCalls = 0;
      let releaseReadCalls = 0;
      try {
        await writeFile(path, original);
        fs.readFileSync = (target, ...args) => {
          if (target === `${path}.lock`) {
            releaseReadCalls += 1;
            throw Object.assign(new Error("private lock failure"), { code: "EACCES" });
          }
          return originalRead(target, ...args);
        };
        syncBuiltinESMExports();
        const result = updateConfigFileWithLock(updateOptions(path, {
          operations: {
            readFileSync: (...args) => {
              readCalls += 1;
              if (readCalls === 2 && verificationFails) {
                throw Object.assign(new Error("private verification failure"), { code: "EIO" });
              }
              return originalRead(...args);
            },
            renameSync: (...args) => {
              renameCalls += 1;
              if (renameCalls === 2 && rollbackFails) {
                throw Object.assign(new Error("private rollback failure"), { code: "EPERM" });
              }
              return nodeFs.renameSync(...args);
            },
          },
          warn: (message) => warnings.push(message),
          onFailure: (failure) => failures.push(failure),
        }));
        assert.equal(result, "failed");
        assert.equal(releaseReadCalls, 1);
        assert.equal(await readFile(path, "utf8"), verificationFails && !rollbackFails ? original : appendConfigBlock(original));
        const backups = (await readdir(root)).filter((entry) => entry.endsWith(".bak"));
        assert.equal(backups.length, rollbackFails ? 1 : 0);
        if (rollbackFails) assert.equal(await readFile(join(root, backups[0]), "utf8"), original);
        assert.deepEqual(failures, [verificationFails ? {
          stage: "verify", errorCode: "CONFIG_VERIFY_FAILED", systemCode: "EIO",
          configState: rollbackFails ? "unknown" : "restored",
          cleanupErrorCode: rollbackFails ? "CONFIG_ROLLBACK_FAILED" : "CONFIG_LOCK_RELEASE_FAILED",
          cleanupSystemCode: rollbackFails ? "EPERM" : "EACCES",
        } : {
          stage: "unlock", errorCode: "CONFIG_UNLOCK_FAILED", configState: "unknown", systemCode: "EACCES",
        }]);
        assert.deepEqual(warnings, [CONFIG_UPDATE_WARNING]);
        assert.doesNotMatch(JSON.stringify(failures), /private|preserved-user|config\.toml/);
      } finally {
        fs.readFileSync = originalRead;
        syncBuiltinESMExports();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("atomic config seeding creates mode 0600 and preserves existing bytes, mode, and owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-config-seed-success-"));
  try {
    const newPath = join(root, "new", "config.toml");
    assert.equal(updateConfigFileAtomically(updateOptions(newPath)), "created");
    assert.equal(await readFile(newPath, "utf8"), configUpdateBlock);
    if (process.platform !== "win32") {
      assert.equal((await stat(newPath)).mode & 0o777, 0o600);
      assert.equal((await stat(join(root, "new"))).mode & 0o777, 0o700);
    }

    const existingPath = join(root, "existing.toml");
    const existing = '[memorax]\napi_key = "preserved-secret"\nuser_id = "user-one"\n';
    await writeFile(existingPath, existing, "utf8");
    await chmod(existingPath, 0o640);
    const before = await stat(existingPath);
    assert.equal(updateConfigFileAtomically(updateOptions(existingPath)), "updated");
    const after = await stat(existingPath);
    assert.equal((await readFile(existingPath, "utf8")).startsWith(existing), true);
    assert.equal(after.mode & 0o7777, before.mode & 0o7777);
    assert.equal(after.uid, before.uid);
    assert.equal(after.gid, before.gid);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("atomic config seeding tightens an existing config directory even when content is unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-config-seed-private-home-"));
  const home = join(root, "home");
  const path = join(home, "config.toml");
  try {
    await mkdir(home, { mode: 0o755 });
    await writeFile(path, configUpdateBlock, "utf8");
    if (process.platform !== "win32") await chmod(home, 0o755);

    assert.equal(updateConfigFileAtomically(updateOptions(path, {
      transform: (text) => text,
    })), "unchanged");
    if (process.platform !== "win32") {
      assert.equal((await stat(home)).mode & 0o777, 0o700);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("atomic config seeding leaves existing bytes unchanged for parse and filesystem failures", async (t) => {
  const cases = [
    ["lstat", "read", () => ({ lstatSync: () => { throw Object.assign(new Error("secret lstat failure"), { code: "secret-code" }); } })],
    ["initial read", "read", () => ({ readFileSync: () => { throw Object.assign(new Error("secret read failure"), { code: "EACCES" }); } })],
    ["directory chmod", "prepare_directory", () => ({ chmodSync: () => { throw new Error("secret chmod directory failure"); } })],
    ["writability check", "check_permissions", () => ({ accessSync: () => { throw new Error("secret access failure"); } })],
    ["open", "write_temp", () => ({ openSync: () => { throw new Error("secret open failure"); } })],
    ["write", "write_temp", () => ({ writeFileSync: () => { throw new Error("secret write failure"); } })],
    ["chown", "write_temp", () => ({ fchownSync: () => { throw new Error("secret chown failure"); } })],
    ["chmod", "write_temp", () => ({ fchmodSync: () => { throw new Error("secret chmod failure"); } })],
    ["close", "write_temp", () => {
      let failed = false;
      return {
        closeSync: (fd) => {
          if (!failed) {
            failed = true;
            throw new Error("secret close failure");
          }
          nodeFs.closeSync(fd);
        },
      };
    }],
    ["backup creation", "backup", () => ({ [process.platform === "win32" ? "copyFileSync" : "linkSync"]: () => { throw new Error("secret link failure"); } })],
    ["rename", "publish", () => ({ renameSync: () => { throw new Error("secret rename failure"); } })],
  ];

  for (const [name, stage, operationsFactory] of cases) {
    await t.test(name, { skip: process.platform === "win32" && ["directory chmod", "chown", "chmod"].includes(name) ? "POSIX metadata operation" : false }, async () => {
      const root = await mkdtemp(join(tmpdir(), "memorax-code-config-seed-failure-"));
      const path = join(root, "config.toml");
      const original = '[memorax]\napi_key = "preserved-secret"\n';
      const warnings = [];
      const failures = [];
      try {
        await writeFile(path, original, "utf8");
        const result = updateConfigFileAtomically(updateOptions(path, {
          operations: operationsFactory(),
          warn: (message) => warnings.push(message),
          onFailure: (failure) => failures.push(failure),
        }));
        assert.equal(result, "failed");
        assert.equal(await readFile(path, "utf8"), original);
        assert.deepEqual(await readdir(root), ["config.toml"]);
        assert.deepEqual(warnings, [CONFIG_UPDATE_WARNING]);
        assert.doesNotMatch(warnings[0], /preserved-secret|secret .* failure|config\.toml/);
        assert.deepEqual(failures, [{
          stage,
          errorCode: `CONFIG_${stage.toUpperCase()}_FAILED`,
          configState: "preserved",
          ...(name === "initial read" ? { systemCode: "EACCES" } : {}),
        }]);
        assert.doesNotMatch(JSON.stringify(failures), /secret|config\.toml/);
        assert.equal(JSON.stringify(failures).includes(root), false);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("atomic config seeding rejects malformed input and a candidate that cannot be parsed", async (t) => {
  await t.test("malformed existing TOML", async () => {
    const root = await mkdtemp(join(tmpdir(), "memorax-code-config-seed-malformed-"));
    const path = join(root, "config.toml");
    const original = '[memorax]\napi_key = "secret"\nbroken = [\n';
    const warnings = [];
    const failures = [];
    try {
      await writeFile(path, original, "utf8");
      assert.equal(updateConfigFileAtomically(updateOptions(path, {
        warn: (message) => warnings.push(message),
        onFailure: (failure) => failures.push(failure),
      })), "failed");
      assert.equal(await readFile(path, "utf8"), original);
      assert.deepEqual(await readdir(root), ["config.toml"]);
      assert.deepEqual(warnings, [CONFIG_UPDATE_WARNING]);
      assert.deepEqual(failures, [{ stage: "parse_existing", errorCode: "CONFIG_PARSE_EXISTING_FAILED", configState: "preserved", recordReason: "invalid_toml" }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  await t.test("candidate parse failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "memorax-code-config-seed-candidate-"));
    const path = join(root, "config.toml");
    const original = '[memorax]\napi_key = "secret"\n';
    let parseCalls = 0;
    const failures = [];
    try {
      await writeFile(path, original, "utf8");
      assert.equal(updateConfigFileAtomically(updateOptions(path, {
        parseToml: (text) => {
          parseCalls += 1;
          if (parseCalls === 2) throw new Error("candidate rejected");
          return parse(text);
        },
        onFailure: (failure) => failures.push(failure),
      })), "failed");
      assert.equal(await readFile(path, "utf8"), original);
      assert.deepEqual(await readdir(root), ["config.toml"]);
      assert.deepEqual(failures, [{ stage: "parse_candidate", errorCode: "CONFIG_PARSE_CANDIDATE_FAILED", configState: "preserved", recordReason: "invalid_toml" }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

test("atomic config seeding reports failed when post-rename verification fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-config-seed-post-rename-"));
  const path = join(root, "config.toml");
  const original = '[memorax]\nuser_id = "user-one"\n';
  let readCalls = 0;
  const warnings = [];
  const failures = [];
  try {
    await writeFile(path, original, "utf8");
    const result = updateConfigFileAtomically(updateOptions(path, {
      operations: {
        readFileSync: (...args) => {
          readCalls += 1;
          if (readCalls === 2) return 'api_key = "unexpected-private-content"';
          return nodeFs.readFileSync(...args);
        },
      },
      warn: (message) => warnings.push(message),
      onFailure: (failure) => failures.push(failure),
    }));
    assert.equal(result, "failed");
    assert.equal(await readFile(path, "utf8"), original);
    assert.deepEqual(await readdir(root), ["config.toml"]);
    assert.deepEqual(warnings, [CONFIG_UPDATE_WARNING]);
    assert.deepEqual(failures, [{ stage: "verify", errorCode: "CONFIG_VERIFY_FAILED", configState: "restored", recordReason: "content_mismatch" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows config replacement preserves the original when the destination is locked", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-config-seed-windows-lock-"));
  const path = join(root, "config.toml");
  const original = '[memorax]\nuser_id = "windows-user"\n';
  let renameCalls = 0;
  const failures = [];
  try {
    await writeFile(path, original, "utf8");
    const result = updateConfigFileAtomically(updateOptions(path, {
      platform: "win32",
      onFailure: (failure) => failures.push(failure),
      operations: {
        renameSync: (...args) => {
          renameCalls += 1;
          if (renameCalls === 1) throw Object.assign(new Error("locked"), { code: "EPERM" });
          return nodeFs.renameSync(...args);
        },
      },
    }));
    assert.equal(result, "failed");
    assert.equal(await readFile(path, "utf8"), original);
    assert.deepEqual(await readdir(root), ["config.toml"]);
    assert.deepEqual(failures, [{ stage: "publish", errorCode: "CONFIG_PUBLISH_FAILED", configState: "preserved", systemCode: "EPERM" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows config replacement copies a backup and skips POSIX metadata calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-config-seed-windows-success-"));
  const path = join(root, "config.toml");
  const original = '[memorax]\nuser_id = "windows-user"\n';
  try {
    await writeFile(path, original, "utf8");
    assert.equal(updateConfigFileAtomically(updateOptions(path, {
      platform: "win32",
      operations: {
        chmodSync: () => { throw new Error("must not run"); },
        fchmodSync: () => { throw new Error("must not run"); },
        fchownSync: () => { throw new Error("must not run"); },
        linkSync: () => { throw new Error("must not run"); },
        copyFileSync: (...args) => {
          assert.equal(nodeFs.existsSync(path), true);
          return nodeFs.copyFileSync(...args);
        },
      },
    })), "updated");
    assert.equal((await readFile(path, "utf8")).startsWith(original), true);
    assert.deepEqual(await readdir(root), ["config.toml"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows config verification failure restores through a temporary replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-config-seed-windows-verify-"));
  const path = join(root, "config.toml");
  const original = '[memorax]\nuser_id = "windows-user"\n';
  let readCalls = 0;
  let renameCalls = 0;
  const failures = [];
  try {
    await writeFile(path, original, "utf8");
    const result = updateConfigFileAtomically(updateOptions(path, {
      platform: "win32",
      onFailure: (failure) => failures.push(failure),
      operations: {
        readFileSync: (...args) => {
          readCalls += 1;
          if (readCalls === 2) throw new Error("verification failed");
          return nodeFs.readFileSync(...args);
        },
        renameSync: (...args) => {
          renameCalls += 1;
          assert.equal(nodeFs.existsSync(path), true);
          return nodeFs.renameSync(...args);
        },
      },
    }));
    assert.equal(result, "failed");
    assert.equal(renameCalls, 2);
    assert.equal(await readFile(path, "utf8"), original);
    assert.deepEqual(await readdir(root), ["config.toml"]);
    assert.deepEqual(failures, [{ stage: "verify", errorCode: "CONFIG_VERIFY_FAILED", configState: "restored" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows config restore failure preserves the candidate and recovery backup", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-config-seed-windows-restore-"));
  const path = join(root, "config.toml");
  const original = '[memorax]\nuser_id = "windows-user"\n';
  let readCalls = 0;
  let renameCalls = 0;
  const failures = [];
  try {
    await writeFile(path, original, "utf8");
    const result = updateConfigFileAtomically(updateOptions(path, {
      platform: "win32",
      onFailure: (failure) => failures.push(failure),
      operations: {
        readFileSync: (...args) => {
          readCalls += 1;
          if (readCalls === 2) throw new Error("verification failed");
          return nodeFs.readFileSync(...args);
        },
        renameSync: (...args) => {
          renameCalls += 1;
          if (renameCalls === 2) throw Object.assign(new Error("secret restore replacement failed"), { code: "EPERM" });
          return nodeFs.renameSync(...args);
        },
      },
    }));
    assert.equal(result, "failed");
    assert.equal(renameCalls, 2);
    assert.equal((await readFile(path, "utf8")).startsWith(original), true);
    const recovery = (await readdir(root)).filter((name) => name.endsWith(".bak"));
    assert.equal(recovery.length, 1);
    assert.equal(await readFile(join(root, recovery[0]), "utf8"), original);
    assert.equal((await readdir(root)).some((name) => name.endsWith(".restore.tmp")), false);
    assert.deepEqual(failures, [{ stage: "verify", errorCode: "CONFIG_VERIFY_FAILED", configState: "unknown", cleanupErrorCode: "CONFIG_ROLLBACK_FAILED", cleanupSystemCode: "EPERM" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("atomic config seeding removes a newly created config when post-rename verification fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-config-seed-new-post-rename-"));
  const path = join(root, "home", "config.toml");
  let readCalls = 0;
  const failures = [];
  try {
    const result = updateConfigFileAtomically(updateOptions(path, {
      onFailure: (failure) => failures.push(failure),
      operations: {
        readFileSync: (...args) => {
          readCalls += 1;
          if (readCalls === 1) throw new Error("post-rename verification failed");
          return nodeFs.readFileSync(...args);
        },
      },
    }));
    assert.equal(result, "failed");
    await assert.rejects(readFile(path), { code: "ENOENT" });
    assert.deepEqual(await readdir(join(root, "home")), []);
    assert.deepEqual(failures, [{ stage: "verify", errorCode: "CONFIG_VERIFY_FAILED", configState: "removed" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("atomic config seeding refuses to replace a config symlink", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-config-seed-symlink-"));
  const target = join(root, "managed.toml");
  const path = join(root, "config.toml");
  const original = '[memorax]\nuser_id = "managed-user"\n';
  const warnings = [];
  try {
    await writeFile(target, original, "utf8");
    await symlink(target, path);
    assert.equal(updateConfigFileAtomically(updateOptions(path, {
      warn: (message) => warnings.push(message),
    })), "failed");
    assert.equal((await lstat(path)).isSymbolicLink(), true);
    assert.equal(await readlink(path), target);
    assert.equal(await readFile(target, "utf8"), original);
    assert.deepEqual((await readdir(root)).sort(), ["config.toml", "managed.toml"]);
    assert.deepEqual(warnings, [CONFIG_UPDATE_WARNING]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("atomic config seeding rejects an unchanged config symlink before returning", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-config-seed-unchanged-symlink-"));
  const target = join(root, "managed.toml");
  const path = join(root, "config.toml");
  const original = '[feature.sample]\nenabled = true\n';
  const warnings = [];
  try {
    await writeFile(target, original, "utf8");
    await symlink(target, path);
    assert.equal(updateConfigFileAtomically(updateOptions(path, {
      transform: (text) => text,
      warn: (message) => warnings.push(message),
    })), "failed");
    assert.equal((await lstat(path)).isSymbolicLink(), true);
    assert.equal(await readlink(path), target);
    assert.equal(await readFile(target, "utf8"), original);
    assert.deepEqual(warnings, [CONFIG_UPDATE_WARNING]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("atomic config seeding refuses a non-regular config path before reading it", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-config-seed-directory-"));
  const path = join(root, "config.toml");
  const warnings = [];
  const failures = [];
  let readCalls = 0;
  try {
    await mkdir(path);
    assert.equal(updateConfigFileAtomically(updateOptions(path, {
      operations: {
        readFileSync: () => {
          readCalls += 1;
          return configUpdateBlock;
        },
      },
      warn: (message) => warnings.push(message),
      onFailure: (failure) => failures.push(failure),
    })), "failed");
    assert.equal(readCalls, 0);
    assert.equal((await lstat(path)).isDirectory(), true);
    assert.deepEqual(await readdir(root), ["config.toml"]);
    assert.deepEqual(warnings, [CONFIG_UPDATE_WARNING]);
    assert.deepEqual(failures, [{ stage: "read", errorCode: "CONFIG_READ_FAILED", configState: "preserved", recordReason: "not_regular_file" }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
