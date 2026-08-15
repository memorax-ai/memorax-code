import assert from "node:assert/strict";
import { test } from "node:test";

// Cross-package contract test: the DSH adapter is a standalone cordis plugin
// (plain .mjs, no dependency on the Backend's TypeScript packages), so every
// field it exchanges with the Backend is defined twice — once here, once
// there. This test imports BOTH sides and fails the build when they drift.
// Without it, a rename on one side surfaces only as silent 404s, 400s, or
// prompt_mismatch skips swallowed by the fail-silent plugin.
import { MEMORY_HOOK_COMMAND_VERSION as ADAPTER_COMMAND_VERSION } from "../../../memorax-code-dsh-adapter/src/config.mjs";
import {
  MEMORY_HOOK_PATHS as ADAPTER_PATHS,
  MESSAGE_JOIN_DELIMITER,
  buildTurnDiscardCommand,
  buildTurnStartCommand,
  buildWritebackCommand,
} from "../../../memorax-code-dsh-adapter/src/session-bridge.mjs";
import {
  MEMORY_HOOK_COMMAND_VERSION as BACKEND_COMMAND_VERSION,
  parseTurnDiscardCommand,
  parseTurnStartCommand,
  parseWritebackCommand,
} from "../../dist/memory/hook-command.js";
import { MEMORY_HOOK_PATHS as BACKEND_PATHS } from "../../dist/transport/http/memory-hook.js";
import { PROMPT_DELIMITER } from "../../dist/clients/dsh/memory-hook-runtime.js";

function adapterState() {
  return {
    sessionId: "contract-session",
    cwd: "/repo",
    firstLiveSeq: 7,
    turn: 3,
    sessionGeneration: 1,
  };
}

test("adapter turn-start commands parse as Backend DSH turn-start commands", () => {
  const command = buildTurnStartCommand({ ...adapterState(), userText: "hello" });
  assert.ok(command, "adapter must build a turn-start command");
  const parsed = parseTurnStartCommand(command);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok ? parsed.command : undefined, command);
});

test("adapter writeback commands parse as Backend DSH writeback commands", () => {
  const command = buildWritebackCommand(adapterState(), 3, "hello", "world");
  assert.ok(command, "adapter must build a writeback command");
  const parsed = parseWritebackCommand(command);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok ? parsed.command : undefined, command);
});

test("adapter discard commands parse as Backend DSH discard commands", () => {
  const command = buildTurnDiscardCommand(adapterState(), 3);
  assert.ok(command, "adapter must build a discard command");
  const parsed = parseTurnDiscardCommand(command);
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok ? parsed.command : undefined, command);
});

test("multi-message turns join with the delimiter the Backend matches against", () => {
  // The adapter joins a turn's messages with MESSAGE_JOIN_DELIMITER and the
  // Backend accepts a writeback whose userText is the started prompt plus
  // further messages: userText.startsWith(prompt + PROMPT_DELIMITER). A
  // delimiter mismatch would make every multi-message writeback fail
  // prompt_mismatch.
  assert.equal(MESSAGE_JOIN_DELIMITER, PROMPT_DELIMITER);
  const startedPrompt = "first";
  const userText = ["first", "second", "third"].join(MESSAGE_JOIN_DELIMITER);
  assert.equal(userText.startsWith(startedPrompt + PROMPT_DELIMITER), true);
});

test("adapter hook paths route on the Backend transport", () => {
  assert.equal(ADAPTER_PATHS.turnStart, BACKEND_PATHS.turnStart);
  assert.equal(ADAPTER_PATHS.writeback, BACKEND_PATHS.writeback);
  assert.equal(ADAPTER_PATHS.turnDiscard, BACKEND_PATHS.turnDiscard);
});

test("adapter and Backend agree on the memory hook command version", () => {
  assert.equal(ADAPTER_COMMAND_VERSION, BACKEND_COMMAND_VERSION);
});

test("adapter authority record matches the adapter-common authority record shape", async () => {
  // The DSH adapter cannot import adapter-common (standalone plugin), so it
  // mirrors the authority record validation. Pin the mirrored rules against
  // the canonical implementation: the same records must be accepted and
  // rejected by both readers, and the mirrored defaults must agree.
  const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const adapterCommon = await import("../../../memorax-code-adapter-common/src/backend-connection.mjs");
  const dshConfig = await import("../../../memorax-code-dsh-adapter/src/config.mjs");

  assert.equal(dshConfig.DEFAULT_BACKEND_URL, adapterCommon.DEFAULT_BACKEND_URL);

  const home = mkdtempSync(join(tmpdir(), "memorax-contract-"));
  try {
    const dir = join(home, "runtime", "backend");
    mkdirSync(dir, { recursive: true });
    const connectionPath = join(dir, "backend-connection.json");
    const tokenPath = join(dir, "backend-token.json");
    const valid = { version: 1, url: "http://127.0.0.1:9001", tokenPath };
    const invalid = [
      { version: 2, url: "http://127.0.0.1:9001" },
      { version: 1, url: "http://127.0.0.1:9001", extra: true },
      { version: 1, url: "ftp://127.0.0.1:9001" },
      { version: 1, url: "http://127.0.0.1:9001/path" },
      { version: 1, url: "http://127.0.0.1:9001", tokenPath: "/elsewhere/token.json" },
    ];

    writeFileSync(connectionPath, JSON.stringify(valid), "utf8");
    writeFileSync(tokenPath, JSON.stringify({
      version: 1,
      token: "managed-token",
      createdAt: "2026-01-01T00:00:00.000Z",
    }), "utf8");
    const canonical = adapterCommon.readBackendConnectionAuthority(home);
    assert.equal(canonical.status, "valid");
    const mirrored = mirrorResolve(dshConfig, home);
    assert.equal(mirrored.connection.backendUrl, "http://127.0.0.1:9001");
    assert.equal(mirrored.connection.urlSource, "authority");
    assert.equal(mirrored.connection.token, "managed-token");
    assert.equal(mirrored.connection.tokenSource, "authority-file");
    assert.deepEqual(mirrored.issues, []);

    for (const record of invalid) {
      writeFileSync(connectionPath, JSON.stringify(record), "utf8");
      const canonicalState = adapterCommon.readBackendConnectionAuthority(home);
      assert.notEqual(canonicalState.status, "valid", `canonical must reject ${JSON.stringify(record)}`);
      const mirroredState = mirrorResolve(dshConfig, home);
      assert.notEqual(mirroredState.connection.urlSource, "authority", `mirror must reject ${JSON.stringify(record)}`);
      assert.equal(mirroredState.issues.length, 1, `mirror must warn for ${JSON.stringify(record)}`);
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  function mirrorResolve(configModule, memoraxCodeHome) {
    // The mirror exposes its reader only through resolveBackendConnection;
    // drive it with a clean environment so the authority record decides.
    const issues = [];
    const connection = configModule.resolveBackendConnection(
      {},
      { MEMORAX_CODE_HOME: memoraxCodeHome },
      { onAuthorityIssue: (reason) => issues.push(reason) },
    );
    return { connection, issues };
  }
});
