import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = (await readFile(new URL("../.github/workflows/cursor-app-isolation.yml", import.meta.url), "utf8"))
  .replaceAll("\r\n", "\n");

// These narrow source contracts execute the actual shell block without treating
// the workflow as a general YAML format or launching a native App.
function step(name) {
  const parts = source.split(`      - name: ${name}\n`);
  assert.equal(parts.length, 2);
  return parts[1].split(/\n      - /)[0];
}
function proofScript() {
  const body = step("Run macOS network isolation proof (not native acceptance)").match(/^        run: \|\n([\s\S]*)$/m)?.[1];
  assert.ok(body);
  return body.split("\n").map((line) => line.slice(10)).join("\n").trimEnd();
}

test("native workflow calls the proof only when explicitly requested alongside normal acceptance", async () => {
  const caller = await readFile(new URL("../.github/workflows/macos-codex-install.yml", import.meta.url), "utf8");
  assert.match(caller, /check_cursor_macos_isolation:\n        description: [^\n]+\n        type: boolean\n        default: false/);
  const job = caller.split("\n  cursor-macos-network-proof:\n")[1]?.split(/\n  [a-z][a-z0-9-]*:\n/)[0];
  assert.ok(job);
  assert.match(job, /^    uses: \.\/\.github\/workflows\/cursor-app-isolation.yml$/m);
  assert.doesNotMatch(job, /continue-on-error:|secrets:|needs:/);
  const condition = job.match(/^    if: (.+)$/m)?.[1];
  assert.ok(condition);
  for (const event of ["push", "pull_request", "workflow_dispatch"]) {
    for (const requested of [false, true]) for (const provider of [false, true]) for (const diagnostic of [false, true]) {
      assert.equal(Boolean(runInNewContext(condition, { github: { event_name: event },
        inputs: { check_cursor_macos_isolation: requested, check_deepseek: provider, diagnose_opencode_initialization: diagnostic },
      }, { timeout: 100 })), event === "workflow_dispatch" && requested && !provider && !diagnostic);
    }
  }
});

test("network proof allows only manual or reusable calls to a read-only macOS Node 24 job", () => {
  assert.match(source, /^name: Cursor App Network isolation proof \(not native acceptance\)$/m);
  assert.equal(source.split("\non:\n")[1].split("\npermissions:\n")[0].trimEnd(), "  workflow_dispatch:\n  workflow_call:");
  assert.equal(source.split("\npermissions:\n")[1].split("\njobs:\n")[0].trimEnd(), "  contents: read");
  assert.equal((source.match(/^\s*permissions:/gm) ?? []).length, 1);
  const jobs = source.split("\njobs:\n")[1];
  assert.deepEqual([...jobs.matchAll(/^  ([a-z][a-z0-9-]*):$/gm)].map((match) => match[1]), ["macos-network-proof"]);
  assert.match(jobs, /^    name: macOS Network isolation proof \(not native acceptance\)$/m);
  assert.match(jobs, /^    runs-on: macos-15$/m);
  assert.match(jobs, /^    timeout-minutes: 10$/m);
  assert.match(source, /actions\/checkout@v7\n        with:\n          persist-credentials: false/);
  assert.match(source, /actions\/setup-node@v7\n        with:\n          node-version: "24"/);
  assert.doesNotMatch(source, /secrets\.|continue-on-error:|\bid-token:|pull_request|schedule:|\bpush:/);
});

test("workflow runs only the unit contracts, parameterless network proof and one public artifact upload", () => {
  assert.deepEqual([...source.matchAll(/\buses: (.+)$/gm)].map((match) => match[1]), [
    "actions/checkout@v7", "actions/setup-node@v7", "actions/upload-artifact@v4",
  ]);
  assert.equal((source.match(/^        run:/gm) ?? []).length, 2);
  assert.equal((source.match(/^\s+if:/gm) ?? []).length, 1);
  assert.equal((source.match(/^      - /gm) ?? []).length, 5);
  assert.equal(step("Test network isolation proof").trimEnd(),
    "        run: node --test scripts/cursor-app-macos-isolation-check.test.mjs scripts/cursor-app-isolation-workflow.test.mjs");
  assert.equal(proofScript(), 'mkdir -p "$RUNNER_TEMP/cursor-app-isolation"\n'
    + 'node scripts/cursor-app-macos-isolation-check.mjs > "$RUNNER_TEMP/cursor-app-isolation/report.json"');
  assert.ok(source.indexOf("name: Test network isolation proof") < source.indexOf("name: Run macOS network isolation proof"));
  assert.equal(step("Upload public network isolation proof").trimEnd(), [
    "        if: always()",
    "        uses: actions/upload-artifact@v4",
    "        with:",
    "          name: cursor-app-macos-network-isolation-proof",
    "          path: ${{ runner.temp }}/cursor-app-isolation/report.json",
    "          if-no-files-found: error",
  ].join("\n"));
});

test("actual proof shell preserves failure exits, exact arguments and the report even on failure", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cursor-app-isolation-workflow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const exitCode of [0, 1, 23]) {
    const runnerTemp = join(root, `runner temp ${exitCode}`), calls = join(root, `calls-${exitCode}`);
    const report = { schemaVersion: 1, kind: "network-isolation-proof", scope: "sandbox-exec-network-only",
      platform: "darwin", status: exitCode ? "FAIL" : "PASS", appStarted: false, nativeAcceptance: false };
    if (exitCode) report.errorCode = "CURSOR_APP_MACOS_LOOPBACK_NOT_RESTRICTED";
    const body = 'node() { printf "%s\\n" "$@" > "$CALLS"; printf "%s\\n" "$PROBE_JSON"; return "$PROBE_EXIT"; }\n'
      + proofScript();
    const result = spawnSync("/bin/bash", ["-e", "-o", "pipefail", "-c", body], {
      cwd: root, encoding: "utf8", timeout: 5000,
      env: { PATH: "/usr/bin:/bin", HOME: root, RUNNER_TEMP: runnerTemp, CALLS: calls,
        PROBE_JSON: JSON.stringify(report), PROBE_EXIT: String(exitCode) },
    });
    assert.ifError(result.error);
    assert.equal(result.status, exitCode);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    assert.equal(await readFile(calls, "utf8"), "scripts/cursor-app-macos-isolation-check.mjs\n");
    assert.deepEqual(JSON.parse(await readFile(join(runnerTemp, "cursor-app-isolation/report.json"), "utf8")), report);
  }
});
