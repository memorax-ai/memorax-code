import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { summarizeEvidence } from "./ci-evidence.mjs";

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
};

const faultyLedgerTool = `import { readFileSync } from "node:fs";
import { runCli } from "./ci-evidence-real.mjs";
const control = JSON.parse(readFileSync(new URL("../../../fixture-control.json", import.meta.url), "utf8"));
const [command, , event] = process.argv.slice(2);
// Fixture-only fault injection: fail the selected ledger events.
if (command === "ledger" && control.failLedger.some((name) => name === "*" || name === event)) process.exit(1);
process.exitCode = await runCli(process.argv.slice(2));
`;
const stubRunner = `import { appendFileSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
const root = new URL("../../../", import.meta.url);
const suite = basename(fileURLToPath(import.meta.url), ".mjs");
const control = JSON.parse(readFileSync(new URL("fixture-control.json", root), "utf8"));
appendFileSync(new URL("environment.log", root), suite + "=" + (process.env.MEMORAX_CI_EVIDENCE_DIR ? "evidence" : "none") + "\\n");
process.exit(control.suites[suite] ?? 0);
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
  command(bin, "codex", "codex-cli 0.0.0");
  command(bin, "claude", "0.0.0 (Claude Code)");
  const opencode = args.find((arg) => arg.startsWith("opencode-ai@"));
  if (opencode) command(bin, "opencode", opencode.slice("opencode-ai@".length));
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
  const wrapper = `scripts/ci/${client}/${client}-install-check.${windows ? "ps1" : "sh"}`;
  copy(wrapper);
  for (const helper of ["ci-evidence.ps1", "codex-install-user-path.ps1", "ci-evidence-projections.mjs"]) copy(`scripts/ci/shared/${helper}`);
  copy("scripts/ci/shared/ci-evidence.mjs", "scripts/ci/shared/ci-evidence-real.mjs");
  write("scripts/ci/shared/ci-evidence.mjs", faultyLedgerTool);
  for (const suite of suites[client]) write(`scripts/ci/${client}/${suite}.mjs`, stubRunner);
  write("bin/npm-stub.mjs", npmStub);
  if (windows) write("bin/npm.cmd", "@echo off\r\nnode \"%~dp0npm-stub.mjs\" %*\r\nexit /b %ERRORLEVEL%\r\n");
  else write("bin/npm", "#!/bin/sh\nexec node \"$(dirname \"$0\")/npm-stub.mjs\" \"$@\"\n", 0o755);
  write("tarballs/memorax-memorax-code-0.0.0.tgz", "fixture package\n");
  // Same layout as CI: the wrapper writes into native-evidence/suites, the summary reads native-evidence.
  return { root, client, wrapper: join(root, wrapper), evidence: join(root, "native-evidence", "suites") };
}

function run(fx, { evidence = fx.evidence, failing = {}, failLedger = [] } = {}) {
  writeFileSync(join(fx.root, "fixture-control.json"), JSON.stringify({ suites: failing, failLedger }));
  rmSync(join(fx.root, "environment.log"), { force: true });
  const env = { ...process.env, PATH: `${join(fx.root, "bin")}${delimiter}${process.env.PATH}` };
  delete env.MEMORAX_CI_EVIDENCE_DIR;
  if (evidence) env.MEMORAX_CI_EVIDENCE_DIR = evidence;
  let result;
  if (windows) {
    // GitHub runs a pwsh step as a dot-sourced script that exits with $LASTEXITCODE.
    const step = join(fx.root, "github-step.ps1");
    const version = { codex: "-CodexVersion", opencode: "-OpenCodeVersion", claude: "-ClaudeVersion" }[fx.client];
    writeFileSync(step, ["$ErrorActionPreference = 'stop'",
      `& '${fx.wrapper}' -TarballDirectory '${join(fx.root, "tarballs")}' ${version} '0.0.0'`,
      "if ((Test-Path -LiteralPath variable:\\LASTEXITCODE)) { exit $LASTEXITCODE }", ""].join("\r\n"));
    result = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", `. '${step}'`],
      { env, encoding: "utf8", timeout: 180_000 });
  } else {
    result = spawnSync("bash", [fx.wrapper, join(fx.root, "tarballs"), "0.0.0"], { env, encoding: "utf8", timeout: 180_000 });
  }
  const log = join(fx.root, "environment.log");
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    environment: existsSync(log) ? readFileSync(log, "utf8").trim().split(/\r?\n/) : [] };
}

function ledger(evidence) {
  const path = join(evidence, "ledger.jsonl");
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}

const shell = windows ? "PowerShell" : "bash";
const firstFailure = { codex: /The Codex installation smoke failed/, opencode: /The OpenCode installation smoke failed/, claude: /The Claude installation smoke failed/ };

for (const client of ["codex", "opencode", "claude"]) {
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
    assert.match(result.output, windows ? firstFailure[client] : /stopped with exit 1/);
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
