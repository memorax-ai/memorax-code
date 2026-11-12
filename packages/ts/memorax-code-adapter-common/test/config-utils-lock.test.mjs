import assert from "node:assert/strict";
import childProcess, { spawn } from "node:child_process";
import fs from "node:fs";
import {
  access,
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  atomicWriteJson,
  withJsonFileLock,
  withJsonFileLockAsync,
} from "../src/config-utils.mjs";

const configUtilsSourceUrl = new URL(
  "../src/config-utils.mjs",
  import.meta.url,
);
const configUtilsUrl = configUtilsSourceUrl.href;
const configUtilsDeclarationUrl = new URL(
  "../src/config-utils.d.mts",
  import.meta.url,
);

test("config-utils declaration covers every JavaScript function export", async () => {
  const [source, declaration] = await Promise.all([
    readFile(configUtilsSourceUrl, "utf8"),
    readFile(configUtilsDeclarationUrl, "utf8"),
  ]);
  const exportedFunctions = [...source.matchAll(
    /^export (?:async )?function ([A-Za-z0-9_]+)/gm,
  )].map((match) => match[1]);

  for (const name of exportedFunctions) {
    assert.match(declaration, new RegExp(`export function ${name}\\b`));
  }
});

test("JSON state lock wait is bounded and releases the owning lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-json-lock-bounded-"));
  const path = join(root, "state.json");
  try {
    withJsonFileLock(path, () => {
      assert.throws(
        () => withJsonFileLock(path, () => undefined, {
          timeoutMs: 40,
          retryMs: 5,
          staleMs: 1,
        }),
        (error) => error?.code === "JSON_FILE_LOCK_TIMEOUT"
          && error.path === path
          && error.lockPath === `${path}.lock`,
      );
    });
    await assert.rejects(access(`${path}.lock`), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("JSON state lock bounds Windows exclusive-create retries without reaping denied locks", async (t) => {
  for (const acquire of [withJsonFileLock, withJsonFileLockAsync]) {
    for (const [platform, code, failures, held = false] of [
      ["win32", "EPERM", 2],
      ["win32", "EPERM", Infinity],
      ["win32", "EPERM", 1, true],
      ["win32", "EACCES", 2],
      ["win32", "EIO", 2],
      ["linux", "EPERM", 2],
    ]) {
      await t.test([acquire.name, platform, code, failures, held].join(":"), async (t) => {
        const root = await mkdtemp(join(tmpdir(), "memorax-code-json-lock-open-"));
        const path = join(root, "state.json");
        const lockPath = `${path}.lock`;
        const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
        const open = fs.openSync;
        const blocked = Object.assign(new Error("exclusive create denied"), { code });
        const recover = platform === "win32" && code === "EPERM" && Number.isFinite(failures) && !held;
        const retry = platform === "win32" && code === "EPERM";
        const original = JSON.stringify({ version: 1, ownerId: "existing", ...(held ? { pid: process.pid } : {}) });
        if (!recover) {
          await writeFile(lockPath, original);
          const staleTime = new Date(Date.now() - 1000);
          await utimes(lockPath, staleTime, staleTime);
        }
        let attempts = 0;
        let calls = 0;
        const operation = () => {
          calls += 1;
          const owner = JSON.parse(fs.readFileSync(lockPath, "utf8"));
          assert.equal(owner.pid, process.pid);
          assert.equal(owner.version, 1);
          assert.equal(fs.statSync(lockPath).nlink, 1);
          return "entered";
        };
        Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
        t.mock.method(fs, "openSync", (target, flags, ...options) => {
          if (target === lockPath && flags === "wx" && ++attempts <= failures) throw blocked;
          return open(target, flags, ...options);
        });
        const claims = t.mock.method(fs, "linkSync");
        syncBuiltinESMExports();
        try {
          const options = { timeoutMs: 40, retryMs: 4, staleMs: 20, ensurePrivateDirectory: false };
          if (recover) {
            assert.equal(await acquire(path, operation, options), "entered");
            assert.equal(calls, 1);
            assert.equal(attempts, failures + 1);
            assert.deepEqual(fs.readdirSync(root), []);
          } else {
            await assert.rejects(async () => acquire(path, operation, options), (error) => held
              ? error?.code === "JSON_FILE_LOCK_TIMEOUT" && error.path === path && error.lockPath === lockPath
              : error === blocked);
            assert.equal(calls, 0);
            assert.ok(retry ? attempts > 1 && attempts <= 12 : attempts === 1);
            assert.equal(fs.readFileSync(lockPath, "utf8"), original);
            assert.deepEqual(fs.readdirSync(root), ["state.json.lock"]);
          }
          assert.equal(claims.mock.callCount(), 0);
        } finally {
          Object.defineProperty(process, "platform", platformDescriptor);
          t.mock.restoreAll();
          syncBuiltinESMExports();
          await rm(root, { recursive: true, force: true });
        }
      });
    }
  }
});

test("JSON state lock does not retry Windows owner-record write denial", async (t) => {
  for (const acquire of [withJsonFileLock, withJsonFileLockAsync]) {
    await t.test(acquire.name, async (t) => {
      const root = await mkdtemp(join(tmpdir(), "memorax-code-json-lock-write-denied-"));
      const path = join(root, "state.json");
      const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
      const write = fs.writeFileSync;
      const blocked = Object.assign(new Error("owner write denied"), { code: "EPERM" });
      Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
      const writes = t.mock.method(fs, "writeFileSync", (target) => {
        write(target, '{"version":');
        throw blocked;
      });
      syncBuiltinESMExports();
      try {
        await assert.rejects(async () => acquire(path, () => assert.fail("must not enter")), (error) => error === blocked);
        assert.equal(writes.mock.callCount(), 1);
        assert.equal(fs.readFileSync(`${path}.lock`, "utf8"), '{"version":');
        assert.deepEqual(fs.readdirSync(root), ["state.json.lock"]);
      } finally {
        Object.defineProperty(process, "platform", platformDescriptor);
        t.mock.restoreAll();
        syncBuiltinESMExports();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("async JSON state lock yields and aborts during Windows exclusive-create retry", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-json-lock-open-abort-"));
  const path = join(root, "state.json");
  const lockPath = `${path}.lock`;
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const open = fs.openSync;
  const controller = new AbortController();
  let attempts = 0;
  let eventLoopRan = false;
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
  t.mock.method(fs, "openSync", (target, flags, ...options) => {
    if (target === lockPath && flags === "wx") {
      attempts += 1;
      throw Object.assign(new Error("exclusive create denied"), { code: "EPERM" });
    }
    return open(target, flags, ...options);
  });
  syncBuiltinESMExports();
  const timer = setTimeout(() => { eventLoopRan = true; controller.abort(); }, 0);
  try {
    await assert.rejects(withJsonFileLockAsync(path, () => assert.fail("must not enter"), {
      timeoutMs: 1000, retryMs: 500, signal: controller.signal,
    }), (error) => lockAbortError(error, path));
    assert.equal(eventLoopRan, true);
    assert.equal(attempts, 1);
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    clearTimeout(timer);
    Object.defineProperty(process, "platform", platformDescriptor);
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

test("JSON state locks acquire repeatedly without creating recycled reap claims", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-json-lock-acquisition-"));
  const path = join(root, "state.json");
  const lockPath = `${path}.lock`;
  const recycledPath = join(root, "recycled");
  await mkdir(recycledPath);
  const originalRemove = fs.rmSync;
  let recycledClaims = 0;
  fs.rmSync = (target, ...options) => {
    if (typeof target === "string" && target.startsWith(`${lockPath}.reap-`)) {
      // Recycling preserves the inode's link count even after the claim leaves this directory.
      fs.renameSync(target, join(recycledPath, String(recycledClaims++)));
      return;
    }
    return originalRemove(target, ...options);
  };
  syncBuiltinESMExports();
  try {
    for (const acquire of [withJsonFileLock, withJsonFileLockAsync, withJsonFileLock, withJsonFileLockAsync]) {
      await acquire(path, () => {
        // The callback requires complete owner data, not atomic visibility during the preceding write.
        const owner = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        assert.equal(owner.pid, process.pid);
        assert.equal(owner.version, 1);
        assert.match(owner.ownerId, new RegExp(`^${process.pid}:`));
        assert.equal(fs.statSync(lockPath).nlink, 1, "normal acquisition must not leave a recycled hard-link alias");
      });
      await assert.rejects(access(lockPath), /ENOENT/);
      assert.deepEqual(fs.readdirSync(root), ["recycled"]);
      assert.deepEqual(fs.readdirSync(recycledPath), []);
    }
    assert.equal(recycledClaims, 0);
  } finally {
    fs.rmSync = originalRemove;
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

test("JSON state lock owner-write failure preserves a replacement owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-json-lock-write-failure-"));
  const path = join(root, "state.json");
  const lockPath = `${path}.lock`;
  const originalWrite = fs.writeFileSync;
  const writeFailure = Object.assign(new Error("owner record write failed"), { code: "EIO" });
  const concurrentOwner = JSON.stringify({ version: 1, ownerId: "concurrent-owner", pid: process.pid });
  let operationCalled = false;
  fs.writeFileSync = () => {
    originalWrite(lockPath, concurrentOwner, { mode: 0o600 });
    throw writeFailure;
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => withJsonFileLock(path, () => { operationCalled = true; }), error => error === writeFailure);
    assert.equal(operationCalled, false);
    assert.equal(fs.readFileSync(lockPath, "utf8"), concurrentOwner);
    assert.deepEqual(fs.readdirSync(root), ["state.json.lock"]);
  } finally {
    fs.writeFileSync = originalWrite;
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

test("JSON state lock owner-write failure retains an incomplete record for stale recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-json-lock-incomplete-"));
  const path = join(root, "state.json");
  const lockPath = `${path}.lock`;
  const originalWrite = fs.writeFileSync;
  const writeFailure = Object.assign(new Error("owner record write failed"), { code: "EIO" });
  let operationCalled = false;
  fs.writeFileSync = (target) => {
    originalWrite(target, '{"version":');
    throw writeFailure;
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => withJsonFileLock(path, () => { operationCalled = true; }), error => error === writeFailure);
    assert.equal(operationCalled, false);
    assert.equal(fs.readFileSync(lockPath, "utf8"), '{"version":');
    assert.deepEqual(fs.readdirSync(root), ["state.json.lock"]);

    fs.writeFileSync = originalWrite;
    syncBuiltinESMExports();
    const staleTime = new Date(Date.now() - 1000);
    await utimes(lockPath, staleTime, staleTime);
    assert.equal(withJsonFileLock(path, () => "recovered", {
      timeoutMs: 100,
      retryMs: 5,
      staleMs: 20,
    }), "recovered");
    await assert.rejects(access(lockPath), /ENOENT/);
  } finally {
    fs.writeFileSync = originalWrite;
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

test("JSON state lock release reports blocked cleanup and preserves the operation error", async (t) => {
  for (const acquire of [withJsonFileLock, withJsonFileLockAsync]) {
    for (const failedOperation of [false, true]) {
      await t.test(`${acquire.name}: operation ${failedOperation ? "failed" : "succeeded"}`, async () => {
        const root = await mkdtemp(join(tmpdir(), "memorax-code-json-lock-release-"));
        const path = join(root, "state.json");
        const lockPath = `${path}.lock`;
        const originalUnlink = fs.unlinkSync;
        const deleteFailure = new Error("[safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] confirmation required");
        const operationFailure = Object.assign(new Error("client setup failed"), { code: "CLIENT_SETUP_FAILED" });
        let operationCalled = false;
        let deleteAttempts = 0;
        fs.unlinkSync = (target) => {
          if (target !== lockPath) return originalUnlink(target);
          deleteAttempts += 1;
          throw deleteFailure;
        };
        syncBuiltinESMExports();
        try {
          await assert.rejects(async () => acquire(path, () => {
            operationCalled = true;
            if (failedOperation) throw operationFailure;
            return "complete";
          }), (error) => {
            assert.equal(error.code, "JSON_FILE_LOCK_RELEASE_FAILED");
            assert.equal(error.lockPath, lockPath);
            assert.ok(error.message.includes(lockPath));
            assert.match(error.message, /SAFE_DELETE_BULK_CONFIRM_REQUIRED/);
            if (failedOperation) {
              assert.ok(error instanceof AggregateError);
              assert.equal(error.cause, operationFailure);
              assert.equal(error.errors[0], operationFailure);
              assert.equal(error.errors[1].cause, deleteFailure);
              assert.match(error.message, /client setup failed/);
            } else {
              assert.equal(error.cause, deleteFailure);
            }
            return true;
          });
          assert.equal(operationCalled, true);
          assert.equal(deleteAttempts, 1);
          await access(lockPath);
        } finally {
          fs.unlinkSync = originalUnlink;
          syncBuiltinESMExports();
          await rm(root, { recursive: true, force: true });
        }
      });
    }
  }
});

test("JSON state lock release preserves unknown ownership but reports unreadable locks", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-json-lock-release-owner-"));
  const path = join(root, "state.json");
  const lockPath = `${path}.lock`;
  const originalRead = fs.readFileSync;
  const readFailure = Object.assign(new Error("lock read denied"), { code: "EACCES" });
  try {
    for (const acquire of [withJsonFileLock, withJsonFileLockAsync]) {
      assert.equal(await acquire(path, () => {
        fs.unlinkSync(lockPath);
        return "missing";
      }), "missing");
      await assert.rejects(access(lockPath), /ENOENT/);

      const replacement = JSON.stringify({ ownerId: "replacement-owner" });
      assert.equal(await acquire(path, () => {
        fs.writeFileSync(lockPath, replacement);
        return "replaced";
      }), "replaced");
      assert.equal(await readFile(lockPath, "utf8"), replacement);
      await rm(lockPath);

      await assert.rejects(async () => acquire(path, () => {
        fs.readFileSync = (target, ...options) => {
          if (target === lockPath) throw readFailure;
          return originalRead(target, ...options);
        };
        syncBuiltinESMExports();
      }), (error) => error.code === "JSON_FILE_LOCK_RELEASE_FAILED" && error.cause === readFailure);
      fs.readFileSync = originalRead;
      syncBuiltinESMExports();
      await access(lockPath);
      await rm(lockPath);
    }
  } finally {
    fs.readFileSync = originalRead;
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

test("JSON state lock owner-write failure also reports blocked release", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-json-lock-write-release-"));
  const path = join(root, "state.json");
  const lockPath = `${path}.lock`;
  const originalWrite = fs.writeFileSync;
  const originalUnlink = fs.unlinkSync;
  const writeFailure = Object.assign(new Error("owner record write failed"), { code: "EIO" });
  const deleteFailure = Object.assign(new Error("lock delete denied"), { code: "EPERM" });
  fs.writeFileSync = (...args) => {
    originalWrite(...args);
    throw writeFailure;
  };
  fs.unlinkSync = (target) => {
    if (target === lockPath) throw deleteFailure;
    return originalUnlink(target);
  };
  syncBuiltinESMExports();
  try {
    assert.throws(() => withJsonFileLock(path, () => assert.fail("must not enter the critical section")), (error) => {
      assert.equal(error.code, "JSON_FILE_LOCK_RELEASE_FAILED");
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, writeFailure);
      assert.equal(error.errors[0], writeFailure);
      assert.equal(error.errors[1].cause, deleteFailure);
      assert.match(error.message, /owner record write failed/);
      assert.match(error.message, /lock delete denied/);
      return true;
    });
    await access(lockPath);
  } finally {
    fs.writeFileSync = originalWrite;
    fs.unlinkSync = originalUnlink;
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

test("JSON state lock tightens an existing private state directory", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-json-lock-mode-"));
  const directory = join(root, "runtime", "backend");
  const path = join(directory, "state.json");
  try {
    await mkdir(directory, { recursive: true });
    await chmod(directory, 0o777);

    withJsonFileLock(path, () => undefined);

    assert.equal((await stat(directory)).mode & 0o777, 0o700);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("JSON state lock can preserve an externally owned directory mode", {
  skip: process.platform === "win32",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-json-lock-external-mode-"));
  const directory = join(root, "external-state");
  const path = join(directory, "state.json");
  try {
    await mkdir(directory, { recursive: true });
    await chmod(directory, 0o755);

    await withJsonFileLockAsync(path, async () => undefined, {
      ensurePrivateDirectory: false,
    });

    assert.equal((await stat(directory)).mode & 0o777, 0o755);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("async JSON state lock serializes the complete awaited operation", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-json-lock-async-"));
  const path = join(root, "state.json");
  const order = [];
  let releaseFirst;
  try {
    const first = withJsonFileLockAsync(path, async () => {
      order.push("first:start");
      await new Promise((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first:end");
    }, { timeoutMs: 500, retryMs: 5 });
    while (!releaseFirst) await new Promise((resolve) => setTimeout(resolve, 1));
    const second = withJsonFileLockAsync(path, async () => {
      order.push("second");
    }, { timeoutMs: 500, retryMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(order, ["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(order, ["first:start", "first:end", "second"]);
    await assert.rejects(access(`${path}.lock`), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("async JSON state lock aborts a waiter without running it or removing the owner lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-json-lock-wait-abort-"));
  const path = join(root, "state.json");
  const lockPath = `${path}.lock`;
  const ownerEntered = deferred();
  const releaseOwner = deferred();
  let owner;
  try {
    owner = withJsonFileLockAsync(path, async () => {
      ownerEntered.resolve();
      await releaseOwner.promise;
    }, { timeoutMs: 500, retryMs: 5 });
    await ownerEntered.promise;
    const ownerLock = await readFile(lockPath, "utf8");

    const controller = new AbortController();
    let waiterCalled = false;
    const waiter = withJsonFileLockAsync(path, async () => {
      waiterCalled = true;
    }, {
      signal: controller.signal,
      timeoutMs: 500,
      retryMs: 50,
    });
    controller.abort();

    await assert.rejects(waiter, (error) => lockAbortError(error, path));
    assert.equal(waiterCalled, false);
    assert.equal(await readFile(lockPath, "utf8"), ownerLock);

    releaseOwner.resolve();
    await owner;
    await assert.rejects(access(lockPath), /ENOENT/);
  } finally {
    releaseOwner.resolve();
    await owner?.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("JSON state lock recovers an abandoned stale lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-json-lock-stale-"));
  const path = join(root, "nested", "state.json");
  const lockPath = `${path}.lock`;
  try {
    await mkdir(join(root, "nested"), { recursive: true });
    await writeFile(lockPath, '{"version":1,"ownerId":"abandoned"}\n');
    const staleTime = new Date(Date.now() - 1000);
    await utimes(lockPath, staleTime, staleTime);

    const result = withJsonFileLock(path, () => "recovered", {
      timeoutMs: 100,
      retryMs: 5,
      staleMs: 20,
    });

    assert.equal(result, "recovered");
    await assert.rejects(access(lockPath), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("JSON state lock recovers when a stale owner PID has been reused", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-json-lock-reused-pid-"));
  const path = join(root, "state.json");
  const lockPath = `${path}.lock`;
  try {
    await writeFile(lockPath, `${JSON.stringify({
      version: 1,
      ownerId: "abandoned-reused-pid",
      pid: process.pid,
      processStartedAt: "2000-01-01T00:00:00.000Z",
      createdAt: "2000-01-01T00:00:01.000Z",
    })}\n`);
    const staleTime = new Date(Date.now() - 1000);
    await utimes(lockPath, staleTime, staleTime);

    const result = withJsonFileLock(path, () => "recovered", {
      timeoutMs: 100,
      retryMs: 5,
      staleMs: 20,
    });

    assert.equal(result, "recovered");
    await assert.rejects(access(lockPath), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("JSON state lock bypasses an orphaned current reap claim", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-json-lock-orphaned-claim-"));
  const path = join(root, "state.json");
  const lockPath = `${path}.lock`;
  const raw = '{"version":1,"ownerId":"abandoned"}\n';
  try {
    await writeFile(lockPath, raw);
    const staleTime = new Date(Date.now() - 1000);
    await utimes(lockPath, staleTime, staleTime);
    await link(lockPath, `${lockPath}.reap-v1-999999999-1-${"a".repeat(24)}`);

    const result = withJsonFileLock(path, () => "recovered", {
      timeoutMs: 100,
      retryMs: 5,
      staleMs: 20,
    });

    assert.equal(result, "recovered");
    await assert.rejects(access(lockPath), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows recent process protection expires without caching inferred owner or claim births", async (t) => {
  for (const kind of ["owner", "claim"]) {
    for (const state of ["recent", "expires", "dead", "old", "future"]) {
      await t.test(kind + ":" + state, async (t) => {
        const root = await mkdtemp(join(tmpdir(), "memorax-code-json-lock-recent-"));
        const path = join(root, "state.json");
        const lockPath = path + ".lock";
        const base = Date.now();
        const pid = process.pid + 2000000;
        const startedAt = base + (state === "old" ? -6000 : state === "future" ? 1000 : 0);
        const claimPath = lockPath + ".reap-v1-" + pid + "-" + startedAt + "-" + "b".repeat(24);
        const raw = JSON.stringify({ version: 1, ownerId: "fixture", ...(kind === "owner"
          ? { pid, processStartedAt: new Date(startedAt).toISOString() } : {}) });
        await writeFile(lockPath, raw);
        await utimes(lockPath, new Date(base - 60000), new Date(base - 60000));
        if (kind === "claim") await link(lockPath, claimPath);
        const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
        const systemRoot = process.env.SystemRoot;
        const powershell = join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
        const open = fs.openSync;
        const exists = fs.existsSync;
        const kill = process.kill;
        let now = base;
        let attempts = 0;
        let queries = 0;
        Object.defineProperty(process, "platform", { ...platformDescriptor, value: "win32" });
        process.env.SystemRoot = root;
        t.mock.method(Date, "now", () => now);
        t.mock.method(fs, "existsSync", (target) => target === powershell || exists(target));
        t.mock.method(process, "kill", (target, signal) => {
          if (target !== pid) return kill(target, signal);
          if (state === "dead") throw Object.assign(new Error("dead fixture PID"), { code: "ESRCH" });
          return true;
        });
        t.mock.method(fs, "openSync", (target, flags, ...options) => {
          if (target === lockPath && flags === "wx") {
            attempts += 1;
            if (state === "expires" && attempts === 2) {
              assert.equal(queries, 0, "a recent live process must not need an OS birth query");
              assert.equal(fs.readFileSync(lockPath, "utf8"), raw);
              now = base + 6001;
            } else now += 10;
          }
          return open(target, flags, ...options);
        });
        t.mock.method(childProcess, "spawnSync", (command) => {
          queries += 1;
          assert.equal(command, powershell);
          return { status: 0, stdout: new Date(base - 60000).toISOString() };
        });
        syncBuiltinESMExports();
        try {
          const options = { timeoutMs: state === "expires" ? 10000 : 40, retryMs: 1, staleMs: 20, ensurePrivateDirectory: false };
          if (state === "recent") {
            assert.throws(() => withJsonFileLock(path, () => assert.fail("must retain live ownership"), options),
              { code: "JSON_FILE_LOCK_TIMEOUT" });
            assert.equal(queries, 0);
            assert.equal(fs.readFileSync(lockPath, "utf8"), raw);
            if (kind === "claim") assert.equal(fs.readFileSync(claimPath, "utf8"), raw);
          } else {
            assert.equal(withJsonFileLock(path, () => "recovered", options), "recovered");
            assert.equal(queries, state === "dead" ? 0 : 1);
            assert.deepEqual(fs.readdirSync(root), []);
          }
        } finally {
          Object.defineProperty(process, "platform", platformDescriptor);
          if (systemRoot === undefined) delete process.env.SystemRoot;
          else process.env.SystemRoot = systemRoot;
          t.mock.restoreAll();
          syncBuiltinESMExports();
          await rm(root, { recursive: true, force: true });
        }
      });
    }
  }
});

test("contending stale reapers withdraw without spending the wait budget on claim reads", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-json-lock-reaper-contention-"));
  const path = join(root, "state.json");
  const lockPath = `${path}.lock`;
  const competingClaim = `${lockPath}.reap-held-fixture`;
  const originalRead = fs.readFileSync;
  const originalRemove = fs.rmSync;
  const originalNow = Date.now;
  let readDelayMs = 0;
  const isOwnClaim = (target) => typeof target === "string"
    && target.startsWith(`${lockPath}.reap-v1-`);
  try {
    await writeFile(lockPath, '{"version":1,"ownerId":"abandoned"}\n');
    const staleTime = new Date(Date.now() - 60000);
    await utimes(lockPath, staleTime, staleTime);
    await link(lockPath, competingClaim);
    Date.now = () => originalNow() + readDelayMs;
    fs.readFileSync = (target, ...args) => {
      if (isOwnClaim(target) && fs.existsSync(competingClaim)) {
        // Model slow claim I/O while another reaper holds a claim, without sleeping.
        readDelayMs += 2000;
      }
      return originalRead(target, ...args);
    };
    fs.rmSync = (target, ...args) => {
      const result = originalRemove(target, ...args);
      if (isOwnClaim(target)) {
        // The other reaper drops its claim after this contender withdraws.
        originalRemove(competingClaim, { force: true });
      }
      return result;
    };
    syncBuiltinESMExports();

    assert.equal(withJsonFileLock(path, () => "recovered"), "recovered");
    assert.deepEqual(fs.readdirSync(root), []);
  } finally {
    Date.now = originalNow;
    fs.readFileSync = originalRead;
    fs.rmSync = originalRemove;
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

test("JSON state lock retries when its unpublished owner is reaped", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-json-lock-unpublished-"));
  const path = join(root, "state.json");
  const releaseReplacement = deferred();
  const originalWrite = fs.writeFileSync;
  const order = [];
  let replaceBeforeWrite = true;
  let first;
  let replacement;
  fs.writeFileSync = (descriptor, ...args) => {
    if (replaceBeforeWrite && typeof descriptor === "number") {
      replaceBeforeWrite = false;
      const staleTime = new Date(Date.now() - 1000);
      fs.futimesSync(descriptor, staleTime, staleTime);
      replacement = withJsonFileLockAsync(path, async () => {
        order.push("replacement:start");
        await releaseReplacement.promise;
        order.push("replacement:end");
      }, { timeoutMs: 500, retryMs: 2, staleMs: 20 });
    }
    return originalWrite(descriptor, ...args);
  };
  syncBuiltinESMExports();
  try {
    first = withJsonFileLockAsync(path, () => { order.push("first"); }, {
      timeoutMs: 500, retryMs: 2, staleMs: 20,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(order, ["replacement:start"]);
    releaseReplacement.resolve();
    await Promise.all([first, replacement]);
    assert.deepEqual(order, ["replacement:start", "replacement:end", "first"]);
    await assert.rejects(access(`${path}.lock`), /ENOENT/);
  } finally {
    fs.writeFileSync = originalWrite;
    syncBuiltinESMExports();
    releaseReplacement.resolve();
    await Promise.allSettled([first, replacement]);
    await rm(root, { recursive: true, force: true });
  }
});

test("JSON state lock waits for an in-flight stale-reaper claim before entering", async (t) => {
  for (const outcome of ["reaped", "timeout", "aborted"]) {
    await t.test(outcome, async () => {
      const root = await mkdtemp(join(tmpdir(), "memorax-code-json-lock-publication-"));
      const path = join(root, "state.json");
      const lockPath = `${path}.lock`;
      const claimPath = `${lockPath}.reap-paused-fixture`;
      const originalWrite = fs.writeFileSync;
      let pauseReaper = true;
      let entered = false;
      let acquisition;
      fs.writeFileSync = (descriptor, ...args) => {
        if (pauseReaper && typeof descriptor === "number") {
          pauseReaper = false;
          // A reaper checked the empty lock and paused just before unlinking it.
          fs.linkSync(lockPath, claimPath);
        }
        return originalWrite(descriptor, ...args);
      };
      syncBuiltinESMExports();
      try {
        const controller = new AbortController();
        const options = { timeoutMs: outcome === "timeout" ? 20 : 500, retryMs: 2, signal: controller.signal };
        const operation = () => { entered = true; };
        if (outcome === "timeout") {
          assert.throws(() => withJsonFileLock(path, operation, options), { code: "JSON_FILE_LOCK_TIMEOUT" });
        } else {
          acquisition = withJsonFileLockAsync(path, operation, options);
        }
        assert.equal(entered, false);
        if (outcome === "reaped") {
          fs.unlinkSync(lockPath);
          fs.unlinkSync(claimPath);
          await acquisition;
          assert.equal(entered, true);
        } else {
          if (outcome === "aborted") {
            controller.abort();
            await assert.rejects(acquisition, { code: "JSON_FILE_LOCK_ABORTED" });
          }
          assert.equal(await readFile(lockPath, "utf8"), "");
          fs.unlinkSync(claimPath);
          const staleTime = new Date(Date.now() - 1000);
          await utimes(lockPath, staleTime, staleTime);
          assert.equal(withJsonFileLock(path, () => "recovered", { staleMs: 20 }), "recovered");
        }
        await assert.rejects(access(lockPath), /ENOENT/);
      } finally {
        fs.writeFileSync = originalWrite;
        syncBuiltinESMExports();
        await rm(claimPath, { force: true });
        await acquisition?.catch(() => undefined);
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("concurrent stale-lock reapers never overlap lock ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-json-lock-reaper-race-"));
  const path = join(root, "state.json");
  const lockPath = `${path}.lock`;
  const workerPath = join(root, "worker.mjs");
  const overlapPath = join(root, "overlap.log");
  const criticalPath = join(root, "critical.lock");
  try {
    const staleRecord = JSON.stringify({
      version: 1,
      ownerId: "abandoned",
      padding: "x".repeat(5 * 1024 * 1024),
    });
    await writeFile(lockPath, `${staleRecord}\n`);
    const staleTime = new Date(Date.now() - 1000);
    await utimes(lockPath, staleTime, staleTime);
    await writeFile(workerPath, [
      'import { appendFileSync, closeSync, openSync, unlinkSync } from "node:fs";',
      `import { withJsonFileLock } from ${JSON.stringify(configUtilsUrl)};`,
      "const [path, criticalPath, overlapPath] = process.argv.slice(2);",
      "withJsonFileLock(path, () => {",
      "  let descriptor;",
      "  try {",
      '    descriptor = openSync(criticalPath, "wx");',
      "  } catch {",
      '    appendFileSync(overlapPath, "overlap\\n");',
      "  }",
      "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15);",
      "  if (descriptor !== undefined) {",
      "    closeSync(descriptor);",
      "    unlinkSync(criticalPath);",
      "  }",
      "}, { timeoutMs: 5000, staleMs: 20, retryMs: 2 });",
      "",
    ].join("\n"));

    const results = await Promise.all(
      Array.from({ length: 24 }, () => runWorker(
        workerPath,
        [path, criticalPath, overlapPath],
      )),
    );
    for (const result of results) {
      assert.equal(result.code, 0, result.stderr);
    }
    const overlaps = await readFile(overlapPath, "utf8").catch((error) => {
      if (error?.code === "ENOENT") return "";
      throw error;
    });
    assert.equal(overlaps, "");
    await assert.rejects(access(lockPath), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function runWorker(path, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path, ...args], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

function deferred() {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
}

function lockAbortError(error, path) {
  return error?.code === "JSON_FILE_LOCK_ABORTED"
    && error.path === path
    && error.lockPath === `${path}.lock`;
}

test("atomic JSON publication retries Windows contention without rewriting the temporary file", async (t) => {
  for (const [platform, failures, expectedAttempts] of [
    ["win32", 2, 3],
    ["win32", Infinity, 5],
    ["linux", 2, 1],
  ]) {
    await t.test(platform + ":" + failures, async (t) => {
      const root = await mkdtemp(join(tmpdir(), "memorax-code-json-publish-"));
      const path = join(root, "job.json");
      const original = '{"status":"running"}\n';
      await writeFile(path, original);
      const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
      const rename = fs.renameSync;
      let attempts = 0;
      const blocked = Object.assign(new Error("fixture file is busy"), { code: "EPERM" });
      Object.defineProperty(process, "platform", { ...descriptor, value: platform });
      const writes = t.mock.method(fs, "writeFileSync");
      t.mock.method(Atomics, "wait", () => "timed-out");
      t.mock.method(fs, "renameSync", (source, destination) => {
        assert.equal(fs.readFileSync(path, "utf8"), original);
        if (++attempts <= failures) throw blocked;
        return rename(source, destination);
      });
      syncBuiltinESMExports();
      try {
        if (platform === "win32" && failures !== Infinity) {
          atomicWriteJson(path, { status: "succeeded" });
          assert.equal(JSON.parse(await readFile(path, "utf8")).status, "succeeded");
        } else {
          assert.throws(() => atomicWriteJson(path, { status: "succeeded" }), (error) => error === blocked);
          assert.equal(await readFile(path, "utf8"), original);
        }
        assert.equal(attempts, expectedAttempts);
        assert.equal(writes.mock.callCount(), 1);
        assert.deepEqual(fs.readdirSync(root), ["job.json"]);
      } finally {
        Object.defineProperty(process, "platform", descriptor);
        t.mock.restoreAll();
        syncBuiltinESMExports();
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});
