import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { codeBuddyInstallPath, enableCodeBuddyAdapter } from "../src/config.mjs";

const hookPath = fileURLToPath(new URL("../hooks/runtime-hook.mjs", import.meta.url));
const manifestPath = fileURLToPath(new URL("../hooks/hooks.json", import.meta.url));

test("SessionStart prewarms Backend and binds later memory CLI commands without starting a turn", async () => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const sessionStart = manifest.hooks.SessionStart?.[0];
  assert.equal(sessionStart?.matcher, "startup|resume|clear|compact");
  assert.equal(sessionStart?.hooks?.length, 1);
  assert.match(sessionStart.hooks[0].command, /runtime-hook\.mjs\" turn$/);
  assert.equal(sessionStart.hooks[0].timeout, 35);

  const root = await mkdtemp(join(tmpdir(), "memorax-codebuddy-hook-"));
  const transcriptPath = join(root, "session.jsonl");
  const envFile = join(root, "session-env.sh");
  await writeFile(transcriptPath, "");
  await writeFile(envFile, "export EXISTING_SESSION_VALUE='preserved'\n", "utf8");
  const requests = [];
  const server = await startServer(requests, { ok: true, service: "memorax-code-backend" });
  try {
    const result = await runHook({
      hook_event_name: "SessionStart", session_id: "session-start-'quoted", transcript_path: transcriptPath,
      source: "startup", cwd: root,
    }, {
      root,
      server,
      hookEnv: {
        CODEBUDDY_ENV_FILE: envFile,
        CODEBUDDY_PLUGIN_ROOT: "/c/Users/incorrect/plugin/root",
      },
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "");
    assert.deepEqual(requests.map((request) => request.path), ["/health"]);
    const observation = JSON.parse(await readFile(join(root, "adapters", "codebuddy", "runtime-observed.json"), "utf8"));
    assert.equal(observation.version, 1);
    assert.equal(observation.pluginVersion.length > 0, true);
    assert.equal(await readFile(envFile, "utf8"), [
      "export EXISTING_SESSION_VALUE='preserved'",
      "export MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT='codebuddy'",
      "export MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID='session-start-'\"'\"'quoted'",
      "",
    ].join("\n"));
    await assert.rejects(readFile(join(root, "adapters", "codebuddy", "pending.json"), "utf8"), { code: "ENOENT" });
  } finally { await server.close(); }
});

test("UserPromptSubmit posts turn-start, injects the skill reminder, and traces it", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-codebuddy-hook-"));
  const transcriptPath = join(root, "session.jsonl");
  await writeFile(transcriptPath, "");
  const requests = [];
  const server = await startServer(requests, { ok: true, additionalContext: "memory context" });
  try {
    const result = await runHook({
      hook_event_name: "UserPromptSubmit", session_id: "session-1", transcript_path: transcriptPath,
      prompt: "remember this", cwd: root,
    }, { root, server });
    assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(output.hookSpecificOutput.additionalContext, /^MemoraX Code reminder:/);
    assert.match(output.hookSpecificOutput.additionalContext, /the `memorax-code` skill/);
    assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /memorax-code-codebuddy-adapter:memorax-code/);
    const turnStarts = requests.filter((request) => request.path === "/memory/turn-start");
    assert.equal(turnStarts.length, 1);
    assert.equal(turnStarts[0].body.client, "codebuddy");
    assert.equal(turnStarts[0].body.sessionId, "session-1");
    assert.equal(turnStarts[0].body.prompt, "remember this");
    const reminders = requests.filter((request) => request.path === "/memory/skill-reminder");
    assert.equal(reminders.length, 1);
    assert.equal(reminders[0].body.client, "codebuddy");
    assert.equal(reminders[0].body.sessionId, "session-1");
    assert.deepEqual(reminders[0].body.triggers, ["cadence"]);
    const pending = JSON.parse(await readFile(join(root, "adapters", "codebuddy", "pending.json"), "utf8"));
    assert.equal(pending["session-1"].version, 1);
    assert.equal(pending["session-1"].turnId, provisionalTurnId("session-1", 0, "remember this"));
    assert.equal(reminders[0].body.turnId, pending["session-1"].turnId);
  } finally { await server.close(); }
});

test("managed prompt entry respects plugin disablement and rejects other events or legacy dispatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-codebuddy-hook-"));
  const requests = [];
  const server = await startServer(requests, { ok: true });
  try {
    for (const fixture of [
      { name: "disabled", pluginEnabled: false },
      { name: "missing", pluginEnabled: null },
      { name: "wrong-event", event: "SessionStart", mode: "managed-user-prompt" },
      { name: "legacy-prompt", mode: "turn" },
    ]) {
      const home = join(root, fixture.name);
      await mkdir(home, { recursive: true });
      const result = await runHook({
        hook_event_name: fixture.event ?? "UserPromptSubmit", session_id: "guarded-session",
        transcript_path: join(home, "session.jsonl"), prompt: "do not start", cwd: home,
      }, { root: home, server, ...fixture });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
      assert.deepEqual(requests, [], fixture.name);
      await assert.rejects(readFile(join(home, "adapters", "codebuddy", "pending.json")), { code: "ENOENT" });
      await assert.rejects(readFile(join(home, "adapters", "codebuddy", "runtime-observed.json")), { code: "ENOENT" });
    }
  } finally { await server.close(); }
});

test("UserPromptSubmit applies the configured reminder cadence to native turn identities", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-codebuddy-hook-"));
  const transcriptPath = join(root, "session.jsonl");
  await writeFile(transcriptPath, "");
  await writeFile(join(root, "config.toml"), "[memory.skill_reminder]\ninterval_turns = 2\n");
  const requests = [];
  const server = await startServer(requests, { ok: true });
  try {
    const outputs = [];
    for (let turn = 1; turn <= 3; turn += 1) {
      outputs.push(await runHook({
        hook_event_name: "UserPromptSubmit", session_id: "session-cadence", transcript_path: transcriptPath,
        prompt: `prompt ${turn}`, cwd: root,
      }, { root, server }));
    }
    for (const output of outputs) assert.equal(output.status, 0, output.stderr);
    assert.match(outputs[0].stdout, /MemoraX Code reminder/);
    assert.equal(outputs[1].stdout, "");
    assert.match(outputs[2].stdout, /MemoraX Code reminder/);
    const reminders = requests.filter((request) => request.path === "/memory/skill-reminder");
    assert.equal(reminders.length, 2);
    assert.deepEqual(reminders.map((request) => request.body.turnId), [
      provisionalTurnId("session-cadence", 0, "prompt 1"),
      provisionalTurnId("session-cadence", 0, "prompt 3"),
    ]);
  } finally { await server.close(); }
});

test("managed default WorkBuddy cwd is pinned through Stop and explicit workspace kind wins", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-codebuddy-default-"));
  const requests = [];
  const server = await startServer(requests, { ok: true });
  try {
    const userData = join(root, "native-app");
    const workspaceRoot = join(root, "custom-tasks");
    const cwd = join(workspaceRoot, "2026-09-08-11-25-30");
    const transcriptPath = join(root, "session.jsonl");
    await mkdir(userData, { recursive: true });
    await mkdir(cwd, { recursive: true });
    await writeFile(join(userData, "app-config.json"), JSON.stringify({ defaultWorkspacePath: workspaceRoot }));
    await writeFile(transcriptPath, "");
    const codeBuddyHome = join(root, "workbuddy");
    await enableCodeBuddyAdapter({ client: "workbuddy", codeBuddyHome, memoraxCodeHome: root, codeBuddyCommand: "fixture-workbuddy" });
    const hookEntry = join(codeBuddyInstallPath(codeBuddyHome), "hooks", "runtime-hook.mjs");
    const hookEnv = { WORKBUDDY_USER_DATA_DIR: userData };
    for (const explicitKind of [undefined, "local"]) {
      const sessionId = `default-${explicitKind ?? "detected"}`;
      const start = await runHook({
        hook_event_name: "UserPromptSubmit", session_id: sessionId, transcript_path: transcriptPath,
        prompt: "Prompt", cwd, ...(explicitKind ? { workspace_kind: explicitKind } : {}),
      }, { root, server, hookEnv, hookEntry });
      assert.equal(start.status, 0, start.stderr);
      const stop = await runHook({
        hook_event_name: "Stop", session_id: sessionId, transcript_path: transcriptPath, cwd: root,
      }, { root, server, hookEnv, hookEntry });
      assert.equal(stop.status, 0, stop.stderr);
      const turnRequests = requests.filter((request) => request.body?.sessionId === sessionId
        && ["/memory/turn-start", "/memory/writeback"].includes(request.path));
      assert.deepEqual(turnRequests.map((request) => request.body.workspaceKind), [explicitKind ?? "projectless", explicitKind ?? "projectless"]);
      assert.equal(turnRequests[1].body.cwd, cwd, "Stop preserves the accepted prompt workspace");
    }
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("installed clients isolate identical native identities and pin their selected homes", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-codebuddy-client-identity-"));
  const requests = [];
  const server = await startServer(requests, { ok: true, scheduled: true });
  const transcriptPath = join(root, "shared.jsonl");
  const sessionId = "same-native-session";
  await writeFile(transcriptPath, "");
  const entries = {};
  try {
    for (const client of ["codebuddy", "workbuddy"]) {
      const nativeHome = join(root, `native-${client}`);
      await enableCodeBuddyAdapter({ client, codeBuddyHome: nativeHome, memoraxCodeHome: root, codeBuddyCommand: `fixture-${client}` });
      entries[client] = join(codeBuddyInstallPath(nativeHome), "hooks", "runtime-hook.mjs");
      const envFile = join(root, `${client}.env`);
      await writeFile(envFile, "");
      const options = { root, server, hookEntry: entries[client], hookEnv: { WORKBUDDY_HOME: "/incorrect/ambient/home", CODEBUDDY_ENV_FILE: envFile } };
      const started = await runHook({ hook_event_name: "SessionStart", session_id: sessionId, transcript_path: transcriptPath, cwd: root }, options);
      assert.equal(started.status, 0, started.stderr);
      assert.match(await readFile(envFile, "utf8"), new RegExp(`TRACE_CLIENT='${client}'`));
      const prompt = await runHook({ hook_event_name: "UserPromptSubmit", session_id: sessionId, transcript_path: transcriptPath, prompt: "same prompt", cwd: root }, options);
      assert.equal(prompt.status, 0, prompt.stderr);
      const observed = JSON.parse(await readFile(join(root, "adapters", client, "runtime-observed.json"), "utf8"));
      assert.equal(observed.client, client);
      assert.equal(observed.codeBuddyHome, nativeHome);
    }
    assert.deepEqual(requests.filter((request) => request.path === "/memory/turn-start").map((request) => request.body.client), ["codebuddy", "workbuddy"]);
    const recoveryArgs = join(root, "recovery-args.json");
    const lifecycle = join(root, "recover.mjs");
    await writeFile(lifecycle, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(recoveryArgs)}, JSON.stringify(process.argv.slice(2))); process.exit(1);`);
    const recovery = await runHook({ hook_event_name: "SessionStart", session_id: sessionId, transcript_path: transcriptPath, cwd: root }, {
      root, server, hookEntry: entries.workbuddy,
      hookEnv: { MEMORAX_CODE_BACKEND_URL: "http://127.0.0.1:1", MEMORAX_CODE_CODEBUDDY_LIFECYCLE_COMMAND: lifecycle },
    });
    assert.equal(recovery.status, 0, recovery.stderr);
    const args = JSON.parse(await readFile(recoveryArgs, "utf8"));
    assert.equal(args.includes("--preserve-clients"), true);
    assert.equal(args.includes("--clients"), false);
    assert.equal(args[args.indexOf("--workbuddy-home") + 1], join(root, "native-workbuddy"));
    const cliPending = await readFile(join(root, "adapters", "codebuddy", "pending.json"), "utf8");
    const stopped = await runHook({ hook_event_name: "Stop", session_id: sessionId, transcript_path: transcriptPath, cwd: root }, { root, server, hookEntry: entries.workbuddy });
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.equal(requests.at(-1).body.client, "workbuddy");
    assert.equal(await readFile(join(root, "adapters", "codebuddy", "pending.json"), "utf8"), cliPending);
    assert.deepEqual(JSON.parse(await readFile(join(root, "adapters", "workbuddy", "pending.json"), "utf8")), {});
  } finally { await server.close(); }
});

test("Hooks without valid client metadata leave Backend and client state untouched", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-codebuddy-hook-authority-"));
  const requests = [];
  const server = await startServer(requests, { ok: true, scheduled: true });
  try {
    for (const [name, metadata] of [
      ["missing", undefined],
      ["malformed", "{"],
      ["unsupported-version", JSON.stringify({ version: 2, client: "workbuddy" })],
      ["unknown-client", JSON.stringify({ version: 1, client: "unknown" })],
    ]) {
      const home = join(root, name);
      const nativeHome = join(home, "native-workbuddy");
      await enableCodeBuddyAdapter({ client: "workbuddy", codeBuddyHome: nativeHome, memoraxCodeHome: home, codeBuddyCommand: "fixture-workbuddy" });
      const pluginRoot = codeBuddyInstallPath(nativeHome);
      const metadataPath = join(pluginRoot, ".memorax-code-package.json");
      if (metadata === undefined) await rm(metadataPath);
      else await writeFile(metadataPath, metadata);
      const envFile = join(home, "session.env");
      const preserved = new Map([[envFile, "export EXISTING_SESSION_VALUE='preserved'\n"]]);
      for (const client of ["codebuddy", "workbuddy"]) {
        const adapterDir = join(home, "adapters", client);
        await mkdir(adapterDir, { recursive: true });
        preserved.set(join(adapterDir, "pending.json"), '{"retained":{"sentinel":true}}\n');
        preserved.set(join(adapterDir, "runtime-observed.json"), '{"sentinel":true}\n');
      }
      for (const [path, content] of preserved) await writeFile(path, content);
      for (const event of ["SessionStart", "UserPromptSubmit", "Stop"]) {
        const result = await runHook({
          hook_event_name: event, session_id: "retained", transcript_path: join(home, "session.jsonl"),
          prompt: "do not dispatch without client identity", cwd: home,
        }, { root: home, server, hookEntry: join(pluginRoot, "hooks", "runtime-hook.mjs"), hookEnv: { CODEBUDDY_ENV_FILE: envFile } });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, "", `${name}: ${event}`);
        assert.deepEqual(requests, [], `${name}: ${event}`);
        for (const [path, content] of preserved) assert.equal(await readFile(path, "utf8"), content, `${name}: ${event}: ${path}`);
      }
    }
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("UserPromptSubmit exposes a Backend user notice without model context", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-codebuddy-hook-"));
  const transcriptPath = join(root, "session.jsonl");
  await writeFile(transcriptPath, "");
  const requests = [];
  let turnStarts = 0;
  const server = await startServer(requests, ({ path }) => {
    if (path !== "/memory/turn-start") return { ok: true, service: "memorax-code-backend" };
    turnStarts += 1;
    return turnStarts === 2
      ? { ok: true, userNotice: "MemoraX Code quota is running low." }
      : { ok: true };
  });
  try {
    const first = await runHook({
      hook_event_name: "UserPromptSubmit", session_id: "session-notice", transcript_path: transcriptPath,
      prompt: "first prompt", cwd: root,
    }, { root, server });
    assert.match(first.stdout, /MemoraX Code reminder/);

    const second = await runHook({
      hook_event_name: "UserPromptSubmit", session_id: "session-notice", transcript_path: transcriptPath,
      prompt: "second prompt", cwd: root,
    }, { root, server });
    assert.deepEqual(JSON.parse(second.stdout), {
      systemMessage: "MemoraX Code quota is running low.",
    });
  } finally { await server.close(); }
});

test("compact restores global profiles and procedures stay on turns 1, 6, and 11 without repository authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-codebuddy-hook-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const transcriptPath = join(root, "session.jsonl");
  await writeFile(transcriptPath, "");
  await createPersonalMemory(root);
  const requests = [];
  const server = await startServer(requests, { ok: true });
  try {
    const first = await runHook({
      hook_event_name: "UserPromptSubmit", session_id: "session-compact", transcript_path: transcriptPath,
      prompt: "first", cwd: workspace,
    }, { root, server });
    assert.match(first.stdout, /Prefer concise answers/);
    assert.match(first.stdout, /Run the focused adapter test first/);
    assert.match(first.stdout, /Natural final-answer mention for supported coding agents:/);
    assert.match(first.stdout, /generic label `Memory`/);

    const compact = await runHook({
      hook_event_name: "SessionStart", session_id: "session-compact", transcript_path: transcriptPath,
      source: "compact", cwd: workspace,
    }, { root, server });
    assert.equal(compact.stdout, "");

    const next = await runHook({
      hook_event_name: "UserPromptSubmit", session_id: "session-compact", transcript_path: transcriptPath,
      prompt: "after compact", cwd: workspace,
    }, { root, server });
    assert.match(next.stdout, /MemoraX Code personal-memory reminder/);
    assert.match(next.stdout, /Prefer concise answers/);
    assert.match(next.stdout, /Natural final-answer mention for supported coding agents:/);
    assert.doesNotMatch(next.stdout, /Run the focused adapter test first/);

    for (let turn = 3; turn <= 11; turn += 1) {
      const result = await runHook({
        hook_event_name: "UserPromptSubmit", session_id: "session-compact", transcript_path: transcriptPath,
        prompt: `prompt ${turn}`, cwd: workspace,
      }, { root, server });
      assert.equal(result.status, 0, result.stderr);
      assert.doesNotMatch(result.stdout, /Prefer concise answers/);
      assert.equal(result.stdout.includes("Run the focused adapter test first"), turn === 6 || turn === 11);
    }

    const reminders = requests.filter((request) => request.path === "/memory/skill-reminder");
    assert.deepEqual(reminders.map((request) => request.body.triggers), [
      ["cadence"],
      ["post_compaction"],
      ["cadence"],
      ["cadence"],
    ]);

    const otherWorkspace = join(root, "other-workspace");
    await mkdir(otherWorkspace);
    const shared = await runHook({
      hook_event_name: "UserPromptSubmit", session_id: "session-other-workspace", transcript_path: transcriptPath,
      prompt: "another workspace", cwd: otherWorkspace,
    }, { root, server });
    assert.equal(shared.status, 0, shared.stderr);
    assert.match(shared.stdout, /Prefer concise answers/);
    assert.match(shared.stdout, /Run the focused adapter test first/);
  } finally { await server.close(); }
});

test("UserPromptSubmit injects global personal memory when the Backend rejects the Turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-codebuddy-hook-"));
  const transcriptPath = join(root, "session.jsonl");
  await writeFile(transcriptPath, "");
  await createPersonalMemory(root);
  const requests = [];
  const server = await startServer(requests, { ok: false });
  try {
    const result = await runHook({
      hook_event_name: "UserPromptSubmit", session_id: "session-rejected", transcript_path: transcriptPath,
      prompt: "rejected prompt", cwd: root,
    }, { root, server });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Prefer concise answers/);
    assert.match(result.stdout, /Run the focused adapter test first/);
    // Search guidance still requires an accepted Turn.
    assert.equal(requests.some((request) => request.path === "/memory/search-guidance"), false);
  } finally { await server.close(); }
});

test("UserPromptSubmit retries reuse one deterministic pending turn and a new prompt replaces it", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-codebuddy-hook-"));
  const transcriptPath = join(root, "session.jsonl");
  await writeFile(transcriptPath, "");
  const requests = [];
  const server = await startServer(requests, { additionalContext: "memory context" });
  const input = {
    hook_event_name: "UserPromptSubmit", session_id: "session-retry", transcript_path: transcriptPath,
    prompt: "same prompt", cwd: root,
  };
  try {
    const first = await runHook(input, { root, server });
    assert.equal(first.status, 0);
    const firstPending = JSON.parse(await readFile(join(root, "adapters", "codebuddy", "pending.json"), "utf8"));

    const retry = await runHook(input, { root, server });
    assert.equal(retry.status, 0);
    assert.equal(retry.stdout, "");
    const retryPending = JSON.parse(await readFile(join(root, "adapters", "codebuddy", "pending.json"), "utf8"));
    assert.equal(retryPending["session-retry"].turnId, firstPending["session-retry"].turnId);
    assert.equal(retryPending["session-retry"].createdAt, firstPending["session-retry"].createdAt);
    assert.equal(retryPending["session-retry"].version, 1);
    assert.equal(Object.keys(retryPending).length, 1);

    const next = await runHook({ ...input, prompt: "next prompt" }, { root, server });
    assert.equal(next.status, 0);
    const nextPending = JSON.parse(await readFile(join(root, "adapters", "codebuddy", "pending.json"), "utf8"));
    assert.equal(nextPending["session-retry"].turnId, provisionalTurnId("session-retry", 0, "next prompt"));
    assert.notEqual(nextPending["session-retry"].turnId, retryPending["session-retry"].turnId);
    assert.equal(Object.keys(nextPending).length, 1);
    assert.equal(requests.filter((request) => request.path === "/memory/turn-start").length, 3);
    assert.equal(requests.filter((request) => request.path === "/memory/skill-reminder").length, 1);
  } finally { await server.close(); }
});

test("a global prompt before plugin SessionStart writes back once at Stop", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-codebuddy-hook-"));
  const transcriptPath = join(root, "session.jsonl");
  await writeFile(transcriptPath, "");
  const requests = [];
  const server = await startServer(requests, { ok: true, scheduled: true });
  try {
    const start = await runHook({
      hook_event_name: "UserPromptSubmit", session_id: "session-2", transcript_path: transcriptPath,
      prompt: "hello", cwd: root,
    }, { root, server });
    assert.equal(start.status, 0);
    const pending = JSON.parse(await readFile(join(root, "adapters", "codebuddy", "pending.json"), "utf8"));
    const turnId = pending["session-2"].turnId;
    const sessionStart = await runHook({
      hook_event_name: "SessionStart", session_id: "session-2", transcript_path: transcriptPath,
      source: "startup", cwd: root,
    }, { root, server });
    assert.equal(sessionStart.status, 0);
    assert.deepEqual(JSON.parse(await readFile(join(root, "adapters", "codebuddy", "pending.json"), "utf8")), pending);
    await writeFile(transcriptPath, [
      JSON.stringify({ id: "u1", role: "user", sessionId: "session-2", content: "<user_query>hello</user_query>" }),
      JSON.stringify({ id: "a1", role: "assistant", parentId: "u1", status: "completed", content: "done" }), "",
    ].join("\n"));
    const stop = await runHook({
      hook_event_name: "Stop", session_id: "session-2", transcript_path: transcriptPath, cwd: root,
    }, { root, server });
    assert.equal(stop.status, 0);
    assert.equal(requests.at(-1).path, "/memory/writeback");
    assert.equal(requests.at(-1).body.turnId, turnId);
    assert.equal(requests.filter((request) => request.path === "/memory/turn-start").length, 1);
    assert.equal(requests.filter((request) => request.path === "/memory/writeback").length, 1);
    assert.deepEqual(JSON.parse(await readFile(join(root, "adapters", "codebuddy", "pending.json"), "utf8")), {});
  } finally { await server.close(); }
});

test("Stop retains pending state when writeback is not scheduled", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-codebuddy-hook-"));
  const transcriptPath = join(root, "session.jsonl");
  await writeFile(transcriptPath, "");
  const server = await startServer([], { ok: true, scheduled: false, reason: "assistant_message_missing" });
  try {
    await runHook({
      hook_event_name: "UserPromptSubmit", session_id: "session-3", transcript_path: transcriptPath,
      prompt: "hello", cwd: root,
    }, { root, server });
    const before = JSON.parse(await readFile(join(root, "adapters", "codebuddy", "pending.json"), "utf8"));
    const stop = await runHook({
      hook_event_name: "Stop", session_id: "session-3", transcript_path: transcriptPath, cwd: root,
    }, { root, server });
    assert.equal(stop.status, 0);
    assert.deepEqual(JSON.parse(await readFile(join(root, "adapters", "codebuddy", "pending.json"), "utf8")), before);
  } finally { await server.close(); }
});

async function startServer(requests, response) {
  const server = createServer(async (request, responseStream) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const received = { path: request.url, body: text ? JSON.parse(text) : undefined };
    requests.push(received);
    const body = received.path === "/health"
      ? { ok: true, service: "memorax-code-backend" }
      : typeof response === "function" ? response(received) : response;
    responseStream.writeHead(200, { "content-type": "application/json" });
    responseStream.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

async function runHook(input, { root, server, hookEnv = {}, pluginEnabled = true, mode, hookEntry = hookPath }) {
  const address = server.address();
  const codeBuddyHome = join(root, "workbuddy");
  if (hookEntry === hookPath) {
    hookEntry = join(codeBuddyInstallPath(codeBuddyHome), "hooks", "runtime-hook.mjs");
    try { await access(hookEntry); } catch {
      await enableCodeBuddyAdapter({ client: "codebuddy", codeBuddyHome, memoraxCodeHome: root, codeBuddyCommand: "fixture-codebuddy" });
    }
  }
  if (pluginEnabled !== null) {
    await mkdir(codeBuddyHome, { recursive: true });
    await writeFile(join(codeBuddyHome, "settings.json"), JSON.stringify({
      enabledPlugins: { "memorax-code-codebuddy-adapter@memorax-code-local": pluginEnabled },
    }));
  } else await rm(join(codeBuddyHome, "settings.json"), { force: true });
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [hookEntry, mode ?? (input.hook_event_name === "UserPromptSubmit" ? "managed-user-prompt" : "turn")], {
      cwd: root,
      env: {
        ...process.env,
        CODEBUDDY_ENV_FILE: "",
        CODEBUDDY_HOME: codeBuddyHome,
        MEMORAX_CODE_HOME: root,
        MEMORAX_CODE_BACKEND_URL: `http://127.0.0.1:${address.port}`,
        ...hookEnv,
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status, signal) => resolve({ status, signal, stdout: stdout.trim(), stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

function provisionalTurnId(sessionId, boundary, prompt) {
  return `${sessionId}:${boundary}:${createHash("sha256").update(prompt.trim()).digest("hex")}`;
}

async function createPersonalMemory(home) {
  await mkdir(join(home, "personal-memory", "procedure-memory"), { recursive: true });
  await mkdir(join(home, "personal-memory", "user-profile"), { recursive: true });
  await writeFile(join(home, "personal-memory", "procedure-memory", "testing.md"), [
    "# Testing workflow",
    "",
    "Run the focused adapter test first.",
    "",
  ].join("\n"));
  await writeFile(join(home, "personal-memory", "user-profile", "preferences.md"), [
    "---",
    'schema: "user_profile_memory.v0.1"',
    'scope: "user"',
    'owner: "user-profile-memory"',
    'trust_state: "user_stated"',
    "active_count: 1",
    "total_count: 1",
    "---",
    "",
    "## Preference pref_concise",
    "- Status: `active`",
    "- Type: `communication`",
    "- Confidence: `explicit`",
    "- Created: `2026-08-28T00:00:00.000Z`",
    "- Updated: `2026-08-28T00:00:00.000Z`",
    "- Description: Prefer concise answers",
    "- Applies when: Always",
    "- Do not apply when: -",
    "",
  ].join("\n"));
}
