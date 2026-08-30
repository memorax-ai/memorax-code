import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const commonRoot = join(packageRoot, "..", "..", "ts", "memorax-code-adapter-common", "src");

test("automatic update checks once per successful eight-hour window", async (t) => {
  const { api, memoraxCodeHome } = await fixture(t);
  const calls = [];
  const handlers = {
    resolveTargetVersion: async () => record(calls, "check", "0.1.9"),
    installVersion: async () => record(calls, "install", true),
    reconcile: async () => record(calls, "reconcile", true),
  };
  const first = await api.runAutomaticUpdateCore(options(memoraxCodeHome, "08:00:00", handlers));
  const throttled = await api.runAutomaticUpdateCore(options(memoraxCodeHome, "15:59:59", {
    ...handlers,
    resolveTargetVersion: async () => record(calls, "check", "0.1.10"),
  }));

  assert.equal(first.disposition, "up-to-date");
  assert.equal(throttled.disposition, "throttled");
  assert.deepEqual(calls, ["check"]);
  const state = await readState(api, memoraxCodeHome);
  assert.deepEqual(Object.keys(state).sort(), ["installedVersion", "nextCheckAt", "version"]);
  assert.equal(state.nextCheckAt, "2026-08-30T16:00:00.000Z");
});

test("automatic update installs an exact target and reconciles configured clients", async (t) => {
  const { api, memoraxCodeHome } = await fixture(t);
  const calls = [];
  const result = await api.runAutomaticUpdateCore(options(memoraxCodeHome, "08:00:00", {
    resolveTargetVersion: async (channel) => record(calls, ["check", channel], "0.1.10"),
    installVersion: async (version) => record(calls, ["install", version], true),
    reconcile: async (version) => record(calls, ["reconcile", version], true),
  }));

  assert.equal(result.disposition, "updated");
  assert.deepEqual(calls, [
    ["check", "latest"],
    ["install", "0.1.10"],
    ["reconcile", "0.1.10"],
  ]);
  const state = await readState(api, memoraxCodeHome);
  assert.equal(state.installedVersion, "0.1.10");
  assert.deepEqual(Object.keys(state).sort(), ["installedVersion", "nextCheckAt", "version"]);
});

test("automatic update retries failures after fifteen minutes and repairs stale setup", async (t) => {
  const { api, memoraxCodeHome } = await fixture(t);
  let checks = 0;
  let reconciles = 0;
  const base = {
    installedVersion: "0.1.10",
    completedByVersion: "0.1.9",
    resolveTargetVersion: async () => {
      checks += 1;
      return "0.1.10";
    },
    reconcile: async () => {
      reconciles += 1;
      return true;
    },
  };
  const failed = await api.runAutomaticUpdateCore(options(memoraxCodeHome, "08:00:00", {
    ...base,
    resolveTargetVersion: async () => {
      checks += 1;
      throw new Error("registry unavailable");
    },
  }));
  const throttled = await api.runAutomaticUpdateCore(options(memoraxCodeHome, "08:14:59", base));
  const repaired = await api.runAutomaticUpdateCore(options(memoraxCodeHome, "08:15:00", base));

  assert.deepEqual(
    [failed.reason, throttled.disposition, repaired.disposition, checks, reconciles],
    ["check_failed", "throttled", "reconciled", 2, 1],
  );
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-automatic-update-"));
  const files = [
    [join(packageRoot, "lib", "automatic-update.mjs"), "lib/automatic-update.mjs"],
    [join(packageRoot, "lib", "npm-invocation.mjs"), "lib/npm-invocation.mjs"],
    ...["config-utils.mjs", "automatic-update-state.mjs", "runtime-record.mjs", "setup-completion.mjs"]
      .map((name) => [join(commonRoot, name), `lib/memorax-code-adapter-common/src/${name}`]),
  ];
  await Promise.all(files.map(async ([source, relativeTarget]) => {
    const target = join(root, relativeTarget);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target);
  }));
  t.after(() => rm(root, { recursive: true, force: true }));
  return {
    api: await import(pathToFileURL(join(root, "lib", "automatic-update.mjs")).href),
    memoraxCodeHome: join(root, "home"),
  };
}

function options(memoraxCodeHome, time, overrides = {}) {
  return {
    memoraxCodeHome,
    installedVersion: "0.1.9",
    completedByVersion: "0.1.9",
    channel: "latest",
    now: () => Date.parse(`2026-08-30T${time}.000Z`),
    resolveTargetVersion: async () => "0.1.9",
    installVersion: async () => true,
    reconcile: async () => true,
    ...overrides,
  };
}

async function readState(api, memoraxCodeHome) {
  return JSON.parse(await readFile(api.automaticUpdateStatePath(memoraxCodeHome), "utf8"));
}

function record(calls, entry, result) {
  calls.push(entry);
  return result;
}
