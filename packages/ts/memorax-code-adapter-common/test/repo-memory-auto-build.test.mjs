import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { sharedRepoMemoryPath } from "../src/repo-memory/repo-memory-shared-bundle.mjs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { scheduleMissingRepoMemoryBuild } from "../src/repo-memory/repo-memory-auto-build.mjs";

test("Repo Memory auto-build schedules maintain only when the shared baseline is missing, independently of local PROFILE", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-repo-auto-build-"));
  const repo = join(root, "repo");
  const pluginRoot = join(root, "plugin");
  const logPath = join(root, "job.json");
  const memoraxCodeHome = join(root, "memorax-code");
  const env = { ...process.env, MEMORAX_CODE_HOME: relative(process.cwd(), memoraxCodeHome) };
  try {
    await Promise.all([
      mkdir(repo, { recursive: true }),
      mkdir(join(pluginRoot, "hooks"), { recursive: true }),
    ]);
    await writeFile(join(pluginRoot, "hooks", "repo-memory-job.mjs"), [
      'import { writeFileSync } from "node:fs";',
      `writeFileSync(${JSON.stringify(logPath)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), home: process.env.MEMORAX_CODE_HOME }));`,
      "",
    ].join("\n"));

    const initialized = spawnSync("git", ["init", repo], { encoding: "utf8" });
    assert.equal(initialized.status, 0, initialized.stderr);
    await mkdir(join(repo, ".repo_memory"), { recursive: true });
    await writeFile(join(repo, ".repo_memory", "PROFILE.md"), "# Local Memory\n");
    assert.equal(scheduleMissingRepoMemoryBuild(repo, { pluginRoot, env }), true);
    const invocation = JSON.parse(await waitForFile(logPath));
    assert.deepEqual(invocation, {
      args: ["maintain", "--repo", repo],
      cwd: await realpath(repo),
      home: memoraxCodeHome,
    });
    assert.equal(env.MEMORAX_CODE_HOME, relative(process.cwd(), memoraxCodeHome));

    const shared = sharedRepoMemoryPath(memoraxCodeHome, repo);
    await mkdir(shared, { recursive: true });
    await writeFile(join(shared, "baseline.json"), "{}");
    assert.equal(scheduleMissingRepoMemoryBuild(repo, { pluginRoot, env }), false);
    assert.equal(scheduleMissingRepoMemoryBuild(undefined, { pluginRoot }), false);
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
