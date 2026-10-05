import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { baselineRelease, validateLinuxRelease } from "./cursor-app-release.mjs";
import { selectCursorMacosRelease } from "./cursor-app-macos-artifact.mjs";

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
  const condition = job(id).match(/^    if: (.+)$/m)?.[1];
  assert.ok(condition);
  return evaluateCondition(condition, options);
}

function evaluateCondition(condition, options = {}) {
  const { event = "pull_request", provider = false, diagnostic = false, isolation = false, cancelled = false } = options;
  const ready = Object.hasOwn(options, "ready") ? options.ready : "true";
  return Boolean(runInNewContext(condition.replaceAll("needs.package.outputs.artifact-ready", 'needs.package.outputs["artifact-ready"]'), {
    github: { event_name: event }, inputs: { check_deepseek: provider, diagnose_opencode_initialization: diagnostic,
      check_cursor_macos_isolation: isolation },
    needs: { package: { outputs: { "artifact-ready": ready } } }, always: () => true, cancelled: () => cancelled,
  }, { timeout: 100 }));
}

test("Cursor App jobs retain normal triggers and exclude dedicated manual diagnostics and proof-only mode", () => {
  for (const event of ["pull_request", "push", "workflow_dispatch"]) {
    for (const provider of [false, true]) {
      for (const diagnostic of [false, true]) for (const isolation of [false, true]) {
        const expected = event !== "workflow_dispatch" || (!provider && !diagnostic && !isolation);
        for (const id of ["cursor-app", "cursor-app-result"]) assert.equal(selected(id, { event, provider, diagnostic, isolation }), expected);
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

test("Cursor App matrix uses the validated candidate, frozen release inventory and unique public reports", () => {
  const canary = job("cursor-app"), result = job("cursor-app-result");
  assert.match(job("package"), /^        run: node --test scripts\/cursor-app-\*\.test\.mjs$/m);
  assert.match(canary, /^    needs: package$/m);
  assert.match(canary, /^    runs-on: \$\{\{ matrix\.os \}\}$/m);
  assert.match(canary, /^          node-version: \$\{\{ matrix\.node \}\}$/m);
  assert.match(canary, /^    name: Cursor App \$\{\{ matrix\.channel \}\} \$\{\{ matrix\.cursor \}\} \(\$\{\{ matrix\.os \}\}, Node \$\{\{ matrix\.node \}\}\)$/m);
  assert.match(canary, /^      fail-fast: false$/m);
  assert.match(canary, /^      matrix: \$\{\{ fromJSON\(needs\.package\.outputs\.cursor-matrix\) \}\}$/m);
  assert.match(job("package"), /^      cursor-matrix: \$\{\{ steps\.cursor-versions\.outputs\.matrix \}\}$/m);
  assert.match(canary, /actions\/download-artifact@v4\n        with:\n          name: memorax-code-package\n          path: dist\/npm\/tarballs/);
  assert.match(canary, /actions\/download-artifact@v4\n        with:\n          name: cursor-app-releases\n          path: \$\{\{ runner\.temp \}\}\/cursor-app-releases/);
  const uploads = canary.split("      - uses: actions/upload-artifact@v4\n");
  assert.equal(uploads.length, 2);
  assert.match(uploads[1], /^        if: always\(\)$/m);
  assert.match(uploads[1], /^          path: \$\{\{ runner\.temp \}\}\/cursor-app-report\/report\.json$/m);
  assert.match(uploads[1], /^          if-no-files-found: error$/m);
  assert.match(uploads[1], /^          name: cursor-app-\$\{\{ matrix\.os \}\}-\$\{\{ matrix\.channel \}\}-node-\$\{\{ matrix\.node \}\}-report$/m);
  assert.match(result, /^    needs: \[package, cursor-app\]$/m);
  assert.doesNotMatch(canary + result, /continue-on-error:/);
  assert.doesNotMatch(canary, /resolve-linux|api\/download|latest\.json/);
});

test("Cursor release acquisition runs once outside the matrix and excludes dedicated diagnostics", () => {
  const step = job("package").split("      - name: Resolve and freeze Cursor App releases once for this run\n")[1];
  const condition = step.match(/^        if: (.+)$/m)?.[1];
  assert.ok(condition);
  for (const event of ["pull_request", "push", "workflow_dispatch"]) {
    for (const provider of [false, true]) for (const diagnostic of [false, true]) {
      assert.equal(evaluateCondition(condition, { event, provider, diagnostic }),
        event !== "workflow_dispatch" || (!provider && !diagnostic));
    }
  }
  assert.equal((source.match(/node scripts\/cursor-app-release\.mjs resolve-linux/g) ?? []).length, 1);
  assert.match(step, /name: cursor-app-releases\n          path: \$\{\{ runner\.temp \}\}\/cursor-app-releases\.json\n          if-no-files-found: error/);
});

test("Cursor matrix independently merges exact platform releases and keeps Linux baseline Node 22", () => {
  const run = script("package", "Resolve and freeze Cursor App releases once for this run");
  const code = run.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\nNODE/)?.[1].replace(/^import .+;\n/gm, "");
  assert.ok(code);
  assert.match(run, /import \{ selectCursorMacosRelease \} from '\.\/scripts\/cursor-app-macos-artifact\.mjs';/);
  const baseline = baselineRelease("linux-x64"), macos = baselineRelease("darwin-arm64");
  const same = { ...baseline, channel: "latest", hashSource: "official-apt-sha256", size: 123456 };
  const sameMacos = { ...macos, channel: "latest" };
  function execute(latest, latestMacos = sameMacos, schemaVersion = 1, macosBaseline = macos) {
    const output = new Map(), manifest = { schemaVersion, baseline: { "linux-x64": baseline, "darwin-arm64": macosBaseline },
      latest: { "linux-x64": latest, "darwin-arm64": latestMacos } };
    runInNewContext(code, { process: { env: { RUNNER_TEMP: "/synthetic temp", GITHUB_OUTPUT: "output", GITHUB_STEP_SUMMARY: "summary" } },
      readFileSync(path) { assert.equal(path, "/synthetic temp/cursor-app-releases.json"); return JSON.stringify(manifest); },
      appendFileSync(path, content) { assert.ok(!output.has(path)); output.set(path, content); }, validateLinuxRelease, selectCursorMacosRelease,
    }, { timeout: 100 });
    assert.match(output.get("summary"), /Linux and macOS App jobs, including Linux baseline on Node 22\. Windows remains outside this matrix\. No version fallback\./);
    const include = JSON.parse(output.get("output").slice("matrix=".length)).include;
    assert.equal(new Set(include.map((cell) => `${cell.os}-${cell.channel}-${cell.node}`)).size, include.length);
    assert.deepEqual([...new Set(include.map((cell) => cell.os))].sort(), ["macos-15", "ubuntu-24.04"]);
    assert.ok(include.every((cell) => cell.os !== "macos-15" || cell.node === "24"));
    assert.equal(include.filter((cell) => cell.node === "22").length, 1);
    return include;
  }
  assert.deepEqual(execute(same), [
    { os: "ubuntu-24.04", node: "24", cursor: baseline.version, release: "baseline", channel: "baseline+latest" },
    { os: "ubuntu-24.04", node: "22", cursor: baseline.version, release: "baseline", channel: "baseline" },
    { os: "macos-15", node: "24", cursor: macos.version, release: "baseline", channel: "baseline+latest" },
  ]);
  const newer = { ...same, version: "3.23.12", commitSha: "2d29876d567da1607532b23bbf2cd5ddbca496fe",
    url: "https://downloads.cursor.com/production/2d29876d567da1607532b23bbf2cd5ddbca496fe/linux/x64/deb/amd64/deb/cursor_3.23.12_amd64.deb",
    sha256: "4b38d23926c72f2080e2ba108593e38f3688312464d70adc9088db63a53c0346", debVersion: "3.23.12-1790831722" };
  const newerMacos = { ...sameMacos, version: newer.version, commitSha: newer.commitSha,
    url: `https://downloads.cursor.com/production/${newer.commitSha}/darwin/arm64/Cursor-darwin-arm64.dmg` };
  const matrix = execute(newer, newerMacos);
  assert.deepEqual(matrix, [
    { os: "ubuntu-24.04", node: "24", cursor: baseline.version, release: "baseline", channel: "baseline" },
    { os: "ubuntu-24.04", node: "22", cursor: baseline.version, release: "baseline", channel: "baseline" },
    { os: "ubuntu-24.04", node: "24", cursor: newer.version, release: "latest", channel: "latest" },
    { os: "macos-15", node: "24", cursor: macos.version, release: "baseline", channel: "baseline" },
    { os: "macos-15", node: "24", cursor: newerMacos.version, release: "latest", channel: "latest" },
  ]);
  assert.equal(execute(newer).length, 4);
  assert.equal(execute(same, newerMacos).length, 4);
  assert.equal(execute({ ...same, commitSha: "a".repeat(40), url: same.url.replace(same.commitSha, "a".repeat(40)),
    sha256: "f".repeat(64) }).length, 4);
  assert.throws(() => execute({ ...same, sha256: "f".repeat(64) }));
  assert.throws(() => execute({ ...same, debVersion: `${same.version}-1790000000` }));
  assert.equal(execute(same, { ...sameMacos, commitSha: "a".repeat(40),
    url: sameMacos.url.replace(sameMacos.commitSha, "a".repeat(40)) }).length, 4);
  assert.equal(execute(same, { ...sameMacos, version: "3.21.19" }).length, 4);
  assert.throws(() => execute({ ...newer, sha256: null }));
  assert.throws(() => execute({ ...newer, platform: "linux-arm64" }));
  assert.throws(() => execute(newer, { ...newerMacos, platform: "darwin-x64" }));
  assert.throws(() => execute(newer, { ...newerMacos, channel: "baseline" }));
  assert.throws(() => execute(newer, { ...newerMacos, url: newerMacos.url.replace("downloads.cursor.com", "example.invalid") }));
  assert.throws(() => execute(newer, undefined, 1, { ...macos, version: "3.21.19" }));
  assert.throws(() => execute(newer, undefined, 2));
});

test("Cursor App invocation selects the native platform, rejects unknown systems and preserves quoted paths", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cursor-app-workflow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = script("cursor-app", "Verify isolated native Cursor App writeback");
  for (const [runnerOs, entrypoint] of [["Linux", "container"], ["macOS", "macos"], ["Windows", null], ["", null]]) {
    for (const kind of ["missing", "single", "multiple", "directory", "symlink"]) {
      const cwd = join(root, runnerOs || "unknown", kind), tarballs = join(cwd, "dist/npm/tarballs"), calls = join(cwd, "calls");
      const runnerTemp = join(cwd, "runner temp");
      await mkdir(tarballs, { recursive: true });
      const name = "memorax-memorax-code-fixture with spaces.tgz", candidate = join(tarballs, name);
      if (["single", "multiple"].includes(kind)) await writeFile(candidate, "synthetic tarball");
      if (kind === "multiple") await writeFile(join(tarballs, "memorax-memorax-code-other.tgz"), "synthetic second tarball");
      if (kind === "directory") await mkdir(candidate);
      if (kind === "symlink") { await writeFile(join(cwd, "target"), "synthetic tarball"); await symlink(join(cwd, "target"), candidate); }
      const actual = spawnSync("/bin/bash", ["-e", "-o", "pipefail", "-c", `node() { printf '%s\\n' "$@" > "$CALLS"; }\n${run}`], {
        cwd, encoding: "utf8", timeout: 5_000,
        env: { PATH: "/usr/bin:/bin", HOME: cwd, RUNNER_TEMP: runnerTemp, RUNNER_OS: runnerOs, CALLS: calls,
          CURSOR_RELEASE: "latest", CURSOR_NODE: "24" },
      });
      assert.ifError(actual.error);
      assert.equal(actual.status, kind === "single" && entrypoint ? 0 : 1, `${runnerOs}: ${kind}`);
      if (kind === "single" && entrypoint) assert.deepEqual((await readFile(calls, "utf8")).trimEnd().split("\n"), [
        `scripts/cursor-app-${entrypoint}-check.mjs`, `dist/npm/tarballs/${name}`, join(runnerTemp, "cursor-app-report"),
        join(runnerTemp, "cursor-app-releases/cursor-app-releases.json"), "latest", "24",
      ]);
      else await assert.rejects(readFile(calls), { code: "ENOENT" });
    }
  }
});

test("Cursor App invocation retains either platform entrypoint failure", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cursor-app-workflow-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "dist/npm/tarballs"), { recursive: true });
  await writeFile(join(root, "dist/npm/tarballs/memorax-memorax-code-fixture.tgz"), "synthetic tarball");
  for (const runnerOs of ["Linux", "macOS"]) {
    const actual = spawnSync("/bin/bash", ["-e", "-o", "pipefail", "-c",
      `node() { return 7; }\n${script("cursor-app", "Verify isolated native Cursor App writeback")}`], {
      cwd: root, encoding: "utf8", timeout: 5_000,
      env: { PATH: "/usr/bin:/bin", HOME: root, RUNNER_OS: runnerOs, RUNNER_TEMP: root, CURSOR_RELEASE: "baseline", CURSOR_NODE: "24" },
    });
    assert.ifError(actual.error);
    assert.equal(actual.status, 7, runnerOs);
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
      assert.ok(text.includes(`Package: **${packageResult}**`) && text.includes(`Cursor App Linux/macOS matrix: **${cursorResult}**`));
      assert.match(text, /Ubuntu 24\.04 and macOS 15, baseline\/latest on Node 24 and Linux baseline on Node 22/);
      assert.match(text, /Six completed App runs per cell exercise repeated-prompt follow-up, independent sessions, App restart\/resume and explicit Skill Search\/Add through native Read\/Shell tools/);
      assert.match(text, /A seventh run cancels a pending Shell through native Stop, requiring interrupted Hook state, no command execution and no additional Memory request/);
      assert.match(text, /Scripted tool requests do not validate model-driven Skill selection/);
      assert.match(text, /macOS requires verified code signatures, Gatekeeper and a network-only sandbox on a fresh GitHub-hosted runner/);
      assert.match(text, /This matrix does not validate real login, Keychain isolation, hosted models, full functional coverage or Windows acceptance/);
    }
  }
});
