import assert from "node:assert/strict";
import test from "node:test";
import { isAllowedNpmPackPath } from "../../../../scripts/npm-package-layout.mjs";
import { npmShippedDocs } from "../../../../scripts/npm-shipped-docs.mjs";

test("single npm package layout accepts declared paths and rejects unknown trees", () => {
  for (const path of npmShippedDocs) {
    assert.equal(isAllowedNpmPackPath(`docs/${path}`), true);
  }
  assert.equal(isAllowedNpmPackPath("LICENSE"), true);
  assert.equal(isAllowedNpmPackPath("bin/memorax-cli.mjs"), true);
  assert.equal(isAllowedNpmPackPath("bin/memorax-code-npm-preinstall.mjs"), true);
  assert.equal(isAllowedNpmPackPath("lib/node-version.mjs"), true);
  assert.equal(isAllowedNpmPackPath("lib/resolve-claude-command.mjs"), true);
  assert.equal(isAllowedNpmPackPath("lib/vscode-extension-command.mjs"), true);
  assert.equal(isAllowedNpmPackPath("lib/memorax-code-adapter-common/src/memorax-code-config-file.mjs"), true);
  assert.equal(isAllowedNpmPackPath("lib/memorax-code-backend/dist/server.js"), true);
  assert.equal(
    isAllowedNpmPackPath("lib/memorax-code-codex-adapter/skills/memorax-code/SKILL.md"),
    true,
  );
  assert.equal(isAllowedNpmPackPath("lib/memorax-code-opencode-adapter/src/plugin.mjs"), true);
  assert.equal(
    isAllowedNpmPackPath("lib/memorax-code-opencode-adapter/skills/memorax-code/SKILL.md"),
    true,
  );
  assert.equal(isAllowedNpmPackPath("lib/temporary-build/output.js"), false);
  assert.equal(isAllowedNpmPackPath("lib/unknown-runtime.mjs"), false);
  assert.equal(isAllowedNpmPackPath("bin/unknown-command.mjs"), false);
  assert.equal(isAllowedNpmPackPath("docs/undeclared.md"), false);
});
