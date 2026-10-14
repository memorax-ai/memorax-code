import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import {
  captureCursorCompaction, consumeCursorCompaction,
} from "../../../dist/clients/cursor/compaction.js";

const binding = {
  databasePath: resolve("synthetic", "state.vscdb"),
  cwd: resolve("synthetic", "repo"),
  scopeKey: "f".repeat(64),
};
const databaseIdentity = "e".repeat(64);
const firstArchive = archive("aa", "d1", ["a1", "a2"]);
const secondArchive = archive("bb", "d2", ["d1", "a3"]);
const baseline = snapshot(["a1", "a2", "a3"]);
const compacted = snapshot(["d1", "a3"], [firstArchive]);

test("Cursor compaction consumes native replacement evidence only once", () => {
  const state = captureCursorCompaction(undefined, binding, baseline);
  assert.equal(consumeCursorCompaction(state, binding, compacted), true);
  assert.deepEqual(state.processedArchiveIds, ["aa"]);
  assert.equal(consumeCursorCompaction(state, binding, compacted), false);
});

test("Cursor compaction keeps the baseline pending when roots only append", () => {
  const state = captureCursorCompaction(undefined, binding, baseline);
  assert.equal(consumeCursorCompaction(state, binding, snapshot(["a1", "a2", "a3", "a4"])), false);
  assert.deepEqual(state.baseline.rootMessageIds, baseline.rootMessageIds);
  assert.equal(consumeCursorCompaction(state, binding, snapshot(["d1", "a3", "a4"], [firstArchive])), true);
});

test("Cursor compaction waits for every summarized root before consuming successive archives", () => {
  const state = captureCursorCompaction(undefined, binding, baseline);
  const partial = snapshot(["d1", "a2", "a3"], [firstArchive]);
  assert.equal(consumeCursorCompaction(state, binding, partial), false);
  assert.deepEqual(state.baseline.rootMessageIds, baseline.rootMessageIds);
  assert.deepEqual(state.processedArchiveIds, []);
  captureCursorCompaction(state, binding, partial);
  assert.deepEqual(state.baseline.rootMessageIds, baseline.rootMessageIds);

  captureCursorCompaction(state, binding, compacted);
  const nestedPartial = snapshot(["d2", "d1", "a4"], [firstArchive, secondArchive]);
  assert.equal(consumeCursorCompaction(state, binding, nestedPartial), false);
  assert.deepEqual(state.baseline.rootMessageIds, baseline.rootMessageIds);
  assert.deepEqual(state.processedArchiveIds, []);

  const complete = snapshot(["d2", "a4"], [firstArchive, secondArchive]);
  assert.equal(consumeCursorCompaction(state, binding, complete), true);
  assert.deepEqual(state.processedArchiveIds, ["aa", "bb"]);
  assert.equal(state.baseline, undefined);
  assert.equal(consumeCursorCompaction(state, binding, complete), false);
});

test("Cursor compaction rejects archives without the matching root replacement", () => {
  const cases = [
    ["all original roots remain", snapshot(["a1", "a2", "a3", "d1"], [firstArchive])],
    ["archive refers to unrelated roots", snapshot(["d1", "a3"], [archive("aa", "d1", ["ff"])])],
    ["unsummarized root disappears", snapshot(["d1"], [firstArchive])],
    ["surviving roots change order", snapshot(["a3", "d1"], [firstArchive])],
  ];
  for (const [label, current] of cases) {
    const state = captureCursorCompaction(undefined, binding, baseline);
    assert.equal(consumeCursorCompaction(state, binding, current), false, label);
    assert.equal(state.baseline, undefined, label);
    assert.deepEqual(state.processedArchiveIds, [], label);
  }
});

test("Cursor successive compactions retain the earliest applicable baseline", () => {
  const state = captureCursorCompaction(undefined, binding, baseline);
  captureCursorCompaction(state, binding, compacted);
  assert.deepEqual(state.baseline.rootMessageIds, baseline.rootMessageIds);
  assert.equal(consumeCursorCompaction(state, binding, snapshot(["d2"], [firstArchive, secondArchive])), true);
  assert.deepEqual(state.processedArchiveIds, ["aa", "bb"]);
});

test("Cursor successful replacement survives a later compact attempt with no replacement", () => {
  const state = captureCursorCompaction(undefined, binding, baseline);
  captureCursorCompaction(state, binding, compacted);
  assert.equal(consumeCursorCompaction(state, binding, compacted), true);
  assert.deepEqual(state.processedArchiveIds, ["aa"]);
});

test("Cursor compaction requires an append-only archive prefix", () => {
  for (const current of [baseline, snapshot(["d2"], [secondArchive])]) {
    const state = captureCursorCompaction(undefined, binding, compacted);
    assert.equal(consumeCursorCompaction(state, binding, current), false);
    assert.equal(state.baseline, undefined);
  }
});

test("Cursor processed archives stay deduplicated after native history rollback", () => {
  const state = captureCursorCompaction(undefined, binding, baseline);
  assert.equal(consumeCursorCompaction(state, binding, compacted), true);
  captureCursorCompaction(state, binding, baseline);
  assert.equal(consumeCursorCompaction(state, binding, compacted), false);
  assert.deepEqual(state.processedArchiveIds, ["aa"]);
});

test("Cursor compaction rejects a replacement database or changed scope binding", () => {
  for (const [currentBinding, current] of [
    [binding, { ...compacted, databaseIdentity: "b".repeat(64) }],
    [{ ...binding, scopeKey: "b".repeat(64) }, compacted],
    [{ ...binding, cwd: resolve("synthetic", "other-repo") }, compacted],
    [{ ...binding, databasePath: resolve("synthetic", "other.vscdb") }, compacted],
  ]) {
    const state = captureCursorCompaction(undefined, binding, baseline);
    assert.equal(consumeCursorCompaction(state, currentBinding, current), false);
    assert.equal(state.baseline, undefined);
  }
});

function snapshot(rootMessageIds, archives = []) {
  return { databaseIdentity, rootMessageIds, archives };
}

function archive(id, summaryMessageId, summarizedMessageIds) {
  return { id, summaryMessageId, summarizedMessageIds };
}
