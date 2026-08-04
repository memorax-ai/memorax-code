import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  activateClientHookRuntimeGeneration,
  clientHookRuntimePaths,
  readCurrentClientHookRuntime,
  stageClientHookRuntimeGeneration,
} from "../../memorax-code-adapter-common/src/hooks/hook-runtime-generation.mjs";
import { selectHookRuntime } from "../../memorax-code-adapter-common/src/hooks/client-hook-launcher.mjs";

const TEST_SHELL_VERSION = "1.2.3";

test("client Hook generations stage immutably and activate atomically", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-generation-"));
  try {
    const packageRoot = join(root, "package");
    const memoraxCodeHome = join(root, "home");
    await writeRuntimePackage(packageRoot, "1.2.3", "generation-a");

    const first = stageClientHookRuntimeGeneration({ packageRoot, memoraxCodeHome });
    const repeated = stageClientHookRuntimeGeneration({ packageRoot, memoraxCodeHome });
    assert.equal(repeated.generationId, first.generationId);
    assert.equal(repeated.reused, true);

    const activated = activateClientHookRuntimeGeneration({
      memoraxCodeHome,
      generation: first,
    });
    assert.equal(activated.generationId, first.generationId);
    const current = readCurrentClientHookRuntime(memoraxCodeHome);
    assert.equal(current.status, "valid");
    assert.equal(current.record.generationId, first.generationId);
    assert.equal(
      JSON.parse(await readFile(join(first.generationPath, "generation.json"), "utf8")).contentDigest,
      first.contentDigest,
    );
    assert.equal(
      (await readFile(join(
        first.generationPath,
        "lib",
        "memorax-code-adapter-common",
        "src",
        "repo-memory",
        "repo-memory-auto-build.mjs",
      ), "utf8")).includes("generation-a:repo-memory-auto-build"),
      true,
    );

    await writeRuntimePackage(packageRoot, "1.2.3", "generation-b");
    const second = stageClientHookRuntimeGeneration({ packageRoot, memoraxCodeHome });
    assert.notEqual(second.generationId, first.generationId);
    assert.equal((await readFile(
      join(first.generationPath, "lib", "memorax-code-codex-adapter", "runtime-hooks", "capture-cwd.mjs"),
      "utf8",
    )).includes("generation-a"), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("turn pin keeps Stop and compact on A while the next turn selects B", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-pin-"));
  try {
    const packageRoot = join(root, "package");
    const memoraxCodeHome = join(root, "home");
    const pluginRoot = join(root, "plugin");
    const fallbackPath = join(pluginRoot, "runtime-hooks", "capture-cwd.mjs");
    await mkdir(join(pluginRoot, "runtime-hooks"), { recursive: true });
    await writeFile(fallbackPath, "export const fallback = true;\n");
    await writeRuntimePackage(packageRoot, "1.0.0", "generation-a");
    const generationA = stageClientHookRuntimeGeneration({ packageRoot, memoraxCodeHome });
    activateClientHookRuntimeGeneration({ memoraxCodeHome, generation: generationA });

    const firstTurn = selection({
      memoraxCodeHome,
      pluginRoot,
      fallbackPath,
      input: hookInput("UserPromptSubmit", "turn-a"),
    });
    assert.equal(firstTurn.generationId, generationA.generationId);

    await writeRuntimePackage(packageRoot, "1.0.1", "generation-b");
    const generationB = stageClientHookRuntimeGeneration({ packageRoot, memoraxCodeHome });
    activateClientHookRuntimeGeneration({ memoraxCodeHome, generation: generationB });

    const stop = selection({
      memoraxCodeHome,
      pluginRoot,
      fallbackPath,
      input: hookInput("Stop", "turn-a"),
    });
    assert.equal(stop.generationId, generationA.generationId);

    const compact = selection({
      memoraxCodeHome,
      pluginRoot,
      fallbackPath,
      input: {
        hook_event_name: "SessionStart",
        source: "compact",
        session_id: "session-a",
      },
    });
    assert.equal(compact.generationId, generationA.generationId);

    const secondTurn = selection({
      memoraxCodeHome,
      pluginRoot,
      fallbackPath,
      input: hookInput("UserPromptSubmit", "turn-b"),
    });
    assert.equal(secondTurn.generationId, generationB.generationId);
    assert.equal(selection({
      memoraxCodeHome,
      pluginRoot,
      fallbackPath,
      input: hookInput("Stop", "unseen-turn"),
    }), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("exact-turn events fail closed when their identity or active pin is missing", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-missing-identity-"));
  try {
    const memoraxCodeHome = join(root, "home");
    const pluginRoot = join(root, "plugin");
    const fallbackPath = join(pluginRoot, "runtime-hooks", "capture-cwd.mjs");
    await mkdir(join(pluginRoot, "runtime-hooks"), { recursive: true });
    await writeFile(fallbackPath, "export const fallback = true;\n");

    assert.equal(selection({
      memoraxCodeHome,
      pluginRoot,
      fallbackPath,
      input: {},
    }), undefined);
    assert.equal(selection({
      memoraxCodeHome,
      pluginRoot,
      fallbackPath,
      input: {
        hook_event_name: "UnknownEvent",
        session_id: "session-a",
        turn_id: "turn-a",
      },
    }), undefined);
    assert.equal(selection({
      memoraxCodeHome,
      pluginRoot,
      fallbackPath,
      input: {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-a",
      },
    }), undefined);
    assert.equal(selection({
      memoraxCodeHome,
      pluginRoot,
      fallbackPath,
      input: {
        hook_event_name: "UserPromptSubmit",
        turn_id: "turn-a",
      },
    }), undefined);
    assert.equal(selection({
      memoraxCodeHome,
      pluginRoot,
      fallbackPath,
      input: {
        hook_event_name: "SessionStart",
        source: "compact",
      },
    }), undefined);
    assert.equal(selection({
      memoraxCodeHome,
      pluginRoot,
      fallbackPath,
      input: {
        hook_event_name: "SessionStart",
        source: "compact",
        session_id: "session-a",
      },
    }), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an exact-turn pin never switches generation when its runtime becomes unavailable", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-unavailable-pin-"));
  try {
    const packageRoot = join(root, "package");
    const memoraxCodeHome = join(root, "home");
    const pluginRoot = join(root, "plugin");
    const fallbackPath = join(pluginRoot, "runtime-hooks", "capture-cwd.mjs");
    await mkdir(join(pluginRoot, "runtime-hooks"), { recursive: true });
    await writeFile(fallbackPath, "export const fallback = true;\n");
    await writeRuntimePackage(packageRoot, "1.0.0", "generation-a");
    const generationA = stageClientHookRuntimeGeneration({ packageRoot, memoraxCodeHome });
    activateClientHookRuntimeGeneration({ memoraxCodeHome, generation: generationA });
    assert.equal(selection({
      memoraxCodeHome,
      pluginRoot,
      fallbackPath,
      input: hookInput("UserPromptSubmit", "turn-a"),
    }).generationId, generationA.generationId);

    await writeRuntimePackage(packageRoot, "1.0.1", "generation-b");
    const generationB = stageClientHookRuntimeGeneration({ packageRoot, memoraxCodeHome });
    activateClientHookRuntimeGeneration({ memoraxCodeHome, generation: generationB });
    await rm(generationA.generationPath, { recursive: true, force: true });

    assert.equal(selection({
      memoraxCodeHome,
      pluginRoot,
      fallbackPath,
      input: hookInput("UserPromptSubmit", "turn-a"),
    }), undefined);
    const pin = JSON.parse(await readFile(turnPinPath(memoraxCodeHome), "utf8"));
    assert.equal(pin.generationId, generationA.generationId);

    assert.equal(selection({
      memoraxCodeHome,
      pluginRoot,
      fallbackPath,
      input: hookInput("UserPromptSubmit", "turn-b"),
    }).generationId, generationB.generationId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("an invalid turn pin is not replaced by the active generation", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-invalid-pin-"));
  try {
    const packageRoot = join(root, "package");
    const memoraxCodeHome = join(root, "home");
    const pluginRoot = join(root, "plugin");
    const fallbackPath = join(pluginRoot, "runtime-hooks", "capture-cwd.mjs");
    await mkdir(join(pluginRoot, "runtime-hooks"), { recursive: true });
    await writeFile(fallbackPath, "export const fallback = true;\n");
    await writeRuntimePackage(packageRoot, "1.0.0", "generation-a");
    const generationA = stageClientHookRuntimeGeneration({ packageRoot, memoraxCodeHome });
    activateClientHookRuntimeGeneration({ memoraxCodeHome, generation: generationA });
    const path = turnPinPath(memoraxCodeHome);
    await mkdir(join(clientHookRuntimePaths(memoraxCodeHome).root, "pins", "codex"), {
      recursive: true,
    });
    const invalid = '{"version":1,"runtimeAbi":1,"client":"codex"}\n';
    await writeFile(path, invalid);

    assert.equal(selection({
      memoraxCodeHome,
      pluginRoot,
      fallbackPath,
      input: hookInput("UserPromptSubmit", "turn-a"),
    }), undefined);
    assert.equal(await readFile(path, "utf8"), invalid);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid authority falls back only for turn start and never invents a Stop pin", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-fallback-"));
  try {
    const memoraxCodeHome = join(root, "home");
    const pluginRoot = join(root, "plugin");
    const fallbackPath = join(pluginRoot, "runtime-hooks", "capture-cwd.mjs");
    await mkdir(join(pluginRoot, "runtime-hooks"), { recursive: true });
    await writeFile(fallbackPath, "export const fallback = true;\n");
    const paths = clientHookRuntimePaths(memoraxCodeHome);
    await mkdir(join(paths.root), { recursive: true });
    await writeFile(paths.currentPath, '{"version":1,"generationId":"../escape"}\n');

    const start = selection({
      memoraxCodeHome,
      pluginRoot,
      fallbackPath,
      input: hookInput("UserPromptSubmit", "turn-a"),
    });
    assert.equal(start.generationSource, "bundled");
    assert.equal(start.generationId, `shell-${TEST_SHELL_VERSION}`);

    const missingStop = selection({
      memoraxCodeHome,
      pluginRoot,
      fallbackPath,
      input: hookInput("Stop", "turn-b"),
    });
    assert.equal(missingStop, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generation staging rejects symbolic links before changing current authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-generation-symlink-"));
  try {
    const packageRoot = join(root, "package");
    const memoraxCodeHome = join(root, "home");
    await writeRuntimePackage(packageRoot, "1.0.0", "safe");
    const target = join(packageRoot, "outside.mjs");
    const linked = join(
      packageRoot,
      "lib",
      "memorax-code-codex-adapter",
      "runtime-hooks",
      "capture-cwd.mjs",
    );
    await writeFile(target, "export const escaped = true;\n");
    await rm(linked);
    await symlink(target, linked);

    assert.throws(
      () => stageClientHookRuntimeGeneration({ packageRoot, memoraxCodeHome }),
      /symbolic link/,
    );
    assert.equal(readCurrentClientHookRuntime(memoraxCodeHome).status, "absent");
  } finally {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("generation staging rejects a symbolic link in the source path ancestry", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-generation-parent-symlink-"));
  try {
    const packageRoot = join(root, "package");
    const memoraxCodeHome = join(root, "home");
    const externalLib = join(root, "external-lib");
    await writeRuntimePackage(packageRoot, "1.0.0", "safe");
    await rename(join(packageRoot, "lib"), externalLib);
    await symlink(
      externalLib,
      join(packageRoot, "lib"),
      process.platform === "win32" ? "junction" : "dir",
    );

    assert.throws(
      () => stageClientHookRuntimeGeneration({ packageRoot, memoraxCodeHome }),
      /source is not a regular directory/,
    );
    assert.equal(readCurrentClientHookRuntime(memoraxCodeHome).status, "absent");
  } finally {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

test("generation identity distinguishes versions that share a safe path prefix", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-generation-version-"));
  try {
    const packageRoot = join(root, "package");
    const memoraxCodeHome = join(root, "home");
    await writeRuntimePackage(packageRoot, "1.0.0+a", "same-content");
    const first = stageClientHookRuntimeGeneration({ packageRoot, memoraxCodeHome });
    await writeFile(join(packageRoot, "package.json"), `${JSON.stringify({
      name: "@example/memorax-code",
      version: "1.0.0-a",
    })}\n`);
    const second = stageClientHookRuntimeGeneration({ packageRoot, memoraxCodeHome });

    assert.notEqual(second.generationId, first.generationId);
    assert.equal(second.contentDigest, first.contentDigest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generation staging syncs copied files and nested directories before publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-generation-sync-"));
  try {
    const packageRoot = join(root, "package");
    const memoraxCodeHome = join(root, "home");
    const syncedFiles = [];
    const syncedDirectories = [];
    await writeRuntimePackage(packageRoot, "1.0.0", "durable");

    stageClientHookRuntimeGeneration({
      packageRoot,
      memoraxCodeHome,
      syncFile(path) {
        syncedFiles.push(path);
      },
      syncDirectory(path) {
        syncedDirectories.push(path);
      },
    });
    assert.ok(syncedFiles.some((path) => path.endsWith("generation.json")));
    assert.ok(syncedFiles.some((path) => path.endsWith(join(
      "lib",
      "memorax-code-codex-adapter",
      "runtime-hooks",
      "memory-writeback.mjs",
    ))));
    assert.ok(syncedFiles.some((path) => path.endsWith(join(
      "lib",
      "memorax-code-claude-adapter",
      "runtime-hooks",
      "memory-turn.mjs",
    ))));
    assert.ok(syncedDirectories.some((path) => path.endsWith(join(
      "memorax-code-codex-adapter",
      "runtime-hooks",
    ))));
    assert.equal(syncedDirectories.at(-1), clientHookRuntimePaths(memoraxCodeHome).generationsRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generation staging rejects a package missing a required Hook component", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-generation-component-"));
  try {
    const packageRoot = join(root, "package");
    const memoraxCodeHome = join(root, "home");
    await writeRuntimePackage(packageRoot, "1.0.0", "incomplete");
    await rm(join(
      packageRoot,
      "lib",
      "memorax-code-claude-adapter",
      "runtime-hooks",
      "memory-turn.mjs",
    ));

    assert.throws(
      () => stageClientHookRuntimeGeneration({ packageRoot, memoraxCodeHome }),
      /missing runtime component: claude-code\/memory-turn/,
    );
    assert.equal(readCurrentClientHookRuntime(memoraxCodeHome).status, "absent");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("generation authority rejects dot-segment identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-hook-generation-dot-segment-"));
  try {
    const memoraxCodeHome = join(root, "home");
    const paths = clientHookRuntimePaths(memoraxCodeHome);
    await mkdir(paths.root, { recursive: true });
    await writeFile(paths.currentPath, `${JSON.stringify({
      version: 1,
      runtimeAbi: 1,
      generationId: "..",
      packageVersion: "1.0.0",
      contentDigest: "a".repeat(64),
      activatedAt: new Date().toISOString(),
    })}\n`);

    assert.deepEqual(readCurrentClientHookRuntime(memoraxCodeHome), {
      status: "invalid",
      reason: "invalid_generation_id",
    });
    assert.equal(selectHookRuntime({
      client: "codex",
      component: "capture-cwd",
      fallbackModuleUrl: pathToFileURL(join(root, "fallback.mjs")),
      memoraxCodeHome,
      input: hookInput("Stop", "turn-a"),
      pluginRoot: root,
      shellVersion: TEST_SHELL_VERSION,
    }), undefined);
    assert.throws(
      () => activateClientHookRuntimeGeneration({
        memoraxCodeHome,
        generation: {
          version: 1,
          runtimeAbi: 1,
          generationId: "..",
          packageVersion: "1.0.0",
          contentDigest: "a".repeat(64),
          createdAt: new Date().toISOString(),
        },
      }),
      /generation ID is invalid/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function selection({ memoraxCodeHome, pluginRoot, fallbackPath, input }) {
  return selectHookRuntime({
    client: "codex",
    component: "capture-cwd",
    fallbackModuleUrl: pathToFileURL(fallbackPath),
    memoraxCodeHome,
    input,
    pluginRoot,
    shellVersion: TEST_SHELL_VERSION,
  });
}

function hookInput(event, turnId) {
  return {
    hook_event_name: event,
    session_id: "session-a",
    turn_id: turnId,
    transcript_path: "/tmp/session-a.jsonl",
  };
}

function turnPinPath(memoraxCodeHome) {
  const sessionKey = createHash("sha256").update("session-a").digest("hex");
  return join(
    clientHookRuntimePaths(memoraxCodeHome).root,
    "pins",
    "codex",
    `${sessionKey}.json`,
  );
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
    await mkdir(join(packageRoot, ...relativePath.split("/")), { recursive: true });
    await writeFile(
      join(packageRoot, ...relativePath.split("/"), "fixture.mjs"),
      `export const marker = ${JSON.stringify(marker)};\n`,
    );
  }
  await mkdir(join(
    packageRoot,
    "lib",
    "memorax-code-adapter-common",
    "src",
    "repo-memory",
  ), { recursive: true });
  await writeFile(
    join(
      packageRoot,
      "lib",
      "memorax-code-adapter-common",
      "src",
      "repo-memory",
      "repo-memory-auto-build.mjs",
    ),
    `export const marker = ${JSON.stringify(`${marker}:repo-memory-auto-build`)};\n`,
  );
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
