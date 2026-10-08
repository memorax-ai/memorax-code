import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { baselineRelease, validateLinuxRelease } from "./cursor-app-release.mjs";
import { selectCursorMacosRelease } from "./cursor-app-macos-artifact.mjs";
import { selectCursorWindowsRelease } from "./cursor-app-windows-artifact.mjs";

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
  const { event = "pull_request", provider = false, diagnostic = false, cancelled = false } = options;
  const ready = Object.hasOwn(options, "ready") ? options.ready : "true";
  return Boolean(runInNewContext(condition.replaceAll("needs.package.outputs.artifact-ready", 'needs.package.outputs["artifact-ready"]'), {
    github: { event_name: event }, inputs: { check_deepseek: provider, diagnose_opencode_initialization: diagnostic },
    needs: { package: { outputs: { "artifact-ready": ready } } }, always: () => true, cancelled: () => cancelled,
  }, { timeout: 100 }));
}

test("Cursor App jobs retain normal triggers and exclude dedicated manual diagnostics", () => {
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
  assert.doesNotMatch(source, /check_cursor_.*_isolation|cursor-.*-proof|cursor-app.*isolation\.yml/);
});

test("Cursor App matrix uses the validated candidate, frozen release inventory and unique public reports", () => {
  const canary = job("cursor-app"), result = job("cursor-app-result");
  assert.match(job("package"), /^        run: node --test scripts\/cursor-app-\*\.test\.mjs scripts\/cursor-lifecycle-\*\.test\.mjs$/m);
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
  assert.equal(uploads.length, 3);
  for (const [index, kind] of [[1, "lifecycle"], [2, "app"]]) {
    assert.match(uploads[index], /^        if: always\(\)$/m);
    assert.match(uploads[index], new RegExp(`^          path: \\$\\{\\{ runner\\.temp \\}\\}/cursor-${kind}-report/report\\.json$`, "m"));
    assert.match(uploads[index], /^          if-no-files-found: error$/m);
    assert.match(uploads[index], new RegExp(`^          name: cursor-${kind}-\\$\\{\\{ matrix\\.os \\}\\}-\\$\\{\\{ matrix\\.channel \\}\\}-node-\\$\\{\\{ matrix\\.node \\}\\}-report$`, "m"));
  }
  assert.match(result, /^    needs: \[package, cursor-app\]$/m);
  assert.doesNotMatch(canary + result, /continue-on-error:/);
  assert.doesNotMatch(canary, /resolve-linux|api\/download|latest\.json/);
});

test("Cursor package lifecycle is required in every cell before native App execution", () => {
  const canary = job("cursor-app"), name = "Verify Cursor package lifecycle and saved account";
  const step = canary.split(`      - name: ${name}\n`);
  assert.equal(step.length, 2);
  const lifecycle = step[1].split(/\n      - /)[0];
  assert.match(lifecycle, /^        shell: bash$/m);
  assert.doesNotMatch(lifecycle, /^        (?:if|continue-on-error):/m);
  assert.ok(canary.indexOf("name: memorax-code-package") < canary.indexOf(`- name: ${name}`));
  assert.ok(canary.indexOf(`- name: ${name}`) < canary.indexOf("- name: Verify isolated native Cursor App writeback"));
  assert.match(script("cursor-app", name), /node scripts\/cursor-lifecycle-check\.mjs "\$1" "\$RUNNER_TEMP\/cursor-lifecycle-report"/);
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
  assert.match(run, /import \{ selectCursorWindowsRelease \} from '\.\/scripts\/cursor-app-windows-artifact\.mjs';/);
  const baseline = baselineRelease("linux-x64"), macos = baselineRelease("darwin-arm64"), windows = baselineRelease("win32-x64-user");
  const same = { ...baseline, channel: "latest", hashSource: "official-apt-sha256", size: 123456 };
  const sameMacos = { ...macos, channel: "latest" };
  const sameWindows = { ...windows, channel: "latest" };
  function execute(latest, latestMacos = sameMacos, schemaVersion = 1, macosBaseline = macos,
    latestWindows = sameWindows, windowsBaseline = windows) {
    const output = new Map(), manifest = { schemaVersion,
      baseline: { "linux-x64": baseline, "darwin-arm64": macosBaseline, "win32-x64-user": windowsBaseline },
      latest: { "linux-x64": latest, "darwin-arm64": latestMacos, "win32-x64-user": latestWindows } };
    runInNewContext(code, { process: { env: { RUNNER_TEMP: "/synthetic temp", GITHUB_OUTPUT: "output", GITHUB_STEP_SUMMARY: "summary" } },
      readFileSync(path) { assert.equal(path, "/synthetic temp/cursor-app-releases.json"); return JSON.stringify(manifest); },
      appendFileSync(path, content) { assert.ok(!output.has(path)); output.set(path, content); },
      validateLinuxRelease, selectCursorMacosRelease, selectCursorWindowsRelease,
    }, { timeout: 100 });
    const include = JSON.parse(output.get("output").slice("matrix=".length)).include;
    assert.equal(new Set(include.map((cell) => `${cell.os}-${cell.channel}-${cell.node}`)).size, include.length);
    assert.deepEqual([...new Set(include.map((cell) => cell.os))].sort(), ["macos-15", "ubuntu-24.04", "windows-2025"]);
    assert.ok(include.every((cell) => cell.os === "ubuntu-24.04" || cell.node === "24"));
    assert.equal(include.filter((cell) => cell.node === "22").length, 1);
    return include;
  }
  assert.deepEqual(execute(same), [
    { os: "ubuntu-24.04", node: "24", cursor: baseline.version, release: "baseline", channel: "baseline+latest" },
    { os: "ubuntu-24.04", node: "22", cursor: baseline.version, release: "baseline", channel: "baseline" },
    { os: "macos-15", node: "24", cursor: macos.version, release: "baseline", channel: "baseline+latest" },
    { os: "windows-2025", node: "24", cursor: windows.version, release: "baseline", channel: "baseline+latest" },
  ]);
  const newer = { ...same, version: "3.23.12", commitSha: "2d29876d567da1607532b23bbf2cd5ddbca496fe",
    url: "https://downloads.cursor.com/production/2d29876d567da1607532b23bbf2cd5ddbca496fe/linux/x64/deb/amd64/deb/cursor_3.23.12_amd64.deb",
    sha256: "4b38d23926c72f2080e2ba108593e38f3688312464d70adc9088db63a53c0346", debVersion: "3.23.12-1790831722" };
  const newerMacos = { ...sameMacos, version: newer.version, commitSha: newer.commitSha,
    url: `https://downloads.cursor.com/production/${newer.commitSha}/darwin/arm64/Cursor-darwin-arm64.dmg` };
  const newerWindows = { ...sameWindows, version: newer.version, commitSha: newer.commitSha,
    url: `https://downloads.cursor.com/production/${newer.commitSha}/win32/x64/user-setup/CursorUserSetup-x64-${newer.version}.exe` };
  const matrix = execute(newer, newerMacos, 1, macos, newerWindows);
  assert.deepEqual(matrix, [
    { os: "ubuntu-24.04", node: "24", cursor: baseline.version, release: "baseline", channel: "baseline" },
    { os: "ubuntu-24.04", node: "22", cursor: baseline.version, release: "baseline", channel: "baseline" },
    { os: "ubuntu-24.04", node: "24", cursor: newer.version, release: "latest", channel: "latest" },
    { os: "macos-15", node: "24", cursor: macos.version, release: "baseline", channel: "baseline" },
    { os: "macos-15", node: "24", cursor: newerMacos.version, release: "latest", channel: "latest" },
    { os: "windows-2025", node: "24", cursor: windows.version, release: "baseline", channel: "baseline" },
    { os: "windows-2025", node: "24", cursor: newerWindows.version, release: "latest", channel: "latest" },
  ]);
  assert.equal(execute(newer).length, 5);
  assert.equal(execute(same, newerMacos).length, 5);
  assert.equal(execute(same, sameMacos, 1, macos, newerWindows).length, 5);
  assert.equal(execute({ ...same, commitSha: "a".repeat(40), url: same.url.replace(same.commitSha, "a".repeat(40)),
    sha256: "f".repeat(64) }).length, 5);
  assert.throws(() => execute({ ...same, sha256: "f".repeat(64) }));
  assert.throws(() => execute({ ...same, debVersion: `${same.version}-1790000000` }));
  assert.equal(execute(same, { ...sameMacos, commitSha: "a".repeat(40),
    url: sameMacos.url.replace(sameMacos.commitSha, "a".repeat(40)) }).length, 5);
  assert.equal(execute(same, { ...sameMacos, version: "3.21.19" }).length, 5);
  assert.equal(execute(same, sameMacos, 1, macos, { ...sameWindows, commitSha: "a".repeat(40),
    url: sameWindows.url.replace(sameWindows.commitSha, "a".repeat(40)) }).length, 5);
  assert.throws(() => execute({ ...newer, sha256: null }));
  assert.throws(() => execute({ ...newer, platform: "linux-arm64" }));
  assert.throws(() => execute(newer, { ...newerMacos, platform: "darwin-x64" }));
  assert.throws(() => execute(newer, { ...newerMacos, channel: "baseline" }));
  assert.throws(() => execute(newer, { ...newerMacos, url: newerMacos.url.replace("downloads.cursor.com", "example.invalid") }));
  assert.throws(() => execute(newer, undefined, 1, { ...macos, version: "3.21.19" }));
  for (const changed of [{ ...newerWindows, platform: "win32-arm64-user" }, { ...newerWindows, channel: "baseline" },
    { ...newerWindows, url: newerWindows.url.replace("downloads.cursor.com", "example.invalid") }, null]) {
    assert.throws(() => execute(newer, newerMacos, 1, macos, changed));
  }
  assert.throws(() => execute(newer, newerMacos, 1, macos, newerWindows, { ...windows, version: "3.21.19" }));
  assert.throws(() => execute(newer, undefined, 2));
});

test("workflow entrypoints preserve platform selection, quoted inputs and every failure", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "cursor-app-workflow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const name = "memorax-memorax-code-fixture with spaces.tgz";
  for (const [runnerOs, entrypoint] of [["Linux", "container"], ["macOS", "macos"], ["Windows", "windows"], ["FreeBSD", null]]) {
    for (const kind of ["missing", "single", "multiple", "directory", "symlink", "failed"]) {
      const cwd = join(root, runnerOs, kind), tarballs = join(cwd, "dist/npm/tarballs"), candidate = join(tarballs, name);
      const calls = join(cwd, "calls"), runnerTemp = join(cwd, "runner temp");
      await mkdir(tarballs, { recursive: true });
      if (["single", "multiple", "failed"].includes(kind)) await writeFile(candidate, "synthetic tarball");
      if (kind === "multiple") await writeFile(join(tarballs, "memorax-memorax-code-other.tgz"), "second");
      if (kind === "directory") await mkdir(candidate);
      if (kind === "symlink") { await writeFile(join(cwd, "target"), "fixture"); await symlink(join(cwd, "target"), candidate); }
      for (const lifecycle of [false, true]) {
        await rm(calls, { force: true });
        const step = lifecycle ? "Verify Cursor package lifecycle and saved account" : "Verify isolated native Cursor App writeback";
        const actual = spawnSync("/bin/bash", ["-e", "-o", "pipefail", "-c",
          `node() { printf '%s\\n' "$@" > "$CALLS"; return "$RESULT"; }\n${script("cursor-app", step)}`], {
          cwd, encoding: "utf8", timeout: 5000,
          env: { PATH: "/usr/bin:/bin", HOME: cwd, RUNNER_TEMP: runnerTemp, RUNNER_OS: runnerOs, CALLS: calls,
            RESULT: kind === "failed" ? "7" : "0", CURSOR_RELEASE: "latest", CURSOR_NODE: "24" },
        });
        assert.ifError(actual.error);
        const invoked = ["single", "failed"].includes(kind) && (lifecycle || entrypoint);
        assert.equal(actual.status, invoked ? kind === "failed" ? 7 : 0 : 1, `${runnerOs}/${kind}/${step}`);
        if (invoked) assert.deepEqual((await readFile(calls, "utf8")).trimEnd().split("\n"), lifecycle
          ? ["scripts/cursor-lifecycle-check.mjs", `dist/npm/tarballs/${name}`, join(runnerTemp, "cursor-lifecycle-report")]
          : [`scripts/cursor-app-${entrypoint}-check.mjs`, `dist/npm/tarballs/${name}`, join(runnerTemp, "cursor-app-report"),
            join(runnerTemp, "cursor-app-releases/cursor-app-releases.json"), "latest", "24"]);
        else await assert.rejects(readFile(calls), { code: "ENOENT" });
      }
    }
  }
});

test("Cursor App summary fails every non-success dependency", { skip: process.platform === "win32" }, async (t) => {
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
      assert.ok(text.includes(`Package: **${packageResult}**`) && text.includes(`Cursor App Linux/macOS/Windows matrix: **${cursorResult}**`));
    }
  }
});
