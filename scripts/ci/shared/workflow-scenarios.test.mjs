import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { decide, render } from "./client-result.mjs";
import { CLIENTS } from "./native-scope.mjs";

const read = async (name) => (await readFile(new URL(`../../../.github/workflows/${name}`, import.meta.url), "utf8"))
  .replaceAll("\r\n", "\n");
const workflows = { ci: await read("ci.yml"), native: await read("macos-codex-install.yml") };

// Pull request runs report these checks under these names; branch protection is configured separately and targets Tests,
// Documentation and PR acceptance. A pull request runs a client's result only when its scope selects that client.
const FORMAL_CHECKS = {
  ci: { tests: "Tests", documentation: "Documentation" },
  native: {
    "functional-result": "Codex functional result", "opencode-result": "OpenCode functional result",
    "claude-result": "Claude native smoke result", "codebuddy-result": "CodeBuddy functional result",
    "cursor-app-result": "Cursor App canary result", "workbuddy-result": "WorkBuddy functional result",
    "pr-acceptance": "PR acceptance",
  },
};
// The formal result job of each native client.
const CLIENT_RESULTS = { codex: "functional-result", opencode: "opencode-result", claude: "claude-result",
  codebuddy: "codebuddy-result", cursor: "cursor-app-result", workbuddy: "workbuddy-result" };
// The basic checks always execute, so push, manual and called runs keep their names.
const BASIC_CHECKS = new Set(["tests", "documentation"]);
const MODES = ["release-acceptance", "provider-only", "opencode-initialization-diagnostic", "workbuddy-download-diagnostic"];

const WORKBUDDY = ["workbuddy-releases", "workbuddy-native", "workbuddy-result"];
const ACCEPTANCE = ["package", "install", "opencode", "claude", "codebuddy", "cursor-app", "functional-result",
  "opencode-result", "claude-result", "codebuddy-result", "cursor-app-result", ...WORKBUDDY];
const RELEASE = [...ACCEPTANCE, "candidate", "basic-checks", "release-result"];
// Every pull request also selects its native clients and reports PR acceptance; it always verifies the package and,
// in workbuddy-releases, the contracts.
const PULL_REQUEST = ["scope", "pr-acceptance"];

// `selected` stands for the clients the scope job selects from the pull request's changes.
const pullRequest = (number, draft = false, selected = CLIENTS) => ({ event: "pull_request", ref: `refs/pull/${number}/merge`,
  payload: { pull_request: { number, draft, base: { ref: "main" } } }, selected });
const push = { event: "push", ref: "refs/heads/main" };
const schedule = { event: "schedule", ref: "refs/heads/main" };
const manual = (inputs, ref = "refs/heads/main") => ({ event: "workflow_dispatch", ref, inputs });
const called = (purpose) => ({ event: "workflow_dispatch", ref: "refs/heads/main",
  inputs: { purpose, "candidate-sha": "0".repeat(40), "docs-base-sha": "1".repeat(40) } });

// The jobs each event or manual selection runs when every executed job succeeds. A main push runs only the package
// health check here and the basic checks in CI; a pull request runs the matrices of the clients its scope selects, and
// the compatibility monitor and release acceptance run the complete acceptance.
const SCENARIOS = {
  ci: [
    ["pull request to main", pullRequest(7), ["tests", "documentation"]],
    ["draft pull request to main", pullRequest(8, true), ["tests", "documentation"]],
    ["push to main", push, ["tests", "documentation"]],
    ["manual run", manual({}), ["tests", "documentation"]],
    ["release acceptance call", called("release-acceptance"), ["tests", "documentation"]],
  ],
  native: [
    ["pull request to main", pullRequest(7), [...ACCEPTANCE, ...PULL_REQUEST]],
    ["draft pull request to main", pullRequest(8, true), [...ACCEPTANCE, ...PULL_REQUEST]],
    ["pull request that selects no native client", pullRequest(9, false, []), ["package", "workbuddy-releases", ...PULL_REQUEST]],
    ["pull request that selects only Cursor App", pullRequest(10, false, ["cursor"]),
      ["package", "workbuddy-releases", "cursor-app", "cursor-app-result", ...PULL_REQUEST]],
    ["pull request that selects only WorkBuddy", pullRequest(11, false, ["workbuddy"]), ["package", ...WORKBUDDY, ...PULL_REQUEST]],
    ["push to main", push, ["package"]],
    ["compatibility monitor", schedule, [...ACCEPTANCE, "acceptance-refresh"]],
    ["release acceptance on main", manual({ mode: "release-acceptance", expected_sha: "" }), RELEASE],
    ["release acceptance on a branch", manual({ mode: "release-acceptance", expected_sha: "" }, "refs/heads/feature"), RELEASE],
    ["provider-only diagnostic", manual({ mode: "provider-only", expected_sha: "" }), ["functional-result", "provider"]],
    ["OpenCode initialization diagnostic", manual({ mode: "opencode-initialization-diagnostic", expected_sha: "" }),
      ["package", "opencode-initialization-diagnostic"]],
    ["WorkBuddy download diagnostic", manual({ mode: "workbuddy-download-diagnostic", expected_sha: "" }), ["package", ...WORKBUDDY]],
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
// The scope job's outputs for the clients it selects.
const selection = (selected) => Object.fromEntries(CLIENTS.map((client) => [client, String(selected.includes(client))]));

function context({ event, ref, inputs = {}, payload = {}, sha = "0".repeat(40), runId = 1 }, needs = {}) {
  return {
    github: { event_name: event, ref, event: payload, sha, run_id: runId }, inputs, needs,
    always: () => true, cancelled: () => false, failure: () => false,
    format: (pattern, ...values) => pattern.replace(/\{(\d+)\}/g, (_, index) => String(values[index])),
    toJSON: (value) => JSON.stringify(value, null, 2),
  };
}

// Decide in dependency order which jobs run, and the check name each reports. Every executed job succeeds unless it
// is listed in `failing`.
function plan(source, scenario, failing = []) {
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
    const result = !runs ? "skipped" : failing.includes(job.id) ? "failure" : "success";
    // Native client jobs also require the package job's validated-artifact marker and, on a pull request, the selection
    // that a successful scope job reports.
    needs[job.id] = { result, outputs: runs && job.id === "package" ? { "artifact-ready": "true" }
      : result === "success" && job.id === "scope" ? selection(scenario.selected) : {} };
    // `name` is the evaluated name; `raw` is the unevaluated expression that earlier runs listed for skipped jobs.
    const name = !job.name ? job.id : job.name.includes("matrix.") ? job.name : expand(job.name, scope);
    const raw = job.name ? job.name.replace(/^\$\{\{ (.+) \}\}$/, "$1") : job.id;
    planned.set(job.id, { runs, name, raw, ...needs[job.id] });
  }
  return planned;
}

const ran = (planned) => [...planned].filter(([, job]) => job.runs).map(([id]) => id).sort();
const needsOf = (planned) => Object.fromEntries([...planned].map(([id, { result, outputs }]) => [id, { result, outputs }]));

test("both workflows run on every pull request to main and every push to main without filters", () => {
  for (const workflow of ["ci", "native"]) {
    const on = triggers(workflows[workflow]);
    assert.deepEqual(on.pull_request, ["    branches: [main]"], workflow);
    assert.deepEqual(on.push, ["    branches: [main]"], workflow);
  }
  const ci = triggers(workflows.ci);
  assert.deepEqual(Object.keys(ci).sort(), ["pull_request", "push", "workflow_call", "workflow_dispatch"]);
  assert.deepEqual(ci.workflow_dispatch, []);
  const call = ci.workflow_call.join("\n");
  assert.deepEqual([...call.matchAll(/^      ([a-z-]+):$/gm)].map((match) => match[1]), ["purpose", "candidate-sha", "docs-base-sha"]);
  assert.equal(call.match(/^        type: string\n        required: true$/gm)?.length, 3);
  const native = triggers(workflows.native);
  assert.deepEqual(Object.keys(native).sort(), ["pull_request", "push", "schedule", "workflow_dispatch"]);
  // The daily compatibility monitor runs the complete native matrix on main.
  assert.deepEqual(native.schedule.filter((line) => !/^ *#/.test(line)), ["    - cron: '17 3 * * *'"]);
  const dispatch = native.workflow_dispatch.join("\n");
  assert.deepEqual([...dispatch.matchAll(/^      ([a-z_]+):$/gm)].map((match) => match[1]), ["mode", "expected_sha"]);
  // A manual run without a selection is the complete release acceptance, never a diagnostic.
  assert.match(dispatch, /^      mode:\n        description: .+\n        type: choice\n        default: release-acceptance\n        options:\n((?:          - .+\n)+)/m);
  assert.deepEqual([...dispatch.matchAll(/^          - (.+)$/gm)].map((match) => match[1]), MODES);
  assert.match(dispatch, /^      expected_sha:\n        description: .+\n        type: string\n        default: ''$/m);
});

test("each event and manual selection runs exactly its intended jobs", () => {
  for (const [workflow, scenarios] of Object.entries(SCENARIOS)) {
    for (const [label, scenario, expected] of scenarios) {
      assert.deepEqual(ran(plan(workflows[workflow], scenario)), [...expected].sort(), `${workflow}: ${label}`);
    }
  }
});

test("release eligibility never decides which acceptance jobs run", () => {
  for (const job of jobs(workflows.native)) {
    assert.doesNotMatch(job.condition ?? "", /candidate|eligib|expected_sha/, job.id);
  }
  for (const ref of ["refs/heads/main", "refs/heads/feature"]) {
    const scenario = manual({ mode: "release-acceptance", expected_sha: "f".repeat(40) }, ref);
    assert.deepEqual(ran(plan(workflows.native, scenario, ["candidate"])), [...RELEASE].sort(), ref);
  }
});

test("only pull request runs report the formal check names, each from one job that runs when its client is selected", () => {
  const names = Object.values(FORMAL_CHECKS).flatMap((checks) => Object.values(checks));
  assert.equal(new Set(names).size, 9);
  assert.deepEqual(Object.values(CLIENT_RESULTS).sort(), Object.keys(FORMAL_CHECKS.native).filter((id) => id !== "pr-acceptance").sort());
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
          // A pull request skips the result of each client its scope does not select; PR acceptance reports that client
          // as not validated. Earlier runs listed a skipped job under its unevaluated name, which must not be a formal name.
          const client = Object.keys(CLIENT_RESULTS).find((item) => CLIENT_RESULTS[item] === id);
          assert.equal(job.runs, scenario.event !== "pull_request" || !client || scenario.selected.includes(client), where);
          if (!job.runs) assert.ok(!names.includes(job.raw), where);
        } else {
          const provider = id === "functional-result" && scenario.inputs?.mode === "provider-only";
          const purpose = { push: "main push", schedule: "compatibility monitor" }[scenario.event] ?? scenario.inputs.mode;
          assert.equal(job.name, provider ? "Codex provider-only result" : `${check} (${purpose})`, where);
        }
      }
    }
  }
});

const REPOSITORY = fileURLToPath(new URL("../../../", import.meta.url));

// Run a formal result's decision step from the repository against these dependency results, as GitHub would: an unset
// output reads as ''. A client result classifies the cells of attempt 1 of the scenario's run, listed in RUNNER_TEMP.
function runResult(root, job, scenario, needs, label) {
  const steps = job.text.split("\n      - ").slice(1).filter((item) => item.startsWith("name: Require "));
  assert.equal(steps.length, 1, job.id);
  const [step] = steps;
  const env = [...step.matchAll(/^          ([A-Z_]+): \$\{\{ (.+) \}\}$/gm)];
  const script = step.split("\n        run: |\n")[1].split("\n").map((line) => line.slice(10)).join("\n");
  const summary = join(root, `${job.id}-${label}.md`);
  const actual = spawnSync("/bin/bash", ["-e", "-o", "pipefail", "-c", script], {
    cwd: REPOSITORY, encoding: "utf8", timeout: 5_000,
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root, RUNNER_TEMP: root, GITHUB_STEP_SUMMARY: summary,
      GITHUB_EVENT_NAME: scenario.event, GITHUB_RUN_ID: String(scenario.runId ?? 1), GITHUB_RUN_ATTEMPT: "1",
      ...Object.fromEntries(env.map(([, name, expression]) => [name, String(evaluate(expression, context(scenario, needs)) ?? "")])) },
  });
  assert.ifError(actual.error);
  return { status: actual.status, summary };
}

test("every formal result reports after failures and passes only when every executed dependency succeeded", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "workflow-results-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scenario = pullRequest(7);
  const planned = plan(workflows.native, scenario);
  for (const job of jobs(workflows.native).filter((item) => FORMAL_CHECKS.native[item.id])) {
    assert.match(job.condition, /^always\(\) && /, job.id);
    // PR acceptance has one step; a client result reads this attempt's jobs, decides and uploads the record it wrote.
    const heads = job.text.split("\n      - ").slice(1).map((step) => step.split("\n")[0]);
    if (job.id === "pr-acceptance") assert.equal(heads.length, 1, job.id);
    else assert.deepEqual(heads.map((head) => head.replace(/^name: Require .+$/, "name: Require")), ["uses: actions/checkout@v7",
      "uses: actions/setup-node@v7", "name: Read this attempt's jobs", "name: Require", "uses: actions/upload-artifact@v7"], job.id);
    // Dependencies that a pull request run skips by design, such as the provider check, keep that result. A client
    // result needs the scope only for its selection; PR acceptance also requires the scope to succeed.
    const executed = job.needs.filter((id) => planned.get(id).runs && (id !== "scope" || job.id === "pr-acceptance"));
    assert.ok(executed.length >= 2, job.id);
    const cases = [{}, ...executed.flatMap((id) => ["failure", "cancelled", "skipped"].map((result) => ({ [id]: result })))];
    for (const override of cases) {
      const needs = Object.fromEntries(job.needs.map((id) => [id, {
        result: override[id] ?? planned.get(id).result,
        outputs: { ...planned.get(id).outputs, coverage: "Synthetic release coverage." },
      }]));
      const label = Object.entries(override).flat().join("-") || "success";
      assert.equal(runResult(root, job, scenario, needs, label).status, label === "success" ? 0 : 1, `${job.id}: ${label}`);
    }
  }
});

test("PR acceptance passes only when each selected client passes and every other client is skipped", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pr-acceptance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const job = jobs(workflows.native).find((item) => item.id === "pr-acceptance");
  assert.deepEqual(job.needs, ["scope", "package", "workbuddy-releases", ...Object.values(CLIENT_RESULTS)]);
  for (const selected of [[], ...CLIENTS.map((client) => [client]), CLIENTS]) {
    const scenario = pullRequest(12, false, selected);
    const needs = needsOf(plan(workflows.native, scenario));
    const label = selected.join("-") || "none";
    const { status, summary } = runResult(root, job, scenario, needs, label);
    assert.equal(status, 0, label);
    const text = await readFile(summary, "utf8");
    assert.equal((text.match(/\| not selected: this pull request does not validate it \|/g) ?? []).length, CLIENTS.length - selected.length, label);
    assert.equal((text.match(/\| selected: passed \|/g) ?? []).length, selected.length, label);
    // A selected client whose result was skipped has not passed; an unselected client's result must not run.
    for (const [client, id] of Object.entries(CLIENT_RESULTS)) {
      for (const result of selected.includes(client) ? ["skipped", "failure", "cancelled"] : ["success", "failure", "cancelled"]) {
        const changed = { ...needs, [id]: { ...needs[id], result } };
        assert.equal(runResult(root, job, scenario, changed, `${label}-${client}-${result}`).status, 1, `${label}: ${client} ${result}`);
      }
    }
  }
  // A missing or malformed selection fails, and a failed scope selects nothing and fails.
  const scenario = pullRequest(13, false, []);
  const needs = needsOf(plan(workflows.native, scenario));
  for (const value of ["", "yes", "True"]) {
    const changed = { ...needs, scope: { result: "success", outputs: { ...needs.scope.outputs, codex: value } } };
    assert.equal(runResult(root, job, scenario, changed, `codex-${value || "unset"}`).status, 1, `codex=${value}`);
  }
  const failed = plan(workflows.native, pullRequest(14), ["scope"]);
  assert.deepEqual(ran(failed), ["package", "pr-acceptance", "scope", "workbuddy-releases"]);
  assert.equal(runResult(root, job, pullRequest(14), needsOf(failed), "scope-failure").status, 1);
});

test("concurrency cancels only an older run of the same purpose and never a release acceptance", () => {
  const groups = [];
  for (const [workflow, source] of Object.entries(workflows)) {
    const [, group, cancel] = source.match(/^concurrency:\n(?:  #.*\n)*  group: (.+)\n  cancel-in-progress: (.+)$/m) ?? [];
    assert.ok(group, workflow);
    const another = SCENARIOS[workflow].find(([label]) => /manual|diagnostic/.test(label))[1];
    const scenarios = [...SCENARIOS[workflow].map(([, scenario]) => scenario), { ...another, ref: "refs/heads/feature" }];
    for (const scenario of scenarios) {
      // Every run has its own run ID.
      const runId = groups.length + 1;
      const run = { ...scenario, workflow, group: expand(group, context({ ...scenario, runId })),
        cancel: expand(cancel, context({ ...scenario, runId })), jobs: ran(plan(source, scenario)).join() };
      const newer = expand(group, context({ ...scenario, sha: "f".repeat(40), runId: runId + 1000 }));
      const release = scenario.inputs?.mode === "release-acceptance" || Boolean(scenario.inputs?.purpose);
      if (release) {
        // Each release acceptance, and the basic checks it calls, keep a group of their own and are never cancelled.
        assert.notEqual(newer, run.group, run.group);
        assert.equal(run.cancel, "false", run.group);
      } else {
        // A newer run of the same purpose and ref joins the older run's group, so it replaces that run.
        assert.equal(newer, run.group, run.group);
        assert.equal(run.cancel, "true", run.group);
      }
      groups.push(run);
    }
  }
  for (const [index, left] of groups.entries()) {
    for (const right of groups.slice(index + 1)) {
      if (left.group !== right.group) continue;
      // Distinct scenarios share a group only when they are the same manual selection of one workflow on one ref.
      assert.ok(left.workflow === right.workflow && left.event === "workflow_dispatch" && right.event === left.event
        && left.ref === right.ref && left.jobs === right.jobs, left.group);
    }
  }
  // The called basic checks never share the calling release acceptance's group.
  const release = manual({ mode: "release-acceptance", expected_sha: "" });
  const caller = expand(workflows.native.match(/^  group: (.+)$/m)[1], context(release));
  const callee = expand(workflows.ci.match(/^  group: (.+)$/m)[1], context(called("release-acceptance")));
  assert.notEqual(caller, callee);
});

// The package output through which client jobs consume each client's versions, and the package job steps that produce it:
// one reads the pinned acceptance versions for a pull request, the other asks npm or a desktop release feed for the latest
// versions. The Cursor release inventory either step freezes is kept as an artifact.
const LOOKUPS = new Map([["codex-matrix", ["codex-accepted", "codex-versions"]],
  ["opencode-matrix", ["opencode-accepted", "opencode-versions"]], ["claude-matrix", ["claude-accepted", "claude-versions"]],
  ["codebuddy-matrix", ["codebuddy-accepted", "codebuddy-versions"]], ["cursor-matrix", ["cursor-accepted", "cursor-versions"]],
  ["cursor-releases-artifact-name", ["cursor-app-releases-attempt${{ github.run_attempt }}"]]]);

test("the package job reads client versions only when a job consumes them, pinned for a pull request, and always checks the package", () => {
  const native = jobs(workflows.native);
  const text = native.find((job) => job.id === "package").text;
  const outputs = Object.fromEntries([...text.split("\n    outputs:\n")[1].split("\n    steps:\n")[0]
    .matchAll(/^      ([a-z-]+): (.+)$/gm)].map(([, name, value]) => [name, value]));
  // A step is known by its ID, else by the artifact it uploads or its name.
  const steps = `\n${text.split("\n    steps:\n")[1]}`.split("\n      - ").slice(1).map((step) => ({ text: step,
    key: (step.match(/^        id: (.+)$/m) ?? step.match(/^          name: (.+)$/m) ?? step.match(/^(?:name|uses): (.+)$/m))[1],
    condition: step.match(/^        if: (.+)$/m)?.[1] }));
  // Every executed step succeeds, as in plan(), and on a pull request reads the scope's selection.
  const runs = (step, scenario, planned = new Map()) => Boolean(evaluate(step.condition ?? "success()", {
    ...context(scenario, needsOf(planned)), success: () => true, steps: { "package-check": { outputs: { "artifact-ready": "true" } } } }));
  const requests = steps.filter((step) => /\bnpm view |dist-tags|cursor-app-release\.mjs resolve-/.test(step.text)).map((step) => step.key);
  assert.deepEqual(requests, ["codex-versions", "opencode-versions", "claude-versions", "codebuddy-versions", "cursor-versions"]);
  const pinned = steps.filter((step) => /client-acceptance\.mjs npm-matrix |cursor-app-release\.mjs accepted /.test(step.text))
    .map((step) => step.key);
  assert.deepEqual(pinned, ["codex-accepted", "opencode-accepted", "claude-accepted", "codebuddy-accepted", "cursor-accepted"]);
  const plans = SCENARIOS.native.map(([label, scenario]) => [label, scenario, plan(workflows.native, scenario)]);
  for (const [output, keys] of LOOKUPS) {
    const selected = keys.map((key) => steps.find((item) => item.key === key));
    assert.ok(selected.every(Boolean), output);
    assert.equal(outputs[output], keys.length === 1 ? keys[0] : `\${{ ${keys.map((key) => `steps.${key}.outputs.matrix`).join(" || ")} }}`, output);
    const consumers = native.filter((job) => job.text.includes(`needs.package.outputs.${output}`)).map((job) => job.id);
    assert.ok(consumers.length, output);
    for (const [label, scenario, planned] of plans) {
      const ran = selected.map((step) => planned.get("package").runs && runs(step, scenario, planned));
      assert.equal(ran.some(Boolean), consumers.some((id) => planned.get(id).runs), `${label}: ${output}`);
      // A pull request reads only the pinned versions and every other run only the latest ones, never both.
      if (keys.length === 2 && ran.some(Boolean)) {
        assert.deepEqual(ran, [scenario.event === "pull_request", scenario.event !== "pull_request"], `${label}: ${output}`);
      }
    }
  }
  // A main push, and a pull request that selects no client, skip only these steps: they still verify the contracts,
  // build and check the package, and upload it with its identity record.
  const lookups = [...LOOKUPS.values()].flat();
  for (const scenario of [push, pullRequest(9, false, [])]) {
    assert.deepEqual(steps.filter((step) => runs(step, scenario, plan(workflows.native, scenario))).map((step) => step.key),
      steps.map((step) => step.key).filter((key) => !lookups.includes(key)), scenario.event);
  }
  // Only the identity record and its upload may fail without failing the package job.
  assert.deepEqual(steps.filter((step) => /^        continue-on-error: true$/m.test(step.text)).map((step) => step.key),
    ["Record the candidate package and frozen client versions", "native-client-inputs-attempt${{ github.run_attempt }}"]);
});

test("release acceptance calls the basic checks with explicit inputs and reads the exact candidate artifact", () => {
  const native = Object.fromEntries(jobs(workflows.native).map((job) => [job.id, job.text]));
  assert.match(native["basic-checks"], /^    uses: \.\/\.github\/workflows\/ci\.yml\n    with:\n      purpose: release-acceptance\n      candidate-sha: \$\{\{ github\.sha \}\}\n      docs-base-sha: \$\{\{ needs\.candidate\.outputs\.docs-base-sha \}\}$/m);
  const ci = Object.fromEntries(jobs(workflows.ci).map((job) => [job.id, job.text]));
  for (const id of ["tests", "documentation"]) assert.match(ci[id], /^          ref: \$\{\{ inputs\.candidate-sha \|\| github\.sha \}\}$/m);
  assert.match(ci.documentation, /^          README_SYNC_BASE_REF: \$\{\{ inputs\.docs-base-sha \|\| /m);
  assert.doesNotMatch(workflows.ci, /workflow_call'/);
  const result = native["release-result"];
  assert.match(result, /^    permissions:\n      contents: read\n      actions: read$/m);
  assert.match(result, /^          artifact-ids: \$\{\{ needs\.package\.outputs\.package-artifact-id \}\}$/m);
  assert.match(result, /^          NEEDS_JSON: \$\{\{ toJSON\(needs\) \}\}$/m);
  assert.match(result, /node scripts\/ci\/shared\/release-acceptance\.mjs record /);
  assert.match(result, /^          name: release-acceptance-record-attempt\$\{\{ github\.run_attempt \}\}$/m);
  assert.match(native.candidate, /^          EXPECTED_SHA: \$\{\{ inputs\.expected_sha \}\}$/m);
  assert.match(native.candidate, /--expected-sha "\$EXPECTED_SHA"/);
  // Manual and calling inputs reach shell code only through environment variables.
  const blocks = Object.values(workflows).flatMap(runBlocks);
  assert.ok(blocks.length > 40);
  for (const block of blocks) assert.doesNotMatch(block, /\$\{\{ inputs\./);
});

test("the release result reads every attempt and marks a failed read instead of writing a listing", { skip: process.platform === "win32" }, async (t) => {
  const result = Object.fromEntries(jobs(workflows.native).map((job) => [job.id, job.text]))["release-result"];
  const step = result.split("      - name: Read the candidate artifact record and every attempt's jobs\n")[1]?.split("\n      - ")[0];
  assert.ok(step);
  assert.match(step, /^        continue-on-error: true$/m);
  const script = step.split("\n        run: |\n")[1].split("\n").map((line) => line.slice(10)).join("\n");
  const root = await mkdtemp(join(tmpdir(), "release-api-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  // A stand-in for gh: attempt 2's pages cannot all be read and the artifact query fails after writing output.
  const gh = [
    'gh() {',
    '  case "$*" in',
    '    *attempts/2/jobs*) printf \'[{"total_count":2,"jobs":[\'; return 1 ;;',
    '    *attempts/*/jobs*) printf \'[{"total_count":1,"jobs":[{"id":1}]}]\' ;;',
    '    *artifacts/*) printf \'{"message":"Server Error"}\'; return 1 ;;',
    '  esac',
    '}',
  ].join("\n");
  const run = spawnSync("/bin/bash", ["-e", "-o", "pipefail", "-c", `${gh}\n${script}`], { cwd: root, encoding: "utf8", timeout: 5_000,
    env: { PATH: "/usr/bin:/bin", HOME: root, RUNNER_TEMP: root, PACKAGE_ARTIFACT_ID: "123", GITHUB_REPOSITORY: "memorax-ai/memorax-code",
      GITHUB_RUN_ID: "999", GITHUB_RUN_ATTEMPT: "3" } });
  assert.equal(run.status, 0, run.stderr);
  const api = join(root, "release-api");
  const { readdir } = await import("node:fs/promises");
  assert.deepEqual((await readdir(api)).sort(), ["attempt-1.json", "attempt-2.failed", "attempt-3.json"]);
  assert.equal(await readFile(join(api, "attempt-3.json"), "utf8"), '[{"total_count":1,"jobs":[{"id":1}]}]');
});

test("each client result reads only this attempt's jobs, and a provider-only run uploads no record", { skip: process.platform === "win32" }, async (t) => {
  const results = jobs(workflows.native).filter((job) => Object.values(CLIENT_RESULTS).includes(job.id));
  assert.equal(results.length, 6);
  for (const job of results) {
    assert.match(job.text, /^    timeout-minutes: 5\n    permissions:\n      contents: read\n      actions: read\n    steps:\n/m, job.id);
  }
  // Every client result checks out the repository without credentials, sets up Node and reads the listing alike.
  const shared = new Set(results.map((job) => job.text.split("\n      - ").slice(1, 4).join("\n      - ")));
  assert.equal(shared.size, 1);
  const [checkout, setup, listing] = [...shared][0].split("\n      - ");
  assert.equal(checkout, "uses: actions/checkout@v7\n        with:\n          persist-credentials: false");
  assert.equal(setup, "uses: actions/setup-node@v7\n        with:\n          node-version-file: .node-version\n          package-manager-cache: false");
  assert.match(listing, /^          GH_TOKEN: \$\{\{ github\.token \}\}$/m);
  const script = listing.split("\n        run: |\n")[1].split("\n").map((line) => line.slice(10)).join("\n");
  const root = await mkdtemp(join(tmpdir(), "client-api-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [status, file, content] of [[0, "attempt-3.json", '[{"total_count":1,"jobs":[{"id":1}]}]'], [1, "attempt-3.failed", ""]]) {
    const temp = await mkdtemp(join(root, "runner-"));
    // A stand-in for gh that records its arguments and writes a page even when the query fails.
    const gh = `gh() { printf '%s\\n' "$@" > "$RUNNER_TEMP/gh-args"; printf '[{"total_count":1,"jobs":[{"id":1}]}]'; return ${status}; }`;
    const run = spawnSync("/bin/bash", ["-e", "-o", "pipefail", "-c", `${gh}\n${script}`], { cwd: temp, encoding: "utf8", timeout: 5_000,
      env: { PATH: "/usr/bin:/bin", HOME: temp, RUNNER_TEMP: temp, GITHUB_REPOSITORY: "memorax-ai/memorax-code",
        GITHUB_RUN_ID: "999", GITHUB_RUN_ATTEMPT: "3" } });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual((await readFile(join(temp, "gh-args"), "utf8")).trimEnd().split("\n"),
      ["api", "--paginate", "--slurp", "repos/memorax-ai/memorax-code/actions/runs/999/attempts/3/jobs?per_page=100"]);
    assert.deepEqual(await readdir(join(temp, "client-api")), [file]);
    assert.equal(await readFile(join(temp, "client-api", file), "utf8"), content);
  }
  // Only a provider-only run, which classifies no cell, skips the upload.
  const plans = SCENARIOS.native.map(([label, scenario]) => [label, scenario, plan(workflows.native, scenario)]);
  for (const job of results) {
    const upload = job.text.split("\n      - ").find((step) => step.startsWith("uses: actions/upload-artifact@v7\n"));
    const condition = upload.match(/^        if: (.+)$/m)?.[1];
    assert.ok(condition, job.id);
    for (const [label, scenario, planned] of plans.filter(([, , planned]) => planned.get(job.id).runs)) {
      assert.equal(Boolean(evaluate(condition, context(scenario))), scenario.inputs?.mode !== "provider-only", `${job.id}: ${label}`);
    }
  }
});

// The real job listing and client matrices of compatibility monitor run 40853420771, attempt 1, which
// client-result.test.mjs describes.
const MONITOR = new URL("./fixtures/client-result/", import.meta.url);

test("on the compatibility monitor each client result classifies this attempt's cells and uploads the record it wrote", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "client-results-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "client-api"));
  await copyFile(new URL("40853420771-1.json", MONITOR), join(root, "client-api", "attempt-1.json"));
  const matrices = JSON.parse(await readFile(new URL("matrices.json", MONITOR), "utf8"))["40853420771"];
  const scenario = { ...schedule, runId: 40853420771 };
  const planned = needsOf(plan(workflows.native, scenario));
  // The package and release jobs publish that run's matrices; its Codex and WorkBuddy matrices failed.
  const needs = { ...planned,
    package: { result: "success", outputs: { ...planned.package.outputs, ...Object.fromEntries(["codex", "opencode", "claude",
      "codebuddy", "cursor"].map((client) => [`${client}-matrix`, JSON.stringify(matrices[client])])) } },
    "workbuddy-releases": { result: "success", outputs: { matrix: JSON.stringify(matrices.workbuddy), coverage: "Synthetic release coverage." } },
    install: { result: "failure", outputs: {} }, "workbuddy-native": { result: "failure", outputs: {} } };
  const env = { GITHUB_EVENT_NAME: "schedule", GITHUB_RUN_ID: "40853420771", GITHUB_RUN_ATTEMPT: "1" };
  for (const [client, id] of Object.entries(CLIENT_RESULTS)) {
    const job = jobs(workflows.native).find((item) => item.id === id);
    const jobNeeds = Object.fromEntries(job.needs.map((need) => [need, needs[need]]));
    const { status, summary } = runResult(root, job, scenario, jobNeeds, "monitor");
    // The step gives the classification this client's matrix, this attempt's listing and the run, and exits with its verdict.
    const record = JSON.parse(await readFile(join(root, "client-result", `client-result-${client}-attempt1.json`), "utf8"));
    assert.deepEqual([record.client, record.basis, record.listing, record.cells.length], [client, "cells", "COMPLETE", 7], id);
    assert.deepEqual(record, decide({ client, needs: jobNeeds, apiDir: join(root, "client-api"), env }), id);
    assert.equal(status, record.verdict === "PASS" ? 0 : 1, id);
    // The step summary ends with the classification, one row per cell.
    assert.ok((await readFile(summary, "utf8")).endsWith(render(record)), id);
    // The upload step uploads that record under an attempt-qualified name.
    const upload = job.text.split("\n      - ").find((step) => step.startsWith("uses: actions/upload-artifact@v7\n"));
    const field = (key) => upload.match(new RegExp(`^          ${key}: (.+)$`, "m"))?.[1];
    const scope = { github: { run_attempt: 1 }, runner: { temp: root } };
    assert.equal(expand(field("name"), scope), `client-result-${client}-attempt1`, id);
    assert.equal(expand(field("path"), scope), join(root, "client-result", `client-result-${client}-attempt1.json`), id);
    assert.deepEqual([field("if-no-files-found"), field("retention-days")], ["warn", "30"], id);
  }
});

function runBlocks(source) {
  const blocks = [], lines = source.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^( +)run: (.*)$/.exec(lines[index]);
    if (!match) continue;
    if (match[2] !== "|") {
      blocks.push(match[2]);
      continue;
    }
    const body = [];
    while (index + 1 < lines.length && (!lines[index + 1].trim() || lines[index + 1].search(/\S/) > match[1].length)) body.push(lines[++index]);
    blocks.push(body.join("\n"));
  }
  return blocks;
}

test("the scope job selects clients only for a pull request, from its merge commit, and every gate reads a client it selects", () => {
  const scope = jobs(workflows.native).find((job) => job.id === "scope");
  assert.equal(scope.condition, "github.event_name == 'pull_request'");
  const outputs = [...scope.text.split("\n    outputs:\n")[1].split("\n    steps:\n")[0]
    .matchAll(/^      ([a-z]+): \$\{\{ steps\.scope\.outputs\.([a-z]+) \}\}$/gm)];
  assert.deepEqual(outputs.map(([, output]) => output), CLIENTS);
  assert.ok(outputs.every(([, output, step]) => output === step));
  assert.match(scope.text, /^          fetch-depth: 2$/m);
  assert.match(scope.text, /^          PR_HEAD_SHA: \$\{\{ github\.event\.pull_request\.head\.sha \}\}$/m);
  assert.match(scope.text, /^        run: node scripts\/ci\/shared\/native-scope\.mjs select --expected-head "\$PR_HEAD_SHA" --github-output "\$GITHUB_OUTPUT" --github-summary "\$GITHUB_STEP_SUMMARY"$/m);
  const gates = [...workflows.native.matchAll(/needs\.scope\.outputs\.([a-z-]+)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(gates)].sort(), [...CLIENTS].sort());
});

test("the Tests job runs these workflow contracts, the scope selection, the pinned acceptance manifest, the result classification and the acceptance refresh tests", () => {
  const tests = jobs(workflows.ci).find((job) => job.id === "tests").text;
  assert.match(tests, /^        run: node --test scripts\/ci\/shared\/workflow-scenarios\.test\.mjs$/m);
  assert.match(tests, /^        run: node --test scripts\/ci\/shared\/native-scope\.test\.mjs$/m);
  assert.match(tests, /^        run: node --test scripts\/ci\/shared\/client-acceptance\.test\.mjs$/m);
  assert.match(tests, /^        run: node --test scripts\/ci\/shared\/client-result\.test\.mjs$/m);
  assert.match(tests, /^        run: node --test scripts\/ci\/shared\/client-acceptance-refresh\.test\.mjs$/m);
});
