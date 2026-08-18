import { strict as assert } from "node:assert";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = join(packageRoot, "skills");
const skillRoot = join(skillsRoot, "memorax-code");

function readSkillFile(path) {
  return readFileSync(join(skillRoot, path), "utf8");
}

test("memorax-code is the single progressive router for all memory authorities", () => {
  const skill = readSkillFile("SKILL.md");

  assert.match(skill, /name: memorax-code/);
  assert.match(skill, /^# MemoraX Code$/m);
  assert.match(skill, /## Authority Router/);
  assert.match(skill, /### MemoraX Code Coding Memory/);
  assert.match(skill, /### Repo Memory/);
  assert.match(skill, /### Personal Memory/);
  assert.match(skill, /Classify the requested memory authority first, then its operation/);
  assert.match(skill, /Ask one focused question when the target remains ambiguous/);
  assert.match(skill, /current-task instructions and temporary plans/);
  assert.match(skill, /Do not call MemoraX HTTP endpoints directly/);
  assert.match(skill, /Invoke this skill as `\$memorax-code` in Codex or `\/memorax-code` in Claude Code/);
  assert.match(skill, /In OpenCode, ask the agent to use the `memorax-code` skill by name/);
  assert.match(skill, /`memorax-code` is the lifecycle CLI and must not be used for memory search or add/);

  for (const reference of [
    "references/memorax-search.md",
    "references/memorax-add.md",
    "references/repo-read.md",
    "references/repo-build.md",
    "references/repo-update.md",
    "references/repo-templates.md",
    "references/personal-read.md",
    "references/personal-write.md",
  ]) {
    assert.equal(existsSync(join(skillRoot, reference)), true, `${reference} should exist`);
    assert.match(skill, new RegExp(reference.replaceAll(".", "\\.")));
  }
});

test("memorax-code removes competing top-level memory skill entries", () => {
  const skillDirectories = readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skillsRoot, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual(skillDirectories, ["memorax-code"]);
});

test("memorax-code references keep authority and operation boundaries explicit", () => {
  const memoraxSearch = readSkillFile("references/memorax-search.md");
  const memoraxAdd = readSkillFile("references/memorax-add.md");
  const repoRead = readSkillFile("references/repo-read.md");
  const repoBuild = readSkillFile("references/repo-build.md");
  const repoUpdate = readSkillFile("references/repo-update.md");
  const personalRead = readSkillFile("references/personal-read.md");
  const personalWrite = readSkillFile("references/personal-write.md");

  assert.match(memoraxSearch, /memorax-cli search/);
  assert.match(memoraxSearch, /In OpenCode, ask the agent to use the `memorax-code` skill by name/);
  assert.match(memoraxSearch, /Run up to two focused first-round searches/);
  assert.match(memoraxSearch, /only when a second independent fact can change the action/);
  assert.match(memoraxSearch, /Do not call MemoraX HTTP endpoints directly/);
  assert.match(memoraxSearch, /memorax-cli search --query '/);
  assert.match(memoraxSearch, /Linked worktrees share one repository scope/);
  assert.match(memoraxSearch, /without executing Git/);
  assert.match(memoraxSearch, /genuine non-Git directories/);
  assert.match(memoraxSearch, /linked worktree of the bound repository is valid/);
  assert.match(memoraxSearch, /`workspace_scope_mismatch` or `workspace_scope_unavailable`/);
  assert.match(memoraxSearch, /search was not executed and no request was sent to MemoraX/);
  assert.match(memoraxSearch, /present the CLI's `userAction`/);
  assert.match(memoraxSearch, /Do not change the CLI working directory and retry/);
  assert.match(memoraxSearch, /`workspaceScopeFallbackReason: git_metadata_invalid`/);
  assert.match(memoraxSearch, /Present its `userNotice` once without pausing the current task/);
  assert.doesNotMatch(memoraxSearch, /--query-file/);
  assert.match(memoraxAdd, /CODE_AGENT_MEMORY/);
  assert.match(memoraxAdd, /In OpenCode, ask the agent to use the `memorax-code` skill by name/);
  assert.match(memoraxAdd, /Route user-owned ordered actions/);
  assert.match(memoraxAdd, /For a proactive add, write all generated prose/);
  assert.match(memoraxAdd, /language of the user's current request/);
  assert.match(memoraxAdd, /preserve exact code, API, path, workflow, and project identifiers/);
  assert.match(memoraxAdd, /memorax-cli add[\s\S]*--memory '/);
  assert.match(memoraxAdd, /`workspace_scope_mismatch` or `workspace_scope_unavailable`/);
  assert.match(memoraxAdd, /memory was not submitted and no request was sent to MemoraX/);
  assert.match(memoraxAdd, /present the CLI's `userAction`/);
  assert.match(memoraxAdd, /Do not change the CLI working directory and retry/);
  assert.match(memoraxAdd, /`workspaceScopeFallbackReason: git_metadata_invalid`/);
  assert.match(memoraxAdd, /Present its `userNotice` once without pausing the current task/);
  assert.doesNotMatch(memoraxAdd, /--memory-file/);
  assert.match(repoRead, /## Retrieval Budget/);
  assert.match(repoRead, /Do not read repo memory again after `maintain` returns/);
  assert.match(repoRead, /Current implementation claims and code edits still require live-code verification/);
  assert.match(repoBuild, /first-time creation, full rebuilds, or full refreshes/);
  assert.match(repoBuild, /scripts\/collect_all\.py/);
  assert.match(repoUpdate, /Update existing repo memory from a delta/);
  assert.match(repoUpdate, /scripts\/detect_updates\.py/);
  assert.match(personalRead, /Do not write, normalize, migrate, repair, or delete memory/);
  assert.match(personalRead, /how the coding agent should interact with the user/);
  assert.match(personalWrite, /Require the user to explicitly ask/);
  assert.match(personalWrite, /may be saved implicitly/);
});

test("memorax-code search guidance preserves semantic roles and exact anchors", () => {
  const memoraxSearch = readSkillFile("references/memorax-search.md");

  assert.match(memoraxSearch, /one short natural-language question or intent statement, not a keyword list/);
  assert.match(memoraxSearch, /instead of copying or concatenating nouns from the prompt/);
  assert.match(memoraxSearch, /Follow the user's language/);
  assert.match(memoraxSearch, /Retain at least one distinctive noun phrase/);
  assert.match(memoraxSearch, /observed symptom, desired outcome, disputed field or hypothesis, or explicit exclusion/);
  assert.match(memoraxSearch, /every query must use this visible shape/);
  assert.match(memoraxSearch, /one or two stable exact identifiers/);
  assert.match(memoraxSearch, /integrate them grammatically/);
  assert.match(memoraxSearch, /do not shorten them into ungrammatical fragments/);

  assert.match(memoraxSearch, /Trace producer version: after an upgrade/);
  assert.match(memoraxSearch, /Task context after upgrade: can an already-open task keep old injected context/);
  assert.match(memoraxSearch, /Desktop SDK authority: without a native CLI/);
});

test("memorax-code retries read-only search once after transport or sandbox failure", () => {
  const memoraxSearch = readSkillFile("references/memorax-search.md");

  assert.match(memoraxSearch, /`fetch failed`/);
  assert.match(memoraxSearch, /retry the same `memorax-cli search` once/);
  assert.match(memoraxSearch, /approved network-enabled execution mode/);
  assert.match(memoraxSearch, /Preserve the same query, workspace, and environment variables/);
  assert.match(memoraxSearch, /Do not apply this retry to `memorax-cli add`/);
  assert.match(memoraxSearch, /authentication or configuration failures, or HTTP errors/);
  assert.match(memoraxSearch, /If no approved mode[\s\S]*report the exact CLI failure/);
});

test("memorax-code uses POSIX-safe direct CLI arguments", () => {
  const memoraxSearch = readSkillFile("references/memorax-search.md");
  const memoraxAdd = readSkillFile("references/memorax-add.md");
  const guidance = `${memoraxSearch}\n${memoraxAdd}`;

  assert.match(memoraxSearch, /dynamically generated query in single quotes, never double quotes/);
  assert.match(memoraxAdd, /dynamically generated `--memory` and `--reason` value in single quotes, never double quotes/);
  assert.match(guidance, /Treat `\$HOME`, backticks, and `\$\(command\)` as literal text/);
  assert.match(guidance, /exact POSIX sequence/);
});

test("memorax-code declares OpenAI and Claude implicit invocation metadata", () => {
  const openaiYaml = readSkillFile("agents/openai.yaml");
  const claudeYaml = readSkillFile("agents/claude.yaml");

  assert.match(openaiYaml, /display_name: "MemoraX Code"/);
  assert.match(openaiYaml, /Route coding, repo, and personal memory/);
  assert.match(openaiYaml, /Use \$memorax-code to route/);
  assert.match(openaiYaml, /allow_implicit_invocation: true/);

  assert.match(claudeYaml, /display_name: "MemoraX Code"/);
  assert.match(claudeYaml, /Use \/memorax-code-claude-adapter:memorax-code to route/);
  assert.doesNotMatch(claudeYaml, /Use \/memorax-code to route/);
  assert.match(claudeYaml, /~\/\.claude\/skills\/memorax-code/);
  assert.match(claudeYaml, /allow_implicit_invocation: true/);
});
