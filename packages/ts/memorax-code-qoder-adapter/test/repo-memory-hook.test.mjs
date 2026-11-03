import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { sharedRepoMemoryPath } from "../../memorax-code-adapter-common/src/repo-memory/repo-memory-shared-bundle.mjs";
import { repoMemoryRepositoryPath } from "../../memorax-code-adapter-common/src/repo-memory/repo-memory-repository.mjs";
import { fixture, hook, hookInput, json, runNode } from "./support.mjs";

test("Qoder automatic maintenance uses only Backend repoMemoryWorktree and keeps tickets out of reminder traces", async t => {
  const f = await memoryFixture(t);
  const backendRepo = await repository(f, "backend repository"), hookRepo = await repository(f, "hook cwd repository");
  f.repoMemoryWorktree = backendRepo;
  try {
    const input = hookInput(f, { cwd: hookRepo });
    const result = await submit(f, input);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.delegations.length, 1);
    const delegation = f.delegations[0], invocation = invocationFor(delegation.prompt, "claim");
    const repo = invocation.args[invocation.args.indexOf("--repo") + 1];
    assert.equal(repo, realpathSync(backendRepo));
    const jobs = await jobRecords(f);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].repo, realpathSync(backendRepo));
    assert.equal(jobs[0].snapshotHead, git(backendRepo, ["rev-parse", "HEAD"]).trim());
    assert.equal(f.requests.find(entry => entry.path === "/memory/turn-start").body.cwd, hookRepo);
    const trace = f.requests.find(entry => entry.path === "/memory/skill-reminder");
    assert.ok(trace, "the first accepted prompt must exercise the reminder trace");
    assert.equal(trace.body.client, "qoder");
    assert.equal(trace.body.turnId, input.request_set_id);
    const ticket = invocation.args[invocation.args.indexOf("--ticket") + 1];
    assert.match(ticket, /^[a-f0-9]{64}$/);
    assert.equal(JSON.stringify(f.requests).includes(ticket), false);
    assert.equal(JSON.stringify(trace.body).includes("subagent_type"), false);
    assert.equal(JSON.stringify(trace.body).includes("--ticket"), false);
  } finally { await releaseJobs(f); }
});

test("Qoder does not infer an automatic build from Hook cwd when Backend scope or acceptance is absent", async t => {
  const f = await memoryFixture(t), repo = await repository(f, "eligible hook cwd");
  try {
    const scenarios = [
      { repoMemoryWorktree: undefined, recorded: true, rejectTurnStart: false },
      { repoMemoryWorktree: "relative-repository", recorded: true, rejectTurnStart: false },
      { repoMemoryWorktree: repo, recorded: false, rejectTurnStart: false },
      { repoMemoryWorktree: repo, recorded: true, rejectTurnStart: true },
    ];
    for (const [index, scenario] of scenarios.entries()) {
      Object.assign(f, scenario);
      const result = await submit(f, hookInput(f, { cwd: repo, request_set_id: `unresolved-turn-${index}` }));
      assert.equal(result.status, 0, result.stderr);
      assert.equal(f.delegations.length, 0);
      assert.equal((await jobRecords(f)).length, 0);
    }
  } finally { await releaseJobs(f); }
});

test("Qoder existing shared baseline prevents automatic update even when every-commit maintenance is due", async t => {
  const f = await memoryFixture(t), repo = await repository(f, "existing baseline repository");
  f.repoMemoryWorktree = repo;
  const head = git(repo, ["rev-parse", "HEAD"]).trim(), root = sharedRepoMemoryPath(f.memoraxCodeHome, repo);
  await mkdir(join(root, ".repo_memory"), { recursive: true });
  const baseline = { schema: "repo_memory_shared_bundle.v1", repository: repoMemoryRepositoryPath(repo),
    head, ref: "refs/remotes/origin/trunk", publishedAt: "2020-01-01T00:00:00.000Z" };
  await writeFile(join(root, "baseline.json"), JSON.stringify(baseline));
  await writeFile(join(root, ".repo_memory", "PROFILE.md"), `---\nlocal_head: "${head}"\n---\n# Synthetic baseline\n`);
  await writeFile(join(repo, "new-mainline.txt"), "new mainline commit");
  git(repo, ["add", "new-mainline.txt"]); git(repo, ["commit", "--quiet", "-m", "new mainline"]);
  git(repo, ["update-ref", "refs/remotes/origin/trunk", "HEAD"]);
  await writeFile(join(f.memoraxCodeHome, "config.toml"), '[memory.repo_update]\npolicy = "every-commit"\n');
  const validatorLog = join(f.root, "validator-called"), scripts = join(f.qoderHome, "skills", "memorax-code", "scripts");
  await mkdir(scripts, { recursive: true });
  await writeFile(join(scripts, "repo-memory.mjs"), 'import{appendFileSync}from"node:fs";appendFileSync(' + JSON.stringify(validatorLog) + ',"validated\\n");console.log(JSON.stringify({ok:true}));\n');
  try {
    const result = await submit(f, hookInput(f, { cwd: repo }));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(f.delegations.length, 0);
    assert.equal((await jobRecords(f)).length, 0);
    assert.equal(existsSync(validatorLog), false, "auto initialization must not call maintain for an existing baseline");
    assert.equal(existsSync(join(root, "update-attempt.json")), false);
    assert.deepEqual(await json(join(root, "baseline.json")), baseline);
  } finally { await releaseJobs(f); }
});

test("two concurrent Qoder submits produce only one background job and one delegation", async t => {
  const f = await memoryFixture(t), repo = await repository(f, "concurrent repository");
  f.repoMemoryWorktree = repo;
  try {
    const results = await Promise.all([1, 2].map(index => submit(f, hookInput(f, {
      cwd: repo, request_set_id: `concurrent-turn-${index}`, prompt: `Synthetic prompt ${index}.`,
    }))));
    for (const result of results) assert.equal(result.status, 0, result.stderr);
    assert.equal(f.requests.filter(entry => entry.path === "/memory/turn-start").length, 2);
    assert.equal(f.delegations.length, 1);
    const jobs = await jobRecords(f);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, "requested");
    assert.equal(jobs[0].runner, "qoder");
  } finally { await releaseJobs(f); }
});

async function memoryFixture(t) {
  const f = await fixture(t, { server: true });
  f.delegations = [];
  return f;
}

async function repository(f, name) {
  const repo = join(f.root, name);
  await mkdir(repo);
  git(repo, ["init", "--quiet"]); git(repo, ["config", "user.name", "Qoder Hook Test"]); git(repo, ["config", "user.email", "qoder-hook@example.invalid"]);
  await writeFile(join(repo, "README.md"), "# Synthetic repository\n");
  git(repo, ["add", "README.md"]); git(repo, ["commit", "--quiet", "-m", "initial"]);
  git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"]);
  git(repo, ["update-ref", "refs/remotes/origin/trunk", "HEAD"]);
  return repo;
}

async function submit(f, input) {
  const result = await hook(f, input);
  const context = result.stdout ? JSON.parse(result.stdout).hookSpecificOutput?.additionalContext : undefined;
  for (const line of context?.split("\n") ?? []) {
    if (!line.startsWith('{"description"')) continue;
    const value = JSON.parse(line);
    if (value.subagent_type === "memorax-repo-memory") f.delegations.push(value);
  }
  return result;
}

async function releaseJobs(f) {
  const jobs = await jobRecords(f);
  for (const delegation of f.delegations) {
    const invocation = invocationFor(delegation.prompt, "claim");
    const result = await invoke(f, invocation);
    assert.equal(result.status, 0, result.stderr);
    const claim = JSON.parse(result.stdout);
    assert.equal(claim.status, "claimed");
    const abort = await invoke(f, invocationFor(claim.instructions, "abort"));
    assert.equal(abort.status, 1, abort.stderr);
    assert.equal(JSON.parse(abort.stdout).failureReason, "child_failed");
  }
  await Promise.all(jobs.map(async job => {
    if (!Number.isSafeInteger(job.leasePid)) return;
    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      try { process.kill(job.leasePid, 0); }
      catch (error) { if (error.code === "ESRCH") return; throw error; }
      await new Promise(resolveWait => setTimeout(resolveWait, 25));
    }
    assert.fail("synthetic Repo Memory lease guard did not exit after abort");
  }));
}

function invocationFor(prompt, command) {
  const value = prompt.split("\n").filter(line => line.startsWith('{"executable"'))
    .map(line => JSON.parse(line)).find(invocation => invocation.args[1] === command);
  assert.ok(value, `missing ${command} helper invocation`);
  return value;
}

function invoke(f, invocation) {
  assert.equal(invocation.executable, process.execPath);
  return runNode(invocation.args, { cwd: f.root, env: {
    PATH: process.env.PATH, HOME: f.home,
    ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, USERPROFILE: f.home } : {}),
    ...invocation.env,
  } });
}

async function jobRecords(f) {
  const root = join(f.memoraxCodeHome, "repo-memory-jobs");
  if (!existsSync(root)) return [];
  const paths = (await readdir(root)).filter(name => name !== "in-progress").map(name => join(root, name, "job.json"));
  return Promise.all(paths.filter(path => existsSync(path)).map(path => json(path)));
}

function git(repo, args) {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}
