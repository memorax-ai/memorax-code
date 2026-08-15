import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";

import { registerBundledMemoraxSkill } from "../src/skill.mjs";

test("registers the materialized canonical skill with its package-local resource base", () => {
  let registered;
  const pluginRoot = resolve("/tmp/memorax-code-dsh-adapter-test");
  registerBundledMemoraxSkill({
    skills: {
      register(definition) {
        registered = definition;
        return () => {};
      },
    },
  }, {
    pluginRoot,
    definition: {
      version: 1,
      name: "memorax-code",
      description: "Shared coding memory.",
      invocation: { modelInvocable: true, userInvocable: true },
      source: "bundled",
      content: "Use the shared memory workflow.",
    },
  });

  assert.equal(registered.name, "memorax-code");
  assert.equal(registered.source, "bundled");
  assert.deepEqual(registered.resourceBase, {
    kind: "directory",
    path: join(pluginRoot, "skills", "memorax-code"),
  });
});
