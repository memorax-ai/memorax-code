import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const coordinator = async () => (await readFile(new URL("./cursor-app-windows-isolation-check.ps1", import.meta.url), "utf8"))
  .replaceAll("\r\n", "\n");
const quote = (value) => `'${value.replaceAll("'", "''")}'`;

function runPowerShell(script, timeout = 25000) {
  return spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", timeout, maxBuffer: 1024 * 1024 });
}

test("WFP proof installs exact TCP permits over same-SID default blocks and keeps static objects after engine close", async () => {
  const source = await readFile(new URL("./cursor-app-windows-wfp.cpp", import.meta.url), "utf8");
  for (const key of ["FWPM_CONDITION_ALE_USER_ID", "FWPM_CONDITION_IP_PROTOCOL",
    "FWPM_CONDITION_IP_REMOTE_ADDRESS", "FWPM_CONDITION_IP_REMOTE_PORT"])
    assert.ok(source.includes(key), key);
  assert.match(source, /numFilterConditions = allow \? 4 : 1;/);
  assert.match(source, /FWP_ACTION_PERMIT : FWP_ACTION_BLOCK/);
  assert.match(source, /allowWeight = 0xFFFFFFFFFFFFFFFFull/);
  assert.match(source, /blockWeight = 0xFFFFFFFFFFFFFFFEull/);
  assert.match(source, /session\.flags = 0;/);
  assert.match(source, /filter\.flags = 0;/);
  assert.match(source, /FwpmTransactionCommit0/);
  assert.match(source, /FwpmFilterGetByKey0/);
  assert.match(source, /FwpmFilterDeleteByKey0/);
  assert.match(source, /FwpmSubLayerDeleteByKey0/);
  assert.doesNotMatch(source, /FWPM_SESSION_FLAG_DYNAMIC|FWPM_FILTER_FLAG_PERSISTENT|FWPM_FILTER_FLAG_BOOTTIME|FWPM_FILTER_FLAG_CLEAR_ACTION_RIGHT|FWP_MATCH_NOT_EQUAL/);
  assert.ok(source.indexOf("VerifyPolicy(engine, plan, false);") < source.indexOf("engine.Close();"));
});

test("WFP action verification compares the unsigned SDK action type", async () => {
  const source = await readFile(new URL("./cursor-app-windows-wfp.cpp", import.meta.url), "utf8");
  const verification = source.match(/bool OwnedFilter\([\s\S]*?(?=\nFWPM_SUBLAYER0 BuildSubLayer)/)?.[0];
  assert.ok(verification);
  assert.match(verification, /const FWP_ACTION_TYPE expectedAction = allow \? FWP_ACTION_PERMIT : FWP_ACTION_BLOCK;/);
  assert.match(verification, /filter\.action\.type != expectedAction/);
  assert.doesNotMatch(verification, /filter\.action\.type\s*[!=]=\s*\(allow\s*\?/);
});

test("coordinator closes installation before probing and retains WFP objects on uncertain process cleanup", async () => {
  const source = await coordinator();
  assert.match(source, /scope = 'windows-wfp-user-direct-outbound-only'/);
  assert.match(source, /dnsBrokerIsolation = 'not-verified'/);
  assert.match(source, /otherSidBrokerIsolation = 'not-enforced'/);
  assert.ok(source.indexOf("Invoke-Wfp 'install'") < source.indexOf("Invoke-Wfp 'verify'"));
  assert.ok(source.indexOf("Invoke-Wfp 'verify'") < source.indexOf("Invoke-ProbeRun 'restricted'"));
  assert.match(source, /if \(\$processesClosed\) \{[\s\S]*?Invoke-Wfp 'remove' \$false/);
  assert.match(source, /\$controllerAcl\.SetAccessRuleProtection\(\$true, \$false\)/);
  assert.doesNotMatch(source, /New-NetFirewallRule|Remove-NetFirewallRule|Set-NetFirewallProfile/);
  assert.match(source, /\$wfpArguments = @\(\$user\.SID\.Value[\s\S]*?Invoke-Wfp 'install'/);
  assert.match(source, /\[string\]\$config.allowed4, \[string\]\$config.allowed6\)/);
  assert.match(source, /\$info\.Environment\.Clear\(\)/);
  assert.ok(source.indexOf("Set-Acl -LiteralPath $controllerRoot") < source.indexOf("Build-WfpHelper $wfpSource $wfp"));
});

test("actual WFP invocation projects fixed diagnostics and pins its own cleanup process", async (t) => {
  const available = runPowerShell("exit 0", 10000);
  if (available.error?.code === "ENOENT") return t.skip("PowerShell is not installed");
  assert.equal(available.status, 0);
  const source = await coordinator();
  const helper = source.match(/function Invoke-Wfp\([\s\S]*?(?=\ntry \{)/)?.[0];
  assert.ok(helper);
  const steps = ["input", "engine-open", "transaction-begin", "precheck", "sublayer-add", "filter-plan",
    "filter-add", "verify-sublayer", "verify-filter", "verify-policy", "transaction-commit", "engine-close",
    "filter-delete", "sublayer-delete", "verify-removed", "unexpected"];
  const failure = { status: "FAIL", step: "filter-add", family: "ipv6", nativeErrorCode: 5 };
  const cases = [
    { name: "success", result: { status: "PASS", filterCount: 4 }, exitCode: 0, passed: true },
    ...steps.map((step) => ({ name: step, result: { ...failure, step }, exitCode: 1, diagnostic: { step, family: "ipv6", nativeErrorCode: 5 } })),
    { name: "maxDword", result: { ...failure, family: "none", nativeErrorCode: 4294967295 }, exitCode: 1,
      diagnostic: { step: "filter-add", family: "none", nativeErrorCode: 4294967295 } },
    ...[
      { step: "private-canary-step" }, { family: "private-canary-family" }, { nativeErrorCode: "private-canary-code" },
      { nativeErrorCode: -1 }, { nativeErrorCode: 4294967296 }, { nativeErrorCode: 1.5 }, { private: "private-canary" },
    ].map((change, index) => ({ name: `invalidFailure${index}`, result: { ...failure, ...change }, exitCode: 1 })),
    { name: "stringCount", result: { status: "PASS", filterCount: "4" }, exitCode: 0 },
    { name: "wrongCount", result: { status: "PASS", filterCount: 0 }, exitCode: 0 },
    { name: "extraOutput", result: { status: "PASS", filterCount: 4, private: "private-canary" }, exitCode: 0 },
    { name: "nonzeroSuccess", result: { status: "PASS", filterCount: 4 }, exitCode: 1 },
    { name: "malformed", raw: "private-canary-not-json", exitCode: 1 },
    { name: "oversized", raw: "private-canary".repeat(200), exitCode: 1 },
    { name: "stderr", result: { status: "PASS", filterCount: 4 }, exitCode: 0, stderr: "private-canary-error" },
    { name: "timeout", timeout: true, result: failure, exitCode: 1 },
    { name: "unprovenCleanup", timeout: true, unprovenCleanup: true, result: failure, exitCode: 1 },
    { name: "cleanupFailurePreservesOriginal", result: failure, exitCode: 1, track: false },
  ];
  const result = runPowerShell(`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Start-OwnedNode([string[]]$Arguments, [bool]$AsProbeUser = $false, [string]$Executable, [string]$WorkingDirectory) {
    if ($Arguments.Count -ne 9 -or $AsProbeUser -or $Executable -cne 'controller-helper' -or $WorkingDirectory -cne 'controller-root') { throw 'FIXTURE_ARGUMENTS_INVALID' }
    $text = if ($case.ContainsKey('raw')) { $case.raw } else { $case.result | ConvertTo-Json -Compress }
    $stderr = if ($case.ContainsKey('stderr')) { $case.stderr } else { '' }
    $instance = [pscustomobject]@{ StandardInput = [IO.StringWriter]::new(); StandardOutput = [IO.StringReader]::new($text)
        StandardError = [IO.StringReader]::new($stderr); ExitCode = [int]$case.exitCode
        HasExited = (-not $case.ContainsKey('timeout')); Killed = $false; Disposed = $false }
    $instance | Add-Member -MemberType ScriptMethod -Name WaitForExit -Value {
        param([int]$Timeout)
        if ($Timeout -eq 15000 -and $case.ContainsKey('timeout')) { return $false }
        return -not $case.ContainsKey('unprovenCleanup')
    }
    $instance | Add-Member -MemberType ScriptMethod -Name Kill -Value { $this.Killed = $true }
    $instance | Add-Member -MemberType ScriptMethod -Name Dispose -Value { $this.Disposed = $true }
    $script:lastProcess = $instance
    $owned.Add($instance)
    return $instance
}
${helper}
$results = foreach ($case in ('${JSON.stringify(cases)}' | ConvertFrom-Json -AsHashtable)) {
    $report = [ordered]@{}; $wfp = 'controller-helper'; $controllerRoot = 'controller-root'
    $wfpArguments = @('private-canary-SID', 'layer', 'key1', 'key2', 'key3', 'key4', '31001', '31003')
    $owned = [System.Collections.Generic.List[object]]::new(); $script:wfpProcessesClosed = $true
    $track = -not $case.ContainsKey('track'); $passed = $false
    if (-not $track) { $report.firewallDiagnostic = [ordered]@{ step = 'verify-policy'; family = 'none'; nativeErrorCode = 13 } }
    try { Invoke-Wfp $(if ($track) { 'install' } else { 'remove' }) $track; $passed = $true } catch {}
    [ordered]@{ name = $case.name; passed = $passed; report = $report; retained = $owned.Count
        processesClosed = $script:wfpProcessesClosed; disposed = $script:lastProcess.Disposed; killed = $script:lastProcess.Killed }
}
ConvertTo-Json -InputObject @($results) -Depth 8 -Compress
`);
  assert.equal(result.status, 0, "PowerShell WFP fixtures failed");
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /private-canary|controller-root|controller-helper/);
  const reports = JSON.parse(result.stdout);
  assert.equal(reports.length, cases.length);
  for (const [index, entry] of cases.entries()) {
    const diagnostic = entry.track === false ? { step: "verify-policy", family: "none", nativeErrorCode: 13 } : entry.diagnostic;
    assert.deepEqual(reports[index], { name: entry.name, passed: entry.passed ?? false,
      report: diagnostic ? { firewallDiagnostic: diagnostic } : {}, retained: entry.unprovenCleanup ? 1 : 0,
      processesClosed: !entry.unprovenCleanup, disposed: !entry.unprovenCleanup, killed: !!entry.timeout }, entry.name);
  }
});

test("actual cleanup preserves policy, user and both roots when ownership or process exit is uncertain", async (t) => {
  const available = runPowerShell("exit 0", 10000);
  if (available.error?.code === "ENOENT") return t.skip("PowerShell is not installed");
  assert.equal(available.status, 0);
  const source = await coordinator();
  const cleanup = source.match(/^    \$rulesRemoved = \$false\n[\s\S]*?(?=    if \(\$securePassword\))/m)?.[0];
  assert.ok(cleanup);
  const cases = ["success", "processUnproven", "foreignPolicy", "helperUnproven", "userQueryFailure"];
  const result = runPowerShell(`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
function Invoke-Wfp([string]$Action, [bool]$TrackDiagnostic) {
    if ($Action -cne 'remove' -or $TrackDiagnostic) { throw 'FIXTURE_ARGUMENTS_INVALID' }
    $script:actions += 'remove-policy'
    if ($case -eq 'foreignPolicy') { throw 'private-canary-ownership' }
    if ($case -eq 'helperUnproven') { $script:wfpProcessesClosed = $false }
}
function Get-LocalUser {
    [CmdletBinding()]param()
    if ($case -eq 'userQueryFailure') { throw 'private-canary-query' }
    if ($script:userPresent) { return $user }
}
function Remove-LocalUser { param($SID); $script:userPresent = $false; $script:actions += 'remove-user' }
function Test-Path { param($LiteralPath); return $true }
function Remove-Item { param($LiteralPath, [switch]$Recurse, [switch]$Force); $script:actions += 'remove-directory' }
$results = foreach ($case in ('${JSON.stringify(cases)}' | ConvertFrom-Json)) {
    $report = [ordered]@{ cleanup = [ordered]@{} }
    $user = [pscustomobject]@{ SID = 'private-canary-SID'; Name = 'private-canary-user' }; $userName = $user.Name
    $root = 'private-canary-root'; $controllerRoot = 'private-canary-controller'; $wfpArguments = @('private-canary-plan')
    $processesClosed = $case -ne 'processUnproven'; $script:wfpProcessesClosed = $true
    $script:actions = @(); $script:userPresent = $true
${cleanup}
    [ordered]@{ name = $case; report = $report; actions = @($script:actions) }
}
ConvertTo-Json -InputObject @($results) -Depth 6 -Compress
`);
  assert.equal(result.status, 0, "PowerShell cleanup fixtures failed");
  assert.equal(result.stderr, "");
  assert.doesNotMatch(result.stdout, /private-canary/);
  const reports = JSON.parse(result.stdout);
  assert.deepEqual(reports, cases.map((name) => ({ name, report: { cleanup: {
    processHandlesClosed: !["processUnproven", "helperUnproven"].includes(name),
    wfpObjectsRemoved: !["processUnproven", "foreignPolicy"].includes(name),
    userRemoved: name === "success", ownedFilesRemoved: ["success", "userQueryFailure"].includes(name),
  } }, actions: name === "success" ? ["remove-policy", "remove-user", "remove-directory", "remove-directory"]
    : name === "processUnproven" ? [] : name === "userQueryFailure" ? ["remove-policy", "remove-directory", "remove-directory"] : ["remove-policy"] })));
});

test("Windows SDK compiles the real helper and rejects broad or foreign in-memory filter plans", { skip: process.platform !== "win32" }, async () => {
  const source = await coordinator();
  const build = source.match(/function Build-WfpHelper\([\s\S]*?(?=\nfunction Invoke-Wfp)/)?.[0];
  assert.ok(build);
  const root = await mkdtemp(join(tmpdir(), "memorax-wfp sdk-"));
  try {
    const cpp = join(root, "cursor-app-windows-wfp.cpp");
    const fixture = join(root, "plan-test.cpp");
    const executable = join(root, "helper.exe");
    const testExecutable = join(root, "plan-test.exe");
    await copyFile(new URL("./cursor-app-windows-wfp.cpp", import.meta.url), cpp);
    await writeFile(fixture, `
#define CURSOR_WFP_UNIT_TEST
#include "cursor-app-windows-wfp.cpp"
#include <utility>
int main() {
    try {
        auto unusedRun = &Run; Require(unusedRun != nullptr, "test");
        constexpr auto sid = L"S-1-5-21-111-222-333-1001";
        constexpr auto layer = L"951835f3-a0ec-4cb1-a507-71f31f778001";
        constexpr auto key4 = L"951835f3-a0ec-4cb1-a507-71f31f778002";
        constexpr auto key6 = L"951835f3-a0ec-4cb1-a507-71f31f778003";
        constexpr auto block4 = L"951835f3-a0ec-4cb1-a507-71f31f778004";
        constexpr auto block6 = L"951835f3-a0ec-4cb1-a507-71f31f778005";
        Plan plan(sid, layer, key4, key6, block4, block6, L"31001", L"31003");
        Plan foreign(L"S-1-5-21-111-222-333-1002", layer, key4, key6, block4, block6, L"31001", L"31003");
        Require(plan.allowWeight > plan.blockWeight, "test");
        for (size_t index = 0; index < 4; ++index) {
            const bool allow = index < 2;
            const FWP_ACTION_TYPE expectedAction = allow ? FWP_ACTION_PERMIT : FWP_ACTION_BLOCK;
            FWPM_FILTER0 filter{}; std::array<FWPM_FILTER_CONDITION0, 4> conditions{};
            auto reset = [&] { BuildFilter(plan, index, filter, conditions); Require(OwnedFilter(filter, plan, index), "test"); };
            auto rejected = [&] { Require(!OwnedFilter(filter, plan, index), "test"); reset(); };
            reset();
            Require(filter.numFilterConditions == (allow ? 4u : 1u), "test");
            Require(filter.action.type == expectedAction, "test");
            Require(filter.flags == 0, "test");
            Require(!OwnedFilter(filter, plan, (index + 2) % 4), "test");
            filter.numFilterConditions = 0; rejected();
            filter.numFilterConditions = 3; rejected();
            filter.filterCondition = nullptr; rejected();
            filter.filterKey = plan.subLayer; rejected();
            filter.subLayerKey = plan.keys[index]; rejected();
            filter.layerKey = GUID{}; rejected();
            filter.flags = 1; rejected();
            filter.providerKey = &plan.subLayer; rejected();
            filter.providerData.size = 1; rejected();
            filter.rawContext = 1; rejected();
            filter.action.type = allow ? FWP_ACTION_BLOCK : FWP_ACTION_PERMIT; rejected();
            filter.weight.type = FWP_EMPTY; rejected();
            filter.weight.uint64 = nullptr; rejected();
            filter.weight.uint64 = allow ? &plan.blockWeight : &plan.allowWeight; rejected();
            filter.displayData.name = nullptr; rejected();
            conditions[0].conditionValue.sd = &foreign.sid; rejected();
            conditions[0].conditionValue.sd = nullptr; rejected();
            for (size_t field = 0; field < (allow ? 4u : 1u); ++field) {
                conditions[field].matchType = FWP_MATCH_NOT_EQUAL; rejected();
                conditions[field].conditionValue.type = FWP_EMPTY; rejected();
                conditions[field].fieldKey = GUID{}; rejected();
            }
            if (allow) {
                conditions[1].conditionValue.uint8 = 17; rejected();
                conditions[3].conditionValue.uint16 = 31002; rejected();
                conditions[3].fieldKey = conditions[1].fieldKey; rejected();
                FWP_BYTE_ARRAY16 wrong{};
                if (index == 0) conditions[2].conditionValue.uint32 = 0;
                else conditions[2].conditionValue.byteArray16 = &wrong;
                rejected();
                std::swap(conditions[0], conditions[3]);
                Require(OwnedFilter(filter, plan, index), "test");
            } else {
                filter.numFilterConditions = 2; rejected();
            }
        }
        auto owned = BuildSubLayer(plan); Require(OwnedSubLayer(owned, plan), "test");
        owned.flags = 1; Require(!OwnedSubLayer(owned, plan), "test");
        owned = BuildSubLayer(plan); owned.subLayerKey = plan.keys[0]; Require(!OwnedSubLayer(owned, plan), "test");
        for (auto port : {L"0", L"65536", L"-1", L"1a", L""}) {
            bool invalid = false; try { ParsePort(port); } catch (const Failure& e) { invalid = std::strcmp(e.step, "input") == 0; }
            Require(invalid, "test");
        }
        for (auto badSid : {L"S-1-1-0", L"S-1-5-21-111-222-333-1001)(A;;CC;;;WD", L"private-canary"}) {
            bool invalid = false;
            try { Plan bad(badSid, layer, key4, key6, block4, block6, L"31001", L"31003"); } catch (const Failure& e) { invalid = std::strcmp(e.step, "input") == 0; }
            Require(invalid, "test");
        }
        bool duplicate = false;
        try { Plan bad(sid, layer, key4, key6, key4, block6, L"31001", L"31003"); } catch (const Failure&) { duplicate = true; }
        Require(duplicate, "test");
        duplicate = false;
        try { Plan bad(sid, layer, key4, key6, block4, layer, L"31001", L"31003"); } catch (const Failure&) { duplicate = true; }
        Require(duplicate, "test");
        Require(PrintFailure({"input", "none", 0xFFFFFFFFul}) == 1, "test");
        std::puts("{\\"status\\":\\"PASS\\",\\"scope\\":\\"in-memory-only\\"}");
        return 0;
    } catch (...) { return 1; }
}
`);
    const compilation = runPowerShell(`
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$owned = [System.Collections.Generic.List[System.Diagnostics.Process]]::new()
$script:buildProcessesClosed = $true
${build}
try {
    Build-WfpHelper ${quote(cpp)} ${quote(executable)}
    Build-WfpHelper ${quote(fixture)} ${quote(testExecutable)}
    [Console]::WriteLine('COMPILED')
} finally {
    foreach ($process in $owned) {
        if (-not $process.HasExited) { $process.Kill() }
        $null = $process.WaitForExit(5000)
        $process.Dispose()
    }
}
`, 150000);
    assert.equal(compilation.status, 0, "Windows SDK helper compilation failed");
    assert.equal(compilation.stderr, "");
    assert.equal(compilation.stdout.trim(), "COMPILED");
    const result = spawnSync(testExecutable, [], { cwd: tmpdir(), encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, "in-memory WFP plan validation failed");
    assert.equal(result.stderr, "");
    assert.deepEqual(result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line)), [
      { status: "FAIL", step: "input", family: "none", nativeErrorCode: 4294967295 },
      { status: "PASS", scope: "in-memory-only" },
    ]);
    const invalid = spawnSync(executable, ["private-canary-invalid-action"], { cwd: tmpdir(), encoding: "utf8", timeout: 10000 });
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stderr, "");
    assert.deepEqual(JSON.parse(invalid.stdout), { status: "FAIL", step: "input", family: "none", nativeErrorCode: 13 });
  } finally { await rm(root, { recursive: true, force: true }); }
});
