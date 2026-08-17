import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const backendRoot = fileURLToPath(new URL("../..", import.meta.url));
const backendSrc = join(backendRoot, "src");
const backendRootFacades = [
  "codex-adapter-lifecycle.ts",
  "jsonl-append.ts",
  "memorax-cli.ts",
  "memorax-code.ts",
  "server.ts",
  "service-entrypoint.ts",
  "windows-cli-invocation.ts",
];

const rules = [
  {
    name: "provider kernel stays independent from server and adapter lifecycle",
    importers: ["provider/memorax/adapter.ts", "provider/memorax/http.ts"],
    forbidden: ["server-", "entrypoints/", "transport/http/", "clients/codex/plugin-install"],
  },
  {
    name: "memorax config stays independent from server routing",
    importers: ["config/memorax-code.ts", "provider/memorax/config.ts"],
    forbidden: ["server-", "entrypoints/", "transport/http/"],
  },
  {
    name: "repository memory identity stays independent from child processes and synchronous filesystem I/O",
    importers: ["repository/scope.ts"],
    forbidden: ["node:child_process", "node:fs"],
  },
  {
    name: "request-time memory production does not depend on adapter lifecycle",
    importers: [
      "memory/automatic-retrieval.ts",
      "memory/automatic-writeback.ts",
      "clients/claude/memory-hook-runtime.ts",
      "clients/claude/transcript-turn.ts",
      "clients/codex/memory-hook-runtime.ts",
      "clients/dsh/memory-hook-runtime.ts",
      "clients/dsh/session-turn.ts",
      "clients/opencode/memory-hook-runtime.ts",
      "clients/opencode/message-turn.ts",
      "memory/turn-coordinator.ts",
      "memory/service.ts",
      "memory/writeback-buffer.ts",
      "memory/writeback-chunk.ts",
    ],
    forbidden: ["clients/codex/plugin-install"],
  },
  {
    name: "memory service stays independent from HTTP and Backend composition",
    importers: ["memory/service.ts"],
    forbidden: ["node:http", "server-", "entrypoints/", "transport/http/", "app/state"],
  },
  {
    name: "memory service kernel receives Backend diagnostics through a port",
    importers: [
      "memory/automatic-retrieval.ts",
      "memory/automatic-writeback.ts",
      "clients/claude/memory-hook-runtime.ts",
      "clients/codex/memory-hook-runtime.ts",
      "clients/dsh/memory-hook-runtime.ts",
      "clients/opencode/memory-hook-runtime.ts",
      "provider/memorax/adapter.ts",
      "memory/turn-coordinator.ts",
      "memory/service.ts",
    ],
    forbidden: ["shared/debug-log"],
  },
  {
    name: "Backend state does not own the memory service",
    importers: ["app/state.ts"],
    forbidden: ["memory/service"],
  },
  {
    name: "automatic writeback stays independent from Codex prompt parsing and Backend routing",
    importers: ["memory/automatic-writeback.ts"],
    forbidden: ["clients/codex/effective-prompt", "server-", "entrypoints/", "transport/http/"],
  },
  {
    name: "Hook memory runtimes use normalized automatic writeback",
    importers: [
      "clients/claude/memory-hook-runtime.ts",
      "clients/codex/memory-hook-runtime.ts",
      "clients/dsh/memory-hook-runtime.ts",
      "clients/opencode/memory-hook-runtime.ts",
      "memory/turn-coordinator.ts",
    ],
    forbidden: ["memory/writeback"],
  },
  {
    name: "Codex memory hook runtime stays independent from HTTP and Backend composition",
    importers: ["clients/codex/memory-hook-runtime.ts"],
    forbidden: ["node:http", "server-", "entrypoints/", "transport/http/", "app/state"],
  },
  {
    name: "Claude memory hook runtime stays independent from HTTP and Backend composition",
    importers: ["clients/claude/memory-hook-runtime.ts", "clients/claude/transcript-turn.ts"],
    forbidden: ["node:http", "server-", "entrypoints/", "transport/http/", "app/state"],
  },
  {
    name: "OpenCode memory hook runtime stays independent from HTTP and Backend composition",
    importers: ["clients/opencode/memory-hook-runtime.ts", "clients/opencode/message-turn.ts"],
    forbidden: ["node:http", "server-", "entrypoints/", "transport/http/", "app/state"],
  },
  {
    name: "DSH memory hook runtime stays independent from HTTP and Backend composition",
    importers: ["clients/dsh/memory-hook-runtime.ts", "clients/dsh/session-turn.ts"],
    forbidden: ["node:http", "server-", "entrypoints/", "transport/http/", "app/state"],
  },
  {
    name: "memory turn coordinator stays independent from HTTP, Backend composition, and client transcripts",
    importers: ["memory/turn-coordinator.ts"],
    forbidden: ["node:http", "server-", "entrypoints/", "transport/http/", "app/state", "clients/codex/rollout", "clients/claude/", "clients/dsh/", "clients/opencode/"],
  },
  {
    name: "writeback reconciliation stays independent from HTTP, Backend composition, and Viewer models",
    importers: ["memory/writeback-reconciler.ts"],
    forbidden: ["node:http", "server-", "entrypoints/", "transport/http/", "app/state", "viewer/"],
  },
  {
    name: "writeback task projection stays independent from Viewer and provider polling",
    importers: ["memory/writeback-task-projection.ts"],
    forbidden: ["viewer/", "provider/memorax/adapter", "server-", "entrypoints/", "transport/http/"],
  },
  {
    name: "public memory viewer routes read local projections without provider access",
    importers: ["viewer/http/public-routes.ts"],
    forbidden: ["provider/memorax/", "memory/writeback-reconciler"],
  },
  {
    name: "HTTP server stays independent from install watchdog and client plugin lifecycle",
    importers: ["app/backend-server.ts"],
    forbidden: ["lifecycle/install-watchdog", "clients/codex/plugin-install", "lifecycle/client-plugin-removal"],
  },
  {
    name: "server CLI uses the app server instead of the compatibility entrypoint",
    importers: ["entrypoints/backend-cli.ts"],
    forbidden: ["server"],
  },
  {
    name: "Viewer projections depend on the Viewer model instead of the Store",
    importers: [
      "viewer/history/claude-transcript.ts",
      "viewer/history/session-title.ts",
      "viewer/projection/activity.ts",
      "viewer/projection/history.ts",
      "viewer/projection/user.ts",
      "viewer/projection/writeback-status.ts",
    ],
    forbidden: ["viewer/store"],
  },
  {
    name: "Viewer model stays independent from Viewer projections and storage",
    importers: ["viewer/model.ts"],
    forbidden: ["viewer/", "server-", "entrypoints/", "transport/http/"],
  },
  {
    name: "lifecycle contracts stay independent from lifecycle implementations",
    importers: ["lifecycle/contracts.ts"],
    forbidden: [
      "lifecycle/lock",
      "lifecycle/backend/result",
      "lifecycle/orchestrator",
      "entrypoints/backend-cli",
      "lifecycle/backend/service",
      "service-entrypoint",
    ],
  },
  {
    name: "lifecycle helpers consume contracts instead of the service implementation",
    importers: [
      "lifecycle/participant.ts",
      "lifecycle/lock.ts",
      "lifecycle/backend/cleanup.ts",
      "lifecycle/backend/token.ts",
      "clients/codex/lifecycle.ts",
    ],
    forbidden: ["lifecycle/backend/service", "service-entrypoint"],
  },
  {
    name: "Codex trace store stays independent from memory and server paths",
    importers: ["trace/store.ts"],
    forbidden: ["memory/", "server-", "entrypoints/", "transport/http/"],
  },
];

test("backend source boundaries keep production, observability, and lifecycle imports separated", async () => {
  const violations = [];
  for (const rule of rules) {
    for (const importer of rule.importers) {
      const imports = await directRelativeImports(importer);
      for (const target of imports) {
        if (rule.forbidden.some((forbidden) => matchesForbiddenTarget(target, forbidden))) {
          violations.push(`${importer} imports ${target} (${rule.name})`);
        }
      }
    }
  }

  assert.deepEqual(violations, []);
});

test("backend source root contains only stable entrypoints and compatibility facades", async () => {
  const entries = await readdir(backendSrc, { withFileTypes: true });
  const rootModules = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual(rootModules, backendRootFacades);
});

test("public memory viewer HTTP ownership contains only the public route", async () => {
  const entries = await readdir(join(backendSrc, "viewer", "http"), { withFileTypes: true });
  const routeModules = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => entry.name)
    .sort();

  assert.deepEqual(routeModules, ["public-routes.ts"]);
});

test("memorax-code lifecycle delegates client implementation details to adapter participants", async () => {
  const source = await readFile(join(backendSrc, "lifecycle", "orchestrator.ts"), "utf8");

  assert.doesNotMatch(source, /clients\/codex\/plugin-install/);
  assert.doesNotMatch(source, /memorax-code-(?:codex|claude)-adapter\/src/);
});

test("backend source dependency graph remains acyclic", async () => {
  const modules = await sourceModules();
  const moduleSet = new Set(modules);
  const graph = new Map();
  for (const importer of modules) {
    const text = await readFile(join(backendSrc, importer), "utf8");
    const targets = importSpecifiers(text)
      .filter((specifier) => specifier.startsWith("."))
      .map((specifier) => sourceImportTarget(importer, specifier))
      .filter((target) => target && moduleSet.has(target));
    graph.set(importer, [...new Set(targets)].sort());
  }

  assert.deepEqual(dependencyCycles(graph), []);
});

async function directRelativeImports(importer) {
  const text = await readFile(join(backendSrc, importer), "utf8");
  return [...new Set(importSpecifiers(text).map((specifier) => (
    specifier.startsWith(".")
      ? stripTypeScriptExtension(sourceImportTarget(importer, specifier))
      : specifier
  )))].sort();
}

function importSpecifiers(text) {
  const specs = [];
  for (const pattern of importPatterns) {
    for (const match of text.matchAll(pattern)) {
      specs.push(match[1]);
    }
  }
  return specs;
}

const importPatterns = [
  /\bimport\s+(?:type\s+)?[\s\S]*?\s+from\s+["']([^"']+)["']/g,
  /\bimport\s+["']([^"']+)["']/g,
  /\bexport\s+(?:type\s+)?[\s\S]*?\s+from\s+["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
];

function matchesForbiddenTarget(target, forbidden) {
  if (forbidden.endsWith("-") || forbidden.endsWith("/")) return target.startsWith(forbidden);
  return target === forbidden || target.startsWith(`${forbidden}-`);
}

async function sourceModules(directory = backendSrc) {
  const entries = await readdir(directory, { withFileTypes: true });
  const modules = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) modules.push(...await sourceModules(path));
    else if (entry.isFile() && entry.name.endsWith(".ts")) {
      modules.push(relative(backendSrc, path).split(sep).join("/"));
    }
  }
  return modules;
}

function sourceImportTarget(importer, specifier) {
  const importerPath = join(backendSrc, importer);
  const targetPath = resolve(dirname(importerPath), specifier.replace(/\.m?js$/, ".ts"));
  return relative(backendSrc, targetPath).split(sep).join("/");
}

function stripTypeScriptExtension(value) {
  return value.replace(/\.ts$/, "");
}

function dependencyCycles(graph) {
  const complete = new Set();
  const active = new Set();
  const stack = [];
  const cycles = [];

  function visit(module) {
    if (complete.has(module)) return;
    active.add(module);
    stack.push(module);
    for (const dependency of graph.get(module) ?? []) {
      if (active.has(dependency)) {
        cycles.push([...stack.slice(stack.indexOf(dependency)), dependency].join(" -> "));
      } else {
        visit(dependency);
      }
    }
    stack.pop();
    active.delete(module);
    complete.add(module);
  }

  for (const module of [...graph.keys()].sort()) visit(module);
  return cycles;
}
