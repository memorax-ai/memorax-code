import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildRepoUserProfilePreferencesContext } from "../src/repo-memory/repo-user-profile-context.mjs";

const PERSONAL_MEMORY_CONTEXT_OPTIONS = {
  adapterDir: "codex",
  debugEnv: "MEMORAX_CODE_CODEX_HOOK_DEBUG",
  sessionKeyPrefix: "codex",
};

test("tracked unignored symlinked oversized and invalid preference files fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-user-profile-context-untrusted-"));
  const cases = [
    ["tracked", async (repo) => runGit(repo, ["add", "-f", ".repo_memory/user-profile/preferences.md"])],
    ["unignored", async (repo) => writeFile(join(repo, ".gitignore"), "node_modules/\n")],
    ["symlinked", async (repo, path) => {
      const target = join(repo, ".repo_memory", "user-profile", "preferences-target.md");
      await rename(path, target);
      await symlink(target, path);
    }],
    ["symlinked-parent", async (repo, path) => {
      const directory = dirname(path);
      const target = join(repo, "user-profile-target");
      await rename(directory, target);
      await symlink(target, directory);
    }],
    ["oversized", async (_repo, path) => writeFile(path, "x".repeat((64 * 1024) + 1))],
    ["invalid", async (_repo, path) => writeFile(path, "# invalid preferences\n")],
  ];

  try {
    for (const [name, mutate] of cases) {
      const repo = await createRepo(root, name);
      await writePreferences(repo, [preference(`pref_${name}`, `${name} must not appear`, "always", "never")]);
      const path = join(repo, ".repo_memory", "user-profile", "preferences.md");
      await mutate(repo, path);
      assert.equal(buildRepoUserProfilePreferencesContext({ cwd: repo }, PERSONAL_MEMORY_CONTEXT_OPTIONS), undefined, name);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("preference context contains only active fields and remains bounded", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-user-profile-context-limit-"));
  try {
    const repo = await createRepo(root, "limit");
    const entries = Array.from({ length: 30 }, (_, index) => preference(
      `pref_${index}`,
      `preference-${index} ${"detail ".repeat(30)}`,
      `scope-${index}`,
      `exception-${index}`,
    ));
    entries.push({
      ...preference("pref_deleted", "deleted preference must not appear", "always", "never"),
      status: "deleted",
    });
    await writePreferences(repo, entries);

    const context = buildRepoUserProfilePreferencesContext({ cwd: repo }, PERSONAL_MEMORY_CONTEXT_OPTIONS);
    assert.ok(context);
    assert.ok(context.length <= 4000);
    assert.match(context, /Description: preference-0/);
    assert.match(context, /Applies when: scope-0/);
    assert.match(context, /Do not apply when: exception-0/);
    assert.doesNotMatch(context, /pref_0/);
    assert.doesNotMatch(context, /deleted preference must not appear/);
    assert.match(context, /Additional user preferences were omitted/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function preference(id, description, appliesWhen, doNotApplyWhen) {
  return { id, type: "communication", status: "active", description, appliesWhen, doNotApplyWhen };
}

async function writePreferences(repo, entries) {
  const directory = join(repo, ".repo_memory", "user-profile");
  await mkdir(directory, { recursive: true });
  await writeFile(join(repo, ".gitignore"), ".repo_memory/\n");
  const blocks = entries.map((entry) => [
    `## Preference ${entry.id}`,
    "",
    `- Type: \`${entry.type}\``,
    `- Status: \`${entry.status}\``,
    "- Confidence: `user_stated`",
    "- Created: `2026-07-18T00:00:00.000Z`",
    "- Updated: `2026-07-18T00:00:00.000Z`",
    `- Description: ${entry.description}`,
    `- Applies when: ${entry.appliesWhen}`,
    `- Do not apply when: ${entry.doNotApplyWhen}`,
    `- Raw lookup: \`preferenceId=${entry.id}\``,
  ].join("\n"));
  await writeFile(join(directory, "preferences.md"), [
    "---",
    'schema: "repo_user_profile_memory.v0.1"',
    'scope: "repo"',
    'owner: "repo-user-profile-memory"',
    'trust_state: "user_stated"',
    'updated_at: "2026-07-18T00:00:00.000Z"',
    `active_count: ${entries.filter((entry) => entry.status === "active").length}`,
    `total_count: ${entries.length}`,
    "---",
    "",
    blocks.join("\n\n---\n\n"),
    "",
  ].join("\n"));
}

async function createRepo(root, name) {
  const repo = join(root, `repo-${name}`);
  await mkdir(repo);
  runGit(repo, ["init", "-b", "main"]);
  await writeFile(join(repo, "README.md"), "# Test repo\n");
  runGit(repo, ["add", "README.md"]);
  runGit(repo, ["commit", "-m", "initial docs"]);
  return repo;
}

function runGit(cwd, args) {
  const result = spawnSync(
    "git",
    ["-c", "user.name=Profile Test", "-c", "user.email=profile-test@example.invalid", ...args],
    { cwd, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
}
