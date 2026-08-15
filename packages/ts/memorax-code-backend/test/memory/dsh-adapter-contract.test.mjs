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

test("Backend result envelopes carry the exact fields the adapter consumes", async (t) => {
  // The adapter reads additionalContext (session-bridge), scheduled/reason
  // (writeback skip), and discarded (turn-discard) straight off Backend
  // response bodies. Both sides define those names independently, and a
  // rename would fail silently — this test runs the real Backend runtime and
  // pins the response keys against the adapter's consumption.
  const { createDshMemoryHookRuntime } = await import("../../dist/clients/dsh/memory-hook-runtime.js");
  const { mkdtempSync, rmSync, readFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");

  const home = mkdtempSync(join(tmpdir(), "dsh-contract-envelope-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const runtime = createDshMemoryHookRuntime({
    memoraxCodeHome: home,
    env: {
      MEMORAX_CODE_HOME: home,
      MEMORAX_CODE_DSH_TRACE_ENABLED: "false",
      MEMORAX_CODE_MEMORY_RETRIEVAL_ENABLED: "false",
      MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "false",
    },
  });
  t.after(() => runtime.close());

  const turnStart = await runtime.recordTurnStart({
    version: BACKEND_COMMAND_VERSION, client: "dsh",
    sessionId: "contract-envelope", turnId: "dsh-0-0", prompt: "hello", cwd: "/repo",
  });
  assert.equal(turnStart.ok, true);
  assert.ok(!("additionalContext" in turnStart) || typeof turnStart.additionalContext === "string",
    "turn-start responses expose additionalContext as a string when present");

  const writeback = await runtime.writeback({
    version: BACKEND_COMMAND_VERSION, client: "dsh",
    sessionId: "contract-envelope", turnId: "dsh-0-0",
    userText: "hello", assistantText: "world", cwd: "/repo",
  });
  assert.equal(writeback.ok, true);
  assert.equal(writeback.scheduled, false);
  assert.equal(typeof writeback.reason, "string",
    "skipped writebacks must carry the reason field the adapter debug-logs");

  const discard = await runtime.discardTurn({
    version: BACKEND_COMMAND_VERSION, client: "dsh",
    sessionId: "contract-envelope", turnId: "dsh-0-0",
  });
  assert.equal(discard.ok, true);
  assert.equal(typeof discard.discarded, "boolean",
    "turn-discard responses must carry the discarded field the adapter debug-logs");
});

test("both sides hardcode the same Backend token header name", async () => {
  const { readFile } = await import("node:fs/promises");
  const TOKEN_HEADER = "x-memorax-code-backend-token";
  const adapterSource = await readFile(
    new URL("../../../memorax-code-dsh-adapter/src/backend-forwarder.mjs", import.meta.url), "utf8",
  );
  const backendSource = await readFile(
    new URL("../../src/transport/http/request.ts", import.meta.url), "utf8",
  );
  assert.ok(adapterSource.includes(TOKEN_HEADER),
    "the adapter must still send the token header the Backend expects");
  assert.ok(backendSource.includes(TOKEN_HEADER),
    "the Backend must still accept the token header the adapter sends");
});
