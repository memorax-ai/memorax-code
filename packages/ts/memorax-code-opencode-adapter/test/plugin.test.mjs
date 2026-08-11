import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter } from "node:path";
import { join } from "node:path";
import { test } from "node:test";
import { createMemoraxOpenCodePlugin } from "../src/plugin.mjs";

test("shell.env overwrites the OpenCode session identity and prepends the managed CLI path", async () => {
  const cliBinDir = "/memorax/bin";
  const plugin = createMemoraxOpenCodePlugin({ cliBinDir });
  const hooks = await plugin({});
  const output = {
    env: {
      MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT: "codex",
      MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID: "old-session",
      MEMORAX_CODE_MEMORY_CLI_SESSION_ID: "old-session",
      PATH: ["/usr/bin", "/bin"].join(delimiter),
    },
  };

  await hooks["shell.env"]({ sessionID: "session-2" }, output);

  assert.equal(output.env.MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT, "opencode");
  assert.equal(output.env.MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID, "session-2");
  assert.equal(output.env.MEMORAX_CODE_MEMORY_CLI_SESSION_ID, "session-2");
  assert.equal(output.env.PATH, [cliBinDir, "/usr/bin", "/bin"].join(delimiter));
});

test("a loaded plugin follows the managed enabled state without an OpenCode restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-opencode-plugin-state-"));
  const statePath = join(root, "state.json");
  try {
    await writeState(false);
    const plugin = createMemoraxOpenCodePlugin({ statePath });
    const hooks = await plugin({});
    const disabledOutput = { env: {} };
    await hooks["shell.env"]({ sessionID: "session-disabled" }, disabledOutput);
    assert.equal(disabledOutput.env.MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT, undefined);

    await writeState(true);
    const enabledOutput = { env: {} };
    await hooks["shell.env"]({ sessionID: "session-enabled" }, enabledOutput);
    assert.equal(enabledOutput.env.MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT, "opencode");
    assert.equal(enabledOutput.env.MEMORAX_CODE_MEMORY_CLI_SESSION_ID, "session-enabled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  async function writeState(enabled) {
    await mkdir(root, { recursive: true });
    await writeFile(statePath, JSON.stringify({
      version: 1,
      runtime: "opencode",
      integration: "plugin",
      enabled,
    }));
  }
});
