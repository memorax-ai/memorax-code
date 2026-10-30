import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { baselineRelease } from "./workbuddy-release-matrix.mjs";

const read = async (name) => (await readFile(new URL(`../../../.github/workflows/${name}`, import.meta.url), "utf8"))
  .replaceAll("\r\n", "\n");
// WorkBuddy runs in the native client workflow with the shared candidate package; the CI Tests job runs this contract.
const source = await read("macos-codex-install.yml");
const ci = await read("ci.yml");
const MODES = ["release-acceptance", "provider-only", "opencode-initialization-diagnostic", "workbuddy-download-diagnostic"];

// These source contracts complement actionlint; they are not a general YAML parser.
function job(id, text = source) {
  const parts = text.split(`\n  ${id}:\n`);
  assert.equal(parts.length, 2, `Expected one ${id} job`);
  return parts[1].split(/\n  [a-z][a-z0-9-]*:\n/)[0];
}

// Evaluate a job condition; the hyphenated dependency outputs used here become bracket lookups. Only a pull request has a
// native client scope, which selects WorkBuddy unless `workbuddy` says otherwise.
function selected(condition, { event, mode, ready = "true", releases = "success", workbuddy = "true" }) {
  const code = condition.replaceAll("needs.package.outputs.artifact-ready", 'needs.package.outputs["artifact-ready"]')
    .replaceAll("needs.workbuddy-releases.result", 'needs["workbuddy-releases"].result');
  return Boolean(runInNewContext(code, {
    github: { event_name: event }, inputs: event === "workflow_dispatch" ? { mode } : {},
    needs: { scope: { outputs: event === "pull_request" ? { workbuddy } : {} }, package: { outputs: { "artifact-ready": ready } },
      "workbuddy-releases": { result: releases } },
    always: () => true, cancelled: () => false,
  }, { timeout: 100 }));
}

function macosMetadataScript() {
  const blocks = [...job("workbuddy-native").matchAll(/^          node --input-type=module - "\$app" "\$product_version" <<'NODE'\n([\s\S]*?)^          NODE$/gm)];
  assert.equal(blocks.length, 1, "Expected one macOS mounted metadata validation block");
  return blocks[0][1].split("\n").map((line) => line.slice(10)).join("\n");
}

test("WorkBuddy CI automatically listens to main PRs and pushes without path filters", () => {
  const triggers = source.split("\njobs:\n")[0];
  assert.match(triggers, /^  pull_request:\n    branches: \[main\]$/m);
  assert.match(triggers, /^  push:\n    branches: \[main\]$/m);
  assert.doesNotMatch(triggers, /paths(?:-ignore)?:/);
  assert.match(job("tests", ci), /^        run: node --test scripts\/ci\/codebuddy-workbuddy\/workbuddy-workflow\.test\.mjs$/m);
  assert.doesNotMatch(ci, /^  workbuddy-/m);
});

// Every pull request runs the WorkBuddy contracts in workbuddy-releases; only one that selects WorkBuddy runs the matrix.
for (const id of ["workbuddy-releases", "workbuddy-native", "workbuddy-result"]) {
  test(`${id} runs for selecting pull requests, the compatibility monitor, release acceptance and the WorkBuddy diagnostic only`, () => {
    const condition = job(id).match(/^    if: (.+)$/m)?.[1];
    assert.ok(condition);
    if (id === "workbuddy-result") assert.match(condition, /^always\(\) && /);
    for (const [event, mode] of [["pull_request"], ["push"], ["schedule"], ...MODES.map((item) => ["workflow_dispatch", item])]) {
      for (const workbuddy of event === "pull_request" ? ["true", "false", ""] : ["true"]) {
        const expected = event === "pull_request" ? id === "workbuddy-releases" || workbuddy === "true"
          : event === "schedule" || ["release-acceptance", "workbuddy-download-diagnostic"].includes(mode);
        assert.equal(selected(condition, { event, mode, workbuddy }), expected, `${event}, mode=${mode}, workbuddy=${workbuddy}`);
      }
    }
  });
}

test("a pull request verifies the contracts and reads only the pinned releases it selects, never the official feeds", () => {
  const releases = job("workbuddy-releases");
  assert.match(releases, /^    needs: scope$/m);
  const steps = releases.split("\n      - ").slice(1);
  const pinned = steps.find((step) => step.startsWith("name: Read the pinned WorkBuddy acceptance releases for this pull request\n"));
  const resolve = steps.find((step) => step.startsWith("name: Resolve each platform's latest release once\n"));
  const [readsPinned, resolvesLatest] = [pinned, resolve].map((step) => step?.match(/^        if: (.+)$/m)?.[1]);
  assert.ok(readsPinned && resolvesLatest);
  for (const workbuddy of ["true", "false", ""]) {
    assert.equal(selected(readsPinned, { event: "pull_request", workbuddy }), workbuddy === "true", `workbuddy=${workbuddy}`);
    assert.equal(selected(resolvesLatest, { event: "pull_request", workbuddy }), false, `workbuddy=${workbuddy}`);
  }
  for (const [event, mode] of [["schedule"], ["workflow_dispatch", "release-acceptance"], ["workflow_dispatch", "workbuddy-download-diagnostic"]]) {
    assert.equal(selected(readsPinned, { event, mode }), false, `${event}, mode=${mode}`);
    assert.equal(selected(resolvesLatest, { event, mode }), true, `${event}, mode=${mode}`);
  }
  // The parser setup and the contracts run in every run of the job.
  for (const step of steps.filter((item) => ![pinned, resolve].includes(item))) assert.doesNotMatch(step, /^        if:/m);
});

test("WorkBuddy native cells require the validated shared package and the frozen releases", () => {
  const condition = job("workbuddy-native").match(/^    if: (.+)$/m)[1];
  assert.match(condition, /^always\(\) && !cancelled\(\) && /);
  for (const ready of [null, "", "false"]) assert.equal(selected(condition, { event: "pull_request", ready }), false);
  for (const releases of ["failure", "cancelled", "skipped"]) assert.equal(selected(condition, { event: "pull_request", releases }), false);
});

test("WorkBuddy consumes the shared candidate package and keeps one aggregate result", () => {
  const releases = job("workbuddy-releases");
  assert.doesNotMatch(releases, /npm-package-check|upload-artifact/);
  assert.match(releases, /^      matrix: \$\{\{ steps\.accepted\.outputs\.matrix \|\| steps\.releases\.outputs\.matrix \}\}$/m);
  assert.match(releases, /^      coverage: \$\{\{ steps\.accepted\.outputs\.coverage \|\| steps\.releases\.outputs\.coverage \}\}$/m);
  assert.match(releases, /^        run: node scripts\/ci\/codebuddy-workbuddy\/workbuddy-release-matrix\.mjs accepted$/m);
  assert.match(releases, /^        run: node scripts\/ci\/codebuddy-workbuddy\/workbuddy-release-matrix\.mjs resolve$/m);
  assert.match(releases, /^        run: node --test scripts\/ci\/codebuddy-workbuddy\/codebuddy-\*\.test\.mjs scripts\/ci\/codebuddy-workbuddy\/workbuddy-\*\.test\.mjs$/m);
  assert.match(job("workbuddy-native"), /^    needs: \[scope, package, workbuddy-releases\]$/m);
  assert.match(job("workbuddy-native"), /^      fail-fast: false$/m);
  assert.match(job("workbuddy-native"), /^      matrix: \$\{\{ fromJSON\(needs\.workbuddy-releases\.outputs\.matrix\) \}\}$/m);
  assert.match(job("workbuddy-native"), /actions\/download-artifact@v4\n        with:\n          name: \$\{\{ needs\.package\.outputs\.package-artifact-name \}\}\n          path: dist\/npm\/tarballs\n/);
  assert.match(job("workbuddy-native"), /^          node-version: \$\{\{ matrix\.nodeVersion \}\}$/m);
  assert.match(job("workbuddy-native"), /^    name: WorkBuddy native \(\$\{\{ matrix\.os \}\}, Node \$\{\{ matrix\.node \}\}, \$\{\{ matrix\.release\.channel \}\}, \$\{\{ matrix\.release\.desktopVersion \}\}\)$/m);
  assert.match(job("workbuddy-native"), /RELEASE_JSON: \$\{\{ toJSON\(matrix\.release\) \}\}/);
  assert.doesNotMatch(job("workbuddy-native"), /run:.*\$\{\{ matrix\.release/);
  assert.match(job("workbuddy-native"), /-ReleaseFile \(Join-Path \$env:RUNNER_TEMP 'workbuddy-release\.json'\)/);
  const result = job("workbuddy-result");
  const name = result.match(/^    name: \$\{\{ (.+) \}\}$/m)?.[1];
  assert.ok(name);
  for (const [event, mode, expected] of [
    ["pull_request", undefined, "WorkBuddy functional result"],
    ["push", undefined, "WorkBuddy functional result (main push)"],
    ["schedule", undefined, "WorkBuddy functional result (compatibility monitor)"],
    ["workflow_dispatch", "release-acceptance", "WorkBuddy functional result (release-acceptance)"],
    ["workflow_dispatch", "workbuddy-download-diagnostic", "WorkBuddy functional result (workbuddy-download-diagnostic)"],
  ]) {
    assert.equal(runInNewContext(name, {
      github: { event_name: event }, inputs: { mode }, format: (pattern, value) => pattern.replace("{0}", value),
    }, { timeout: 100 }), expected);
  }
  assert.match(result, /^    needs: \[scope, package, workbuddy-releases, workbuddy-native\]$/m);
  assert.match(result, /PACKAGE_RESULT: \$\{\{ needs\.package\.result \}\}/);
  assert.match(result, /RELEASES_RESULT: \$\{\{ needs\.workbuddy-releases\.result \}\}/);
  assert.match(result, /WORKBUDDY_RESULT: \$\{\{ needs\.workbuddy-native\.result \}\}/);
  assert.match(result, /WORKBUDDY_COVERAGE: \$\{\{ needs\.workbuddy-releases\.outputs\.coverage \}\}/);
  for (const id of ["workbuddy-releases", "workbuddy-native", "workbuddy-result"]) {
    assert.doesNotMatch(job(id), /continue-on-error:/);
  }
});

test("Linux download evidence is retained only for explicit manual diagnosis, including failed acquisition", () => {
  const native = job("workbuddy-native");
  const acquire = native.split("      - name: Acquire and extract the selected official Linux package\n")[1]
    .split("      - name:")[0];
  const capture = acquire.match(/WORKBUDDY_DOWNLOAD_DIAGNOSTIC_DIR: \$\{\{ (.+) \}\}/)?.[1];
  assert.ok(capture);
  const upload = native.split("      - name: Retain Linux download evidence for manual diagnosis\n")[1]
    .split("      - name:")[0];
  const condition = upload.match(/^        if: (.+)$/m)?.[1];
  assert.ok(condition);
  for (const [event, mode] of [["pull_request"], ["push"], ...MODES.map((item) => ["workflow_dispatch", item])]) {
    const context = { github: { event_name: event }, inputs: event === "workflow_dispatch" ? { mode } : {},
      runner: { os: "Linux", temp: "/owned" }, always: () => true,
      format: (pattern, value) => pattern.replace("{0}", value) };
    const enabled = event === "workflow_dispatch" && mode === "workbuddy-download-diagnostic";
    assert.equal(runInNewContext(capture, context), enabled ? "/owned/workbuddy-download-diagnostic" : "");
    assert.equal(runInNewContext(condition, context), enabled);
    for (const os of ["macOS", "Windows"]) {
      assert.equal(runInNewContext(condition, { ...context, runner: { os } }), false);
    }
  }
  assert.match(upload, /uses: actions\/upload-artifact@v4/);
  assert.match(upload, /name: workbuddy-linux-download-node-\$\{\{ matrix.node \}\}-\$\{\{ matrix.release.channel \}\}-attempt\$\{\{ github\.run_attempt \}\}\n/);
  assert.match(upload, /retention-days: 1/);
  assert.match(upload, /compression-level: 0/);
  assert.match(upload, /if-no-files-found: error/);
  assert.match(upload, /workbuddy-download-diagnostic\/WorkBuddy\.deb/);
  assert.match(upload, /workbuddy-download-diagnostic\/download\.json/);
  assert.doesNotMatch(upload, /path:.*\*|\.headers|\.partial|\.download/);
});

test("each WorkBuddy cell records its verified versions, hashes and run attempt for the release record, without paths or URLs", { skip: process.platform === "win32" }, async () => {
  const native = job("workbuddy-native");
  const name = "      - name: Record the verified WorkBuddy versions for the release record\n";
  const step = native.split(name)[1]?.split(/\n      - /)[0];
  assert.ok(step);
  assert.ok(native.indexOf("- name: Record the verified bundled runtime") < native.indexOf(name));
  assert.ok(native.indexOf(name) < native.indexOf("- name: Run strict native WorkBuddy suites with isolated local services (macOS/Linux)"));
  assert.match(step, /^          WORKBUDDY_CHANNEL: \$\{\{ matrix\.release\.channel \}\}$/m);
  const script = step.match(/^          node --input-type=module <<'NODE'\n([\s\S]*?)^          NODE$/m)?.[1]
    .split("\n").map((line) => line.slice(10)).join("\n");
  assert.ok(script);
  const release = { ...baselineRelease("linux-x64-deb"), channel: "latest", runtimeVersion: null };
  // Linux keeps a differing download with a warning, but an accepted release must match the hash its acceptance recorded;
  // the report records both hashes and the status either way.
  for (const [channel, actual, status] of [["latest", release.sha256.toUpperCase(), "match"], ["latest", "e".repeat(64), "warning"],
    ["accepted", release.sha256, "match"], ["accepted", "e".repeat(64), "mismatch"]]) {
    const root = await realpath(await mkdtemp(join(tmpdir(), "workbuddy-report-")));
    try {
      await writeFile(join(root, "workbuddy-bundle.json"), JSON.stringify({ desktopVersion: "5.7.0.40000000", runtimeVersion: "2.160.1",
        arch: "x64", command: "extracted/opt/WorkBuddy/cli/bin/codebuddy", file: "WorkBuddy.deb", sha256: actual }));
      await writeFile(join(root, "workbuddy-release.json"), JSON.stringify({ ...release, channel }));
      const result = spawnSync(process.execPath, ["--input-type=module", "-"], { input: script, cwd: root, encoding: "utf8", timeout: 5_000,
        env: { RUNNER_TEMP: root, HOME: root, GITHUB_RUN_ID: "39203658997", GITHUB_RUN_ATTEMPT: "2",
          WORKBUDDY_OS: "ubuntu-24.04", WORKBUDDY_NODE: "24", WORKBUDDY_CHANNEL: channel } });
      assert.equal(result.status, status === "mismatch" ? 1 : 0, result.stderr);
      if (status === "mismatch") assert.match(result.stderr, /WORKBUDDY_ACCEPTED_HASH_MISMATCH/);
      assert.deepEqual(JSON.parse(await readFile(join(root, "workbuddy-report", "report.json"), "utf8")), { schemaVersion: 2,
        runId: "39203658997", runAttempt: 2, os: "ubuntu-24.04", node: "24", channel, desktopVersion: "5.7.0.40000000",
        runtimeVersion: "2.160.1", arch: "x64", source: new URL(release.url).host,
        sha256: { reference: release.sha256, actual: actual.toLowerCase(), status } });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
  const upload = native.split("      - uses: actions/upload-artifact@v4\n").at(-1);
  assert.match(upload, /^        if: always\(\)$/m);
  assert.match(upload, /^          name: workbuddy-report-\$\{\{ matrix\.os \}\}-\$\{\{ matrix\.release\.channel \}\}-node-\$\{\{ matrix\.node \}\}-attempt\$\{\{ github\.run_attempt \}\}$/m);
  assert.match(upload, /^          path: \$\{\{ runner\.temp \}\}\/workbuddy-report\/report\.json$/m);
  // The release record finds each cell's job by this name in the attempts API.
  assert.match(native, /^    name: WorkBuddy native \(\$\{\{ matrix\.os \}\}, Node \$\{\{ matrix\.node \}\}, \$\{\{ matrix\.release\.channel \}\}, \$\{\{ matrix\.release\.desktopVersion \}\}\)$/m);
});

test("WorkBuddy macOS verifies the selected archive type before common application gates", () => {
  const native = job("workbuddy-native");
  assert.ok(native.includes('["WorkBuddy.dmg", "WorkBuddy.zip"].includes(f)'));
  assert.ok(native.includes('if [[ "$archive_name" == WorkBuddy.dmg ]]; then'));
  assert.match(native, /ditto -x -k "\$image" "\$mountpoint"/);
  const extracted = native.indexOf('ditto -x -k "$image" "$mountpoint"');
  const signature = native.indexOf("codesign --verify --deep --strict --all-architectures");
  assert.ok(extracted > 0 && signature > extracted);
  assert.ok(native.includes('[[ -d "$app" && ! -L "$app" ]]'));
  assert.ok(native.includes("if: always() && runner.os == 'macOS' && env.WORKBUDDY_IMAGE_ATTACHED == 'true'"));
});

test("WorkBuddy mounted metadata validation follows signature gates and treats the release as data", () => {
  const native = job("workbuddy-native");
  let previous = -1;
  for (const command of ["spctl --assess --type open", "hdiutil attach -readonly -nobrowse -noautoopen",
    "codesign --verify --deep --strict --all-architectures", "spctl --assess --type execute",
    'node --input-type=module - "$app" "$product_version"']) {
    const offset = native.indexOf(command);
    assert.ok(offset > previous, `Missing or out-of-order macOS gate: ${command}`);
    previous = offset;
  }
  assert.match(native, /identifier "com\.tencent\.workbuddy\.mac" and anchor apple generic and certificate leaf\[subject\.OU\] = "FN2V63AD2J"/);
  assert.match(native, /^          RELEASE_JSON: \$\{\{ toJSON\(matrix\.release\) \}\}$/m);
  let inRun = false, scripts = "";
  for (const line of native.split("\n")) {
    if (/^        run:/.test(line)) inRun = true;
    else if (line.trim() && !line.startsWith("          ")) inRun = false;
    if (inRun) scripts += `${line}\n`;
  }
  assert.doesNotMatch(scripts, /\$\{\{[^}]*\bmatrix\.release\b/);
  assert.match(scripts, /JSON\.parse\(process\.env\.RELEASE_JSON\)/);
  macosMetadataScript();
});

for (const scenario of ["baseline", "latest", "baseline runtime mismatch", "product mismatch",
  "wrong package", "wrong bin", "malformed runtime", "runtime newline", "metadata symlink"]) {
  test(`WorkBuddy macOS workflow validates actual mounted metadata: ${scenario}`, {
    skip: process.platform === "win32" && scenario === "metadata symlink",
  }, async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "workbuddy-macos-workflow-")));
    try {
      const app = join(root, "workbuddy-bundle", "mounted", "WorkBuddy.app");
      const cli = join(app, "Contents", "Resources", "app.asar.unpacked", "cli");
      await mkdir(join(cli, "bin"), { recursive: true });
      const release = baselineRelease("darwin-arm64");
      if (["latest", "malformed runtime", "runtime newline"].includes(scenario)) {
        Object.assign(release, { desktopVersion: "5.7.0.40000000", productVersion: "5.7.0",
          runtimeVersion: null, sha256: "a".repeat(64), channel: "latest",
          url: "https://download.codebuddy.cn/workbuddy/saas/darwin-arm64/WorkBuddy-darwin-arm64-5.7.0.40000000-abcdef12.dmg" });
      }
      const runtime = scenario === "latest" || scenario === "baseline runtime mismatch" ? "2.160.1" : "2.147.0";
      const metadata = { bin: { codebuddy: "./bin/codebuddy" },
        publishConfig: { customPackage: { name: "@tencent-ai/codebuddy-code", version: runtime } } };
      if (scenario === "wrong package") metadata.publishConfig.customPackage.name = "other-cli";
      if (scenario === "wrong bin") metadata.bin.codebuddy = "./other-command";
      if (scenario === "malformed runtime") metadata.publishConfig.customPackage.version = "2.160.1-beta.1";
      if (scenario === "runtime newline") metadata.publishConfig.customPackage.version = "2.160.1\n";
      const packageJson = join(cli, "package.json");
      await writeFile(packageJson, JSON.stringify(metadata));
      if (scenario === "metadata symlink") {
        const target = join(root, "external-package.json");
        await writeFile(target, JSON.stringify(metadata));
        await rm(packageJson);
        await symlink(target, packageJson);
      }
      await writeFile(join(cli, "bin", "codebuddy"), 'throw new Error("SYNTHETIC_CLIENT_MUST_NOT_EXECUTE");\n');
      await writeFile(join(root, "workbuddy-release.json"), JSON.stringify(release));
      const report = { desktopVersion: release.desktopVersion, runtimeVersion: release.runtimeVersion,
        arch: "arm64", sha256: release.sha256, file: "WorkBuddy.dmg" };
      const reportPath = join(root, "workbuddy-bundle.json");
      const originalReport = JSON.stringify(report);
      await writeFile(reportPath, originalReport);
      const product = scenario === "product mismatch" ? "0.0.0" : release.productVersion;
      const result = spawnSync(process.execPath, ["--input-type=module", "-", app, product], {
        input: macosMetadataScript(), cwd: root, encoding: "utf8", timeout: 5_000,
        env: { RUNNER_TEMP: root, HOME: root, USERPROFILE: root,
          ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR } : {}) },
      });
      assert.ifError(result.error);
      assert.equal(result.stdout, "");
      if (scenario === "baseline" || scenario === "latest") {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stderr, "");
        assert.deepEqual(JSON.parse(await readFile(reportPath, "utf8")), { ...report, runtimeVersion: runtime,
          command: "mounted/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy" });
      } else {
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, /AssertionError/);
        assert.equal(await readFile(reportPath, "utf8"), originalReport);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("WorkBuddy aggregate reports actual coverage and rejects unsuccessful dependencies or missing coverage", { skip: process.platform === "win32" }, async () => {
  const body = job("workbuddy-result").match(/^        run: \|\n([\s\S]*)$/m)?.[1];
  assert.ok(body);
  const script = body.split("\n").map((line) => line.slice(10)).join("\n");
  const root = await mkdtemp(join(tmpdir(), "workbuddy-workflow-"));
  const summaryPath = join(root, "summary.md");
  try {
    const results = ["success", "failure", "cancelled", "skipped"];
    // The release resolution is varied only with the other dependencies passing; skipped native cells cover its usual effect.
    const combinations = [...results.flatMap((packageResult) => results.map((nativeResult) => [packageResult, "success", nativeResult])),
      ...results.slice(1).map((releasesResult) => ["success", releasesResult, "success"])];
    for (const [packageResult, releasesResult, nativeResult] of combinations) {
      for (const coverage of ["All official latest releases resolved.",
        "Coverage degraded: Windows latest 5.7.6.40409493 not tested (winget manifest missing); selected 5.6.2.39298511.", ""]) {
        await writeFile(summaryPath, "");
        const result = spawnSync("/bin/bash", ["-e", "-o", "pipefail", "-c", script], {
          cwd: root, encoding: "utf8", timeout: 5_000,
          env: { PATH: "/usr/bin:/bin", HOME: root, GITHUB_STEP_SUMMARY: summaryPath, PACKAGE_RESULT: packageResult,
            RELEASES_RESULT: releasesResult, WORKBUDDY_RESULT: nativeResult, WORKBUDDY_COVERAGE: coverage },
        });
        assert.ifError(result.error);
        const passes = [packageResult, releasesResult, nativeResult].every((item) => item === "success") && coverage;
        assert.equal(result.status, passes ? 0 : 1,
          `package=${packageResult}, releases=${releasesResult}, native=${nativeResult}, coverage=${coverage}: ${result.stderr}`);
        const summary = await readFile(summaryPath, "utf8");
        assert.ok(summary.includes(coverage || "Coverage unavailable."));
        assert.ok(summary.includes(`Package: **${packageResult}**`));
        assert.ok(summary.includes(`WorkBuddy releases: **${releasesResult}**`));
        assert.ok(summary.includes(`WorkBuddy matrix: **${nativeResult}**`));
        assert.doesNotMatch(summary, /Verified baseline\/latest/);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
