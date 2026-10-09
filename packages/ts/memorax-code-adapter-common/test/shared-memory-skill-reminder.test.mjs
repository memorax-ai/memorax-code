import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { evaluateMemorySkillReminder, markSupplementalReminderForSession } from "../src/hooks/memory-skill-reminder-hook.mjs";
import {
  codingMemoryReminderContext,
  isMemorySkillReminderDue,
  resolveMemorySkillReminderIntervalTurns,
} from "../src/hooks/memory-skill-reminder-policy.mjs";

test("Jev search guidance routes through the client's canonical Search reference", () => {
  for (const invocation of [undefined, "/memorax-code-claude-adapter:memorax-code", "/memorax-code", "the `memorax-code` skill"]) {
    const context = codingMemoryReminderContext({ ok: true, decision: "search" }, invocation);
    assert.ok(context.includes(invocation ?? "$memorax-code"));
    assert.match(context, /references\/memorax-search\.md/);
    assert.match(context, /completely in a standalone tool call/);
    assert.match(context, /before constructing queries or executing Search/);
    assert.match(context, /Query Workflow/);
    assert.doesNotMatch(context, /search --query|without rereading|Use one focused natural-language query/);
    assert.equal(codingMemoryReminderContext({ ok: true, decision: "skip" }, invocation), undefined);
    const fallback = codingMemoryReminderContext({ ok: false, reason: "timeout" }, invocation);
    assert.match(fallback, /proactively invoke/);
    assert.ok(fallback.includes(invocation ?? "$memorax-code"));
  }
});

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

test("duplicate reminders preserve independent notices and pending compaction context", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-shared-reminder-notice-"));
  const statePath = join(root, "adapters", "shared-contract", "memory-skill-reminders.json");
  const options = {
    memoraxCodeHome: root,
    adapterDir: "shared-contract",
    runtime: "shared-contract",
    supplementalReminderAfterCompact: true,
    additionalReminderContext: "Restore personal memory after compaction.",
  };
  const input = { session_id: "session", turn_id: "turn-1" };
  try {
    assert.ok((await evaluateMemorySkillReminder(options, input)).reminder);
    markSupplementalReminderForSession(options, input.session_id);
    const beforeDuplicate = await readFile(statePath, "utf8");

    assert.deepEqual(await evaluateMemorySkillReminder({
      ...options,
      systemMessage: "Pending Add quota notice.",
    }, input), { systemMessage: "Pending Add quota notice." });
    assert.equal(await evaluateMemorySkillReminder(options, input), undefined);
    assert.equal(await evaluateMemorySkillReminder({ ...options, systemMessage: " " }, input), undefined);
    assert.equal(await readFile(statePath, "utf8"), beforeDuplicate);

    const next = await evaluateMemorySkillReminder(options, { ...input, turn_id: "turn-2" });
    assert.equal(next.systemMessage, undefined);
    assert.ok(next.reminder.triggers.includes("post_compaction"));
    assert.match(next.additionalContext, /Restore personal memory after compaction/);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.sessions.session.turnCount, 2);
    assert.equal(state.sessions.session.supplementalReminderPending, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Jev judges each unique prompt while fallback and personal context keep their own cadence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-jev-reminder-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const decisions = [];
  let profiles = 0;
  let procedures = 0;
  const options = {
    memoraxCodeHome: root, adapterDir: "shared-contract", runtime: "shared-contract",
    supplementalReminderAfterCompact: true,
    additionalReminderContext: "Personal memory routing remains available.",
    memoryImpactContext: "Memory attribution.",
    buildPersonalMemoryContext: async () => { profiles += 1; return "Profile context."; },
    buildCadenceReminderContext: async () => { procedures += 1; return "Procedure context."; },
    evaluateSearchGuidance: async (input) => {
      decisions.push(input.turnId);
      if (["turn-5", "turn-6"].includes(input.turnId)) throw new Error("unavailable");
      return { ok: true, decision: ["turn-2", "turn-3", "turn-9"].includes(input.turnId) ? "search" : "skip" };
    },
  };
  const input = (turn) => ({ sessionId: "session", turnId: "turn-" + turn, prompt: "Current request" });
  const first = await evaluateMemorySkillReminder(options, input(1));
  assert.doesNotMatch(first.additionalContext, /proactively invoke|references\/memorax-search\.md/);
  assert.match(first.additionalContext, /Personal memory routing/);
  assert.match(first.additionalContext, /Profile context/);
  assert.match(first.additionalContext, /Procedure context/);
  assert.match(first.additionalContext, /Memory attribution/);
  assert.deepEqual(first.reminder.triggers, ["search_guidance", "cadence"]);
  assert.deepEqual(await evaluateMemorySkillReminder({ ...options, systemMessage: "Quota notice." }, input(1)), { systemMessage: "Quota notice." });
  markSupplementalReminderForSession(options, "session");
  const compact = await evaluateMemorySkillReminder(options, input(2));
  assert.match(compact.additionalContext, /Profile context/);
  assert.match(compact.additionalContext, /references\/memorax-search\.md/);
  assert.doesNotMatch(compact.additionalContext, /Procedure context|proactively invoke/);
  assert.deepEqual(compact.reminder.triggers, ["search_guidance", "post_compaction"]);
  for (let turn = 3; turn <= 11; turn += 1) {
    const result = await evaluateMemorySkillReminder(options, input(turn));
    if (turn === 3 || turn === 9) {
      assert.match(result.additionalContext, /Jev selected Coding Memory search/);
      assert.match(result.additionalContext, /references\/memorax-search\.md/);
      assert.match(result.additionalContext, /Memory attribution/);
      assert.doesNotMatch(result.additionalContext, /Personal memory routing|Procedure context|proactively invoke|Profile context/);
      assert.deepEqual(result.reminder.triggers, ["search_guidance"]);
    } else if (turn === 6) {
      assert.match(result.additionalContext, /proactively invoke/);
      assert.match(result.additionalContext, /Procedure context/);
      assert.deepEqual(result.reminder.triggers, ["cadence"]);
    } else if (turn === 11) {
      assert.match(result.additionalContext, /Personal memory routing|Procedure context/);
      assert.doesNotMatch(result.additionalContext, /proactively invoke|references\/memorax-search\.md|Profile context/);
    } else assert.equal(result, undefined);
  }
  assert.deepEqual(decisions, Array.from({ length: 11 }, (_, index) => "turn-" + (index + 1)));
  assert.equal(profiles, 2, "only initial and post-compaction prompts load Profile context");
  assert.equal(procedures, 3, "Procedure context retains turns 1, 6, and 11");
});

test("cancelled reminder delivery retains cadence and initial Profile for a retry or later turn", async (t) => {
  for (const scenario of [
    { cancelledTurn: 1, resumedTurn: 1, decision: "skip" },
    { cancelledTurn: 1, resumedTurn: 2, decision: "unavailable" },
    { cancelledTurn: 6, resumedTurn: 6, decision: "unavailable" },
    { cancelledTurn: 6, resumedTurn: 7, decision: "skip" },
  ]) {
    await t.test(JSON.stringify(scenario), async () => {
      const root = await mkdtemp(join(tmpdir(), "memorax-reminder-cancel-"));
      const statePath = join(root, "adapters", "shared-contract", "memory-skill-reminders.json");
      const profiles = [];
      const procedures = [];
      const input = (turn) => ({ sessionId: "session", turnId: `turn-${turn}` });
      const options = {
        memoraxCodeHome: root, adapterDir: "shared-contract", runtime: "shared-contract",
        additionalReminderContext: "Personal memory routing.",
        buildPersonalMemoryContext: async ({ turnId }) => { profiles.push(turnId); return "Profile context."; },
        buildCadenceReminderContext: async ({ turnId }) => { procedures.push(turnId); return "Procedure context."; },
      };
      try {
        for (let turn = 1; turn < scenario.cancelledTurn; turn += 1) {
          await evaluateMemorySkillReminder(options, input(turn));
        }
        const controller = new AbortController();
        let guidanceStarted;
        const started = new Promise((resolve) => { guidanceStarted = resolve; });
        const pending = evaluateMemorySkillReminder({
          ...options, signal: controller.signal,
          evaluateSearchGuidance: () => new Promise((resolve, reject) => {
            controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
            guidanceStarted();
          }),
        }, input(scenario.cancelledTurn));
        await started;
        controller.abort();
        assert.equal(await pending, undefined);

        let evaluations = 0;
        const resumedOptions = {
          ...options, systemMessage: "Pending quota notice.",
          evaluateSearchGuidance: async () => {
            evaluations += 1;
            return scenario.decision === "skip" ? { ok: true, decision: "skip" } : undefined;
          },
        };
        const result = await evaluateMemorySkillReminder(resumedOptions, input(scenario.resumedTurn));
        assert.equal(result.systemMessage, "Pending quota notice.");
        assert.match(result.additionalContext, /Procedure context/);
        if (scenario.cancelledTurn === 1) assert.match(result.additionalContext, /Profile context/);
        else assert.doesNotMatch(result.additionalContext, /Profile context/);
        if (scenario.decision === "skip") assert.doesNotMatch(result.additionalContext, /proactively invoke/);
        else assert.match(result.additionalContext, /proactively invoke/);
        assert.deepEqual(await evaluateMemorySkillReminder(resumedOptions, input(scenario.resumedTurn)), {
          systemMessage: "Pending quota notice.",
        });
        assert.equal(evaluations, 1, "delivered retries retain ordinary guidance deduplication");
        assert.equal(profiles.length, 1, "initial Profile is delivered once");
        assert.equal(procedures.length, scenario.cancelledTurn === 1 ? 1 : 2);
        const state = JSON.parse(await readFile(statePath, "utf8")).sessions.session;
        assert.equal(state.turnCount, scenario.resumedTurn, "same-turn retries do not count as another turn");
        assert.equal(state.lastTurnId, `turn-${scenario.resumedTurn}`);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("cancelled cadence restoration preserves a newer turn and independent compaction state", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-reminder-cancel-concurrent-"));
  const options = {
    memoraxCodeHome: root, adapterDir: "shared-contract", runtime: "shared-contract",
    supplementalReminderAfterCompact: true,
    additionalReminderContext: "Personal memory routing.",
    buildPersonalMemoryContext: async () => "Profile context.",
    buildCadenceReminderContext: async () => "Procedure context.",
  };
  const input = (turn) => ({ sessionId: "session", turnId: `turn-${turn}` });
  try {
    for (let turn = 1; turn <= 5; turn += 1) await evaluateMemorySkillReminder(options, input(turn));
    const controller = new AbortController();
    let guidanceStarted;
    const started = new Promise((resolve) => { guidanceStarted = resolve; });
    const pending = evaluateMemorySkillReminder({
      ...options, signal: controller.signal,
      evaluateSearchGuidance: () => new Promise((resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
        guidanceStarted();
      }),
    }, input(6));
    await started;
    assert.equal(await evaluateMemorySkillReminder(options, input(7)), undefined);
    markSupplementalReminderForSession(options, "session");
    controller.abort();
    assert.equal(await pending, undefined);
    const statePath = join(root, "adapters", "shared-contract", "memory-skill-reminders.json");
    const state = JSON.parse(await readFile(statePath, "utf8")).sessions.session;
    assert.equal(state.turnCount, 7);
    assert.equal(state.lastTurnId, "turn-7");
    assert.equal(state.supplementalReminderPending, true);
    let finishRetry;
    let retryStarted;
    const recovering = new Promise((resolve) => { retryStarted = resolve; });
    const recovery = evaluateMemorySkillReminder({
      ...options,
      evaluateSearchGuidance: () => new Promise((resolve) => {
        finishRetry = resolve;
        retryStarted();
      }),
    }, input(7));
    await recovering;
    markSupplementalReminderForSession(options, "session");
    finishRetry(undefined);
    const retry = await recovery;
    assert.match(retry.additionalContext, /Procedure context/);
    assert.match(retry.additionalContext, /Profile context/);
    assert.deepEqual(retry.reminder.triggers, ["cadence", "post_compaction"]);
    const recovered = JSON.parse(await readFile(statePath, "utf8")).sessions.session;
    assert.equal(recovered.turnCount, 7);
    assert.equal(recovered.supplementalReminderPending, true, "a later compaction event survives delivery");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
