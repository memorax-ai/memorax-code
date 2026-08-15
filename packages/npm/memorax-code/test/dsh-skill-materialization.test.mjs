import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  assertDshSkillDefinition,
  dshRepoMemoryJobSource,
  materializeDshSkillDefinition,
} from "../../../../scripts/dsh-skill-materialization.mjs";

const canonicalSkill = new URL(
  "../../../ts/memorax-code-codex-adapter/skills/memorax-code/SKILL.md",
  import.meta.url,
);

test("DSH derives a package-local runtime definition without changing the canonical skill body", () => {
  const canonical = readFileSync(canonicalSkill, "utf8");
  const definition = materializeDshSkillDefinition(canonical);
  const canonicalBody = canonical.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").replaceAll("\r\n", "\n");

  assert.equal(definition.name, "memorax-code");
  assert.match(definition.description, /single router for persistent coding/);
  assert.deepEqual(definition.invocation, { modelInvocable: true, userInvocable: true });
  assert.equal(definition.source, "bundled");
  assert.equal(definition.content, canonicalBody);
  assert.doesNotThrow(() => assertDshSkillDefinition(definition, canonical));
});

test("DSH repo-memory helper keeps the native maintenance handoff and fails closed without headless", () => {
  const source = dshRepoMemoryJobSource();
  assert.match(source, /runner: "dsh"/);
  assert.match(source, /memorySkillInvocation: "\/memorax-code"/);
  assert.match(source, /@deepseek-ai\/dsh-headless/);
  assert.match(source, /no existing DSH headless-capable profile/);
  assert.match(source, /state\.enabled !== true/);
  assert.match(source, /selectHeadlessProfile\(metadata\.dshHome, state\.profiles\)/);
  assert.match(source, /managedNames\.has\(candidate\.name\)/);
});
