import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  clearIncrementalJsonlProjections,
  readIncrementalJsonlProjection,
  readIncrementalJsonlProjectionSnapshot,
} from "../../dist/shared/incremental-jsonl-projection.js";

test.beforeEach(() => clearIncrementalJsonlProjections());

test("incremental JSONL projection refreshes only entries that still have retry keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-incremental-jsonl-retry-"));
  const sessionDir = join(root, "session-one");
  const eventsPath = join(sessionDir, "events.jsonl");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(eventsPath, [
    JSON.stringify({ id: "resolved", retry: false }),
    JSON.stringify({ id: "pending", retry: true }),
  ].join("\n"), "utf8");

  const refreshed = [];
  let resolveRetries = false;
  const options = {
    root,
    filename: "events.jsonl",
    project(value) {
      const event = value;
      return {
        value: event.id,
        ...(event.retry ? { retryKey: event.id } : {}),
      };
    },
    refreshEntry(entry) {
      assert.ok(entry.retryKey);
      refreshed.push(entry.retryKey);
      if (!resolveRetries) return false;
      entry.retryKey = undefined;
      return true;
    },
    compare: (left, right) => left.localeCompare(right),
  };

  assert.deepEqual(await readIncrementalJsonlProjection(options), ["pending", "resolved"]);
  assert.deepEqual(refreshed, []);

  await readIncrementalJsonlProjection(options);
  assert.deepEqual(refreshed, ["pending"]);

  await appendFile(eventsPath, [
    JSON.stringify({ id: "appended-resolved", retry: false }),
    JSON.stringify({ id: "appended-pending", retry: true }),
  ].map((line) => `\n${line}`).join(""), "utf8");
  await readIncrementalJsonlProjection(options);
  assert.deepEqual(refreshed, ["pending", "pending"]);

  resolveRetries = true;
  await readIncrementalJsonlProjection(options);
  assert.deepEqual(refreshed, ["pending", "pending", "pending", "appended-pending"]);

  await readIncrementalJsonlProjection(options);
  assert.deepEqual(refreshed, ["pending", "pending", "pending", "appended-pending"]);
});

test("incremental JSONL projections keep independent namespaces for one trace file", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-incremental-jsonl-namespace-"));
  const sessionDir = join(root, "session-one");
  await mkdir(sessionDir, { recursive: true });
  await writeFile(
    join(sessionDir, "events.jsonl"),
    `${JSON.stringify({ id: "shared" })}\n`,
    "utf8",
  );
  let firstProjectionCalls = 0;
  let secondProjectionCalls = 0;
  const options = (namespace, prefix, count) => ({
    namespace,
    root,
    filename: "events.jsonl",
    project(value) {
      count();
      return { value: `${prefix}:${value.id}` };
    },
    compare: (left, right) => left.localeCompare(right),
  });

  assert.deepEqual(await readIncrementalJsonlProjection(options(
    "first",
    "first",
    () => { firstProjectionCalls += 1; },
  )), ["first:shared"]);
  assert.deepEqual(await readIncrementalJsonlProjection(options(
    "second",
    "second",
    () => { secondProjectionCalls += 1; },
  )), ["second:shared"]);
  assert.deepEqual(await readIncrementalJsonlProjection(options(
    "first",
    "first",
    () => { firstProjectionCalls += 1; },
  )), ["first:shared"]);
  assert.equal(firstProjectionCalls, 1);
  assert.equal(secondProjectionCalls, 1);
});

test("incremental JSONL projection reports an incomplete best-effort snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-incremental-jsonl-completeness-"));
  const validSessionDir = join(root, "session-valid");
  const brokenSessionDir = join(root, "session-broken");
  await mkdir(validSessionDir, { recursive: true });
  await mkdir(brokenSessionDir, { recursive: true });
  await writeFile(
    join(validSessionDir, "events.jsonl"),
    `${JSON.stringify({ id: "valid" })}\n`,
    "utf8",
  );
  await writeFile(
    join(brokenSessionDir, "events.jsonl"),
    '{"id":"possibly-colliding"\n',
    "utf8",
  );
  const options = {
    root,
    filename: "events.jsonl",
    project(value) {
      return { value: value.id };
    },
    compare: (left, right) => left.localeCompare(right),
  };

  assert.deepEqual(await readIncrementalJsonlProjectionSnapshot(options), {
    values: ["valid"],
    complete: false,
  });
  assert.deepEqual(await readIncrementalJsonlProjection(options), ["valid"]);

  await writeFile(
    join(brokenSessionDir, "events.jsonl"),
    `${JSON.stringify({ id: "repaired" })}\n`,
    "utf8",
  );
  assert.deepEqual(await readIncrementalJsonlProjectionSnapshot(options), {
    values: ["repaired", "valid"],
    complete: true,
  });
});
