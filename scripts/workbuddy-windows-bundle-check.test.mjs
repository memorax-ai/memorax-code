import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const script = join(dirname(fileURLToPath(import.meta.url)), "workbuddy-windows-bundle-check.ps1");
const windowsOnly = { skip: process.platform !== "win32" };
const sha256 = "627E5A565436D0876740AF69C2747759648662C52958D2A5DF1BA330A82C3025";
const url = "https://download.codebuddy.cn/workbuddy/saas/win32-x64-user/WorkBuddy-win32-x64-user-5.6.2.39298511-37a65c0b.exe";
const command = "WorkBuddy/resources/app.asar.unpacked/cli/bin/codebuddy";

test("Windows acquisition source pins the official installer and fails closed before extraction", async () => {
  const source = await readFile(script, "utf8");
  assert.ok(source.includes(`$url = '${url}'`));
  assert.ok(source.includes(`$sha256 = '${sha256}'`));
  assert.ok(source.includes(`$command = '${command}'`));
  assert.match(source, /-not \$IsWindows.*OSArchitecture -ne 'X64'/);
  assert.match(source, /\$signature\.Status -ne 'Valid'/);
  assert.match(source, /-cne 'Tencent Technology \(Shenzhen\) Company Limited'/);
  assert.ok(source.indexOf("Get-FileHash") < source.indexOf("Get-AuthenticodeSignature"));
  assert.ok(source.indexOf("Get-AuthenticodeSignature") < source.indexOf("& $sevenZip"));
  assert.match(source, /VersionInfo\.ProductVersion -cne '5\.6\.2'/);
  assert.match(source, /'\$PLUGINSDIR\/app-64\.7z'/);
  assert.match(source, /'resources\/app\.asar\.unpacked\/cli\/\*'/);
  assert.doesNotMatch(source, /Start-Process|&\s+\$installer|Invoke-Expression|\bwinget\b|\bchoco\b/);
});

test("Windows acquisition verifies the publisher and extracts the actual complete bundled CLI", windowsOnly, async () => {
  await fixture(async ({ run, calls, destination }) => {
    const result = await run();
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.deepEqual(JSON.parse(result.stdout), { desktopVersion: "5.6.2.39298511", runtimeVersion: "2.147.0",
      arch: "x64", sha256: sha256.toLowerCase(), command });
    assert.equal(result.stdout.includes(destination), false);
    const observed = await calls();
    assert.deepEqual(observed.map((call) => call.tool), ["curl", "hash", "signature", "desktop", "7zip", "7zip"]);
    assert.deepEqual(observed[0].args, ["--disable", "--fail", "--silent", "--show-error", "--location", "--proto", "=https",
      "--proto-redir", "=https", "--connect-timeout", "30", "--max-time", "600", "--retry", "2", "--retry-max-time", "900",
      "--output", join(destination, "WorkBuddy.exe"), url]);
    assert.equal(observed[1].algorithm, "SHA256");
    assert.equal(observed[4].args.at(-1), "$PLUGINSDIR/app-64.7z");
    assert.equal(observed[5].args.at(-1), "resources/app.asar.unpacked/cli/*");
    assert.deepEqual(await readdir(destination), ["WorkBuddy"]);
    assert.equal(await readFile(join(destination, command), "utf8"), "Synthetic bundled CLI; never executed.");
  });
});

test("Windows acquisition refuses a nonempty destination without touching existing data", windowsOnly, async () => {
  await fixture(async ({ run, calls, destination }) => {
    await writeFile(join(destination, "existing.txt"), "Keep this.");
    const result = await run();
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.trim(), "WORKBUDDY_BUNDLE_DESTINATION_NOT_EMPTY");
    assert.deepEqual(await calls(), []);
    assert.equal(await readFile(join(destination, "existing.txt"), "utf8"), "Keep this.");
  });
});

test("Windows acquisition refuses a destination junction before any side effects", windowsOnly, async () => {
  await fixture(async ({ run, calls, destination, outside }) => {
    const link = join(dirname(destination), "destination-link");
    await symlink(outside, link, "junction");
    const result = await run(link);
    assert.equal(result.code, 1);
    assert.equal(result.stderr.trim(), "WORKBUDDY_BUNDLE_DESTINATION_INVALID");
    assert.deepEqual(await calls(), []);
    assert.deepEqual(await readdir(destination), []);
    assert.equal(await readFile(join(outside, "codebuddy"), "utf8"), "Outside data; preserve.");
  });
});

test("Windows acquisition does not publish success when owned cleanup fails", windowsOnly, async () => {
  await fixture(async ({ run, outside }) => {
    const result = await run();
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.trim(), "WORKBUDDY_BUNDLE_CLEANUP_FAILED");
    assert.equal(await readFile(join(outside, "codebuddy"), "utf8"), "Outside data; preserve.");
  }, "cleanup");
});

for (const [scenario, expected, tools] of [
  ["network", "DOWNLOAD_FAILED", ["curl"]],
  ["hash", "HASH_MISMATCH", ["curl", "hash"]],
  ["signature", "SIGNATURE_INVALID", ["curl", "hash", "signature"]],
  ["publisher", "SIGNATURE_INVALID", ["curl", "hash", "signature"]],
  ["signature-error", "SIGNATURE_INVALID", ["curl", "hash", "signature"]],
  ["desktop", "DESKTOP_VERSION_MISMATCH", ["curl", "hash", "signature", "desktop"]],
  ["outer", "EXTRACTION_FAILED", ["curl", "hash", "signature", "desktop", "7zip"]],
  ["missing-payload", "EXTRACTION_FAILED", ["curl", "hash", "signature", "desktop", "7zip"]],
  ["inner", "EXTRACTION_FAILED", ["curl", "hash", "signature", "desktop", "7zip", "7zip"]],
  ["directory-entry", "LAYOUT_INVALID", ["curl", "hash", "signature", "desktop", "7zip", "7zip"]],
  ["runtime", "RUNTIME_VERSION_MISMATCH", ["curl", "hash", "signature", "desktop", "7zip", "7zip"]],
  ["junction", "LAYOUT_INVALID", ["curl", "hash", "signature", "desktop", "7zip", "7zip"]],
]) {
  test(`Windows acquisition stops, redacts and cleans only owned files after ${scenario} failure`, windowsOnly, async () => {
    await fixture(async ({ run, calls, destination, outside }) => {
      const result = await run();
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr.trim(), `WORKBUDDY_BUNDLE_${expected}`);
      assert.deepEqual((await calls()).map((call) => call.tool), tools);
      assert.deepEqual(await readdir(destination), []);
      assert.equal(await readFile(join(outside, "codebuddy"), "utf8"), "Outside data; preserve.");
    }, scenario);
  });
}

async function fixture(callback, scenario = "success") {
  const root = await mkdtemp(join(tmpdir(), "workbuddy-windows-bundle-"));
  const destination = join(root, "download"), outside = join(root, "outside"), callLog = join(root, "calls.jsonl");
  try {
    await Promise.all([destination, outside, join(root, "home"), join(root, "tmp")].map((path) => mkdir(path)));
    await writeFile(join(outside, "codebuddy"), "Outside data; preserve.");
    const runner = join(root, "fixture.ps1");
    await writeFile(runner, `
$ErrorActionPreference = 'Stop'
function Record-Call($Value) { Add-Content -LiteralPath $env:FIXTURE_CALLS -Value ($Value | ConvertTo-Json -Compress -Depth 5) }
function curl.exe {
  # A function retains numeric arguments; a native executable receives strings.
  Record-Call @{ tool = 'curl'; args = [string[]]$args }
  $output = $args[[Array]::IndexOf($args, '--output') + 1]
  [IO.File]::WriteAllText($output, 'Synthetic installer; never executed.')
  $global:LASTEXITCODE = if ($env:FIXTURE_SCENARIO -eq 'network') { 22 } else { 0 }
}
function Get-FileHash {
  param($LiteralPath, $Algorithm)
  Record-Call @{ tool = 'hash'; algorithm = $Algorithm }
  @{ Hash = if ($env:FIXTURE_SCENARIO -eq 'hash') { '0' * 64 } else { '${sha256}' } }
}
function Get-AuthenticodeSignature {
  param($LiteralPath)
  Record-Call @{ tool = 'signature' }
  if ($env:FIXTURE_SCENARIO -eq 'signature-error') { throw "PRIVATE_FIXTURE $LiteralPath secret-token" }
  $certificate = [pscustomobject]@{}
  $certificate | Add-Member -MemberType ScriptMethod -Name GetNameInfo -Value {
    param($Type, $Issuer)
    if ($env:FIXTURE_SCENARIO -eq 'publisher') { return 'Unrelated Publisher' }
    return 'Tencent Technology (Shenzhen) Company Limited'
  }
  @{ Status = if ($env:FIXTURE_SCENARIO -eq 'signature') { 'NotTrusted' } else { 'Valid' }; SignerCertificate = $certificate }
}
function Get-Item {
  param($LiteralPath, [switch]$Force)
  if ($LiteralPath.EndsWith('WorkBuddy.exe')) {
    Record-Call @{ tool = 'desktop' }
    return @{ VersionInfo = @{ ProductVersion = if ($env:FIXTURE_SCENARIO -eq 'desktop') { '0.0.0' } else { '5.6.2' } } }
  }
  Microsoft.PowerShell.Management\\Get-Item -LiteralPath $LiteralPath -Force:$Force
}
function Get-Command {
  param($Name, $CommandType)
  if ($Name -ne '7z.exe' -or $CommandType -ne 'Application') { throw 'Unexpected command lookup' }
  @{ Source = 'Invoke-Fixture7Zip' }
}
function Remove-Item {
  param($LiteralPath, [switch]$Recurse, [switch]$Force)
  if ($env:FIXTURE_SCENARIO -eq 'cleanup') { throw "PRIVATE_FIXTURE $LiteralPath cleanup" }
  Microsoft.PowerShell.Management\\Remove-Item -LiteralPath $LiteralPath -Recurse:$Recurse -Force:$Force
}
function Invoke-Fixture7Zip {
  Record-Call @{ tool = '7zip'; args = @($args) }
  $output = $args[3].Substring(2)
  $global:LASTEXITCODE = 0
  if ($args[4].EndsWith('WorkBuddy.exe')) {
    if ($env:FIXTURE_SCENARIO -eq 'outer') { $global:LASTEXITCODE = 2; return }
    if ($env:FIXTURE_SCENARIO -eq 'missing-payload') { return }
    $payload = Join-Path $output '$PLUGINSDIR/app-64.7z'
    New-Item -ItemType Directory (Split-Path $payload -Parent) | Out-Null
    [IO.File]::WriteAllText($payload, 'Synthetic nested payload.')
    return
  }
  if ($env:FIXTURE_SCENARIO -eq 'inner') { $global:LASTEXITCODE = 2; return }
  $cli = Join-Path $output 'resources/app.asar.unpacked/cli'
  New-Item -ItemType Directory -Force $cli | Out-Null
  if ($env:FIXTURE_SCENARIO -eq 'junction') {
    New-Item -ItemType Junction -Path (Join-Path $cli 'bin') -Target $env:FIXTURE_OUTSIDE | Out-Null
  } else {
    New-Item -ItemType Directory (Join-Path $cli 'bin') | Out-Null
    if ($env:FIXTURE_SCENARIO -eq 'directory-entry') {
      New-Item -ItemType Directory (Join-Path $cli 'bin/codebuddy') | Out-Null
    } else { [IO.File]::WriteAllText((Join-Path $cli 'bin/codebuddy'), 'Synthetic bundled CLI; never executed.') }
  }
  $version = if ($env:FIXTURE_SCENARIO -eq 'runtime') { '0.0.0' } else { '2.147.0' }
  @{ publishConfig = @{ customPackage = @{ version = $version } }; bin = @{ codebuddy = './bin/codebuddy' } } |
    ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $cli 'package.json')
}
& $env:FIXTURE_HELPER -Destination $env:FIXTURE_DESTINATION
exit $LASTEXITCODE
`);
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      HOME: join(root, "home"), USERPROFILE: join(root, "home"), TEMP: join(root, "tmp"), TMP: join(root, "tmp"),
      MEMORAX_CODE_HOME: join(root, "state"), FIXTURE_HELPER: script, FIXTURE_DESTINATION: destination,
      FIXTURE_OUTSIDE: outside, FIXTURE_CALLS: callLog, FIXTURE_SCENARIO: scenario };
    const run = async (target = destination) => {
      try { return { code: 0, ...await execute("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", runner],
        { env: { ...env, FIXTURE_DESTINATION: target }, cwd: root, timeout: 20_000, maxBuffer: 64 * 1024 }) }; }
      catch (error) {
        if (typeof error.code !== "number") throw error;
        return { code: error.code, stdout: error.stdout, stderr: error.stderr };
      }
    };
    const calls = async () => {
      try { return (await readFile(callLog, "utf8")).trim().split(/\r?\n/).map(JSON.parse); }
      catch (error) { if (error.code === "ENOENT") return []; throw error; }
    };
    await callback({ destination, outside, run, calls });
  } finally { await rm(root, { recursive: true, force: true }); }
}
