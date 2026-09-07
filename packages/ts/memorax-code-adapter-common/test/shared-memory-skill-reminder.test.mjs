import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { evaluateMemorySkillReminder } from "../src/hooks/memory-skill-reminder-hook.mjs";
import {
  isMemorySkillReminderDue,
  resolveMemorySkillReminderIntervalTurns,
} from "../src/hooks/memory-skill-reminder-policy.mjs";

test("shared reminder interval resolves environment, configuration, and defaults", async (t) => {
  const configured = "[memory.skill_reminder]\ninterval_turns = 2\n";
  const scenarios = [
    { name: "missing settings use five turns", input: {}, expected: 5 },
    { name: "configuration accepts comments and integer separators", input: { configText: "[memory.skill_reminder]\ninterval_turns = 1_0 # cadence\n" }, expected: 10 },
    { name: "another section cannot configure reminders", input: { configText: "[memory]\ninterval_turns = 2\n" }, expected: 5 },
    { name: "environment overrides configuration", input: { environmentValue: " 3 ", configText: configured }, expected: 3 },
    { name: "invalid environment falls through to configuration", input: { environmentValue: "0", configText: configured }, expected: 2 },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, () => {
      assert.equal(resolveMemorySkillReminderIntervalTurns(scenario.input), scenario.expected);
    });
  }
  for (const value of ["0", "-1", "2.5", '"2"', "true", "9007199254740992"]) {
    await t.test(`invalid configured interval ${value} uses the default`, () => {
      assert.equal(resolveMemorySkillReminderIntervalTurns({
        configText: `[memory.skill_reminder]\ninterval_turns = ${value}\n`,
      }), 5);
    });
  }
});

test("shared reminder cadence has explicit first-turn and interval boundaries", async (t) => {
  for (const scenario of [
    { name: "default cadence", interval: 5, first: true, expected: [1, 6, 11] },
    { name: "every turn", interval: 1, first: true, expected: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
    { name: "first-turn suppression retains the later cadence", interval: 5, first: false, expected: [6, 11] },
  ]) {
    await t.test(scenario.name, () => {
      const dueTurns = Array.from({ length: 11 }, (_, index) => index + 1)
        .filter((turn) => isMemorySkillReminderDue(turn, scenario.interval, scenario.first));
      assert.deepEqual(dueTurns, scenario.expected);
    });
  }
  for (const invalid of [0, -1, 1.5, undefined]) {
    await t.test(`invalid count or interval ${invalid} is never due`, () => {
      assert.equal(isMemorySkillReminderDue(invalid, 5), false);
      assert.equal(isMemorySkillReminderDue(1, invalid), false);
    });
  }
});

test("shared reminder evaluator persists cadence using the resolved interval", async (t) => {
  const environmentKey = "MEMORAX_CODE_MEMORY_SKILL_REMINDER_INTERVAL_TURNS";
  const previousValue = process.env[environmentKey];
  t.after(() => {
    if (previousValue === undefined) delete process.env[environmentKey];
    else process.env[environmentKey] = previousValue;
  });
  for (const scenario of [
    { name: "missing config", expected: [1, 6] },
    { name: "configured interval", config: 2, expected: [1, 3, 5] },
    { name: "environment overrides config", config: 9, environment: "2", expected: [1, 3, 5] },
    { name: "invalid config uses the default", config: 0, expected: [1, 6] },
  ]) {
    await t.test(scenario.name, async () => {
      const root = await mkdtemp(join(tmpdir(), "memorax-code-shared-reminder-cadence-"));
      try {
        if (scenario.environment === undefined) delete process.env[environmentKey];
        else process.env[environmentKey] = scenario.environment;
        if (scenario.config !== undefined) {
          await writeFile(join(root, "config.toml"), `[memory.skill_reminder]\ninterval_turns = ${scenario.config}\n`);
        }
        const dueTurns = [];
        for (let turn = 1; turn <= 6; turn += 1) {
          const result = await evaluateMemorySkillReminder({
            memoraxCodeHome: root,
            adapterDir: "shared-contract",
            runtime: "shared-contract",
          }, { hook_event_name: "UserPromptSubmit", session_id: "session" });
          if (result) {
            assert.deepEqual(result.reminder.triggers, ["cadence"]);
            assert.equal(result.reminder.sessionId, "session");
            dueTurns.push(turn);
          }
        }
        assert.deepEqual(dueTurns, scenario.expected);
        const state = JSON.parse(await readFile(join(root, "adapters", "shared-contract", "memory-skill-reminders.json"), "utf8"));
        assert.equal(state.sessions.session.turnCount, 6);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("shared reminder evaluator replaces corrupt state with the first correlated turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-shared-reminder-corrupt-"));
  const statePath = join(root, "adapters", "shared-contract", "memory-skill-reminders.json");
  try {
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(statePath, "{not json");
    const result = await evaluateMemorySkillReminder({
      memoraxCodeHome: root,
      adapterDir: "shared-contract",
      runtime: "shared-contract",
    }, { session_id: "session", turn_id: "after-corrupt-state" });

    assert.deepEqual(result.reminder.triggers, ["cadence"]);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.runtime, "shared-contract");
    assert.equal(state.sessions.session.turnCount, 1);
    assert.equal(state.sessions.session.lastTurnId, "after-corrupt-state");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
