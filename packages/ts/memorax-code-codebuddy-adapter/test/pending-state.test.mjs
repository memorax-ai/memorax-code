import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { readPending, updatePending } from "../hooks/pending-state.mjs";

const pendingModuleUrl = new URL("../hooks/pending-state.mjs", import.meta.url).href;

test("pending state waits for a legacy directory owner and reads its final update", async (t) => {
  const { root, path, lockPath } = await fixture(t);
  const original = { earlier: pendingRecord("earlier") };
  await writeFile(path, JSON.stringify(original));
  await mkdir(lockPath);

  let mutated = false;
  const update = updatePending(path, (state) => {
    mutated = true;
    state.current = pendingRecord("current");
  });
  assert.equal(mutated, false);
  assert.equal((await stat(lockPath)).isDirectory(), true);
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), original);

  const legacyState = { ...original, legacy: pendingRecord("legacy") };
  await writeFile(path, JSON.stringify(legacyState));
  await rm(lockPath, { recursive: true });
  await update;

  const state = await readPending(path);
  assert.deepEqual(state.legacy, legacyState.legacy);
  assert.deepEqual(Object.keys(state).sort(), ["current", "earlier", "legacy"]);
  await assert.rejects(stat(lockPath), { code: "ENOENT" });
  if (process.platform !== "win32") {
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(root)).mode & 0o777, 0o700);
  }
});

test("pending state never reaps an aged legacy directory without owner evidence", async (t) => {
  const { path, lockPath } = await fixture(t);
  const original = JSON.stringify({ retained: pendingRecord("retained") });
  await writeFile(path, original);
  await mkdir(lockPath);
  await writeFile(join(lockPath, "owner-evidence"), "preserve");
  const old = new Date(Date.now() - 60_000);
  await utimes(lockPath, old, old);

  let mutated = false;
  await assert.rejects(updatePending(path, () => { mutated = true; }), (error) => {
    assert.equal(error.code, "JSON_FILE_LOCK_TIMEOUT");
    assert.equal(error.lockPath, lockPath);
    assert.match(error.message, /legacy CodeBuddy Hook directory lock remains/);
    return true;
  });
  assert.equal(mutated, false);
  assert.equal(await readFile(path, "utf8"), original);
  assert.equal(await readFile(join(lockPath, "owner-evidence"), "utf8"), "preserve");
});

test("pending state publication failure preserves the previous private record", async (t) => {
  const { root, path, lockPath } = await fixture(t);
  await updatePending(path, (state) => { state.retained = pendingRecord("retained"); });
  const original = await readFile(path, "utf8");
  const rename = fs.renameSync;
  const failure = Object.assign(new Error("injected publication failure"), { code: "EIO" });
  fs.renameSync = (source, target) => {
    if (target === path) throw failure;
    return rename(source, target);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(updatePending(path, (state) => {
      delete state.retained;
      state.replacement = pendingRecord("replacement");
    }), (error) => error === failure);
  } finally {
    fs.renameSync = rename;
    syncBuiltinESMExports();
  }
  assert.equal(await readFile(path, "utf8"), original);
  await assert.rejects(stat(lockPath), { code: "ENOENT" });
  assert.deepEqual(await readdir(root), ["pending.json"]);
});

test("pending state retains native validation, expiration, and entry limits", async (t) => {
  const { path } = await fixture(t);
  const previousTtl = process.env.MEMORAX_CODE_CODEBUDDY_PENDING_TTL_MS;
  const previousMax = process.env.MEMORAX_CODE_CODEBUDDY_PENDING_MAX_ENTRIES;
  process.env.MEMORAX_CODE_CODEBUDDY_PENDING_TTL_MS = "10000";
  process.env.MEMORAX_CODE_CODEBUDDY_PENDING_MAX_ENTRIES = "2";
  try {
    const now = Date.now();
    const state = {
      expired: pendingRecord("expired", now - 20_000),
      oldest: pendingRecord("oldest", now - 2_000),
      retained: pendingRecord("retained", now - 1_000),
      newest: pendingRecord("newest", now),
      malformed: { ...pendingRecord("malformed", now), turnId: "unqualified" },
      unsupported: { ...pendingRecord("unsupported", now), version: 2 },
    };
    await writeFile(path, JSON.stringify(state));
    assert.deepEqual(await readPending(path), {
      retained: state.retained,
      newest: state.newest,
    });
  } finally {
    if (previousTtl === undefined) delete process.env.MEMORAX_CODE_CODEBUDDY_PENDING_TTL_MS;
    else process.env.MEMORAX_CODE_CODEBUDDY_PENDING_TTL_MS = previousTtl;
    if (previousMax === undefined) delete process.env.MEMORAX_CODE_CODEBUDDY_PENDING_MAX_ENTRIES;
    else process.env.MEMORAX_CODE_CODEBUDDY_PENDING_MAX_ENTRIES = previousMax;
  }
});

test("concurrent pending writers share one lock and preserve every session", { timeout: 15000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-codebuddy-pending-writers-"));
  const path = join(root, "pending.json");
  const releasePath = join(root, "release-owner");
  const workers = Array.from({ length: 6 }, (_, index) => startWriter(path, releasePath, String(index)));
  t.after(async () => {
    for (const worker of workers) {
      if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill("SIGKILL");
    }
    await Promise.all(workers.map((worker) => worker.closed));
    await rm(root, { recursive: true, force: true });
  });
  await Promise.all(workers.map((worker) => worker.waitFor("ready")));
  workers[0].child.send("start");
  await workers[0].waitFor("entered");
  for (const worker of workers.slice(1)) worker.child.send("start");
  await Promise.all(workers.slice(1).map((worker) => worker.waitFor("contending")));
  await writeFile(releasePath, "release");
  const results = await Promise.all(workers.map((worker) => worker.closed));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  const state = await readPending(path);
  assert.deepEqual(Object.keys(state).sort(), ["0", "1", "2", "3", "4", "5"]);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "memorax-codebuddy-pending-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "pending.json");
  return { root, path, lockPath: `${path}.lock` };
}

function pendingRecord(sessionId, timestamp = Date.now()) {
  return {
    version: 1,
    turnId: `${sessionId}:0:${"a".repeat(64)}`,
    transcriptPath: "session.jsonl",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function startWriter(path, releasePath, sessionId) {
  const source = `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const [path, releasePath, sessionId] = process.argv.slice(1);
    const exists = fs.existsSync;
    let reported = false;
    fs.existsSync = (target) => {
      const present = exists(target);
      if (target === path + ".lock" && present && !reported) {
        reported = true;
        process.send("contending");
      }
      return present;
    };
    syncBuiltinESMExports();
    const { updatePending } = await import(${JSON.stringify(pendingModuleUrl)});
    const started = new Promise((resolve) => process.once("message", resolve));
    process.send("ready");
    await started;
    await updatePending(path, (state) => {
      const critical = path + ".critical";
      const descriptor = fs.openSync(critical, "wx");
      try {
        if (sessionId === "0") {
          process.send("entered");
          const deadline = Date.now() + 5000;
          while (!exists(releasePath)) {
            if (Date.now() > deadline) throw new Error("owner release timed out");
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
          }
        }
        const now = Date.now();
        state[sessionId] = {
          version: 1,
          turnId: sessionId + ":0:" + "a".repeat(64),
          transcriptPath: "session.jsonl",
          createdAt: now,
          updatedAt: now,
        };
      } finally {
        fs.closeSync(descriptor);
        fs.unlinkSync(critical);
      }
    });
    process.disconnect();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source, path, releasePath, sessionId], {
    env: { ...process.env, MEMORAX_CODE_HOME: dirname(path), MEMORAX_CODE_CODEBUDDY_PENDING_TTL_MS: "86400000", MEMORAX_CODE_CODEBUDDY_PENDING_MAX_ENTRIES: "200" },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  const received = new Set();
  const waiting = new Map();
  let exited;
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.on("message", (message) => {
    received.add(message);
    waiting.get(message)?.resolve();
    waiting.delete(message);
  });
  const closed = new Promise((resolve) => child.on("close", (code) => {
    exited = new Error(`pending writer exited before synchronization: ${code}; ${stderr}`);
    for (const waiter of waiting.values()) waiter.reject(exited);
    resolve({ code, stderr });
  }));
  return {
    child,
    closed,
    waitFor(event) {
      if (received.has(event)) return Promise.resolve();
      if (exited) return Promise.reject(exited);
      return new Promise((resolve, reject) => waiting.set(event, { resolve, reject }));
    },
  };
}
