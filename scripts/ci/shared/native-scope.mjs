// Native client scope for one pull request: decide from the files it changes which native client matrices it runs.
// Every pull request still runs Tests, Documentation, the package and the contract tests. Documentation selects no client
// and a shared or unclassified file selects every client. A test or a client's own adapter or CI file selects only the clients
// whose native steps name it, or name or own a file that names it, so reuse across directories is followed, not assumed.
// Shared code names the product adapter files, so an adapter change other than a test still selects every client: this
// version accepts that conservative boundary and does not route adapter changes precisely.
import { spawnSync } from "node:child_process";
import { appendFileSync, lstatSync, readFileSync, statSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

export const CLIENTS = ["codex", "opencode", "claude", "codebuddy", "cursor", "workbuddy"];
const NAMES = { codex: "Codex", opencode: "OpenCode", claude: "Claude", codebuddy: "CodeBuddy", cursor: "Cursor App",
  workbuddy: "WorkBuddy" };
// The workflow job that runs each client's native matrix.
const NATIVE_JOBS = { codex: "install", opencode: "opencode", claude: "claude", codebuddy: "codebuddy", cursor: "cursor-app",
  workbuddy: "workbuddy-native" };
export const WORKFLOW = ".github/workflows/macos-codex-install.yml";
const DOCUMENTATION = /^(?:docs\/.+|[^/]+\.md|LICENSE|\.github\/ISSUE_TEMPLATE\/.+|\.github\/pull_request_template\.md|eslint\.config\.mjs|ruff\.toml|typos\.toml)$/;
const TEST = /(?:^|\/)test\/|\.test\.[^/]+$/;
// Client adapter and CI files; the first match wins and null marks a file every client runs. Shared files come first: the
// canonical Skill ships from the Codex adapter and the Claude adapter links to it, every setup stages the client Hook runtime
// from the src and runtime-hooks of those two adapters, and adapter-common, the Backend and the npm package serve every
// client. The CodeBuddy adapter also serves WorkBuddy. DSH, Qoder and Trae have no native matrix in this workflow.
const OWNERS = [
  [/^packages\/(?:ts\/memorax-code-(?:codex|claude)-adapter\/(?:skills|src|runtime-hooks)\/|ts\/memorax-code-(?:adapter-common|backend)\/|npm\/memorax-code\/)/, null],
  [/^packages\/ts\/memorax-code-codex-adapter\//, ["codex"]],
  [/^packages\/ts\/memorax-code-opencode-adapter\//, ["opencode"]],
  [/^packages\/ts\/memorax-code-claude-adapter\//, ["claude"]],
  [/^packages\/ts\/memorax-code-codebuddy-adapter\//, ["codebuddy", "workbuddy"]],
  [/^packages\/ts\/memorax-code-cursor-adapter\//, ["cursor"]],
  [/^packages\/ts\/memorax-code-(?:dsh|qoder|trae)-adapter\//, []],
  [/^scripts\/ci\/codex\//, ["codex"]],
  [/^scripts\/ci\/opencode\//, ["opencode"]],
  [/^scripts\/ci\/claude\//, ["claude"]],
  [/^scripts\/ci\/codebuddy-workbuddy\/workbuddy-/, ["workbuddy"]],
  [/^scripts\/ci\/codebuddy-workbuddy\//, ["codebuddy"]],
  [/^scripts\/(?:ci\/cursor|fixtures\/cursor-app)\//, ["cursor"]],
  [/^scripts\/ci\/(?:dsh|qoder)\//, []],
];
// Files that run nothing they name: documentation, GitHub settings and workflows, whose native steps are read separately,
// and the Makefile, whose targets run only in Tests, Documentation and the package job that every pull request runs.
const NOT_A_RUNNER = (file) => DOCUMENTATION.test(file) || /^(?:\.github\/|Makefile$)|\.md$/.test(file);
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The repository paths, directories and globs each client's native job names, read from the workflow.
export function nativeSteps(workflow, files) {
  const roots = [...new Set(files.filter((file) => file.includes("/")).map((file) => file.split("/")[0]))];
  const path = new RegExp(`(?<![\\w./-])(?:\\./)?((?:${roots.map(escape).join("|")})/[\\w.*/-]*[\\w*])`, "g");
  const jobs = {};
  let job;
  for (const line of workflow.slice(workflow.indexOf("\njobs:\n")).split("\n")) {
    const header = /^ {2}([\w-]+):$/.exec(line);
    if (header) jobs[header[1]] = job = [];
    else job?.push(line);
  }
  return Object.fromEntries(CLIENTS.map((client) => {
    const paths = [...(jobs[NATIVE_JOBS[client]] ?? []).join("\n").matchAll(path)].map((match) => match[1]);
    if (!paths.length) throw new Error(`The ${NATIVE_JOBS[client]} job of ${WORKFLOW} names no repository file`);
    return [client, paths.map((step) => new RegExp(`^${step.split("*").map(escape).join("[^/]*")}(?:/.*)?$`))];
  }));
}

export function selectClients({ changed, files, read, workflow }) {
  const steps = nativeSteps(workflow, files);
  const runners = files.filter((file) => !NOT_A_RUNNER(file));
  const texts = new Map();
  const text = (file) => {
    if (!texts.has(file)) texts.set(file, read(file));
    return texts.get(file);
  };
  const namedBy = (file) => {
    const name = basename(file);
    const mention = new RegExp(`(?<![\\w.-])${escape(name)}(?![\\w-])`);
    return runners.filter((runner) => runner !== file && text(runner).includes(name) && mention.test(text(runner)));
  };
  const decisions = changed.map((file) => {
    if (DOCUMENTATION.test(file)) return { file, clients: [], reason: "documentation" };
    const selected = new Set();
    const via = [];
    const queue = [file];
    for (const current of queue) {
      const before = selected.size;
      for (const client of CLIENTS) if (steps[client].some((step) => step.test(current))) selected.add(client);
      if (!TEST.test(current)) {
        const owners = OWNERS.find(([pattern]) => pattern.test(current))?.[1];
        if (!owners) {
          return { file, clients: CLIENTS, reason: current === file ? "shared or unclassified" : `named by shared or unclassified ${current}` };
        }
        for (const client of owners) selected.add(client);
      }
      if (current !== file && selected.size > before) via.push(current);
      for (const next of namedBy(current)) if (!queue.includes(next)) queue.push(next);
    }
    const clients = CLIENTS.filter((client) => selected.has(client));
    const reason = !clients.length ? "no native step runs it" : via.length ? `named by ${via.join(", ")}` : "its own native step or client file";
    return { file, clients, reason };
  });
  return { clients: CLIENTS.filter((client) => decisions.some((decision) => decision.clients.includes(client))), files: decisions };
}

function renderScope({ clients, files }) {
  const label = (selected) => (selected.length === CLIENTS.length ? "all" : selected.map((client) => NAMES[client]).join(", ") || "none");
  return `### Native client scope\n\n| Client | Native matrix |\n|---|---|\n${CLIENTS.map((client) => `| ${NAMES[client]} | ${
    clients.includes(client) ? "selected" : "not selected: this pull request does not validate it"} |\n`).join("")}\n`
    + `| Changed file | Clients | Why |\n|---|---|---|\n${files.map(({ file, clients: selected, reason }) => `| \`${file}\` | ${
      label(selected)} | ${reason} |\n`).join("")}\n`;
}

function git(...args) {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 60_000 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr?.trim() || result.error?.message}`);
  return result.stdout;
}

// A symbolic link to a directory has no text to search. Any other file that cannot be read fails the scope: reading it as
// empty would drop the references it makes and silently narrow the selection.
export function readText(file) {
  if (lstatSync(file).isSymbolicLink() && statSync(file).isDirectory()) return "";
  return readFileSync(file, "utf8");
}

function parseOptions(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = /^--([a-z][a-z0-9-]{0,40})$/.exec(args[index])?.[1];
    if (!name || index + 1 >= args.length) throw new Error("Usage: native-scope.mjs select --expected-head SHA [--github-output FILE] [--github-summary FILE]");
    options[name] = args[index + 1];
  }
  return options;
}

// Select from the pull request merge commit that actions/checkout fetched with its two parents: the base and the head.
export function runCli(args) {
  const [command, ...rest] = args;
  const options = parseOptions(rest);
  if (command !== "select" || !/^[0-9a-f]{40}$/.test(options["expected-head"] ?? "")) {
    throw new Error("Usage: native-scope.mjs select --expected-head SHA [--github-output FILE] [--github-summary FILE]");
  }
  const head = git("rev-parse", "--verify", "HEAD^2").trim();
  if (head !== options["expected-head"]) throw new Error(`The checkout merges ${head}, not the pull request head ${options["expected-head"]}`);
  const list = (...command) => git(...command).split("\0").filter(Boolean);
  const scope = selectClients({ changed: list("diff", "--name-only", "--no-renames", "-z", "HEAD^1", "HEAD"),
    files: list("ls-files", "-z"), read: readText, workflow: readFileSync(WORKFLOW, "utf8") });
  if (options["github-output"]) {
    appendFileSync(options["github-output"], CLIENTS.map((client) => `${client}=${scope.clients.includes(client)}\n`).join(""));
  }
  if (options["github-summary"]) appendFileSync(options["github-summary"], renderScope(scope));
  console.log(JSON.stringify(scope, null, 2));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = runCli(process.argv.slice(2));
  } catch (error) {
    console.error(`::error title=Native client scope::${error.message}`);
    process.exitCode = 1;
  }
}
