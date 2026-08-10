import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { memoryProjectRoot, resolveMemoryProject } from "../dist/memory/project.js";
import { listMemoryViewerDataWithHistory } from "../dist/viewer/store.js";
import {
  REPO_MEMORY_READINESS_MAX_CONCURRENT_VALIDATIONS,
  repoMemoryReadinessForProject,
} from "../dist/repository/readiness.js";

test("repo memory readiness reports the stable public status contract", async () => {
  const base = {
    resolveProjectRoot: () => "/repo",
    readActiveJob: async () => ({ active: false }),
  };
  assert.deepEqual(await readiness({
    ...base,
    validateBundle: async () => "usable",
  }), { status: "ready", reason: "usable" });

  let validationCalled = false;
  assert.deepEqual(await readiness({
    ...base,
    readActiveJob: async () => ({ active: true }),
    validateBundle: async () => {
      validationCalled = true;
      return "usable";
    },
  }), { status: "preparing", reason: "active_job" });
  assert.equal(validationCalled, false);

  assert.deepEqual(await readiness({
    ...base,
    validateBundle: async () => "missing",
  }), { status: "not_ready", reason: "bundle_missing" });
  assert.deepEqual(await readiness({
    ...base,
    validateBundle: async () => "invalid",
  }), { status: "not_ready", reason: "bundle_invalid" });
  assert.deepEqual(await readiness({
    ...base,
    validateBundle: async () => "unknown",
  }), { status: "unknown", reason: "validator_unavailable" });
  assert.deepEqual(await readiness({
    ...base,
    resolveProjectRoot: () => undefined,
    validateBundle: async () => "usable",
  }), { status: "unknown", reason: "project_unresolved" });
  assert.deepEqual(await readiness({
    ...base,
    readActiveJob: async () => {
      throw new Error("marker unavailable");
    },
    validateBundle: async () => "usable",
  }), { status: "ready", reason: "usable" });
});

test("resolved Git projects support default readiness without exposing their path", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-readiness-root-"));
  const repo = join(root, "repo with spaces");
  const nested = join(repo, "packages", "backend");
  const memoraxCodeHome = join(root, "memorax-code-home");
  try {
    await Promise.all([
      mkdir(join(repo, ".git"), { recursive: true }),
      mkdir(nested, { recursive: true }),
    ]);
    const project = resolveMemoryProject(nested);
    assert.ok(project);
    assert.equal(memoryProjectRoot(project.projectId), await realpath(repo));

    const result = await repoMemoryReadinessForProject(project.projectId, memoraxCodeHome);
    assert.deepEqual(result, { status: "not_ready", reason: "bundle_missing" });
    assert.doesNotMatch(JSON.stringify(result), new RegExp(escapeRegExp(repo)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("default bundle validator distinguishes an invalid bundle from tool failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-readiness-validator-"));
  const repo = join(root, "repo with spaces");
  try {
    await mkdir(join(repo, ".repo_memory"), { recursive: true });
    await writeFile(join(repo, ".repo_memory", "PROFILE.md"), "# incomplete\n", "utf8");
    assert.deepEqual(await readiness({
      resolveProjectRoot: () => repo,
      readActiveJob: async () => ({ active: false }),
    }), { status: "not_ready", reason: "bundle_invalid" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("historical cwd rebuilds the project-root index on a cold start", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-readiness-history-"));
  const repo = join(root, "repo");
  const memoraxCodeHome = join(root, "memorax-code-home");
  try {
    await mkdir(join(repo, ".git"), { recursive: true });
    const canonicalRepo = await realpath(repo);
    const projectId = `repo:${createHash("sha256").update(canonicalRepo).digest("hex").slice(0, 32)}`;
    const sessionDirectory = join(
      memoraxCodeHome,
      "debug",
      "traces",
      "codex",
      "sessions",
      "cold-start-session",
    );
    await mkdir(sessionDirectory, { recursive: true });
    await writeFile(join(sessionDirectory, "events.jsonl"), `${JSON.stringify({
      type: "memory_retrieve",
      event_id: "cold-start-event",
      timestamp: "2026-07-28T00:00:00.000Z",
      source: "direct_overlay",
      operation: "retrieve",
      ok: true,
      trace: {
        session_id: "cold-start-session",
        cwd: repo,
        memory_project: { project_id: projectId, project_label: "repo" },
      },
      response: { items: [] },
    })}\n`, "utf8");

    // The project id is derived manually so this assertion exercises history
    // hydration rather than a prior resolveMemoryProject call in this process.
    assert.equal(memoryProjectRoot(projectId), undefined);
    await listMemoryViewerDataWithHistory(memoraxCodeHome, { client: "codex" });
    assert.equal(memoryProjectRoot(projectId), canonicalRepo);
    assert.deepEqual(
      await repoMemoryReadinessForProject(projectId, memoraxCodeHome),
      { status: "not_ready", reason: "bundle_missing" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readiness coalesces concurrent and cached validation for one project", async () => {
  let validationCalls = 0;
  let releaseValidation;
  let markValidationStarted;
  const validationStarted = new Promise((resolve) => {
    markValidationStarted = resolve;
  });
  const validationGate = new Promise((resolve) => {
    releaseValidation = resolve;
  });
  const dependencies = {
    resolveProjectRoot: () => "/repo/coalesced",
    readActiveJob: async () => ({ active: false }),
    validateBundle: async () => {
      validationCalls += 1;
      markValidationStarted();
      await validationGate;
      return "usable";
    },
  };

  const first = repoMemoryReadinessForProject("coalesced-project", "/memorax-code/coalesced", dependencies);
  const second = repoMemoryReadinessForProject("coalesced-project", "/memorax-code/coalesced", dependencies);
  await validationStarted;
  assert.equal(validationCalls, 1);
  releaseValidation();
  assert.deepEqual(await Promise.all([first, second]), [
    { status: "ready", reason: "usable" },
    { status: "ready", reason: "usable" },
  ]);

  assert.deepEqual(
    await repoMemoryReadinessForProject("coalesced-project", "/memorax-code/coalesced", dependencies),
    { status: "ready", reason: "usable" },
  );
  assert.equal(validationCalls, 1);
});

test("readiness bounds validation concurrency across projects", async () => {
  let activeValidations = 0;
  let maximumActiveValidations = 0;
  let validationCalls = 0;
  const dependencies = {
    resolveProjectRoot: (projectId) => `/repo/${projectId}`,
    readActiveJob: async () => ({ active: false }),
    validateBundle: async () => {
      validationCalls += 1;
      activeValidations += 1;
      maximumActiveValidations = Math.max(maximumActiveValidations, activeValidations);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeValidations -= 1;
      return "usable";
    },
  };

  const projectCount = REPO_MEMORY_READINESS_MAX_CONCURRENT_VALIDATIONS * 3;
  const results = await Promise.all(Array.from({ length: projectCount }, (_, index) => (
    repoMemoryReadinessForProject(`bounded-${index}`, "/memorax-code/bounded", dependencies)
  )));

  assert.equal(validationCalls, projectCount);
  assert.equal(maximumActiveValidations, REPO_MEMORY_READINESS_MAX_CONCURRENT_VALIDATIONS);
  assert.ok(results.every((result) => result.status === "ready"));
});

function readiness(dependencies) {
  return repoMemoryReadinessForProject("repo-id", "/memorax-code", dependencies);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
