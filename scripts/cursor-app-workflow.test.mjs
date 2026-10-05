import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = (await readFile(new URL("../.github/workflows/macos-codex-install.yml", import.meta.url), "utf8"))
  .replaceAll("\r\n", "\n");

// Execute these jobs' actual gates and shell blocks; source contracts complement
// actionlint and intentionally do not attempt general YAML parsing.
function job(id) {
  const parts = source.split(`\n  ${id}:\n`);
  assert.equal(parts.length, 2);
  return parts[1].split(/\n  [a-z][a-z0-9-]*:\n/)[0];
}

function script(id, name) {
  const step = job(id).split(`      - name: ${name}\n`);
  assert.equal(step.length, 2);
  const body = step[1].split(/\n      - /)[0].match(/^        run: \|\n([\s\S]*)$/m)?.[1];
  assert.ok(body);
  return body.split("\n").map((line) => line.slice(10)).join("\n");
}

function selected(id, options = {}) {
  const { event = "pull_request", provider = false, diagnostic = false, cancelled = false } = options;
  const ready = Object.hasOwn(options, "ready") ? options.ready : "true";
  const condition = job(id).match(/^    if: (.+)$/m)?.[1];
  assert.ok(condition);
  return Boolean(runInNewContext(condition.replaceAll("needs.package.outputs.artifact-ready", 'needs.package.outputs["artifact-ready"]'), {
    github: { event_name: event }, inputs: { check_deepseek: provider, diagnose_opencode_initialization: diagnostic },
    needs: { package: { outputs: { "artifact-ready": ready } } }, always: () => true, cancelled: () => cancelled,
  }, { timeout: 100 }));
}

test("Cursor App jobs retain normal triggers and exclude the two dedicated manual diagnostics", () => {
  for (const event of ["pull_request", "push", "workflow_dispatch"]) {
    for (const provider of [false, true]) {
      for (const diagnostic of [false, true]) {
        const expected = event !== "workflow_dispatch" || (!provider && !diagnostic);
        for (const id of ["cursor-app", "cursor-app-result"]) assert.equal(selected(id, { event, provider, diagnostic }), expected);
      }
    }
  }
  for (const ready of [undefined, "", "false"]) assert.equal(selected("cursor-app", { ready }), false);
  assert.equal(selected("cursor-app", { cancelled: true }), false);
  assert.equal(selected("cursor-app-result", { ready: "false", cancelled: true }), true);
  const triggers = source.split("\njobs:\n")[0];
  assert.match(triggers, /^  pull_request:$/m);
  assert.match(triggers, /^  push:\n    branches: \[main\]$/m);
  assert.doesNotMatch(triggers, /paths(?:-ignore)?:/);
});

test("Cursor App is one Node 24 Linux canary using the validated candidate and only its public report", () => {
  const canary = job("cursor-app"), result = job("cursor-app-result");
  assert.match(job("package"), /^        run: node --test scripts\/cursor-app-\*\.test\.mjs$/m);
  assert.match(canary, /^    needs: package$/m);
  assert.match(canary, /^    runs-on: ubuntu-24\.04$/m);
  assert.match(canary, /^          node-version: '24'$/m);
  assert.match(canary, /^    name: Cursor App canary \(Linux, Node 24, 3\.21\.18\)$/m);
  assert.match(canary, /actions\/download-artifact@v4\n        with:\n          name: memorax-code-package\n          path: dist\/npm\/tarballs/);
  const uploads = canary.split("      - uses: actions/upload-artifact@v4\n");
  assert.equal(uploads.length, 2);
  assert.match(uploads[1], /^        if: always\(\)$/m);
  assert.match(uploads[1], /^          path: \$\{\{ runner\.temp \}\}\/cursor-app-report\/report\.json$/m);
  assert.match(uploads[1], /^          if-no-files-found: error$/m);
  assert.match(result, /^    needs: \[package, cursor-app\]$/m);
  assert.doesNotMatch(canary + result, /continue-on-error:|strategy:|matrix:/);
});

test("Cursor App invocation accepts only one regular candidate and preserves quoted paths", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cursor-app-workflow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = script("cursor-app", "Verify isolated native Cursor App writeback");
  for (const kind of ["missing", "single", "multiple", "directory", "symlink"]) {
    const cwd = join(root, kind), tarballs = join(cwd, "dist/npm/tarballs"), calls = join(cwd, "calls");
    const runnerTemp = join(cwd, "runner temp");
    await mkdir(tarballs, { recursive: true });
    const name = "memorax-memorax-code-fixture with spaces.tgz", candidate = join(tarballs, name);
    if (["single", "multiple"].includes(kind)) await writeFile(candidate, "synthetic tarball");
    if (kind === "multiple") await writeFile(join(tarballs, "memorax-memorax-code-other.tgz"), "synthetic second tarball");
    if (kind === "directory") await mkdir(candidate);
    if (kind === "symlink") { await writeFile(join(cwd, "target"), "synthetic tarball"); await symlink(join(cwd, "target"), candidate); }
    const actual = spawnSync("/bin/bash", ["-e", "-o", "pipefail", "-c", `node() { printf '%s\\n' "$@" > "$CALLS"; }\n${run}`], {
      cwd, encoding: "utf8", timeout: 5_000,
      env: { PATH: "/usr/bin:/bin", HOME: cwd, RUNNER_TEMP: runnerTemp, CALLS: calls },
    });
    assert.ifError(actual.error);
    assert.equal(actual.status, kind === "single" ? 0 : 1, kind);
    if (kind === "single") assert.deepEqual((await readFile(calls, "utf8")).trimEnd().split("\n"), [
      "scripts/cursor-app-container-check.mjs", `dist/npm/tarballs/${name}`, join(runnerTemp, "cursor-app-report"),
    ]);
    else await assert.rejects(readFile(calls), { code: "ENOENT" });
  }
});

test("Cursor App summary fails every non-success dependency and states the limited native scope", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cursor-app-summary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = script("cursor-app-result", "Require the package and Cursor App canary to succeed");
  for (const packageResult of ["success", "failure", "cancelled", "skipped"]) {
    for (const cursorResult of ["success", "failure", "cancelled", "skipped"]) {
      const summary = join(root, `${packageResult}-${cursorResult}.md`);
      const actual = spawnSync("/bin/bash", ["-e", "-o", "pipefail", "-c", run], {
        cwd: root, encoding: "utf8", timeout: 5_000,
        env: { PATH: "/usr/bin:/bin", HOME: root, GITHUB_STEP_SUMMARY: summary,
          PACKAGE_RESULT: packageResult, CURSOR_RESULT: cursorResult },
      });
      assert.ifError(actual.error);
      assert.equal(actual.status, packageResult === "success" && cursorResult === "success" ? 0 : 1,
        `package=${packageResult}, cursor=${cursorResult}`);
      const text = await readFile(summary, "utf8");
      assert.ok(text.includes(`Package: **${packageResult}**`) && text.includes(`Cursor App Linux canary: **${cursorResult}**`));
      assert.match(text, /Four real App runs exercise repeated-prompt follow-up, independent sessions and App restart\/resume/);
      assert.match(text, /This Linux canary does not validate real login, hosted models, full functional coverage or three-platform acceptance/);
    }
  }
});
