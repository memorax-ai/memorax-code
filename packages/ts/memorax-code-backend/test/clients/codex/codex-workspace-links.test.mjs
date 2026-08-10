import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { resolveCodexWorkspaceRoot } from "../../../dist/clients/codex/workspace-links.js";

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`, "utf8");
}

test("Codex workspace resolution uses the native adapter observation", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-codex-native-workspace-"));
  try {
    const sessionHome = join(root, "home");
    const registered = join(root, "registered");
    await mkdir(registered);
    await writeJson(join(sessionHome, "adapters", "codex", "workspaces.json"), {
      sessions: { "codex-native": { cwd: registered } },
    });

    const resolved = resolveCodexWorkspaceRoot({
      sessionHome,
      sessionKey: "codex-native",
    });

    assert.equal(resolved, await realpath(registered));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
