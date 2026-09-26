#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createDatabaseFixture } from "../packages/ts/memorax-code-backend/test/clients/cursor/support/database-fixtures.mjs";

// The input is an already materialized npm package. Every mutable client,
// native database, Backend record, and provider request belongs to this fixture.
const packageRoot = resolve(process.argv[2] ?? "");
assert.ok(process.argv[2], "Usage: node scripts/cursor-npm-package-smoke.mjs PACKAGE_ROOT");
const packageManifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8"));
assert.equal(packageManifest.name, "@memorax/memorax-code");
const root = await realpath(await mkdtemp(join(tmpdir(), "memorax cursor package smoke-")));
const home = join(root, "home");
const stateHome = join(root, "state");
const cursorHome = join(root, "cursor");
const workspace = join(root, "workspace");
const maintenanceRepo = join(root, "maintenance repo");
const gitDirectory = await commandDirectory("git");
assert.ok(gitDirectory, "Cursor Repo Memory package smoke requires Git");
const databasePath = join(root, "native-user-data", "User", "globalStorage", "state.vscdb");
const requests = [];
const provider = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  requests.push({ path: request.url, body });
  response.writeHead(200, { "content-type": "application/json" });
  const data = request.url === "/v1/memories/add"
    ? { task_id: "cursor-smoke-task", status: "completed" } : { data: [] };
  response.end(JSON.stringify({ success: true, data }));
});
await new Promise((accept) => provider.listen(0, "127.0.0.1", accept));
const reserve = createServer();
await new Promise((accept) => reserve.listen(0, "127.0.0.1", accept));
const port = reserve.address().port;
await new Promise((accept) => reserve.close(accept));
const env = {
  PATH: [dirname(process.execPath), gitDirectory, ...(process.platform === "win32"
    ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32")]
    : ["/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(delimiter),
  ...(process.platform === "win32" ? {
    SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR, ComSpec: process.env.ComSpec,
    PATHEXT: process.env.PATHEXT,
  } : {}),
  HOME: home, USERPROFILE: home, TMPDIR: root, TMP: root, TEMP: root,
  APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"),
  npm_config_cache: join(root, "npm-cache"),
  MEMORAX_CODE_HOME: stateHome, CURSOR_HOME: cursorHome,
  MEMORAX_CODE_CURSOR_DATABASE_PATH: databasePath,
  CODEX_HOME: join(root, "codex"), CLAUDE_CONFIG_DIR: join(root, "claude"),
  DSH_HOME: join(root, "dsh"), OPENCODE_CONFIG_DIR: join(root, "opencode"),
  CODEBUDDY_HOME: join(root, "codebuddy"), CODEBUDDY_CONFIG_DIR: join(root, "codebuddy"),
  WORKBUDDY_HOME: join(root, "workbuddy"), TRAE_HOME: join(root, "trae"), TRAE_CN_HOME: join(root, "trae"),
  XDG_CONFIG_HOME: join(root, "xdg-config"),
  MEMORAX_CODE_CODEX_COMMAND: join(root, "missing-codex"),
  MEMORAX_CODE_CLAUDE_COMMAND: join(root, "missing-claude"),
  MEMORAX_CODE_CODEBUDDY_COMMAND: join(root, "missing-codebuddy"),
  MEMORAX_CODE_WORKBUDDY_COMMAND: join(root, "missing-workbuddy"),
  MEMORAX_CODE_MEMORAX_ENDPOINT: "http://127.0.0.1:" + provider.address().port,
  MEMORAX_CODE_MEMORAX_API_KEY: "cursor-smoke-fixture-key",
  MEMORAX_CODE_MEMORAX_USER_ID: "cursor-smoke-fixture-user",
  MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
  MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_ENABLED: "false",
  MEMORAX_CODE_MEMORY_WRITEBACK_CHUNK_ENABLED: "false",
  MEMORAX_CODE_CURSOR_ENSURE_BACKEND: "false",
  MEMORAX_CODE_CURSOR_TRACE_ENABLED: "false",
  MEMORAX_CODE_AUTO_UPDATE: "false",
};
const cli = join(packageRoot, "bin", "memorax-code.mjs");
const lifecycleArgs = ["--home", stateHome, "--cursor-home", cursorHome, "--port", String(port), "--clients", "cursor", "--json"];
const runCli = async (command, extra = []) => {
  try { return JSON.parse(await run(process.execPath, [cli, command, ...lifecycleArgs, ...extra])); }
  catch (error) {
    const log = await readFile(join(stateHome, "runtime", "backend", "backend.log"), "utf8").catch(() => "");
    throw new Error(error.message + "\n" + log, { cause: error });
  }
};
const hooksPath = join(cursorHome, "hooks.json");
const userConfig = { version: 1, customSetting: "preserved", hooks: { stop: [{ command: "user-owned-hook" }] } };
let nativeDatabase;
try {
  await Promise.all([home, cursorHome, workspace].map((path) => mkdir(path, { recursive: true })));
  await writeFile(hooksPath, JSON.stringify(userConfig));
  const started = await runCli("start");
  assert.equal(started.cursorAdapter.enabled, true);
  assert.equal(started.claudeAdapter, undefined);
  const manifest = JSON.parse(await readFile(hooksPath, "utf8"));
  const sessionId = randomUUID();
  const generationId = randomUUID();
  nativeDatabase = await createDatabaseFixture(databasePath, { sessionId, latestGenerationId: generationId, turns: [] });
  nativeDatabase.database.exec("PRAGMA journal_mode = WAL");
  const payload = {
    conversation_id: sessionId, generation_id: generationId,
    workspace_roots: [workspace],
  };
  const hookEnv = { ...env };
  delete hookEnv.MEMORAX_CODE_CURSOR_DATABASE_PATH;
  const hook = async (event, fields = {}) => {
    const installed = manifest.hooks[event].find(({ command }) => command !== "user-owned-hook");
    assert.ok(installed?.command, "Missing installed " + event + " Hook");
    return run(installed.command, [], { shell: true, env: hookEnv,
      input: JSON.stringify({ ...payload, hook_event_name: event, ...fields }) });
  };
  const session = JSON.parse(await hook("sessionStart"));
  assert.equal(session.env.MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT, "cursor");
  const maintenancePrefix = "MemoraX Code Repo Memory maintenance for this Cursor session: ";
  const maintenanceLine = session.additional_context.split("\n").find((line) => line.startsWith(maintenancePrefix));
  assert.ok(maintenanceLine, "The installed Hook must identify the current Cursor maintenance helper");
  const maintenance = JSON.parse(maintenanceLine.slice(maintenancePrefix.length));
  assert.equal(maintenance.executable, process.execPath);
  assert.deepEqual(maintenance.env, { MEMORAX_CODE_HOME: stateHome });
  assert.equal(maintenance.helper, join(started.cursorAdapter.installPath, "repo-memory-job.mjs"));
  assert.equal((await stat(maintenance.helper)).isFile(), true);
  const nativeSkill = join(cursorHome, "skills", "memorax-code");
  const importedSkill = join(packageRoot, "lib", "memorax-code-claude-adapter", "skills", "memorax-code");
  assert.equal(await readFile(join(nativeSkill, "references", "repo-read.md"), "utf8"),
    await readFile(join(importedSkill, "references", "repo-read.md"), "utf8"));
  await mkdir(maintenanceRepo);
  for (const args of [["init", "--quiet"], ["config", "user.name", "Cursor Package Test"],
    ["config", "user.email", "cursor-package@example.invalid"], ["config", "commit.gpgsign", "false"],
    ["commit", "--quiet", "--allow-empty", "-m", "fixture"]]) await run("git", args, { cwd: maintenanceRepo });
  const cursorAgent = join(root, "missing cursor agent");
  // Both Skill origins use the session's absolute helper; no shell environment
  // inheritance or client installation path determines the selected runner.
  for (const skillDirectory of [nativeSkill, importedSkill]) {
    const decision = JSON.parse(await run(maintenance.executable,
      [maintenance.helper, "maintain", "--repo", maintenanceRepo, "--dry-run"], {
        cwd: skillDirectory,
        env: { ...env, ...maintenance.env, MEMORAX_CODE_CURSOR_AGENT_COMMAND: cursorAgent },
      }));
    assert.equal(decision.ok, true);
    assert.equal(decision.reason, "bundle_missing");
    assert.equal(decision.job.dryRun, true);
    assert.equal(decision.job.runner, "cursor");
    assert.equal(decision.job.repo, maintenanceRepo);
    assert.equal(decision.job.execution, "native-subagent");
    assert.equal(decision.job.command, undefined);
    assert.equal(decision.job.delegation, undefined, "Dry runs must not issue claim tickets");
  }
  assert.equal(requests.length, 0, "Maintenance dry runs must not call the provider");
  await assert.rejects(stat(join(stateHome, "repo-memory-jobs")), { code: "ENOENT" });
  const managedAgentPath = join(cursorHome, "agents", "memorax-repo-memory.md");
  assert.match(await readFile(managedAgentPath, "utf8"), /is_background: true/);
  const nativeJob = async (...args) => JSON.parse(await run(maintenance.executable,
    [maintenance.helper, ...args], { expectedCode: args[0] === "abort" ? 1 : 0, env: { ...env, ...maintenance.env,
      MEMORAX_CODE_CURSOR_AGENT_COMMAND: cursorAgent } }));
  const reserved = await nativeJob("maintain", "--repo", maintenanceRepo);
  assert.equal(reserved.job.status, "requested");
  assert.equal(reserved.job.delegation.name, "memorax-repo-memory");
  assert.equal(reserved.job.delegation.background, true);
  const duplicate = await nativeJob("maintain", "--repo", maintenanceRepo);
  assert.equal(duplicate.reason, "active_job");
  assert.equal(duplicate.job.delegation, undefined);
  const invocationLine = reserved.job.delegation.prompt.split("\n").find((line) => line.startsWith('{"executable":'));
  const invocation = JSON.parse(invocationLine);
  assert.equal(invocation.executable, process.execPath);
  assert.equal(invocation.args[0], maintenance.helper);
  assert.deepEqual(invocation.env, maintenance.env);
  const claimed = await nativeJob(...invocation.args.slice(1));
  assert.equal(claimed.status, "claimed");
  assert.match(claimed.instructions, /repo-build\.md/);
  const aborted = await nativeJob("abort", "--repo", maintenanceRepo, "--job", reserved.job.jobId,
    "--run", reserved.job.runId, "--claim-token", claimed.claimToken, "--reason", "cancelled");
  assert.equal(aborted.status, "failed");
  assert.equal(aborted.failureReason, "cancelled");
  assert.equal(requests.length, 0, "Native job coordination must not call MemoraX");
  const prompt = "Use English for this synthetic Cursor fixture.";
  const reply = "I will use English for this synthetic Cursor fixture.";
  assert.equal(JSON.parse(await hook("beforeSubmitPrompt", { prompt })).continue, true);
  nativeDatabase.write({ latestGenerationId: generationId, turns: [{ requestId: generationId, prompt,
    steps: [
      { type: "thinkingMessage", text: "Private synthetic thinking must remain excluded." },
      { type: "toolCall", text: "Synthetic tool payload must remain excluded." },
      { type: "assistantMessage", text: reply },
    ],
  }] });
  await hook("afterAgentResponse", { text: reply });
  assert.equal(requests.length, 0, "Response observation alone must not trigger Add");
  await hook("stop", { status: "completed" });
  for (let attempt = 0; requests.length === 0 && attempt < 50; attempt += 1) await delay(50);
  assert.equal(requests.length, 1, "Exactly one provider request must reach the loopback fixture");
  assert.equal(requests[0].path, "/v1/memories/add");
  assert.deepEqual(requests[0].body.messages.map(({ role, content }) => ({ role, content })), [
    { role: "user", content: prompt }, { role: "assistant", content: reply },
  ]);
  assert.equal(JSON.stringify(requests[0].body).includes(root), false, "Local paths must not reach MemoraX");
  await hook("stop", { status: "completed" });
  await delay(100);
  assert.equal(requests.length, 1, "Duplicate stop must not enqueue another Add");
  // Operational current-turn authority must survive a trace-disabled round trip.
  // POSIX also allows a distinct sibling whose path differs only by trailing space.
  const pathWorkspace = join(root, process.platform === "win32" ? "path workspace" : "path workspace ");
  await mkdir(pathWorkspace);
  if (process.platform !== "win32") await mkdir(pathWorkspace.trimEnd());
  const pathIdentity = { conversation_id: randomUUID(), generation_id: randomUUID(), workspace_roots: [pathWorkspace] };
  const pathSession = JSON.parse(await hook("sessionStart", pathIdentity));
  await hook("beforeSubmitPrompt", { ...pathIdentity, prompt: "Preserve this synthetic workspace scope." });
  const pathSessionDir = join(stateHome, "debug", "traces", "cursor", "sessions", pathIdentity.conversation_id);
  const currentTurn = JSON.parse(await readFile(join(pathSessionDir, ".current-turn.json"), "utf8"));
  assert.equal(currentTurn.trace.cwd, pathWorkspace);
  await assert.rejects(stat(join(pathSessionDir, "events.jsonl")), { code: "ENOENT" });
  const memoryCli = join(packageRoot, "bin", "memorax-cli.mjs");
  const scopedCli = (args, options = {}) => run(process.execPath, [memoryCli, ...args, "--json"], {
    cwd: pathWorkspace, env: { ...env, ...pathSession.env }, ...options,
  }).then(JSON.parse);
  const searched = await scopedCli(["search", "--query", "Synthetic workspace preference"]);
  const added = await scopedCli(["add", "--memory", "Preserve synthetic workspace paths.",
    "--type", "procedural", "--reason", "Explicit package fixture save."]);
  assert.equal(searched.ok, true);
  assert.equal(added.ok, true);
  assert.equal(searched.scopeKind, "local-directory");
  assert.equal(added.effectiveUserId, searched.effectiveUserId);
  assert.deepEqual(requests.slice(1).map(({ path, body }) => [path, body.user_id]), [
    ["/v1/memories/search", searched.effectiveUserId], ["/v1/memories/add", searched.effectiveUserId],
  ]);
  if (process.platform !== "win32") {
    const sibling = await scopedCli(["search", "--query", "Must not cross into the sibling"], {
      cwd: pathWorkspace.trimEnd(), expectedCode: 1,
    });
    assert.equal(sibling.errorCode, "MEMORY_SCOPE_MISMATCH");
    assert.equal(requests.length, 3);
  }
  await assert.rejects(stat(join(pathSessionDir, "events.jsonl")), { code: "ENOENT" });

  // Use the actual Backend parser and trace sink for the projectless reminder;
  // a Hook stdout assertion alone cannot detect a rejected reminder command.
  assert.equal((await runCli("stop")).ok, true);
  env.MEMORAX_CODE_CURSOR_TRACE_ENABLED = "true";
  assert.equal((await runCli("start")).cursorAdapter.enabled, true);
  const generalIdentity = { conversation_id: randomUUID(), generation_id: randomUUID(), workspace_roots: [] };
  const generalPrompt = JSON.parse(await hook("beforeSubmitPrompt", {
    ...generalIdentity, prompt: "Use concise answers in this synthetic general conversation.",
  }));
  assert.ok(generalPrompt.additional_context);
  const generalEventsPath = join(stateHome, "debug", "traces", "cursor", "sessions",
    generalIdentity.conversation_id, "events.jsonl");
  const generalEvents = (await readFile(generalEventsPath, "utf8")).trim().split("\n").map(JSON.parse);
  const reminderEvents = generalEvents.filter(({ type }) => type === "skill_reminder");
  assert.equal(reminderEvents.length, 1, "The projectless reminder must be accepted and persisted");
  assert.equal(reminderEvents[0].trace.workspace_kind, "projectless");
  assert.equal(reminderEvents[0].trace.turn_id, generalIdentity.generation_id);
  assert.equal(requests.length, 3, "Projectless registration and reminders must not call MemoraX");
  const status = await runCli("status");
  assert.equal(status.cursorAdapter.cursorHooks.runtimeObserved, true);
  assert.equal((await runCli("stop")).ok, true);
  assert.deepEqual(JSON.parse(await readFile(hooksPath, "utf8")), userConfig);
  const removed = await runCli("uninstall", ["--no-npm-uninstall"]);
  assert.equal(removed.cursorPlugin.ok, true);
  assert.equal(removed.npmPackageRemoval.skipped, true);
  assert.deepEqual(JSON.parse(await readFile(hooksPath, "utf8")), userConfig);
  await assert.rejects(stat(join(cursorHome, "skills", "memorax-code")), { code: "ENOENT" });
  await assert.rejects(stat(managedAgentPath), { code: "ENOENT" });
  await stat(join(packageRoot, "package.json"));
  console.log("Cursor npm package smoke: installed Hooks → native SQLite → exact Add; native/imported Skill maintenance delegates without Cursor CLI; trace-off scoped CLI, projectless reminder persistence, deduplication and cleanup passed.");
} finally {
  let cleanupError;
  try { await run(process.execPath, [cli, "stop", ...lifecycleArgs]); }
  catch (error) { cleanupError = error; }
  provider.closeAllConnections();
  await new Promise((accept) => provider.close(accept));
  await nativeDatabase?.cleanup();
  if (cleanupError) throw cleanupError;
  await rm(root, { recursive: true, force: true });
}

function run(command, args, options = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { env: options.env ?? env, cwd: options.cwd ?? workspace, shell: options.shell ?? false, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => child.kill(), 20_000);
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.stdin.on("error", (error) => {
      // A child may exit before consuming stdin. Its exit status and captured
      // response still determine the result instead of an unhandled EPIPE.
      if (error.code !== "EPIPE") { clearTimeout(timeout); reject(error); }
    });
    child.on("error", (error) => { clearTimeout(timeout); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === (options.expectedCode ?? 0)) accept(stdout);
      else reject(new Error("Cursor package fixture command failed (" + code + "): " + stdout + stderr));
    });
    child.stdin.end(options.input ?? "");
  });
}

async function commandDirectory(command) {
  for (const directory of String(process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(directory, process.platform === "win32" ? `${command}.exe` : command);
    if ((await stat(candidate).catch(() => undefined))?.isFile()) return directory;
  }
  return undefined;
}
