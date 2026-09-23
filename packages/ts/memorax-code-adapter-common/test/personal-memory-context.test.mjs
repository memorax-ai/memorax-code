import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { buildProcedureMemoryContext } from "../src/personal-memory/procedure-memory-context.mjs";
import { buildUserProfilePreferencesContext } from "../src/personal-memory/user-profile-context.mjs";

const PERSONAL_MEMORY_CONTEXT_OPTIONS = {
  adapterDir: "codex",
  debugEnv: "MEMORAX_CODE_CODEX_HOOK_DEBUG",
  sessionKeyPrefix: "codex",
};

test("symlinked oversized and invalid global preference files fail closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-user-profile-context-untrusted-"));
  const cases = [
    ["symlinked", async (repo, path) => {
      const target = join(repo, "personal-memory", "user-profile", "preferences-target.md");
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
    ["blank-description", async (repo) => writePreferences(repo, [
      preference("pref_blank", " \t", "this must not become the description", "never"),
    ])],
  ];

  try {
    for (const [name, mutate] of cases) {
      const repo = await createRepo(root, name);
      await writePreferences(repo, [preference(`pref_${name}`, `${name} must not appear`, "always", "never")]);
      const path = join(repo, "personal-memory", "user-profile", "preferences.md");
      await mutate(repo, path);
      assert.equal(buildUserProfilePreferencesContext({ ...PERSONAL_MEMORY_CONTEXT_OPTIONS, memoraxCodeHome: repo }), undefined, name);
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

    const context = buildUserProfilePreferencesContext({ ...PERSONAL_MEMORY_CONTEXT_OPTIONS, memoraxCodeHome: repo });
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
  const directory = join(repo, "personal-memory", "user-profile");
  await mkdir(directory, { recursive: true });
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
    'schema: "user_profile_memory.v0.1"',
    'scope: "user"',
    'owner: "user-profile-memory"',
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
  const home = join(root, `home-${name}`);
  await mkdir(home);
  return home;
}

test("only configured global memory is read, regardless of workspace or legacy files", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-global-memory-home-"));
  try {
    const home = join(root, "home");
    await writePreferences(home, [preference("pref_global", "Use concise answers.", "always", "never")]);
    const procedures = join(home, "personal-memory", "procedure-memory");
    await mkdir(procedures);
    await writeFile(join(procedures, "testing.md"), "# Testing\nRun the focused tests.");
    for (const workspace of ["repo-a", "non-git"]) {
      const cwd = join(root, workspace);
      await mkdir(join(cwd, ".repo_memory", "user-profile"), { recursive: true });
      await writeFile(join(cwd, ".repo_memory", "user-profile", "preferences.md"), "legacy memory must be ignored");
      const options = { memoraxCodeHome: home, cwd };
      assert.match(buildUserProfilePreferencesContext(options), /Use concise answers/);
      assert.match(buildProcedureMemoryContext(options), /Run the focused tests/);
      assert.equal(buildUserProfilePreferencesContext({ ...options, memoraxCodeHome: join(root, "empty-home") }), undefined);
      assert.equal(buildProcedureMemoryContext({ ...options, memoraxCodeHome: join(root, "empty-home") }), undefined);
    }
    const profile = join(home, "personal-memory", "user-profile", "preferences.md");
    const content = await readFile(profile, "utf8");
    await writeFile(profile, content.replace("user_profile_memory.v0.1", "repo_user_profile_memory.v0.1"));
    assert.equal(buildUserProfilePreferencesContext({ memoraxCodeHome: home }), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("both readers resolve MEMORAX_CODE_HOME when no explicit home is supplied", async () => {
  const home = await mkdtemp(join(tmpdir(), "memorax-global-memory-default-"));
  const previous = process.env.MEMORAX_CODE_HOME;
  try {
    await writePreferences(home, [preference("pref_env", "Read configured home.", "always", "never")]);
    const directory = join(home, "personal-memory", "procedure-memory");
    await mkdir(directory);
    await writeFile(join(directory, "testing.md"), "# Testing\nUse configured home.");
    process.env.MEMORAX_CODE_HOME = home;
    assert.match(buildUserProfilePreferencesContext(), /Read configured home/);
    assert.match(buildProcedureMemoryContext(), /Use configured home/);
    assert.equal(buildUserProfilePreferencesContext({ memoraxCodeHome: join(home, "other") }), undefined);
    assert.equal(buildProcedureMemoryContext({ memoraxCodeHome: join(home, "other") }), undefined);
  } finally {
    if (previous === undefined) delete process.env.MEMORAX_CODE_HOME;
    else process.env.MEMORAX_CODE_HOME = previous;
    await rm(home, { recursive: true, force: true });
  }
});
