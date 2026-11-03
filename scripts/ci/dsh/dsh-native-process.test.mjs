import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { runNativeProcess } from "./dsh-native-process.mjs";

test("native timeout preserves redacted diagnostics and kills the owned child tree", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "dsh-native-process-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logPath = join(root, "process.json");
  await assert.rejects(runNativeProcess(process.execPath, ["--input-type=module", "-e", [
    'import { spawn } from "node:child_process";',
    'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);',
    'process.stdout.write(`child=${child.pid} synthetic-secret\\n`);',
    'process.stderr.write("waiting for model fixture\\n");',
    'setInterval(() => {}, 1000);',
  ].join("\n")], {
    cwd: root, env: process.env, timeout: 1_000, logPath,
    redact: (text) => text.replaceAll("synthetic-secret", "[redacted]"),
  }), /after 1000 ms timeout/);
  const report = JSON.parse(await readFile(logPath, "utf8"));
  assert.equal(report.timedOut, true);
  assert.match(report.stdout, /\[redacted\]/);
  assert.doesNotMatch(report.stdout, /synthetic-secret/);
  assert.match(report.stderr, /waiting for model fixture/);
  const descendantPid = Number(report.stdout.match(/child=(\d+)/)?.[1]);
  assert.ok(descendantPid > 1);
  await assertGone(report.pid);
  await assertGone(descendantPid);
});

test("native expected signal remains distinguishable from a timeout", async () => {
  const result = await runNativeProcess(process.execPath, ["-e", 'process.kill(process.pid, "SIGKILL")'], {
    cwd: tmpdir(), env: process.env, timeout: 5_000, expectedExit: null,
  });
  assert.equal(result.signal, "SIGKILL");
});

test("native cleanup reaps a surviving POSIX descendant after the leader exits", {
  skip: process.platform === "win32",
}, async () => {
  const result = await runNativeProcess(process.execPath, ["--input-type=module", "-e", [
    'import { spawn } from "node:child_process";',
    'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    'child.unref();',
    'process.stdout.write(String(child.pid));',
  ].join("\n")], { cwd: tmpdir(), env: process.env });
  await assertGone(Number(result.stdout));
});

async function assertGone(pid) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) {
      if (error.code === "ESRCH") return;
      throw error;
    }
    await delay(10);
  }
  assert.fail(`owned fixture process ${pid} survived cleanup`);
}
