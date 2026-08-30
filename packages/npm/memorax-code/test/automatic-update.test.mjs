import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-automatic-update-"));
  const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const commonRoot = join(packageRoot, "..", "..", "ts", "memorax-code-adapter-common", "src");
  for (const relativePath of [
    "lib/automatic-update.mjs",
    "lib/memorax-code-adapter-common/src/config-utils.mjs",
    "lib/memorax-code-adapter-common/src/hooks/automatic-update-scheduler.mjs",
    "lib/memorax-code-adapter-common/src/runtime-record.mjs",
    "lib/memorax-code-adapter-common/src/setup-completion.mjs",
    "lib/npm-invocation.mjs",
  ]) {
    const source = relativePath === "lib/automatic-update.mjs"
      ? join(packageRoot, "lib", "automatic-update.mjs")
      : relativePath.startsWith("lib/memorax-code-adapter-common/src/")
        ? join(commonRoot, relativePath.slice("lib/memorax-code-adapter-common/src/".length))
        : join(packageRoot, relativePath);
    const target = join(root, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target);
  }
  const api = await import(pathToFileURL(join(root, "lib", "automatic-update.mjs")).href);
  return { root, memoraxCodeHome: join(root, "home"), api };
}

test("automatic update checks once per successful eight-hour window", async () => {
  const fixtureRoot = await fixture();
  const { memoraxCodeHome, api } = fixtureRoot;
  let checks = 0;
  let installs = 0;
  let reconciles = 0;
  try {
    const first = await api.runAutomaticUpdateCore({
      memoraxCodeHome,
      installedVersion: "0.1.9",
      completedByVersion: "0.1.9",
      channel: "latest",
      now: () => Date.parse("2026-08-30T08:00:00.000Z"),
      resolveTargetVersion: async () => {
        checks += 1;
        return "0.1.9";
      },
      installVersion: async () => {
        installs += 1;
        return true;
      },
      reconcile: async () => {
        reconciles += 1;
        return true;
      },
    });
    const throttled = await api.runAutomaticUpdateCore({
      memoraxCodeHome,
      installedVersion: "0.1.9",
      completedByVersion: "0.1.9",
      channel: "latest",
      now: () => Date.parse("2026-08-30T15:59:59.000Z"),
      resolveTargetVersion: async () => {
        checks += 1;
        return "0.1.10";
      },
      installVersion: async () => {
        installs += 1;
        return true;
      },
      reconcile: async () => {
        reconciles += 1;
        return true;
      },
    });

    assert.equal(first.disposition, "up-to-date");
    assert.equal(throttled.disposition, "throttled");
    assert.equal(checks, 1);
    assert.equal(installs, 0);
    assert.equal(reconciles, 0);
    const state = JSON.parse(await readFile(api.automaticUpdateStatePath(memoraxCodeHome), "utf8"));
    assert.equal(state.outcome, "up-to-date");
    assert.equal(state.nextCheckAt, "2026-08-30T16:00:00.000Z");
  } finally {
    await rm(fixtureRoot.root, { recursive: true, force: true });
  }
});

test("automatic update installs an exact target and reconciles configured clients", async () => {
  const fixtureRoot = await fixture();
  const { memoraxCodeHome, api } = fixtureRoot;
  const calls = [];
  try {
    const result = await api.runAutomaticUpdateCore({
      memoraxCodeHome,
      installedVersion: "0.1.9",
      completedByVersion: "0.1.9",
      channel: "latest",
      now: () => Date.parse("2026-08-30T08:00:00.000Z"),
      resolveTargetVersion: async (channel) => {
        calls.push(["check", channel]);
        return "0.1.10";
      },
      installVersion: async (targetVersion) => {
        calls.push(["install", targetVersion]);
        return true;
      },
      reconcile: async (installedVersion) => {
        calls.push(["reconcile", installedVersion]);
        return true;
      },
    });

    assert.equal(result.disposition, "updated");
    assert.deepEqual(calls, [
      ["check", "latest"],
      ["install", "0.1.10"],
      ["reconcile", "0.1.10"],
    ]);
    const state = JSON.parse(await readFile(api.automaticUpdateStatePath(memoraxCodeHome), "utf8"));
    assert.equal(state.installedVersion, "0.1.10");
    assert.equal(state.targetVersion, "0.1.10");
    assert.equal(state.outcome, "updated");
  } finally {
    await rm(fixtureRoot.root, { recursive: true, force: true });
  }
});

test("automatic update retries failures after fifteen minutes and repairs stale setup", async () => {
  const fixtureRoot = await fixture();
  const { memoraxCodeHome, api } = fixtureRoot;
  let checks = 0;
  let reconciles = 0;
  try {
    const failed = await api.runAutomaticUpdateCore({
      memoraxCodeHome,
      installedVersion: "0.1.10",
      completedByVersion: "0.1.9",
      channel: "latest",
      now: () => Date.parse("2026-08-30T08:00:00.000Z"),
      resolveTargetVersion: async () => {
        checks += 1;
        throw new Error("registry unavailable");
      },
      installVersion: async () => true,
      reconcile: async () => true,
    });
    const throttled = await api.runAutomaticUpdateCore({
      memoraxCodeHome,
      installedVersion: "0.1.10",
      completedByVersion: "0.1.9",
      channel: "latest",
      now: () => Date.parse("2026-08-30T08:14:59.000Z"),
      resolveTargetVersion: async () => {
        checks += 1;
        return "0.1.10";
      },
      installVersion: async () => true,
      reconcile: async () => {
        reconciles += 1;
        return true;
      },
    });
    const repaired = await api.runAutomaticUpdateCore({
      memoraxCodeHome,
      installedVersion: "0.1.10",
      completedByVersion: "0.1.9",
      channel: "latest",
      now: () => Date.parse("2026-08-30T08:15:00.000Z"),
      resolveTargetVersion: async () => {
        checks += 1;
        return "0.1.10";
      },
      installVersion: async () => true,
      reconcile: async () => {
        reconciles += 1;
        return true;
      },
    });

    assert.equal(failed.disposition, "failed");
    assert.equal(failed.reason, "check_failed");
    assert.equal(throttled.disposition, "throttled");
    assert.equal(repaired.disposition, "reconciled");
    assert.equal(checks, 2);
    assert.equal(reconciles, 1);
  } finally {
    await rm(fixtureRoot.root, { recursive: true, force: true });
  }
});
