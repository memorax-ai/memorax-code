import assert from "node:assert/strict";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { promisify } from "node:util";
import { runMemoryCli } from "../dist/memory/cli.js";
import { traceContextFromClaudeHookBody, traceContextFromHookBody } from "../dist/trace/context.js";
import { claudeTracePaths, tracePaths } from "../dist/trace/config.js";
import { writeCurrentClaudeTurn, writeCurrentCodexTurn } from "../dist/trace/store.js";
import { listen } from "./helpers.mjs";

const execFileAsync = promisify(execFile);

test("memory CLI status reports configured MemoraX and enabled add gate by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-cli-default-status-"));
  const workspace = join(root, "memorax-code");
  await mkdir(workspace, { recursive: true });
  const result = await runMemoryCli(["status"], {
    cwd: workspace,
    env: {
      MEMORAX_CODE_HOME: join(root, "home"),
      MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
      MEMORAX_CODE_MEMORAX_API_KEY: "secret",
      MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "memory.status");
  assert.equal(result.provider, "memory.memorax");
  assert.equal(result.baseUrl, "http://memorax.test");
  assert.equal(result.userId, "user-1");
  assert.equal(result.baseUserId, "user-1");
  assert.equal(result.workspace, "memorax-code");
  assert.equal("repository" in result, false);
  assert.equal(result.effectiveUserId, "user-1@memorax-code");
  assert.equal(result.workspaceScope, "bound");
  assert.equal(result.searchEnabled, true);
  assert.equal(result.addEnabled, true);
});

test("memory CLI config-only status does not resolve or persist workspace scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-cli-config-only-"));
  const memoraxCodeHome = join(root, "memorax-code-home");
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });

  const result = await runMemoryCli(["status", "--config-only"], {
    cwd: workspace,
    env: {
      MEMORAX_CODE_HOME: memoraxCodeHome,
      MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
      MEMORAX_CODE_MEMORAX_API_KEY: "secret",
      MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.action, "memory.status");
  assert.equal(result.provider, "memory.memorax");
  assert.equal(result.config.configured, true);
  assert.equal("repository" in result, false);
  assert.equal(result.workspace, undefined);
  assert.equal(result.effectiveUserId, undefined);
});

test("memory CLI searches within a readable non-Git workspace scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-cli-non-git-"));
  const workspace = join(root, "notes");
  await mkdir(workspace, { recursive: true });
  const env = {
    MEMORAX_CODE_HOME: root,
    MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
    MEMORAX_CODE_MEMORAX_API_KEY: "secret",
    MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
  };
  const requests = [];
  const status = await runMemoryCli(["status"], { cwd: workspace, env });
  const search = await runMemoryCli(["search", "--query", "workspace-specific note"], {
    cwd: workspace,
    env,
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ success: true, data: { data: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(status.ok, true);
  assert.equal(status.baseUserId, "user-1");
  assert.equal(status.workspaceScope, "bound");
  assert.equal(status.scopeKind, "local-directory");
  assert.equal(status.workspace, "notes");
  assert.equal(status.effectiveUserId, "user-1@notes");
  assert.equal(search.ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].user_id, "user-1@notes");
});

test("memory CLI reuses the current non-Git turn scope from a nested cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-cli-local-turn-"));
  const memoraxCodeHome = join(root, "memorax-code-home");
  const workspace = join(root, "notes");
  const nested = join(workspace, "src");
  await mkdir(nested, { recursive: true });
  await writeCurrentCodexTurn(traceContextFromHookBody({
    session_id: "session-local-turn",
    turn_id: "turn-local-turn",
    cwd: workspace,
  }), { memoraxCodeHome });
  const requests = [];

  const result = await runMemoryCli(["search", "--query", "nested workspace note"], {
    cwd: nested,
    env: {
      CODEX_THREAD_ID: "session-local-turn",
      MEMORAX_CODE_HOME: memoraxCodeHome,
      MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
      MEMORAX_CODE_MEMORAX_API_KEY: "secret",
      MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
    },
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ success: true, data: { data: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.effectiveUserId, "user-1@notes");
  assert.equal(requests[0].user_id, "user-1@notes");
});

test("memory CLI rejects a nested repository outside the current turn scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-cli-nested-repo-"));
  const memoraxCodeHome = join(root, "memorax-code-home");
  const parent = join(root, "parent");
  const nested = join(parent, "nested");
  await createRepositoryMetadata(parent, "Parent");
  await createRepositoryMetadata(nested, "Nested");
  await writeCurrentCodexTurn(traceContextFromHookBody({
    session_id: "session-nested-repo",
    turn_id: "turn-nested-repo",
    cwd: parent,
  }), { memoraxCodeHome });
  let requestCount = 0;

  const result = await runMemoryCli(["search", "--query", "must not cross nested repositories"], {
    cwd: nested,
    env: {
      CODEX_THREAD_ID: "session-nested-repo",
      MEMORAX_CODE_HOME: memoraxCodeHome,
      MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
      MEMORAX_CODE_MEMORAX_API_KEY: "secret",
      MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
    },
    fetchImpl: async () => {
      requestCount += 1;
      return new Response("{}", { status: 200 });
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /does not match the current Codex turn repository\/workspace scope/);
  assert.equal(result.workspaceScope, "unavailable");
  assert.equal(result.workspaceScopeReason, "workspace_scope_mismatch");
  assert.equal(
    result.userAction,
    "Start a new Codex or Claude Code session from the target repository or local workspace.",
  );
  assert.equal(requestCount, 0);
});

test("memory CLI falls back to the folder scope when direct Git metadata is malformed", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-cli-invalid-git-"));
  const workspace = join(root, "quant");
  await mkdir(join(workspace, ".git"), { recursive: true });
  const requests = [];
  const env = {
    MEMORAX_CODE_HOME: join(root, "memorax-code-home"),
    MEMORAX_CODE_MEMORY_CLI_ADD_ENABLED: "true",
    MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
    MEMORAX_CODE_MEMORAX_API_KEY: "secret",
    MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
  };
  const options = {
    cwd: workspace,
    env,
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) });
      const data = String(url).endsWith("/v1/memories/add")
        ? { task_id: "fallback-add", status: "queued" }
        : { data: [] };
      return new Response(JSON.stringify({ success: true, data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };

  const status = await runMemoryCli(["status"], options);
  const search = await runMemoryCli(["search", "--query", "use folder fallback"], options);
  const add = await runMemoryCli([
    "add",
    "--memory",
    "Must preserve workspace scope.",
    "--type",
    "procedural",
    "--reason",
    "Record a verified scope invariant.",
  ], options);

  for (const result of [status, search, add]) {
    assert.equal(result.ok, true);
    assert.equal(result.workspaceScope, "bound");
    assert.equal(result.scopeKind, "local-directory");
    assert.equal(result.workspace, "quant");
    assert.equal(result.effectiveUserId, "user-1@quant");
    assert.equal(result.workspaceScopeFallbackReason, "git_metadata_invalid");
    assert.match(result.userNotice, /Git repository metadata is invalid or incomplete/);
    assert.match(result.userNotice, /local folder name "quant"/);
    assert.match(result.userNotice, /Search and Add use "user-1@quant"/);
  }
  assert.equal(requests.length, 2);
  assert.equal(requests[0].body.user_id, "user-1@quant");
  assert.equal(requests[1].body.user_id, "user-1@quant");

  await createRepositoryMetadata(workspace, "quant-repository");
  const repairedSearch = await runMemoryCli(["search", "--query", "use repaired Git scope"], options);
  const repairedAdd = await runMemoryCli([
    "add",
    "--memory",
    "Use the repaired Git scope.",
    "--type",
    "procedural",
    "--reason",
    "Verify same-session scope recovery.",
  ], options);

  for (const result of [repairedSearch, repairedAdd]) {
    assert.equal(result.ok, true);
    assert.equal(result.workspaceScope, "bound");
    assert.equal(result.scopeKind, "git-repository");
    assert.equal(result.workspace, "quant-repository");
    assert.equal(result.effectiveUserId, "user-1@quant-repository");
    assert.equal(result.workspaceScopeFallbackReason, undefined);
    assert.equal(result.userNotice, undefined);
  }
  assert.equal(requests.length, 4);
  assert.equal(requests[2].body.user_id, "user-1@quant-repository");
  assert.equal(requests[3].body.user_id, "user-1@quant-repository");
});

test("memory CLI gives the same scope recovery guidance for a Claude turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-cli-claude-scope-"));
  const memoraxCodeHome = join(root, "memorax-code-home");
  const first = join(root, "first");
  const second = join(root, "second");
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  await writeCurrentClaudeTurn(traceContextFromClaudeHookBody({
    session_id: "session-claude-scope",
    prompt_id: "prompt-claude-scope",
    cwd: first,
  }), { memoraxCodeHome });
  let requestCount = 0;

  const result = await runMemoryCli(["search", "--query", "must not cross workspaces"], {
    cwd: second,
    env: {
      MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT: "claude",
      MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID: "session-claude-scope",
      MEMORAX_CODE_HOME: memoraxCodeHome,
      MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
      MEMORAX_CODE_MEMORAX_API_KEY: "secret",
      MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
    },
    fetchImpl: async () => {
      requestCount += 1;
      return new Response("{}", { status: 200 });
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /does not match the current Claude turn repository\/workspace scope/);
  assert.equal(result.workspaceScope, "unavailable");
  assert.equal(result.workspaceScopeReason, "workspace_scope_mismatch");
  assert.equal(
    result.userAction,
    "Start a new Codex or Claude Code session from the target repository or local workspace.",
  );
  assert.equal(requestCount, 0);
});

test("memory CLI accepts a sibling linked worktree from the current turn repository", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-cli-linked-worktree-"));
  const memoraxCodeHome = join(root, "memorax-code-home");
  const main = join(root, "Project");
  const linked = join(root, "Project-feature");
  const commonDir = await createRepositoryMetadata(main, "Project");
  await createLinkedWorktreeMetadata(linked, commonDir, "feature");
  await writeCurrentCodexTurn(traceContextFromHookBody({
    session_id: "session-linked-worktree",
    turn_id: "turn-linked-worktree",
    cwd: main,
  }), { memoraxCodeHome });
  const requests = [];

  const result = await runMemoryCli(["search", "--query", "shared repository memory"], {
    cwd: linked,
    env: {
      CODEX_THREAD_ID: "session-linked-worktree",
      MEMORAX_CODE_HOME: memoraxCodeHome,
      MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
      MEMORAX_CODE_MEMORAX_API_KEY: "secret",
      MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
    },
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ success: true, data: { data: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.scopeKind, "git-repository");
  assert.equal(result.effectiveUserId, "user-1@Project");
  assert.equal(requests.length, 1);
  assert.equal(requests[0].user_id, "user-1@Project");
});

test("memory CLI uses Codex-General for a projectless current turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-cli-projectless-"));
  const memoraxCodeHome = join(root, "memorax-code-home");
  const taskRoot = join(root, "2026-07-13", "new-chat-2");
  const taskWork = join(taskRoot, "work");
  await mkdir(taskWork, { recursive: true });
  await writeCurrentCodexTurn(traceContextFromHookBody({
    session_id: "session-projectless",
    turn_id: "turn-projectless",
    cwd: taskRoot,
    workspace_kind: "projectless",
  }), { memoraxCodeHome });

  const result = await runMemoryCli(["status"], {
    cwd: taskWork,
    env: {
      CODEX_THREAD_ID: "session-projectless",
      MEMORAX_CODE_HOME: memoraxCodeHome,
      MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
      MEMORAX_CODE_MEMORAX_API_KEY: "secret",
      MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.scopeKind, "codex-projectless");
  assert.equal(result.workspace, "Codex-General");
  assert.equal(result.effectiveUserId, "user-1@Codex-General");
});

test("memory CLI uses Codex-General when a projectless current turn has no cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-cli-projectless-no-cwd-"));
  const memoraxCodeHome = join(root, "memorax-code-home");
  const commandWorkspace = join(root, "arbitrary-command-workspace");
  await mkdir(commandWorkspace, { recursive: true });
  await writeCurrentCodexTurn(traceContextFromHookBody({
    session_id: "session-projectless-no-cwd",
    turn_id: "turn-projectless-no-cwd",
    workspace_kind: "projectless",
  }), { memoraxCodeHome });

  const result = await runMemoryCli(["status"], {
    cwd: commandWorkspace,
    env: {
      CODEX_THREAD_ID: "session-projectless-no-cwd",
      MEMORAX_CODE_HOME: memoraxCodeHome,
      MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
      MEMORAX_CODE_MEMORAX_API_KEY: "secret",
      MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.scopeKind, "codex-projectless");
  assert.equal(result.workspace, "Codex-General");
  assert.equal(result.effectiveUserId, "user-1@Codex-General");
});

test("memory CLI blocks a cwd outside the current Codex turn scope", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-cli-turn-scope-"));
  const memoraxCodeHome = join(root, "memorax-code-home");
  const first = join(root, "first");
  const second = join(root, "second");
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  await writeCurrentCodexTurn(traceContextFromHookBody({
    session_id: "session-cli-scope",
    turn_id: "turn-cli-scope",
    cwd: first,
  }), { memoraxCodeHome });
  let requestCount = 0;
  const result = await runMemoryCli(["search", "--query", "must not cross repositories"], {
    cwd: second,
    env: {
      CODEX_THREAD_ID: "session-cli-scope",
      MEMORAX_CODE_HOME: memoraxCodeHome,
      MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
      MEMORAX_CODE_MEMORAX_API_KEY: "secret",
      MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
    },
    fetchImpl: async () => {
      requestCount += 1;
      return new Response("{}", { status: 200 });
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /does not match the current Codex turn repository\/workspace scope/);
  assert.equal(requestCount, 0);
});

test("memorax-cli status dispatches through its dedicated entrypoint", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-cli-service-status-"));
  const result = await execFileAsync(process.execPath, ["dist/memorax-cli.js", "status"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      MEMORAX_CODE_HOME: root,
      MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
      MEMORAX_CODE_MEMORAX_API_KEY: "secret",
      MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
    },
  });
  const parsed = JSON.parse(result.stdout);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.action, "memory.status");
  assert.equal(parsed.provider, "memory.memorax");
  assert.equal(parsed.addEnabled, true);
});

test("memorax-cli config-only status dispatches without workspace identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-cli-service-config-only-"));
  const result = await execFileAsync(
    process.execPath,
    ["dist/memorax-cli.js", "status", "--json", "--config-only"],
    {
      cwd: new URL("..", import.meta.url),
      env: {
        ...process.env,
        MEMORAX_CODE_HOME: root,
        MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
        MEMORAX_CODE_MEMORAX_API_KEY: "secret",
        MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
      },
    },
  );
  const parsed = JSON.parse(result.stdout);

  assert.equal(parsed.ok, true);
  assert.equal(parsed.action, "memory.status");
  assert.equal(parsed.config.configured, true);
  assert.equal("repository" in parsed, false);
  assert.equal(parsed.effectiveUserId, undefined);
});

test("memorax-cli search prints model-facing answer by default and keeps raw items behind --json", async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      success: true,
      data: {
        task_id: "search-task",
        status: "completed",
        data: [{
          id: "raw-memory-id",
          memory: "Trace collection uses request-time structured tracing.",
          score: 0.9,
          user_id: "private-user",
          api_key_uuid: "private-api-key-uuid",
          metadata: {
            memory_type: "core",
            matched_facts: [{ id: "fact-1", text: "internal fact" }],
          },
        }],
      },
    }));
  });
  const baseUrl = await listen(server);
  const root = await mkdtemp(join(tmpdir(), "memorax-code-cli-service-search-"));
  const env = {
    ...process.env,
    MEMORAX_CODE_HOME: root,
    MEMORAX_CODE_MEMORAX_ENDPOINT: baseUrl,
    MEMORAX_CODE_MEMORAX_API_KEY: "secret",
    MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
  };

  try {
    const plain = await execFileAsync(process.execPath, ["dist/memorax-cli.js", "search", "--query", "trace collection"], {
      cwd: new URL("..", import.meta.url),
      env,
    });

    assert.match(plain.stdout, /<memories>/);
    assert.match(plain.stdout, /Trace collection uses request-time structured tracing/);
    assert.doesNotMatch(plain.stdout, /raw-memory-id/);
    assert.doesNotMatch(plain.stdout, /private-api-key-uuid/);
    assert.doesNotMatch(plain.stdout, /matched_facts/);

    const json = await execFileAsync(process.execPath, ["dist/memorax-cli.js", "search", "--query", "trace collection", "--json"], {
      cwd: new URL("..", import.meta.url),
      env,
    });
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.items[0].id, "raw-memory-id");
    assert.equal(requests.length, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("memory CLI search reads query file and calls MemoraX search", async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({
      url: req.url,
      authorization: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      success: true,
      data: {
        task_id: "search-task",
        status: "completed",
        data: [{
          id: "m1",
          memory: "User prefers short direct answers.",
          score: 0.9,
          metadata: { memory_type: "core" },
        }],
      },
    }));
  });
  const baseUrl = await listen(server);
  const root = await mkdtemp(join(tmpdir(), "memorax-code-cli-search-"));
  const workspace = join(root, "memorax-code");
  const queryFile = join(root, "query.txt");
  await mkdir(workspace, { recursive: true });
  await writeFile(queryFile, "answer style preference", "utf8");

  try {
    const result = await runMemoryCli(["search", "--query-file", queryFile], {
      cwd: workspace,
      env: {
        MEMORAX_CODE_HOME: join(root, "home"),
        MEMORAX_CODE_MEMORAX_ENDPOINT: baseUrl,
        MEMORAX_CODE_MEMORAX_API_KEY: "secret",
        MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.action, "memory.search");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/v1/memories/search");
    assert.equal(requests[0].authorization, "Token secret");
    assert.equal(requests[0].body.query, "answer style preference");
    assert.equal(requests[0].body.user_id, "user-1@memorax-code");
    assert.equal(requests[0].body.top_k, 6);
    assert.equal(requests[0].body.k_dense, 6);
    assert.equal(requests[0].body.k_sparse, 6);
    assert.match(result.answer, /short direct answers/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("memory CLI search writes a Codex trace event from current turn bridge", async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({
      url: req.url,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      success: true,
      data: { data: [{ memory: "Trace bridge search memory.", score: 0.7 }] },
    }));
  });
  const baseUrl = await listen(server);
  const root = await mkdtemp(join(tmpdir(), "memorax-code-cli-search-trace-"));
  await writeCurrentCodexTurn(traceContextFromHookBody({
    session_id: "session-cli-search",
    turn_id: "turn-cli-search",
  }), {
    memoraxCodeHome: root,
  });

  try {
    const result = await runMemoryCli(["search", "--query", "trace bridge search"], {
      env: {
        CODEX_THREAD_ID: "session-cli-search",
        MEMORAX_CODE_HOME: root,
        MEMORAX_CODE_MEMORAX_ENDPOINT: baseUrl,
        MEMORAX_CODE_MEMORAX_API_KEY: "secret",
        MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
      },
    });

    assert.equal(result.ok, true);
    assert.equal(requests.length, 1);
    const events = (await readFile(tracePaths(root).eventsJsonl("session-cli-search"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "memory_cli_search");
    assert.equal(events[0].source, "memory_cli");
    assert.equal(events[0].trace.session_id, "session-cli-search");
    assert.equal(events[0].trace.turn_id, "turn-cli-search");
    assert.equal(events[0].trace.context_origin, "current-turn-file");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("memory CLI search does not read or write a global Codex trace without binding authority", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-memory-cli-unbound-trace-"));
  await writeCurrentCodexTurn(traceContextFromHookBody({
    session_id: "session-global-unbound",
    turn_id: "turn-global-unbound",
  }), {
    memoraxCodeHome: root,
  });
  const requests = [];

  const result = await runMemoryCli(["search", "--query", "unbound trace"], {
    env: {
      MEMORAX_CODE_HOME: root,
      MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
      MEMORAX_CODE_MEMORAX_API_KEY: "secret",
      MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
    },
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ success: true, data: { data: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(requests.length, 1);
  await assert.rejects(readFile(tracePaths(root).eventsJsonl("session-global-unbound"), "utf8"));
});

test("memory CLI search does not fall back to Codex for a partial explicit trace binding", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-memory-cli-partial-trace-binding-"));
  await writeCurrentCodexTurn(traceContextFromHookBody({
    session_id: "session-codex-fallback",
    turn_id: "turn-codex-fallback",
  }), {
    memoraxCodeHome: root,
  });
  const requests = [];

  const result = await runMemoryCli(["search", "--query", "partial trace binding"], {
    env: {
      CODEX_THREAD_ID: "session-codex-fallback",
      MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT: "claude",
      MEMORAX_CODE_HOME: root,
      MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
      MEMORAX_CODE_MEMORAX_API_KEY: "secret",
      MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
    },
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ success: true, data: { data: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  assert.equal(result.ok, true);
  assert.equal(requests.length, 1);
  await assert.rejects(readFile(tracePaths(root).eventsJsonl("session-codex-fallback"), "utf8"));
});

test("memory CLI search binds to Claude trace without writing the same-id Codex trace", async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      success: true,
      data: { data: [{ memory: "Claude trace bridge memory.", score: 0.7 }] },
    }));
  });
  const baseUrl = await listen(server);
  const root = await mkdtemp(join(tmpdir(), "memorax-code-cli-claude-trace-"));
  const sessionId = "shared-cli-session";
  const codexWorkspace = join(root, "codex-workspace");
  const claudeWorkspace = join(root, "claude-workspace");
  const claudeNestedCwd = join(claudeWorkspace, "src");
  await mkdir(codexWorkspace, { recursive: true });
  await mkdir(claudeNestedCwd, { recursive: true });
  await writeCurrentCodexTurn(traceContextFromHookBody({
    session_id: sessionId,
    turn_id: "codex-turn",
    cwd: codexWorkspace,
  }), {
    memoraxCodeHome: root,
  });
  await writeCurrentClaudeTurn(traceContextFromClaudeHookBody({
    session_id: sessionId,
    prompt_id: "claude-prompt",
    cwd: claudeWorkspace,
  }), {
    memoraxCodeHome: root,
  });

  try {
    const result = await runMemoryCli(["search", "--query", "Claude trace bridge"], {
      env: {
        MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT: "claude",
        MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID: sessionId,
        MEMORAX_CODE_HOME: root,
        MEMORAX_CODE_MEMORAX_ENDPOINT: baseUrl,
        MEMORAX_CODE_MEMORAX_API_KEY: "secret",
        MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
      },
      cwd: claudeNestedCwd,
    });

    assert.equal(result.ok, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].user_id, "user-1@claude-workspace");
    const events = (await readFile(claudeTracePaths(root).eventsJsonl(sessionId), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "memory_cli_search");
    assert.equal(events[0].source, "memory_cli");
    assert.equal(events[0].trace.client, "claude");
    assert.equal(events[0].trace.session_id, sessionId);
    assert.equal(events[0].trace.turn_id, "claude-prompt");
    assert.equal(events[0].trace.context_origin, "current-turn-file");
    await assert.rejects(readFile(tracePaths(root).eventsJsonl(sessionId), "utf8"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("memory CLI search does not trace to a different Codex thread current turn", async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true, data: { data: [] } }));
  });
  const baseUrl = await listen(server);
  const root = await mkdtemp(join(tmpdir(), "memorax-code-cli-search-trace-thread-mismatch-"));
  await writeCurrentCodexTurn(traceContextFromHookBody({
    session_id: "session-other",
    turn_id: "turn-other",
  }), {
    memoraxCodeHome: root,
  });

  try {
    const result = await runMemoryCli(["search", "--query", "thread mismatch"], {
      env: {
        CODEX_THREAD_ID: "session-current",
        MEMORAX_CODE_HOME: root,
        MEMORAX_CODE_MEMORAX_ENDPOINT: baseUrl,
        MEMORAX_CODE_MEMORAX_API_KEY: "secret",
        MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
      },
    });

    assert.equal(result.ok, true);
    assert.equal(requests.length, 1);
    await assert.rejects(readFile(tracePaths(root).eventsJsonl("session-other"), "utf8"));
    await assert.rejects(readFile(tracePaths(root).eventsJsonl("session-current"), "utf8"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("memory CLI add rejects writes when add gate is explicitly disabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-cli-disabled-"));
  const memoryFile = join(root, "memory.txt");
  await writeFile(memoryFile, "User prefers concise Chinese responses.", "utf8");
  await writeFile(join(root, "config.toml"), [
    "[memory.cli]",
    "add_enabled = false",
  ].join("\n"), "utf8");

  const result = await runMemoryCli([
    "add",
    "--memory-file",
    memoryFile,
    "--type",
    "preference",
    "--reason",
    "User stated a stable preference.",
  ], {
    env: {
      MEMORAX_CODE_HOME: root,
      MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
      MEMORAX_CODE_MEMORAX_API_KEY: "secret",
      MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
    },
  });

  assert.equal(result.ok, false);
  assert.equal(result.action, "memory.add");
  assert.match(result.error, /MEMORAX_CODE_MEMORY_CLI_ADD_ENABLED=true|memory\.cli.*add_enabled/i);
});

test("memory CLI add writes a short memory through MemoraX", async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({
      url: req.url,
      authorization: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({
      success: true,
      data: { task_id: "add-task", status: "queued" },
      meta: { request_id: "add-request" },
    }));
  });
  const baseUrl = await listen(server);
  const root = await mkdtemp(join(tmpdir(), "memorax-code-cli-add-"));
  const workspace = join(root, "memorax-code");
  const memoryFile = join(root, "memory.txt");
  await mkdir(workspace, { recursive: true });
  await writeFile(memoryFile, "User prefers concise Chinese responses.", "utf8");

  try {
    const result = await runMemoryCli([
      "add",
      "--memory-file",
      memoryFile,
      "--type",
      "preference",
      "--reason",
      "User stated a stable preference.",
      "--session-id",
      "session-manual",
    ], {
      cwd: workspace,
      env: {
        MEMORAX_CODE_HOME: join(root, "home"),
        MEMORAX_CODE_MEMORY_CLI_ADD_ENABLED: "true",
        MEMORAX_CODE_MEMORAX_ENDPOINT: baseUrl,
        MEMORAX_CODE_MEMORAX_API_KEY: "secret",
        MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
        MEMORAX_CODE_MEMORY_OUTPUT_LANGUAGE: "en",
      },
    });

    assert.equal(result.ok, true);
    assert.equal(result.action, "memory.add");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/v1/memories/add");
    assert.equal(requests[0].authorization, "Token secret");
    assert.equal(requests[0].body.user_id, "user-1@memorax-code");
    assert.equal(requests[0].body.session_id, "session-manual");
    assert.equal(requests[0].body.content_type, "code");
    assert.equal(requests[0].body.mode, "pre_summarized");
    assert.equal(requests[0].body.memory_output_language, "en");
    assert.deepEqual(requests[0].body.messages.map((message) => ({
      role: message.role,
      content: message.content,
    })), [{
      role: "user",
      content: "User prefers concise Chinese responses.",
    }]);
    assert.equal(requests[0].body.metadata.source, "memorax-code");
    assert.equal(requests[0].body.metadata.source_detail, "memorax_code_memory_cli");
    assert.equal(requests[0].body.metadata.memorax_code_base_user_id, "user-1");
    assert.equal(requests[0].body.metadata.memorax_code_workspace, "memorax-code");
    assert.equal(requests[0].body.metadata.memorax_code_memory_scope, "workspace-name.v1");
    assert.equal("memorax_code_repository" in requests[0].body.metadata, false);
    assert.equal(requests[0].body.metadata.memory_type, "preference");
    assert.equal(requests[0].body.metadata.memorax_code_memory_reason, "User stated a stable preference.");
    assert.match(requests[0].body.metadata.idempotency_key, /^memory-cli:session-manual:/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("memory CLI add writes a Codex trace event from current turn bridge", async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push({
      url: req.url,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true, data: { task_id: "add-task", status: "queued" } }));
  });
  const baseUrl = await listen(server);
  const root = await mkdtemp(join(tmpdir(), "memorax-code-cli-add-trace-"));
  const memoryFile = join(root, "memory.txt");
  await writeFile(memoryFile, "Trace bridge add memory.", "utf8");
  await writeCurrentCodexTurn(traceContextFromHookBody({
    session_id: "session-cli-add",
    turn_id: "turn-cli-add",
  }), {
    memoraxCodeHome: root,
  });

  try {
    const result = await runMemoryCli([
      "add",
      "--memory-file",
      memoryFile,
      "--type",
      "procedural",
      "--reason",
      "Trace bridge add.",
    ], {
      env: {
        CODEX_THREAD_ID: "session-cli-add",
        MEMORAX_CODE_HOME: root,
        MEMORAX_CODE_MEMORY_CLI_ADD_ENABLED: "true",
        MEMORAX_CODE_MEMORAX_ENDPOINT: baseUrl,
        MEMORAX_CODE_MEMORAX_API_KEY: "secret",
        MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
      },
    });

    assert.equal(result.ok, true);
    assert.equal(requests.length, 1);
    const events = (await readFile(tracePaths(root).eventsJsonl("session-cli-add"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, "memory_cli_add");
    assert.equal(events[0].source, "memory_cli");
    assert.equal(events[0].trace.session_id, "session-cli-add");
    assert.equal(events[0].trace.turn_id, "turn-cli-add");
    assert.equal(events[0].trace.context_origin, "current-turn-file");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("memory CLI search ignores stale or disabled current turn bridge without failing", async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ success: true, data: { data: [] } }));
  });
  const baseUrl = await listen(server);
  const staleRoot = await mkdtemp(join(tmpdir(), "memorax-code-cli-stale-trace-"));
  const disabledRoot = await mkdtemp(join(tmpdir(), "memorax-code-cli-disabled-trace-"));
  await writeFile(join(disabledRoot, "config.toml"), [
    "[trace.codex]",
    "enabled = false",
    "",
  ].join("\n"), "utf8");
  await mkdir(tracePaths(staleRoot).root, { recursive: true });
  await writeFile(tracePaths(staleRoot).currentTurnPath, JSON.stringify({
    schema_version: "1",
    trace: {
      client: "codex",
      session_id: "session-cli-stale",
      turn_id: "turn-cli-stale",
      context_origin: "codex-hook-body",
      captured_at: "2000-01-01T00:00:00.000Z",
    },
  }), "utf8");

  try {
    const stale = await runMemoryCli(["search", "--query", "stale trace"], {
      env: {
        CODEX_THREAD_ID: "session-cli-stale",
        MEMORAX_CODE_HOME: staleRoot,
        MEMORAX_CODE_MEMORAX_ENDPOINT: baseUrl,
        MEMORAX_CODE_MEMORAX_API_KEY: "secret",
        MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
      },
    });
    assert.equal(stale.ok, true);
    await assert.rejects(readFile(tracePaths(staleRoot).eventsJsonl("session-cli-stale"), "utf8"));

    const disabled = await runMemoryCli(["search", "--query", "disabled trace"], {
      env: {
        CODEX_THREAD_ID: "session-cli-disabled",
        MEMORAX_CODE_HOME: disabledRoot,
        MEMORAX_CODE_MEMORAX_ENDPOINT: baseUrl,
        MEMORAX_CODE_MEMORAX_API_KEY: "secret",
        MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
      },
    });
    assert.equal(disabled.ok, true);
    await assert.rejects(readFile(tracePaths(disabledRoot).eventsJsonl("session-cli-disabled"), "utf8"));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

async function createRepositoryMetadata(workspace, repositoryName) {
  const gitDir = join(workspace, ".git");
  await mkdir(join(gitDir, "objects"), { recursive: true });
  await mkdir(join(gitDir, "refs", "heads"), { recursive: true });
  await writeFile(join(gitDir, "HEAD"), "ref: refs/heads/main\n", "utf8");
  await writeFile(
    join(gitDir, "config"),
    `[remote "origin"]\n\turl = https://example.test/owner/${repositoryName}.git\n`,
    "utf8",
  );
  return gitDir;
}

async function createLinkedWorktreeMetadata(workspace, commonDir, name) {
  const adminDir = join(commonDir, "worktrees", name);
  await mkdir(adminDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(join(adminDir, "HEAD"), "ref: refs/heads/main\n", "utf8");
  await writeFile(join(adminDir, "commondir"), "../..\n", "utf8");
  await writeFile(join(workspace, ".git"), `gitdir: ${adminDir}\n`, "utf8");
}
