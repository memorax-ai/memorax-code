import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import {
  ensureClaudeMarketplaceEnv,
  ensureInstallWatchdogEnv,
  ensureNpmPackageRuntimeEnv,
  installWatchPathsForPackageRoot,
} from "../lib/run-entrypoint.mjs";

test("package entrypoint preserves a verified Windows npm CLI path", async () => {
  const packageRoot = await mkdtemp(`${tmpdir()}/memorax-code-npm-runtime-`);
  const npmExecPath = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
  const env = {};
  try {
    await writeFile(join(packageRoot, "package.json"), `${JSON.stringify({ version: "0.1.9-test" })}\n`);
    ensureNpmPackageRuntimeEnv(packageRoot, {
      env,
      platform: "win32",
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      existsSync: (candidate) => candidate === npmExecPath,
    });

    assert.equal(env.MEMORAX_CODE_NPM_PACKAGE_ROOT, packageRoot);
    assert.equal(env.MEMORAX_CODE_NPM_PACKAGE_VERSION, "0.1.9-test");
    assert.equal(env.MEMORAX_CODE_NPM_EXEC_PATH, npmExecPath);
  } finally {
    await rm(packageRoot, { recursive: true, force: true });
  }
});

test("package entrypoint declares install watchdog paths without overriding user config", async () => {
  const packageRoot = await mkdtemp(`${tmpdir()}/memorax-code-run-entrypoint-`);
  await mkdir(`${packageRoot}/bin`, { recursive: true });
  await mkdir(`${packageRoot}/lib/memorax-code-backend/dist`, { recursive: true });
  await writeFile(`${packageRoot}/package.json`, "{}\n");
  await writeFile(`${packageRoot}/bin/memorax-code.mjs`, "#!/usr/bin/env node\n");
  await writeFile(`${packageRoot}/lib/memorax-code-backend/dist/server.js`, "\n");
  const paths = installWatchPathsForPackageRoot(packageRoot);
  assert.ok(paths.length >= 3);
  assert.ok(paths.some((path) => path.endsWith("package.json")));
  assert.ok(paths.every((path) => existsSync(path)));

  const previous = process.env.MEMORAX_CODE_INSTALL_WATCH_PATHS;
  const previousFlag = process.env.MEMORAX_CODE_INSTALL_WATCHDOG;
  try {
    delete process.env.MEMORAX_CODE_INSTALL_WATCH_PATHS;
    delete process.env.MEMORAX_CODE_INSTALL_WATCHDOG;
    ensureInstallWatchdogEnv(packageRoot);
    assert.equal(process.env.MEMORAX_CODE_INSTALL_WATCHDOG, "1");
    assert.deepEqual(process.env.MEMORAX_CODE_INSTALL_WATCH_PATHS?.split(delimiter), paths);

    process.env.MEMORAX_CODE_INSTALL_WATCH_PATHS = "/custom/sentinel";
    process.env.MEMORAX_CODE_INSTALL_WATCHDOG = "0";
    ensureInstallWatchdogEnv(packageRoot);
    assert.equal(process.env.MEMORAX_CODE_INSTALL_WATCH_PATHS, "/custom/sentinel");
    assert.equal(process.env.MEMORAX_CODE_INSTALL_WATCHDOG, "0");
  } finally {
    if (previous === undefined) delete process.env.MEMORAX_CODE_INSTALL_WATCH_PATHS;
    else process.env.MEMORAX_CODE_INSTALL_WATCH_PATHS = previous;
    if (previousFlag === undefined) delete process.env.MEMORAX_CODE_INSTALL_WATCHDOG;
    else process.env.MEMORAX_CODE_INSTALL_WATCHDOG = previousFlag;
    await rm(packageRoot, { recursive: true, force: true });
  }
});

test("package entrypoint exposes bundled Claude marketplace and skills roots", async () => {
  const previousMarketplace = process.env.MEMORAX_CODE_CLAUDE_MARKETPLACE_ROOT;
  const previousSkills = process.env.MEMORAX_CODE_CLAUDE_SKILLS_ROOT;
  try {
    delete process.env.MEMORAX_CODE_CLAUDE_MARKETPLACE_ROOT;
    delete process.env.MEMORAX_CODE_CLAUDE_SKILLS_ROOT;
    ensureClaudeMarketplaceEnv();
    assert.match(process.env.MEMORAX_CODE_CLAUDE_MARKETPLACE_ROOT ?? "", /lib\/memorax-code-claude-marketplace$/);
    assert.match(process.env.MEMORAX_CODE_CLAUDE_SKILLS_ROOT ?? "", /lib\/memorax-code-claude-adapter\/skills$/);

    process.env.MEMORAX_CODE_CLAUDE_MARKETPLACE_ROOT = "/custom/marketplace";
    process.env.MEMORAX_CODE_CLAUDE_SKILLS_ROOT = "/custom/skills";
    ensureClaudeMarketplaceEnv();
    assert.equal(process.env.MEMORAX_CODE_CLAUDE_MARKETPLACE_ROOT, "/custom/marketplace");
    assert.equal(process.env.MEMORAX_CODE_CLAUDE_SKILLS_ROOT, "/custom/skills");
  } finally {
    if (previousMarketplace === undefined) delete process.env.MEMORAX_CODE_CLAUDE_MARKETPLACE_ROOT;
    else process.env.MEMORAX_CODE_CLAUDE_MARKETPLACE_ROOT = previousMarketplace;
    if (previousSkills === undefined) delete process.env.MEMORAX_CODE_CLAUDE_SKILLS_ROOT;
    else process.env.MEMORAX_CODE_CLAUDE_SKILLS_ROOT = previousSkills;
  }
});
