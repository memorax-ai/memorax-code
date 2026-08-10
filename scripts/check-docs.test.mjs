import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  appendFile,
  mkdtemp,
  mkdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkDocumentation } from "./check-docs.mjs";

const README_SYNC_SCRIPT = fileURLToPath(
  new URL("./check-readme-sync.sh", import.meta.url),
);

test("documentation contract accepts a complete minimal fixture", async (t) => {
  const root = await fixture(t);
  assert.deepEqual(checkDocumentation(root), []);
});

test("documentation contract rejects a broken relative link", async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, "docs", "configuration.md"),
    "# Configuration\n\n[Missing](missing.md)\n",
  );
  assert.ok(
    checkDocumentation(root).some((error) => error.includes("links to missing path")),
  );
});

test("documentation contract checks the root installation guide", async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, "INSTALL.md"),
    "# Installation\n\n[Missing](missing.md)\n",
  );
  assert.ok(
    checkDocumentation(root).some((error) => error.includes("links to missing path")),
  );
});

test("documentation contract checks the root architecture guide", async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, "ARCHITECTURE.md"),
    "# Architecture\n\n[Missing](missing.md)\n",
  );
  assert.ok(
    checkDocumentation(root).some((error) => error.includes("links to missing path")),
  );
});

test("documentation contract rejects personal absolute paths", async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, "docs", "configuration.md"),
    "# Configuration\n\nDo not publish /Users/example/private/config.toml.\n",
  );
  assert.ok(
    checkDocumentation(root).some(
      (error) => error.includes("contains a personal absolute path"),
    ),
  );
});

test("documentation contract requires shipped docs to exist", async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, "packages", "npm", "memorax-code", "shipped-docs.json"),
    `${JSON.stringify(["configuration.md", "troubleshooting.md"], null, 2)}\n`,
  );
  assert.ok(
    checkDocumentation(root).some(
      (error) => error.includes("npm shipped doc is missing from docs/: troubleshooting.md"),
    ),
  );
});

test("documentation contract keeps npm README references equal to the manifest", async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, "packages", "npm", "memorax-code", "README.md"),
    "# Package\n\n- `docs/configuration.md`\n- `docs/internal.md`\n",
  );
  assert.ok(
    checkDocumentation(root).some(
      (error) => error.includes("docs references must exactly match"),
    ),
  );
});

test("documentation contract requires shipped document links to stay inside the package", async (t) => {
  const root = await fixture(t);
  await writeFile(
    join(root, "docs", "configuration.md"),
    "# Configuration\n\n[Internal](internal.md)\n",
  );
  await writeFile(join(root, "docs", "internal.md"), "# Internal\n");
  assert.ok(
    checkDocumentation(root).some(
      (error) => error.includes("links to an unshipped document: internal.md"),
    ),
  );
});

test("README sync rejects a one-sided change in an explicit range", async (t) => {
  const root = await gitFixture(t);
  const base = git(root, ["rev-parse", "HEAD"]);
  await appendFile(join(root, "README.md"), "\nEnglish only.\n");
  git(root, ["add", "README.md"]);
  git(root, ["commit", "-m", "english only"]);

  const result = spawnSync("bash", [README_SYNC_SCRIPT], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      README_SYNC_BASE_REF: base,
      README_SYNC_HEAD_REF: "HEAD",
    },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /README language sync check failed/);
});

test("README sync falls back when automatic origin/main is unrelated", async (t) => {
  const root = await gitFixture(t);
  await appendFile(join(root, "README.md"), "\nEnglish update.\n");
  await appendFile(join(root, "README.zh.md"), "\n中文更新。\n");
  git(root, ["add", "README.md", "README.zh.md"]);
  git(root, ["commit", "-m", "paired update"]);

  const emptyTree = git(root, ["mktree"], "");
  const unrelated = git(root, ["commit-tree", emptyTree, "-m", "unrelated"]);
  git(root, ["update-ref", "refs/remotes/origin/main", unrelated]);

  const result = spawnSync("bash", [README_SYNC_SCRIPT], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      README_SYNC_BASE_REF: "",
      README_SYNC_HEAD_REF: "HEAD",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /README language sync check passed/);
});

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-docs-check-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, "docs"), { recursive: true });
  await mkdir(join(root, "packages", "npm", "memorax-code"), { recursive: true });
  await writeFile(
    join(root, "README.md"),
    "# Project\n\n[Configuration](docs/configuration.md)\n",
  );
  await writeFile(
    join(root, "README.zh.md"),
    "# 项目\n\n[配置](docs/configuration.md)\n",
  );
  await writeFile(join(root, "docs", "configuration.md"), "# Configuration\n");
  await writeFile(
    join(root, "packages", "npm", "memorax-code", "README.md"),
    "# Package\n\n- `docs/configuration.md`\n",
  );
  await writeFile(
    join(root, "packages", "npm", "memorax-code", "shipped-docs.json"),
    `${JSON.stringify(["configuration.md"], null, 2)}\n`,
  );
  return root;
}

async function gitFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-readme-sync-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  git(root, ["init", "--quiet"]);
  git(root, ["config", "user.name", "MemoraX Code Docs Test"]);
  git(root, ["config", "user.email", "docs-test@example.invalid"]);
  await writeFile(join(root, "README.md"), "# Project\n");
  await writeFile(join(root, "README.zh.md"), "# 项目\n");
  git(root, ["add", "README.md", "README.zh.md"]);
  git(root, ["commit", "-m", "initial"]);
  return root;
}

function git(root, args, input) {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    input,
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
