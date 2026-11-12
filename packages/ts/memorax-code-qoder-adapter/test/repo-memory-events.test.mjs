import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  consumeQoderNotification, deferQoderNotification, peekQoderNotification,
  isQoderChildHook, isQoderTaskNotificationCandidate,
} from "../src/repo-memory-events.mjs";

const notification = "<task-notification>\n<task-id>synthetic-task</task-id>\n<tool-use-id>tool-1</tool-use-id>\n<status>completed</status>\n<summary>Done.</summary>\n</task-notification>";

test("notification envelopes are only candidates, while examples and malformed prefixes stay ordinary", () => {
  for (const prompt of [notification, `  ${notification}\r\n`]) assert.equal(isQoderTaskNotificationCandidate(prompt), true);
  for (const prompt of [undefined, {}, "ordinary", "<task-notification>",
    "<task-notification><task-id></task-id></task-notification>",
    `Please explain this:\n${notification}`, `${notification}\nWhat does it mean?`]) {
    assert.equal(isQoderTaskNotificationCandidate(prompt), false);
  }
});

test("any child identity field prevents parent-session routing, including malformed and unknown types", () => {
  for (const input of [null, {}, { session_id: "parent" }]) assert.equal(isQoderChildHook(input), false);
  for (const input of [
    { agent_id: "child", agent_type: "memorax-repo-memory" },
    { agent_id: "child", agent_type: "general-purpose" },
    { agent_id: "child" }, { agent_type: "unknown" },
    { agent_id: undefined }, { agent_type: null }, { agent_id: "" },
  ]) assert.equal(isQoderChildHook(input), true);
});

test("deferred prompts preserve bytes privately and consume only their exact client/session/turn/workspace", async (t) => {
  const f = await fixture(t);
  const start = { ...f.start, prompt: `  ${notification}\r\n` };
  assert.equal(deferQoderNotification({ ...start, prompt: "ordinary" }, f.options), false);
  assert.equal(existsSync(f.path), false);
  assert.equal(deferQoderNotification(start, f.options), true);
  if (process.platform !== "win32") {
    assert.equal((await stat(f.path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(f.home, "adapters", "qoder"))).mode & 0o777, 0o700);
  }
  for (const mismatch of [
    { version: 2 }, { client: "cursor" }, { sessionId: "other" }, { turnId: "other" },
    { cwd: `${start.cwd} ` }, { transcriptPath: `${start.transcriptPath} ` }, { workspaceKind: "projectless" },
  ]) assert.equal(consumeQoderNotification({ ...start, ...mismatch }, f.options), undefined);
  assert.deepEqual(consumeQoderNotification(start, f.options), start);
  assert.equal(consumeQoderNotification(start, f.options), undefined);
  assert.equal(existsSync(f.path), false);
});

test("peek retains exact pending observations and a stale acknowledgment cannot delete a replacement", async (t) => {
  const f = await fixture(t);
  const start = { ...f.start, workspaceKind: "projectless" };
  deferQoderNotification(start, f.options);
  for (const mismatch of [
    { version: 2 }, { client: "cursor" }, { sessionId: "other" }, { turnId: "other" },
    { cwd: start.cwd + " " }, { transcriptPath: start.transcriptPath + " " },
    { workspaceKind: undefined }, { prompt: notification + " " },
  ]) assert.equal(peekQoderNotification({ ...start, ...mismatch }, f.options), undefined);
  const pending = await readFile(f.path, "utf8");
  const observed = peekQoderNotification(start, f.options);
  assert.deepEqual(observed, start);
  assert.deepEqual(peekQoderNotification(start, f.options), start);
  assert.equal(await readFile(f.path, "utf8"), pending);

  assert.deepEqual(consumeQoderNotification(start, f.options), start);
  const replacement = { ...start, prompt: notification.replace("Done.", "Replacement.") };
  deferQoderNotification(replacement, f.options);
  assert.equal(consumeQoderNotification(observed, f.options), undefined);
  assert.deepEqual(peekQoderNotification(replacement, f.options), replacement);
  assert.deepEqual(consumeQoderNotification(replacement, f.options), replacement);
  assert.equal(peekQoderNotification(replacement, f.options), undefined);
});

test("duplicate submits are idempotent and conflicting observations cannot replace pending prompts", async (t) => {
  const f = await fixture(t);
  assert.equal(deferQoderNotification(f.start, f.options), true);
  const before = await readFile(f.path, "utf8");
  assert.equal(deferQoderNotification(f.start, f.options), true);
  assert.equal(await readFile(f.path, "utf8"), before);
  for (const changes of [
    { prompt: notification.replace("Done.", "Different result.") },
    { cwd: `${f.start.cwd} ` }, { transcriptPath: join(f.root, "other.jsonl") },
  ]) assert.throws(() => deferQoderNotification({ ...f.start, ...changes }, f.options), /invalid or full/);
  assert.deepEqual(consumeQoderNotification(f.start, f.options), f.start);
});

test("deferred projectless prompts retain their workspace kind and reject changed scope", async (t) => {
  const f = await fixture(t);
  const start = { ...f.start, workspaceKind: "projectless" };
  assert.equal(deferQoderNotification(start, f.options), true);
  assert.equal(deferQoderNotification(start, f.options), true);
  assert.throws(() => deferQoderNotification(f.start, f.options), /invalid or full/);
  for (const workspaceKind of [undefined, null, "general", "project"])
    assert.equal(consumeQoderNotification({ ...start, workspaceKind }, f.options), undefined);
  assert.deepEqual(consumeQoderNotification(start, f.options), start);
  for (const workspaceKind of [null, "general", "project", " projectless "])
    assert.throws(() => deferQoderNotification({ ...start, workspaceKind }, f.options), /invalid or full/);
  assert.equal(existsSync(f.path), false);
});

test("concurrent processes preserve separate sessions and equal request IDs", async (t) => {
  const f = await fixture(t);
  const moduleUrl = new URL("../src/repo-memory-events.mjs", import.meta.url).href;
  const commands = Array.from({ length: 4 }, (_, index) => ({ ...f.start, sessionId: `session-${index}` }));
  const code = `import {deferQoderNotification} from ${JSON.stringify(moduleUrl)}; const options=JSON.parse(process.argv[2]); options.now=()=>options.nowValue; deferQoderNotification(JSON.parse(process.argv[1]), options);`;
  await Promise.all(commands.map((command) => child(["--input-type=module", "-e", code, JSON.stringify(command), JSON.stringify({ memoraxCodeHome: f.home, nowValue: f.now })])));
  for (const command of commands) assert.deepEqual(consumeQoderNotification(command, f.options), command);
});

test("missing QueryEnd observations expire and pending storage is bounded without eviction", async (t) => {
  const f = await fixture(t);
  for (let index = 0; index < 64; index += 1) deferQoderNotification({ ...f.start, turnId: `turn-${index}` }, f.options);
  assert.throws(() => deferQoderNotification({ ...f.start, turnId: "overflow" }, f.options), /invalid or full/);
  const later = { ...f.options, now: () => f.now + 24 * 60 * 60 * 1000 };
  assert.equal(deferQoderNotification(f.start, later), true);
  assert.equal(consumeQoderNotification({ ...f.start, turnId: "turn-0" }, later), undefined);
  assert.deepEqual(consumeQoderNotification(f.start, later), f.start);
});

test("malformed, conflicting, oversized, or unavailable storage fails closed", async (t) => {
  const f = await fixture(t);
  deferQoderNotification(f.start, f.options);
  const valid = JSON.parse(await readFile(f.path, "utf8"));
  for (const value of [
    "{", JSON.stringify({ ...valid, version: 2 }), JSON.stringify({ ...valid, client: "cursor" }),
    JSON.stringify({ ...valid, records: [valid.records[0], valid.records[0]] }),
  ]) {
    await writeFile(f.path, value);
    assert.throws(() => deferQoderNotification(f.start, f.options), /invalid or full/);
    assert.throws(() => consumeQoderNotification(f.start, f.options), /invalid or full/);
    assert.throws(() => peekQoderNotification(f.start, f.options), /invalid or full/);
  }
  assert.throws(() => deferQoderNotification({ ...f.start, prompt: notification.replace("Done.", "x".repeat(1024 * 1024)) }, f.options), /invalid or full/);
  const blockedHome = join(f.root, "file-not-directory");
  await writeFile(blockedHome, "synthetic");
  assert.throws(() => deferQoderNotification(f.start, { memoraxCodeHome: blockedHome }));
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "memorax-qoder-events-"));
  const home = join(root, "state");
  const cwd = join(root, "workspace with spaces");
  await mkdir(cwd);
  t.after(() => rm(root, { recursive: true, force: true }));
  const now = 1_800_000_000_000;
  return { root, home, now, options: { memoraxCodeHome: home, now: () => now },
    path: join(home, "adapters", "qoder", "deferred-task-notifications.json"),
    start: { version: 1, client: "qoder", sessionId: "session-1", turnId: "turn-1", cwd,
      transcriptPath: join(root, "native.jsonl"), prompt: notification } };
}

function child(args) {
  return new Promise((resolve, reject) => {
    const processHandle = spawn(process.execPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    processHandle.stderr.on("data", (part) => { stderr += part; });
    processHandle.on("error", reject);
    processHandle.on("close", (status) => status === 0 ? resolve() : reject(new Error(stderr)));
  });
}
