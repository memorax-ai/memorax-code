import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const checker = fileURLToPath(new URL("./check-local-trace-only.mjs", import.meta.url));

test("local-only trace gate accepts a clean artifact", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-local-trace-clean-"));
  try {
    await writeFile(join(root, "trace-store.js"), "export const localTrace = true;\n");
    const result = await runChecker(root);
    assert.equal(result.code, 0, result.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local-only trace gate scans untracked provider transport consumers", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-local-trace-source-"));
  const scriptsDir = join(root, "scripts");
  const copiedChecker = join(scriptsDir, "check-local-trace-only.mjs");
  const sourceDir = join(root, "packages", "ts", "memorax-code-backend", "src");
  try {
    await mkdir(scriptsDir, { recursive: true });
    await mkdir(sourceDir, { recursive: true });
    await mkdir(join(sourceDir, "memory"), { recursive: true });
    await copyFile(checker, copiedChecker);
    const initialized = spawnSync("git", ["init", "--quiet"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(initialized.status, 0, initialized.stderr);
    await writeFile(
      join(sourceDir, "memory", "unreviewed-provider-client.ts"),
      [
        'import { callMemoAdd } from "../provider/memorax/adapter.js";',
        "export const send = callMemoAdd;",
        "",
      ].join("\n"),
    );

    const result = await runChecker(undefined, copiedChecker);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /unreviewed-provider-client\.ts: undeclared network-capable production module/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local-only trace gate rejects same-directory provider transport bridges", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-local-trace-provider-sibling-"));
  const scriptsDir = join(root, "scripts");
  const copiedChecker = join(scriptsDir, "check-local-trace-only.mjs");
  const providerDir = join(
    root,
    "packages",
    "ts",
    "memorax-code-backend",
    "src",
    "provider",
    "memorax",
  );
  try {
    await mkdir(scriptsDir, { recursive: true });
    await mkdir(providerDir, { recursive: true });
    await copyFile(checker, copiedChecker);
    const initialized = spawnSync("git", ["init", "--quiet"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(initialized.status, 0, initialized.stderr);
    await writeFile(join(providerDir, "unreviewed-trace-bridge.ts"), [
      'import { postMemoraxJson } from "./http.js";',
      'import { readCurrentTraceTurn } from "../../trace/store.js";',
      "export async function publish(value) {",
      "  const turn = readCurrentTraceTurn();",
      "  return await postMemoraxJson('/v1/events', { turn, value });",
      "}",
      "",
    ].join("\n"));

    const result = await runChecker(undefined, copiedChecker);
    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      /provider\/memorax\/unreviewed-trace-bridge\.ts: undeclared network-capable production module \(provider transport import\)/,
    );
    assert.match(
      result.stderr,
      /provider\/memorax\/unreviewed-trace-bridge\.ts: unreviewed trace-aware outbound bridge/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local-only trace gate does not grant runtime network authority to lifecycle contracts", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-local-trace-contracts-network-"));
  const scriptsDir = join(root, "scripts");
  const copiedChecker = join(scriptsDir, "check-local-trace-only.mjs");
  const lifecycleDir = join(
    root,
    "packages",
    "ts",
    "memorax-code-backend",
    "src",
    "lifecycle",
  );
  try {
    await mkdir(scriptsDir, { recursive: true });
    await mkdir(lifecycleDir, { recursive: true });
    await copyFile(checker, copiedChecker);
    const initialized = spawnSync("git", ["init", "--quiet"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(initialized.status, 0, initialized.stderr);
    await writeFile(join(lifecycleDir, "contracts.ts"), [
      "export type Runtime = {",
      "  fetch?: typeof fetch;",
      "};",
      "export async function publish() {",
      "  return await fetch('https://collector.example/v1/events');",
      "}",
      "",
    ].join("\n"));

    const result = await runChecker(undefined, copiedChecker);
    assert.equal(result.code, 1);
    assert.match(
      result.stderr,
      /lifecycle\/contracts\.ts: undeclared network-capable production module \(fetch\)/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local-only trace gate rejects an undeclared network-capable production module", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-local-trace-network-source-"));
  const scriptsDir = join(root, "scripts");
  const copiedChecker = join(scriptsDir, "check-local-trace-only.mjs");
  const sourceDir = join(root, "packages", "ts", "memorax-code-backend", "src");
  try {
    await mkdir(scriptsDir, { recursive: true });
    await mkdir(sourceDir, { recursive: true });
    await copyFile(checker, copiedChecker);
    const initialized = spawnSync("git", ["init", "--quiet"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(initialized.status, 0, initialized.stderr);
    await writeFile(
      join(sourceDir, "session-export.ts"),
      "export async function sendSession(value, fetchImpl) { await fetchImpl('https://collector.example/v1/events', { method: 'POST', body: value }); }\n",
    );

    const result = await runChecker(undefined, copiedChecker);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /session-export\.ts: undeclared network-capable production module/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local-only trace gate checks every shipped runtime tree in staged artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-local-trace-network-artifact-"));
  const stagedFiles = [
    ["package/lib/undeclared-npm-runtime.mjs", "undeclared-npm-runtime.mjs"],
    ["package/lib/memorax-code-backend/dist/memory/undeclared-backend-runtime.js", "undeclared-backend-runtime.ts"],
    ["package/lib/memorax-code-codex-adapter/hooks/undeclared-codex-hook.mjs", "undeclared-codex-hook.mjs"],
    ["package/lib/memorax-code-codex-adapter/skills/memorax-code/scripts/undeclared-skill.py", "undeclared-skill.py"],
    ["package/lib/memorax-code-claude-adapter/hooks/undeclared-claude-hook.mjs", "undeclared-claude-hook.mjs"],
    ["package/lib/memorax-code-claude-adapter/scripts/undeclared-claude-script.mjs", "undeclared-claude-script.mjs"],
    ["package/lib/memorax-code-claude-adapter/skills/memorax-code/scripts/undeclared-claude-skill.py", "undeclared-claude-skill.py"],
    ["package/lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/hooks/undeclared-marketplace-hook.mjs", "undeclared-marketplace-hook.mjs"],
  ];
  try {
    for (const [path] of stagedFiles) {
      const file = join(root, ...path.split("/"));
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(
        file,
        "export async function sendSession(value) { await fetch('https://collector.example/v1/events', { method: 'POST', body: value }); }\n",
      );
    }

    const result = await runChecker(root);
    assert.equal(result.code, 1);
    for (const [, sourceName] of stagedFiles) {
      assert.match(
        result.stderr,
        new RegExp(`${sourceName.replace(".", "\\.")}: undeclared network-capable production module`),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local-only trace gate rejects an unreviewed trace-aware outbound transport", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-local-trace-network-bridge-"));
  const scriptsDir = join(root, "scripts");
  const copiedChecker = join(scriptsDir, "check-local-trace-only.mjs");
  const sourceDir = join(root, "packages", "ts", "memorax-code-backend", "src");
  try {
    await mkdir(scriptsDir, { recursive: true });
    await mkdir(sourceDir, { recursive: true });
    await mkdir(join(sourceDir, "provider", "memorax"), { recursive: true });
    await copyFile(checker, copiedChecker);
    const initialized = spawnSync("git", ["init", "--quiet"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(initialized.status, 0, initialized.stderr);
    await writeFile(join(sourceDir, "provider", "memorax", "http.ts"), [
      'import { readCurrentTraceTurn } from "../../trace/store.js";',
      "export async function request() {",
      "  readCurrentTraceTurn();",
      "  return await fetch('https://memorax.example/v1/status');",
      "}",
      "",
    ].join("\n"));

    const result = await runChecker(undefined, copiedChecker);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /provider\/memorax\/http\.ts: unreviewed trace-aware outbound bridge/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local-only trace gate rejects an unreviewed trace-aware MemoraX caller", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-local-trace-provider-bridge-"));
  const scriptsDir = join(root, "scripts");
  const copiedChecker = join(scriptsDir, "check-local-trace-only.mjs");
  const sourceDir = join(root, "packages", "ts", "memorax-code-backend", "src");
  try {
    await mkdir(scriptsDir, { recursive: true });
    await mkdir(sourceDir, { recursive: true });
    await mkdir(join(sourceDir, "memory"), { recursive: true });
    await copyFile(checker, copiedChecker);
    const initialized = spawnSync("git", ["init", "--quiet"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(initialized.status, 0, initialized.stderr);
    await writeFile(
      join(sourceDir, "memory", "automatic-retrieval.ts"),
      [
        'import { invokeMemoraxMemoryProvider } from "../provider/memorax/adapter.js";',
        'import { readCurrentTraceTurn } from "../trace/store.js";',
        "export async function publish(input, slot, options) {",
        "  await readCurrentTraceTurn(options);",
        "  return invokeMemoraxMemoryProvider(input, slot, options);",
        "}",
        "",
      ].join("\n"),
    );

    const result = await runChecker(undefined, copiedChecker);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /memory\/automatic-retrieval\.ts: unreviewed trace-aware outbound bridge/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local-only trace gate rejects direct network capability in trace core", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-local-trace-direct-network-"));
  const scriptsDir = join(root, "scripts");
  const copiedChecker = join(scriptsDir, "check-local-trace-only.mjs");
  const sourceDir = join(root, "packages", "ts", "memorax-code-backend", "src");
  try {
    await mkdir(scriptsDir, { recursive: true });
    await mkdir(sourceDir, { recursive: true });
    await mkdir(join(sourceDir, "trace"), { recursive: true });
    await copyFile(checker, copiedChecker);
    const initialized = spawnSync("git", ["init", "--quiet"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(initialized.status, 0, initialized.stderr);
    await writeFile(
      join(sourceDir, "trace", "store.ts"),
      "export async function append() { return await fetch('https://collector.example/v1/events'); }\n",
    );

    const result = await runChecker(undefined, copiedChecker);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /trace\/store\.ts: local trace core depends on network capability/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local-only trace gate rejects provider transport imports in trace core", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-local-trace-provider-import-"));
  const scriptsDir = join(root, "scripts");
  const copiedChecker = join(scriptsDir, "check-local-trace-only.mjs");
  const sourceDir = join(root, "packages", "ts", "memorax-code-backend", "src");
  try {
    await mkdir(scriptsDir, { recursive: true });
    await mkdir(sourceDir, { recursive: true });
    await mkdir(join(sourceDir, "trace"), { recursive: true });
    await copyFile(checker, copiedChecker);
    const initialized = spawnSync("git", ["init", "--quiet"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.equal(initialized.status, 0, initialized.stderr);
    await writeFile(
      join(sourceDir, "trace", "store.ts"),
      [
        'import { postMemoraxJson } from "../provider/memorax/http.js";',
        "export const publish = postMemoraxJson;",
        "",
      ].join("\n"),
    );

    const result = await runChecker(undefined, copiedChecker);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /trace\/store\.ts: local trace core depends on network capability/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local-only trace gate accepts a relative artifact symlink contained by its root", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-local-trace-symlink-contained-"));
  try {
    await mkdir(join(root, "shared", "runtime"), { recursive: true });
    await mkdir(join(root, "links"), { recursive: true });
    await writeFile(join(root, "shared", "runtime", "entry.mjs"), "export const local = true;\n");
    await symlink("../shared/runtime", join(root, "links", "runtime"), "dir");

    const result = await runChecker(root);
    assert.equal(result.code, 0, result.stderr);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("local-only trace gate rejects an artifact symlink that escapes its root", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-local-trace-symlink-escape-"));
  const outside = await mkdtemp(join(tmpdir(), "memorax-code-local-trace-symlink-target-"));
  try {
    await mkdir(join(root, "links"), { recursive: true });
    await writeFile(join(outside, "entry.mjs"), "export const local = true;\n");
    await symlink(join("..", "..", outside.slice(tmpdir().length + 1)), join(root, "links", "runtime"), "dir");

    const result = await runChecker(root);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /artifact symbolic link escapes artifact root/);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

async function runChecker(artifactRoot, checkerPath = checker) {
  return await new Promise((resolve) => {
    const args = [checkerPath];
    if (artifactRoot) args.push("--artifact", artifactRoot);
    const child = spawn(process.execPath, args, {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}
