import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CLIENTS, WORKFLOW, nativeSteps, readText, selectClients } from "./native-scope.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SCRIPT = fileURLToPath(new URL("./native-scope.mjs", import.meta.url));

// A synthetic repository: each native job runs one client script, the WorkBuddy job also runs its tests by glob, and the
// package job, which every pull request runs, runs a contract test.
const WORKFLOW_TEXT = `on: pull_request
jobs:
  package:
    steps:
      - run: node --test scripts/ci/codex/codex-check.test.mjs
  install:
    steps:
      - run: node scripts/ci/codex/codex-check.mjs
  opencode:
    steps:
      - run: node ./scripts/ci/opencode/opencode-check.mjs
  claude:
    steps:
      - run: bash scripts/ci/claude/claude-check.sh
  codebuddy:
    steps:
      - run: node scripts/ci/codebuddy-workbuddy/codebuddy-check.mjs
  cursor-app:
    steps:
      - run: node scripts/ci/cursor/cursor-app-check.mjs
  workbuddy-native:
    steps:
      - run: node --test scripts/ci/codebuddy-workbuddy/workbuddy-*.test.mjs
      - run: node scripts/ci/codebuddy-workbuddy/workbuddy-check.mjs
`;
const FILES = {
  "README.md": "",
  "docs/guide.md": "Run node scripts/ci/codebuddy-workbuddy/codebuddy-check.mjs.\n",
  ".github/workflows/native.yml": WORKFLOW_TEXT,
  "Makefile": "check:\n\tnode scripts/ci/opencode/opencode-check.mjs\n",
  "package.json": "{}\n",
  "packages/core/index.mjs": "",
  "packages/ts/memorax-code-backend/src/lifecycle/client-plugin-removal.ts":
    "import('../../../memorax-code-opencode-adapter/src/plugin-install.mjs');\n",
  "packages/ts/memorax-code-claude-adapter/src/plugin-install.mjs": "",
  "packages/ts/memorax-code-codebuddy-adapter/src/cli.mjs": "",
  "packages/ts/memorax-code-codex-adapter/hooks/runtime-hook.mjs": "",
  "packages/ts/memorax-code-codex-adapter/skills/memorax-code/SKILL.md": "",
  "packages/ts/memorax-code-opencode-adapter/src/plugin-install.mjs": "",
  "packages/ts/memorax-code-opencode-adapter/src/plugin.mjs": "",
  "packages/ts/memorax-code-trae-adapter/src/config.mjs": "",
  "scripts/lib/shared.mjs": "",
  "scripts/npm-package-check.sh": "node test/package-fixture.mjs\n",
  "test/package-fixture.mjs": "",
  "test/cursor-fixture.mjs": "",
  "scripts/ci/codex/check.mjs": "",
  "scripts/ci/codex/codex-check.mjs": "import './codex-reused.mjs';\n",
  "scripts/ci/codex/codex-check.test.mjs": "",
  "scripts/ci/codex/codex-reused.mjs": "",
  "scripts/ci/opencode/opencode-check.mjs": "// Not my-check.mjs or recheck.mjs.\n",
  "scripts/ci/claude/claude-check.sh": "node scripts/ci/codex/codex-reused.mjs\n",
  "scripts/ci/codebuddy-workbuddy/codebuddy-check.mjs": "",
  "scripts/ci/codebuddy-workbuddy/workbuddy-check.mjs": "",
  "scripts/ci/codebuddy-workbuddy/workbuddy-parser.test.mjs": "",
  "scripts/ci/cursor/cursor-app-check.mjs": "import '../../../test/cursor-fixture.mjs';\n",
  "scripts/ci/dsh/dsh-check.mjs": "",
};
const synthetic = (changed) => selectClients({ changed, files: Object.keys(FILES), read: (file) => FILES[file] ?? "",
  workflow: WORKFLOW_TEXT });

test("each changed file selects the clients whose native steps can run it", () => {
  const expected = [
    ["README.md", [], "documentation"],
    ["docs/guide.md", [], "documentation"],
    // Shared and unclassified files select every client.
    ["package.json", CLIENTS, "shared or unclassified"],
    ["packages/core/index.mjs", CLIENTS, "shared or unclassified"],
    ["scripts/lib/shared.mjs", CLIENTS, "shared or unclassified"],
    [".github/workflows/native.yml", CLIENTS, "shared or unclassified"],
    // A client's own files select that client; the workflow, a Makefile target or a documentation mention adds no other.
    ["scripts/ci/opencode/opencode-check.mjs", ["opencode"], "its own native step or client file"],
    ["scripts/ci/codebuddy-workbuddy/codebuddy-check.mjs", ["codebuddy"], "its own native step or client file"],
    ["scripts/ci/codebuddy-workbuddy/workbuddy-check.mjs", ["workbuddy"], "its own native step or client file"],
    // So do a client's adapter files. The CodeBuddy adapter also serves WorkBuddy and Trae has no native matrix here.
    ["packages/ts/memorax-code-opencode-adapter/src/plugin.mjs", ["opencode"], "its own native step or client file"],
    ["packages/ts/memorax-code-codex-adapter/hooks/runtime-hook.mjs", ["codex"], "its own native step or client file"],
    ["packages/ts/memorax-code-codebuddy-adapter/src/cli.mjs", ["codebuddy", "workbuddy"], "its own native step or client file"],
    ["packages/ts/memorax-code-trae-adapter/src/config.mjs", [], "no native step runs it"],
    // The canonical Skill and the Hook runtime in the Codex and Claude adapters are shared, and so is an adapter file that
    // shared code loads.
    ["packages/ts/memorax-code-codex-adapter/skills/memorax-code/SKILL.md", CLIENTS, "shared or unclassified"],
    ["packages/ts/memorax-code-claude-adapter/src/plugin-install.mjs", CLIENTS, "shared or unclassified"],
    ["packages/ts/memorax-code-opencode-adapter/src/plugin-install.mjs", CLIENTS,
      "named by shared or unclassified packages/ts/memorax-code-backend/src/lifecycle/client-plugin-removal.ts"],
    // A name inside a longer file name is not a reference.
    ["scripts/ci/codex/check.mjs", ["codex"], "its own native step or client file"],
    // Reuse across directories selects every client that runs the file, not only the directory's owner.
    ["scripts/ci/codex/codex-reused.mjs", ["codex", "claude"], "named by scripts/ci/claude/claude-check.sh"],
    // A test selects only the native jobs that run it, directly or through a file they run.
    ["scripts/ci/codex/codex-check.test.mjs", [], "no native step runs it"],
    ["scripts/ci/codebuddy-workbuddy/workbuddy-parser.test.mjs", ["workbuddy"], "its own native step or client file"],
    ["test/cursor-fixture.mjs", ["cursor"], "named by scripts/ci/cursor/cursor-app-check.mjs"],
    ["test/package-fixture.mjs", CLIENTS, "named by shared or unclassified scripts/npm-package-check.sh"],
    // DSH has no native matrix here, and a deleted client file still selects its client.
    ["scripts/ci/dsh/dsh-check.mjs", [], "no native step runs it"],
    ["scripts/ci/cursor/cursor-removed.mjs", ["cursor"], "its own native step or client file"],
  ];
  const { files } = synthetic(expected.map(([file]) => file));
  assert.deepEqual(files, expected.map(([file, clients, reason]) => ({ file, clients, reason })));
});

test("a pull request selects the union of its files' clients, and documentation alone selects none", () => {
  assert.deepEqual(synthetic(["README.md", "test/cursor-fixture.mjs", "scripts/ci/codebuddy-workbuddy/workbuddy-check.mjs"]).clients,
    ["cursor", "workbuddy"]);
  assert.deepEqual(synthetic(["README.md", "docs/guide.md"]).clients, []);
  assert.deepEqual(synthetic(["scripts/ci/codex/codex-check.test.mjs"]).clients, []);
  assert.deepEqual(synthetic(["docs/guide.md", "scripts/lib/shared.mjs"]).clients, CLIENTS);
});

test("native steps are read from each client's job and every native job must name a repository file", () => {
  const steps = nativeSteps(WORKFLOW_TEXT, Object.keys(FILES));
  assert.deepEqual(Object.keys(steps), CLIENTS);
  assert.ok(steps.workbuddy.some((step) => step.test("scripts/ci/codebuddy-workbuddy/workbuddy-parser.test.mjs")));
  assert.ok(!steps.workbuddy.some((step) => step.test("scripts/ci/codebuddy-workbuddy/nested/workbuddy-parser.test.mjs")));
  assert.ok(steps.opencode.some((step) => step.test("scripts/ci/opencode/opencode-check.mjs")));
  // The package job is not a native job.
  assert.ok(!Object.values(steps).flat().some((step) => step.test("scripts/ci/codex/codex-check.test.mjs")));
  assert.throws(() => nativeSteps(WORKFLOW_TEXT.replace("node scripts/ci/cursor/cursor-app-check.mjs", "echo none"), Object.keys(FILES)),
    /The cursor-app job of .+ names no repository file/);
  assert.throws(() => nativeSteps(WORKFLOW_TEXT.replace("  claude:\n", "  claude-native:\n"), Object.keys(FILES)),
    /The claude job of .+ names no repository file/);
});

test("this repository's changes select the clients that can be affected", () => {
  const listed = spawnSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  assert.equal(listed.status, 0, listed.stderr);
  const read = (file) => readText(join(ROOT, file));
  const changed = [
    // #234 changed only this contract test, which the package job runs for every pull request.
    ["scripts/ci/codebuddy-workbuddy/codebuddy-native-content-check.test.mjs", []],
    ["docs/troubleshooting.md", []],
    ["scripts/ci/codex/codex-install-smoke.mjs", ["codex"]],
    ["scripts/ci/opencode/opencode-native-check.mjs", ["opencode"]],
    ["scripts/ci/claude/claude-install-smoke.mjs", ["claude"]],
    ["scripts/ci/codebuddy-workbuddy/codebuddy-native-check.mjs", ["codebuddy"]],
    ["scripts/ci/cursor/cursor-app-release.mjs", ["cursor"]],
    ["scripts/ci/codebuddy-workbuddy/workbuddy-release-matrix.mjs", ["workbuddy"]],
    ["scripts/ci/codebuddy-workbuddy/workbuddy-winget-parser.test.mjs", ["workbuddy"]],
    // Codex helpers that every client's checks reuse, the workflow and this selection select every client.
    ["scripts/ci/codex/codex-lifecycle-assertions.mjs", CLIENTS],
    ["scripts/ci/codex/codex-native-content-check.mjs", CLIENTS],
    ["scripts/ci/codex/codex-setup-pty.mjs", CLIENTS],
    [WORKFLOW, CLIENTS],
    ["scripts/ci/shared/native-scope.mjs", CLIENTS],
    // The client acceptance manifest and its reader pin every client's pull request inputs, so an update runs every matrix.
    ["scripts/ci/shared/client-acceptance.json", CLIENTS],
    ["scripts/ci/shared/client-acceptance.mjs", CLIENTS],
    // Adapter files that shared code loads whichever client it serves: the Backend loads the OpenCode plugin installer to
    // clean up every client's plugins, and the setup imports the Cursor adapter's paths. The canonical Skill and the client
    // Hook runtime are shared. An adapter's tests run in Tests.
    ["packages/ts/memorax-code-opencode-adapter/src/plugin-install.mjs", CLIENTS],
    ["packages/ts/memorax-code-cursor-adapter/src/adapter-paths.mjs", CLIENTS],
    ["packages/ts/memorax-code-codex-adapter/skills/memorax-code/SKILL.md", CLIENTS],
    ["packages/ts/memorax-code-claude-adapter/runtime-hooks/memory-turn.mjs", CLIENTS],
    ["packages/ts/memorax-code-opencode-adapter/test/plugin-install.test.mjs", []],
  ];
  const { files } = selectClients({ changed: changed.map(([file]) => file), files: listed.stdout.split("\0").filter(Boolean),
    read, workflow: read(WORKFLOW) });
  assert.deepEqual(files.map(({ file, clients }) => [file, clients]), changed);
});

test("the command selects from the pull request merge commit and writes the job outputs and summary", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "native-scope-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: root, GIT_CONFIG_NOSYSTEM: "1" };
  const git = (...args) => {
    const result = spawnSync("git", ["-c", "user.name=Native Scope", "-c", "user.email=native-scope@example.invalid",
      "-c", "commit.gpgsign=false", "-c", "init.defaultBranch=main", ...args], { cwd: root, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const write = async (file, text) => {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), text);
  };
  await write(WORKFLOW, await readFile(join(ROOT, WORKFLOW), "utf8"));
  await write("docs/guide.md", "Guide.\n");
  await write("scripts/ci/cursor/cursor-helper.mjs", "export {};\n");
  // A link to a directory has no text to search.
  await symlink("../../../docs", join(root, "scripts/ci/cursor/docs-link"));
  git("init", "--quiet");
  git("add", "--all");
  git("commit", "--quiet", "--message", "Base");
  git("switch", "--quiet", "--create", "change");
  await write("docs/guide.md", "Changed guide.\n");
  await write("scripts/ci/cursor/cursor-helper.mjs", "export const changed = true;\n");
  git("commit", "--quiet", "--all", "--message", "Change");
  const head = git("rev-parse", "HEAD");
  git("switch", "--quiet", "main");
  await write("README.md", "Base moved on.\n");
  git("add", "README.md");
  git("commit", "--quiet", "--message", "Base moved on");
  git("merge", "--quiet", "--no-ff", "--no-edit", "change");
  const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: root, env, encoding: "utf8", timeout: 30_000 });

  const output = join(root, "output"), summary = join(root, "summary.md");
  const selected = run("select", "--expected-head", head, "--github-output", output, "--github-summary", summary);
  assert.equal(selected.status, 0, selected.stderr);
  // The base's own change is not part of the pull request.
  assert.deepEqual(JSON.parse(selected.stdout).files.map(({ file }) => file), ["docs/guide.md", "scripts/ci/cursor/cursor-helper.mjs"]);
  assert.equal(await readFile(output, "utf8"), CLIENTS.map((client) => `${client}=${client === "cursor"}\n`).join(""));
  const text = await readFile(summary, "utf8");
  assert.match(text, /^\| Cursor App \| selected \|$/m);
  assert.match(text, /^\| Codex \| not selected: this pull request does not validate it \|$/m);
  assert.match(text, /^\| `docs\/guide\.md` \| none \| documentation \|$/m);
  assert.match(text, /^\| `scripts\/ci\/cursor\/cursor-helper\.mjs` \| Cursor App \| its own native step or client file \|$/m);

  // Another head, a malformed head or an unknown command fails without writing outputs.
  for (const args of [["select", "--expected-head", "f".repeat(40)], ["select", "--expected-head", "HEAD"], ["select"],
    ["list", "--expected-head", head], ["select", "--expected-head"]]) {
    const failed = run(...args, "--github-output", join(root, "unused"));
    assert.equal(failed.status, 1, args.join(" "));
    assert.match(failed.stderr, /^::error title=Native client scope::/, args.join(" "));
    await assert.rejects(readFile(join(root, "unused")), { code: "ENOENT" });
  }

  // Any other file that cannot be read, here a dangling link the base already has, fails the selection: reading it as empty
  // would drop the clients that its references select.
  await mkdir(join(root, "scripts/ci/claude"));
  await symlink("missing.mjs", join(root, "scripts/ci/claude/claude-check.mjs"));
  git("add", "scripts/ci/claude/claude-check.mjs");
  git("commit", "--quiet", "--message", "Dangling link");
  git("switch", "--quiet", "--create", "again");
  await write("scripts/ci/cursor/cursor-helper.mjs", "export const again = true;\n");
  git("commit", "--quiet", "--all", "--message", "Change again");
  const again = git("rev-parse", "HEAD");
  git("switch", "--quiet", "main");
  git("merge", "--quiet", "--no-ff", "--no-edit", "again");
  const unreadable = run("select", "--expected-head", again, "--github-output", join(root, "unused"));
  assert.equal(unreadable.status, 1, unreadable.stdout);
  assert.match(unreadable.stderr, /^::error title=Native client scope::ENOENT.+scripts\/ci\/claude\/claude-check\.mjs/);
  await assert.rejects(readFile(join(root, "unused")), { code: "ENOENT" });
});
