import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../packages/ts/memorax-code-codex-adapter");
const skillRoot = join(packageRoot, "skills", "memorax-code");

function readSkill(path) {
  return readFileSync(join(skillRoot, path), "utf8").replace(/\s+/g, " ");
}

test("memorax-code routes global personal procedure reads and writes", () => {
  const router = readSkill("SKILL.md");
  const readReference = readSkill("references/personal-read.md");
  const writeReference = readSkill("references/personal-write.md");

  assert.match(router, /ordered actions, checklists, prerequisites, gates, exceptions, and validation rules/);
  assert.match(router, /personal procedure write/);
  assert.match(router, /\$MEMORAX_CODE_HOME\/personal-memory/);
  assert.match(router, /Procedure Memory writes require an explicit request/);
  assert.match(router, /durable User Profile preference may be saved implicitly/);
  assert.match(readReference, /\$MEMORAX_CODE_HOME\/personal-memory\/procedure-memory\//);
  assert.match(readReference, /user_profile_memory\.v0\.1/);
  assert.match(readReference, /scope `user`/);
  assert.match(readReference, /owner `user-profile-memory`/);
  assert.match(readReference, /--home <memorax-code-home>/);
  assert.match(readReference, /do not require Git, a repository root, or a worktree/);
  assert.match(readReference, /no global procedure file, semantic index/);
  assert.match(readReference, /do not create it during a read/);
  assert.match(readReference, /Do not write, normalize, migrate, repair, or delete memory/);

  assert.match(writeReference, /Require the user to explicitly ask/);
  assert.match(writeReference, /A durable preference may be saved implicitly/);
  assert.match(writeReference, /\$MEMORAX_CODE_HOME\/personal-memory\/procedure-memory\//);
  assert.match(writeReference, /user_profile_memory\.v0\.1/);
  assert.match(writeReference, /scope `user`/);
  assert.match(writeReference, /owner `user-profile-memory`/);
  assert.match(writeReference, /--home <memorax-code-home>/);
  assert.match(writeReference, /each procedure topic in its own concise kebab-case Markdown file/);
  assert.match(writeReference, /Do not create a global procedures file, index/);
  assert.match(writeReference, /Do not persist current-task instructions or temporary plans/);
  assert.match(writeReference, /Choose the closest existing topic file before writing/);
  assert.match(writeReference, /New topic: create a file/);
  assert.match(writeReference, /Addition or refinement to the same topic: update the existing file/);
  assert.match(writeReference, /directly conflicts with or replaces an old rule: update the existing file and remove the superseded content/);
  assert.match(writeReference, /command, file, or workflow that no longer exists: update the invalid part; delete the file if the entire procedure is obsolete/);
  assert.match(writeReference, /Equivalent content: do not add a duplicate/);
  assert.match(writeReference, /unclear whether the change is durable or only applies to the current task: ask the user/);
  assert.match(writeReference, /Do not modify existing memory because of a one-time instruction/);
  assert.match(writeReference, /Do not scan or clean up unrelated topics/);
  assert.match(writeReference, /Delete only the topic file, section, or step the user explicitly identifies/);
  assert.match(writeReference, /preserve unrelated content/);
  assert.match(writeReference, /Do not retain deleted text in tombstones/);
  assert.match(writeReference, /Apply the same rule to superseded text/);
  assert.doesNotMatch(readReference, /--repo/);
  assert.doesNotMatch(writeReference, /--repo/);
  assert.doesNotMatch(readReference, /<repo>\/\.repo_memory\/procedure-memory/);
  assert.doesNotMatch(writeReference, /<repo>\/\.repo_memory\/user-profile/);
});
