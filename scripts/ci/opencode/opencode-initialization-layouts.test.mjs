import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createInitializationLayoutPlan } from "./opencode-initialization-layouts.mjs";

const osRoot = `C:\\${"o".repeat(50)}`;
const runnerRoot = `D:\\${"r".repeat(21)}`;

test("Windows initialization layouts match lengths without leaving their owned roots", () => {
  const { layouts } = createInitializationLayoutPlan(osRoot, runnerRoot, path.win32);
  assert.deepEqual(layouts.map((layout) => layout.id), ["os-short", "os-long", "runner-short", "runner-long"]);
  assert.deepEqual(layouts.map((layout) => layout.tempDirectory.length), [76, 105, 76, 105]);
  assert.deepEqual(layouts.map((layout) => path.win32.join(layout.tempDirectory,
    "memorax-opencode-server-000000", "user home", ".config", "opencode").length), [134, 163, 134, 163]);
  assert.equal(new Set(layouts.map((layout) => layout.tempDirectory)).size, 4);
  for (const layout of layouts) {
    assert.equal(layout.root, layout.id.startsWith("os-") ? osRoot : runnerRoot);
    assert.equal(path.win32.dirname(layout.tempDirectory), layout.root);
    assert.match(path.win32.relative(layout.root, layout.tempDirectory), /^p+$/);
  }
});

test("longer owned roots increase both locations by the same amount", () => {
  const longRoot = `C:\\${"o".repeat(82)}`;
  const { layouts } = createInitializationLayoutPlan(longRoot, runnerRoot, path.win32);
  const short = longRoot.length + 2;
  assert.deepEqual(layouts.map((layout) => layout.tempDirectory.length), [short, short + 29, short, short + 29]);
  for (const layout of layouts) {
    assert.equal(path.win32.dirname(layout.tempDirectory), layout.root);
    assert.match(path.win32.relative(layout.root, layout.tempDirectory), /^p+$/);
  }
});

test("initialization rounds balance positions and ordered adjacent pairs", () => {
  const { layouts, rounds } = createInitializationLayoutPlan(osRoot, runnerRoot, path.win32);
  assert.deepEqual(rounds.map((round) => round.map((layout) => layouts.indexOf(layout))),
    [[0, 1, 3, 2], [1, 2, 0, 3], [2, 3, 1, 0], [3, 0, 2, 1]]);
  for (const round of rounds) assert.equal(new Set(round.map((layout) => layout.id)).size, 4);
  for (let position = 0; position < 4; position++) {
    assert.equal(new Set(rounds.map((round) => round[position].id)).size, 4);
  }
  const pairs = new Map();
  for (const round of rounds) {
    for (let position = 1; position < round.length; position++) {
      const pair = `${round[position - 1].id}:${round[position].id}`;
      pairs.set(pair, (pairs.get(pair) ?? 0) + 1);
    }
  }
  assert.equal(pairs.size, 12);
  assert.equal([...pairs.values()].every((count) => count === 1), true);
});

test("initialization layouts reject invalid or equivalent Windows roots without exposing them", () => {
  for (const root of [undefined, null, 1, "", "PRIVATE_RELATIVE_ROOT", "C:PRIVATE_DRIVE_RELATIVE_ROOT"]) {
    for (const roots of [[root, runnerRoot], [osRoot, root]]) {
      assert.throws(() => createInitializationLayoutPlan(...roots, path.win32), (error) => {
        assert.equal(error.message, "INIT_DIAG_LAYOUT_ROOT_NOT_ABSOLUTE");
        assert.equal(error.nativeCode, error.message);
        return true;
      });
    }
  }
  assert.throws(() => createInitializationLayoutPlan("C:\\PRIVATE_ROOT\\owned",
    "c:/private_root/owned/child/..", path.win32), (error) => {
    assert.equal(error.message, "INIT_DIAG_LAYOUT_ROOTS_NOT_DISTINCT");
    assert.equal(error.nativeCode, error.message);
    return true;
  });
});

test("initialization layouts default to the host path API and normalize trailing separators", () => {
  const root = path.parse(process.cwd()).root;
  const first = path.join(root, "initialization-os-owned");
  const second = path.join(root, "initialization-runner-owned");
  const { layouts } = createInitializationLayoutPlan(`${first}${path.sep}`, second);
  assert.equal(layouts[0].root, first);
  assert.equal(layouts[2].root, second);
  assert.equal(layouts[0].tempDirectory.length, layouts[2].tempDirectory.length);
  for (const layout of layouts) assert.equal(path.dirname(layout.tempDirectory), layout.root);
});
