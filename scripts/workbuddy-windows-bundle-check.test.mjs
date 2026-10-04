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
const releaseScript = join(dirname(script), "workbuddy-release-matrix.mjs");
const windowsOnly = { skip: process.platform !== "win32" };
const sha256 = "627E5A565436D0876740AF69C2747759648662C52958D2A5DF1BA330A82C3025";
const url = "https://download.codebuddy.cn/workbuddy/saas/win32-x64-user/WorkBuddy-win32-x64-user-5.6.2.39298511-37a65c0b.exe";
const command = "WorkBuddy/resources/app.asar.unpacked/cli/bin/codebuddy";
const baseline = { platform: "win32-x64-user", desktopVersion: "5.6.2.39298511", productVersion: "5.6.2",
  runtimeVersion: "2.147.0", sha256: sha256.toLowerCase(), url, channel: "baseline" };
const latest = { platform: "win32-x64-user", desktopVersion: "5.7.0.40000000", productVersion: "5.7.0",
  runtimeVersion: null, sha256: "a".repeat(64), channel: "latest",
  url: "https://download.codebuddy.cn/workbuddy/saas/win32-x64-user/WorkBuddy-win32-x64-user-5.7.0.40000000-abcdef12.exe" };

test("Windows acquisition resolves a validated release before downloading and fails closed before extraction", async () => {
  const source = await readFile(script, "utf8");
  assert.match(source, /\[string\]\$ReleaseFile/);
  assert.match(source, /Join-Path \$PSScriptRoot 'workbuddy-release-matrix\.mjs'/);
  assert.match(source, /'select-json', 'win32-x64-user'/);
  assert.match(source, /ContainsKey\('ReleaseFile'\).*\$releaseArgs \+= \$ReleaseFile/);
  assert.match(source, /\$releaseJson = & node @releaseArgs 2>\$null\s+if \(\$LASTEXITCODE -ne 0\) \{ throw \$stage \}/);
  assert.ok(source.indexOf("$releaseJson | ConvertFrom-Json") < source.indexOf("& curl.exe"));
  assert.ok(source.includes(`$command = '${command}'`));
  assert.match(source, /-not \$IsWindows.*OSArchitecture -ne 'X64'/);
  assert.match(source, /\$signature\.Status -ne 'Valid'/);
  assert.match(source, /-cne 'Tencent Technology \(Shenzhen\) Company Limited'/);
  assert.ok(source.indexOf("Get-FileHash") < source.indexOf("Get-AuthenticodeSignature"));
  assert.ok(source.indexOf("Get-AuthenticodeSignature") < source.indexOf("& $sevenZip"));
  assert.match(source, /VersionInfo\.ProductVersion -cne \$release\.productVersion/);
  assert.match(source, /customPackage\.name -cne '@tencent-ai\/codebuddy-code'/);
  assert.match(source, /\$null -ne \$release\.runtimeVersion -and \$runtimeVersion -cne \$release\.runtimeVersion/);
  assert.match(source, /'\$PLUGINSDIR\/app-64\.7z'/);
  assert.match(source, /'resources\/app\.asar\.unpacked\/cli\/\*'/);
  assert.doesNotMatch(source, /Start-Process|&\s+\$installer|Invoke-Expression|\bwinget\b|\bchoco\b/);
});

test("Windows acquisition's default release selector retains the fixed baseline", async () => {
  const result = await execute(process.execPath, [releaseScript, "select-json", "win32-x64-user"],
    { env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }, timeout: 5_000, maxBuffer: 64 * 1024 });
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), baseline);
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
    assert.deepEqual(observed.map((call) => call.tool), ["release", "curl", "hash", "signature", "desktop", "7zip", "7zip"]);
    assert.deepEqual(observed[0].args, [releaseScript, "select-json", "win32-x64-user"]);
    assert.deepEqual(observed[1].args, ["--disable", "--fail", "--silent", "--show-error", "--location", "--proto", "=https",
      "--proto-redir", "=https", "--connect-timeout", "30", "--max-time", "600", "--retry", "2", "--retry-max-time", "900",
      "--output", join(destination, "WorkBuddy.exe"), url]);
    assert.equal(observed[2].algorithm, "SHA256");
    assert.equal(observed[5].args.at(-1), "$PLUGINSDIR/app-64.7z");
    assert.equal(observed[6].args.at(-1), "resources/app.asar.unpacked/cli/*");
    assert.deepEqual(await readdir(destination), ["WorkBuddy"]);
    assert.equal(await readFile(join(destination, command), "utf8"), "Synthetic bundled CLI; never executed.");
  });
});

for (const release of [baseline, latest]) {
  test(`Windows acquisition accepts an explicit ${release.channel} release and reports the extracted runtime`, windowsOnly, async () => {
    await fixture(async ({ run, calls, releaseFile }) => {
      const result = await run();
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stderr, "");
      assert.deepEqual(JSON.parse(result.stdout), { desktopVersion: release.desktopVersion,
        runtimeVersion: release.runtimeVersion ?? "2.150.1", arch: "x64", sha256: release.sha256, command });
      const observed = await calls();
      assert.deepEqual(observed.map((call) => call.tool), ["release", "curl", "hash", "signature", "desktop", "7zip", "7zip"]);
      assert.deepEqual(observed[0].args, [releaseScript, "select-json", "win32-x64-user", releaseFile]);
      assert.equal(observed[1].args.at(-1), release.url);
    }, "success", release);
  });
}

for (const [name, release] of [
  ["wrong platform", { ...latest, platform: "linux-x64-deb" }],
  ["missing digest", { ...latest, sha256: "" }],
  ["untrusted URL", { ...latest, url: latest.url.replace("download.codebuddy.cn", "example.invalid") }],
  ["changed baseline", { ...baseline, sha256: "b".repeat(64) }],
  ["runtime supplied for latest", { ...latest, runtimeVersion: "2.150.1" }],
  ["malformed JSON", "not-json"],
]) {
  test(`Windows acquisition rejects ${name} before creating installer files`, windowsOnly, async () => {
    await fixture(async ({ run, calls, destination }) => {
      const result = await run();
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr.trim(), "WORKBUDDY_BUNDLE_RELEASE_INVALID");
      assert.deepEqual((await calls()).map((call) => call.tool), ["release"]);
      assert.deepEqual(await readdir(destination), []);
    }, "success", release);
  });
}

test("Windows acquisition rejects a selector failure even when it emits valid JSON", windowsOnly, async () => {
  await fixture(async ({ run, calls, destination }) => {
    const result = await run();
    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr.trim(), "WORKBUDDY_BUNDLE_RELEASE_INVALID");
    assert.deepEqual((await calls()).map((call) => call.tool), ["release"]);
    assert.deepEqual(await readdir(destination), []);
  }, "selector-exit");
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
  ["package-name", "LAYOUT_INVALID", ["curl", "hash", "signature", "desktop", "7zip", "7zip"]],
  ["package-name-array", "LAYOUT_INVALID", ["curl", "hash", "signature", "desktop", "7zip", "7zip"]],
  ["bin", "LAYOUT_INVALID", ["curl", "hash", "signature", "desktop", "7zip", "7zip"]],
  ["bin-array", "LAYOUT_INVALID", ["curl", "hash", "signature", "desktop", "7zip", "7zip"]],
  ["runtime", "RUNTIME_VERSION_MISMATCH", ["curl", "hash", "signature", "desktop", "7zip", "7zip"]],
  ["junction", "LAYOUT_INVALID", ["curl", "hash", "signature", "desktop", "7zip", "7zip"]],
]) {
  test(`Windows acquisition stops, redacts and cleans only owned files after ${scenario} failure`, windowsOnly, async () => {
    await fixture(async ({ run, calls, destination, outside }) => {
      const result = await run();
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr.trim(), `WORKBUDDY_BUNDLE_${expected}`);
      assert.deepEqual((await calls()).map((call) => call.tool), ["release", ...tools]);
      assert.deepEqual(await readdir(destination), []);
      assert.equal(await readFile(join(outside, "codebuddy"), "utf8"), "Outside data; preserve.");
    }, scenario);
  });
}

for (const scenario of ["runtime-prerelease", "runtime-number", "runtime-missing", "runtime-leading-zero", "runtime-newline"]) {
  test(`Windows latest acquisition rejects ${scenario} metadata instead of accepting an unverified runtime`, windowsOnly, async () => {
    await fixture(async ({ run, calls, destination }) => {
      const result = await run();
      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr.trim(), "WORKBUDDY_BUNDLE_RUNTIME_VERSION_MISMATCH");
      assert.deepEqual((await calls()).map((call) => call.tool), ["release", "curl", "hash", "signature", "desktop", "7zip", "7zip"]);
      assert.deepEqual(await readdir(destination), []);
    }, scenario, latest);
  });
}

for (const failure of [undefined, new Error("Synthetic callback failure")]) {
  test(`Windows acquisition fixture cleans up after callback ${failure ? "failure" : "success"}`, async () => {
    let root;
    const result = fixture(async ({ destination }) => {
      root = dirname(destination);
      if (failure) throw failure;
    });
    if (failure) await assert.rejects(result, (error) => error === failure);
    else await result;
    await assert.rejects(readdir(root), { code: "ENOENT" });
  });
}

async function fixture(callback, scenario = "success", release) {
  const root = await mkdtemp(join(tmpdir(), "workbuddy-windows-bundle-"));
  const destination = join(root, "download"), outside = join(root, "outside"), callLog = join(root, "calls.jsonl");
  const releaseFile = release === undefined ? undefined : join(root, "release selection.json");
  const selected = release && typeof release === "object" ? release : baseline;
  const failures = [];
  try {
    await Promise.all([destination, outside, join(root, "home"), join(root, "tmp")].map((path) => mkdir(path)));
    await writeFile(join(outside, "codebuddy"), "Outside data; preserve.");
    if (releaseFile) await writeFile(releaseFile, typeof release === "string" ? release : JSON.stringify(release));
    const runner = join(root, "fixture.ps1");
    await writeFile(runner, `
$ErrorActionPreference = 'Stop'
function Record-Call($Value) { Add-Content -LiteralPath $env:FIXTURE_CALLS -Value ($Value | ConvertTo-Json -Compress -Depth 5) }
function node {
  Record-Call @{ tool = 'release'; args = [string[]]$args }
  & $env:FIXTURE_NODE @args
  if ($env:FIXTURE_SCENARIO -eq 'selector-exit') { $global:LASTEXITCODE = 1 }
}
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
  @{ Hash = if ($env:FIXTURE_SCENARIO -eq 'hash') { '0' * 64 } else { $env:FIXTURE_SHA256 } }
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
    return @{ VersionInfo = @{ ProductVersion = if ($env:FIXTURE_SCENARIO -eq 'desktop') { '0.0.0' } else { $env:FIXTURE_PRODUCT_VERSION } } }
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
  $version = switch ($env:FIXTURE_SCENARIO) {
    'runtime' { '0.0.0' }
    'runtime-prerelease' { '2.150.1-beta.1' }
    'runtime-number' { 21501 }
    'runtime-missing' { $null }
    'runtime-leading-zero' { '02.150.1' }
    'runtime-newline' { "2.150.1\n" }
    default { $env:FIXTURE_RUNTIME_VERSION }
  }
  $name = if ($env:FIXTURE_SCENARIO -eq 'package-name') { '@unrelated/cli' } else { '@tencent-ai/codebuddy-code' }
  $bin = if ($env:FIXTURE_SCENARIO -eq 'bin') { './bin/unrelated' } else { './bin/codebuddy' }
  $package = @{ publishConfig = @{ customPackage = @{ name = $name; version = $version } }; bin = @{ codebuddy = $bin } }
  if ($env:FIXTURE_SCENARIO -eq 'package-name-array') { $package.publishConfig.customPackage.name = @($name) }
  if ($env:FIXTURE_SCENARIO -eq 'bin-array') { $package.bin.codebuddy = @($bin) }
  $package | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $cli 'package.json')
}
if ($env:FIXTURE_RELEASE_FILE) {
  & $env:FIXTURE_HELPER -Destination $env:FIXTURE_DESTINATION -ReleaseFile $env:FIXTURE_RELEASE_FILE
} else { & $env:FIXTURE_HELPER -Destination $env:FIXTURE_DESTINATION }
exit $LASTEXITCODE
`);
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR,
      HOME: join(root, "home"), USERPROFILE: join(root, "home"), TEMP: join(root, "tmp"), TMP: join(root, "tmp"),
      MEMORAX_CODE_HOME: join(root, "state"), FIXTURE_HELPER: script, FIXTURE_DESTINATION: destination,
      FIXTURE_OUTSIDE: outside, FIXTURE_CALLS: callLog, FIXTURE_SCENARIO: scenario, FIXTURE_NODE: process.execPath,
      FIXTURE_RELEASE_FILE: releaseFile, FIXTURE_SHA256: selected.sha256,
      FIXTURE_PRODUCT_VERSION: selected.productVersion, FIXTURE_RUNTIME_VERSION: selected.runtimeVersion ?? "2.150.1" };
    const run = async (target = destination) => {
      // Native commands launched by PowerShell must not retain the directory we remove.
      try { return { code: 0, ...await execute("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", runner],
        { env: { ...env, FIXTURE_DESTINATION: target }, cwd: dirname(root), timeout: 20_000, maxBuffer: 64 * 1024 }) }; }
      catch (error) {
        if (typeof error.code !== "number") throw error;
        return { code: error.code, stdout: error.stdout, stderr: error.stderr };
      }
    };
    const calls = async () => {
      try { return (await readFile(callLog, "utf8")).trim().split(/\r?\n/).map(JSON.parse); }
      catch (error) { if (error.code === "ENOENT") return []; throw error; }
    };
    await callback({ destination, outside, run, calls, releaseFile });
  } catch (error) { failures.push(error); }
  try { await rm(root, { recursive: true, force: true }); }
  catch (error) { failures.push(error); }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Windows acquisition fixture and cleanup failed");
}
