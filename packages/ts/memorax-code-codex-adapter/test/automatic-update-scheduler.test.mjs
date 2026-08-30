import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { scheduleAutomaticUpdate } from "../../memorax-code-adapter-common/src/hooks/automatic-update-scheduler.mjs";

test("SessionStart schedules a detached automatic update for completed setup", async () => {
  const fixture = await createFixture();
  try {
    await writeSetupCompletion(fixture.memoraxCodeHome);
    const scheduled = scheduleAutomaticUpdate({
      input: { hook_event_name: "SessionStart" },
      memoraxCodeCommand: fixture.command,
      memoraxCodeHome: fixture.memoraxCodeHome,
      nodePath: process.execPath,
      env: {
        ...process.env,
        MEMORAX_CODE_TEST_AUTOMATIC_UPDATE_RECORD: fixture.recordPath,
      },
    });

    assert.equal(scheduled, true);
    const record = JSON.parse(await waitForFile(fixture.recordPath));
    assert.deepEqual(record.args, [
      "update",
      "--automatic",
      "--home",
      fixture.memoraxCodeHome,
    ]);
    assert.equal(record.automaticUpdateProcess, "1");
    assert.equal(record.memoraxCodeHome, fixture.memoraxCodeHome);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

for (const scenario of [
  {
    name: "non-SessionStart Hook event",
    input: { hook_event_name: "UserPromptSubmit" },
  },
  {
    name: "explicit opt-out",
    input: { hook_event_name: "SessionStart" },
    automaticUpdateValue: "false",
  },
  {
    name: "incomplete setup",
    input: { hook_event_name: "SessionStart" },
    setupComplete: false,
  },
]) {
  test(`automatic update is not scheduled for ${scenario.name}`, async () => {
    const fixture = await createFixture();
    try {
      if (scenario.setupComplete !== false) await writeSetupCompletion(fixture.memoraxCodeHome);
      const scheduled = scheduleAutomaticUpdate({
        automaticUpdateValue: scenario.automaticUpdateValue,
        input: scenario.input,
        memoraxCodeCommand: fixture.command,
        memoraxCodeHome: fixture.memoraxCodeHome,
        nodePath: process.execPath,
        env: {
          ...process.env,
          MEMORAX_CODE_TEST_AUTOMATIC_UPDATE_RECORD: fixture.recordPath,
        },
      });

      assert.equal(scheduled, false);
      await delay(25);
      await assert.rejects(readFile(fixture.recordPath, "utf8"), (error) => error?.code === "ENOENT");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-update-scheduler-"));
  const memoraxCodeHome = join(root, "memorax-code-home");
  const command = join(root, "memorax-code.mjs");
  const recordPath = join(root, "automatic-update.json");
  await writeFile(command, [
    "import { writeFileSync } from 'node:fs';",
    "writeFileSync(process.env.MEMORAX_CODE_TEST_AUTOMATIC_UPDATE_RECORD, JSON.stringify({",
    "  args: process.argv.slice(2),",
    "  automaticUpdateProcess: process.env.MEMORAX_CODE_AUTOMATIC_UPDATE_PROCESS,",
    "  memoraxCodeHome: process.env.MEMORAX_CODE_HOME,",
    "}));",
    "",
  ].join("\n"));
  return { root, memoraxCodeHome, command, recordPath };
}

async function writeSetupCompletion(memoraxCodeHome) {
  const path = join(memoraxCodeHome, "runtime", "setup", "setup-completion.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({
    version: 1,
    state: "complete",
    completedAt: "2026-08-30T08:00:00.000Z",
    completedByVersion: "0.1.9",
  })}\n`);
}

async function waitForFile(path) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await delay(10);
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}
