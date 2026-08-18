import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readerSkillRoot = join(packageRoot, "skills", "memorax-code");

test("memorax-code repo-read reference enforces retrieval budget and stop rules", () => {
  const skill = readFileSync(join(readerSkillRoot, "references", "repo-read.md"), "utf8");

  assert.match(skill, /## Retrieval Budget/);
  assert.match(skill, /Read `PROFILE\.md` at most once/);
  assert.match(skill, /at most 2 combined `rg` commands/);
  assert.match(skill, /Stop repo-memory retrieval as soon as the hits are sufficient/);
  assert.match(skill, /Do NOT open these unless the user explicitly asks/);
  assert.match(skill, /\.repo_memory\/raw\/\*\.json/);
  assert.match(skill, /`docs\/`, `packages\/`, `tests\/`, or other live source directories/);
  assert.match(skill, /Do not read repo memory again after `maintain` returns/);
  assert.match(skill, /Current implementation claims and code edits still require live-code verification/);
});

test("memorax-code repo-read reference silently schedules supervised maintenance only when needed", () => {
  const skill = readFileSync(join(readerSkillRoot, "references", "repo-read.md"), "utf8");
  const openaiYaml = readFileSync(join(readerSkillRoot, "agents", "openai.yaml"), "utf8");

  assert.match(skill, /broad repo introduction/);
  assert.match(skill, /history, architecture background, cross-module routing, PR\/issue context/);
  assert.match(skill, /Skip this reference for narrow tasks with a clear live-code target/);
  assert.match(skill, /## Single Maintenance Handoff/);
  assert.match(skill, /repo-memory-job\.mjs' maintain --repo/);
  assert.match(skill, /`bundle_missing`/);
  assert.match(skill, /`bundle_invalid`/);
  assert.match(skill, /`up_to_date`/);
  assert.match(skill, /`active_job`/);
  assert.match(skill, /Do not wait, poll, retry, or expose/);
  assert.match(skill, /Never replace the packaged helper with a generic subagent/);

  assert.match(openaiYaml, /allow_implicit_invocation: true/);
  assert.match(openaiYaml, /Route coding, repo, and personal memory/);
  assert.match(openaiYaml, /Use \$memorax-code to route/);
});

test("memorax-code repo-read delegates deterministic maintenance decisions only on relevant demand", () => {
  const skill = readFileSync(join(readerSkillRoot, "references", "repo-read.md"), "utf8");

  assert.match(skill, /Only a relevant `repo-read` invokes `maintain`/);
  assert.match(skill, /Commit arrival, PR merge, and elapsed time alone do not invoke it/);
  assert.match(skill, /validates the generated bundle, evaluates the configured local update policy/);
  assert.match(skill, /provider network access/);
  assert.match(skill, /`adaptive\(5 commits OR 24 hours\)`/);
  assert.match(skill, /missing or non-ancestor baseline/);
});

test("memorax-code repo-read makes maintain the immediate post-read handoff", () => {
  const skill = readFileSync(join(readerSkillRoot, "references", "repo-read.md"), "utf8");

  assert.match(skill, /After the final repo-memory read, run `maintain` as the very next tool action/);
  assert.match(skill, /Do not run it in parallel with a repo-memory read/);
  assert.match(skill, /Do not inspect live code, maintained documentation, Git evidence, run unrelated tools, or answer between them/);
  assert.match(skill, /If no repo-memory read was possible, run it immediately after detecting that state/);
  assert.match(skill, /The same handoff applies when hits already answer the question or the retrieval budget is exhausted/);
});


test("memorax-code repo-read follows wiki-style progressive reading", () => {
  const skill = readFileSync(join(readerSkillRoot, "references", "repo-read.md"), "utf8");

  assert.match(skill, /wiki-style repo memory/);
  assert.match(skill, /PROFILE\.md` as the wiki landing page/);
  assert.match(skill, /Major Areas/);
  assert.match(skill, /Supporting Pages/);
  assert.match(skill, /Open at most 2-4 relevant conceptual pages/);
  assert.match(skill, /canonical homes/);
  assert.match(skill, /Do not assume fixed page names/);
  assert.match(skill, /\.repo_memory\/\*\.md/);
  assert.match(skill, /resources\/\*\.md for historical routing cards/);
});

test("memorax-code repo-read treats disabled history resources as collection state", () => {
  const skill = readFileSync(join(readerSkillRoot, "references", "repo-read.md"), "utf8");

  assert.match(skill, /Disabled and unavailable historical resource files/);
  assert.match(skill, /source: "history_disabled"/);
  assert.match(skill, /source: "provider_skipped_local_only"/);
  assert.match(skill, /source: "provider_unavailable"/);
  assert.match(skill, /collection state, not repository state/);
  assert.match(skill, /do not conclude that there are no commits, PRs, MRs, or issues/);
  assert.match(skill, /Ask whether to rebuild with provider history/);
});
