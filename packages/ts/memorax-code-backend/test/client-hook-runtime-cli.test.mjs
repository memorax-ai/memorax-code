import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  activateClientHookRuntimeGeneration,
  stageClientHookRuntimeGeneration,
} from "../../memorax-code-adapter-common/src/hooks/hook-runtime-generation.mjs";
import { startMemoraxCodeService } from "../dist/lifecycle/orchestrator.js";
import { freePort } from "./helpers.mjs";

const cliPath = fileURLToPath(new URL("../dist/memorax-code.js", import.meta.url));

test("start activates its pending Hook generation for an inline MemoraX Code home", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-cli-start-"));
  const home = join(root, "home");
  const packageRoot = join(root, "package");
  const port = await freePort();
  try {
    await writeRuntimePackage(packageRoot, "1.0.0", "generation-b");
    const generation = stageClientHookRuntimeGeneration({ packageRoot, memoraxCodeHome: home });

    const started = await runCli([
      "start",
      "--json",
      `--home=${home}`,
      `--port=${port}`,
      "--clients",
      "none",
    ], {
      MEMORAX_CODE_PENDING_CLIENT_HOOK_RUNTIME_V1: pendingRuntime(home, generation),
    });

    assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`);
    assert.equal(await currentGenerationId(home), generation.generationId);
  } finally {
    await runCli(["stop", "--json", "--home", home, "--port", String(port), "--clients", "none"]);
    await rm(root, { recursive: true, force: true });
  }
});

test("restart activates its pending Hook generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-cli-restart-"));
  const home = join(root, "home");
  const packageRoot = join(root, "package");
  const port = await freePort();
  try {
    await writeRuntimePackage(packageRoot, "1.0.0", "generation-a");
    const generationA = stageClientHookRuntimeGeneration({ packageRoot, memoraxCodeHome: home });
    activateClientHookRuntimeGeneration({ memoraxCodeHome: home, generation: generationA });
    const started = await runCli([
      "start",
      "--json",
      "--home",
      home,
      "--port",
      String(port),
      "--clients",
      "none",
    ]);
    assert.equal(started.code, 0, `${started.stdout}\n${started.stderr}`);

    await writeRuntimePackage(packageRoot, "1.0.1", "generation-b");
    const generationB = stageClientHookRuntimeGeneration({ packageRoot, memoraxCodeHome: home });
    const restarted = await runCli([
      "restart",
      "--json",
      "--home",
      home,
      "--port",
      String(port),
      "--clients",
      "none",
    ], {
      MEMORAX_CODE_PENDING_CLIENT_HOOK_RUNTIME_V1: pendingRuntime(home, generationB),
    });

    assert.equal(restarted.code, 0, `${restarted.stdout}\n${restarted.stderr}`);
    assert.equal(await currentGenerationId(home), generationB.generationId);
  } finally {
    await runCli(["stop", "--json", "--home", home, "--port", String(port), "--clients", "none"]);
    await rm(root, { recursive: true, force: true });
  }
});

test("failed lifecycle and failed activation both preserve the current Hook generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-cli-failure-"));
  const packageRoot = join(root, "package");
  const invalidHome = join(root, "invalid-home");
  const corruptHome = join(root, "corrupt-home");
  const port = await freePort();
  try {
    await writeRuntimePackage(packageRoot, "1.0.0", "generation-a");
    const invalidA = stageClientHookRuntimeGeneration({
      packageRoot,
      memoraxCodeHome: invalidHome,
    });
    activateClientHookRuntimeGeneration({ memoraxCodeHome: invalidHome, generation: invalidA });
    await writeRuntimePackage(packageRoot, "1.0.1", "generation-b");
    const invalidB = stageClientHookRuntimeGeneration({
      packageRoot,
      memoraxCodeHome: invalidHome,
    });
    await mkdir(join(invalidHome, "runtime", "backend"), { recursive: true });
    await writeFile(
      join(invalidHome, "runtime", "backend", "backend-connection.json"),
      "{not-json\n",
    );

    const failedLifecycle = await runCli([
      "start",
      "--json",
      "--home",
      invalidHome,
      "--clients",
      "none",
    ], {
      MEMORAX_CODE_PENDING_CLIENT_HOOK_RUNTIME_V1: pendingRuntime(invalidHome, invalidB),
    });
    assert.equal(failedLifecycle.code, 1, failedLifecycle.stderr);
    assert.equal(await currentGenerationId(invalidHome), invalidA.generationId);

    await writeRuntimePackage(packageRoot, "2.0.0", "generation-a");
    const corruptA = stageClientHookRuntimeGeneration({
      packageRoot,
      memoraxCodeHome: corruptHome,
    });
    activateClientHookRuntimeGeneration({ memoraxCodeHome: corruptHome, generation: corruptA });
    await writeRuntimePackage(packageRoot, "2.0.1", "generation-b");
    const corruptB = stageClientHookRuntimeGeneration({
      packageRoot,
      memoraxCodeHome: corruptHome,
    });
    await rm(join(corruptB.generationPath, "generation.json"));

    const failedActivation = await runCli([
      "start",
      "--json",
      "--home",
      corruptHome,
      "--port",
      String(port),
      "--clients",
      "none",
    ], {
      MEMORAX_CODE_PENDING_CLIENT_HOOK_RUNTIME_V1: pendingRuntime(corruptHome, corruptB),
    });
    assert.equal(failedActivation.code, 1);
    assert.match(failedActivation.stderr, /client Hook runtime activation failed:/);
    assert.equal(await currentGenerationId(corruptHome), corruptA.generationId);
  } finally {
    await runCli(["stop", "--json", "--home", corruptHome, "--port", String(port), "--clients", "none"]);
    await rm(root, { recursive: true, force: true });
  }
});

test("non-lifecycle commands ignore pending Hook runtime input", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-cli-ignore-"));
  const home = join(root, "home");
  try {
    const status = await runCli(["status", "--json", "--home", home, "--clients", "none"], {
      MEMORAX_CODE_PENDING_CLIENT_HOOK_RUNTIME_V1: "{malformed",
    });
    assert.doesNotMatch(`${status.stdout}\n${status.stderr}`, /pending client Hook runtime/);

    const stopped = await runCli(["stop", "--json", "--home", home, "--clients", "none"], {
      MEMORAX_CODE_PENDING_CLIENT_HOOK_RUNTIME_V1: "{malformed",
    });
    assert.equal(stopped.code, 0, `${stopped.stdout}\n${stopped.stderr}`);
    assert.doesNotMatch(`${stopped.stdout}\n${stopped.stderr}`, /pending client Hook runtime/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ready-state commits remain ordered inside the lifecycle lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-lifecycle-commit-"));
  const home = join(root, "home");
  const port = await freePort();
  const argv = ["node", "memorax-code", "start", "--clients", "none"];
  const commits = [];
  let releaseFirstCommit;
  let markFirstCommitEntered;
  const firstCommitEntered = new Promise((resolve) => {
    markFirstCommitEntered = resolve;
  });
  const holdFirstCommit = new Promise((resolve) => {
    releaseFirstCommit = resolve;
  });
  try {
    const first = startMemoraxCodeService({ home, port }, argv, async () => {
      commits.push("B:entered");
      markFirstCommitEntered();
      await holdFirstCommit;
      commits.push("B:committed");
    });
    await firstCommitEntered;

    const second = startMemoraxCodeService({ home, port }, argv, () => {
      commits.push("C:committed");
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(commits, ["B:entered"]);

    releaseFirstCommit();
    const [firstReport, secondReport] = await Promise.all([first, second]);
    assert.equal(firstReport.ok, true);
    assert.equal(secondReport.ok, true);
    assert.deepEqual(commits, ["B:entered", "B:committed", "C:committed"]);
  } finally {
    releaseFirstCommit?.();
    await runCli(["stop", "--json", "--home", home, "--port", String(port), "--clients", "none"]);
    await rm(root, { recursive: true, force: true });
  }
});

function pendingRuntime(memoraxCodeHome, generation) {
  return JSON.stringify({
    version: 1,
    memoraxCodeHome,
    generation: {
      version: generation.version,
      runtimeAbi: generation.runtimeAbi,
      generationId: generation.generationId,
      packageVersion: generation.packageVersion,
      contentDigest: generation.contentDigest,
      createdAt: generation.createdAt,
    },
  });
}

async function currentGenerationId(home) {
  const current = JSON.parse(await readFile(
    join(home, "runtime", "client-hooks", "current.json"),
    "utf8",
  ));
  return current.generationId;
}

function runCli(args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function writeRuntimePackage(packageRoot, version, marker) {
  await rm(packageRoot, { recursive: true, force: true });
  await mkdir(packageRoot, { recursive: true });
  await writeFile(join(packageRoot, "package.json"), `${JSON.stringify({
    name: "@example/memorax-code",
    version,
  })}\n`);
  for (const relativePath of [
    "lib/memorax-code-adapter-common/src",
    "lib/memorax-code-codex-adapter/src",
    "lib/memorax-code-codex-adapter/runtime-hooks",
    "lib/memorax-code-claude-adapter/src",
    "lib/memorax-code-claude-adapter/runtime-hooks",
  ]) {
    const directory = join(packageRoot, ...relativePath.split("/"));
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "fixture.mjs"),
      `export const marker = ${JSON.stringify(marker)};\n`,
    );
  }
  for (const [adapter, components] of Object.entries({
    "memorax-code-codex-adapter": [
      "capture-cwd",
      "ensure-backend",
      "memory-skill-reminder",
      "memory-writeback",
    ],
    "memorax-code-claude-adapter": [
      "capture-cwd",
      "ensure-backend",
      "memory-cli-session",
      "memory-skill-reminder",
      "memory-turn",
    ],
  })) {
    for (const component of components) {
      await writeFile(
        join(packageRoot, "lib", adapter, "runtime-hooks", `${component}.mjs`),
        `export const marker = ${JSON.stringify(`${marker}:${component}`)};\n`,
      );
    }
  }
}
