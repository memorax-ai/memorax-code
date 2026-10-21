import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = async (path) => (await readFile(new URL(path, import.meta.url), "utf8")).replaceAll("\r\n", "\n");
const source = await read("../../../.github/workflows/macos-codex-install.yml");

// Source contracts, as in the Cursor workflow tests; they complement actionlint rather than parse YAML.
function job(id) {
  const parts = source.split(`\n  ${id}:\n`);
  assert.equal(parts.length, 2);
  return parts[1].split(/\n  [a-z][a-z0-9-]*:\n/)[0];
}
const steps = (id) => job(id).split("\n      - ").slice(1);
function step(id, predicate) {
  const found = steps(id).filter(predicate);
  assert.equal(found.length, 1);
  return found[0];
}

test("the evidence change keeps every acceptance trigger, matrix and job timeout", () => {
  assert.match(source, /^on:\n  workflow_dispatch:\n    inputs:\n      check_deepseek:[\s\S]*?\n      diagnose_opencode_initialization:[\s\S]*?\n  pull_request:\n    branches: \[main\]\n  push:\n    branches: \[main\]\n/m);
  for (const [id, client] of [["install", "codex"], ["opencode", "opencode"], ["claude", "claude"]]) {
    assert.match(job(id), new RegExp(`^      matrix: \\$\\{\\{ fromJSON\\(needs\\.package\\.outputs\\.${client}-matrix\\) \\}\\}$`, "m"));
    assert.match(job(id), /^    timeout-minutes: 30$/m);
    assert.match(job(id), /^      fail-fast: false$/m);
  }
});

for (const [id, client, version] of [["install", "codex", "codex"], ["opencode", "opencode", "opencode"], ["claude", "claude", "claude"]]) {
  test(`${client} jobs record inputs, keep evidence outside the runtime and export it without changing the outcome`, () => {
    const list = steps(id);
    const download = step(id, (item) => item.startsWith("uses: actions/download-artifact@v4"));
    assert.match(download, /^          name: \$\{\{ needs\.package\.outputs\.package-artifact-name \}\}$/m);
    const inputs = step(id, (item) => item.startsWith("name: Record native test inputs\n"));
    assert.match(inputs, /^        id: record-inputs$/m);
    assert.match(inputs, /^        continue-on-error: true$/m);
    assert.match(inputs, new RegExp(`--client ${client} `));
    assert.match(inputs, new RegExp(`CLIENT_VERSION: \\$\\{\\{ matrix\\.${version} \\}\\}`));
    assert.match(inputs, /--expected-package-sha256 "\$PACKAGE_SHA256"/);
    const tests = list.filter((item) => /^\s+id: native-(posix|windows)$/m.test(item));
    assert.equal(tests.length, 2);
    for (const item of tests) {
      if (client === "claude") assert.doesNotMatch(item, /timeout-minutes:/);
      else assert.match(item, /^        timeout-minutes: 20$/m);
      assert.match(item, /^          MEMORAX_CI_EVIDENCE_DIR: \$\{\{ runner\.temp \}\}\/native-evidence\/suites$/m);
      assert.doesNotMatch(item, /continue-on-error/);
    }
    const summary = step(id, (item) => item.startsWith("name: Summarize first-failure evidence\n"));
    assert.match(summary, /^        if: always\(\)$/m);
    assert.match(summary, /^        continue-on-error: true$/m);
    assert.match(summary, /TEST_OUTCOME: \$\{\{ runner\.os == 'Windows' && steps\.native-windows\.outcome \|\| steps\.native-posix\.outcome \}\}/);
    assert.match(summary, new RegExp(`summarize "\\$RUNNER_TEMP/native-evidence" --client ${client} `));
    // Skipped steps owe no evidence, so the summary needs both step outcomes.
    assert.match(summary, /INPUTS_OUTCOME: \$\{\{ steps\.record-inputs\.outcome \}\}/);
    assert.match(summary, /--test-step-outcome "\$TEST_OUTCOME" --inputs-step-outcome "\$INPUTS_OUTCOME" /);
    const upload = step(id, (item) => /^        id: upload-evidence$/m.test(item));
    assert.match(upload, /^        if: always\(\)$/m);
    assert.match(upload, /^        continue-on-error: true$/m);
    assert.match(upload, new RegExp(`^          name: native-evidence-${client}-\\$\\{\\{ matrix\\.os \\}\\}-\\$\\{\\{ matrix\\.channel \\}\\}-node-\\$\\{\\{ matrix\\.node \\}\\}-attempt\\$\\{\\{ github\\.run_attempt \\}\\}$`, "m"));
    assert.match(upload, /^          path: \$\{\{ runner\.temp \}\}\/native-evidence$/m);
    assert.match(upload, /^          if-no-files-found: warn$/m);
    assert.match(upload, /^          retention-days: 30$/m);
    const report = step(id, (item) => item.startsWith("name: Report evidence export\n"));
    assert.match(report, /^        if: always\(\)$/m);
    assert.match(report, /^        continue-on-error: true$/m);
    assert.match(report, /UPLOAD_OUTCOME: \$\{\{ steps\.upload-evidence\.outcome \}\}/);
    assert.match(report, /ARTIFACT_ID: \$\{\{ steps\.upload-evidence\.outputs\.artifact-id \}\}/);
    assert.match(report, /ci-evidence\.mjs export-status --outcome "\$UPLOAD_OUTCOME" --artifact-id "\$ARTIFACT_ID" /);
    // The real-PowerShell wrapper test gates the job but cannot skip the native suites or delay their evidence.
    // Its TAP counts decide its result, so a skipped test fails it, and it reports on its own summary line.
    const ordered = [inputs, ...tests, summary, upload, report];
    if (client !== "claude") {
      const wrappers = step(id, (item) => item.startsWith("name: Verify evidence helpers keep the wrapper result (Windows)\n"));
      assert.match(wrappers, /^        if: always\(\) && !cancelled\(\) && runner\.os == 'Windows'$/m);
      assert.match(wrappers, /^        timeout-minutes: 10$/m);
      assert.match(wrappers, /^          node --test --test-reporter=spec --test-reporter-destination=stdout --test-reporter=tap "--test-reporter-destination=\$tap" scripts\/ci\/shared\/native-evidence-wrappers\.test\.mjs$/m);
      assert.match(wrappers, /^          node scripts\/ci\/shared\/ci-evidence\.mjs self-test-status --tap \$tap --exit-code \$LASTEXITCODE --github-summary \$env:GITHUB_STEP_SUMMARY$/m);
      assert.doesNotMatch(wrappers, /continue-on-error/);
      ordered.push(wrappers);
    }
    const order = ordered.map((item) => list.indexOf(item));
    assert.deepEqual(order, [...order].sort((left, right) => left - right));
  });
}

test("every uploaded artifact is attempt-qualified and every package reader uses the package job outputs", () => {
  const uploads = source.split("uses: actions/upload-artifact@v4\n").slice(1).map((item) => item.split("\n      - ")[0]);
  // Package, Cursor releases and input manifest; three clients' evidence; two Cursor reports.
  assert.equal(uploads.length, 8);
  for (const upload of uploads) assert.match(upload, /^          name: .*\$\{\{ github\.run_attempt \}\}$/m);
  assert.doesNotMatch(source, /overwrite:/);
  const downloads = source.split("uses: actions/download-artifact@v4\n").slice(1).map((item) => item.split("\n      - ")[0]);
  const packageReaders = downloads.filter((item) => item.includes("path: dist/npm/tarballs"));
  assert.equal(packageReaders.length, 6);
  for (const item of packageReaders) assert.match(item, /^          name: \$\{\{ needs\.package\.outputs\.package-artifact-name \}\}$/m);
  assert.match(job("cursor-app"), /^          name: \$\{\{ needs\.package\.outputs\.cursor-releases-artifact-name \}\}$/m);
  assert.doesNotMatch(source, /^\s+name: (?:memorax-code-package|cursor-app-releases)$/m);
});

test("the package job publishes the candidate package and frozen client versions with their checksums", () => {
  const packageJob = job("package");
  for (const [name, value] of [
    ["package-artifact-name", "memorax-code-package-attempt${{ github.run_attempt }}"],
    ["package-artifact-id", "${{ steps.upload-package.outputs.artifact-id }}"],
    ["package-artifact-digest", "${{ steps.upload-package.outputs.artifact-digest }}"],
    ["package-sha256", "${{ steps.package-provenance.outputs.sha256 }}"],
    ["cursor-releases-artifact-name", "cursor-app-releases-attempt${{ github.run_attempt }}"],
  ]) assert.ok(packageJob.includes(`\n      ${name}: ${value}\n`), name);
  const checksum = step("package", (item) => /^        id: package-provenance$/m.test(item));
  assert.match(checksum, /printf 'sha256=%s\\n'/);
  const upload = step("package", (item) => /^        id: upload-package$/m.test(item));
  assert.match(upload, /^          name: memorax-code-package-attempt\$\{\{ github\.run_attempt \}\}$/m);
  assert.match(upload, /^          retention-days: 30$/m);
  const manifest = step("package", (item) => item.startsWith("name: Record the candidate package and frozen client versions\n"));
  assert.match(manifest, /^        continue-on-error: true$/m);
  for (const client of ["codex", "opencode", "claude", "codebuddy"]) assert.ok(manifest.includes(`--matrix "${client}=$`), client);
  const manifestUpload = step("package", (item) => item.includes("name: native-client-inputs-attempt"));
  assert.match(manifestUpload, /^        continue-on-error: true$/m);
  assert.match(manifestUpload, /^          retention-days: 30$/m);
  assert.match(step("package", (item) => item.includes("name: cursor-app-releases-attempt")), /^          retention-days: 30$/m);
  const tests = step("package", (item) => item.startsWith("name: Verify test assertions reject malformed content and unexpected failures\n"));
  assert.match(tests, /scripts\/ci\/shared\/ci-evidence\.test\.mjs scripts\/ci\/shared\/native-evidence-workflow\.test\.mjs scripts\/ci\/shared\/native-evidence-wrappers\.test\.mjs/);
});

test("wrappers capture the evidence location before isolation and pass it only to test runners", async () => {
  for (const [path, planned] of [
    ["../claude/claude-install-check.sh", "claude-install-smoke,claude-install-interruption-check,claude-native-check,claude-permissions-check"],
    ["../codex/codex-install-check.sh", "codex-install-smoke,codex-native-check,codex-permissions-check,codex-install-interruption-check"],
    ["../opencode/opencode-install-check.sh", "opencode-install-smoke,opencode-native-check,opencode-permissions-check,opencode-server-check,opencode-install-interruption-check"],
  ]) {
    const script = await read(path);
    assert.ok(script.indexOf('evidence_dir="${MEMORAX_CI_EVIDENCE_DIR:-}"') < script.indexOf("env -i"), path);
    assert.ok(script.includes(`\nplanned_suites=${planned}\n`), path);
    assert.match(script, /^  ledger finalize "\$planned_suites"$/m);
    assert.match(script, /^trap finish EXIT\nledger plan "\$planned_suites"\nledger phase setup$/m);
    const runners = script.split("\n").filter((line) => /node "\$repo_root\/scripts\/ci\/[a-z-]+\/[a-z-]+\.mjs"/.test(line));
    assert.ok(runners.length >= 4);
    for (const line of runners) assert.match(line, /^run_suite [a-z-]+ isolated_suite node /, line);
    assert.doesNotMatch(script, /isolated_suite npm|MEMORAX_CI_EVIDENCE_DIR="\$evidence_dir" npm/);
    // Phases let the summary tell a wrapper setup failure from a wrapper cleanup failure.
    const suitesPhase = script.indexOf("\nledger phase suites\n");
    assert.ok(suitesPhase > script.lastIndexOf("isolated npm") && suitesPhase < script.indexOf("\nrun_suite "), path);
    assert.match(script, /^ledger phase cleanup\nrm -rf "\$test_root"$/m);
  }
  for (const [path, planned] of [
    ["../claude/claude-install-check.ps1", "claude-install-smoke,claude-install-interruption-check,claude-native-check,claude-permissions-check"],
    ["../codex/codex-install-check.ps1", "codex-install-smoke,codex-native-check,codex-permissions-check,codex-install-interruption-check"],
    ["../opencode/opencode-install-check.ps1", "opencode-install-smoke,opencode-native-check,opencode-permissions-check,opencode-server-check,opencode-install-interruption-check"],
  ]) {
    const script = await read(path);
    const helpers = script.indexOf(". (Join-Path $PSScriptRoot '../shared/ci-evidence.ps1')");
    const capture = script.indexOf("Initialize-CiEvidence -Tool (Join-Path $repoRoot 'scripts/ci/shared/ci-evidence.mjs') -RuntimeRoot $testRoot");
    const scrub = script.indexOf("[Environment]::SetEnvironmentVariable($item.Name, $null, 'Process')");
    const lastInstall = script.lastIndexOf("& npm.cmd install");
    const handoff = script.indexOf("if ($CiEvidenceDir) { $env:MEMORAX_CI_EVIDENCE_DIR = $CiEvidenceDir }");
    const firstRunner = script.search(/& node \(Join-Path \$repoRoot ['"]scripts\/ci\//);
    assert.ok(helpers > 0 && helpers < capture && capture < scrub && lastInstall < handoff && handoff < firstRunner, path);
    assert.ok(script.includes(`\n$plannedSuites = '${planned}'\nWrite-CiLedger plan $plannedSuites\nWrite-CiLedger phase setup\n`), path);
    assert.match(script.slice(handoff, firstRunner), /\n\s*Write-CiLedger phase suites\n/);
    assert.match(script, /^\s*Write-CiLedger phase cleanup\n\s*Remove-Item -LiteralPath \$testRoot -Recurse -Force$/m);
    assert.ok(script.includes("} finally {\n  Write-CiLedger finalize $plannedSuites\n}"), path);
    // Only the shared helpers run the evidence tool; they restore $LASTEXITCODE after every call.
    assert.doesNotMatch(script, /function Write-CiLedger|\$evidenceTool|ci-evidence\.mjs['"]?\) (?:prepare|ledger)/);
    // Every suite result is captured before the ledger records it and decides the wrapper result.
    assert.doesNotMatch(script.slice(firstRunner), /if \(\$LASTEXITCODE -ne 0\)/);
    assert.equal((script.match(/\$suiteExit = \$LASTEXITCODE/g) ?? []).length, (script.match(/Write-CiLedger end /g) ?? []).length);
    assert.doesNotMatch(script, /isolated state retained/);
  }
  // The executable PowerShell tests in native-evidence-wrappers.test.mjs check the behavior; this keeps
  // any later helper from calling node outside the save/restore pair.
  const helpers = await read("./ci-evidence.ps1");
  const nodeCalls = (helpers.match(/& node /g) ?? []).length;
  assert.equal(nodeCalls, 2);
  assert.equal((helpers.match(/\$saved = Save-CiExitCode\n/g) ?? []).length, nodeCalls);
  assert.equal((helpers.match(/\} finally \{\n    Restore-CiExitCode \$saved\n  \}/g) ?? []).length, nodeCalls);
});
