import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { enableTraeAdapter } from "../src/config.mjs";

test("Trae UserPromptSubmit records one Turn and injects memory context", async () => {
  const fixture = await createFixture("prompt", { withProcedureMemory: true });
  try {
    const result = await runHook(fixture, {
      hook_event_name: "UserPromptSubmit",
      session_id: "trae-session-1",
      prompt: "remember the validated Trae Hook flow",
      cwd: fixture.root,
    });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(output.hookSpecificOutput.additionalContext, /^memory context\n\nMemoraX Code reminder:/);
    assert.match(output.hookSpecificOutput.additionalContext, /Natural final-answer mention for supported coding agents:/);
    assert.match(output.hookSpecificOutput.additionalContext, /Run the focused Trae adapter test first/);

    const turnStart = fixture.requests.find((request) => request.path === "/memory/turn-start");
    assert.equal(turnStart.body.client, "trae");
    assert.equal(turnStart.body.sessionId, "trae-session-1");
    assert.equal(turnStart.body.prompt, "remember the validated Trae Hook flow");
    assert.match(turnStart.body.turnId, /^trae-session-1:[1-9]\d*:[a-f0-9]{64}$/);

    const reminder = fixture.requests.find((request) => request.path === "/memory/skill-reminder");
    assert.equal(reminder.body.turnId, turnStart.body.turnId);
    assert.deepEqual(reminder.body.triggers, ["cadence"]);

    const turns = JSON.parse(await readFile(join(fixture.root, "adapters", "trae", "active-turns.json"), "utf8"));
    assert.equal(turns.sessions["trae-session-1"].turnId, turnStart.body.turnId);
    const observed = JSON.parse(await readFile(join(fixture.root, "adapters", "trae", "runtime-observed.json"), "utf8"));
    assert.equal(observed.runtimeDigest, fixture.runtimeDigest);
  } finally {
    await fixture.close();
  }
});

test("Trae Stop writes the matching Hook pair and clears only an accepted Turn", async () => {
  const fixture = await createFixture("stop");
  try {
    await runHook(fixture, {
      hook_event_name: "UserPromptSubmit",
      session_id: "trae-session-2",
      prompt: "pair this prompt with the final answer",
      cwd: fixture.root,
    });
    const turnStart = fixture.requests.find((request) => request.path === "/memory/turn-start");
    const turnsPath = join(fixture.root, "adapters", "trae", "active-turns.json");
    const before = JSON.parse(await readFile(turnsPath, "utf8"));
    const stopInput = {
      hook_event_name: "Stop",
      session_id: "trae-session-2",
      last_assistant_message: "validated final answer",
      text_content: "validated final answer",
      cwd: fixture.root,
    };

    for (const reply of [
      { status: 503, body: { ok: false } },
      { status: 200, body: { ok: true, scheduled: false } },
    ]) {
      fixture.control.writebackReply = async () => reply;
      const rejected = await runHook(fixture, stopInput);
      assert.equal(rejected.status, 0, rejected.stderr);
      assert.equal(rejected.stdout, "");
      assert.deepEqual(JSON.parse(await readFile(turnsPath, "utf8")), before);
    }

    fixture.control.writebackReply = async () => ({ status: 200, body: { ok: true, scheduled: true } });
    const stop = await runHook(fixture, stopInput);

    assert.equal(stop.status, 0, stop.stderr);
    const writebacks = fixture.requests.filter((request) => request.path === "/memory/writeback");
    const expectedWriteback = {
      version: 1,
      client: "trae",
      sessionId: "trae-session-2",
      turnId: turnStart.body.turnId,
      prompt: "pair this prompt with the final answer",
      lastAssistantMessage: "validated final answer",
      cwd: fixture.root,
    };
    assert.deepEqual(writebacks.map(({ body }) => body), Array(3).fill(expectedWriteback));
    const turns = JSON.parse(await readFile(turnsPath, "utf8"));
    assert.deepEqual(turns.sessions, {});
  } finally {
    await fixture.close();
  }
});

test("Trae Stop fails closed when its assistant fields conflict", async () => {
  const fixture = await createFixture("conflict");
  try {
    await runHook(fixture, {
      hook_event_name: "UserPromptSubmit",
      session_id: "trae-session-3",
      prompt: "retain this turn",
      cwd: fixture.root,
    });
    const before = await readFile(join(fixture.root, "adapters", "trae", "active-turns.json"), "utf8");

    const stop = await runHook(fixture, {
      hook_event_name: "Stop",
      session_id: "trae-session-3",
      last_assistant_message: "first answer",
      text_content: "conflicting answer",
      cwd: fixture.root,
    });

    assert.equal(stop.status, 0, stop.stderr);
    assert.equal(fixture.requests.some((request) => request.path === "/memory/writeback"), false);
    assert.equal(await readFile(join(fixture.root, "adapters", "trae", "active-turns.json"), "utf8"), before);
  } finally {
    await fixture.close();
  }
});

test("Trae retains the previous accepted Turn when a replacement start is rejected", async () => {
  const fixture = await createFixture("rejected-replacement");
  try {
    await runHook(fixture, {
      hook_event_name: "UserPromptSubmit",
      session_id: "trae-session-4",
      prompt: "retain the accepted turn",
      cwd: fixture.root,
    });
    const turnsPath = join(fixture.root, "adapters", "trae", "active-turns.json");
    const before = await readFile(turnsPath, "utf8");
    fixture.control.rejectNextTurnStart = true;

    const rejected = await runHook(fixture, {
      hook_event_name: "UserPromptSubmit",
      session_id: "trae-session-4",
      prompt: "do not persist this rejected replacement",
      cwd: fixture.root,
    });

    assert.equal(rejected.status, 0, rejected.stderr);
    assert.equal(rejected.stdout, "");
    assert.equal(await readFile(turnsPath, "utf8"), before);
    const starts = fixture.requests.filter((request) => request.path === "/memory/turn-start");
    assert.equal(starts.length, 2);
    assert.notEqual(starts[0].body.turnId, starts[1].body.turnId);
  } finally {
    await fixture.close();
  }
});

test("Trae delayed Stop acceptance preserves a newer active Turn", async () => {
  let notifyReceived;
  let releaseReply;
  const received = new Promise((resolve) => { notifyReceived = resolve; });
  const replyReleased = new Promise((resolve) => { releaseReply = resolve; });
  const fixture = await createFixture("delayed-stop");
  let pendingStop;
  let stopCompleted = false;
  try {
    const promptInput = {
      hook_event_name: "UserPromptSubmit",
      session_id: "trae-overlapping-turns",
      prompt: "first prompt",
      cwd: fixture.root,
    };
    const first = await runHook(fixture, promptInput);
    assert.equal(first.status, 0, first.stderr);
    const turnsPath = join(fixture.root, "adapters", "trae", "active-turns.json");
    const firstTurn = JSON.parse(await readFile(turnsPath, "utf8")).sessions[promptInput.session_id];
    fixture.control.writebackReply = async (body) => {
      notifyReceived(body);
      await replyReleased;
      return { status: 200, body: { ok: true, scheduled: true } };
    };
    pendingStop = runHook(fixture, {
      hook_event_name: "Stop",
      session_id: promptInput.session_id,
      last_assistant_message: "first answer",
      cwd: fixture.root,
    }).then((result) => {
      stopCompleted = true;
      return result;
    });
    const oldWriteback = await Promise.race([
      received,
      pendingStop.then((result) => assert.fail(`Stop exited before writeback: ${JSON.stringify(result)}`)),
    ]);
    assert.equal(oldWriteback.turnId, firstTurn.turnId);
    assert.equal(oldWriteback.prompt, "first prompt");

    const next = await runHook(fixture, { ...promptInput, prompt: "second prompt" });
    assert.equal(next.status, 0, next.stderr);
    const replacement = JSON.parse(await readFile(turnsPath, "utf8"));
    assert.notEqual(replacement.sessions[promptInput.session_id].turnId, firstTurn.turnId);
    assert.equal(replacement.sessions[promptInput.session_id].prompt, "second prompt");
    assert.equal(stopCompleted, false, "the old Stop must still be waiting for acceptance");

    releaseReply();
    const oldStop = await pendingStop;
    assert.equal(oldStop.status, 0, oldStop.stderr);
    const afterStop = JSON.parse(await readFile(turnsPath, "utf8"));
    assert.deepEqual(afterStop.sessions, replacement.sessions);
    assert.equal(fixture.requests.filter(({ path }) => path === "/memory/writeback").length, 1);
  } finally {
    releaseReply();
    await Promise.allSettled([pendingStop]);
    await fixture.close();
  }
});

test("Trae restores authorized Profile after compact and keeps Procedure Memory on cadence", async () => {
  const fixture = await createFixture("personal-memory", { withProcedureMemory: true, intervalTurns: 2 });
  try {
    const profileDir = join(fixture.repoMemoryWorktree, ".repo_memory", "user-profile");
    await mkdir(profileDir, { recursive: true });
    await writeFile(join(profileDir, "preferences.md"), [
      "---",
      'schema: "repo_user_profile_memory.v0.1"',
      'scope: "repo"',
      'owner: "repo-user-profile-memory"',
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
      "- Description: Prefer concise Trae answers",
      "- Applies when: Always",
      "- Do not apply when: -",
      "",
    ].join("\n"));
    const expectedReminders = [];
    const sessionId = "trae-personal-memory";
    const scenarios = [
      { profile: true, procedure: true, triggers: ["cadence"] },
      { profile: true, procedure: false, triggers: ["post_compaction"] },
      { profile: false, procedure: true, triggers: ["cadence"] },
      { profile: false, procedure: false, triggers: [] },
    ];
    for (const [index, scenario] of scenarios.entries()) {
      if (index === 1) {
        const requestCount = fixture.requests.length;
        const compact = await runHook(fixture, {
          hook_event_name: "SessionStart", session_id: sessionId, source: "compact", cwd: fixture.root,
        });
        assert.equal(compact.status, 0, compact.stderr);
        assert.equal(compact.stdout, "");
        assert.deepEqual(fixture.requests.slice(requestCount).filter(({ path }) => path !== "/health"), []);
      }
      const result = await runHook(fixture, {
        hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: `prompt ${index + 1}`, cwd: fixture.root,
      });
      assert.equal(result.status, 0, result.stderr);
      const output = JSON.parse(result.stdout);
      assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
      const context = output.hookSpecificOutput.additionalContext;
      assert.equal(context.includes("Prefer concise Trae answers"), scenario.profile);
      assert.equal(context.includes("Run the focused Trae adapter test first"), scenario.procedure);
      assert.equal(context.includes("MemoraX Code reminder:"), scenario.procedure);
      assert.equal(context.includes("MemoraX Code personal-memory reminder:"), scenario.profile);
      if (scenario.triggers.length) {
        assert.match(context, /^memory context\n\n/);
        const turnStart = fixture.requests.filter(({ path }) => path === "/memory/turn-start").at(-1);
        expectedReminders.push({
          version: 1, client: "trae", sessionId, turnId: turnStart.body.turnId, cwd: fixture.root,
          content: context.slice("memory context\n\n".length), triggers: scenario.triggers,
        });
      } else {
        assert.equal(context, "memory context");
      }
      assert.deepEqual(
        fixture.requests.filter(({ path }) => path === "/memory/skill-reminder").map(({ body }) => body),
        expectedReminders,
      );
    }

    fixture.control.repoMemoryWorktree = undefined;
    const unauthorized = await runHook(fixture, {
      hook_event_name: "UserPromptSubmit", session_id: "trae-no-worktree-authority",
      prompt: "do not infer repository authority from cwd", cwd: fixture.repoMemoryWorktree,
    });
    assert.equal(unauthorized.status, 0, unauthorized.stderr);
    const context = JSON.parse(unauthorized.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /MemoraX Code reminder:/);
    assert.doesNotMatch(context, /Prefer concise Trae answers|Run the focused Trae adapter test first/);
  } finally {
    await fixture.close();
  }
});

async function createFixture(name, options = {}) {
  const root = await mkdtemp(join(tmpdir(), `memorax-code-trae-hook-${name}-`));
  const traeHome = join(root, "trae-home");
  const repoMemoryWorktree = options.withProcedureMemory ? join(root, "repo") : undefined;
  if (repoMemoryWorktree) await createProcedureMemoryRepo(repoMemoryWorktree);
  const requests = [];
  const control = {
    rejectNextTurnStart: false,
    repoMemoryWorktree,
    writebackReply: async () => ({ status: 200, body: { ok: true, scheduled: true } }),
  };
  const server = createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    const received = { path: request.url, body: text ? JSON.parse(text) : undefined };
    requests.push(received);
    if (request.url === "/memory/writeback") {
      const reply = await control.writebackReply(received.body);
      response.writeHead(reply.status, { "content-type": "application/json" });
      response.end(JSON.stringify(reply.body));
      return;
    }
    const rejectedTurnStart = request.url === "/memory/turn-start" && control.rejectNextTurnStart;
    if (rejectedTurnStart) control.rejectNextTurnStart = false;
    const body = rejectedTurnStart
      ? { ok: false }
      : request.url === "/health"
      ? { ok: true, service: "memorax-code-backend" }
      : request.url === "/memory/turn-start"
        ? {
            ok: true,
            additionalContext: "memory context",
            ...(control.repoMemoryWorktree ? { repoMemoryWorktree: control.repoMemoryWorktree } : {}),
          }
        : { ok: true };
    response.writeHead(rejectedTurnStart ? 503 : 200, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const installed = await enableTraeAdapter({
    memoraxCodeHome: root,
    traeHome,
    memoraxCodeCommand: process.execPath,
  });
  assert.equal(installed.ok, true);
  const state = JSON.parse(await readFile(installed.statePath, "utf8"));
  return {
    root,
    traeHome,
    requests,
    control,
    repoMemoryWorktree,
    intervalTurns: options.intervalTurns ?? 1,
    runtimePath: state.runtimePath,
    runtimeDigest: state.runtimeDigest,
    server,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function createProcedureMemoryRepo(repo) {
  execFileSync("git", ["init", "--quiet", repo]);
  await writeFile(join(repo, ".gitignore"), ".repo_memory/\n");
  await mkdir(join(repo, ".repo_memory", "procedure-memory"), { recursive: true });
  await writeFile(
    join(repo, ".repo_memory", "procedure-memory", "testing.md"),
    "# Testing workflow\n\nRun the focused Trae adapter test first.\n",
  );
}

function runHook(fixture, input) {
  const address = fixture.server.address();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [fixture.runtimePath], {
      cwd: fixture.root,
      env: {
        ...process.env,
        MEMORAX_CODE_HOME: fixture.root,
        MEMORAX_CODE_BACKEND_URL: `http://127.0.0.1:${address.port}`,
        MEMORAX_CODE_MEMORY_SKILL_REMINDER_INTERVAL_TURNS: String(fixture.intervalTurns),
        TRAE_CN_HOME: fixture.traeHome,
      },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15_000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (status, signal) => resolve({
      status,
      signal,
      stdout: stdout.trim(),
      stderr,
    }));
    child.stdin.end(JSON.stringify(input));
  });
}
