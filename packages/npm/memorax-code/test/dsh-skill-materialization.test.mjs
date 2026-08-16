import assert from "node:assert/strict";
import test from "node:test";
import { dshRepoMemoryJobSource } from "../../../../scripts/dsh-skill-materialization.mjs";

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
