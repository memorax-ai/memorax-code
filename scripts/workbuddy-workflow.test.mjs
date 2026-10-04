import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = (await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"))
  .replaceAll("\r\n", "\n");

// These source contracts complement actionlint; they are not a general YAML parser.
function job(id) {
  const parts = source.split(`\n  ${id}:\n`);
  assert.equal(parts.length, 2, `Expected one ${id} job`);
  return parts[1].split(/\n  [a-z][a-z0-9-]*:\n/)[0];
}

test("WorkBuddy CI automatically listens to main PRs and pushes without path filters", () => {
  const triggers = source.split("\njobs:\n")[0];
  assert.match(triggers, /^  pull_request:\n    branches: \[main\]$/m);
  assert.match(triggers, /^  push:\n    branches: \[main\]$/m);
  assert.doesNotMatch(triggers, /paths(?:-ignore)?:/);
  assert.match(job("tests"), /^        run: node --test scripts\/workbuddy-workflow\.test\.mjs$/m);
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
  assert.match(job("workbuddy-native"), /^        os: \[ubuntu-24\.04, macos-15, windows-2025\]$/m);
  assert.match(job("workbuddy-native"), /^        node: \['24'\]$/m);
  assert.match(job("workbuddy-native"), /^        include:\n          - os: ubuntu-24\.04\n            node: '20'$/m);
  assert.match(job("workbuddy-native"), /^          node-version: \$\{\{ matrix\.node \}\}$/m);
  assert.match(job("workbuddy-native"), /^    name: WorkBuddy native \(\$\{\{ matrix\.os \}\}, Node \$\{\{ matrix\.node \}\}\)$/m);
  const result = job("workbuddy-result");
  assert.match(result, /^    name: WorkBuddy functional result$/m);
  assert.match(result, /^    needs: \[workbuddy-package, workbuddy-native\]$/m);
  assert.match(result, /PACKAGE_RESULT: \$\{\{ needs\.workbuddy-package\.result \}\}/);
  assert.match(result, /WORKBUDDY_RESULT: \$\{\{ needs\.workbuddy-native\.result \}\}/);
  for (const id of ["workbuddy-package", "workbuddy-native", "workbuddy-result"]) {
    assert.doesNotMatch(job(id), /continue-on-error:/);
  }
});

test("WorkBuddy aggregate rejects failed, cancelled or skipped dependencies", { skip: process.platform === "win32" }, async () => {
  const body = job("workbuddy-result").match(/^        run: \|\n([\s\S]*)$/m)?.[1];
  assert.ok(body);
  const script = body.split("\n").map((line) => line.slice(10)).join("\n");
  const root = await mkdtemp(join(tmpdir(), "workbuddy-workflow-"));
  try {
    for (const packageResult of ["success", "failure", "cancelled", "skipped"]) {
      for (const nativeResult of ["success", "failure", "cancelled", "skipped"]) {
        const result = spawnSync("/bin/bash", ["-e", "-o", "pipefail", "-c", script], {
          cwd: root, encoding: "utf8", timeout: 5_000,
          env: { PATH: "/usr/bin:/bin", HOME: root, GITHUB_STEP_SUMMARY: join(root, "summary.md"),
            PACKAGE_RESULT: packageResult, WORKBUDDY_RESULT: nativeResult },
        });
        assert.ifError(result.error);
        assert.equal(result.status, packageResult === "success" && nativeResult === "success" ? 0 : 1,
          `package=${packageResult}, native=${nativeResult}: ${result.stderr}`);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
