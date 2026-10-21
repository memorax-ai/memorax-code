import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fixture, hook, hookInput, json } from "./support.mjs";

const PROFILE_MARKER = "SYNTHETIC_PROFILE_CONTEXT";
const PROCEDURE_MARKER = "SYNTHETIC_PROCEDURE_CONTEXT";

test("first and periodic reminders inject personal context without counting duplicate native turns", async (t) => {
  const f = await fixture(t, { server: true });
  await writePersonalContext(f);
  const profileTurns = [];
  const procedureTurns = [];
  for (let turn = 1; turn <= 11; turn += 1) {
    const context = await submit(f, turn);
    if (context.includes(PROFILE_MARKER)) profileTurns.push(turn);
    if (context.includes(PROCEDURE_MARKER)) procedureTurns.push(turn);
    assert.equal(await submit(f, turn), "");
  }
  assert.deepEqual(profileTurns, [1]);
  assert.deepEqual(procedureTurns, [1, 6, 11]);
  assert.equal((await reminderState(f)).turnCount, 11);
  assert.equal(f.requests.filter((request) => request.path === "/memory/search-guidance").length, 11);
  assert.deepEqual(f.requests.filter((request) => request.path === "/memory/skill-reminder")
    .map((request) => request.body.turnId), ["turn-1", "turn-6", "turn-11"]);
});

test("resume preserves reminder cadence while a new native session receives initial context", async (t) => {
  const f = await fixture(t, { server: true });
  await writePersonalContext(f);
  assert.match(await submit(f, 1), new RegExp(PROFILE_MARKER));
  const resumed = await hook(f, hookInput(f, { hook_event_name: "SessionStart", source: "resume" }));
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(resumed.stdout, "");
  assert.equal((await reminderState(f)).turnCount, 1);
  assert.equal(await submit(f, 2), "");
  const newSession = "qoder-new-session";
  const context = await submit(f, 1, { session_id: newSession });
  assert.match(context, new RegExp(PROFILE_MARKER));
  assert.match(context, new RegExp(PROCEDURE_MARKER));
  assert.equal((await reminderState(f)).turnCount, 2);
  assert.equal((await reminderState(f, newSession)).turnCount, 1);
});

test("SessionStart compact refreshes Profile once on the next prompt without resetting cadence", async (t) => {
  const f = await fixture(t, { server: true });
  await writePersonalContext(f);
  await submit(f, 1);
  const refreshedProfile = "SYNTHETIC_PROFILE_AFTER_COMPACT";
  await writePersonalContext(f, refreshedProfile);
  const compact = await hook(f, hookInput(f, {
    hook_event_name: "SessionStart", source: "compact", request_set_id: undefined, prompt: undefined,
  }));
  assert.equal(compact.status, 0, compact.stderr);
  assert.equal(compact.stdout, "");
  assert.equal((await reminderState(f)).turnCount, 1);
  assert.equal((await reminderState(f)).supplementalReminderPending, true);
  const context = await submit(f, 2);
  assert.match(context, new RegExp(refreshedProfile));
  assert.match(context, /personal-memory reminder/);
  assert.equal(context.includes(PROFILE_MARKER), false);
  assert.equal(context.includes(PROCEDURE_MARKER), false);
  assert.equal((await reminderState(f)).supplementalReminderPending, false);
  assert.equal(await submit(f, 3), "");
  assert.equal((await reminderState(f)).turnCount, 3);
  const reminder = f.requests.find((request) => request.path === "/memory/skill-reminder" && request.body.turnId === "turn-2");
  assert.equal(reminder.body.triggers.includes("post_compaction"), true);
});

test("mock Jev search bypasses cadence while skip and unavailable guidance retain separate fallback rules", async (t) => {
  const f = await fixture(t, { server: true });
  await writeFile(join(f.memoraxCodeHome, "config.toml"), "[memory.skill_reminder]\ninterval_turns = 3\n");
  await submit(f, 1);
  f.searchGuidance = { ok: true, decision: "search" };
  const search = await submit(f, 2);
  assert.match(search, /Jev selected Coding Memory search/);
  assert.match(search, /references\/memorax-search\.md completely/);
  assert.equal(search.includes("proactively invoke"), false);
  f.searchGuidance = { ok: false };
  assert.equal(await submit(f, 3), "");
  assert.match(await submit(f, 4), /proactively invoke the `memorax-code` skill/);
  f.searchGuidance = { ok: true, decision: "skip" };
  for (let turn = 5; turn <= 7; turn += 1) {
    assert.equal((await submit(f, turn)).includes("proactively invoke"), false);
  }
  assert.equal(f.requests.filter((request) => request.path === "/memory/search-guidance").length, 7);
});

test("Backend loss between SessionStart and Submit retains local context without starting recovery", async (t) => {
  const f = await fixture(t, { server: true });
  await writePersonalContext(f);
  const marker = join(f.root, "unexpected-recovery");
  await writeFile(f.options.memoraxCodeCommand, `import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(marker)},'started');\n`);
  const started = await hook(f, hookInput(f, { hook_event_name: "SessionStart", source: "startup" }));
  assert.equal(started.status, 0, started.stderr);
  assert.deepEqual(f.requests.map((request) => request.path), ["/health"]);
  const backendUrl = `http://127.0.0.1:${f.server.address().port}`;
  await new Promise((resolve) => f.server.close(resolve));
  f.server = undefined;
  const result = await hook(f, hookInput(f), { MEMORAX_CODE_BACKEND_URL: backendUrl });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(PROFILE_MARKER));
  assert.match(result.stdout, new RegExp(PROCEDURE_MARKER));
  assert.equal(existsSync(marker), false);
  assert.equal((await reminderState(f)).turnCount, 1);
});

async function submit(f, turn, overrides = {}) {
  const result = await hook(f, hookInput(f, { request_set_id: `turn-${turn}`, ...overrides }));
  assert.equal(result.status, 0, result.stderr);
  return result.stdout ? JSON.parse(result.stdout).hookSpecificOutput?.additionalContext ?? "" : "";
}

async function reminderState(f, sessionId = "qoder-session-1") {
  const state = await json(join(f.memoraxCodeHome, "adapters", "qoder", "memory-skill-reminders.json"));
  return state.sessions[sessionId];
}

async function writePersonalContext(f, description = PROFILE_MARKER) {
  const personalHome = join(f.memoraxCodeHome, "personal-memory");
  await mkdir(join(personalHome, "user-profile"), { recursive: true });
  await mkdir(join(personalHome, "procedure-memory"), { recursive: true });
  await writeFile(join(personalHome, "user-profile", "preferences.md"), [
    "---", "schema: user_profile_memory.v0.1", "scope: user", "owner: user-profile-memory",
    "trust_state: user_stated", "active_count: 1", "total_count: 1", "---", "",
    "## Preference pref_synthetic", "- Status: active", "- Type: communication",
    "- Confidence: explicit", "- Created: 2026-01-01", "- Updated: 2026-01-01",
    `- Description: ${description}`, "- Applies when: Synthetic adapter tests.", "- Do not apply when: -", "",
  ].join("\n"));
  await writeFile(join(personalHome, "procedure-memory", "synthetic.md"), `# Synthetic procedure\n\n${PROCEDURE_MARKER}\n`);
}
