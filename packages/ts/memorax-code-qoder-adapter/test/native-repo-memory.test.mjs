import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runQoderRepoMemoryJob } from "../src/native-repo-memory.mjs";
import { markerPathForRepo, readActiveRepoMemoryJobMarker } from "../../memorax-code-adapter-common/src/repo-memory/repo-memory-job-marker.mjs";
import { runRepoMemoryJob } from "../../memorax-code-adapter-common/src/repo-memory/repo-memory-job-supervisor.mjs";
import { readSharedRepoMemory, sharedSnapshotRoot } from "../../memorax-code-adapter-common/src/repo-memory/repo-memory-shared-bundle.mjs";

const adapterRoot = fileURLToPath(new URL("..", import.meta.url));
const commonRoot = fileURLToPath(new URL("../../memorax-code-adapter-common/src", import.meta.url));
const jobHook = join(adapterRoot, "hooks/repo-memory-job.mjs");
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(MEMORAX_CODE_|QODER_|REPO_MEMORY_TEST_)/i.test(key)));

test("Qoder delegates exact native Agent arguments and publishes only the fixed mainline snapshot", t => {
  const f = fixture(t);
  git(f.repo, ["switch", "-c", "feature"]);
  commit(f, "feature.txt");
  writeFileSync(join(f.repo, "dirty.txt"), "uncommitted");
  const featureHead = git(f.repo, ["rev-parse", "HEAD"]).trim();
  const decision = runQoderRepoMemoryJob(["maintain", "--repo", f.repo], f.options);
  assert.equal(decision.action, "build");
  const job = decision.job;
  assert.deepEqual(Object.keys(job.delegation).sort(), ["description", "prompt", "run_in_background", "subagent_type"]);
  assert.equal(job.delegation.subagent_type, "memorax-repo-memory");
  assert.equal(job.delegation.run_in_background, true);
  assert.ok(job.delegation.description.length > 0);
  assert.equal(job.command, undefined);
  assert.equal(job.snapshotHead, f.head);
  const invocation = helperInvocation(job.delegation.prompt);
  assert.equal(invocation.executable, process.execPath);
  assert.equal(invocation.args[0], jobHook);
  assert.deepEqual(invocation.env, { MEMORAX_CODE_HOME: f.home });
  assert.match(job.delegation.prompt, /memorax-cli Search\/Add/);
  assert.match(job.delegation.prompt, /out of memory requests, traces/);
  const persisted = readFileSync(job.jobPath, "utf8");
  assert.equal(persisted.includes(ticket(job)), false);
  assert.equal(JSON.parse(persisted).schema, "qoder_native_repo_memory_job.v1");
  assert.equal(JSON.parse(persisted).runner, "qoder");
  if (process.platform !== "win32") assert.equal(statSync(job.jobPath).mode & 0o777, 0o600);
  const claim = claimJob(f, job), source = sharedSnapshotRoot(job.jobPath);
  assert.equal(claim.status, "claimed");
  assert.ok(claim.instructions.includes(source));
  assert.match(claim.instructions, /absolute source snapshot/);
  assert.match(claim.instructions, /repo-build\.md/);
  assert.match(claim.instructions, /memorax-cli Search\/Add/);
  assert.equal(readFileSync(job.jobPath, "utf8").includes(claim.claimToken), false);
  assert.equal(existsSync(join(source, "feature.txt")), false);
  assert.equal(existsSync(join(source, "dirty.txt")), false);
  profile(source, f.head);
  const result = transition(f, "finish", job, ["--claim-token", claim.claimToken]);
  assert.equal(result.status, "succeeded");
  assert.equal(JSON.stringify(result).includes(claim.claimToken), false);
  assert.equal(result.validation.ok, true);
  const baseline = readSharedRepoMemory(f.home, f.repo);
  assert.equal(baseline.head, f.head);
  assert.equal(existsSync(source), false);
  assert.equal(existsSync(join(f.repo, ".repo_memory")), false);
  assert.equal(git(f.repo, ["rev-parse", "HEAD"]).trim(), featureHead);
  assert.equal(readFileSync(join(f.repo, "dirty.txt"), "utf8"), "uncommitted");
  const linked = join(f.root, "linked");
  git(f.repo, ["worktree", "add", "--detach", linked, f.head]);
  assert.equal(runQoderRepoMemoryJob(["resolve", "--repo", linked], f.options).memoryPath, join(baseline.path, ".repo_memory"));
  assert.equal(runQoderRepoMemoryJob(["maintain", "--repo", linked], f.options).reason, "up_to_date");
});

for (const invalid of [false, true]) {
  test(`Qoder shared update ${invalid ? "retains the old baseline on validation failure" : "publishes after validated finish"}`, t => {
    const f = fixture(t), build = runQoderRepoMemoryJob(["maintain", "--repo", f.repo], f.options).job;
    const firstClaim = claimJob(f, build);
    profile(sharedSnapshotRoot(build.jobPath), f.head);
    assert.equal(transition(f, "finish", build, ["--claim-token", firstClaim.claimToken]).status, "succeeded");
    const first = readSharedRepoMemory(f.home, f.repo);
    commit(f, "main-change.txt");
    const target = git(f.repo, ["rev-parse", "HEAD"]).trim();
    git(f.repo, ["update-ref", "refs/remotes/origin/trunk", target]);
    writeFileSync(join(f.home, "config.toml"), '[memory.repo_update]\npolicy = "every-commit"\n');
    const decision = runQoderRepoMemoryJob(["maintain", "--repo", f.repo], f.options);
    assert.equal(decision.reason, "shared_update_due");
    assert.equal(decision.policyDecision.commitsBehind, 1);
    const job = decision.job, claim = claimJob(f, job), source = sharedSnapshotRoot(job.jobPath);
    assert.match(claim.instructions, /repo-update\.md/);
    profile(source, target);
    if (invalid) writeFileSync(join(source, ".repo_memory/invalid"), "invalid");
    const result = transition(f, "finish", job, ["--claim-token", claim.claimToken]);
    assert.equal(result.status, invalid ? "failed" : "succeeded");
    assert.equal(readSharedRepoMemory(f.home, f.repo).head, invalid ? f.head : target);
    assert.ok(readFileSync(join(first.path, ".repo_memory/PROFILE.md"), "utf8").includes(f.head));
    if (invalid) assert.equal(runQoderRepoMemoryJob(["maintain", "--repo", f.repo], f.options).reason, "shared_update_cooldown");
  });
}

test("Qoder shares single-flight ownership with other runners and only one claimant", async t => {
  const f = fixture(t), driver = driverFor(f);
  const results = await Promise.all([1, 2, 3].map(() => runAsync(driver, ["maintain", "--repo", f.repo])));
  for (const result of results) assert.equal(result.status, 0, result.stderr);
  const decisions = results.map(result => JSON.parse(result.stdout));
  assert.equal(decisions.filter(result => result.job?.delegation).length, 1);
  const job = decisions.find(result => result.job?.delegation).job;
  const other = runRepoMemoryJob(["start", "--mode", "build", "--repo", f.repo], {
    runner: "fixture", memoraxCodeHome: f.home, validatorPath: f.validator,
    evaluateRepository: () => { throw new Error("must not evaluate another client"); },
    createCommand: () => { throw new Error("must not launch another client"); },
  });
  assert.equal(other.alreadyRunning, true);
  assert.equal(other.jobId, job.jobId);
  const args = transitionArgs(f, "claim", job, ["--ticket", ticket(job)]);
  const claims = (await Promise.all([1, 2].map(() => runAsync(driver, args)))).map(result => JSON.parse(result.stdout));
  assert.equal(claims.filter(result => result.status === "claimed").length, 1);
  assert.equal(claims.filter(result => result.reason === "invalid_capability").length, 1);
  assert.equal(claimJob(f, job).reason, "invalid_capability");
  const claim = claims.find(result => result.claimToken);
  assert.equal(transition(f, "finish", job, ["--claim-token", "0".repeat(64)]).reason, "invalid_capability");
  assert.equal(transition(f, "abort", job, ["--claim-token", claim.claimToken, "--reason", "cancelled"]).failureReason, "cancelled");
  assert.equal(transition(f, "finish", job, ["--claim-token", claim.claimToken]).reason, "invalid_job_status");
});

for (const reason of ["snapshot_changed", "artifact_validation_failed", "profile_head_mismatch", "shared_publication_rejected"]) {
  test("Qoder finish rejects " + reason, t => {
    const f = fixture(t), shared = reason === "shared_publication_rejected";
    const job = shared ? runQoderRepoMemoryJob(["maintain", "--repo", f.repo], f.options).job : prepare(f);
    const claim = claimJob(f, job), source = shared ? sharedSnapshotRoot(job.jobPath) : f.repo;
    profile(source, reason === "profile_head_mismatch" ? "0".repeat(40) : f.head);
    if (reason === "snapshot_changed") commit(f, "changed-during-authoring.txt");
    if (reason === "artifact_validation_failed") writeFileSync(f.validator, 'console.log(JSON.stringify({ok:false}));');
    if (shared) writeFileSync(join(source, "README.md"), "changed outside memory");
    const result = transition(f, "finish", job, ["--claim-token", claim.claimToken]);
    assert.equal(result.ok, false);
    assert.equal(result.failureReason, reason);
    assert.equal(active(f).active, false);
    if (shared) assert.equal(readSharedRepoMemory(f.home, f.repo), undefined);
  });
}

test("Qoder rejects repo, run and replacement-owner mismatches", t => {
  const f = fixture(t), job = prepare(f), claim = claimJob(f, job);
  const otherRepo = join(f.root, "other"); mkdirSync(otherRepo);
  assert.throws(() => transition({ ...f, repo: otherRepo }, "finish", job, ["--claim-token", claim.claimToken]), /identity/);
  assert.throws(() => transition(f, "finish", { ...job, runId: "0".repeat(32) }, ["--claim-token", claim.claimToken]), /identity/);
  const markerPath = markerPathForRepo(f.home, f.repo).markerPath;
  const marker = JSON.parse(readFileSync(markerPath));
  marker.runId = "replacement-run"; writeFileSync(markerPath, JSON.stringify(marker));
  assert.equal(transition(f, "finish", job, ["--claim-token", claim.claimToken]).reason, "job_ownership_lost");
  assert.equal(JSON.parse(readFileSync(markerPath)).runId, "replacement-run");
});

test("Qoder refuses expired claims before and after validation without releasing a new owner", t => {
  const f = fixture(t), job = prepare(f);
  const expired = transition(f, "claim", job, ["--ticket", ticket(job)], { now: () => Date.parse(job.expiresAt) + 1 });
  assert.equal(expired.failureReason, "lease_expired");
  const next = prepare(f), claim = claimJob(f, next);
  profile(f.repo, f.head);
  let reads = 0;
  const result = transition(f, "finish", next, ["--claim-token", claim.claimToken], {
    now: () => ++reads === 1 ? Date.now() : Date.parse(claim.expiresAt) + 1,
  });
  assert.equal(result.failureReason, "lease_expired");
  const replacement = prepare(f);
  assert.equal(transition(f, "finish", next, ["--claim-token", claim.claimToken]).reason, "invalid_job_status");
  assert.equal(active(f).marker.jobId, replacement.jobId);
});

test("Qoder abort during validation prevents a late result from overwriting its replacement", async t => {
  const f = fixture(t), job = prepare(f), claim = claimJob(f, job);
  profile(f.repo, f.head);
  const started = join(f.root, "validator-started"), release = join(f.root, "validator-release");
  writeFileSync(f.validator, 'import{existsSync,writeFileSync}from"node:fs";const started=' + JSON.stringify(started) + ',release=' + JSON.stringify(release) + ';writeFileSync(started,"started");const end=Date.now()+10000;while(!existsSync(release)&&Date.now()<end)Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,20);console.log(JSON.stringify({ok:existsSync(release)}));');
  const finishing = runAsync(driverFor(f), transitionArgs(f, "finish", job, ["--claim-token", claim.claimToken]));
  t.after(() => { if (existsSync(f.root)) writeFileSync(release, "release"); });
  await waitFor(() => existsSync(started), "finish validator did not start");
  assert.equal(transition(f, "abort", job, ["--claim-token", claim.claimToken, "--reason", "permission_denied"]).failureReason, "permission_denied");
  const terminal = readFileSync(job.jobPath, "utf8"), replacement = prepare(f);
  writeFileSync(release, "release");
  const result = await finishing;
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).reason, "invalid_job_status");
  assert.equal(readFileSync(job.jobPath, "utf8"), terminal);
  assert.equal(active(f).marker.jobId, replacement.jobId);
});

test("Qoder rechecks installation authority before publishing a prepared job", t => {
  const f = fixture(t);
  let checks = 0;
  assert.throws(() => runQoderRepoMemoryJob(["maintain", "--repo", f.repo], {
    ...f.options, assertEnabled: () => { if (++checks === 3) throw new Error("disabled during snapshot preparation"); },
  }), /disabled during snapshot preparation/);
  assert.equal(checks, 3);
  assert.equal(active(f).active, false);
  const state = states(f)[0];
  assert.equal(state.status, "failed");
  assert.equal(existsSync(sharedSnapshotRoot(join(f.home, "repo-memory-jobs", state.jobId, "job.json"))), false);
});

test("Qoder rechecks installation authority after reading the claim snapshot", t => {
  const f = fixture(t), job = prepare(f);
  let checks = 0;
  assert.throws(() => transition(f, "claim", job, ["--ticket", ticket(job)], {
    assertEnabled: () => { if (++checks === 3) throw new Error("disabled during snapshot read"); },
  }), /disabled during snapshot read/);
  assert.equal(checks, 3);
  assert.equal(JSON.parse(readFileSync(job.jobPath)).status, "requested");
  assert.equal(claimJob(f, job).status, "claimed");
});

test("installed Qoder helper binds metadata home and rejects disabled or superseded start and claim", t => {
  const f = fixture(t), deployed = deploy(f);
  const invoke = args => cli(deployed.helper, args, { MEMORAX_CODE_HOME: join(f.root, "wrong state") });
  const start = invoke(["start", "--mode", "build", "--repo", f.repo]);
  assert.equal(start.status, 0, start.stderr);
  const job = JSON.parse(start.stdout);
  assert.ok(job.jobPath.startsWith(f.home));
  assert.equal(existsSync(join(f.root, "wrong state")), false);
  assert.deepEqual(helperInvocation(job.delegation.prompt).env, { MEMORAX_CODE_HOME: f.home });
  assert.equal(JSON.parse(readFileSync(job.jobPath)).validatorPath, deployed.validator);
  const claimArgs = transitionArgs(f, "claim", job, ["--ticket", ticket(job)]);
  for (const patch of [{ enabled: false }, { installPending: true }, { runtimeDigest: "b".repeat(64) }, { qoderHome: join(f.root, "other-qoder") }]) {
    writeFileSync(deployed.statePath, JSON.stringify({ ...deployed.state, ...patch }));
    for (const args of [["maintain", "--repo", f.repo], ["start", "--mode", "build", "--repo", f.repo], claimArgs]) {
      const result = invoke(args);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /disabled or superseded/);
      assert.equal(JSON.parse(readFileSync(job.jobPath)).status, "requested");
    }
  }
  writeFileSync(deployed.statePath, JSON.stringify(deployed.state));
  writeFileSync(deployed.agentPath, "changed agent definition");
  const changedAgent = invoke(claimArgs);
  assert.equal(changedAgent.status, 1);
  assert.match(changedAgent.stderr, /agent is unavailable or changed/);
  cpSync(deployed.generationAgentPath, deployed.agentPath);
  const claimed = invoke(claimArgs);
  assert.equal(claimed.status, 0, claimed.stderr);
  const claim = JSON.parse(claimed.stdout);
  assert.equal(claim.status, "claimed");
  writeFileSync(deployed.statePath, JSON.stringify({ ...deployed.state, enabled: false }));
  profile(f.repo, f.head);
  const finished = invoke(transitionArgs(f, "finish", job, ["--claim-token", claim.claimToken]));
  assert.equal(finished.status, 0, finished.stderr);
  assert.equal(JSON.parse(finished.stdout).status, "succeeded");
});

test("deployed Qoder helper fails closed without metadata and dry-run never launches a client", t => {
  const f = fixture(t), deployed = deploy(f);
  const dry = cli(deployed.helper, ["maintain", "--repo", f.repo, "--dry-run"], { MEMORAX_CODE_QODER_COMMAND: join(f.root, "must-not-execute") });
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(JSON.parse(dry.stdout).job.execution, "native-subagent");
  assert.equal(JSON.parse(dry.stdout).job.delegation, undefined);
  assert.equal(existsSync(join(f.home, "repo-memory-jobs")), false);
  rmSync(join(dirname(dirname(deployed.helper)), ".memorax-code-package.json"));
  assert.equal(cli(deployed.helper, ["maintain", "--repo", f.repo]).status, 1);
  assert.equal(existsSync(join(f.home, "repo-memory-jobs")), false);
});

test("Qoder source helper uses the canonical validator rather than trusting completion prose", t => {
  const f = fixture(t);
  delete f.options.validatorPath;
  const job = prepare(f), claim = claimJob(f, job);
  profile(f.repo, f.head);
  const result = cli(jobHook, transitionArgs(f, "finish", job, ["--claim-token", claim.claimToken]), { MEMORAX_CODE_HOME: f.home });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).failureReason, "artifact_validation_failed");
});

function fixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "qoder native memory ")));
  const repo = join(root, "repo with spaces"), home = join(root, "private state");
  const f = { root, repo, home };
  t.after(async () => {
    const pids = states(f).map(state => state.leasePid).filter(pid => Number.isSafeInteger(pid) && pid > 0);
    rmSync(root, { recursive: true, force: true });
    try { await Promise.all(pids.map(pid => waitFor(() => { try { process.kill(pid, 0); return false; } catch (error) { if (error.code === "ESRCH") return true; throw error; } }, "lease guard did not stop"))); }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
  mkdirSync(repo);
  git(repo, ["init", "--quiet"]); git(repo, ["config", "user.name", "Qoder Test"]); git(repo, ["config", "user.email", "qoder@example.invalid"]);
  writeFileSync(join(repo, "README.md"), "# Isolated test\n");
  git(repo, ["add", "README.md"]); git(repo, ["commit", "--quiet", "-m", "initial"]);
  const head = git(repo, ["rev-parse", "HEAD"]).trim();
  git(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk"]); git(repo, ["update-ref", "refs/remotes/origin/trunk", head]);
  const validator = join(root, "validator.mjs");
  writeFileSync(validator, 'import{existsSync}from"node:fs";import{join}from"node:path";const repo=process.argv[3],ok=existsSync(join(repo,".repo_memory/PROFILE.md"))&&!existsSync(join(repo,".repo_memory/invalid"));console.log(JSON.stringify({ok,errors:ok?[]:["fixture_invalid"]}));process.exitCode=ok?0:1;\n');
  return Object.assign(f, { head, validator, options: { memoraxCodeHome: home, validatorPath: validator, helperPath: jobHook, sessionId: "fixture-parent" } });
}

function deploy(f) {
  const qoderHome = join(f.root, "qoder home"), digest = "a".repeat(64);
  const root = join(f.home, "adapters", "qoder", "runtime", "generations", digest);
  for (const file of ["src/native-repo-memory.mjs", "hooks/repo-memory-job.mjs"]) { mkdirSync(dirname(join(root, file)), { recursive: true }); cpSync(join(adapterRoot, file), join(root, file)); }
  cpSync(commonRoot, join(root, "memorax-code-adapter-common", "src"), { recursive: true });
  writeFileSync(join(root, "hooks/runtime-hook.mjs"), "// Synthetic native Hook entrypoint.\n");
  writeFileSync(join(root, ".memorax-code-package.json"), JSON.stringify({ version: 1, memoraxCodeHome: f.home, qoderHome, runtimeDigest: digest }));
  const validator = join(qoderHome, "skills", "memorax-code", "scripts", "repo-memory.mjs");
  mkdirSync(dirname(validator), { recursive: true }); cpSync(f.validator, validator);
  const agentPath = join(qoderHome, "agents", "memorax-repo-memory.md"), generationAgentPath = join(root, "agents", "memorax-repo-memory.md");
  mkdirSync(dirname(agentPath), { recursive: true }); mkdirSync(dirname(generationAgentPath), { recursive: true });
  const agent = "# Synthetic managed native repository-memory agent\n";
  writeFileSync(agentPath, agent); writeFileSync(generationAgentPath, agent);
  const state = { version: 1, runtime: "qoder", integration: "hooks", enabled: true, qoderHome, agentDigest: createHash("sha256").update(agent).digest("hex"), runtimeDigest: digest, runtimePath: join(root, "hooks/runtime-hook.mjs") };
  const statePath = join(f.home, "adapters", "qoder", "state.json"); writeFileSync(statePath, JSON.stringify(state));
  return { helper: join(root, "hooks/repo-memory-job.mjs"), validator, state, statePath, agentPath, generationAgentPath };
}

function states(f) { const path = join(f.home, "repo-memory-jobs"); return existsSync(path) ? readdirSync(path).filter(name => name !== "in-progress").flatMap(name => { const file = join(path, name, "job.json"); return existsSync(file) ? [JSON.parse(readFileSync(file))] : []; }) : []; }
function prepare(f) { return runQoderRepoMemoryJob(["start", "--mode", "build", "--repo", f.repo], f.options); }
function helperInvocation(prompt) { return JSON.parse(prompt.split("\n").find(line => line.startsWith('{"executable"'))); }
function ticket(job) { const { args } = helperInvocation(job.delegation.prompt); return args[args.indexOf("--ticket") + 1]; }
function claimJob(f, job) { return transition(f, "claim", job, ["--ticket", ticket(job)]); }
function transitionArgs(f, command, job, extra = []) { return [command, "--repo", f.repo, "--job", job.jobId, "--run", job.runId, ...extra]; }
function transition(f, command, job, extra = [], options = {}) { return runQoderRepoMemoryJob(transitionArgs(f, command, job, extra), { ...f.options, ...options }); }
function profile(repo, head) { mkdirSync(join(repo, ".repo_memory"), { recursive: true }); writeFileSync(join(repo, ".repo_memory/PROFILE.md"), '---\nlocal_head: "' + head + '"\ngenerated_at: "' + new Date().toISOString() + '"\n---\n# Fixture\n'); }
function active(f) { return readActiveRepoMemoryJobMarker({ memoraxCodeHome: f.home, repoRealpath: f.repo }); }
function commit(f, name) { writeFileSync(join(f.repo, name), name); git(f.repo, ["add", name]); git(f.repo, ["commit", "--quiet", "-m", name]); }
function git(repo, args) { const result = spawnSync("git", args, { cwd: repo, encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); return result.stdout; }
function cli(helper, args, env = {}) { return spawnSync(process.execPath, [helper, ...args], { encoding: "utf8", env: { ...cleanEnv, ...env }, timeout: 15000 }); }
function driverFor(f) { const driver = join(f.root, "driver.mjs"); writeFileSync(driver, "import{runQoderRepoMemoryJob}from " + JSON.stringify(new URL("../src/native-repo-memory.mjs", import.meta.url).href) + ";console.log(JSON.stringify(runQoderRepoMemoryJob(process.argv.slice(2)," + JSON.stringify(f.options) + ")));\n"); return driver; }
function runAsync(driver, args) { return new Promise(resolveResult => { const child = spawn(process.execPath, [driver, ...args], { env: cleanEnv, stdio: ["ignore", "pipe", "pipe"] }); let stdout = "", stderr = ""; child.stdout.on("data", chunk => stdout += chunk); child.stderr.on("data", chunk => stderr += chunk); child.once("close", status => resolveResult({ status, stdout, stderr })); }); }
async function waitFor(predicate, message) { const deadline = Date.now() + 6000; while (Date.now() < deadline) { if (predicate()) return; await new Promise(resolveWait => setTimeout(resolveWait, 25)); } assert.fail(message); }
