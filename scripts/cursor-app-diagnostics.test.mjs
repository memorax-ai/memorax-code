import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { collectCursorAppDiagnostics, collectCursorAppLaunchDiagnostics, collectCursorAppStopDiagnostics, isCursorAppDiagnostics,
  projectCursorAppDiagnostics, projectCursorAppLaunchDiagnostics, projectCursorAppStopDiagnostics } from "./cursor-app-diagnostics.mjs";

const privateCanary = "private-content-path-token-canary";

test("launch diagnostics expose only bounded process outcomes and fixed stderr markers", () => {
  const result = collectCursorAppLaunchDiagnostics({ spawned: true, debugEndpointSeen: false, exitCode: null,
    signal: "SIGABRT", log: `${privateCanary}: sandbox_init: Operation not permitted\nNetwork service crashed` });
  assert.equal(result.signal, "SIGABRT");
  assert.equal(result.exitCode, null);
  assert.equal(result.markers.sandboxInitializationFailed, true);
  assert.equal(result.markers.permissionDenied, true);
  assert.equal(result.markers.networkServiceCrashed, true);
  assert.equal(result.markers.gpuProcessFailed, false);
  assert.equal(JSON.stringify(result).includes(privateCanary), false);
  assert.deepEqual(projectCursorAppLaunchDiagnostics(result), result);
  assert.equal(collectCursorAppLaunchDiagnostics({ log: "sandbox_init: " + "x".repeat(1024 * 1024) })
    .markers.sandboxInitializationFailed, false);
});

test("launch diagnostic projection cannot reflect arbitrary fields or invalid statuses", () => {
  for (const exitCode of [-1, 256, 1.5, "1", privateCanary]) {
    const result = projectCursorAppLaunchDiagnostics({ spawned: "true", debugEndpointSeen: 1, exitCode,
      signal: privateCanary, spawnError: privateCanary, log: privateCanary, privatePath: privateCanary,
      markers: { permissionDenied: "true", [privateCanary]: true } });
    assert.equal(result.spawned, false); assert.equal(result.debugEndpointSeen, false);
    assert.equal(result.exitCode, null); assert.equal(result.signal, "other"); assert.equal(result.spawnError, "other");
    assert.ok(Object.values(result.markers).every((value) => value === false));
    assert.equal(JSON.stringify(result).includes(privateCanary), false);
  }
  for (const exitCode of [0, 1, 255]) assert.equal(projectCursorAppLaunchDiagnostics({ exitCode }).exitCode, exitCode);
  for (const spawnError of ["ENOENT", "EACCES", "ENOEXEC"]) {
    assert.equal(projectCursorAppLaunchDiagnostics({ spawnError }).spawnError, spawnError);
  }
});

test("Seatbelt apply denial requires the exact same-line marker", () => {
  for (const log of ["sandbox_apply: Operation not permitted\n", `${privateCanary}: sandbox_apply: Operation not permitted\n`]) {
    const result = collectCursorAppLaunchDiagnostics({ log });
    assert.equal(result.markers.seatbeltApplyDenied, true);
    assert.equal(JSON.stringify(result).includes(privateCanary), false);
  }
  for (const log of ["sandbox_apply:\nOperation not permitted", "sandbox_init: Operation not permitted",
    "sandbox_apply: Invalid argument\nPermission denied", "sandbox_apply: Operation not permittedextra"]) {
    assert.equal(collectCursorAppLaunchDiagnostics({ log }).markers.seatbeltApplyDenied, false);
  }
});

test("Helper sandbox initialization uses its exact sentence, not the broader secure-mode diagnostic", () => {
  for (const log of ["Failed to initialize sandbox.", `${privateCanary}: Failed to initialize sandbox.\n`]) {
    const result = collectCursorAppLaunchDiagnostics({ log });
    assert.equal(result.markers.helperSandboxInitializationFailed, true);
    assert.equal(JSON.stringify(result).includes(privateCanary), false);
  }
  for (const log of ["Failed to initialize sandbox", "Failed to initialize sandbox in secure mode.",
    "Failed to initialize sandbox\n.", "Failed to initialize sandboxx."]) {
    assert.equal(collectCursorAppLaunchDiagnostics({ log }).markers.helperSandboxInitializationFailed, false);
  }
});

test("SandboxSerializer diagnostics distinguish exact policy modes and bounded same-line access denial", () => {
  const prefixes = {
    sandboxPolicyDeserializeFailed: "SandboxSerializer: Failed to deserialize policy:",
    sandboxCompiledPolicyFailed: "SandboxSerializer: Failed to apply compiled policy:",
    sandboxSourcePolicyFailed: "SandboxSerializer: Failed to initialize sandbox with source mode policy:",
  };
  for (const [marker, prefix] of Object.entries(prefixes)) {
    const result = collectCursorAppLaunchDiagnostics({ log: `${privateCanary}: ${prefix} ${privateCanary}\n` });
    for (const key of Object.keys(prefixes)) assert.equal(result.markers[key], key === marker);
    assert.equal(result.markers.sandboxPolicyPermissionDenied, false);
    assert.equal(JSON.stringify(result).includes(privateCanary), false);
    for (const log of [prefix.slice(0, -1), prefix.replace("SandboxSerializer: ", ""),
      prefix.replace("Serializer: ", "Serializer:\n"), prefix.replace("policy:", "policies:")]) {
      assert.equal(collectCursorAppLaunchDiagnostics({ log }).markers[marker], false);
    }
    for (const ending of ["", "\n", "\r\n"]) {
      const denied = collectCursorAppLaunchDiagnostics({ log: `${prefix} ${privateCanary}: Operation not permitted${ending}` });
      assert.equal(denied.markers.sandboxPolicyPermissionDenied, true);
      assert.equal(JSON.stringify(denied).includes(privateCanary), false);
    }
    for (const suffix of ["\nOperation not permitted", "\rOperation not permitted", " EPERM", " Permission denied",
      " Operation not permittedextra", " Operation not permitted.", ` ${"x".repeat(256)}Operation not permitted`]) {
      assert.equal(collectCursorAppLaunchDiagnostics({ log: prefix + suffix }).markers.sandboxPolicyPermissionDenied, false);
    }
  }
});

test("Seatbelt pipe diagnostics distinguish exact length and body read failures", () => {
  for (const [marker, prefix] of [["sandboxPipeLengthReadFailed", "SeatbeltExec: buffer length read failed"],
    ["sandboxPipeBodyReadFailed", "SeatbeltExec: buffer read failed"]]) {
    for (const suffix of ["", "\n", "\r\n", `: ${privateCanary}`]) {
      const result = collectCursorAppLaunchDiagnostics({ log: prefix + suffix });
      assert.equal(result.markers[marker], true); assert.equal(JSON.stringify(result).includes(privateCanary), false);
    }
    for (const log of [prefix + "extra", prefix.replace(" read ", "\nread "), prefix.replace("read", "write"),
      prefix.replace("SeatbeltExec: ", "")]) {
      assert.equal(collectCursorAppLaunchDiagnostics({ log }).markers[marker], false);
    }
  }
});

test("candidate stop diagnostics retain only fixed JSON result and process fields", () => {
  const result = collectCursorAppStopDiagnostics({ exitCode: 1, signal: null, timedOut: false,
    stdout: JSON.stringify({ ok: false, action: "stop", error: privateCanary,
      backend: { ok: false, errorCode: "BACKEND_OWNERSHIP_UNVERIFIED", stage: "verify_ownership",
        failureReason: "process_probe_inconclusive", systemCode: "EPERM", processState: "unknown",
        state: { pid: 12345, logPath: privateCanary, token: privateCanary }, error: privateCanary },
      cursorAdapter: { ok: true, root: privateCanary }, diagnostics: { raw: privateCanary } }) });
  assert.deepEqual(result, { exitCode: 1, signal: "none", timedOut: false, outputOverflow: false,
    jsonStatus: "valid", actionMatched: true, ok: false,
    backend: { present: true, ok: false, errorCode: "BACKEND_OWNERSHIP_UNVERIFIED", stage: "verify_ownership",
      failureReason: "process_probe_inconclusive", systemCode: "EPERM", processState: "unknown" },
    cursorAdapter: { present: true, ok: true } });
  assert.deepEqual(projectCursorAppStopDiagnostics(result), result);
  assert.equal(JSON.stringify(result).includes(privateCanary), false);
  assert.equal(JSON.stringify(result).includes("12345"), false);
});

test("candidate stop diagnostics reject malformed output and arbitrary nested codes without reflecting them", () => {
  for (const [stdout, expected] of [["", "absent"], [undefined, "absent"], [privateCanary, "invalid"],
    ["null", "invalid"], ["[]", "invalid"], ["x".repeat(1024 * 1024 + 1), "oversized"]]) {
    const result = collectCursorAppStopDiagnostics({ stdout, exitCode: null, signal: "SIGKILL", timedOut: true });
    assert.equal(result.jsonStatus, expected); assert.equal(result.backend.present, false);
    assert.equal(result.exitCode, null); assert.equal(result.signal, "SIGKILL"); assert.equal(result.timedOut, true);
    assert.equal(JSON.stringify(result).includes(privateCanary), false);
  }
  const result = projectCursorAppStopDiagnostics({ exitCode: privateCanary, signal: privateCanary, timedOut: "true",
    outputOverflow: 1, jsonStatus: privateCanary, actionMatched: 1, ok: "true", stdout: privateCanary, stderr: privateCanary,
    backend: { present: "true", ok: 1, errorCode: "BACKEND_PRIVATE_CANARY", stage: privateCanary, failureReason: privateCanary,
      systemCode: privateCanary, processState: privateCanary, state: privateCanary }, cursorAdapter: { present: 1, ok: "true" } });
  assert.equal(result.exitCode, null); assert.equal(result.signal, "other"); assert.equal(result.jsonStatus, "other");
  assert.equal(result.timedOut, false); assert.equal(result.outputOverflow, false); assert.equal(result.actionMatched, false);
  for (const key of ["errorCode", "stage", "failureReason", "systemCode", "processState"]) assert.equal(result.backend[key], "other");
  assert.deepEqual(result.cursorAdapter, { present: false, ok: false });
  assert.equal(JSON.stringify(result).includes(privateCanary), false);
  assert.equal(JSON.stringify(result).includes("BACKEND_PRIVATE_CANARY"), false);
  for (const exitCode of [-1, 256, 1.5, "1"]) assert.equal(projectCursorAppStopDiagnostics({ exitCode }).exitCode, null);
  for (const exitCode of [0, 1, 255]) assert.equal(projectCursorAppStopDiagnostics({ exitCode }).exitCode, exitCode);
});

async function fixture(callback) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "memorax-cursor-diagnostics-")));
  const sessionId = randomUUID(), turnId = randomUUID();
  const store = join(home, "runtime/cursor/turns", createHash("sha256").update(sessionId).digest("hex") + ".json");
  const trace = join(home, "debug/traces/cursor/sessions", sessionId, "events.jsonl");
  await mkdir(dirname(store), { recursive: true }); await mkdir(dirname(trace), { recursive: true });
  const record = { version: 2, client: "cursor", sessionId, active: { turnId, state: "open", stopStatus: "completed",
    reason: "native_final_response_pending", responseDigest: "a".repeat(64), metadata: { secret: privateCanary }, retryUntil: 42,
    cwd: privateCanary, databasePath: privateCanary } };
  const event = (type, outcome, identities = {}) => ({ type, outcome,
    trace: { client: "cursor", session_id: sessionId, turn_id: turnId, ...identities }, request: { prompt: privateCanary } });
  try { await callback({ home, sessionId, turnId, store, trace, record, event }); }
  finally { await rm(home, { recursive: true, force: true }); }
}
function assertSanitized(value, f) {
  assert.equal(isCursorAppDiagnostics(value), true);
  const text = JSON.stringify(value);
  for (const secret of [privateCanary, f.home, f.sessionId, f.turnId, "a".repeat(64)]) assert.ok(!text.includes(secret));
}

test("Cursor diagnostics correlate only the exact active generation and matching trace events", async () => {
  await fixture(async (f) => {
    await writeFile(f.store, JSON.stringify(f.record));
    const events = [f.event("turn_start"), f.event("turn_end", "completed"), f.event("turn_end", "interrupted"),
      f.event("turn_materialized"), f.event("turn_start", undefined, { turn_id: randomUUID() }),
      f.event("turn_start", undefined, { session_id: randomUUID() }), f.event("turn_start", undefined, { client: "codex" })];
    await writeFile(f.trace, events.map(JSON.stringify).join("\n") + "\n");
    const actual = await collectCursorAppDiagnostics(f);
    assert.deepEqual(actual.turnStore, { readStatus: "present", versionMatched: true, clientMatched: true,
      sessionMatched: true, activePresent: true, turnMatched: true, state: "open", stopStatus: "completed",
      reason: "native_final_response_pending", responseDigestPresent: true, metadataPresent: true, retryUntilPresent: true });
    assert.deepEqual(actual.trace, { readStatus: "present", eventCount: 7, turnStartCount: 1,
      completedCount: 1, interruptedCount: 1, materializedCount: 1 });
    assertSanitized(actual, f);
    assert.deepEqual(JSON.parse(await readFile(f.store, "utf8")), f.record);
  });
});

test("Cursor diagnostics retain interruption status without requiring a response digest", async () => {
  await fixture(async (f) => {
    f.record.active = { turnId: f.turnId, state: "interrupted", stopStatus: "aborted", reason: "interrupted" };
    await writeFile(f.store, JSON.stringify(f.record));
    await writeFile(f.trace, JSON.stringify(f.event("turn_end", "interrupted")) + "\n");
    const actual = await collectCursorAppDiagnostics(f);
    assert.equal(actual.turnStore.state, "interrupted"); assert.equal(actual.turnStore.stopStatus, "aborted");
    assert.equal(actual.turnStore.reason, "interrupted"); assert.equal(actual.turnStore.responseDigestPresent, false);
    assert.equal(actual.turnStore.metadataPresent, false); assert.equal(actual.trace.interruptedCount, 1);
    assertSanitized(actual, f);
  });
});

test("Cursor diagnostics distinguish identity mismatch, missing files and invalid structured records", async () => {
  await fixture(async (f) => {
    let actual = await collectCursorAppDiagnostics(f);
    assert.equal(actual.turnStore.readStatus, "absent"); assert.equal(actual.trace.readStatus, "absent");
    await writeFile(f.store, JSON.stringify({ ...f.record, version: 1, client: "codex", sessionId: randomUUID(),
      active: { ...f.record.active, turnId: randomUUID(), reason: privateCanary } }));
    actual = await collectCursorAppDiagnostics(f);
    for (const key of ["versionMatched", "clientMatched", "sessionMatched", "turnMatched"]) assert.equal(actual.turnStore[key], false);
    assert.equal(actual.turnStore.reason, "other"); assertSanitized(actual, f);
    for (const malformed of ["not-json", "null", "[]", Buffer.from([0xff])]) {
      await writeFile(f.store, malformed); await writeFile(f.trace, malformed);
      actual = await collectCursorAppDiagnostics(f);
      assert.equal(actual.turnStore.readStatus, "invalid"); assert.equal(actual.trace.readStatus, "invalid");
      assertSanitized(actual, f);
    }
  });
});

test("Cursor diagnostics reject oversized files, excessive events and nonregular files", async () => {
  await fixture(async (f) => {
    await writeFile(f.store, Buffer.alloc(1024 * 1024 + 1)); await writeFile(f.trace, Buffer.alloc(1024 * 1024 + 1));
    let actual = await collectCursorAppDiagnostics(f);
    assert.equal(actual.turnStore.readStatus, "oversized"); assert.equal(actual.trace.readStatus, "oversized");
    await writeFile(f.trace, "{}\n".repeat(4097));
    actual = await collectCursorAppDiagnostics(f); assert.equal(actual.trace.readStatus, "oversized");
    await rm(f.store); await mkdir(f.store);
    actual = await collectCursorAppDiagnostics(f); assert.equal(actual.turnStore.readStatus, "unsafe");
    assertSanitized(actual, f);
  });
});

test("Cursor diagnostics reject symlink files and directories without reading their targets", {
  skip: process.platform === "win32" ? "Symlink permission is runner-dependent" : false,
}, async () => {
  await fixture(async (f) => {
    const target = join(f.home, "private"); await writeFile(target, JSON.stringify(f.record));
    await symlink(target, f.store); await symlink(target, f.trace);
    let actual = await collectCursorAppDiagnostics(f);
    assert.equal(actual.turnStore.readStatus, "unsafe"); assert.equal(actual.trace.readStatus, "unsafe");
    await rm(dirname(f.store), { recursive: true }); await symlink(f.home, dirname(f.store));
    actual = await collectCursorAppDiagnostics(f); assert.equal(actual.turnStore.readStatus, "unsafe");
    assertSanitized(actual, f);
  });
});

test("Cursor diagnostics reject unsafe input and never reflect filesystem errors", async () => {
  for (const input of [undefined, {}, { home: "relative", sessionId: randomUUID(), turnId: randomUUID() },
    { home: tmpdir(), sessionId: "../private", turnId: randomUUID() },
    { home: tmpdir(), sessionId: randomUUID() + "\n", turnId: randomUUID() },
    { home: tmpdir(), sessionId: randomUUID(), turnId: privateCanary }]) {
    const actual = await collectCursorAppDiagnostics(input);
    assert.equal(actual.turnStore.readStatus, "invalid"); assert.equal(actual.trace.readStatus, "invalid");
    assert.equal(isCursorAppDiagnostics(actual), true); assert.ok(!JSON.stringify(actual).includes(privateCanary));
  }
});

test("Cursor diagnostics projection drops unknown fields and validates only the public schema", () => {
  const dirty = { secret: privateCanary, turnStore: { readStatus: "present", state: "open", stopStatus: privateCanary,
    reason: privateCanary, turnMatched: true, responseDigestPresent: "true", secret: privateCanary },
    trace: { readStatus: "present", eventCount: 9, turnStartCount: 1, completedCount: -1,
      interruptedCount: 4097, materializedCount: "1", raw: privateCanary } };
  const projected = projectCursorAppDiagnostics(dirty);
  assert.equal(projected.turnStore.reason, "other"); assert.equal(projected.turnStore.stopStatus, "other");
  assert.equal(projected.turnStore.responseDigestPresent, false); assert.equal(projected.trace.completedCount, 0);
  assert.equal(projected.trace.interruptedCount, 0); assert.equal(projected.trace.materializedCount, 0);
  assert.equal(isCursorAppDiagnostics(dirty), false); assert.equal(isCursorAppDiagnostics(projected), true);
  assert.ok(!JSON.stringify(projected).includes(privateCanary));
  assert.equal(isCursorAppDiagnostics(undefined), false);
  assert.equal(isCursorAppDiagnostics({ ...projected, private: privateCanary }), false);
});
