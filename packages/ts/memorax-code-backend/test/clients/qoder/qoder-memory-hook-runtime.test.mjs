import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createQoderMemoryHookRuntime } from "../../../dist/clients/qoder/memory-hook-runtime.js";
import { createAutomaticMemoryWritebackRuntime } from "../../../dist/memory/automatic-writeback.js";
import { runMemoryCli } from "../../../dist/memory/cli.js";
import { readCurrentTraceTurn, readOpenTraceTurn } from "../../../dist/trace/store.js";
import { clientTracePaths } from "../../../dist/trace/config.js";

async function fixture(t, { projectless = false, ...overrides } = {}) {
  const root = await mkdtemp(join(tmpdir(), "memorax-qoder-runtime-"));
  const userHome = join(root, "user");
  const cwd = projectless ? join(userHome, "Documents", "Qoder", "2026-10-06", "1a2b3c4d") : join(root, "workspace");
  await mkdir(cwd, { recursive: true });
  const home = join(root, "state");
  const env = {
    HOME: userHome, USERPROFILE: userHome,
    MEMORAX_CODE_HOME: home,
    MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
    MEMORAX_CODE_MEMORAX_API_KEY: "synthetic-key",
    MEMORAX_CODE_MEMORAX_USER_ID: "synthetic-user",
    MEMORAX_CODE_QODER_TRACE_ENABLED: "false",
  };
  const writes = [];
  const options = {
    env, memoraxCodeHome: home,
    automaticWriteback: (input) => { writes.push(input); return { accepted: true }; },
    ...overrides,
  };
  const runtime = createQoderMemoryHookRuntime(options);
  t.after(async () => { runtime.close(); await rm(root, { recursive: true, force: true }); });
  const start = {
    version: 1, client: "qoder", sessionId: "qoder-session-a", turnId: "qoder-turn-a",
    cwd, transcriptPath: join(root, "native.jsonl"), prompt: "  Original Qoder prompt.\nSecond line.  ",
    ...(projectless ? { workspaceKind: "projectless" } : {}),
  };
  const finish = ({ prompt, ...identity } = start) => ({ ...identity, status: "completed" });
  const writeNative = async (command = start, reply = "Native final answer.", extra = []) => {
    const identity = { sessionId: command.sessionId, cwd: command.cwd, isSidechain: false };
    const human = { ...identity, type: "user", uuid: command.turnId, requestSetId: command.turnId,
      parentUuid: null, origin: { kind: "human" }, humanInput: { text: command.prompt, mode: "prompt" },
      message: { role: "user", content: [{ type: "text", text: command.prompt }] },
      timestamp: "2026-09-01T08:00:00.000Z" };
    const final = { ...identity, type: "assistant", uuid: `${command.turnId}-final`, parentUuid: command.turnId,
      message: { role: "assistant", content: [{ type: "text", text: reply }], stop_reason: "end_turn" },
      timestamp: "2026-09-01T08:00:03.000Z" };
    await writeFile(command.transcriptPath, [human, final, ...extra,
      { type: "active-leaf", sessionId: command.sessionId, leafUuid: final.uuid }].map(JSON.stringify).join("\n") + "\n");
  };
  return { root, cwd, home, env, options, runtime, writes, start, finish, writeNative };
}

test("Qoder registers before native persistence and writes only exact native QA with timestamps", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.runtime.recordTurnStart(f.start)).recorded, true);
  const pending = await f.runtime.writeback(f.finish());
  assert.equal(pending.reason, "transcript_unavailable");
  assert.equal(f.runtime.size(), 1);
  await f.writeNative();
  assert.deepEqual(await f.runtime.writeback(f.finish()), { ok: true, scheduled: true });
  assert.equal(f.runtime.size(), 0);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].userText, f.start.prompt);
  assert.equal(f.writes[0].assistantText, "Native final answer.");
  assert.equal(f.writes[0].client, "qoder");
  assert.equal(f.writes[0].traceContext.turnId, f.start.turnId);
  assert.equal(f.writes[0].userTimestamp, Date.parse("2026-09-01T08:00:00.000Z"));
  assert.equal(f.writes[0].assistantTimestamp, Date.parse("2026-09-01T08:00:03.000Z"));
  const bridge = await readCurrentTraceTurn({ client: "qoder", expectedSessionId: f.start.sessionId, memoraxCodeHome: f.home });
  assert.equal(bridge.ok, true);
  assert.equal(bridge.traceContext.turnId, f.start.turnId);
});

test("Qoder concurrent duplicate completion enqueues once", async (t) => {
  const f = await fixture(t);
  await f.runtime.recordTurnStart(f.start);
  await f.writeNative();
  const results = await Promise.all([f.runtime.writeback(f.finish()), f.runtime.writeback(f.finish())]);
  assert.equal(results.filter((r) => r.scheduled).length, 1);
  assert.equal(results[1].reason, "already_accepted_locally");
  assert.equal(f.writes.length, 1);
});

test("Qoder abort discards only the matching turn and cannot be replayed as completed", async (t) => {
  const f = await fixture(t);
  await f.runtime.recordTurnStart(f.start);
  await f.writeNative();
  assert.equal((await f.runtime.writeback({ ...f.finish(), status: "aborted" })).reason, "interrupted");
  assert.equal(f.runtime.size(), 0);
  assert.equal((await f.runtime.writeback(f.finish())).reason, "interrupted");
  const next = { ...f.start, turnId: "qoder-next", prompt: "Continue after cancellation." };
  await f.runtime.recordTurnStart(next);
  assert.equal((await f.runtime.writeback({ ...f.finish(), status: "aborted" })).reason, "turn_metadata_mismatch");
  const bridge = await readOpenTraceTurn({ client: "qoder", expectedSessionId: next.sessionId, memoraxCodeHome: f.home });
  assert.equal(bridge.ok, true);
  assert.equal(bridge.traceContext.turnId, next.turnId);
  await f.writeNative(next);
  assert.equal((await f.runtime.writeback(f.finish(next))).scheduled, true);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].userText, next.prompt);
});

test("Qoder retains rejected enqueue metadata until a matching retry is accepted", async (t) => {
  let accepted = false;
  let attempts = 0;
  const f = await fixture(t, { automaticWriteback: () => {
    attempts += 1;
    return accepted ? { accepted: true } : { accepted: false, reason: "decision_error" };
  } });
  await f.runtime.recordTurnStart(f.start);
  await f.writeNative();
  assert.equal((await f.runtime.writeback(f.finish())).reason, "decision_error");
  assert.equal(f.runtime.size(), 1);
  accepted = true;
  assert.equal((await f.runtime.writeback(f.finish())).scheduled, true);
  assert.equal(attempts, 2);
  assert.equal(f.runtime.size(), 0);
});

test("Qoder rejects changed prompt, workspace, transcript and late superseded completion", async (t) => {
  const f = await fixture(t);
  await f.runtime.recordTurnStart(f.start);
  assert.equal((await f.runtime.recordTurnStart({ ...f.start, prompt: "Changed Hook prompt" })).recorded, false);
  await f.writeNative({ ...f.start, prompt: "Different native prompt" });
  assert.equal((await f.runtime.writeback(f.finish())).reason, "turn_prompt_mismatch");
  assert.equal((await f.runtime.writeback({ ...f.finish(), cwd: f.root })).reason, "turn_metadata_mismatch");
  assert.equal((await f.runtime.writeback({ ...f.finish(), transcriptPath: join(f.root, "other.jsonl") })).reason, "turn_metadata_mismatch");
  const next = { ...f.start, turnId: "qoder-next", prompt: "New turn" };
  await f.runtime.recordTurnStart(next);
  assert.equal((await f.runtime.writeback(f.finish())).reason, "turn_metadata_mismatch");
  assert.equal(f.writes.length, 0);
});

test("Qoder cannot reconstruct missing scope metadata from a completion after Backend restart", async (t) => {
  const f = await fixture(t);
  await f.runtime.recordTurnStart(f.start);
  await f.writeNative();
  f.runtime.close();
  const restarted = createQoderMemoryHookRuntime(f.options);
  t.after(() => restarted.close());
  assert.equal((await restarted.writeback(f.finish())).reason, "turn_metadata_missing");
  assert.equal(f.writes.length, 0);
  const next = { ...f.start, turnId: "qoder-after-restart" };
  await restarted.recordTurnStart(next);
  await f.writeNative(next);
  assert.equal((await restarted.writeback(f.finish(next))).scheduled, true);
});

test("Qoder sessions sharing cwd and turn IDs remain isolated", async (t) => {
  const f = await fixture(t);
  const second = { ...f.start, sessionId: "qoder-session-b", transcriptPath: join(f.root, "second.jsonl"), prompt: "Session B" };
  await Promise.all([f.runtime.recordTurnStart(f.start), f.runtime.recordTurnStart(second)]);
  await Promise.all([f.writeNative(), f.writeNative(second)]);
  await f.runtime.writeback({ ...f.finish(), status: "aborted" });
  assert.equal((await f.runtime.writeback(f.finish(second))).scheduled, true);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].sessionKey, second.sessionId);
});

for (const projectless of [false, true]) {
test(`Qoder ${projectless ? "General" : "workspace"} CLI binding preserves current turn for Add/Search and refuses conflicting cwd`, async (t) => {
  const f = await fixture(t, { projectless });
  f.env.MEMORAX_CODE_QODER_TRACE_ENABLED = "true";
  await f.runtime.recordTurnStart(f.start);
  const requests = [];
  const cliOptions = {
    cwd: f.cwd,
    env: { ...f.env, CODEX_THREAD_ID: "unrelated-codex-session",
      MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT: "qoder",
      MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID: f.start.sessionId },
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ success: true, data: String(url).endsWith("/add")
        ? { task_id: "synthetic-task", status: "queued" } : { data: [] } }), { status: 200 });
    },
  };
  const search = await runMemoryCli(["search", "--query", "synthetic query"], cliOptions);
  assert.equal(search.ok, true, JSON.stringify(search));
  const add = await runMemoryCli(["add", "--memory", "Synthetic durable fact.", "--type", "procedural", "--reason", "Explicit integration test"], cliOptions);
  assert.equal(add.ok, true, JSON.stringify(add));
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.user_id, requests[1].body.user_id);
  assert.equal(requests[0].body.user_id, `synthetic-user@${projectless ? "General" : "workspace"}`);
  const trace = (await readFile(clientTracePaths("qoder", f.home).eventsJsonl(f.start.sessionId), "utf8"))
    .trim().split("\n").map(JSON.parse).filter((e) => e.source === "memory_cli");
  assert.equal(trace.length, 2);
  assert.ok(trace.every((e) => e.trace.client === "qoder" && e.trace.turn_id === f.start.turnId));
  const other = join(f.root, "other-workspace");
  await mkdir(other);
  assert.equal((await runMemoryCli(["search", "--query", "must not run"], { ...cliOptions, cwd: other })).ok, false);
  assert.equal(requests.length, 2);
});
}

test("Qoder default task sends automatic native Add to General", async (t) => {
  const requests = [];
  const automatic = createAutomaticMemoryWritebackRuntime();
  t.after(() => automatic.close());
  const f = await fixture(t, {
    projectless: true,
    automaticWriteback: automatic.enqueue,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      return new Response(JSON.stringify({ success: true, data: { task_id: "synthetic-task", status: "queued" } }), { status: 200 });
    },
  });
  f.env.MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED = "true";
  f.env.MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED = "false";
  const started = await f.runtime.recordTurnStart(f.start);
  assert.equal(started.recorded, true);
  assert.equal(started.repoMemoryWorktree, undefined);
  await f.writeNative();
  assert.equal((await f.runtime.writeback(f.finish())).scheduled, true);
  await automatic.drain();
  assert.equal(requests.length, 1);
  assert.ok(requests[0].url.endsWith("/v1/memories/add"));
  assert.equal(requests[0].body.user_id, "synthetic-user@General");
  assert.deepEqual(requests[0].body.messages.map(({ role, content }) => ({ role, content })), [
    { role: "user", content: f.start.prompt.trim() }, { role: "assistant", content: "Native final answer." },
  ]);
});

test("Qoder default tasks share General remotely but keep separate local workspace bindings", async (t) => {
  const f = await fixture(t, { projectless: true });
  const second = { ...f.start, cwd: join(dirname(f.cwd), "2b3c4d5e"), sessionId: "qoder-session-b", transcriptPath: join(f.root, "second.jsonl") };
  await mkdir(second.cwd);
  for (const command of [f.start, second]) {
    assert.equal((await f.runtime.recordTurnStart(command)).recorded, true);
    await f.writeNative(command);
    assert.equal((await f.runtime.writeback(f.finish(command))).scheduled, true);
  }
  assert.deepEqual(f.writes.map((input) => input.repositoryScope.effectiveUserId), ["synthetic-user@General", "synthetic-user@General"]);
  assert.notEqual(f.writes[0].repositoryScope.repositoryKey, f.writes[1].repositoryScope.repositoryKey);
  assert.deepEqual(f.writes.map((input) => input.repositoryScope.boundWorkspaceRoot), await Promise.all([realpath(f.cwd), realpath(second.cwd)]));
});

test("Qoder General rejects changed Hook classification and a different default task in one session", async (t) => {
  const f = await fixture(t, { projectless: true });
  await f.runtime.recordTurnStart(f.start);
  await f.writeNative();
  const missingHint = f.finish();
  delete missingHint.workspaceKind;
  assert.equal((await f.runtime.writeback(missingHint)).reason, "turn_metadata_mismatch");
  assert.equal((await f.runtime.writeback({ ...f.finish(), workspaceKind: "general" })).reason, "workspace_scope_mismatch");
  assert.equal((await f.runtime.writeback(f.finish())).scheduled, true);
  const moved = { ...f.start, turnId: "qoder-moved", cwd: join(dirname(f.cwd), "2b3c4d5e") };
  await mkdir(moved.cwd);
  await f.runtime.recordTurnStart(moved);
  await f.writeNative(moved);
  assert.equal((await f.runtime.writeback(f.finish(moved))).reason, "workspace_scope_mismatch");
  const returned = { ...f.start, turnId: "qoder-returned" };
  await f.runtime.recordTurnStart(returned);
  await f.writeNative(returned);
  assert.equal((await f.runtime.writeback(f.finish(returned))).reason, "workspace_scope_mismatch");
  assert.equal(f.writes.length, 1);
});

test("Qoder rechecks managed default path authority on duplicate start and completion", async (t) => {
  const f = await fixture(t, { projectless: true });
  await f.runtime.recordTurnStart(f.start);
  await f.writeNative();
  const outside = join(f.root, "outside");
  await rename(f.cwd, outside);
  await symlink(outside, f.cwd, process.platform === "win32" ? "junction" : "dir");
  assert.equal((await f.runtime.recordTurnStart(f.start)).reason, "workspace_scope_mismatch");
  assert.equal((await f.runtime.writeback(f.finish())).reason, "workspace_scope_mismatch");
  assert.equal(f.writes.length, 0);
});

test("Qoder default task keeps Git authority ahead of the projectless hint", async (t) => {
  const f = await fixture(t, { projectless: true });
  await writeGitMetadata(f.cwd);
  assert.equal((await f.runtime.recordTurnStart(f.start)).repoMemoryWorktree, await realpath(f.cwd));
  await f.writeNative();
  assert.equal((await f.runtime.writeback(f.finish())).scheduled, true);
  assert.equal(f.writes[0].repositoryScope.effectiveUserId, "synthetic-user@SyntheticProject");
  assert.equal(f.writes[0].repositoryScope.scopeKind, "git-repository");
});

test("Qoder General cannot silently acquire a repository within the same live session", async (t) => {
  const f = await fixture(t, { projectless: true });
  await f.runtime.recordTurnStart(f.start);
  await f.writeNative();
  await writeGitMetadata(f.cwd);
  assert.equal((await f.runtime.writeback(f.finish())).reason, "workspace_scope_mismatch");
  assert.equal(f.writes.length, 0);
});

test("Qoder default task with an invalid Git pointer cannot fall back to General", async (t) => {
  const f = await fixture(t, { projectless: true });
  await writeFile(join(f.cwd, ".git"), "gitdir: missing-admin-directory\n");
  await f.runtime.recordTurnStart(f.start);
  await f.writeNative();
  assert.equal((await f.runtime.writeback(f.finish())).reason, "workspace_scope_unavailable");
  assert.equal(f.writes.length, 0);
});

async function writeGitMetadata(cwd) {
  const git = join(cwd, ".git");
  await mkdir(join(git, "objects"), { recursive: true });
  await mkdir(join(git, "refs"));
  await writeFile(join(git, "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(git, "config"), '[core]\nrepositoryformatversion = 0\n[remote "origin"]\nurl = https://example.test/owner/SyntheticProject.git\n');
}

const notificationPrompt = "<task-notification>\n<task-id>synthetic-task</task-id>\n<tool-use-id>tool-1</tool-use-id>\n<status>completed</status>\n<summary>Synthetic completion.</summary>\n</task-notification>";

test("Qoder notification candidates cannot register before exact completed human authority exists", async (t) => {
  const f = await fixture(t);
  const candidate = { ...f.start, prompt: notificationPrompt };
  assert.equal((await f.runtime.recordTurnStart(candidate)).recorded, false);
  assert.equal(f.runtime.size(), 0);
  await f.writeNative(candidate);
  const records = (await readFile(candidate.transcriptPath, "utf8")).trim().split("\n").map(JSON.parse);
  records[1].message.stop_reason = "tool_use";
  await writeFile(candidate.transcriptPath, records.map(JSON.stringify).join("\n"));
  assert.equal((await f.runtime.recordTurnStart(candidate)).reason, "assistant_message_missing");
  assert.equal(f.runtime.size(), 0);
  assert.equal((await readOpenTraceTurn({ client: "qoder", expectedSessionId: candidate.sessionId, memoraxCodeHome: f.home })).ok, false);
  assert.deepEqual(f.writes, []);
});

test("a human pasting a complete notification remains eligible for exact native Add after completion", async (t) => {
  const f = await fixture(t);
  const candidate = { ...f.start, prompt: `  ${notificationPrompt}\r\n` };
  assert.equal((await f.runtime.recordTurnStart(candidate)).recorded, false);
  await f.writeNative(candidate, "Human-request answer.");
  assert.equal((await f.runtime.recordTurnStart(candidate)).recorded, true);
  assert.equal((await f.runtime.writeback(f.finish(candidate))).scheduled, true);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].userText, candidate.prompt);
  assert.equal(f.writes[0].assistantText, "Human-request answer.");
});

test("native notification identities cannot register or displace an open human turn", async (t) => {
  const f = await fixture(t);
  await f.runtime.recordTurnStart(f.start);
  const candidate = { ...f.start, turnId: "notification-query", prompt: notificationPrompt };
  for (const changes of [
    { uuid: "native-notification-id", requestSetId: undefined, humanInput: undefined, origin: { kind: "task-notification" }, isMeta: true },
    { origin: { kind: "task-notification" }, isMeta: true },
    { origin: { kind: "human" }, isMeta: true },
    { sessionId: "foreign-session" }, { requestSetId: "foreign-request" },
    { humanInput: undefined },
  ]) {
    await f.writeNative(candidate);
    const records = (await readFile(candidate.transcriptPath, "utf8")).trim().split("\n").map(JSON.parse);
    Object.assign(records[0], changes);
    await writeFile(candidate.transcriptPath, records.map(JSON.stringify).join("\n"));
    assert.equal((await f.runtime.recordTurnStart(candidate)).recorded, false);
  }
  const current = await readOpenTraceTurn({ client: "qoder", expectedSessionId: f.start.sessionId, memoraxCodeHome: f.home });
  assert.equal(current.ok, true);
  assert.equal(current.traceContext.turnId, f.start.turnId);
  await f.writeNative();
  assert.equal((await f.runtime.writeback(f.finish())).scheduled, true);
  assert.equal(f.writes.length, 1);
});

test("candidate registration rejects mismatched native prompt or workspace", async (t) => {
  const f = await fixture(t);
  const candidate = { ...f.start, prompt: notificationPrompt };
  await f.writeNative({ ...candidate, prompt: notificationPrompt.replace("completion", "other result") });
  assert.equal((await f.runtime.recordTurnStart(candidate)).reason, "turn_prompt_mismatch");
  await f.writeNative({ ...candidate, cwd: f.root });
  assert.equal((await f.runtime.recordTurnStart(candidate)).reason, "workspace_scope_mismatch");
  assert.equal(f.runtime.size(), 0);
});

test("delayed candidate registration proves native order and cannot replace a newer open human turn", async (t) => {
  const f = await fixture(t);
  const candidate = { ...f.start, prompt: notificationPrompt };
  const later = { ...f.start, turnId: "later-human", prompt: "Later ordinary request." };
  await f.writeNative(candidate);
  const first = (await readFile(candidate.transcriptPath, "utf8")).trim().split("\n").map(JSON.parse).slice(0, 2);
  await f.writeNative(later);
  const second = (await readFile(later.transcriptPath, "utf8")).trim().split("\n").map(JSON.parse);
  second[0].parentUuid = first[1].uuid;
  await writeFile(candidate.transcriptPath, [...first, ...second].map(JSON.stringify).join("\n"));
  await f.runtime.recordTurnStart(later);
  assert.equal((await f.runtime.recordTurnStart(candidate)).reason, "turn_order_mismatch");
  assert.equal((await f.runtime.writeback(f.finish(later))).scheduled, true);
  assert.deepEqual(f.writes.map((write) => write.userText), [later.prompt]);
});

test("a later pasted notification may advance an earlier registered native turn", async (t) => {
  const f = await fixture(t);
  await f.runtime.recordTurnStart(f.start);
  await f.writeNative();
  assert.equal((await f.runtime.writeback(f.finish())).scheduled, true);
  const first = (await readFile(f.start.transcriptPath, "utf8")).trim().split("\n").map(JSON.parse).slice(0, 2);
  const candidate = { ...f.start, turnId: "later-pasted-notification", prompt: notificationPrompt };
  await f.writeNative(candidate);
  const second = (await readFile(candidate.transcriptPath, "utf8")).trim().split("\n").map(JSON.parse);
  second[0].parentUuid = first[1].uuid;
  await writeFile(candidate.transcriptPath, [...first, ...second].map(JSON.stringify).join("\n"));
  assert.equal((await f.runtime.recordTurnStart(candidate)).recorded, true);
  assert.equal((await f.runtime.writeback(f.finish(candidate))).scheduled, true);
  assert.deepEqual(f.writes.map((write) => write.userText), [f.start.prompt, candidate.prompt]);
});
