import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

const read = async (name) => (await readFile(new URL(`../../../.github/workflows/${name}`, import.meta.url), "utf8"))
  .replaceAll("\r\n", "\n");
const workflows = { ci: await read("ci.yml"), native: await read("macos-codex-install.yml") };

// Pull request runs report exactly these checks for main's merge gate; branch protection is configured separately.
const FORMAL_CHECKS = {
  ci: { tests: "Tests", documentation: "Documentation", "workbuddy-result": "WorkBuddy functional result" },
  native: {
    "functional-result": "Codex functional result", "opencode-result": "OpenCode functional result",
    "claude-result": "Claude native smoke result", "codebuddy-result": "CodeBuddy functional result",
    "cursor-app-result": "Cursor App canary result",
  },
};
// The basic checks always execute, so push and manual runs keep their names.
const BASIC_CHECKS = new Set(["tests", "documentation"]);

const CI_ACCEPTANCE = ["tests", "documentation", "workbuddy-package", "workbuddy-native", "workbuddy-result"];
const NATIVE_ACCEPTANCE = ["package", "install", "opencode", "claude", "codebuddy", "cursor-app",
  "functional-result", "opencode-result", "claude-result", "codebuddy-result", "cursor-app-result"];

const pullRequest = (number, draft = false) => ({ event: "pull_request", ref: `refs/pull/${number}/merge`,
  payload: { pull_request: { number, draft, base: { ref: "main" } } } });
const push = { event: "push", ref: "refs/heads/main" };
const manual = (inputs, ref = "refs/heads/main") => ({ event: "workflow_dispatch", ref, inputs });

// The jobs each event or manual selection runs when every executed job succeeds.
const SCENARIOS = {
  ci: [
    ["pull request to main", pullRequest(7), CI_ACCEPTANCE],
    ["draft pull request to main", pullRequest(8, true), CI_ACCEPTANCE],
    ["push to main", push, CI_ACCEPTANCE],
    ["manual run", manual({ diagnose_workbuddy: false }), ["tests", "documentation"]],
    ["manual WorkBuddy diagnostics", manual({ diagnose_workbuddy: true }), CI_ACCEPTANCE],
  ],
  native: [
    ["pull request to main", pullRequest(7), NATIVE_ACCEPTANCE],
    ["draft pull request to main", pullRequest(8, true), NATIVE_ACCEPTANCE],
    ["push to main", push, NATIVE_ACCEPTANCE],
    ["manual functional run", manual({ check_deepseek: false, diagnose_opencode_initialization: false }), NATIVE_ACCEPTANCE],
    ["manual provider-only run", manual({ check_deepseek: true, diagnose_opencode_initialization: false }),
      ["functional-result", "provider"]],
    ["manual OpenCode initialization diagnostic", manual({ check_deepseek: false, diagnose_opencode_initialization: true }),
      ["package", "opencode-initialization-diagnostic"]],
    ["manual provider-only and OpenCode initialization", manual({ check_deepseek: true, diagnose_opencode_initialization: true }),
      ["package", "opencode-initialization-diagnostic"]],
  ],
};

// Source contracts, as in the other workflow tests; they complement actionlint rather than parse YAML.
function jobs(source) {
  return source.split("\njobs:\n")[1].split(/^(?=  [a-z][a-z0-9-]*:\n)/m).map((text) => {
    const field = (key) => text.match(new RegExp(`^    ${key}: (.+)$`, "m"))?.[1];
    const needs = field("needs");
    return { id: text.match(/^  ([a-z][a-z0-9-]*):\n/)[1], text, name: field("name"), condition: field("if"),
      needs: needs ? needs.replace(/^\[(.*)\]$/, "$1").split(", ") : [] };
  });
}

function triggers(source) {
  const block = source.split("\non:\n")[1].split(/\n(?=\S)/)[0];
  return Object.fromEntries(block.split(/^(?=  \S)/m).map((text) => {
    const [event, ...lines] = text.split("\n").filter(Boolean);
    return [event.trim().replace(/:$/, ""), lines];
  }));
}

// These expressions are also JavaScript once property access is null-safe, as in GitHub, and hyphenated names use brackets.
function evaluate(expression, scope) {
  const code = expression.split(/('[^']*')/).map((part, index) => index % 2 ? part
    : part.replace(/\.([A-Za-z_]\w*(?:-\w+)+)/g, '?.["$1"]').replace(/\.(?=[A-Za-z_])/g, "?.")).join("");
  return runInNewContext(code, scope, { timeout: 100 });
}
const expand = (template, scope) => template.replace(/\$\{\{ (.+?) \}\}/g, (_, expression) => String(evaluate(expression, scope)));

function context({ event, ref, inputs = {}, payload = {}, sha = "0".repeat(40), runId = 1 }, needs = {}) {
  return {
    github: { event_name: event, ref, event: payload, sha, run_id: runId }, inputs, needs,
    always: () => true, cancelled: () => false, failure: () => false,
    format: (pattern, ...values) => pattern.replace(/\{(\d+)\}/g, (_, index) => String(values[index])),
  };
}

// Decide in dependency order which jobs run when every executed job succeeds, and the check name each reports.
function plan(source, scenario) {
  const pending = jobs(source), needs = {}, planned = new Map();
  while (pending.length) {
    const index = pending.findIndex((job) => job.needs.every((id) => planned.has(id)));
    assert.notEqual(index, -1, "every job dependency is defined");
    const [job] = pending.splice(index, 1);
    const scope = context(scenario, needs);
    const condition = (job.condition ?? "success()").replace(/^\$\{\{ (.+) \}\}$/, "$1");
    // Without a status function, a job also requires every dependency to succeed.
    const status = /\b(?:always|success|failure|cancelled)\(\)/.test(condition);
    const succeeded = job.needs.every((id) => needs[id].result === "success");
    const runs = Boolean(evaluate(status ? condition : `success() && (${condition})`, { ...scope, success: () => succeeded }));
    // Native client jobs also require the package job's validated-artifact marker.
    needs[job.id] = { result: runs ? "success" : "skipped", outputs: runs && job.id === "package" ? { "artifact-ready": "true" } : {} };
    // `name` is the evaluated name; `raw` is the unevaluated expression that earlier runs listed for skipped jobs.
    const name = !job.name ? job.id : job.name.includes("matrix.") ? job.name : expand(job.name, scope);
    const raw = job.name ? job.name.replace(/^\$\{\{ (.+) \}\}$/, "$1") : job.id;
    planned.set(job.id, { runs, name, raw });
  }
  return planned;
}

test("both workflows run on every pull request to main and every push to main without filters", () => {
  for (const [workflow, inputs] of [["ci", ["diagnose_workbuddy"]], ["native", ["check_deepseek", "diagnose_opencode_initialization"]]]) {
    const on = triggers(workflows[workflow]);
    assert.deepEqual(Object.keys(on).sort(), ["pull_request", "push", "workflow_dispatch"], workflow);
    assert.deepEqual(on.pull_request, ["    branches: [main]"], workflow);
    assert.deepEqual(on.push, ["    branches: [main]"], workflow);
    const dispatch = on.workflow_dispatch.join("\n");
    assert.deepEqual([...dispatch.matchAll(/^      ([a-z_]+):$/gm)].map((match) => match[1]), inputs, workflow);
    assert.equal(dispatch.match(/^        type: boolean$/gm)?.length, inputs.length, workflow);
    assert.equal(dispatch.match(/^        default: false$/gm)?.length, inputs.length, workflow);
  }
});

test("each event and manual selection runs exactly its intended jobs", () => {
  for (const [workflow, scenarios] of Object.entries(SCENARIOS)) {
    for (const [label, scenario, expected] of scenarios) {
      const planned = [...plan(workflows[workflow], scenario)].filter(([, job]) => job.runs).map(([id]) => id);
      assert.deepEqual(planned.sort(), [...expected].sort(), `${workflow}: ${label}`);
    }
  }
});

test("only pull request runs report the formal check names, each from one job that runs", () => {
  const names = Object.values(FORMAL_CHECKS).flatMap((checks) => Object.values(checks));
  assert.equal(new Set(names).size, 8);
  const purpose = { push: "main push", workflow_dispatch: "manual run" };
  for (const [workflow, scenarios] of Object.entries(SCENARIOS)) {
    for (const [label, scenario] of scenarios) {
      const planned = plan(workflows[workflow], scenario);
      for (const id of Object.keys(FORMAL_CHECKS[workflow])) assert.ok(planned.has(id), `${workflow}: ${id}`);
      for (const [id, job] of planned) {
        const check = FORMAL_CHECKS[workflow][id];
        const where = `${workflow}: ${label}: ${id}`;
        if (!check || (!job.runs && scenario.event !== "pull_request")) {
          // Neither the evaluated nor the unevaluated name of a skipped job may be a formal name.
          assert.ok(!names.includes(job.name) && !names.includes(job.raw), where);
        } else if (scenario.event === "pull_request" || BASIC_CHECKS.has(id)) {
          assert.equal(job.name, check, where);
          assert.equal(job.runs, true, where);
        } else {
          const provider = id === "functional-result" && scenario.inputs?.check_deepseek;
          assert.equal(job.name, provider ? "Codex provider-only result" : `${check} (${purpose[scenario.event]})`, where);
        }
      }
    }
  }
});

test("every formal result reports after failures and passes only when every executed dependency succeeded", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workflow-results-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scenario = pullRequest(7);
  for (const [workflow, checks] of Object.entries(FORMAL_CHECKS)) {
    const planned = plan(workflows[workflow], scenario);
    for (const job of jobs(workflows[workflow]).filter((item) => checks[item.id] && item.needs.length)) {
      assert.match(job.condition, /^always\(\) && /, job.id);
      const [step, ...others] = job.text.split("\n      - ").slice(1);
      assert.equal(others.length, 0, job.id);
      const env = [...step.matchAll(/^          ([A-Z_]+): \$\{\{ (.+) \}\}$/gm)];
      const script = step.split("\n        run: |\n")[1].split("\n").map((line) => line.slice(10)).join("\n");
      // Dependencies that a pull request run skips by design, such as the provider check, keep that result.
      const executed = job.needs.filter((id) => planned.get(id).runs);
      assert.ok(executed.length >= 2, job.id);
      const cases = [{}, ...executed.flatMap((id) => ["failure", "cancelled", "skipped"].map((result) => ({ [id]: result })))];
      for (const override of cases) {
        const needs = Object.fromEntries(job.needs.map((id) => [id, {
          result: override[id] ?? (planned.get(id).runs ? "success" : "skipped"),
          outputs: { coverage: "Synthetic release coverage." },
        }]));
        const label = Object.entries(override).flat().join("-") || "success";
        const actual = spawnSync("/bin/bash", ["-e", "-o", "pipefail", "-c", script], {
          cwd: root, encoding: "utf8", timeout: 5_000,
          env: { PATH: "/usr/bin:/bin", HOME: root, GITHUB_STEP_SUMMARY: join(root, `${job.id}-${label}.md`),
            ...Object.fromEntries(env.map(([, name, expression]) => [name, String(evaluate(expression, context(scenario, needs)))])) },
        });
        assert.ifError(actual.error);
        assert.equal(actual.status, label === "success" ? 0 : 1, `${job.id}: ${label}`);
      }
    }
  }
});

test("concurrency cancels only an older run of the same pull request, main push or manual selection", () => {
  const groups = [];
  for (const [workflow, source] of Object.entries(workflows)) {
    const [, group, cancel] = source.match(/^concurrency:\n(?:  #.*\n)*  group: (.+)\n  cancel-in-progress: (.+)$/m) ?? [];
    assert.ok(group, workflow);
    assert.equal(cancel, "true", workflow);
    const another = SCENARIOS[workflow].find(([label]) => label.startsWith("manual"))[1];
    const scenarios = [...SCENARIOS[workflow].map(([, scenario]) => scenario), { ...another, ref: "refs/heads/feature" }];
    const runs = scenarios.map((scenario) => ({ ...scenario, workflow, group: expand(group, context(scenario)),
      jobs: [...plan(source, scenario)].filter(([, job]) => job.runs).map(([id]) => id).join() }));
    for (const run of runs) {
      // A newer run of the same purpose and ref joins the older run's group, so it replaces that run.
      assert.equal(expand(group, context({ ...run, sha: "f".repeat(40), runId: 2 })), run.group, run.group);
    }
    groups.push(...runs);
  }
  for (const [index, left] of groups.entries()) {
    for (const right of groups.slice(index + 1)) {
      if (left.group !== right.group) continue;
      // Distinct scenarios share a group only when they are the same manual selection of one workflow on one ref.
      assert.ok(left.workflow === right.workflow && left.event === "workflow_dispatch" && right.event === left.event
        && left.ref === right.ref && left.jobs === right.jobs, left.group);
    }
  }
});

test("the Tests job runs these workflow contracts", () => {
  const tests = jobs(workflows.ci).find((job) => job.id === "tests").text;
  assert.match(tests, /^        run: node --test scripts\/ci\/shared\/workflow-scenarios\.test\.mjs$/m);
});
