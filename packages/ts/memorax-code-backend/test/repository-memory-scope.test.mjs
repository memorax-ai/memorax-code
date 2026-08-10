import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fsPromises from "node:fs/promises";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  resolveConfiguredRepositoryMemoryForSession,
} from "../dist/memory/repository-session.js";
import {
  repositoryMemoryScopeCanUpgradeFromDegradedGit,
  repositoryMemoryScopeContainsWorkspace,
  repositoryMemoryScopesMatch,
  resolveRepositoryMemoryScope,
} from "../dist/repository/scope.js";

const execFileAsync = promisify(execFile);

test("workspace memory scope derives a readable namespace from the workspace root folder", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-workspace-name-"));
  const workspace = join(root, "Ｍｙ @ Workspace");
  await mkdir(workspace, { recursive: true });

  const result = await resolveRepositoryMemoryScope({
    workspaceRoot: workspace,
    baseUserId: "alice@example.com",
  });

  assert.equal(result.ok, true);
  assert.equal(result.scope.schemaVersion, "workspace-memory-scope.v1");
  assert.equal(result.scope.repositorySlug, "My-Workspace");
  assert.equal(result.scope.repositoryName, "My-Workspace");
  assert.equal(result.scope.effectiveUserId, "alice@example.com@My-Workspace");
  assert.equal(result.scope.identitySource, "workspace-directory");
  assert.equal(result.scope.scopeKind, "local-directory");
  assert.equal(result.scope.boundWorkspaceRoot, await realpath(workspace));
  assert.equal(
    result.scope.repositoryKey,
    createHash("sha256")
      .update(`workspace-directory:${await realpath(workspace)}`)
      .digest("hex"),
  );
});

test("workspace namespace truncation preserves complete Unicode code points", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-workspace-unicode-"));
  const workspace = join(root, `${"a".repeat(119)}𐐀tail`);
  await mkdir(workspace, { recursive: true });

  const result = await resolveRepositoryMemoryScope({
    workspaceRoot: workspace,
    baseUserId: "alice",
  });

  assert.equal(result.ok, true);
  assert.equal([...result.scope.repositorySlug].length, 120);
  assert.equal(result.scope.repositorySlug.endsWith("𐐀"), true);
  assert.equal(result.scope.repositorySlug.includes("\uFFFD"), false);
});

test("workspace scope resolution does not require a Git executable", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-workspace-no-git-"));
  const workspace = join(root, "memorax-code");
  const emptyPath = join(root, "empty-path");
  await createGitRepository(workspace, [
    ["origin", "https://github.com/example-org/memorax-code.git"],
  ]);
  await mkdir(emptyPath, { recursive: true });
  const moduleUrl = new URL("../dist/repository/scope.js", import.meta.url).href;
  const source = [
    `import { resolveRepositoryMemoryScope } from ${JSON.stringify(moduleUrl)};`,
    `const result = await resolveRepositoryMemoryScope(${JSON.stringify({
      workspaceRoot: workspace,
      baseUserId: "alice",
    })});`,
    "process.stdout.write(JSON.stringify(result));",
  ].join("\n");

  const { stdout } = await execFileAsync(
    process.execPath,
    ["--input-type=module", "-e", source],
    { env: { ...process.env, PATH: emptyPath } },
  );
  const result = JSON.parse(stdout);

  assert.equal(result.ok, true);
  assert.equal(result.scope.effectiveUserId, "alice@memorax-code");
  assert.equal(result.scope.identitySource, "origin-remote");
  assert.equal(result.scope.scopeKind, "git-repository");
  assert.equal(
    result.scope.repositoryKey,
    createHash("sha256")
      .update(`git-common-dir:${await realpath(join(workspace, ".git"))}`)
      .digest("hex"),
  );
});

test("workspace scope resolution yields the event loop while Git metadata reads are pending", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-workspace-async-metadata-"));
  const workspace = join(root, "memorax-code");
  const configPath = join(workspace, ".git", "config");
  await createGitRepository(workspace, [
    ["origin", "https://github.com/example-org/memorax-code.git"],
  ]);
  const canonicalConfigPath = await realpath(configPath);

  const originalReadFile = fsPromises.readFile;
  let releaseRead = () => undefined;
  let markReadStarted = () => undefined;
  const readStarted = new Promise((resolveStarted) => {
    markReadStarted = resolveStarted;
  });
  const readGate = new Promise((resolveRead) => {
    releaseRead = resolveRead;
  });
  fsPromises.readFile = async (path, ...args) => {
    if (path === canonicalConfigPath) {
      markReadStarted();
      await readGate;
    }
    return await originalReadFile(path, ...args);
  };

  try {
    let settled = false;
    const resolution = resolveRepositoryMemoryScope({
      workspaceRoot: workspace,
      baseUserId: "alice",
    }).finally(() => {
      settled = true;
    });
    let readStartTimeout;
    try {
      await Promise.race([
        readStarted,
        resolution.then(() => {
          throw new Error("scope resolution completed before the config read was intercepted");
        }),
        new Promise((_, rejectTimeout) => {
          readStartTimeout = setTimeout(
            () => rejectTimeout(new Error("scope resolution did not reach the config read")),
            1_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(readStartTimeout);
    }
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));

    assert.equal(settled, false);

    releaseRead();
    const result = await resolution;
    assert.equal(result.ok, true);
    assert.equal(result.scope.effectiveUserId, "alice@memorax-code");
  } finally {
    releaseRead();
    fsPromises.readFile = originalReadFile;
  }
});

test("linked worktrees share canonical common-dir identity and one session scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-workspace-worktrees-"));
  const home = join(root, "home");
  const main = join(root, "Project");
  const relativeWorktree = join(root, "Project-feature");
  const absoluteWorktree = join(root, "nested", "Project-review");
  const relativeNested = join(relativeWorktree, "src");
  const unrelated = join(root, "Unrelated");
  const commonDir = join(main, ".git");
  const relativeAdmin = join(commonDir, "worktrees", "feature");
  const absoluteAdmin = join(commonDir, "worktrees", "review");
  await createGitRepository(main, [
    ["upstream", "https://github.com/other/ignored.git"],
    ["origin", "https://u:p@example.test/owner/Project.git?x=1#fragment"],
  ]);
  await createWorktreeAdmin(relativeAdmin);
  await createWorktreeAdmin(absoluteAdmin);
  await mkdir(relativeNested, { recursive: true });
  await mkdir(absoluteWorktree, { recursive: true });
  await createGitRepository(unrelated, [
    ["origin", "https://github.com/example-org/Unrelated.git"],
  ]);
  await writeFile(
    join(relativeWorktree, ".git"),
    `gitdir: ${relative(relativeWorktree, relativeAdmin)}\r\n`,
    "utf8",
  );
  await writeFile(join(absoluteWorktree, ".git"), `gitdir: ${absoluteAdmin}\n`, "utf8");

  const mainScope = await resolveRepositoryMemoryScope({ workspaceRoot: main, baseUserId: "alice" });
  const relativeScope = await resolveRepositoryMemoryScope({
    workspaceRoot: relativeWorktree,
    baseUserId: "alice",
  });
  const absoluteScope = await resolveRepositoryMemoryScope({
    workspaceRoot: absoluteWorktree,
    baseUserId: "alice",
  });

  assert.equal(mainScope.ok, true);
  assert.equal(relativeScope.ok, true);
  assert.equal(absoluteScope.ok, true);
  assert.equal(mainScope.scope.effectiveUserId, "alice@Project");
  assert.equal(relativeScope.scope.effectiveUserId, mainScope.scope.effectiveUserId);
  assert.equal(absoluteScope.scope.effectiveUserId, mainScope.scope.effectiveUserId);
  assert.equal(relativeScope.scope.repositoryKey, mainScope.scope.repositoryKey);
  assert.equal(absoluteScope.scope.repositoryKey, mainScope.scope.repositoryKey);
  assert.equal(relativeScope.scope.identitySource, "origin-remote");
  assert.equal(relativeScope.scope.scopeKind, "git-repository");
  assert.equal(relativeScope.scope.boundWorkspaceRoot, await realpath(relativeWorktree));
  assert.equal(await repositoryMemoryScopeContainsWorkspace(mainScope.scope, relativeNested), true);
  assert.equal(await repositoryMemoryScopeContainsWorkspace(mainScope.scope, unrelated), false);

  const owner = {};
  const mainSession = await resolveConfiguredRepositoryMemoryForSession({
    owner,
    client: "codex",
    sessionId: "linked-worktree-session",
    workspaceRoot: main,
    memoraxCodeHome: home,
    env: memoryEnv(home),
  });
  const linkedSession = await resolveConfiguredRepositoryMemoryForSession({
    owner,
    client: "codex",
    sessionId: "linked-worktree-session",
    workspaceRoot: relativeWorktree,
    memoraxCodeHome: home,
    env: memoryEnv(home),
  });

  assert.equal(mainSession.ok, true);
  assert.equal(linkedSession.ok, true);
  assert.equal(linkedSession.memory.scope.effectiveUserId, mainSession.memory.scope.effectiveUserId);
  assert.equal(linkedSession.memory.scope.repositoryKey, mainSession.memory.scope.repositoryKey);
});

test("real Git linked worktrees resolve to one repository scope", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-workspace-real-worktree-"));
  const main = join(root, "Project");
  const linked = join(root, "Project-feature");
  await mkdir(main, { recursive: true });
  try {
    await execFileAsync("git", ["init", "--initial-branch=main", main]);
  } catch (error) {
    if (error?.code === "ENOENT") {
      t.skip("Git executable is unavailable for the integration fixture");
      return;
    }
    throw error;
  }
  await writeFile(join(main, "README.md"), "# fixture\n", "utf8");
  await execFileAsync("git", ["-C", main, "add", "README.md"]);
  await execFileAsync("git", ["-C", main, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"]);
  await execFileAsync("git", ["-C", main, "remote", "add", "origin", "https://example.test/owner/Project.git"]);
  await execFileAsync("git", ["-C", main, "worktree", "add", "-b", "feature", linked]);

  const mainScope = await resolveRepositoryMemoryScope({ workspaceRoot: main, baseUserId: "alice" });
  const linkedScope = await resolveRepositoryMemoryScope({ workspaceRoot: linked, baseUserId: "alice" });

  assert.equal(mainScope.ok, true);
  assert.equal(linkedScope.ok, true);
  assert.equal(mainScope.scope.effectiveUserId, "alice@Project");
  assert.equal(linkedScope.scope.effectiveUserId, mainScope.scope.effectiveUserId);
  assert.equal(linkedScope.scope.repositoryKey, mainScope.scope.repositoryKey);
  assert.equal(repositoryMemoryScopesMatch(mainScope.scope, linkedScope.scope), true);
});

test("repository naming uses origin, then a sole remote, then the canonical common directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-workspace-remote-selection-"));
  const originRepo = join(root, "origin-selection");
  const soleRepo = join(root, "sole-selection");
  const fallbackRepo = join(root, "Fallback-Repo");
  const includedConfig = join(root, "included.gitconfig");
  await createGitRepository(originRepo, [
    ["upstream", "git@github.com:other/upstream-name.git"],
    ["origin", "ssh://git@github.com/example-org/Origin-Name.git"],
  ]);
  await createGitRepository(soleRepo, [
    ["upstream", "git@github.com:example-org/Sole-Name.git"],
  ]);
  await writeFile(
    includedConfig,
    '[remote "origin"]\n\turl = https://github.com/ignored/Included-Name.git\n',
    "utf8",
  );
  await createGitRepository(
    fallbackRepo,
    [
      ["upstream", "https://github.com/one/First-Name.git"],
      ["backup", "https://github.com/two/Second-Name.git"],
    ],
    `[include]\n\tpath = ${includedConfig}\n`,
  );

  const origin = await resolveRepositoryMemoryScope({ workspaceRoot: originRepo, baseUserId: "alice" });
  const sole = await resolveRepositoryMemoryScope({ workspaceRoot: soleRepo, baseUserId: "alice" });
  const fallback = await resolveRepositoryMemoryScope({ workspaceRoot: fallbackRepo, baseUserId: "alice" });

  assert.equal(origin.ok, true);
  assert.equal(sole.ok, true);
  assert.equal(fallback.ok, true);
  assert.equal(origin.scope.effectiveUserId, "alice@Origin-Name");
  assert.equal(sole.scope.effectiveUserId, "alice@Sole-Name");
  assert.equal(fallback.scope.effectiveUserId, "alice@Fallback-Repo");
  assert.equal(origin.scope.identitySource, "origin-remote");
  assert.equal(sole.scope.identitySource, "origin-remote");
  assert.equal(fallback.scope.identitySource, "git-common-dir");
});

test("Git containment rechecks the readable repository name after a remote rename", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-workspace-remote-rename-"));
  const workspace = join(root, "workspace");
  await createGitRepository(workspace, [
    ["origin", "https://github.com/example-org/Before.git"],
  ]);
  const before = await resolveRepositoryMemoryScope({ workspaceRoot: workspace, baseUserId: "alice" });
  await createGitRepository(workspace, [
    ["origin", "https://github.com/example-org/After.git"],
  ]);
  const after = await resolveRepositoryMemoryScope({ workspaceRoot: workspace, baseUserId: "alice" });

  assert.equal(before.ok, true);
  assert.equal(after.ok, true);
  assert.equal(after.scope.repositoryKey, before.scope.repositoryKey);
  assert.equal(after.scope.effectiveUserId, "alice@After");
  assert.equal(await repositoryMemoryScopeContainsWorkspace(before.scope, workspace), false);
});

test("independent same-named clones share a namespace but remain distinct sticky session scopes", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-workspace-same-name-clones-"));
  const home = join(root, "home");
  const first = join(root, "first");
  const second = join(root, "second");
  await createGitRepository(first, [
    ["origin", "https://github.com/one/Shared.git"],
  ]);
  await createGitRepository(second, [
    ["origin", "https://github.com/two/Shared.git"],
  ]);
  const firstScope = await resolveRepositoryMemoryScope({ workspaceRoot: first, baseUserId: "alice" });
  const secondScope = await resolveRepositoryMemoryScope({ workspaceRoot: second, baseUserId: "alice" });
  const owner = {};
  const initial = await resolveConfiguredRepositoryMemoryForSession({
    owner,
    client: "codex",
    sessionId: "same-name-clones",
    workspaceRoot: first,
    memoraxCodeHome: home,
    env: memoryEnv(home),
  });
  const mismatch = await resolveConfiguredRepositoryMemoryForSession({
    owner,
    client: "codex",
    sessionId: "same-name-clones",
    workspaceRoot: second,
    memoraxCodeHome: home,
    env: memoryEnv(home),
  });

  assert.equal(firstScope.ok, true);
  assert.equal(secondScope.ok, true);
  assert.equal(firstScope.scope.effectiveUserId, "alice@Shared");
  assert.equal(secondScope.scope.effectiveUserId, firstScope.scope.effectiveUserId);
  assert.notEqual(secondScope.scope.repositoryKey, firstScope.scope.repositoryKey);
  assert.equal(repositoryMemoryScopesMatch(firstScope.scope, secondScope.scope), false);
  assert.equal(initial.ok, true);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, "workspace_scope_mismatch");
});

test("the nearest Git marker isolates nested repositories", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-workspace-nested-git-"));
  const outer = join(root, "outer");
  const nested = join(outer, "packages", "nested");
  const nestedSource = join(nested, "src");
  await createGitRepository(outer, [
    ["origin", "https://github.com/example-org/Outer.git"],
  ]);
  await createGitRepository(nested, [
    ["origin", "https://github.com/example-org/Nested.git"],
  ]);
  await mkdir(nestedSource, { recursive: true });

  const result = await resolveRepositoryMemoryScope({ workspaceRoot: nestedSource, baseUserId: "alice" });

  assert.equal(result.ok, true);
  assert.equal(result.scope.effectiveUserId, "alice@Nested");
  assert.equal(result.scope.boundWorkspaceRoot, await realpath(nested));
});

test("malformed or incomplete direct Git metadata falls back to the workspace folder scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-workspace-invalid-git-"));
  const emptyDirectory = join(root, "empty-directory");
  const malformedDirectory = join(root, "malformed-directory");
  await mkdir(join(emptyDirectory, ".git"), { recursive: true });
  await mkdir(join(malformedDirectory, ".git", "objects"), { recursive: true });
  await mkdir(join(malformedDirectory, ".git", "refs"), { recursive: true });
  await writeFile(join(malformedDirectory, ".git", "HEAD"), "not-a-ref\n", "utf8");

  for (const workspaceRoot of [emptyDirectory, malformedDirectory]) {
    const nested = join(workspaceRoot, "src");
    await mkdir(nested, { recursive: true });
    const result = await resolveRepositoryMemoryScope({ workspaceRoot: nested, baseUserId: "alice" });
    const workspaceName = workspaceRoot === emptyDirectory ? "empty-directory" : "malformed-directory";

    assert.equal(result.ok, true);
    assert.equal(result.scope.scopeKind, "local-directory");
    assert.equal(result.scope.identitySource, "workspace-directory");
    assert.equal(result.scope.repositorySlug, workspaceName);
    assert.equal(result.scope.effectiveUserId, `alice@${workspaceName}`);
    assert.equal(result.scope.fallbackReason, "git_metadata_invalid");
    assert.equal(result.scope.boundWorkspaceRoot, await realpath(workspaceRoot));
    assert.equal(await repositoryMemoryScopeContainsWorkspace(result.scope, nested), true);
  }
});

test("malformed Git pointer metadata remains fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-workspace-invalid-git-pointer-"));
  const malformedFile = join(root, "malformed-file");
  const missingTarget = join(root, "missing-target");
  const invalidCommonDir = join(root, "invalid-common-dir");
  const unusableName = join(root, "unusable-name");
  await mkdir(malformedFile, { recursive: true });
  await writeFile(join(malformedFile, ".git"), "gitdir: one\ngitdir: two\n", "utf8");
  await mkdir(missingTarget, { recursive: true });
  await writeFile(join(missingTarget, ".git"), "gitdir: ../does-not-exist\n", "utf8");
  const invalidAdmin = join(root, "admin");
  await mkdir(invalidAdmin, { recursive: true });
  await writeFile(join(invalidAdmin, "HEAD"), "ref: refs/heads/main\n", "utf8");
  await writeFile(join(invalidAdmin, "commondir"), "../missing-common-dir\n", "utf8");
  await mkdir(invalidCommonDir, { recursive: true });
  await writeFile(join(invalidCommonDir, ".git"), `gitdir: ${invalidAdmin}\n`, "utf8");
  const unnamedSource = join(root, "@@@");
  await createGitRepository(unnamedSource);
  await mkdir(unusableName, { recursive: true });
  await writeFile(join(unusableName, ".git"), `gitdir: ${join(unnamedSource, ".git")}\n`, "utf8");

  for (const workspaceRoot of [
    malformedFile,
    missingTarget,
    invalidCommonDir,
    unusableName,
  ]) {
    const result = await resolveRepositoryMemoryScope({ workspaceRoot, baseUserId: "alice" });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "workspace_scope_unavailable");
  }
});

test("a symlinked Git marker fails closed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-workspace-symlinked-git-marker-"));
  const source = join(root, "source");
  const workspace = join(root, "workspace");
  await createGitRepository(source, [
    ["origin", "https://github.com/example-org/source.git"],
  ]);
  await mkdir(workspace, { recursive: true });
  try {
    await symlink(
      join(source, ".git"),
      join(workspace, ".git"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip(`directory symlinks are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  const result = await resolveRepositoryMemoryScope({ workspaceRoot: workspace, baseUserId: "alice" });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "workspace_scope_unavailable");
});

test("unreadable Git marker and common config fail closed", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-workspace-unreadable-git-"));
  const separateSource = join(root, "separate-source");
  const separateWorkspace = join(root, "separate-workspace");
  const configWorkspace = join(root, "config-workspace");
  await createGitRepository(separateSource);
  await mkdir(separateWorkspace, { recursive: true });
  await writeFile(
    join(separateWorkspace, ".git"),
    `gitdir: ${join(separateSource, ".git")}\n`,
    "utf8",
  );
  await createGitRepository(configWorkspace, [
    ["origin", "https://github.com/example-org/config.git"],
  ]);
  const cases = [
    [separateWorkspace, join(separateWorkspace, ".git")],
    [configWorkspace, join(configWorkspace, ".git", "config")],
  ];
  let exercised = 0;

  for (const [workspaceRoot, protectedPath] of cases) {
    await chmod(protectedPath, 0o000);
    try {
      try {
        await readFile(protectedPath);
        continue;
      } catch (error) {
        if (error?.code !== "EACCES" && error?.code !== "EPERM") throw error;
      }
      exercised += 1;
      const result = await resolveRepositoryMemoryScope({ workspaceRoot, baseUserId: "alice" });
      assert.equal(result.ok, false);
      assert.equal(result.reason, "workspace_scope_unavailable");
    } finally {
      await chmod(protectedPath, 0o600);
    }
  }
  if (exercised === 0) t.skip("the current user can still read mode-000 files");
});

test("same-name non-Git workspaces share a MemoraX namespace but keep distinct physical bindings", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-workspace-collision-"));
  const first = join(root, "one", "demo");
  const second = join(root, "two", "demo");
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });

  const firstScope = await resolveRepositoryMemoryScope({ workspaceRoot: first, baseUserId: "alice" });
  const secondScope = await resolveRepositoryMemoryScope({ workspaceRoot: second, baseUserId: "alice" });

  assert.equal(firstScope.ok, true);
  assert.equal(secondScope.ok, true);
  assert.equal(firstScope.scope.effectiveUserId, "alice@demo");
  assert.equal(secondScope.scope.effectiveUserId, "alice@demo");
  assert.notEqual(firstScope.scope.repositoryKey, secondScope.scope.repositoryKey);
  assert.notEqual(firstScope.scope.boundWorkspaceRoot, secondScope.scope.boundWorkspaceRoot);
});

test("canonically equivalent folder paths remain distinct physical bindings when the filesystem permits", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-workspace-unicode-path-"));
  const composed = join(root, "caf\u00e9");
  const decomposed = join(root, "cafe\u0301");
  await mkdir(composed, { recursive: true });
  await mkdir(decomposed, { recursive: true });
  if (await realpath(composed) === await realpath(decomposed)) {
    t.skip("filesystem aliases canonically equivalent Unicode names");
    return;
  }

  const composedScope = await resolveRepositoryMemoryScope({ workspaceRoot: composed, baseUserId: "alice" });
  const decomposedScope = await resolveRepositoryMemoryScope({ workspaceRoot: decomposed, baseUserId: "alice" });

  assert.equal(composedScope.ok, true);
  assert.equal(decomposedScope.ok, true);
  assert.equal(composedScope.scope.effectiveUserId, decomposedScope.scope.effectiveUserId);
  assert.notEqual(composedScope.scope.repositoryKey, decomposedScope.scope.repositoryKey);
  assert.equal(repositoryMemoryScopesMatch(composedScope.scope, decomposedScope.scope), false);

  const home = join(root, "home");
  const env = memoryEnv(home);
  const owner = {};
  const initial = await resolveConfiguredRepositoryMemoryForSession({
    owner,
    client: "codex",
    sessionId: "unicode-path-session",
    workspaceRoot: composed,
    memoraxCodeHome: home,
    env,
  });
  const moved = await resolveConfiguredRepositoryMemoryForSession({
    owner,
    client: "codex",
    sessionId: "unicode-path-session",
    workspaceRoot: decomposed,
    memoraxCodeHome: home,
    env,
  });
  assert.equal(initial.ok, true);
  assert.equal(moved.ok, false);
  assert.equal(moved.reason, "workspace_scope_mismatch");
});

test("different non-Git workspace folder names use different MemoraX namespaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-workspace-separate-"));
  const main = join(root, "memorax-code");
  const worktree = join(root, "memorax-code-feature");
  await mkdir(main, { recursive: true });
  await mkdir(worktree, { recursive: true });

  const mainScope = await resolveRepositoryMemoryScope({ workspaceRoot: main, baseUserId: "alice" });
  const worktreeScope = await resolveRepositoryMemoryScope({ workspaceRoot: worktree, baseUserId: "alice" });

  assert.equal(mainScope.ok, true);
  assert.equal(worktreeScope.ok, true);
  assert.equal(mainScope.scope.effectiveUserId, "alice@memorax-code");
  assert.equal(worktreeScope.scope.effectiveUserId, "alice@memorax-code-feature");
});

test("explicit Codex projectless work keeps the fixed Codex-General namespace", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-workspace-projectless-"));
  const firstTask = join(root, "2026-07-13", "first-task");
  const secondTask = join(root, "2026-07-14", "second-task");
  await mkdir(firstTask, { recursive: true });
  await mkdir(secondTask, { recursive: true });

  const first = await resolveRepositoryMemoryScope({
    workspaceRoot: firstTask,
    workspaceKind: "projectless",
    baseUserId: "alice",
  });
  const second = await resolveRepositoryMemoryScope({
    workspaceRoot: secondTask,
    workspaceKind: "projectless",
    baseUserId: "alice",
  });
  const withoutPath = await resolveRepositoryMemoryScope({
    workspaceKind: "projectless",
    baseUserId: "alice",
  });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(withoutPath.ok, true);
  assert.equal(first.scope.effectiveUserId, "alice@Codex-General");
  assert.equal(second.scope.effectiveUserId, first.scope.effectiveUserId);
  assert.equal(withoutPath.scope.effectiveUserId, first.scope.effectiveUserId);
  assert.equal(first.scope.repositoryKey, second.scope.repositoryKey);
  assert.equal(second.scope.repositoryKey, withoutPath.scope.repositoryKey);
});

test("a real Codex-General folder intentionally shares the projectless namespace", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-workspace-projectless-collision-"));
  const workspace = join(root, "Codex-General");
  await mkdir(workspace, { recursive: true });

  const local = await resolveRepositoryMemoryScope({ workspaceRoot: workspace, baseUserId: "alice" });
  const projectless = await resolveRepositoryMemoryScope({ workspaceKind: "projectless", baseUserId: "alice" });

  assert.equal(local.ok, true);
  assert.equal(projectless.ok, true);
  assert.equal(local.scope.effectiveUserId, "alice@Codex-General");
  assert.equal(projectless.scope.effectiveUserId, local.scope.effectiveUserId);
  assert.notEqual(projectless.scope.repositoryKey, local.scope.repositoryKey);
});

test("workspace scope rejects missing roots and empty base user ids", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-workspace-invalid-"));

  const missing = await resolveRepositoryMemoryScope({
    workspaceRoot: join(root, "missing"),
    baseUserId: "alice",
  });
  const emptyUser = await resolveRepositoryMemoryScope({
    workspaceRoot: root,
    baseUserId: " ",
  });

  assert.equal(missing.ok, false);
  assert.equal(missing.reason, "workspace_scope_unavailable");
  assert.equal(emptyUser.ok, false);
  assert.equal(emptyUser.reason, "effective_user_id_invalid");
});

test("workspace containment accepts the bound root and nested directories only", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-workspace-containment-"));
  const workspace = join(root, "notes");
  const nested = join(workspace, "src");
  const sibling = join(root, "drafts");
  await mkdir(nested, { recursive: true });
  await mkdir(sibling, { recursive: true });
  const result = await resolveRepositoryMemoryScope({ workspaceRoot: workspace, baseUserId: "alice" });

  assert.equal(result.ok, true);
  assert.equal(await repositoryMemoryScopeContainsWorkspace(result.scope, workspace), true);
  assert.equal(await repositoryMemoryScopeContainsWorkspace(result.scope, nested), true);
  assert.equal(await repositoryMemoryScopeContainsWorkspace(result.scope, sibling), false);

  await createGitRepository(nested, [
    ["origin", "https://github.com/example-org/nested.git"],
  ]);
  assert.equal(await repositoryMemoryScopeContainsWorkspace(result.scope, nested), false);
});

test("a nested repository cannot reuse a cached local-directory session scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-workspace-local-nested-repo-"));
  const home = join(root, "home");
  const workspace = join(root, "notes");
  const nested = join(workspace, "nested");
  await mkdir(nested, { recursive: true });
  const owner = {};
  const initial = await resolveConfiguredRepositoryMemoryForSession({
    owner,
    client: "codex",
    sessionId: "local-to-nested-git",
    workspaceRoot: workspace,
    memoraxCodeHome: home,
    env: memoryEnv(home),
  });
  await createGitRepository(nested, [
    ["origin", "https://github.com/example-org/nested.git"],
  ]);
  const nestedTurn = await resolveConfiguredRepositoryMemoryForSession({
    owner,
    client: "codex",
    sessionId: "local-to-nested-git",
    workspaceRoot: nested,
    memoraxCodeHome: home,
    env: memoryEnv(home),
  });

  assert.equal(initial.ok, true);
  assert.equal(nestedTurn.ok, false);
  assert.equal(nestedTurn.reason, "workspace_scope_mismatch");
});

test("a non-Git session remains mismatched after its workspace becomes a repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-workspace-local-git-init-"));
  const home = join(root, "home");
  const workspace = join(root, "notes");
  const hiddenGitDir = join(workspace, ".git-disabled");
  await mkdir(workspace, { recursive: true });
  const owner = {};
  const env = memoryEnv(home);

  const initial = await resolveConfiguredRepositoryMemoryForSession({
    owner,
    client: "codex",
    sessionId: "local-to-git",
    workspaceRoot: workspace,
    memoraxCodeHome: home,
    env,
  });
  await createGitRepository(workspace, [
    ["origin", "https://github.com/example-org/notes.git"],
  ]);
  const repositoryTurn = await resolveConfiguredRepositoryMemoryForSession({
    owner,
    client: "codex",
    sessionId: "local-to-git",
    workspaceRoot: workspace,
    memoraxCodeHome: home,
    env,
  });
  await rename(join(workspace, ".git"), hiddenGitDir);
  const remainsBlocked = await resolveConfiguredRepositoryMemoryForSession({
    owner,
    client: "codex",
    sessionId: "local-to-git",
    workspaceRoot: workspace,
    memoraxCodeHome: home,
    env,
  });

  assert.equal(initial.ok, true);
  assert.equal(initial.memory.scope.scopeKind, "local-directory");
  assert.equal(initial.memory.scope.effectiveUserId, "alice@notes");
  assert.equal(repositoryTurn.ok, false);
  assert.equal(repositoryTurn.reason, "workspace_scope_mismatch");
  assert.equal(remainsBlocked.ok, false);
  assert.equal(remainsBlocked.reason, "workspace_scope_mismatch");
});

test("a non-Git session cannot silently acquire degraded Git fallback provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-workspace-local-degraded-git-"));
  const home = join(root, "home");
  const workspace = join(root, "notes");
  await mkdir(workspace, { recursive: true });
  const owner = {};
  const env = memoryEnv(home);

  const initial = await resolveConfiguredRepositoryMemoryForSession({
    owner,
    client: "codex",
    sessionId: "local-to-degraded-git",
    workspaceRoot: workspace,
    memoraxCodeHome: home,
    env,
  });
  await mkdir(join(workspace, ".git"), { recursive: true });
  const degradedTurn = await resolveConfiguredRepositoryMemoryForSession({
    owner,
    client: "codex",
    sessionId: "local-to-degraded-git",
    workspaceRoot: workspace,
    memoraxCodeHome: home,
    env,
  });
  const freshSession = await resolveConfiguredRepositoryMemoryForSession({
    owner,
    client: "codex",
    sessionId: "fresh-degraded-git",
    workspaceRoot: workspace,
    memoraxCodeHome: home,
    env,
  });

  assert.equal(initial.ok, true);
  assert.equal(initial.memory.scope.fallbackReason, undefined);
  assert.equal(degradedTurn.ok, false);
  assert.equal(degradedTurn.reason, "workspace_scope_mismatch");
  assert.equal(freshSession.ok, true);
  assert.equal(freshSession.memory.scope.fallbackReason, "git_metadata_invalid");
});

test("a degraded Git-directory session upgrades when Git metadata is repaired", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-workspace-degraded-git-repair-"));
  const home = join(root, "home");
  const workspace = join(root, "quant");
  const nested = join(workspace, "src");
  await mkdir(join(workspace, ".git"), { recursive: true });
  await mkdir(nested, { recursive: true });
  const owner = {};
  const env = memoryEnv(home);

  const initial = await resolveConfiguredRepositoryMemoryForSession({
    owner,
    client: "codex",
    sessionId: "degraded-to-git",
    workspaceRoot: workspace,
    memoraxCodeHome: home,
    env,
  });
  const nestedTurn = await resolveConfiguredRepositoryMemoryForSession({
    owner,
    client: "codex",
    sessionId: "degraded-to-git",
    workspaceRoot: nested,
    memoraxCodeHome: home,
    env,
  });
  await createGitRepository(workspace, [
    ["origin", "https://github.com/example-org/quant.git"],
  ]);
  const repairedTurn = await resolveConfiguredRepositoryMemoryForSession({
    owner,
    client: "codex",
    sessionId: "degraded-to-git",
    workspaceRoot: workspace,
    memoraxCodeHome: home,
    env,
  });

  assert.equal(initial.ok, true);
  assert.equal(initial.memory.scope.scopeKind, "local-directory");
  assert.equal(initial.memory.scope.fallbackReason, "git_metadata_invalid");
  assert.equal(initial.memory.scope.effectiveUserId, "alice@quant");
  assert.equal(nestedTurn.ok, true);
  assert.equal(nestedTurn.memory.scope.repositoryKey, initial.memory.scope.repositoryKey);
  assert.equal(repairedTurn.ok, true);
  assert.equal(repairedTurn.memory.scope.scopeKind, "git-repository");
  assert.equal(repairedTurn.memory.scope.fallbackReason, undefined);
  assert.equal(repairedTurn.memory.scope.effectiveUserId, "alice@quant");
  assert.equal(
    repositoryMemoryScopeCanUpgradeFromDegradedGit(initial.memory.scope, repairedTurn.memory.scope),
    true,
  );

  const subsequentTurn = await resolveConfiguredRepositoryMemoryForSession({
    owner,
    client: "codex",
    sessionId: "degraded-to-git",
    workspaceRoot: nested,
    memoraxCodeHome: home,
    env,
  });
  assert.equal(subsequentTurn.ok, true);
  assert.equal(subsequentTurn.memory.scope.repositoryKey, repairedTurn.memory.scope.repositoryKey);
});

test("case-distinct physical roots do not pass containment when the filesystem permits", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-workspace-case-path-"));
  const workspace = join(root, "CaseRoot");
  const other = join(root, "caseroot");
  const nestedOther = join(other, "nested");
  await mkdir(workspace, { recursive: true });
  await mkdir(nestedOther, { recursive: true });
  if (await realpath(workspace) === await realpath(other)) {
    t.skip("filesystem aliases case-distinct directory names");
    return;
  }

  const result = await resolveRepositoryMemoryScope({ workspaceRoot: workspace, baseUserId: "alice" });

  assert.equal(result.ok, true);
  assert.equal(await repositoryMemoryScopeContainsWorkspace(result.scope, nestedOther), false);
});

test("workspace scope follows symlinks to the canonical target and rejects symlink escape", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-workspace-symlink-"));
  const workspace = join(root, "actual-project");
  const outside = join(root, "outside");
  const workspaceLink = join(root, "workspace-link");
  const escapeLink = join(workspace, "escape");
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });
  try {
    await symlink(workspace, workspaceLink, process.platform === "win32" ? "junction" : "dir");
    await symlink(outside, escapeLink, process.platform === "win32" ? "junction" : "dir");
  } catch (error) {
    if (error?.code === "EPERM" || error?.code === "EACCES") {
      t.skip(`directory symlinks are unavailable: ${error.code}`);
      return;
    }
    throw error;
  }

  const direct = await resolveRepositoryMemoryScope({ workspaceRoot: workspace, baseUserId: "alice" });
  const throughLink = await resolveRepositoryMemoryScope({ workspaceRoot: workspaceLink, baseUserId: "alice" });

  assert.equal(direct.ok, true);
  assert.equal(throughLink.ok, true);
  assert.equal(throughLink.scope.effectiveUserId, "alice@actual-project");
  assert.equal(throughLink.scope.repositoryKey, direct.scope.repositoryKey);
  assert.equal(throughLink.scope.boundWorkspaceRoot, direct.scope.boundWorkspaceRoot);
  assert.equal(await repositoryMemoryScopeContainsWorkspace(direct.scope, escapeLink), false);
});

test("session binding reuses its workspace root from nested paths and sticks after a mismatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-workspace-session-"));
  const home = join(root, "home");
  const workspace = join(root, "notes");
  const nested = join(workspace, "src");
  const sibling = join(root, "drafts");
  await mkdir(nested, { recursive: true });
  await mkdir(sibling, { recursive: true });
  const env = memoryEnv(home);
  const owner = {};

  const initial = await resolveConfiguredRepositoryMemoryForSession({
    owner,
    client: "codex",
    sessionId: "session-1",
    workspaceRoot: workspace,
    memoraxCodeHome: home,
    env,
  });
  const nestedTurn = await resolveConfiguredRepositoryMemoryForSession({
    owner,
    client: "codex",
    sessionId: "session-1",
    workspaceRoot: nested,
    memoraxCodeHome: home,
    env,
  });
  const mismatch = await resolveConfiguredRepositoryMemoryForSession({
    owner,
    client: "codex",
    sessionId: "session-1",
    workspaceRoot: sibling,
    memoraxCodeHome: home,
    env,
  });
  const stillBlocked = await resolveConfiguredRepositoryMemoryForSession({
    owner,
    client: "codex",
    sessionId: "session-1",
    workspaceRoot: workspace,
    memoraxCodeHome: home,
    env,
  });

  assert.equal(initial.ok, true);
  assert.equal(initial.memory.scope.effectiveUserId, "alice@notes");
  assert.equal(nestedTurn.ok, true);
  assert.equal(nestedTurn.memory.scope.repositoryKey, initial.memory.scope.repositoryKey);
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, "workspace_scope_mismatch");
  assert.equal(stillBlocked.ok, false);
  assert.equal(stillBlocked.reason, "workspace_scope_mismatch");
});

test("projectless and real Codex-General scopes cannot be exchanged inside a session", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-workspace-projectless-session-"));
  const home = join(root, "home");
  const projectlessWorkspace = join(root, "task");
  const realWorkspace = join(root, "Codex-General");
  await mkdir(projectlessWorkspace, { recursive: true });
  await mkdir(realWorkspace, { recursive: true });
  const env = memoryEnv(home);
  const owner = {};

  const projectless = await resolveConfiguredRepositoryMemoryForSession({
    owner,
    client: "codex",
    sessionId: "projectless-session",
    workspaceRoot: projectlessWorkspace,
    workspaceKind: "projectless",
    memoraxCodeHome: home,
    env,
  });
  const movedToRealWorkspace = await resolveConfiguredRepositoryMemoryForSession({
    owner,
    client: "codex",
    sessionId: "projectless-session",
    workspaceRoot: realWorkspace,
    workspaceKind: "project",
    memoraxCodeHome: home,
    env,
  });
  const remainsBlocked = await resolveConfiguredRepositoryMemoryForSession({
    owner,
    client: "codex",
    sessionId: "projectless-session",
    workspaceRoot: projectlessWorkspace,
    workspaceKind: "projectless",
    memoraxCodeHome: home,
    env,
  });

  assert.equal(projectless.ok, true);
  assert.equal(projectless.memory.scope.effectiveUserId, "alice@Codex-General");
  assert.equal(movedToRealWorkspace.ok, false);
  assert.equal(movedToRealWorkspace.reason, "workspace_scope_mismatch");
  assert.equal(remainsBlocked.ok, false);
  assert.equal(remainsBlocked.reason, "workspace_scope_mismatch");

  const reverseOwner = {};
  const real = await resolveConfiguredRepositoryMemoryForSession({
    owner: reverseOwner,
    client: "codex",
    sessionId: "real-session",
    workspaceRoot: realWorkspace,
    memoraxCodeHome: home,
    env,
  });
  const movedToProjectless = await resolveConfiguredRepositoryMemoryForSession({
    owner: reverseOwner,
    client: "codex",
    sessionId: "real-session",
    workspaceRoot: projectlessWorkspace,
    workspaceKind: "projectless",
    memoraxCodeHome: home,
    env,
  });

  assert.equal(real.ok, true);
  assert.equal(real.memory.scope.effectiveUserId, "alice@Codex-General");
  assert.equal(movedToProjectless.ok, false);
  assert.equal(movedToProjectless.reason, "workspace_scope_mismatch");
});

test("same-name physical workspaces cannot bypass session pinning", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-workspace-same-name-session-"));
  const home = join(root, "home");
  const first = join(root, "one", "demo");
  const second = join(root, "two", "demo");
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  const env = memoryEnv(home);
  const owner = {};

  const initial = await resolveConfiguredRepositoryMemoryForSession({
    owner,
    client: "codex",
    sessionId: "same-name-session",
    workspaceRoot: first,
    memoraxCodeHome: home,
    env,
  });
  const mismatch = await resolveConfiguredRepositoryMemoryForSession({
    owner,
    client: "codex",
    sessionId: "same-name-session",
    workspaceRoot: second,
    memoraxCodeHome: home,
    env,
  });

  assert.equal(initial.ok, true);
  assert.equal(initial.memory.scope.effectiveUserId, "alice@demo");
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, "workspace_scope_mismatch");
});

test("Codex and Claude can bind the same session id independently across same-name non-Git scopes", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-workspace-client-session-"));
  const home = join(root, "home");
  const codexWorkspace = join(root, "codex", "demo");
  const claudeWorkspace = join(root, "claude", "demo");
  await mkdir(codexWorkspace, { recursive: true });
  await mkdir(claudeWorkspace, { recursive: true });
  const env = memoryEnv(home);
  const owner = {};

  const codex = await resolveConfiguredRepositoryMemoryForSession({
    owner,
    client: "codex",
    sessionId: "shared-session",
    workspaceRoot: codexWorkspace,
    memoraxCodeHome: home,
    env,
  });
  const claude = await resolveConfiguredRepositoryMemoryForSession({
    owner,
    client: "claude-code",
    sessionId: "shared-session",
    workspaceRoot: claudeWorkspace,
    memoraxCodeHome: home,
    env,
  });

  assert.equal(codex.ok, true);
  assert.equal(claude.ok, true);
  assert.equal(codex.memory.scope.effectiveUserId, "alice@demo");
  assert.equal(claude.memory.scope.effectiveUserId, codex.memory.scope.effectiveUserId);
  assert.notEqual(claude.memory.scope.repositoryKey, codex.memory.scope.repositoryKey);
});

test("concurrent first session bindings accept one workspace and reject the other", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-workspace-concurrent-session-"));
  const home = join(root, "home");
  const first = join(root, "first");
  const second = join(root, "second");
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  const env = memoryEnv(home);
  const owner = {};

  const results = await Promise.all([first, second].map((workspaceRoot) => (
    resolveConfiguredRepositoryMemoryForSession({
      owner,
      client: "codex",
      sessionId: "concurrent-session",
      workspaceRoot,
      memoraxCodeHome: home,
      env,
    })
  )));

  assert.equal(results.filter((result) => result.ok).length, 1);
  assert.deepEqual(
    results.filter((result) => !result.ok).map((result) => result.reason),
    ["workspace_scope_mismatch"],
  );
});

test("renaming a non-Git workspace creates a new namespace and invalidates the old session binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-workspace-rename-"));
  const home = join(root, "home");
  const original = join(root, "demo");
  const renamed = join(root, "renamed");
  await mkdir(original, { recursive: true });
  const env = memoryEnv(home);
  const owner = {};

  const initial = await resolveConfiguredRepositoryMemoryForSession({
    owner,
    client: "codex",
    sessionId: "old-session",
    workspaceRoot: original,
    memoraxCodeHome: home,
    env,
  });
  await rename(original, renamed);
  const oldSession = await resolveConfiguredRepositoryMemoryForSession({
    owner,
    client: "codex",
    sessionId: "old-session",
    workspaceRoot: renamed,
    memoraxCodeHome: home,
    env,
  });
  const newSession = await resolveConfiguredRepositoryMemoryForSession({
    owner,
    client: "codex",
    sessionId: "new-session",
    workspaceRoot: renamed,
    memoraxCodeHome: home,
    env,
  });

  assert.equal(initial.ok, true);
  assert.equal(initial.memory.scope.effectiveUserId, "alice@demo");
  assert.equal(oldSession.ok, false);
  assert.equal(oldSession.reason, "workspace_scope_mismatch");
  assert.equal(newSession.ok, true);
  assert.equal(newSession.memory.scope.effectiveUserId, "alice@renamed");
});

function memoryEnv(home) {
  return {
    MEMORAX_CODE_HOME: home,
    MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
    MEMORAX_CODE_MEMORAX_API_KEY: "secret",
    MEMORAX_CODE_MEMORAX_USER_ID: "alice",
  };
}

async function createGitRepository(workspace, remotes = [], extraConfig = "") {
  const gitDir = join(workspace, ".git");
  await mkdir(join(gitDir, "objects"), { recursive: true });
  await mkdir(join(gitDir, "refs", "heads"), { recursive: true });
  await writeFile(join(gitDir, "HEAD"), "ref: refs/heads/main\n", "utf8");
  const remoteConfig = remotes.map(([name, url]) => (
    `[remote "${name}"]\n\turl = "${url.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"\n`
  )).join("");
  await writeFile(
    join(gitDir, "config"),
    `[core]\n\trepositoryformatversion = 0\n${extraConfig}${remoteConfig}`,
    "utf8",
  );
}

async function createWorktreeAdmin(adminDir) {
  await mkdir(adminDir, { recursive: true });
  await writeFile(join(adminDir, "HEAD"), "ref: refs/heads/main\n", "utf8");
  await writeFile(join(adminDir, "commondir"), "../..\r\n", "utf8");
}
