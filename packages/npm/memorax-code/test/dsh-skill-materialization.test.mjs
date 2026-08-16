import assert from "node:assert/strict";
import test from "node:test";
import { dshRepoMemoryJobSource } from "../../../../scripts/dsh-skill-materialization.mjs";

test("DSH repo-memory helper keeps the native maintenance handoff and fails closed without headless", () => {
  const source = dshRepoMemoryJobSource();
  assert.match(source, /runner: "dsh"/);
  assert.match(source, /memorySkillInvocation: "\/memorax-code"/);
  assert.match(source, /@deepseek-ai\/dsh-headless/);
  assert.match(source, /no existing DSH headless-capable profile/);
  assert.match(source, /requireEnabledDshRuntime\(pluginRoot\)/);
  assert.match(source, /selectHeadlessProfile\(runtime\.dshHome, runtime\.profiles\)/);
  assert.doesNotMatch(source, /function assertEnabled/);
  assert.doesNotMatch(source, /function readMetadata/);
  assert.match(source, /managedNames\.has\(candidate\.name\)/);
});
