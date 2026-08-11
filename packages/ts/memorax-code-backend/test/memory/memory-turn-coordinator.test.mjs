import assert from "node:assert/strict";
import { test } from "node:test";
import { createMemoryTurnCoordinator } from "../../dist/memory/turn-coordinator.js";

test("memory turn coordinator isolates identical client turn keys", () => {
  const coordinator = createMemoryTurnCoordinator({
    automaticWriteback() {
      return { accepted: true };
    },
    now: () => 100,
    cleanupIntervalMs: 60_000,
  });
  try {
    coordinator.recordTurnStart(turnStart("codex"));
    coordinator.recordTurnStart(turnStart("claude-code"));
    coordinator.recordTurnStart(turnStart("opencode"));

    assert.equal(coordinator.size(), 3);
    assert.equal(coordinator.size("codex"), 1);
    assert.equal(coordinator.size("claude-code"), 1);
    assert.equal(coordinator.size("opencode"), 1);
    assert.equal(coordinator.getTurn(turnKey("codex"))?.client, "codex");
    assert.equal(coordinator.discardTurn(turnKey("codex"), "interrupted"), true);
    assert.equal(coordinator.getTurn(turnKey("codex")), undefined);
    assert.equal(coordinator.getTurn(turnKey("claude-code"))?.client, "claude-code");
    assert.equal(coordinator.getTurn(turnKey("opencode"))?.client, "opencode");
  } finally {
    coordinator.close();
  }
});

test("memory turn coordinator preserves materialized Codex content and pinned scope", async () => {
  const writebacks = [];
  const coordinator = createMemoryTurnCoordinator({
    automaticWriteback(options) {
      writebacks.push(options);
      return { accepted: true };
    },
    cleanupIntervalMs: 60_000,
  });
  const scope = repositoryScope("repo-a");
  try {
    coordinator.recordTurnStart(turnStart("codex", scope));
    const metadata = coordinator.getTurn(turnKey("codex"));
    const result = await coordinator.completeMaterializedTurn({
      key: turnKey("codex"),
      metadata,
      resolveRepositoryMemory: async () => configuredMemory(scope),
      userText: "Materialized rollout prompt.",
      assistantText: "Materialized rollout answer.",
      writeback: {
        client: "codex",
        sessionKey: "shared-session",
        memoryObservabilitySource: "codex_hook_writeback",
      },
    });

    assert.deepEqual(result, {
      scheduled: true,
      metadataDisposition: "consumed",
    });
    assert.equal(coordinator.getTurn(turnKey("codex")), undefined);
    assert.equal(writebacks.length, 1);
    assert.equal(writebacks[0].userText, "Materialized rollout prompt.");
    assert.equal(writebacks[0].assistantText, "Materialized rollout answer.");
    assert.equal(writebacks[0].repositoryScope, scope);
    assert.equal(writebacks[0].memoryObservabilitySource, "codex_hook_writeback");
    assert.equal(writebacks[0].client, "codex");
  } finally {
    coordinator.close();
  }
});

test("memory turn coordinator uses repaired Git scope after a degraded turn start", async () => {
  const writebacks = [];
  const coordinator = createMemoryTurnCoordinator({
    automaticWriteback(options) {
      writebacks.push(options);
      return { accepted: true };
    },
    cleanupIntervalMs: 60_000,
  });
  const degradedScope = {
    ...repositoryScope("quant"),
    fallbackReason: "git_metadata_invalid",
  };
  const gitScope = {
    ...repositoryScope("quant"),
    repositoryKey: "git-key:quant",
    identitySource: "origin-remote",
    scopeKind: "git-repository",
  };
  try {
    coordinator.recordTurnStart(turnStart("codex", degradedScope));
    const result = await coordinator.completeMaterializedTurn({
      key: turnKey("codex"),
      metadata: coordinator.getTurn(turnKey("codex")),
      resolveRepositoryMemory: async () => configuredMemory(gitScope),
      userText: "Repair the repository metadata.",
      assistantText: "The repository metadata is repaired.",
      writeback: { client: "codex", sessionKey: "shared-session" },
    });

    assert.deepEqual(result, {
      scheduled: true,
      metadataDisposition: "consumed",
    });
    assert.equal(writebacks.length, 1);
    assert.strictEqual(writebacks[0].repositoryScope, gitScope);
  } finally {
    coordinator.close();
  }
});

test("memory turn coordinator requires materialized client content", async () => {
  const writebacks = [];
  const coordinator = createMemoryTurnCoordinator({
    automaticWriteback(options) {
      writebacks.push(options);
      return { accepted: true };
    },
    cleanupIntervalMs: 60_000,
  });
  const scope = repositoryScope("repo-a");
  try {
    coordinator.recordTurnStart(turnStart("claude-code", scope));
    const result = await coordinator.completeMaterializedTurn({
      key: turnKey("claude-code"),
      metadata: coordinator.getTurn(turnKey("claude-code")),
      resolveRepositoryMemory: async () => configuredMemory(scope),
      userText: "Materialized Claude transcript prompt.",
      assistantText: "Materialized Claude transcript answer.",
      writeback: { client: "claude-code", sessionKey: "shared-session" },
    });

    assert.deepEqual(result, {
      scheduled: true,
      metadataDisposition: "consumed",
    });
    assert.equal(writebacks[0].userText, "Materialized Claude transcript prompt.");
    assert.equal(writebacks[0].assistantText, "Materialized Claude transcript answer.");
    assert.equal(writebacks[0].client, "claude-code");
  } finally {
    coordinator.close();
  }
});

test("memory turn coordinator preserves scope failures and expiration", async () => {
  let now = 100;
  let resolutions = 0;
  const writebacks = [];
  const coordinator = createMemoryTurnCoordinator({
    automaticWriteback(options) {
      writebacks.push(options);
      return { accepted: true };
    },
    now: () => now,
    ttlMs: 10,
    cleanupIntervalMs: 60_000,
  });
  try {
    coordinator.recordTurnStart({
      ...turnStart("codex"),
      createdAt: now,
      repositoryMemory: { ok: false, reason: "config_missing", error: "missing config" },
    });
    const failed = await coordinator.completeMaterializedTurn({
      key: turnKey("codex"),
      metadata: coordinator.getTurn(turnKey("codex")),
      resolveRepositoryMemory: async () => {
        resolutions += 1;
        return configuredMemory(repositoryScope("repo-a"));
      },
      userText: "Unavailable scope.",
      assistantText: "Must not write.",
      writeback: { client: "codex", sessionKey: "shared-session" },
    });
    assert.deepEqual(failed, {
      scheduled: false,
      reason: "config_missing",
      metadataDisposition: "retained",
    });
    assert.equal(resolutions, 0);
    assert.equal(writebacks.length, 0);
    assert.notEqual(coordinator.getTurn(turnKey("codex")), undefined);

    coordinator.recordTurnStart(turnStart("codex"));
    const mismatched = await coordinator.completeMaterializedTurn({
      key: turnKey("codex"),
      metadata: coordinator.getTurn(turnKey("codex")),
      resolveRepositoryMemory: async () => {
        resolutions += 1;
        return configuredMemory(repositoryScope("repo-b"));
      },
      userText: "Pinned scope.",
      assistantText: "Must remain in repo A.",
      writeback: { client: "codex", sessionKey: "shared-session" },
    });
    assert.deepEqual(mismatched, {
      scheduled: false,
      reason: "workspace_scope_mismatch",
      metadataDisposition: "retained",
    });
    assert.equal(resolutions, 1);
    assert.equal(writebacks.length, 0);
    assert.notEqual(coordinator.getTurn(turnKey("codex")), undefined);

    coordinator.recordTurnStart({
      ...turnStart("codex"),
      createdAt: now,
    });
    now += 11;
    coordinator.pruneExpired();
    assert.equal(coordinator.size(), 0);
  } finally {
    coordinator.close();
  }
});

test("memory turn coordinator retains metadata when automatic enqueue rejects", async () => {
  const coordinator = createMemoryTurnCoordinator({
    automaticWriteback() {
      return { accepted: false, reason: "disabled" };
    },
    cleanupIntervalMs: 60_000,
  });
  const scope = repositoryScope("repo-a");
  try {
    coordinator.recordTurnStart(turnStart("codex", scope));
    const metadata = coordinator.getTurn(turnKey("codex"));
    const result = await coordinator.completeMaterializedTurn({
      key: turnKey("codex"),
      metadata,
      resolveRepositoryMemory: async () => configuredMemory(scope),
      userText: "Materialized rollout prompt.",
      assistantText: "Materialized rollout answer.",
      writeback: { client: "codex", sessionKey: "shared-session" },
    });

    assert.deepEqual(result, {
      scheduled: false,
      reason: "disabled",
      metadataDisposition: "retained",
    });
    assert.strictEqual(coordinator.getTurn(turnKey("codex")), metadata);
  } finally {
    coordinator.close();
  }
});

test("memory turn coordinator reports accepted late materialization without cached metadata", async () => {
  const coordinator = createMemoryTurnCoordinator({
    automaticWriteback() {
      return { accepted: true };
    },
    cleanupIntervalMs: 60_000,
  });
  const scope = repositoryScope("repo-a");
  try {
    const result = await coordinator.completeMaterializedTurn({
      key: turnKey("codex"),
      resolveRepositoryMemory: async () => configuredMemory(scope),
      userText: "Late materialized rollout prompt.",
      assistantText: "Late materialized rollout answer.",
      writeback: { client: "codex", sessionKey: "shared-session" },
    });

    assert.deepEqual(result, {
      scheduled: true,
      metadataDisposition: "absent",
    });
  } finally {
    coordinator.close();
  }
});

test("memory turn coordinator rejects metadata from another turn key", async () => {
  let resolutions = 0;
  const coordinator = createMemoryTurnCoordinator({
    automaticWriteback() {
      return { accepted: true };
    },
    now: () => 100,
    cleanupIntervalMs: 60_000,
  });
  try {
    coordinator.recordTurnStart(turnStart("codex"));
    const foreign = coordinator.recordTurnStart(turnStart("claude-code"));
    const result = await coordinator.completeMaterializedTurn({
      key: turnKey("codex"),
      metadata: foreign,
      resolveRepositoryMemory: async () => {
        resolutions += 1;
        return configuredMemory(repositoryScope("repo-a"));
      },
      userText: "Mismatched metadata prompt.",
      assistantText: "Mismatched metadata answer.",
      writeback: { client: "codex", sessionKey: "shared-session" },
    });

    assert.deepEqual(result, {
      scheduled: false,
      reason: "turn_metadata_mismatch",
      metadataDisposition: "retained",
    });
    assert.equal(resolutions, 0);
    assert.equal(coordinator.size(), 2);
  } finally {
    coordinator.close();
  }
});

test("memory turn coordinator keeps delimiter-containing turn identities distinct", async () => {
  const writebacks = [];
  const coordinator = createMemoryTurnCoordinator({
    automaticWriteback(options) {
      writebacks.push(options);
      return { accepted: true };
    },
    now: () => 100,
    cleanupIntervalMs: 60_000,
  });
  const scope = repositoryScope("repo-a");
  const firstKey = {
    client: "codex",
    sessionId: "s:a",
    clientTurnId: "t",
  };
  const secondKey = {
    client: "codex",
    sessionId: "s",
    clientTurnId: "a:t",
  };
  try {
    const first = coordinator.recordTurnStart({
      ...turnStart("codex", scope),
      ...firstKey,
    });
    const second = coordinator.recordTurnStart({
      ...turnStart("codex", scope),
      ...secondKey,
    });

    assert.equal(coordinator.size(), 2);
    assert.strictEqual(coordinator.getTurn(firstKey), first);
    assert.strictEqual(coordinator.getTurn(secondKey), second);

    const result = await coordinator.completeMaterializedTurn({
      key: secondKey,
      metadata: first,
      resolveRepositoryMemory: async () => configuredMemory(scope),
      userText: "Mismatched delimiter metadata prompt.",
      assistantText: "Must not write.",
      writeback: { client: "codex", sessionKey: "s" },
    });

    assert.deepEqual(result, {
      scheduled: false,
      reason: "turn_metadata_mismatch",
      metadataDisposition: "retained",
    });
    assert.equal(writebacks.length, 0);
    assert.strictEqual(coordinator.getTurn(firstKey), first);
    assert.strictEqual(coordinator.getTurn(secondKey), second);
  } finally {
    coordinator.close();
  }
});

test("memory turn coordinator never consumes replacement metadata after async resolution", async () => {
  let resolveRepositoryMemory;
  const repositoryMemory = new Promise((resolve) => {
    resolveRepositoryMemory = resolve;
  });
  const coordinator = createMemoryTurnCoordinator({
    automaticWriteback() {
      return { accepted: true };
    },
    cleanupIntervalMs: 60_000,
  });
  const initialScope = repositoryScope("repo-a");
  try {
    const initial = coordinator.recordTurnStart(turnStart("codex", initialScope));
    const completion = coordinator.completeMaterializedTurn({
      key: turnKey("codex"),
      metadata: initial,
      resolveRepositoryMemory: async () => await repositoryMemory,
      userText: "Initial rollout prompt.",
      assistantText: "Initial rollout answer.",
      writeback: { client: "codex", sessionKey: "shared-session" },
    });
    const replacement = coordinator.recordTurnStart({
      ...turnStart("codex", repositoryScope("repo-b")),
      createdAt: 200,
    });
    resolveRepositoryMemory(configuredMemory(initialScope));

    assert.deepEqual(await completion, {
      scheduled: true,
      metadataDisposition: "retained",
    });
    assert.strictEqual(coordinator.getTurn(turnKey("codex")), replacement);
  } finally {
    coordinator.close();
  }
});

function turnStart(client, scope = repositoryScope("repo-a")) {
  return {
    ...turnKey(client),
    cwd: "/workspace/repo-a",
    createdAt: 100,
    repositoryMemory: configuredMemory(scope),
  };
}

function turnKey(client) {
  return {
    client,
    sessionId: "shared-session",
    clientTurnId: "shared-turn",
  };
}

function configuredMemory(scope) {
  return { ok: true, memory: { config: {}, scope } };
}

function repositoryScope(repositorySlug) {
  return {
    schemaVersion: "workspace-memory-scope.v1",
    baseUserId: "user-1",
    effectiveUserId: `user-1@${repositorySlug}`,
    repositoryKey: `key:${repositorySlug}`,
    repositorySlug,
    repositoryName: repositorySlug,
    identitySource: "workspace-directory",
    scopeKind: "local-directory",
    boundWorkspaceRoot: `/workspace/${repositorySlug}`,
  };
}
