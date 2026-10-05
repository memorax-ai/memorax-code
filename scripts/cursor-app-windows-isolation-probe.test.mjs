import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  classifyConnectionError, connectToFixture, parseProbeConfig, summarizeLevels,
} from "./cursor-app-windows-isolation-probe.mjs";

const config = { allowed4: 31001, denied4: 31002, allowed6: 31003, denied6: 31004 };
function levels(denied = "ACCESS_DENIED") {
  return [0, 1, 2].map((depth) => ({ depth, allowed4: "CONNECTED", allowed6: "CONNECTED",
    denied4: denied, denied6: denied }));
}

test("probe input accepts numeric loopback ports with distinct allow/deny ports per family", () => {
  assert.deepEqual(parseProbeConfig(config), config);
  assert.equal(parseProbeConfig({ ...config, allowed6: config.allowed4 }).allowed6, config.allowed4);
  for (const change of [{ allowed4: 0 }, { allowed4: 65536 }, { allowed4: "31001" },
    { denied4: config.allowed4 }, { host: "example.com" }, { token: "private" }]) {
    assert.throws(() => parseProbeConfig({ ...config, ...change }), /PROBE_CONFIG_INVALID/);
  }
  assert.throws(() => parseProbeConfig(null), /PROBE_CONFIG_INVALID/);
});

test("only an explicit access denial counts, never timeout, refusal or address errors", () => {
  assert.equal(classifyConnectionError({ code: "EACCES", message: "private" }), "ACCESS_DENIED");
  assert.equal(classifyConnectionError({ code: "ECONNREFUSED" }), "REFUSED");
  assert.equal(classifyConnectionError({ code: "ETIMEDOUT" }), "TIMEOUT");
  for (const code of ["EPERM", "EADDRINUSE", "ENETUNREACH", "ENOENT", undefined]) {
    assert.equal(classifyConnectionError({ code }), "OTHER");
  }
});

test("baseline and restricted runs require every gate at all three depths", () => {
  assert.equal(summarizeLevels(levels("CONNECTED"), "baseline").passed, true);
  const report = summarizeLevels(levels(), "restricted");
  assert.equal(report.passed, true);
  assert.equal(report.levelCount, 3);
  assert.equal(report.deniedAttempts, 6);
  assert.deepEqual(report.observations, levels());
  assert.equal(summarizeLevels(levels("CONNECTED"), "restricted").errorCode,
    "CURSOR_APP_WINDOWS_LOOPBACK_NOT_RESTRICTED");
  for (const outcome of ["TIMEOUT", "REFUSED", "OTHER", "INVALID_RESPONSE"]) {
    assert.equal(summarizeLevels(levels(outcome), "restricted").errorCode,
      "CURSOR_APP_WINDOWS_DENIAL_UNPROVEN");
  }
  for (const depth of [0, 1, 2]) for (const key of ["allowed4", "allowed6", "denied4", "denied6"]) {
    const input = levels();
    input[depth][key] = "OTHER";
    assert.equal(summarizeLevels(input, "restricted").passed, false, `${depth}:${key}`);
  }
});

test("summary rejects missing, reordered, extra or unrecognized private output", () => {
  for (const input of [null, levels().slice(0, 2), [...levels(), levels()[0]], levels().reverse(),
    levels().map((entry) => ({ ...entry, sid: "private" })),
    levels().map((entry) => ({ ...entry, denied4: "private" }))]) {
    const summary = summarizeLevels(input, "restricted");
    assert.equal(summary.passed, false);
    assert.equal(summary.errorCode, "CURSOR_APP_WINDOWS_PROBE_OUTPUT_INVALID");
    assert.equal(JSON.stringify(summary).includes("private"), false);
  }
  assert.equal(summarizeLevels(levels(), "other").passed, false);
});

test("owned loopback fixture exchange is required, not merely a successful connect", async (t) => {
  const server = createServer((socket) => {
    socket.once("data", (data) => socket.end(data.toString() === "cursor-loopback-proof\n" ? "fixture-ok\n" : "wrong"));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  assert.equal(await connectToFixture("127.0.0.1", server.address().port), "CONNECTED");
  await assert.rejects(connectToFixture("example.com", server.address().port), /PROBE_CONFIG_INVALID/);
  await assert.rejects(connectToFixture("192.0.2.1", server.address().port), /PROBE_CONFIG_INVALID/);
});

test("PowerShell coordinator is hosted-Windows-only, SID-scoped and uses retained process handles", async () => {
  const source = (await readFile(new URL("./cursor-app-windows-isolation-check.ps1", import.meta.url), "utf8"))
    .replaceAll("\r\n", "\n");
  for (const text of ["GITHUB_ACTIONS", "RUNNER_ENVIRONMENT", "github-hosted", "RUNNER_OS", "ImageOS", "win25",
    "WindowsBuiltInRole]::Administrator", "-LocalUser $localUserSddl", "-Authentication NotRequired",
    "$info.Environment.Clear()", "$info.LoadUserProfile = $false", "GetOwnerSid", ".Kill()", "finally {"])
    assert.ok(source.includes(text), text);
  assert.ok(source.indexOf("Assert-HostedRunner") < source.indexOf("$user = New-LocalUser"));
  assert.ok(source.indexOf("Invoke-ProbeRun 'baseline'") < source.indexOf("New-NetFirewallRule"));
  assert.ok(source.indexOf("New-NetFirewallRule") < source.indexOf("Invoke-ProbeRun 'restricted'"));
  assert.match(source, /appStarted = \$false/);
  assert.match(source, /nativeAcceptance = \$false/);
  assert.match(source, /externalProbes = \$false/);
  assert.match(source, /bounded = \$true/);
  assert.match(source, /if \(\$report.status -ne 'PASS'\) \{ exit 1 \}\s+exit 0\s*$/);
  assert.doesNotMatch(source, /Set-NetFirewallProfile|CheckNetIsolation|Invoke-WebRequest|Invoke-RestMethod|taskkill|Stop-Process|Set-ExecutionPolicy/);
});

test("host guard identifies each failed check without exposing inputs or changing unrelated guards", async (t) => {
  const available = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"],
    { encoding: "utf8", timeout: 10000 });
  if (available.error?.code === "ENOENT") return t.skip("PowerShell is not installed");
  assert.equal(available.status, 0, "PowerShell is required to execute guard fixtures");
  const source = (await readFile(new URL("./cursor-app-windows-isolation-check.ps1", import.meta.url), "utf8"))
    .replaceAll("\r\n", "\n");
  let guard = source.match(/function Assert-HostedRunner \{[\s\S]*?\n\}/)?.[0];
  assert.ok(guard);
  // Replace only OS identity calls; all conditions and diagnostics execute from the real guard.
  for (const type of ["WindowsIdentity", "WindowsPrincipal"]) {
    const target = `[System.Security.Principal.${type}]`;
    assert.equal(guard.split(target).length, 2);
    guard = guard.replace(target, `[Mock${type}]`);
  }
  const cases = [
    { name: "originalImage", expected: null },
    { name: "vs2026Image", env: { ImageOS: "win25-vs2026" }, expected: null },
    { name: "platform", windows: false, expected: "platform" },
    { name: "actions", env: { GITHUB_ACTIONS: "false" }, expected: "actions" },
    { name: "runnerEnvironment", env: { RUNNER_ENVIRONMENT: "self-hosted" }, expected: "runnerEnvironment" },
    { name: "runnerOs", env: { RUNNER_OS: "Linux" }, expected: "runnerOs" },
    ...["win22", "windows-2025", "win25-vs2027", "Win25", "private-env-value"].map((value, index) =>
      ({ name: `unknownImage${index}`, env: { ImageOS: value }, expected: "imageOs" })),
    { name: "runId", env: { GITHUB_RUN_ID: "private-run-id" }, expected: "runId" },
    ...Object.entries({ GITHUB_ACTIONS: "actions", RUNNER_ENVIRONMENT: "runnerEnvironment",
      RUNNER_OS: "runnerOs", ImageOS: "imageOs", GITHUB_RUN_ID: "runId" }).map(([name, expected]) =>
      ({ name: `missing${name}`, env: { [name]: null }, expected })),
    { name: "admin", admin: false, expected: "admin" },
    { name: "identityQueryError", identityError: true, expected: "admin" },
    { name: "firewallService", service: "Stopped", expected: "firewallService" },
    { name: "serviceQueryError", serviceError: true, expected: "firewallService" },
    { name: "firewallProfiles", profilesEnabled: false, expected: "firewallProfiles" },
    { name: "profileQueryError", profileError: true, expected: "firewallProfiles" },
    { name: "firstFailure", windows: false, admin: false, service: "Stopped", expected: "platform" },
  ];
  const script = `
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
class MockWindowsIdentity {
    static [bool] $Fail
    static [MockWindowsIdentity] GetCurrent() {
        if ([MockWindowsIdentity]::Fail) { throw 'private-identity-error' }
        return [MockWindowsIdentity]::new()
    }
    [void] Dispose() {}
}
class MockWindowsPrincipal {
    static [bool] $Allowed
    MockWindowsPrincipal([MockWindowsIdentity] $identity) {}
    [bool] IsInRole([object] $role) { return [MockWindowsPrincipal]::Allowed }
}
function Get-Service {
    $script:queries += 'firewallService'
    if ($case.ContainsKey('serviceError')) { throw 'private-service-error' }
    [pscustomobject]@{ Status = $(if ($case.ContainsKey('service')) { $case.service } else { 'Running' }) }
}
function Get-NetFirewallProfile {
    $script:queries += 'firewallProfiles'
    if ($case.ContainsKey('profileError')) { throw 'private-profile-error' }
    [pscustomobject]@{ Enabled = $true }
    [pscustomobject]@{ Enabled = (-not $case.ContainsKey('profilesEnabled')) }
    [pscustomobject]@{ Enabled = $true }
}
${guard}
$results = foreach ($case in ('${JSON.stringify(cases)}' | ConvertFrom-Json -AsHashtable)) {
    $values = @{ GITHUB_ACTIONS = 'true'; RUNNER_ENVIRONMENT = 'github-hosted'; RUNNER_OS = 'Windows'; ImageOS = 'win25'; GITHUB_RUN_ID = '123' }
    if ($case.ContainsKey('env')) { foreach ($entry in $case.env.GetEnumerator()) { $values[$entry.Key] = $entry.Value } }
    foreach ($entry in $values.GetEnumerator()) { [Environment]::SetEnvironmentVariable($entry.Key, $entry.Value, 'Process') }
    Set-Variable -Name IsWindows -Value (-not $case.ContainsKey('windows')) -Scope Script -Force
    [MockWindowsIdentity]::Fail = $case.ContainsKey('identityError')
    [MockWindowsPrincipal]::Allowed = -not $case.ContainsKey('admin')
    $report = [ordered]@{ failedGuard = 'stale' }
    $script:queries = @()
    $passed = $false
    try { Assert-HostedRunner; $passed = $true } catch {}
    [ordered]@{ name = $case.name; passed = $passed; report = $report; queries = @($script:queries) }
}
ConvertTo-Json -InputObject @($results) -Depth 6 -Compress
`;
  const result = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", timeout: 20000, maxBuffer: 1024 * 1024 });
  assert.equal(result.status, 0, "PowerShell guard fixtures failed");
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /private-|win25|self-hosted/);
  const reports = JSON.parse(result.stdout);
  assert.equal(reports.length, cases.length);
  for (const [index, entry] of cases.entries()) {
    const expectedQueries = entry.expected === null || entry.expected === "firewallProfiles"
      ? ["firewallService", "firewallProfiles"] : entry.expected === "firewallService" ? ["firewallService"] : [];
    assert.deepEqual(reports[index], { name: entry.name, passed: entry.expected === null,
      report: entry.expected === null ? {} : { failedGuard: entry.expected }, queries: expectedQueries }, entry.name);
  }
});

test("version preflight checks owned real Node and projects only bounded numeric diagnostics", async (t) => {
  const available = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "exit 0"],
    { encoding: "utf8", timeout: 10000 });
  if (available.error?.code === "ENOENT") return t.skip("PowerShell is not installed");
  assert.equal(available.status, 0, "PowerShell is required to execute version fixtures");
  const source = (await readFile(new URL("./cursor-app-windows-isolation-check.ps1", import.meta.url), "utf8"))
    .replaceAll("\r\n", "\n");
  const helpers = source.match(/function Start-OwnedNode\([\s\S]*?(?=\nfunction Wait-Ready)/)?.[0];
  const preflight = source.match(/    \$report\.nodeVersionPreflight = [\s\S]*?(?=    \$userName =)/)?.[0];
  assert.ok(helpers);
  assert.ok(preflight);
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const run = (script) => {
    const result = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", timeout: 25000, maxBuffer: 1024 * 1024 });
    assert.equal(result.status, 0, "PowerShell version fixtures failed");
    assert.equal(result.stderr, "");
    assert.doesNotMatch(result.stdout, /private-canary/);
    return JSON.parse(result.stdout);
  };
  const root = await mkdtemp(join(tmpdir(), "memorax-windows-node preflight-"));
  try {
    const node = join(root, "node.exe");
    await copyFile(process.execPath, node);
    const actual = run(`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = ${quote(root)}
$sourceNode = ${quote(process.execPath)}
$node = ${quote(node)}
$owned = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
$report = [ordered]@{}
$errorCode = $null
${helpers}
try {
${preflight}
} catch { $errorCode = if ($_.Exception.Message -ceq 'CURSOR_APP_WINDOWS_HOST_UNSUPPORTED') { $_.Exception.Message } else { 'FIXTURE_FAILED' } }
finally {
    foreach ($process in $owned) {
        if (-not $process.HasExited) { $process.Kill() }
        $null = $process.WaitForExit(5000)
        $process.Dispose()
    }
}
[ordered]@{ report = $report; errorCode = $errorCode; processCount = $owned.Count } | ConvertTo-Json -Depth 6 -Compress
`);
    const [major, minor, patch] = process.versions.node.split(".").map(Number);
    assert.equal(actual.errorCode, major === 24 ? null : "CURSOR_APP_WINDOWS_HOST_UNSUPPORTED");
    assert.equal(actual.processCount, 2);
    assert.equal(actual.report.nodeVersionPreflight.versionsMatch, true);
    for (const kind of ["source", "copied"]) {
      const observation = actual.report.nodeVersionPreflight[kind];
      assert.equal(observation.classification, "semver");
      assert.equal(observation.exitCode, 0);
      assert.deepEqual(observation.version, { major, minor, patch });
      assert.ok(observation.outputLength >= process.version.length + 1 && observation.outputLength <= process.version.length + 2);
      assert.deepEqual(Object.keys(observation).sort(), ["classification", "exitCode", "outputLength", "version"]);
    }
  } finally { await rm(root, { recursive: true, force: true }); }

  const cases = [
    { name: "matching", output: "v24.2.3\n", classification: "semver", version: { major: 24, minor: 2, patch: 3 }, errorCode: null, versionsMatch: true },
    { name: "different", output: "v24.2.4\n", classification: "semver", version: { major: 24, minor: 2, patch: 4 }, errorCode: null },
    { name: "wrongMajor", output: "v22.2.3\n", classification: "semver", version: { major: 22, minor: 2, patch: 3 }, errorCode: "CURSOR_APP_WINDOWS_HOST_UNSUPPORTED" },
    { name: "missing", output: "", classification: "missing", errorCode: "CURSOR_APP_WINDOWS_HOST_UNSUPPORTED" },
    { name: "privateOutput", output: "private-canary-output", classification: "non-semver", errorCode: "CURSOR_APP_WINDOWS_HOST_UNSUPPORTED" },
    { name: "oversized", oversized: true, classification: "oversized", errorCode: "CURSOR_APP_WINDOWS_PROBE_OUTPUT_INVALID" },
    { name: "nonzeroExit", output: "v24.2.3\n", classification: "semver", version: { major: 24, minor: 2, patch: 3 }, exitCode: 7, errorCode: "CURSOR_APP_WINDOWS_PROBE_FAILED" },
    { name: "privateError", output: "v24.2.3\n", classification: "semver", version: { major: 24, minor: 2, patch: 3 }, stderr: "private-canary-error", errorCode: "CURSOR_APP_WINDOWS_PROBE_OUTPUT_INVALID" },
  ];
  const reports = run(`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Start-OwnedNode([string[]]$Arguments, [bool]$AsProbeUser = $false, [string]$Executable = $node) {
    if ($Arguments.Count -ne 1 -or $Arguments[0] -cne '--version' -or @('source', 'copied') -cnotcontains $Executable) { throw 'FIXTURE_ARGUMENTS_INVALID' }
    $text = if ($Executable -eq 'source') { "v24.2.3\`n" } elseif ($case.ContainsKey('oversized')) { 'private-canary' * 1000 } else { $case.output }
    $stderr = if ($Executable -eq 'copied' -and $case.ContainsKey('stderr')) { $case.stderr } else { '' }
    $exitCode = if ($Executable -eq 'copied' -and $case.ContainsKey('exitCode')) { $case.exitCode } else { 0 }
    $instance = [pscustomobject]@{ StandardInput = [System.IO.StringWriter]::new(); StandardOutput = [System.IO.StringReader]::new($text)
        StandardError = [System.IO.StringReader]::new($stderr); ExitCode = [int]$exitCode }
    $instance | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value { param([int]$Timeout); return $true }
    return $instance
}
$results = foreach ($case in ('${JSON.stringify(cases)}' | ConvertFrom-Json -AsHashtable)) {
    $sourceNode = 'source'; $node = 'copied'; $report = [ordered]@{}; $errorCode = $null
    try {
${preflight}
    } catch { $errorCode = if (@('CURSOR_APP_WINDOWS_HOST_UNSUPPORTED', 'CURSOR_APP_WINDOWS_PROBE_FAILED', 'CURSOR_APP_WINDOWS_PROBE_OUTPUT_INVALID') -ccontains $_.Exception.Message) { $_.Exception.Message } else { 'FIXTURE_FAILED' } }
    [ordered]@{ name = $case.name; report = $report; errorCode = $errorCode; executableUnchanged = ($node -ceq 'copied') }
}
ConvertTo-Json -InputObject @($results) -Depth 8 -Compress
`);
  assert.equal(reports.length, cases.length);
  for (const [index, entry] of cases.entries()) {
    const copied = { classification: entry.classification, outputLength: entry.oversized ? 8192 : entry.output.length,
      exitCode: entry.exitCode ?? 0, ...(entry.version ? { version: entry.version } : {}) };
    assert.deepEqual(reports[index], { name: entry.name, report: { nodeVersionPreflight: {
      versionsMatch: entry.versionsMatch ?? false,
      source: { classification: "semver", outputLength: 8, exitCode: 0, version: { major: 24, minor: 2, patch: 3 } }, copied,
    } }, errorCode: entry.errorCode, executableUnchanged: true }, entry.name);
  }
});

test("unproven process cleanup preserves the rule, account and private root for VM teardown", async () => {
  const source = (await readFile(new URL("./cursor-app-windows-isolation-check.ps1", import.meta.url), "utf8"))
    .replaceAll("\r\n", "\n");
  const cleanup = source.split("    $report.cleanup.processHandlesClosed = $processesClosed\n")[1];
  assert.ok(cleanup);
  assert.match(cleanup, /\$rulesRemoved = \$false\s+if \(\$processesClosed\) \{\s+\$rulesRemoved = \$true/);
  assert.match(cleanup, /try \{\s+if \(-not \$processesClosed\) \{ throw 'PROCESS_CLEANUP_UNPROVEN' \}\s+if \(\$user\)/);
  assert.match(cleanup, /if \(\$root -and \(Test-Path -LiteralPath \$root\)\) \{\s+if \(-not \$processesClosed\) \{ throw 'PROCESS_CLEANUP_UNPROVEN' \}\s+Remove-Item/);
  assert.match(cleanup, /\$report.status = 'FAIL'/);
  assert.doesNotMatch(source, /Kill\(\$true\)|Stop-Process|taskkill|Invoke-CimMethod[^\n]*Terminate/);
  assert.doesNotMatch(source, /-ErrorAction SilentlyContinue/);
  assert.match(source, /Get-NetFirewallRule -PolicyStore PersistentStore -ErrorAction Stop \| Where-Object/);
  assert.match(source, /Get-LocalUser -ErrorAction Stop \| Where-Object/);
  assert.match(source, /-Filter "Name='node\.exe'" -OperationTimeoutSec 5 -ErrorAction Stop/);
  assert.match(source, /elseif \(\$owner.Sid -ceq \$user.SID.Value\) \{ \$remaining\+\+ \}/);
  assert.match(source, /if \(\$remaining -ne 0 -or \$unproven\) \{ \$processesClosed = \$false \}/);
});
