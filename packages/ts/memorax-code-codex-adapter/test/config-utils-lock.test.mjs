import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  withJsonFileLock,
  withJsonFileLockAsync,
} from "../../memorax-code-adapter-common/src/config-utils.mjs";

const configUtilsSourceUrl = new URL(
  "../../memorax-code-adapter-common/src/config-utils.mjs",
  import.meta.url,
);
const configUtilsUrl = configUtilsSourceUrl.href;
const configUtilsDeclarationUrl = new URL(
  "../../memorax-code-adapter-common/src/config-utils.d.mts",
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
