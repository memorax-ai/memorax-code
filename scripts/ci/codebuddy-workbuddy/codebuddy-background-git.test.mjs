import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { backgroundGitPath, probeBackgroundGit } from "./codebuddy-background-git.mjs";

const exec = promisify(execFile), head = "a".repeat(40);

test("background Git precedes system tools without displacing native, package or Node commands", () => {
  const paths = ["native", "package", "node", "system", "fallback"];
  assert.deepEqual(backgroundGitPath(paths.join(delimiter), join("selected", "git")).split(delimiter),
    ["native", "package", "node", "selected", "system", "fallback"]);
});

test("post-failure Git probes preserve the failing stage and expose only bounded diagnostics", async () => {
  const secret = "PRIVATE_PATH_STDERR_TOKEN_CANARY";
  for (const [failedCall, failure, expected] of [
    [1, { code: "ETIMEDOUT" }, { systemCode: "ETIMEDOUT", timedOut: true }],
    [1, { code: null, killed: true, signal: "SIGKILL" }, { signal: "SIGKILL", timedOut: true }],
    [2, { code: 128 }, { exitCode: 128 }],
    [1, { code: "ENOENT" }, { systemCode: "ENOENT" }],
    [1, { code: secret, signal: secret }, { systemCode: "other", signal: "other" }],
    [1, { code: 2 ** 40 }, {}],
    [1, { code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", killed: true, signal: "SIGKILL" },
      { systemCode: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER", signal: "SIGKILL" }],
  ]) {
    const calls = [], env = { HOME: secret, PATH: "isolated" };
    const result = await probeBackgroundGit({ repository: secret, snapshotHead: head, env }, async (...args) => {
      calls.push(args);
      if (calls.length === failedCall) throw Object.assign(new Error(secret), failure, { stdout: secret, stderr: secret });
      return { stdout: "refs/remotes/origin/main\n" };
    });
    assert.deepEqual(result, { observation: "after_failure", stage: failedCall === 1 ? "symbolic-ref" : "rev-parse",
      refMatches: failedCall === 1 ? null : true, headMatches: null,
      exitCode: null, systemCode: null, signal: null, timedOut: false, ...expected });
    assert.equal(calls.length, failedCall);
    assert.deepEqual(calls[0].slice(0, 2), ["git", ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]]);
    assert.deepEqual(calls[0][2], { cwd: secret, env: { ...env, GIT_NO_LAZY_FETCH: "1" },
      encoding: "utf8", timeout: 2000, killSignal: "SIGKILL", maxBuffer: 128 * 1024, windowsHide: true });
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(env.GIT_NO_LAZY_FETCH, undefined);
  }
  let calls = 0;
  const mismatch = await probeBackgroundGit({ repository: secret, snapshotHead: head, env: {} }, async () => {
    calls++; return { stdout: secret };
  });
  assert.equal(calls, 1);
  assert.equal(mismatch.refMatches, false);
  assert.equal(mismatch.headMatches, null);
  const changed = await probeBackgroundGit({ repository: secret, snapshotHead: head, env: {} }, async (_, args) =>
    ({ stdout: args[0] === "symbolic-ref" ? "refs/remotes/origin/main" : secret }));
  assert.equal(changed.refMatches, true);
  assert.equal(changed.headMatches, false);
});

test("post-failure probes inspect a local fixture without modifying its Git files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "background-git-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = join(root, "repo"), home = join(root, "home");
  await mkdir(home);
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(home, "missing-config"), GIT_TERMINAL_PROMPT: "0",
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) };
  const git = (args) => exec("git", args, { cwd: root, env, timeout: 10_000 });
  await git(["init", "--quiet", repository]);
  await git(["-C", repository, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "--allow-empty", "--no-gpg-sign", "--quiet", "-m", "fixture"]);
  const snapshotHead = (await git(["-C", repository, "rev-parse", "HEAD"])).stdout.trim();
  await git(["-C", repository, "update-ref", "refs/remotes/origin/main", snapshotHead]);
  await git(["-C", repository, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  const before = await readdir(repository, { recursive: true });
  const contents = () => Promise.all(["HEAD", "config", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]
    .map((file) => readFile(join(repository, ".git", file))));
  const original = await contents();
  assert.deepEqual(await probeBackgroundGit({ repository, snapshotHead, env }), {
    observation: "after_failure", stage: "rev-parse", refMatches: true, headMatches: true,
    exitCode: 0, systemCode: null, signal: null, timedOut: false });
  assert.deepEqual(await readdir(repository, { recursive: true }), before);
  assert.deepEqual(await contents(), original);
});
