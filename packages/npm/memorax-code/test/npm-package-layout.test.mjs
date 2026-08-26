import assert from "node:assert/strict";
import test from "node:test";
import {
  isAllowedNpmPackFilePath,
  isAllowedNpmPackPath,
  isReviewedCredentialRuntimePath,
} from "../../../../scripts/npm-package-layout.mjs";
import { npmShippedDocs } from "../../../../scripts/npm-shipped-docs.mjs";

test("single npm package layout accepts declared paths and rejects unknown trees", () => {
  for (const path of npmShippedDocs) {
    assert.equal(isAllowedNpmPackPath(`docs/${path}`), true);
  }
  assert.equal(isAllowedNpmPackPath("LICENSE"), true);
  assert.equal(isAllowedNpmPackPath("bin/memorax-cli.mjs"), true);
  assert.equal(isAllowedNpmPackPath("bin/memorax-code-npm-preinstall.mjs"), true);
  assert.equal(isAllowedNpmPackPath("bin/memorax-code-plugin-postinstall.mjs"), true);
  assert.equal(isAllowedNpmPackPath("bin/memorax-code-setup.mjs"), true);
  assert.equal(isAllowedNpmPackPath("bin/memorax-code-opencode.mjs"), true);
  assert.equal(isAllowedNpmPackPath("lib/node-version.mjs"), true);
  assert.equal(isAllowedNpmPackPath("lib/dsh-plugin-install.mjs"), true);
  assert.equal(isAllowedNpmPackPath("lib/package-transition.mjs"), true);
  assert.equal(isAllowedNpmPackPath("lib/resolve-claude-command.mjs"), true);
  assert.equal(isAllowedNpmPackPath("lib/vscode-extension-command.mjs"), true);
  assert.equal(isAllowedNpmPackPath("lib/setup-memory-preferences.mjs"), true);
  assert.equal(isAllowedNpmPackPath("lib/setup-reconcile.mjs"), true);
  for (const name of [
    "trial-plugin-mark.mjs",
    "trial-provision-client.mjs",
    "trial-provision-flow.mjs",
    "trial-setup.mjs",
  ]) {
    assert.equal(isAllowedNpmPackPath(`lib/${name}`), true);
  }
  assert.equal(isAllowedNpmPackPath("lib/memorax-code-adapter-common/src/memorax-code-config-file.mjs"), true);
  assert.equal(
    isAllowedNpmPackPath("lib/memorax-code-adapter-common/src/credentials/trial-credential-store.mjs"),
    true,
  );
  assert.equal(isAllowedNpmPackPath("lib/memorax-code-backend/dist/server.js"), true);
  assert.equal(
    isAllowedNpmPackPath("lib/memorax-code-codex-adapter/skills/memorax-code/SKILL.md"),
    true,
  );
  assert.equal(isAllowedNpmPackPath("lib/memorax-code-opencode-adapter/src/plugin.mjs"), true);
  assert.equal(isAllowedNpmPackPath("lib/memorax-code-dsh-adapter/src/plugin.mjs"), true);
  assert.equal(
    isAllowedNpmPackPath("lib/memorax-code-opencode-adapter/skills/memorax-code/SKILL.md"),
    true,
  );
  assert.equal(isAllowedNpmPackPath("lib/temporary-build/output.js"), false);
  assert.equal(isAllowedNpmPackPath("lib/unknown-runtime.mjs"), false);
  assert.equal(isAllowedNpmPackPath("bin/unknown-command.mjs"), false);
  assert.equal(isAllowedNpmPackPath("docs/undeclared.md"), false);
});

test("credential runtime allowlist accepts only reviewed main and marketplace files", () => {
  const names = [
    "linux-secret-service.mjs",
    "macos-keychain.mjs",
    "secure-command.mjs",
    "trial-credential-record.d.mts",
    "trial-credential-record.mjs",
    "trial-credential-store.d.mts",
    "trial-credential-store.mjs",
    "windows-dpapi.mjs",
  ];
  const prefixes = [
    "lib/memorax-code-adapter-common/src/credentials/",
    "lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/memorax-code-adapter-common/src/credentials/",
  ];
  for (const prefix of prefixes) {
    assert.equal(isAllowedNpmPackPath(prefix.slice(0, -1)), true);
    for (const name of names) {
      assert.equal(isReviewedCredentialRuntimePath(`${prefix}${name}`), true);
      assert.equal(isAllowedNpmPackFilePath(`${prefix}${name}`), true);
    }
  }
  for (const path of [
    "lib/memorax-code-adapter-common/src/credentials/evil-secret.mjs",
    "lib/memorax-code-claude-marketplace/plugins/memorax-code-claude-adapter/memorax-code-adapter-common/src/credentials/evil-secret.mjs",
    "lib/memorax-code-adapter-common/src/credentials/macos-keychain.mjs.bak",
    "lib/memorax-code-adapter-common/src/credentials/nested/windows-dpapi.mjs",
    "lib/memorax-code-codex-adapter/src/credentials/trial-credential-store.mjs",
  ]) {
    assert.equal(isReviewedCredentialRuntimePath(path), false);
    assert.equal(isAllowedNpmPackFilePath(path), false);
  }
  assert.equal(
    isAllowedNpmPackFilePath("lib/memorax-code-adapter-common/src/runtime-record.mjs"),
    true,
  );
  assert.equal(isAllowedNpmPackFilePath("lib/memorax-code-adapter-common/src/credential-leak.mjs"), false);
  assert.equal(isAllowedNpmPackFilePath("lib/unknown-runtime.mjs"), false);
});
