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
  assert.match(memoraxSearch, /successful Search returns `quotaNotice`/);
  assert.match(memoraxSearch, /present the complete reminder once and prominently/);
  assert.match(memoraxSearch, /Do not reduce it to only a percentage/);
  assert.match(memoraxSearch, /Never run `memorax-code account --show-mark-id` for the user/);
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
  assert.match(memoraxAdd, /successful Add returns `quotaNotice`/);
  assert.match(memoraxAdd, /present the complete reminder once and prominently/);
  assert.match(memoraxAdd, /Do not reduce it to only a percentage/);
  assert.match(memoraxAdd, /Never run `memorax-code account --show-mark-id` for the user/);
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

test("memorax-code reports only material current-turn memory impact in every supported coding agent", () => {
  const router = readSkillFile("SKILL.md");
  const memoraxSearch = readSkillFile("references/memorax-search.md");
  const memoraxAdd = readSkillFile("references/memorax-add.md");
  const repoRead = readSkillFile("references/repo-read.md");
  const personalRead = readSkillFile("references/personal-read.md");

  assert.match(router, /## Natural Final-Answer Mention/);
  assert.match(router, /Codex, Claude Code, DeepSeek Harness, OpenCode, CodeBuddy\/WorkBuddy, and Trae/);
  assert.match(router, /materially changed localization, a decision, implementation, validation, or the delivered answer/);
  assert.match(router, /A Search or read alone is insufficient/);
  assert.match(router, /recover or substantiate historical intent, rationale, a prior decision, a constraint, or a reusable lesson/);
  assert.match(router, /Merely confirmatory/);
  assert.match(router, /begin the final answer with one brief opening paragraph before the normal task result/);
  assert.match(router, /Put a blank line after it/);
  assert.match(router, /under 600 characters/);
  assert.match(router, /Prefer one sentence/);
  assert.match(router, /second sentence only when two independent memory points/);
  assert.match(router, /Coding Memory.*Repo Memory.*Procedure Memory.*Profile Memory/s);
  assert.match(router, /must literally include `MemoraX Code` and the generic label `Memory`/);
  assert.match(router, /Do not name or enumerate the specific source type/);
  assert.match(router, /这次我参考了 MemoraX Code 的 Memory/);
  assert.match(router, /Do not add a heading, card, label, or colon-led report/);
  assert.match(router, /do not include HTML or XML comments, Markdown markers, tags, zero-width text, hidden control text, or metadata/i);
  assert.doesNotMatch(router, /memorax-impact/);
  assert.match(router, /raw memory text, IDs, scores, query text, private paths, or secrets/);
  assert.match(router, /Do not report active Add, automatic writeback, Repo Memory build or update, or automatic coding-memory retrieval/);
  assert.match(router, /Omit the opening paragraph when no eligible memory materially helped/);
  assert.match(memoraxSearch, /Natural Final-Answer Mention contract/);
  assert.match(memoraxSearch, /successful Search alone is insufficient/);
  assert.match(repoRead, /Natural Final-Answer Mention contract/);
  assert.match(repoRead, /materially affects the task/);
  assert.match(personalRead, /Natural Final-Answer Mention contract/);
  assert.match(personalRead, /routine language or tone preference/);
  assert.doesNotMatch(memoraxAdd, /memorax-impact/);
  assert.doesNotMatch(memoraxAdd, /Natural Final-Answer Mention/);
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

test("memorax-code selects the Windows cmd shim without changing execution policy", () => {
  const skill = readSkillFile("SKILL.md");
  const memoraxSearch = readSkillFile("references/memorax-search.md");
  const memoraxAdd = readSkillFile("references/memorax-add.md");

  for (const guidance of [skill, memoraxSearch, memoraxAdd]) {
    assert.match(guidance, /Windows PowerShell[\s\S]*`memorax-cli\.cmd`/);
    assert.match(guidance, /macOS and Linux[\s\S]*`memorax-cli`/);
    assert.match(guidance, /Never invoke `memorax-cli\.ps1`/);
    assert.match(guidance, /Never run `Set-ExecutionPolicy`/);
  }
  assert.match(memoraxSearch, /memorax-cli\.cmd search --query '/);
  assert.match(memoraxAdd, /memorax-cli\.cmd add --memory '/);
  assert.match(skill, /retry the same command once with `memorax-cli\.cmd`[\s\S]*preserving all arguments, the active workspace, and environment variables/);
  assert.match(memoraxAdd, /blocked before the CLI starts[\s\S]*retry that command once with `memorax-cli\.cmd`/);
  assert.match(memoraxAdd, /Do not retry Add after the CLI may have started/);
  for (const reference of [memoraxSearch, memoraxAdd]) {
    assert.match(reference, /Windows PowerShell:[\s\S]*two single quotes \(`''`\)/);
    assert.match(reference, /`don't` becomes `'don''t'`/);
    assert.match(reference, /macOS and Linux:[\s\S]*exact POSIX sequence/);
  }
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
