import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { renderSummary, summarizeEvidence } from "./ci-evidence.mjs";

// Run the real wrappers with fast stubs for npm, installed shims and suite runners, so
// exit-status and evidence behavior are exercised by actual bash or PowerShell.
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const windows = process.platform === "win32";
const pwsh = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"]).status === 0;
const suites = {
  claude: ["claude-install-smoke", "claude-install-interruption-check", "claude-native-check", "claude-permissions-check"],
  codex: ["codex-install-smoke", "codex-native-check", "codex-permissions-check", "codex-install-interruption-check"],
  opencode: ["opencode-install-smoke", "opencode-native-check", "opencode-permissions-check", "opencode-server-check",
    "opencode-install-interruption-check"],
  codebuddy: ["codebuddy-lifecycle-check", "codebuddy-install-interruption-check", "codebuddy-native-check",
    "codebuddy-background-check", "codebuddy-permissions-check"],
};
const directories = { codebuddy: "codebuddy-workbuddy" };
// WorkBuddy reuses the CodeBuddy wrappers with its bundled runtime and its own native suite.
const workbuddySuites = suites.codebuddy.map((suite) => suite.replace(/^codebuddy-native-check$/, "workbuddy-native-check"));

const faultyLedgerTool = `import { readFileSync } from "node:fs";
import { runCli } from "./ci-evidence-real.mjs";
const control = JSON.parse(readFileSync(new URL("../../../fixture-control.json", import.meta.url), "utf8"));
const [command, , event] = process.argv.slice(2);
// Fixture-only fault injection: fail the selected ledger events.
if (command === "ledger" && control.failLedger.some((name) => name === "*" || name === event)) process.exit(1);
process.exitCode = await runCli(process.argv.slice(2));
`;
const stubRunner = `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
const root = new URL("../../../", import.meta.url);
const suite = basename(fileURLToPath(import.meta.url), ".mjs");
const control = JSON.parse(readFileSync(new URL("fixture-control.json", root), "utf8"));
appendFileSync(new URL("environment.log", root), suite + "=" + (process.env.MEMORAX_CI_EVIDENCE_DIR ? "evidence" : "none") + "\\n");
appendFileSync(new URL("evidence-locations.log", root), JSON.stringify([suite, process.env.MEMORAX_CI_EVIDENCE_DIR ?? null]) + "\\n");
// A hanging runner stands in for a suite that is still running when its job is cancelled.
if (control.hang === suite) {
  writeFileSync(new URL("hanging", root), "");
  setTimeout(() => process.exit(9), 120_000);
} else process.exit(control.suites[suite] ?? 0);
`;
const npmStub = `import { appendFileSync, chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const windows = process.platform === "win32";
appendFileSync(new URL("../environment.log", import.meta.url), "npm=" + (process.env.MEMORAX_CI_EVIDENCE_DIR ? "evidence" : "none") + "\\n");
const prefix = args[args.indexOf("--prefix") + 1];
function command(directory, name, output) {
  mkdirSync(directory, { recursive: true });
  if (windows) writeFileSync(join(directory, name + ".cmd"), "@echo off\\r\\n" + (output ? "echo " + output + "\\r\\n" : "") + "exit /b 0\\r\\n");
  else {
    writeFileSync(join(directory, name), "#!/bin/sh\\n" + (output ? "echo '" + output + "'\\n" : "") + "exit 0\\n");
    chmodSync(join(directory, name), 0o755);
  }
}
if (args.includes("--global")) {
  const bin = windows ? prefix : join(prefix, "bin");
  command(bin, "memorax-code", "");
  command(bin, "memorax-cli", "");
  command(bin, "codex", "codex-cli 0.0.0");
  command(bin, "claude", "0.0.0 (Claude Code)");
  const opencode = args.find((arg) => arg.startsWith("opencode-ai@"));
  if (opencode) command(bin, "opencode", opencode.slice("opencode-ai@".length));
  const codebuddy = args.find((arg) => arg.startsWith("@tencent-ai/codebuddy-code@"));
  if (codebuddy) command(bin, "codebuddy", codebuddy.slice("@tencent-ai/codebuddy-code@".length));
} else {
  mkdirSync(join(prefix, "node_modules", "node-pty"), { recursive: true });
  if (args.some((arg) => arg.startsWith("@vscode/ripgrep@"))) {
    const ripgrep = join(prefix, "node_modules", "@vscode", "ripgrep");
    command(join(ripgrep, "bin"), "rg", "ripgrep 0.0.0");
    writeFileSync(join(ripgrep, "index.js"), "module.exports = { rgPath: " + JSON.stringify(join(ripgrep, "bin", windows ? "rg.cmd" : "rg")) + " };\\n");
  }
}
`;

function fixture(t, client) {
  const root = mkdtempSync(join(tmpdir(), `memorax-wrapper-${client}-`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (relative, content, mode) => {
    mkdirSync(dirname(join(root, relative)), { recursive: true });
    writeFileSync(join(root, relative), content);
    if (mode) chmodSync(join(root, relative), mode);
  };
  const copy = (relative, target = relative) => {
    mkdirSync(dirname(join(root, target)), { recursive: true });
    copyFileSync(join(repo, relative), join(root, target));
  };
  const directory = directories[client] ?? client;
  const wrapper = `scripts/ci/${directory}/${client}-install-check.${windows ? "ps1" : "sh"}`;
  copy(wrapper);
  for (const helper of ["ci-evidence.ps1", "codex-install-user-path.ps1", "ci-evidence-projections.mjs"]) copy(`scripts/ci/shared/${helper}`);
  copy("scripts/ci/shared/ci-evidence.mjs", "scripts/ci/shared/ci-evidence-real.mjs");
  write("scripts/ci/shared/ci-evidence.mjs", faultyLedgerTool);
  for (const suite of suites[client]) write(`scripts/ci/${directory}/${suite}.mjs`, stubRunner);
  if (client === "codebuddy") {
    // The wrapper cleanup logs like a runner, so the tests see whether it ran and what it received.
    for (const name of ["workbuddy-native-check", "codebuddy-install-cleanup"]) write(`scripts/ci/${directory}/${name}.mjs`, stubRunner);
    write(`scripts/ci/${directory}/workbuddy-bundled-command-check.mjs`, "process.exit(0);\n");
    if (windows) write("bundle/codebuddy.cmd", "@echo off\r\necho 0.0.0\r\nexit /b 0\r\n");
    else write("bundle/codebuddy", "#!/bin/sh\necho '0.0.0'\nexit 0\n", 0o755);
  }
  write("bin/npm-stub.mjs", npmStub);
  if (windows) write("bin/npm.cmd", "@echo off\r\nnode \"%~dp0npm-stub.mjs\" %*\r\nexit /b %ERRORLEVEL%\r\n");
  else write("bin/npm", "#!/bin/sh\nexec node \"$(dirname \"$0\")/npm-stub.mjs\" \"$@\"\n", 0o755);
  write("tarballs/memorax-memorax-code-0.0.0.tgz", "fixture package\n");
  // Same layout as CI: the wrapper writes into native-evidence/suites, the summary reads native-evidence.
  return { root, client, wrapper: join(root, wrapper), evidence: join(root, "native-evidence", "suites"),
    bundled: join(root, "bundle", windows ? "codebuddy.cmd" : "codebuddy") };
}

function invocation(fx, { evidence = fx.evidence, failing = {}, failLedger = [], hang, workbuddy = false } = {}) {
  writeFileSync(join(fx.root, "fixture-control.json"), JSON.stringify({ suites: failing, failLedger, hang }));
  for (const log of ["environment.log", "evidence-locations.log"]) rmSync(join(fx.root, log), { force: true });
  const env = { ...process.env, PATH: `${join(fx.root, "bin")}${delimiter}${process.env.PATH}` };
  delete env.MEMORAX_CI_EVIDENCE_DIR;
  if (evidence) env.MEMORAX_CI_EVIDENCE_DIR = evidence;
  if (windows) {
    // GitHub runs a pwsh step as a dot-sourced script that exits with $LASTEXITCODE.
    const step = join(fx.root, "github-step.ps1");
    const version = { codex: "-CodexVersion", opencode: "-OpenCodeVersion", claude: "-ClaudeVersion", codebuddy: "-CodeBuddyVersion" }[fx.client];
    const mode = workbuddy ? ` -PreviousVersion '0.1.18' -Client workbuddy -WorkBuddyCommand '${fx.bundled}'` : "";
    writeFileSync(step, ["$ErrorActionPreference = 'stop'",
      `& '${fx.wrapper}' -TarballDirectory '${join(fx.root, "tarballs")}' ${version} '0.0.0'${mode}`,
      "if ((Test-Path -LiteralPath variable:\\LASTEXITCODE)) { exit $LASTEXITCODE }", ""].join("\r\n"));
    return { command: "pwsh", args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `. '${step}'`], env };
  }
  const mode = workbuddy ? ["0.1.18", "workbuddy", fx.bundled] : [];
  return { command: "bash", args: [fx.wrapper, join(fx.root, "tarballs"), "0.0.0", ...mode], env };
}

function logs(fx) {
  const read = (name) => existsSync(join(fx.root, name)) ? readFileSync(join(fx.root, name), "utf8").trim().split(/\r?\n/) : [];
  return { environment: read("environment.log"), locations: read("evidence-locations.log").map((line) => JSON.parse(line)) };
}

function run(fx, options) {
  const { command, args, env } = invocation(fx, options);
  const result = spawnSync(command, args, { env, encoding: "utf8", timeout: 180_000 });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}`, ...logs(fx) };
}

function ledger(evidence) {
  const path = join(evidence, "ledger.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

const shell = windows ? "PowerShell" : "bash";
const firstFailure = { codex: /The Codex installation smoke failed/, opencode: /The OpenCode installation smoke failed/, claude: /The Claude installation smoke failed/,
  codebuddy: /The selected client lifecycle suite failed/ };

for (const client of ["codex", "opencode", "claude", "codebuddy"]) {
  test(`${client} ${shell} wrapper passes, records its phases and hands evidence only to the runners`, (t) => {
    const fx = fixture(t, client);
    const result = run(fx);
    assert.equal(result.status, 0, result.output);
    const events = ledger(fx.evidence);
    assert.deepEqual(events.filter(({ event }) => event === "phase").map(({ phase }) => phase), ["setup", "suites", "cleanup"]);
    assert.deepEqual(events.filter(({ event }) => event === "plan").map(({ suites: planned }) => planned), [suites[client]]);
    assert.deepEqual(events.filter(({ event }) => event === "end").map(({ suite, exitCode }) => [suite, exitCode]),
      suites[client].map((suite) => [suite, 0]));
    assert.ok(result.environment.length > suites[client].length);
    for (const line of result.environment) assert.match(line, line.startsWith("npm=") ? /=none$/ : /=evidence$/);
  });

  test(`${client} ${shell} wrapper keeps a passing result when ledger finalize or every ledger call fails`, (t) => {
    const fx = fixture(t, client);
    for (const failLedger of [["finalize"], ["*"]]) {
      rmSync(fx.evidence, { recursive: true, force: true });
      const result = run(fx, { failLedger });
      assert.equal(result.status, 0, `${failLedger}: ${result.output}`);
      assert.match(result.output, /CI evidence ledger could not be updated/);
    }
  });

  test(`${client} ${shell} wrapper keeps the original suite failure when ledger finalize fails`, (t) => {
    const fx = fixture(t, client);
    const failing = { [suites[client][0]]: 1 };
    const result = run(fx, { failing, failLedger: ["finalize"] });
    assert.equal(result.status, 1, result.output);
    // The CodeBuddy shell wrapper adds no failure message of its own; its exit status is the suite's.
    if (windows || client !== "codebuddy") assert.match(result.output, windows ? firstFailure[client] : /stopped with exit 1/);
    const events = ledger(fx.evidence);
    assert.deepEqual(events.filter(({ event }) => event === "end").map(({ suite, exitCode }) => [suite, exitCode]), [[suites[client][0], 1]]);
    assert.equal(events.some(({ event }) => event === "not_run"), false);
    // The plan still lets the summary report the suites the wrapper never reached.
    const summary = summarizeEvidence(dirname(fx.evidence), { client, os: windows ? "windows-2025" : "ubuntu-24.04", testStepOutcome: "failure" });
    assert.deepEqual(summary.suites.filter(({ suite }) => suites[client].includes(suite)).map(({ status }) => status),
      ["FAIL", ...suites[client].slice(1).map(() => "NOT_RUN")]);
  });

  test(`${client} ${shell} wrapper disables an unusable evidence directory without changing its result`, (t) => {
    const fx = fixture(t, client);
    mkdirSync(fx.evidence, { recursive: true });
    writeFileSync(join(fx.evidence, "existing.txt"), "occupied\n");
    for (const [failing, expected] of [[{}, 0], [{ [suites[client][0]]: 1 }, 1]]) {
      const result = run(fx, { failing });
      assert.equal(result.status, expected, result.output);
      assert.match(result.output, /CI evidence disabled: the evidence directory is unusable/);
      assert.deepEqual(readdirSync(fx.evidence), ["existing.txt"]);
      for (const line of result.environment) assert.match(line, /=none$/);
      // The test step ran without leaving a ledger, so its evidence is unavailable while its outcome stays separate.
      const summary = summarizeEvidence(dirname(fx.evidence), { client, os: windows ? "windows-2025" : "ubuntu-24.04",
        testStepOutcome: expected === 0 ? "success" : "failure", inputsStepOutcome: "skipped" });
      assert.deepEqual([summary.testOutcome, summary.evidenceStatus, summary.evidenceIssues],
        [expected === 0 ? "PASS" : "FAIL", "UNAVAILABLE", ["LEDGER_MISSING"]]);
    }
  });
}

const cleanupLines = (environment) => environment.filter((line) => line.startsWith("codebuddy-install-cleanup="));

test(`codebuddy ${shell} wrapper reports the first failed suite and marks the later ones NOT_RUN`, (t) => {
  const fx = fixture(t, "codebuddy");
  const result = run(fx, { failing: { "codebuddy-lifecycle-check": 1 } });
  assert.equal(result.status, 1, result.output);
  if (windows) assert.match(result.output, firstFailure.codebuddy);
  assert.deepEqual(ledger(fx.evidence).filter(({ event }) => event === "not_run").map(({ suite }) => suite), suites.codebuddy.slice(1));
  // The wrapper cleanup still ran once and, like npm, never received the evidence location.
  assert.deepEqual(cleanupLines(result.environment), ["codebuddy-install-cleanup=none"]);
  const os = windows ? "windows-2025" : "ubuntu-24.04";
  const summary = summarizeEvidence(dirname(fx.evidence), { client: "codebuddy", os, testStepOutcome: "failure", inputsStepOutcome: "skipped" });
  assert.deepEqual(summary.suites.map(({ suite, status, evidence }) => [suite, status, evidence]),
    suites.codebuddy.map((suite, index) => [suite, index === 0 ? "FAIL" : "NOT_RUN", "not_instrumented"]));
  // These suites write no journal or result, so COMPLETE covers the wrapper ledger only, as the job summary says.
  assert.deepEqual([summary.testOutcome, summary.category, summary.signature, summary.wrapperPhase, summary.evidenceStatus],
    ["FAIL", "unclassified", `codebuddy|${os}|codebuddy-lifecycle-check|unknown|EXIT_1`, "suites", "COMPLETE"]);
  const rendered = renderSummary(summary);
  assert.match(rendered, /codebuddy-lifecycle-check \*\*FAIL\*\* \(exit 1, not_instrumented\) · codebuddy-install-interruption-check NOT_RUN \(not_instrumented\)/);
  assert.match(rendered, /evidenceStatus covers only the inputs record and the wrapper ledger, not suite-internal diagnostics/);
});

test(`codebuddy ${shell} wrapper leaves a failed suite's end unconfirmed when only its end record is lost`, (t) => {
  const fx = fixture(t, "codebuddy");
  const result = run(fx, { failing: { "codebuddy-lifecycle-check": 7 }, failLedger: ["end"] });
  assert.equal(result.status, windows ? 1 : 7, result.output);
  assert.match(result.output, /CI evidence ledger could not be updated/);
  if (windows) assert.match(result.output, firstFailure.codebuddy);
  assert.deepEqual(cleanupLines(result.environment), ["codebuddy-install-cleanup=none"]);
  assert.deepEqual(ledger(fx.evidence).filter(({ event }) => ["start", "end", "incomplete", "not_run"].includes(event)).map(({ event, suite }) => [event, suite]),
    [["start", "codebuddy-lifecycle-check"], ["incomplete", "codebuddy-lifecycle-check"], ...suites.codebuddy.slice(1).map((suite) => ["not_run", suite])]);
  const os = windows ? "windows-2025" : "ubuntu-24.04";
  const summary = summarizeEvidence(dirname(fx.evidence), { client: "codebuddy", os, testStepOutcome: "failure", inputsStepOutcome: "skipped" });
  assert.deepEqual(summary.suites.map(({ status }) => status), ["INCOMPLETE", "NOT_RUN", "NOT_RUN", "NOT_RUN", "NOT_RUN"]);
  // Nothing shows an interruption, so the suite is not reported as interrupted and the lost record is an evidence gap.
  assert.deepEqual([summary.testOutcome, summary.category, summary.signature, summary.evidenceStatus, summary.evidenceIssues],
    ["FAIL", "unclassified", `codebuddy|${os}|codebuddy-lifecycle-check|unknown|EXIT_UNCONFIRMED`, "PARTIAL",
      ["LEDGER_END_UNCONFIRMED_CODEBUDDY_LIFECYCLE_CHECK"]]);
});

test(`codebuddy ${shell} wrapper keeps a later suite failure and fail-fast when every ledger call fails`, (t) => {
  const fx = fixture(t, "codebuddy");
  const result = run(fx, { failing: { "codebuddy-background-check": 7 }, failLedger: ["*"] });
  // The shell wrapper exits with the suite's status; a PowerShell step reports the thrown failure as 1.
  assert.equal(result.status, windows ? 1 : 7, result.output);
  assert.match(result.output, /CI evidence ledger could not be updated/);
  if (windows) assert.match(result.output, /The selected client background suite failed/);
  assert.deepEqual(result.environment.filter((line) => line.endsWith("=evidence")), suites.codebuddy.slice(0, 4).map((suite) => `${suite}=evidence`));
  assert.deepEqual(cleanupLines(result.environment), ["codebuddy-install-cleanup=none"]);
  assert.deepEqual(ledger(fx.evidence), []);
  const summary = summarizeEvidence(dirname(fx.evidence), { client: "codebuddy", os: windows ? "windows-2025" : "ubuntu-24.04",
    testStepOutcome: "failure", inputsStepOutcome: "skipped" });
  assert.deepEqual([summary.testOutcome, summary.evidenceStatus, summary.evidenceIssues], ["FAIL", "UNAVAILABLE", ["LEDGER_MISSING"]]);
});

test(`codebuddy ${shell} wrapper hands the prepared evidence path to every runner in both client modes`, (t) => {
  const fx = fixture(t, "codebuddy");
  for (const [workbuddy, planned] of [[false, suites.codebuddy], [true, workbuddySuites]]) {
    rmSync(fx.evidence, { recursive: true, force: true });
    const result = run(fx, { workbuddy });
    assert.equal(result.status, 0, result.output);
    const events = ledger(fx.evidence);
    assert.deepEqual(events.filter(({ event }) => event === "plan").map(({ suites: listed }) => listed), [planned]);
    assert.deepEqual(events.filter(({ event }) => event === "end").map(({ suite, exitCode }) => [suite, exitCode]), planned.map((suite) => [suite, 0]));
    // PowerShell clears the whole environment during setup; the runners see the path only through the handoff.
    assert.deepEqual(result.locations, planned.map((suite) => [suite, realpathSync(fx.evidence)]));
  }
});

test(`workbuddy ${shell} mode of the CodeBuddy wrapper keeps its result and environment without an evidence directory`, (t) => {
  const fx = fixture(t, "codebuddy");
  for (const [failing, expected, reached] of [[{}, 0, 5], [{ "workbuddy-native-check": 5 }, windows ? 1 : 5, 3]]) {
    const result = run(fx, { evidence: null, failing, workbuddy: true });
    assert.equal(result.status, expected, result.output);
    assert.equal(existsSync(fx.evidence), false);
    assert.doesNotMatch(result.output, /CI evidence/);
    assert.deepEqual(result.locations.filter(([suite]) => workbuddySuites.includes(suite)),
      workbuddySuites.slice(0, reached).map((suite) => [suite, null]));
    for (const line of result.environment) assert.match(line, /=none$/);
    assert.deepEqual(cleanupLines(result.environment), expected === 0 ? [] : ["codebuddy-install-cleanup=none"]);
  }
});

// Only bash traps the termination signal here, and the Windows self-test step fails on any skipped
// test, so this case is registered only off Windows; real job cancellation is not reproduced.
if (!windows) test("codebuddy bash wrapper records the interrupted suite and the unreached ones when it is terminated", async (t) => {
  const fx = fixture(t, "codebuddy");
  const { command, args, env } = invocation(fx, { hang: "codebuddy-install-interruption-check" });
  const child = spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  const closed = new Promise((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
  const deadline = Date.now() + 60_000;
  while (!existsSync(join(fx.root, "hanging"))) {
    assert.ok(Date.now() < deadline && child.exitCode === null, output);
    await delay(50);
  }
  child.kill("SIGTERM");
  assert.deepEqual(await closed, { code: 143, signal: null }, output);
  assert.deepEqual(ledger(fx.evidence).filter(({ event }) => ["end", "incomplete", "not_run"].includes(event)).map(({ event, suite }) => [event, suite]),
    [["end", "codebuddy-lifecycle-check"], ["incomplete", "codebuddy-install-interruption-check"],
      ...suites.codebuddy.slice(2).map((suite) => ["not_run", suite])]);
  assert.deepEqual(cleanupLines(logs(fx).environment), ["codebuddy-install-cleanup=none"]);
  const summary = summarizeEvidence(dirname(fx.evidence), { client: "codebuddy", os: "ubuntu-24.04", testStepOutcome: "cancelled", inputsStepOutcome: "skipped" });
  assert.deepEqual(summary.suites.map(({ status }) => status), ["PASS", "INCOMPLETE", "NOT_RUN", "NOT_RUN", "NOT_RUN"]);
  // The cancelled step explains the missing end record, so it is not an evidence gap.
  assert.deepEqual([summary.testOutcome, summary.category, summary.signature, summary.evidenceStatus, summary.evidenceIssues],
    ["FAIL", "interrupted", "codebuddy|ubuntu-24.04|codebuddy-install-interruption-check|unknown|INCOMPLETE", "COMPLETE", []]);
});

// Windows requires PowerShell for every test here; only other platforms may lack it.
test("PowerShell evidence helpers restore the caller's $LASTEXITCODE", { skip: !windows && !pwsh && "pwsh is not available" }, (t) => {
  const root = mkdtempSync(join(tmpdir(), "memorax-evidence-pwsh-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  writeFileSync(join(root, "failing-ledger.mjs"),
    "if (process.argv[2] === 'prepare') { console.log(process.argv[3]); process.exit(0); }\nprocess.exit(1);\n");
  mkdirSync(join(root, "evidence"));
  mkdirSync(join(root, "runtime"));
  writeFileSync(join(root, "not-a-directory"), "");
  writeFileSync(join(root, "helpers.ps1"), [
    "$ErrorActionPreference = 'Stop'",
    `. ${quote(join(repo, "scripts/ci/shared/ci-evidence.ps1"))}`,
    `$env:MEMORAX_CI_EVIDENCE_DIR = ${quote(join(root, "evidence"))}`,
    `Initialize-CiEvidence -Tool ${quote(join(root, "failing-ledger.mjs"))} -RuntimeRoot ${quote(join(root, "runtime"))}`,
    "$results = [ordered]@{ enabled = [bool]$script:CiEvidenceDir }",
    "& node -e \"process.exit(7)\"; Write-CiLedger finalize a-suite; $results.afterFailure = $LASTEXITCODE",
    "& node -e \"process.exit(0)\"; Write-CiLedger finalize a-suite; $results.afterSuccess = $LASTEXITCODE",
    "Remove-Variable -Name LASTEXITCODE -Scope Global -ErrorAction SilentlyContinue",
    "Write-CiLedger finalize a-suite; $results.definedAfterUnset = Test-Path -LiteralPath variable:\\LASTEXITCODE",
    `$env:MEMORAX_CI_EVIDENCE_DIR = ${quote(join(root, "not-a-directory"))}`,
    `& node -e "process.exit(5)"; Initialize-CiEvidence -Tool ${quote(join(repo, "scripts/ci/shared/ci-evidence.mjs"))} -RuntimeRoot ${quote(join(root, "runtime"))}`,
    "$results.afterDisabledPrepare = $LASTEXITCODE; $results.disabled = -not $script:CiEvidenceDir",
    "'RESULT=' + ($results | ConvertTo-Json -Compress)", "",
  ].join("\n"));
  const result = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", join(root, "helpers.ps1")], { encoding: "utf8" });
  const output = `${result.stdout}${result.stderr}`;
  assert.equal(result.status, 0, output);
  const line = output.split(/\r?\n/).find((entry) => entry.startsWith("RESULT="));
  assert.ok(line, output);
  assert.deepEqual(JSON.parse(line.slice("RESULT=".length)),
    { enabled: true, afterFailure: 7, afterSuccess: 0, definedAfterUnset: false, afterDisabledPrepare: 5, disabled: true });
  assert.match(output, /CI evidence ledger could not be updated/);
  assert.match(output, /CI evidence disabled: the evidence directory is unusable/);
});
