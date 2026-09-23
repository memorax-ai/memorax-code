import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { enableCursorAdapter } from "../src/config.mjs";
import { cursorDatabasePath } from "../src/native-database-path.mjs";
import { DEFAULT_ENSURE_BACKEND_START_TIMEOUT_MS } from "../../memorax-code-adapter-common/src/hooks/ensure-backend-runner.mjs";

const sessionId = "11111111-1111-4111-8111-111111111111";
const turnId = "22222222-2222-4222-8222-222222222222";

test("Cursor starts preserve native identity, exact prompts, missing paths and empty Continue", async () => {
  const fixture = await createFixture();
  try {
    for (const [prompt, transcript_path] of [["  exact prompt\n", join(fixture.root, "native.jsonl")], ["first prompt", null], ["", null], ["database authority", "relative.jsonl"]]) {
      const result = await runHook(fixture, { hook_event_name: "beforeSubmitPrompt", prompt, transcript_path });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).continue, true);
      assert.deepEqual(fixture.requests.filter(({ path }) => path === "/memory/turn-start").at(-1), { path: "/memory/turn-start", body: {
        version: 1, client: "cursor", sessionId, turnId, cwd: fixture.root, prompt, databasePath: fixture.databasePath,
        ...(transcript_path && transcript_path !== "relative.jsonl" ? { transcriptPath: transcript_path } : {}),
      } });
    }
  } finally { await fixture.close(); }
});

test("Cursor response sends only the exact native text digest and stop preserves native status", async () => {
  const fixture = await createFixture();
  try {
    const text = "  synthetic response 中文\n";
    const transcript_path = join(fixture.root, "native.jsonl");
    const response = await runHook(fixture, { hook_event_name: "afterAgentResponse", text, transcript_path });
    assert.equal(response.status, 0, response.stderr);
    assert.equal(response.stdout, "");
    assert.deepEqual(fixture.requests.at(-1), { path: "/memory/writeback", body: {
      version: 1, client: "cursor", sessionId, turnId, cwd: fixture.root, databasePath: fixture.databasePath,
      transcriptPath: transcript_path, phase: "response",
      responseDigest: createHash("sha256").update(text).digest("hex"),
    } });
    assert.equal(JSON.stringify(fixture.requests).includes(text), false);
    for (const status of ["completed", "aborted", "error"]) {
      await runHook(fixture, { hook_event_name: "stop", status, transcript_path,
        last_assistant_message: "must not become fallback content" });
      assert.deepEqual(fixture.requests.at(-1).body, {
        version: 1, client: "cursor", sessionId, turnId, cwd: fixture.root, databasePath: fixture.databasePath,
        transcriptPath: transcript_path, phase: "stop", status,
      });
    }
  } finally { await fixture.close(); }
});

test("Cursor preCompact sends only native identity and does not mark or inject reminders", async () => {
  const fixture = await createFixture();
  try {
    fixture.control.body.restorePersonalMemory = true;
    fixture.control.body.repoMemoryWorktree = fixture.root;
    const transcriptPath = join(fixture.root, "native.jsonl");
    const result = await runHook(fixture, { hook_event_name: "preCompact", transcript_path: transcriptPath,
      trigger: "manual", prompt: "private prompt", text: "private context" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    assert.deepEqual(fixture.requests, [{ path: "/memory/pre-compact", body: {
      version: 1, client: "cursor", sessionId, turnId, cwd: fixture.root,
      databasePath: fixture.databasePath, transcriptPath,
    } }]);
    await assert.rejects(readFile(join(fixture.home, "adapters", "cursor", "memory-skill-reminders.json")), { code: "ENOENT" });
    for (const patch of [{ conversation_id: "invalid" }, { generation_id: undefined },
      { workspace_roots: ["relative"] }, { session_id: turnId }]) {
      assert.equal((await runHook(fixture, { hook_event_name: "preCompact", ...patch })).stdout, "");
    }
    assert.equal(fixture.requests.length, 1);
  } finally { await fixture.close(); }
});

test("Cursor sessionStart uses only native output fields and explicit per-command CLI environment", async () => {
  const fixture = await createFixture();
  try {
    const result = await runHook(fixture, { hook_event_name: "sessionStart", session_id: sessionId,
      generation_id: undefined, transcript_path: null });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(output).sort(), ["additional_context", "env"]);
    assert.deepEqual(output.env, {
      MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT: "cursor",
      MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID: sessionId,
    });
    assert.match(output.additional_context, /memorax-code.*skill/);
    assert.match(output.additional_context, /explicitly set MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT=cursor/);
    assert.match(output.additional_context, /Do not assume shell tools inherit Hook environment variables/);
    assertMaintenanceContext(output.additional_context, fixture);
    assert.equal(fixture.requests.length, 0);
    const observed = JSON.parse(await readFile(join(fixture.home, "adapters", "cursor", "runtime-observed.json"), "utf8"));
    assert.equal(observed.runtimeDigest, fixture.runtimeDigest);
  } finally { await fixture.close(); }
});

test("Cursor sessionStart accepts the documented session_id alias", async () => {
  const fixture = await createFixture();
  try {
    const result = await runHook(fixture, { hook_event_name: "sessionStart",
      conversation_id: undefined, session_id: sessionId, generation_id: undefined, transcript_path: null });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.env, {
      MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT: "cursor",
      MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID: sessionId,
    });
    assert.match(output.additional_context, /MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID=/);
  } finally { await fixture.close(); }
});

test("Cursor sessionStart still injects generic context without a workspace", async () => {
  const fixture = await createFixture();
  try {
    const result = await runHook(fixture, { hook_event_name: "sessionStart",
      conversation_id: undefined, session_id: sessionId, workspace_roots: [],
      generation_id: undefined, transcript_path: null });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.match(output.additional_context, /the \`memorax-code\` skill/);
    assert.equal(fixture.requests.length, 0);
  } finally { await fixture.close(); }
});

test("Cursor projectless turns preserve General identity across Hook events", async () => {
  const fixture = await createFixture();
  try {
    const projectless = { workspace_roots: [] };
    await runHook(fixture, { hook_event_name: "beforeSubmitPrompt", prompt: "A projectless Cursor prompt.", ...projectless });
    assert.deepEqual(fixture.requests.filter(({ path }) => path === "/memory/turn-start").at(-1), {
      path: "/memory/turn-start", body: {
        version: 1, client: "cursor", sessionId, turnId, workspaceKind: "projectless",
        databasePath: fixture.databasePath, prompt: "A projectless Cursor prompt.",
      },
    });

    await runHook(fixture, { hook_event_name: "afterAgentResponse", text: "A projectless Cursor response.", ...projectless });
    assert.deepEqual(fixture.requests.filter(({ path }) => path === "/memory/writeback").at(-1), {
      path: "/memory/writeback", body: {
        version: 1, client: "cursor", sessionId, turnId, workspaceKind: "projectless",
        databasePath: fixture.databasePath, phase: "response",
        responseDigest: createHash("sha256").update("A projectless Cursor response.").digest("hex"),
      },
    });

    await runHook(fixture, { hook_event_name: "stop", status: "completed", ...projectless });
    assert.deepEqual(fixture.requests.filter(({ path }) => path === "/memory/writeback").at(-1), {
      path: "/memory/writeback", body: {
        version: 1, client: "cursor", sessionId, turnId, workspaceKind: "projectless",
        databasePath: fixture.databasePath, phase: "stop", status: "completed",
      },
    });

    await runHook(fixture, { hook_event_name: "preCompact", ...projectless });
    assert.deepEqual(fixture.requests.filter(({ path }) => path === "/memory/pre-compact").at(-1), {
      path: "/memory/pre-compact", body: {
        version: 1, client: "cursor", sessionId, turnId, workspaceKind: "projectless",
        databasePath: fixture.databasePath,
      },
    });
  } finally { await fixture.close(); }
});

test("Cursor rejects ambiguous native identities, multiroot workspaces and unsupported events", async () => {
  const fixture = await createFixture();
  try {
    const invalid = [
      { conversation_id: undefined }, { generation_id: undefined },
      { conversation_id: "not-a-native-id" }, { session_id: turnId },
      { workspace_roots: [fixture.root, fixture.root] },
      { workspace_roots: ["relative"] },
      { hook_event_name: "UserPromptSubmit", session_id: sessionId },
      { hook_event_name: "afterAgentThought", text: "private thought" },
      { hook_event_name: "stop", status: "unknown" },
      { hook_event_name: "afterAgentResponse", text: "" },
      { prompt: undefined },
    ];
    for (const patch of invalid) {
      const result = await runHook(fixture, { hook_event_name: "beforeSubmitPrompt", prompt: "test", ...patch });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, "");
    }
    assert.equal(fixture.requests.length, 0);
  } finally { await fixture.close(); }
});

test("Cursor Backend rejection never manufactures context or writeback content", async () => {
  const fixture = await createFixture();
  try {
    fixture.control.status = 503;
    const result = await runHook(fixture, { hook_event_name: "beforeSubmitPrompt", prompt: "test" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { continue: true });
    assert.equal(fixture.requests.length, 1);
    await assert.rejects(readFile(join(fixture.home, "adapters", "cursor", "memory-skill-reminders.json")), { code: "ENOENT" });
    fixture.control.status = 200;
    const retry = await runHook(fixture, { hook_event_name: "beforeSubmitPrompt", prompt: "test" });
    assert.match(JSON.parse(retry.stdout).additional_context, /MemoraX Code reminder:/);
  } finally { await fixture.close(); }
});

test("Cursor forwards a recorded database override without requiring GUI environment inheritance", async () => {
  const fixture = await createFixture({ recordDatabasePath: true });
  try {
    await runHook(fixture, { hook_event_name: "beforeSubmitPrompt", prompt: "test" });
    assert.equal(fixture.requests.find(({ path }) => path === "/memory/turn-start").body.databasePath, join(fixture.root, "custom-profile", "state.vscdb"));
    const changed = join(fixture.root, "other-profile", "state.vscdb");
    await runHook(fixture, { hook_event_name: "stop", status: "completed" }, { MEMORAX_CODE_CURSOR_DATABASE_PATH: changed });
    assert.equal(fixture.requests.at(-1).body.databasePath, changed);
    const count = fixture.requests.length;
    for (const override of ["", "relative.vscdb", "/invalid\npath"]) {
      const result = await runHook(fixture, { hook_event_name: "beforeSubmitPrompt", prompt: "test" },
        { MEMORAX_CODE_CURSOR_DATABASE_PATH: override });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(fixture.requests.length, count);
    }
  } finally { await fixture.close(); }
});

test("Cursor injects global profiles on the first prompt and procedures on turns 1, 6, and 11", async () => {
  const fixture = await createFixture();
  try {
    await createPersonalMemory(fixture.home);
    // A retrieval result is not part of Cursor's explicit-memory integration.
    fixture.control.body.additionalContext = "unexpected automatic search result";
    const expectedReminders = [];
    for (let index = 0; index < 11; index += 1) {
      const cadence = index % 5 === 0;
      const generation = generationId(index);
      const input = { hook_event_name: "beforeSubmitPrompt", generation_id: generation,
        prompt: `question ${index}`, transcript_path: null };
      const result = await runHook(fixture, input);
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.continue, true);
      const context = output.additional_context ?? "";
      assert.equal(context.includes("Prefer concise Cursor answers"), index === 0);
      assert.equal(context.includes("Run the focused Cursor test first"), cadence);
      assert.equal(context.includes("MemoraX Code reminder:"), cadence);
      assert.equal(context.includes("MemoraX Code personal-memory reminder:"), index === 0);
      if (cadence) assertMaintenanceContext(context, fixture);
      assert.doesNotMatch(context, /unexpected automatic search result|\$memorax-code/);
      assert.deepEqual(Object.keys(output).sort(), cadence ? ["additional_context", "continue"] : ["continue"]);
      if (context) expectedReminders.push({
        version: 1, client: "cursor", sessionId, turnId: generation, cwd: fixture.root,
        content: context, triggers: ["cadence"],
      });
      assert.deepEqual(fixture.requests.filter(({ path }) => path === "/memory/skill-reminder").map(({ body }) => body), expectedReminders);
      const duplicate = await runHook(fixture, input);
      assert.deepEqual(JSON.parse(duplicate.stdout), { continue: true });
      const continuation = await runHook(fixture, {
        hook_event_name: "beforeSubmitPrompt", generation_id: generationId(index + 10), prompt: "  ",
      });
      assert.deepEqual(JSON.parse(continuation.stdout), { continue: true });
    }
    const state = JSON.parse(await readFile(join(fixture.home, "adapters", "cursor", "memory-skill-reminders.json"), "utf8"));
    assert.equal(state.runtime, "cursor");
    assert.equal(state.sessions[sessionId].turnCount, 11);
    assert.equal(fixture.requests.filter(({ path }) => path === "/memory/skill-reminder").length, 3);
  } finally { await fixture.close(); }
});

test("Cursor shares global personal memory across workspaces without repository authority", async () => {
  const fixture = await createFixture();
  try {
    await createPersonalMemory(fixture.home);
    for (const [index, worktree] of [undefined, "relative-repo"].entries()) {
      const workspace = join(fixture.root, `workspace-${index}`);
      await mkdir(workspace);
      fixture.control.body.repoMemoryWorktree = worktree;
      const result = await runHook(fixture, { hook_event_name: "beforeSubmitPrompt",
        conversation_id: generationId(index + 20), workspace_roots: [workspace], prompt: "test global memory" });
      const context = JSON.parse(result.stdout).additional_context;
      assert.match(context, /MemoraX Code reminder:/);
      assert.match(context, /Prefer concise Cursor answers/);
      assert.match(context, /Run the focused Cursor test first/);
    }
  } finally { await fixture.close(); }
});

test("Cursor restores global profiles after compaction without advancing procedure cadence", async () => {
  const fixture = await createFixture();
  try {
    await createPersonalMemory(fixture.home);
    const env = { MEMORAX_CODE_MEMORY_SKILL_REMINDER_INTERVAL_TURNS: "3" };
    const prompt = (index) => runHook(fixture, { hook_event_name: "beforeSubmitPrompt",
      generation_id: generationId(index), prompt: `question ${index}` }, env);
    await prompt(0);
    const statePath = join(fixture.home, "adapters", "cursor", "memory-skill-reminders.json");
    const before = await readFile(statePath, "utf8");
    await runHook(fixture, { hook_event_name: "preCompact" }, env);
    assert.equal(await readFile(statePath, "utf8"), before);

    fixture.control.body.restorePersonalMemory = true;
    const restored = JSON.parse((await prompt(1)).stdout).additional_context;
    assert.match(restored, /Prefer concise Cursor answers/);
    assert.match(restored, /MemoraX Code personal-memory reminder:/);
    assertMaintenanceContext(restored, fixture);
    assert.doesNotMatch(restored, /Run the focused Cursor test first|MemoraX Code reminder:/);
    assert.deepEqual(fixture.requests.filter(({ path }) => path === "/memory/skill-reminder").at(-1).body.triggers,
      ["post_compaction"]);
    assert.equal(JSON.parse(await readFile(statePath, "utf8")).sessions[sessionId].supplementalReminderPending, false);

    fixture.control.body.restorePersonalMemory = false;
    assert.deepEqual(JSON.parse((await prompt(2)).stdout), { continue: true });
    const cadence = JSON.parse((await prompt(3)).stdout).additional_context;
    assert.match(cadence, /Run the focused Cursor test first/);
    assertMaintenanceContext(cadence, fixture);
    assert.doesNotMatch(cadence, /Prefer concise Cursor answers/);
    assert.deepEqual(fixture.requests.filter(({ path }) => path === "/memory/skill-reminder").at(-1).body.triggers,
      ["cadence"]);
  } finally { await fixture.close(); }
});

test("Cursor ignores restoration without an accepted real prompt or a boolean restore flag", async () => {
  const fixture = await createFixture();
  try {
    await createPersonalMemory(fixture.home);
    const env = { MEMORAX_CODE_MEMORY_SKILL_REMINDER_INTERVAL_TURNS: "10" };
    const cases = [
      { ok: false }, { recorded: false }, { prompt: "  " }, { restorePersonalMemory: "true" },
    ];
    for (const [index, { prompt = "next question", ...response }] of cases.entries()) {
      const conversation = generationId(index + 40);
      fixture.control.body = { ok: true, recorded: true };
      await runHook(fixture, { hook_event_name: "beforeSubmitPrompt", conversation_id: conversation,
        generation_id: generationId(100), prompt: "first question" }, env);
      fixture.control.body = { ok: true, recorded: true, restorePersonalMemory: true, ...response };
      const result = await runHook(fixture, { hook_event_name: "beforeSubmitPrompt", conversation_id: conversation,
        generation_id: generationId(101), prompt }, env);
      assert.deepEqual(JSON.parse(result.stdout), { continue: true });
      const state = JSON.parse(await readFile(join(fixture.home, "adapters", "cursor", "memory-skill-reminders.json"), "utf8"));
      assert.equal(state.sessions[conversation].supplementalReminderPending, undefined);
    }
    assert.equal(fixture.requests.filter(({ path, body }) => path === "/memory/skill-reminder"
      && body.triggers.includes("post_compaction")).length, 0);
  } finally { await fixture.close(); }
});

test("Cursor skips invalid or untrusted personal files and preserves generic reminders", async () => {
  const fixture = await createFixture();
  try {
    await createPersonalMemory(fixture.home);
    const preferences = join(fixture.home, "personal-memory", "user-profile", "preferences.md");
    const procedure = join(fixture.home, "personal-memory", "procedure-memory", "testing.md");
    await writeFile(preferences, "invalid profile with Prefer concise Cursor answers");
    await writeFile(procedure, "");
    const invalid = await runHook(fixture, { hook_event_name: "beforeSubmitPrompt", prompt: "invalid files" });
    assert.match(JSON.parse(invalid.stdout).additional_context, /MemoraX Code reminder:/);
    assert.doesNotMatch(JSON.parse(invalid.stdout).additional_context, /Prefer concise Cursor answers|Run the focused Cursor test first/);

    await createPersonalMemory(fixture.home);
    for (const path of [preferences, procedure]) {
      const outside = `${path}.outside`;
      await writeFile(outside, await readFile(path));
      await rm(path);
      await symlink(outside, path);
    }
    const linked = await runHook(fixture, { hook_event_name: "beforeSubmitPrompt",
      conversation_id: generationId(30), prompt: "linked files" });
    assert.match(JSON.parse(linked.stdout).additional_context, /MemoraX Code reminder:/);
    assert.doesNotMatch(JSON.parse(linked.stdout).additional_context, /Prefer concise Cursor answers|Run the focused Cursor test first/);
  } finally { await fixture.close(); }
});

test("Cursor requires a successful Backend result before consuming the first reminder", async () => {
  const fixture = await createFixture();
  try {
    for (const body of [{ ok: false }, { ok: true, recorded: false }, { ok: true }, {}, null]) {
      fixture.control.body = body;
      const result = await runHook(fixture, { hook_event_name: "beforeSubmitPrompt", prompt: "retry later" });
      assert.deepEqual(JSON.parse(result.stdout), { continue: true });
      await assert.rejects(readFile(join(fixture.home, "adapters", "cursor", "memory-skill-reminders.json")), { code: "ENOENT" });
    }
    fixture.control.body = { ok: true, recorded: true };
    const result = await runHook(fixture, { hook_event_name: "beforeSubmitPrompt", prompt: "retry later" });
    assert.match(JSON.parse(result.stdout).additional_context, /MemoraX Code reminder:/);
    assertMaintenanceContext(JSON.parse(result.stdout).additional_context, fixture);
  } finally { await fixture.close(); }
});

test("Cursor missing-bundle initialization delegates once using only the accepted worktree", async () => {
  const fixture = await createFixture();
  try {
    const repo = join(fixture.root, "authorized repo");
    await mkdir(repo);
    for (const args of [["init", "--quiet"], ["config", "user.name", "Fixture"],
      ["config", "user.email", "fixture@example.invalid"], ["config", "commit.gpgsign", "false"],
      ["commit", "--quiet", "--allow-empty", "-m", "fixture"]]) execFileSync("git", args, { cwd: repo });
    fixture.control.body.repoMemoryWorktree = repo;
    const result = await runHook(fixture, { hook_event_name: "beforeSubmitPrompt", prompt: "inspect this repo" }, { MEMORAX_CODE_CURSOR_HOOK_DEBUG: "1" });
    assert.equal(result.status, 0, result.stderr);
    const context = JSON.parse(result.stdout).additional_context;
    assert.match(context, /missing Repo Memory build: launch this native background delegation once/, result.stderr);
    assert.match(context, /memorax-repo-memory/);
    assert.match(context, /claim/);
    const delegation = JSON.parse(context.split("\n").find(line => line.startsWith('{"name":"memorax-repo-memory"')));
    const invocation = JSON.parse(delegation.prompt.split("\n").find(line => line.startsWith('{"executable":')));
    assert.equal(invocation.args[invocation.args.indexOf("--repo") + 1], realpathSync(repo),
      "Delegation must retain the Backend-authorized repository");
    const repeat = await runHook(fixture, { hook_event_name: "beforeSubmitPrompt", prompt: "inspect this repo" });
    assert.doesNotMatch(repeat.stdout, /missing Repo Memory build/);
    assert.equal(fixture.requests.filter(({ path }) => path === "/memory/skill-reminder").length, 1);
    assert.doesNotMatch(fixture.requests.find(({ path }) => path === "/memory/skill-reminder").body.content,
      /--ticket/, "Private delegation tickets must not be copied into reminder trace records");
  } finally { await fixture.close(); }
});

test("Cursor skips native initialization without real-prompt and repository authority", async () => {
  const fixture = await createFixture();
  try {
    const repo = join(fixture.root, "repo");
    await mkdir(repo);
    for (const args of [["init", "--quiet"], ["config", "user.name", "Fixture"],
      ["config", "user.email", "fixture@example.invalid"], ["config", "commit.gpgsign", "false"],
      ["commit", "--quiet", "--allow-empty", "-m", "fixture"]]) execFileSync("git", args, { cwd: repo });
    for (const [body, prompt] of [
      [{ ok: true, recorded: true, repoMemoryWorktree: repo }, "  "],
      [{ ok: true, recorded: false, repoMemoryWorktree: repo }, "question"],
      [{ ok: true, recorded: true }, "question"],
      [{ ok: true, recorded: true, repoMemoryWorktree: "relative" }, "question"],
    ]) {
      fixture.control.body = body;
      assert.doesNotMatch((await runHook(fixture, { hook_event_name: "beforeSubmitPrompt", prompt })).stdout,
        /missing Repo Memory build/);
    }
    await mkdir(join(repo, ".repo_memory"));
    await writeFile(join(repo, ".repo_memory", "PROFILE.md"), "Existing profile: read-triggered maintenance owns validation.");
    fixture.control.body = { ok: true, recorded: true, repoMemoryWorktree: repo };
    assert.doesNotMatch((await runHook(fixture, { hook_event_name: "beforeSubmitPrompt", prompt: "question" })).stdout,
      /missing Repo Memory build/);
    await assert.rejects(readFile(join(fixture.home, "repo-memory-jobs")), { code: "ENOENT" });
  } finally { await fixture.close(); }
});

function assertMaintenanceContext(context, fixture) {
  const prefix = "MemoraX Code Repo Memory maintenance for this Cursor session: ";
  const line = context.split("\n").find(line => line.startsWith(prefix));
  assert.ok(line, "Cursor must supply its own maintenance entrypoint without shell environment inheritance");
  assert.deepEqual(JSON.parse(line.slice(prefix.length)), {
    executable: process.execPath,
    helper: realpathSync(join(dirname(fixture.runtimePath), "repo-memory-job.mjs")),
    env: { MEMORAX_CODE_HOME: fixture.home },
  });
  assert.match(context, /native Task tool/);
  assert.match(context, /foreground task without waiting/);
  assert.match(context, /takes precedence over any Skill-relative maintenance helper, including an imported Claude Skill/);
  assert.match(context, /stop maintenance without falling back to another client's helper/);
}

function generationId(index) {
  return `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`;
}

test("Cursor reminder trace failure does not hold the prompt Hook until its native timeout", async () => {
  const fixture = await createFixture();
  try {
    fixture.control.stallReminder = true;
    const started = Date.now();
    const result = await runHook(fixture, { hook_event_name: "beforeSubmitPrompt", prompt: "test trace timeout" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(JSON.parse(result.stdout).additional_context, /MemoraX Code reminder:/);
    assert.ok(Date.now() - started < 5000, "best-effort trace must leave time for native Hook completion");
    assert.equal(fixture.requests.filter(({ path }) => path === "/memory/skill-reminder").length, 1);
  } finally { await fixture.close(); }
});


test("installed Cursor Hook budget covers cold recovery before delivering the event", async () => {
  const fixture = await createFixture();
  const pidPath = join(fixture.root, "recovery.pid");
  try {
    const manifest = JSON.parse(await readFile(join(fixture.cursorHome, "hooks.json"), "utf8"));
    for (const hooks of Object.values(manifest.hooks)) {
      assert.ok(hooks[0].timeout * 1000 > DEFAULT_ENSURE_BACKEND_START_TIMEOUT_MS + 1500 + 12000,
        "native deadline must allow recovery and event delivery");
    }
    fixture.control.healthy = false;
    const command = join(fixture.root, "slow-recovery.mjs");
    await writeFile(command, 'import fs from "node:fs";fs.writeFileSync(' + JSON.stringify(pidPath) + ',String(process.pid));setTimeout(()=>process.exit(0),16000);');
    const result = await runHook(fixture, { hook_event_name: "beforeSubmitPrompt", prompt: "cold recovery" }, {
      MEMORAX_CODE_CURSOR_ENSURE_BACKEND: "true",
      MEMORAX_CODE_CURSOR_LIFECYCLE_COMMAND: command,
    }, manifest.hooks.beforeSubmitPrompt[0].timeout * 1000);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).continue, true);
    assert.equal(fixture.requests.filter(request => request.path === "/memory/turn-start").length, 1);
    assert.ok(Number(await readFile(pidPath, "utf8")) > 0, "recovery command must have run");
  } finally {
    try { process.kill(Number(await readFile(pidPath, "utf8")), "SIGTERM"); } catch {}
    await fixture.close();
  }
});

test("Cursor recovery overrides stay within the installed native Hook budget", async () => {
  const fixture = await createFixture();
  try {
    const captured = join(fixture.root, "recovery-options.json");
    const helper = join(dirname(dirname(fixture.runtimePath)), "memorax-code-adapter-common/src/hooks/ensure-backend-runner.mjs");
    await writeFile(helper, 'import fs from "node:fs";export const DEFAULT_ENSURE_BACKEND_START_TIMEOUT_MS=90000;export async function ensureBackendAvailable(options){fs.writeFileSync(' + JSON.stringify(captured) + ',JSON.stringify({health:options.healthTimeoutValue,start:options.startTimeoutValue}));}');
    for (const [health, start, expected] of [
      ["999999", "999999", { health: 1500, start: 90000 }],
      ["100", "200", { health: 100, start: 200 }],
      ["invalid", "-1", { health: 1500, start: 90000 }],
    ]) {
      const result = await runHook(fixture, { hook_event_name: "sessionStart" }, {
        MEMORAX_CODE_CURSOR_ENSURE_TIMEOUT_MS: health, MEMORAX_CODE_CURSOR_START_TIMEOUT_MS: start,
      });
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(await readFile(captured, "utf8")), expected);
    }
  } finally { await fixture.close(); }
});

async function createPersonalMemory(home) {
  await mkdir(join(home, "personal-memory", "procedure-memory"), { recursive: true });
  await mkdir(join(home, "personal-memory", "user-profile"), { recursive: true });
  await writeFile(join(home, "personal-memory", "procedure-memory", "testing.md"),
    "# Testing workflow\n\nRun the focused Cursor test first.\n");
  await writeFile(join(home, "personal-memory", "user-profile", "preferences.md"), [
    "---", 'schema: "user_profile_memory.v0.1"', 'scope: "user"',
    'owner: "user-profile-memory"', 'trust_state: "user_stated"',
    "active_count: 1", "total_count: 1", "---", "", "## Preference pref_concise",
    "- Status: `active`", "- Type: `communication`", "- Confidence: `explicit`",
    "- Created: `2026-09-18T00:00:00.000Z`", "- Updated: `2026-09-18T00:00:00.000Z`",
    "- Description: Prefer concise Cursor answers", "- Applies when: Always", "- Do not apply when: -", "",
  ].join("\n"));
}

async function createFixture({ recordDatabasePath = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-cursor-hook-"));
  const home = join(root, "state");
  const cursorHome = join(root, "cursor");
  const requests = [];
  const guidanceRequests = [];
  const control = { status: 200, body: { ok: true, recorded: true }, stallReminder: false };
  const server = createServer(async (request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: control.healthy !== false, service: "memorax-code-backend" }));
      return;
    }
    if (request.url === "/memory/search-guidance" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ enabled: control.guidance?.ok === true }));
      return;
    }
    let text = "";
    for await (const chunk of request) text += chunk;
    if (request.url === "/memory/search-guidance") {
      guidanceRequests.push(JSON.parse(text));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(control.guidance ?? { ok: false, reason: "disabled" }));
      return;
    }
    requests.push({ path: request.url, body: JSON.parse(text) });
    if (request.url === "/memory/skill-reminder" && control.stallReminder) return;
    response.writeHead(control.status, { "content-type": "application/json" });
    response.end(JSON.stringify(control.body));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const databaseEnv = { APPDATA: join(root, "appdata"), USERPROFILE: root };
  const previousDatabasePath = process.env.MEMORAX_CODE_CURSOR_DATABASE_PATH;
  let installed;
  try {
    if (recordDatabasePath) process.env.MEMORAX_CODE_CURSOR_DATABASE_PATH = join(root, "custom-profile", "state.vscdb");
    else delete process.env.MEMORAX_CODE_CURSOR_DATABASE_PATH;
    installed = await enableCursorAdapter({ cursorHome, memoraxCodeHome: home, memoraxCodeCommand: process.execPath });
  } finally {
    if (previousDatabasePath === undefined) delete process.env.MEMORAX_CODE_CURSOR_DATABASE_PATH;
    else process.env.MEMORAX_CODE_CURSOR_DATABASE_PATH = previousDatabasePath;
  }
  assert.equal(installed.ok, true, installed.error);
  const state = JSON.parse(await readFile(installed.statePath, "utf8"));
  return { root, home, cursorHome, requests, guidanceRequests, control, server, runtimePath: state.runtimePath,
    databasePath: cursorDatabasePath({ env: databaseEnv, home: root }),
    runtimeDigest: state.runtimeDigest,
    async close() {
      await new Promise(resolve => server.close(resolve));
      const jobs = join(home, "repo-memory-jobs");
      const entries = await readdir(jobs).catch(error => { if (error.code === "ENOENT") return []; throw error; });
      const pids = [];
      for (const name of entries.filter(name => name !== "in-progress")) {
        const state = JSON.parse(await readFile(join(jobs, name, "job.json"), "utf8"));
        if (Number.isSafeInteger(state.leasePid) && state.leasePid > 0) pids.push(state.leasePid);
      }
      // Guards must release their Windows working-directory handles before root removal.
      await rm(jobs, { recursive: true, force: true });
      await Promise.all(pids.map(waitForFixtureLeaseExit));
      await rm(root, { recursive: true, force: true });
    },
  };
}

function runHook(fixture, input, env = {}, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture.runtimePath, "--memorax-code-cursor-hook-v1"], {
      cwd: fixture.root, env: {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
        HOME: fixture.root, USERPROFILE: fixture.root,
        APPDATA: join(fixture.root, "appdata"), LOCALAPPDATA: join(fixture.root, "localappdata"),
        TMPDIR: fixture.root, TEMP: fixture.root, TMP: fixture.root,
        MEMORAX_CODE_HOME: fixture.home, CURSOR_HOME: fixture.cursorHome,
        MEMORAX_CODE_CURSOR_AGENT_COMMAND: join(fixture.root, "missing-cursor-agent"),
        MEMORAX_CODE_CURSOR_ENSURE_BACKEND: "false",
        MEMORAX_CODE_BACKEND_URL: `http://127.0.0.1:${fixture.server.address().port}`,
        ...env,
      }, stdio: ["pipe", "pipe", "pipe"], timeout: timeoutMs,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", status => resolve({ status, stdout: stdout.trim(), stderr }));
    child.stdin.end(JSON.stringify({ conversation_id: sessionId, generation_id: turnId,
      workspace_roots: [fixture.root], ...input }));
  });
}

async function waitForFixtureLeaseExit(pid) {
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === "ESRCH") return; throw error; }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  try { process.kill(pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
  assert.fail("fixture lease guard did not stop within its cleanup budget");
}

test("Cursor evaluates Jev on every prompt while keeping bootstrap and personal memory", async () => {
  const fixture = await createFixture();
  try {
    fixture.control.guidance = { ok: true, decision: "skip" };
    const bootstrap = JSON.parse((await runHook(fixture, { hook_event_name: "sessionStart" })).stdout);
    assert.doesNotMatch(bootstrap.additional_context, /proactively invoke/);
    assert.match(bootstrap.additional_context, /personal-memory reminder/);
    assertMaintenanceContext(bootstrap.additional_context, fixture);
    const first = JSON.parse((await runHook(fixture, { hook_event_name: "beforeSubmitPrompt", prompt: "First task" })).stdout);
    assert.doesNotMatch(first.additional_context, /proactively invoke|Jev selected/);
    assert.match(first.additional_context, /personal-memory reminder/);
    assert.deepEqual(fixture.guidanceRequests[0], fixture.requests.find(({ path }) => path === "/memory/turn-start").body);
    for (let turn = 2; turn <= 6; turn += 1) {
      fixture.control.guidance = { ok: true, decision: "search" };
      const output = JSON.parse((await runHook(fixture, {
        hook_event_name: "beforeSubmitPrompt", prompt: "Next task",
        generation_id: "22222222-2222-4222-8222-" + String(turn).padStart(12, "0"),
      })).stdout);
      assert.match(output.additional_context, /Jev selected Coding Memory search/);
      assert.match(output.additional_context, /the `memorax-code` skill/);
      assert.match(output.additional_context, /references\/memorax-search\.md/);
      assert.doesNotMatch(output.additional_context, /search --query|without rereading|\$memorax-code/);
      assert.match(output.additional_context, /Natural final-answer mention/);
      assert.doesNotMatch(output.additional_context, /proactively invoke/);
    }
    assert.equal(fixture.guidanceRequests.length, 6);
  } finally { await fixture.close(); }
});
