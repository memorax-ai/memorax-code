import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const source = (await readFile(new URL("../.github/workflows/cursor-app-windows-isolation.yml", import.meta.url), "utf8"))
  .replaceAll("\r\n", "\n");

function step(name) {
  const parts = source.split(`      - name: ${name}\n`);
  assert.equal(parts.length, 2);
  return parts[1].split(/\n      - |\n  [a-z][a-z0-9-]*:\n/)[0];
}

const loopbackJob = source.split("\n  windows-loopback-proof:\n")[1].split("\n  windows-install-proof:\n")[0];

function proofScript() {
  const body = step("Run Windows loopback feasibility proof (not native acceptance)").match(/^        run: \|\n([\s\S]*)$/m)?.[1];
  assert.ok(body);
  return body.split("\n").map((line) => line.slice(10)).join("\n").trimEnd();
}

test("Windows prerequisite workflow is manual or reusable only and cannot claim native acceptance", () => {
  assert.match(source, /^name: Cursor App Windows prerequisites \(not native acceptance\)$/m);
  assert.equal(source.split("\non:\n")[1].split("\npermissions:\n")[0].trimEnd(), "  workflow_dispatch:\n  workflow_call:");
  assert.equal(source.split("\npermissions:\n")[1].split("\njobs:\n")[0].trimEnd(), "  contents: read");
  assert.equal((source.match(/^\s*permissions:/gm) ?? []).length, 1);
  const jobs = source.split("\njobs:\n")[1];
  assert.deepEqual([...jobs.matchAll(/^  ([a-z][a-z0-9-]*):$/gm)].map((match) => match[1]), ["windows-loopback-proof", "windows-install-proof", "windows-artifact-proof"]);
  assert.match(jobs, /^    name: Windows loopback feasibility \(not native acceptance\)$/m);
  assert.match(jobs, /^    runs-on: windows-2025$/m);
  assert.match(jobs, /^    timeout-minutes: 10$/m);
  assert.match(source, /actions\/checkout@v7\n        with:\n          persist-credentials: false/);
  assert.match(source, /actions\/setup-node@v7\n        with:\n          node-version: "24"\n          package-manager-cache: false/);
  assert.doesNotMatch(source, /secrets\.|continue-on-error:|\bid-token:|pull_request|schedule:|\bpush:/);
});

test("Windows loopback workflow invokes only its contracts and exact probe with one public report", () => {
  assert.deepEqual([...loopbackJob.matchAll(/\buses: (.+)$/gm)].map((match) => match[1]), [
    "actions/checkout@v7", "actions/setup-node@v7", "actions/upload-artifact@v4",
  ]);
  assert.equal((loopbackJob.match(/^        run:/gm) ?? []).length, 2);
  assert.equal((loopbackJob.match(/^\s+if:/gm) ?? []).length, 1);
  assert.equal((loopbackJob.match(/^      - /gm) ?? []).length, 5);
  assert.equal(step("Test Windows loopback proof contracts").trimEnd(),
    "        run: node --test scripts/cursor-app-windows-isolation-probe.test.mjs scripts/cursor-app-windows-wfp.test.mjs scripts/cursor-app-windows-isolation-workflow.test.mjs scripts/cursor-app-isolation-workflow.test.mjs");
  assert.match(step("Run Windows loopback feasibility proof (not native acceptance)"), /^        shell: pwsh$/m);
  assert.equal(proofScript(), [
    "$reportDirectory = Join-Path $env:RUNNER_TEMP 'cursor-app-windows-isolation'",
    "New-Item -ItemType Directory -Path $reportDirectory -Force | Out-Null",
    "& ./scripts/cursor-app-windows-isolation-check.ps1 -ReportPath (Join-Path $reportDirectory 'report.json')",
    "if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
  ].join("\n"));
  assert.ok(source.indexOf("name: Test Windows loopback proof contracts") < source.indexOf("name: Run Windows loopback feasibility proof"));
  assert.equal(step("Upload public Windows loopback proof").trimEnd(), [
    "        if: always()",
    "        uses: actions/upload-artifact@v4",
    "        with:",
    "          name: cursor-app-windows-loopback-proof",
    "          path: ${{ runner.temp }}/cursor-app-windows-isolation/report.json",
    "          if-no-files-found: error",
  ].join("\n"));
});

test("Windows static artifact job is separate and uploads only its public report", () => {
  const job = source.split("\n  windows-artifact-proof:\n")[1];
  assert.match(job, /^    name: Windows installer signature \(not native acceptance\)$/m);
  assert.match(job, /^    runs-on: windows-2025$/m);
  assert.match(job, /^    timeout-minutes: 15$/m);
  assert.deepEqual([...job.matchAll(/\buses: (.+)$/gm)].map((match) => match[1]), [
    "actions/checkout@v7", "actions/setup-node@v7", "actions/upload-artifact@v4",
  ]);
  assert.equal(step("Test Windows artifact contracts").trimEnd(),
    "        run: node --test scripts/cursor-app-windows-artifact.test.mjs scripts/cursor-app-windows-artifact-check.test.mjs scripts/cursor-app-windows-isolation-workflow.test.mjs");
  assert.equal(step("Verify Windows installers without executing them").trimEnd(), [
    "        shell: pwsh", "        run: |",
    "          node scripts/cursor-app-windows-artifact-check.mjs (Join-Path $env:RUNNER_TEMP 'cursor-app-windows-artifact')",
    "          if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
  ].join("\n"));
  assert.equal(step("Upload public Windows artifact proof").trimEnd(), [
    "        if: always()", "        uses: actions/upload-artifact@v4", "        with:",
    "          name: cursor-app-windows-artifact-proof",
    "          path: ${{ runner.temp }}/cursor-app-windows-artifact/report.json",
    "          if-no-files-found: error",
  ].join("\n"));
  assert.doesNotMatch(loopbackJob, /artifact-check|resolveLatest|Invoke-WebRequest/);
});

test("Windows installation proof is a separate hosted job with exact contracts and public report", () => {
  const job = source.split("\n  windows-install-proof:\n")[1].split("\n  windows-artifact-proof:\n")[0];
  assert.match(job, /^    runs-on: windows-2025$/m);
  assert.match(job, /^    timeout-minutes: 25$/m);
  assert.equal(step("Test Windows restricted installation contracts").trimEnd(),
    "        run: node --test scripts/cursor-app-windows-owned-session.test.mjs scripts/cursor-app-windows-install-check.test.mjs scripts/cursor-app-windows-artifact.test.mjs scripts/cursor-app-windows-installed.test.mjs scripts/cursor-app-windows-isolation-workflow.test.mjs");
  assert.equal(step("Install verified Windows releases under restricted fresh users").trimEnd(), [
    "        shell: pwsh", "        run: |",
    "          node scripts/cursor-app-windows-install-check.mjs (Join-Path $env:RUNNER_TEMP 'cursor-app-windows-install')",
    "          if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }",
  ].join("\n"));
  assert.equal(step("Upload public Windows installation proof").trimEnd(), [
    "        if: always()", "        uses: actions/upload-artifact@v4", "        with:",
    "          name: cursor-app-windows-install-proof",
    "          path: ${{ runner.temp }}/cursor-app-windows-install/report.json",
    "          if-no-files-found: error",
  ].join("\n"));
});

test("Windows proof shell preserves script failure and passes an absolute report path with spaces", { skip: process.platform !== "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cursor-windows-proof-workflow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "scripts"));
  // This fixture replaces the probe; no account, firewall rule or client is created.
  await writeFile(join(root, "scripts/cursor-app-windows-isolation-check.ps1"), [
    "param([Parameter(Mandatory)] [string]$ReportPath)",
    "[System.IO.File]::WriteAllText($env:PROOF_CALLS, $ReportPath)",
    "[System.IO.File]::WriteAllText($ReportPath, $env:PROOF_JSON)",
    "exit ([int]$env:PROOF_EXIT)",
  ].join("\n"));
  for (const exitCode of [0, 1, 23]) {
    const runnerTemp = join(root, `runner temp ${exitCode}`), calls = join(root, `calls-${exitCode}`);
    const report = { kind: "windows-loopback-feasibility", status: exitCode ? "FAIL" : "PASS",
      appStarted: false, nativeAcceptance: false };
    const result = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      "$ErrorActionPreference = 'Stop'\n" + proofScript()], {
      cwd: root, encoding: "utf8", timeout: 10_000,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
        HOME: root, USERPROFILE: root, TEMP: root, TMP: root, RUNNER_TEMP: runnerTemp,
        PROOF_CALLS: calls, PROOF_JSON: JSON.stringify(report), PROOF_EXIT: String(exitCode) },
    });
    assert.ifError(result.error);
    assert.equal(result.status, exitCode);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, "");
    const reportPath = join(runnerTemp, "cursor-app-windows-isolation/report.json");
    assert.equal(await readFile(calls, "utf8"), reportPath);
    assert.deepEqual(JSON.parse(await readFile(reportPath, "utf8")), report);
  }
});
