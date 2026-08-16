import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { scheduleMissingRepoMemoryBuild } from "../../memorax-code-adapter-common/src/repo-memory/repo-memory-auto-build.mjs";

test("Repo Memory auto-build schedules maintain only when PROFILE.md is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-repo-auto-build-"));
  const repo = join(root, "repo");
  const pluginRoot = join(root, "plugin");
  const logPath = join(root, "job.json");
  try {
    await Promise.all([
      mkdir(repo, { recursive: true }),
      mkdir(join(pluginRoot, "hooks"), { recursive: true }),
    ]);
    await writeFile(join(pluginRoot, "hooks", "repo-memory-job.mjs"), [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));`,
      "",
    ].join("\n"));

    assert.equal(scheduleMissingRepoMemoryBuild(repo, { pluginRoot }), true);
    const invocation = JSON.parse(await waitForFile(logPath));
    assert.deepEqual(invocation, {
      args: ["maintain", "--repo", repo],
      cwd: await realpath(repo),
    });

    await mkdir(join(repo, ".repo_memory"), { recursive: true });
    await writeFile(join(repo, ".repo_memory", "PROFILE.md"), "# Repo Memory\n");
    assert.equal(scheduleMissingRepoMemoryBuild(repo, { pluginRoot }), false);
    assert.equal(scheduleMissingRepoMemoryBuild(undefined, { pluginRoot }), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Repo Memory auto-build forwards an explicit child environment", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-repo-auto-build-env-"));
  const repo = join(root, "repo");
  const pluginRoot = join(root, "plugin");
  const logPath = join(root, "job.json");
  const memoraxCodeHome = join(root, "memorax-code-home");
  try {
    await Promise.all([
      mkdir(repo, { recursive: true }),
      mkdir(join(pluginRoot, "hooks"), { recursive: true }),
    ]);
    await writeFile(join(pluginRoot, "hooks", "repo-memory-job.mjs"), [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(logPath)}, JSON.stringify({ memoraxCodeHome: process.env.MEMORAX_CODE_HOME }));`,
      "",
    ].join("\n"));

    assert.equal(scheduleMissingRepoMemoryBuild(repo, {
      pluginRoot,
      env: { ...process.env, MEMORAX_CODE_HOME: memoraxCodeHome },
    }), true);
    assert.deepEqual(JSON.parse(await waitForFile(logPath)), { memoraxCodeHome });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function waitForFile(path) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`timed out waiting for ${path}`);
}
