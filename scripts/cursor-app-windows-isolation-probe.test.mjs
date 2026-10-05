import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:net";
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
  const source = await readFile(new URL("./cursor-app-windows-isolation-check.ps1", import.meta.url), "utf8");
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

test("unproven process cleanup preserves the rule, account and private root for VM teardown", async () => {
  const source = await readFile(new URL("./cursor-app-windows-isolation-check.ps1", import.meta.url), "utf8");
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
