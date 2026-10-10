import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { baselineRelease } from "./workbuddy-release-matrix.mjs";

const source = (await readFile(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8"))
  .replaceAll("\r\n", "\n");

// These source contracts complement actionlint; they are not a general YAML parser.
function job(id) {
  const parts = source.split(`\n  ${id}:\n`);
  assert.equal(parts.length, 2, `Expected one ${id} job`);
  return parts[1].split(/\n  [a-z][a-z0-9-]*:\n/)[0];
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
  assert.match(job("tests"), /^        run: node --test scripts\/ci\/codebuddy-workbuddy\/workbuddy-workflow\.test\.mjs$/m);
});

for (const id of ["workbuddy-package", "workbuddy-native", "workbuddy-result"]) {
  test(`${id} runs automatically and retains explicit manual selection`, () => {
    const condition = job(id).match(/^    if: (.+)$/m)?.[1];
    assert.ok(condition);
    if (id === "workbuddy-result") assert.match(condition, /^always\(\) && /);
    for (const [event, selected, expected] of [
      ["pull_request", undefined, true], ["push", undefined, true],
      ["pull_request", false, true], ["push", false, true],
      ["workflow_dispatch", true, true], ["workflow_dispatch", false, false],
      ["workflow_dispatch", undefined, false],
    ]) {
      const actual = runInNewContext(condition, {
        github: { event_name: event }, inputs: { diagnose_workbuddy: selected }, always: () => true,
      }, { timeout: 100 });
      assert.equal(Boolean(actual), expected, `${event}, diagnose_workbuddy=${selected}`);
    }
  });
}

test("WorkBuddy matrix retains the package gate and one aggregate result", () => {
  assert.match(job("workbuddy-package"), /^            make npm-package-check$/m);
  assert.match(job("workbuddy-native"), /^    needs: workbuddy-package$/m);
  assert.match(job("workbuddy-native"), /^      fail-fast: false$/m);
  assert.match(job("workbuddy-package"), /^      matrix: \$\{\{ steps\.releases\.outputs\.matrix \}\}$/m);
  assert.match(job("workbuddy-package"), /^      coverage: \$\{\{ steps\.releases\.outputs\.coverage \}\}$/m);
  assert.match(job("workbuddy-package"), /^        run: node scripts\/ci\/codebuddy-workbuddy\/workbuddy-release-matrix\.mjs resolve$/m);
  assert.match(job("workbuddy-native"), /^      matrix: \$\{\{ fromJSON\(needs\.workbuddy-package\.outputs\.matrix\) \}\}$/m);
  assert.match(job("workbuddy-native"), /^          node-version: \$\{\{ matrix\.node \}\}$/m);
  assert.match(job("workbuddy-native"), /^    name: WorkBuddy native \(\$\{\{ matrix\.os \}\}, Node \$\{\{ matrix\.node \}\}, \$\{\{ matrix\.release\.channel \}\}, \$\{\{ matrix\.release\.desktopVersion \}\}\)$/m);
  assert.match(job("workbuddy-native"), /RELEASE_JSON: \$\{\{ toJSON\(matrix\.release\) \}\}/);
  assert.doesNotMatch(job("workbuddy-native"), /run:.*\$\{\{ matrix\.release/);
  assert.match(job("workbuddy-native"), /-ReleaseFile \(Join-Path \$env:RUNNER_TEMP 'workbuddy-release\.json'\)/);
  const result = job("workbuddy-result");
  assert.match(result, /^    name: WorkBuddy functional result$/m);
  assert.match(result, /^    needs: \[workbuddy-package, workbuddy-native\]$/m);
  assert.match(result, /PACKAGE_RESULT: \$\{\{ needs\.workbuddy-package\.result \}\}/);
  assert.match(result, /WORKBUDDY_RESULT: \$\{\{ needs\.workbuddy-native\.result \}\}/);
  assert.match(result, /WORKBUDDY_COVERAGE: \$\{\{ needs\.workbuddy-package\.outputs\.coverage \}\}/);
  for (const id of ["workbuddy-package", "workbuddy-native", "workbuddy-result"]) {
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
  for (const event of ["pull_request", "push", "workflow_dispatch"]) {
    for (const selected of [false, true]) {
      const context = { github: { event_name: event }, inputs: { diagnose_workbuddy: selected },
        runner: { os: "Linux", temp: "/owned" }, always: () => true,
        format: (pattern, value) => pattern.replace("{0}", value) };
      const enabled = event === "workflow_dispatch" && selected;
      assert.equal(runInNewContext(capture, context), enabled ? "/owned/workbuddy-download-diagnostic" : "");
      assert.equal(runInNewContext(condition, context), enabled);
      for (const os of ["macOS", "Windows"]) {
        assert.equal(runInNewContext(condition, { ...context, runner: { os } }), false);
      }
    }
  }
  assert.match(upload, /uses: actions\/upload-artifact@v4/);
  assert.match(upload, /name: workbuddy-linux-download-node-\$\{\{ matrix.node \}\}-\$\{\{ matrix.release.channel \}\}/);
  assert.match(upload, /retention-days: 1/);
  assert.match(upload, /compression-level: 0/);
  assert.match(upload, /if-no-files-found: error/);
  assert.match(upload, /workbuddy-download-diagnostic\/WorkBuddy\.deb/);
  assert.match(upload, /workbuddy-download-diagnostic\/download\.json/);
  assert.doesNotMatch(upload, /path:.*\*|\.headers|\.partial|\.download/);
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
    for (const packageResult of ["success", "failure", "cancelled", "skipped"]) {
      for (const nativeResult of ["success", "failure", "cancelled", "skipped"]) {
        for (const coverage of ["All official latest releases resolved.",
          "Coverage degraded: Windows latest 5.7.6.40409493 not tested (winget manifest missing); selected 5.6.2.39298511.", ""]) {
          await writeFile(summaryPath, "");
          const result = spawnSync("/bin/bash", ["-e", "-o", "pipefail", "-c", script], {
            cwd: root, encoding: "utf8", timeout: 5_000,
            env: { PATH: "/usr/bin:/bin", HOME: root, GITHUB_STEP_SUMMARY: summaryPath,
              PACKAGE_RESULT: packageResult, WORKBUDDY_RESULT: nativeResult, WORKBUDDY_COVERAGE: coverage },
          });
          assert.ifError(result.error);
          assert.equal(result.status, packageResult === "success" && nativeResult === "success" && coverage ? 0 : 1,
            `package=${packageResult}, native=${nativeResult}, coverage=${coverage}: ${result.stderr}`);
          const summary = await readFile(summaryPath, "utf8");
          assert.ok(summary.includes(coverage || "Coverage unavailable."));
          assert.ok(summary.includes(`Package: **${packageResult}**`));
          assert.ok(summary.includes(`WorkBuddy matrix: **${nativeResult}**`));
          assert.doesNotMatch(summary, /Verified baseline\/latest/);
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
