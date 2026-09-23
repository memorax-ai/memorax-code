import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import fsPromises, { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { promisify } from "node:util";
import { runMemoryCli } from "../../dist/memory/cli.js";
import {
  traceContextFromClaudeHookBody,
  traceContextFromCodeBuddyHookBody,
  traceContextFromCursorHookBody,
  traceContextFromDshTurnStart,
  traceContextFromHookBody,
  traceContextFromOpenCodeHookBody,
} from "../../dist/trace/context.js";
import {
  claudeTracePaths,
  clientTracePaths,
  codeBuddyTracePaths,
  dshTracePaths,
  openCodeTracePaths,
  tracePaths,
} from "../../dist/trace/config.js";
import {
  writeCurrentClaudeTurn,
  writeCurrentCodeBuddyTurn,
  writeCurrentCodexTurn,
  writeCurrentTraceTurn,
} from "../../dist/trace/store.js";
import { listen } from "../support/helpers.mjs";

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

test("memory CLI config-only status does not resolve or persist workspace scope", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-cli-config-only-"));
  const memoraxCodeHome = join(root, "memorax-code-home");
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const options = {
    cwd: workspace,
    env: {
      MEMORAX_CODE_HOME: memoraxCodeHome,
      MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
      MEMORAX_CODE_MEMORAX_API_KEY: "secret",
      MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
    },
  };
  const realpath = t.mock.method(fsPromises, "realpath");
  const workspaceProbes = () => realpath.mock.calls.filter(({ arguments: args }) => args[0] === workspace);

  try {
    const result = await runMemoryCli(["status", "--config-only"], options);
    assert.equal(result.ok, true);
    assert.equal(result.action, "memory.status");
    assert.equal(result.provider, "memory.memorax");
    assert.equal(result.config.configured, true);
    assert.equal("repository" in result, false);
    assert.equal(result.workspace, undefined);
    assert.equal(result.effectiveUserId, undefined);
    assert.equal(workspaceProbes().length, 0, "config-only status must not probe the workspace");
    assert.deepEqual(await readdir(root), ["workspace"]);
    assert.deepEqual(await readdir(workspace), []);

    const scoped = await runMemoryCli(["status"], options);
    assert.equal(scoped.workspaceScope, "bound");
    assert.ok(workspaceProbes().length > 0, "ordinary status must exercise the workspace probe");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("memory CLI forwards work source restrictions without changing legacy searches", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-cli-work-search-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "office");
  await mkdir(workspace);
  const env = {
    MEMORAX_CODE_HOME: join(root, "state"),
    MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
    MEMORAX_CODE_MEMORAX_API_KEY: "test-secret",
    MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
  };
  const cases = [
    [[], {}],
    [["--sources", "document"], { sources: ["document"], output_mode: "facts" }],
    [["--sources", "dialogue"], { sources: ["dialogue"], output_mode: "facts" }],
    [["--sources", "dialogue,document"], { sources: ["dialogue", "document"], output_mode: "facts" }],
    [["--sources", "document", "--document-id", "expense-policy", "--document-id", "travel,policy"],
      { sources: ["document"], document_ids: ["expense-policy", "travel,policy"], output_mode: "facts" }],
  ];
  for (const [flags, scope] of cases) {
    const requests = [];
    const result = await runMemoryCli(["search", "--query", "approval threshold", ...flags], {
      cwd: workspace, env,
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(init.body) });
        return Response.json({ success: true, data: { data: [{
          id: "policy-fact", memory: "Approval required over CNY 5000.", content_type: "document",
        }] } });
      },
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.match(result.answer, /Approval required over CNY 5000/);
    assert.deepEqual(requests, [{
      url: "http://memorax.test/v1/memories/search",
      body: { query: "approval threshold", user_id: "user-1@office", top_k: 6, k_dense: 6, k_sparse: 6, ...scope },
    }]);
  }
});

test("memory CLI rejects invalid work scopes without issuing a search", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-cli-invalid-work-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = {
    MEMORAX_CODE_HOME: join(root, "state"),
    MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
    MEMORAX_CODE_MEMORAX_API_KEY: "test-secret",
    MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
  };
  const invalid = [
    ["--sources"], ["--sources", ""], ["--sources", "code"],
    ["--sources", "document,"], ["--sources", "document,document"],
    ["--sources", "document", "--sources", "dialogue"], ["--sources=document"],
    ["--document-id"], ["--document-id", ""], ["--document-id", "expense-policy"],
    ["--sources", "dialogue", "--document-id", "expense-policy"],
    ["--sources", "dialogue,document", "--document-id", "expense-policy"],
    ["--sources", "document", "--document-id", "--limit", "3"],
    ["--sources", "document", ...Array.from({ length: 101 }, (_, index) => ["--document-id", `doc-${index}`]).flat()],
  ];
  for (const flags of invalid) {
    let called = false;
    const result = await runMemoryCli(["search", "--query", "approval threshold", ...flags], {
      cwd: root, env,
      fetchImpl: async () => { called = true; throw new Error("must not fetch"); },
    });
    assert.equal(result.ok, false, JSON.stringify(flags));
    assert.equal(result.errorCode, "MEMORY_INPUT_INVALID", JSON.stringify(result));
    assert.equal(called, false);
  }
});

test("memory CLI does not broaden source restrictions after server rejection", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-cli-unsupported-work-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let requests = 0;
  const result = await runMemoryCli(["search", "--query", "policy", "--sources", "document"], {
    cwd: root,
    env: {
      MEMORAX_CODE_HOME: join(root, "state"),
      MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
      MEMORAX_CODE_MEMORAX_API_KEY: "test-secret",
      MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
    },
    fetchImpl: async () => {
      requests += 1;
      return Response.json({ detail: "sources unsupported" }, { status: 422 });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(requests, 1);
});

test("memory CLI preserves non-Git turn scope across trace settings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-cli-local-turn-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "notes");
  const nested = join(workspace, "src");
  await mkdir(nested, { recursive: true });
  for (const [enabled, captureContent] of [["true", "true"], ["false", "true"], ["true", "false"]]) {
    const memoraxCodeHome = join(root, `home-${enabled}-${captureContent}`);
    const env = {
      CODEX_THREAD_ID: "session-local-turn",
      MEMORAX_CODE_HOME: memoraxCodeHome,
      MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
      MEMORAX_CODE_MEMORAX_API_KEY: "secret",
      MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
      MEMORAX_CODE_CODEX_TRACE_ENABLED: enabled,
      MEMORAX_CODE_CODEX_TRACE_CAPTURE_CONTENT: captureContent,
    };
    await writeCurrentCodexTurn(traceContextFromHookBody({
      session_id: "session-local-turn",
      turn_id: "turn-local-turn",
      cwd: workspace,
    }), { memoraxCodeHome, env });
    const requests = [];
    const options = {
      cwd: nested,
      env,
      fetchImpl: async (url, init) => {
        requests.push(JSON.parse(init.body));
        const data = String(url).endsWith("/add") ? { task_id: "scope-add", status: "queued" } : { data: [] };
        return new Response(JSON.stringify({ success: true, data }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    };
    const result = await runMemoryCli(["search", "--query", "nested workspace note"], options);
    assert.equal(result.ok, true);
    assert.equal(result.effectiveUserId, "user-1@notes", `trace enabled=${enabled}, captureContent=${captureContent}`);
    assert.equal(requests[0].user_id, "user-1@notes");
    if (enabled === "false") {
      const added = await runMemoryCli([
        "add", "--memory", "Keep the original workspace scope.", "--type", "procedural", "--reason", "Explicit test save.",
      ], options);
      assert.equal(added.ok, true);
      assert.equal(added.effectiveUserId, "user-1@notes");
      assert.equal(requests[1].user_id, "user-1@notes");
    }
  }
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
    "Start a new Codex, Claude Code, CodeBuddy CLI, WorkBuddy, DSH, OpenCode, or Cursor session from the target repository or local workspace.",
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
    "Start a new Codex, Claude Code, CodeBuddy CLI, WorkBuddy, DSH, OpenCode, or Cursor session from the target repository or local workspace.",
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

test("memory CLI preserves projectless turn scope across trace settings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-cli-projectless-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const taskRoot = join(root, "2026-07-13", "new-chat-2");
  const taskWork = join(taskRoot, "work");
  await mkdir(taskWork, { recursive: true });
  for (const [enabled, captureContent] of [["true", "true"], ["false", "true"], ["true", "false"]]) {
    const memoraxCodeHome = join(root, `home-${enabled}-${captureContent}`);
    const env = {
      CODEX_THREAD_ID: "session-projectless",
      MEMORAX_CODE_HOME: memoraxCodeHome,
      MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
      MEMORAX_CODE_MEMORAX_API_KEY: "secret",
      MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
      MEMORAX_CODE_CODEX_TRACE_ENABLED: enabled,
      MEMORAX_CODE_CODEX_TRACE_CAPTURE_CONTENT: captureContent,
    };
    await writeCurrentCodexTurn(traceContextFromHookBody({
      session_id: "session-projectless",
      turn_id: "turn-projectless",
      cwd: taskRoot,
      workspace_kind: "projectless",
    }), { memoraxCodeHome, env });
    const requests = [];
    const options = {
      cwd: taskWork,
      env,
      fetchImpl: async (url, init) => {
        requests.push(JSON.parse(init.body));
        const data = String(url).endsWith("/add") ? { task_id: "general-add", status: "queued" } : { data: [] };
        return new Response(JSON.stringify({ success: true, data }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    };
    const result = await runMemoryCli(["search", "--query", "projectless scope"], options);
    assert.equal(result.ok, true);
    assert.equal(result.scopeKind, "general", `trace enabled=${enabled}, captureContent=${captureContent}`);
    assert.equal(result.workspace, "General");
    assert.equal(result.effectiveUserId, "user-1@General");
    assert.equal(requests[0].user_id, "user-1@General");
    if (enabled === "false") {
      const added = await runMemoryCli([
        "add", "--memory", "Keep shared general preferences.", "--type", "preference", "--reason", "Explicit test save.",
      ], options);
      assert.equal(added.ok, true);
      assert.equal(added.effectiveUserId, "user-1@General");
      assert.equal(requests[1].user_id, "user-1@General");
      assert.equal(requests[1].metadata.memorax_code_memory_scope, "general.v1");
    }
  }
});

test("memory CLI binds a Cursor projectless turn without cwd to General", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-cli-cursor-projectless-"));
  const commandWorkspace = join(root, "cursor-command-workspace");
  const memoraxCodeHome = join(root, "memorax-code-home");
  await mkdir(commandWorkspace, { recursive: true });
  const sessionId = "cursor-projectless-session";
  const env = {
    MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT: "cursor",
    MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID: sessionId,
    MEMORAX_CODE_HOME: memoraxCodeHome,
    MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
    MEMORAX_CODE_MEMORAX_API_KEY: "secret",
    MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
  };
  await writeCurrentTraceTurn(traceContextFromCursorHookBody({
    client: "cursor", sessionId, turnId: "cursor-projectless-turn", workspaceKind: "projectless",
  }), { memoraxCodeHome, env });
  const requests = [];
  const options = {
    cwd: commandWorkspace,
    env,
    fetchImpl: async (url, init) => {
      requests.push(JSON.parse(init.body));
      const data = String(url).endsWith("/add") ? { task_id: "cursor-general-add", status: "queued" } : { data: [] };
      return new Response(JSON.stringify({ success: true, data }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    },
  };
  try {
    const search = await runMemoryCli(["search", "--query", "Cursor General scope"], options);
    assert.equal(search.ok, true);
    assert.equal(search.effectiveUserId, "user-1@General");
    const add = await runMemoryCli([
      "add", "--memory", "Keep Cursor General preferences.", "--type", "preference", "--reason", "Explicit test save.",
    ], options);
    assert.equal(add.ok, true);
    assert.equal(add.effectiveUserId, "user-1@General");
    assert.deepEqual(requests.map(({ user_id }) => user_id), ["user-1@General", "user-1@General"]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("memory CLI validates command cwd before using a projectless turn without cwd", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-cli-projectless-no-cwd-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const memoraxCodeHome = join(root, "memorax-code-home");
  const commandWorkspace = join(root, "arbitrary-command-workspace");
  const repository = join(root, "repository");
  await mkdir(commandWorkspace, { recursive: true });
  await createRepositoryMetadata(repository, "My-Project");
  await writeCurrentCodexTurn(traceContextFromHookBody({
    session_id: "session-projectless-no-cwd",
    turn_id: "turn-projectless-no-cwd",
    workspace_kind: "projectless",
  }), { memoraxCodeHome });

  const requests = [];
  const options = {
    env: {
      CODEX_THREAD_ID: "session-projectless-no-cwd",
      MEMORAX_CODE_HOME: memoraxCodeHome,
      MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
      MEMORAX_CODE_MEMORAX_API_KEY: "secret",
      MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
    },
    fetchImpl: async (url, init) => {
      requests.push(JSON.parse(init.body));
      const data = String(url).endsWith("/add") ? { task_id: "general-add", status: "queued" } : { data: [] };
      return new Response(JSON.stringify({ success: true, data }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
  for (const [cwd, failureReason] of [
    [commandWorkspace, undefined],
    [repository, "workspace_scope_mismatch"],
    [join(root, "missing"), "workspace_scope_unavailable"],
  ]) {
    const requestCount = requests.length;
    for (const args of [
      ["search", "--query", "Keep General within a verified non-Git workspace."],
      ["add", "--memory", "Shared preference.", "--type", "preference", "--reason", "Explicit test save."],
    ]) {
      const result = await runMemoryCli(args, { ...options, cwd });
      assert.equal(result.ok, failureReason === undefined, `${args[0]} in ${cwd}`);
      if (failureReason) {
        assert.equal(result.workspaceScopeReason, failureReason);
      } else {
        assert.equal(result.scopeKind, "general");
        assert.equal(result.workspace, "General");
        assert.equal(result.effectiveUserId, "user-1@General");
      }
    }
    assert.equal(requests.length - requestCount, failureReason ? 0 : 2);
  }
  assert.deepEqual(requests.map((request) => request.user_id), ["user-1@General", "user-1@General"]);
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
    cwd: new URL("../..", import.meta.url),
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
      cwd: new URL("../..", import.meta.url),
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
      cwd: new URL("../..", import.meta.url),
      env,
    });

    assert.match(plain.stdout, /<memories>/);
    assert.match(plain.stdout, /Trace collection uses request-time structured tracing/);
    assert.doesNotMatch(plain.stdout, /raw-memory-id/);
    assert.doesNotMatch(plain.stdout, /private-api-key-uuid/);
    assert.doesNotMatch(plain.stdout, /matched_facts/);

    const json = await execFileAsync(process.execPath, ["dist/memorax-cli.js", "search", "--query", "trace collection", "--json"], {
      cwd: new URL("../..", import.meta.url),
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
  let observedQuota;
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
        balances: [{
          product_code: "memory_api",
          feature_code: "memory_search",
          spec_key: "calls",
          quota_unit: "times",
          quota_limit: 10_000,
          reserved: 1,
          consumed: 0,
          remaining: 4_800,
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
      claimQuotaNotice: async (_config, quota) => {
        observedQuota = quota;
        return "MemoraX Code quota is running low.";
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
    assert.deepEqual(observedQuota, {
      featureCode: "memory_search",
      remaining: 4_800,
      limit: 10_000,
    });
    assert.equal(result.quotaNotice, "MemoraX Code quota is running low.");
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

test("memory CLI search binds to the current WorkBuddy trace and workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-cli-workbuddy-trace-"));
  const sessionId = "workbuddy-cli-session";
  const workspace = join(root, "workbuddy-workspace");
  const nestedCwd = join(workspace, "src");
  const otherWorkspace = join(root, "other-workspace");
  await Promise.all([
    mkdir(nestedCwd, { recursive: true }),
    mkdir(otherWorkspace, { recursive: true }),
  ]);
  await writeCurrentTraceTurn(traceContextFromCodeBuddyHookBody({
    client: "workbuddy",
    session_id: sessionId,
    turn_id: "workbuddy-turn",
    cwd: workspace,
  }), { client: "workbuddy", memoraxCodeHome: root });
  const requests = [];
  const env = {
    MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT: "workbuddy",
    MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID: sessionId,
    MEMORAX_CODE_HOME: root,
    MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
    MEMORAX_CODE_MEMORAX_API_KEY: "secret",
    MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
  };
  const fetchImpl = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ success: true, data: { data: [] } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };

  const search = await runMemoryCli(["search", "--query", "WorkBuddy trace bridge"], {
    cwd: nestedCwd,
    env,
    fetchImpl,
  });
  assert.equal(search.ok, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].user_id, "user-1@workbuddy-workspace");

  const rejected = await runMemoryCli(["search", "--query", "must not cross workspaces"], {
    cwd: otherWorkspace,
    env,
    fetchImpl,
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /does not match the current WorkBuddy turn repository\/workspace scope/);
  assert.equal(rejected.workspaceScopeReason, "workspace_scope_mismatch");
  assert.equal(
    rejected.userAction,
    "Start a new Codex, Claude Code, CodeBuddy CLI, WorkBuddy, DSH, OpenCode, or Cursor session from the target repository or local workspace.",
  );
  assert.equal(requests.length, 1);

  const events = (await readFile(clientTracePaths("workbuddy", root).eventsJsonl(sessionId), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "memory_cli_search");
  assert.equal(events[0].source, "memory_cli");
  assert.equal(events[0].trace.client, "workbuddy");
  assert.equal(events[0].trace.session_id, sessionId);
  assert.equal(events[0].trace.turn_id, "workbuddy-turn");
  assert.equal(events[0].trace.context_origin, "current-turn-file");
  const addArgs = ["add", "--memory", "The expense approval request is pending.", "--type", "episodic", "--reason", "Save office requirement"];
  assert.equal((await runMemoryCli(addArgs, { cwd: nestedCwd, env, fetchImpl })).ok, true);
  assert.equal(requests[1].content_type, "dialogue");
  assert.equal(requests[1].mode, "default");
  assert.equal((await runMemoryCli([...addArgs, "--content-type", "code"], { cwd: nestedCwd, env, fetchImpl })).ok, true);
  assert.equal(requests[2].content_type, "code");
  assert.equal(requests[2].mode, "pre_summarized");
  const { MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT, MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID, ...nativeEnv } = env;
  assert.equal((await runMemoryCli(addArgs, {
    cwd: nestedCwd, env: { ...nativeEnv, CODEBUDDY_SESSION_ID: sessionId }, fetchImpl,
  })).ok, true);
  assert.equal(requests[3].content_type, "dialogue", "native WorkBuddy binding must use the resolved client, not the shared environment variable name");
});

test("memory CLI Add preserves validated explicit WorkBuddy identity during cwd fallback", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-cli-workbuddy-fallback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const env = {
    MEMORAX_CODE_HOME: root,
    MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
    MEMORAX_CODE_MEMORAX_API_KEY: "secret",
    MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
    MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT: "workbuddy",
    MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID: "fallback-session",
  };
  const requests = [];
  const options = {
    cwd: workspace, env,
    fetchImpl: async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ success: true, data: { task_id: "add-task", status: "queued" } }));
    },
  };
  const args = ["add", "--memory", "Approval is required.", "--type", "episodic", "--reason", "Save requirement"];
  for (const scenario of ["missing", "stale"]) {
    if (scenario === "stale") {
      await writeCurrentTraceTurn(traceContextFromCodeBuddyHookBody({
        client: "workbuddy", session_id: "fallback-session", turn_id: "expired-turn",
        cwd: join(root, "old-workspace"),
      }), { client: "workbuddy", memoraxCodeHome: root, now: () => new Date(0) });
    }
    const result = await runMemoryCli(args, options);
    assert.equal(result.ok, true, scenario);
    assert.equal(result.effectiveUserId, "user-1@workspace", scenario);
    assert.equal(requests.at(-1).content_type, "dialogue", scenario);
    assert.equal(requests.at(-1).mode, "default", scenario);
    await assert.rejects(readFile(clientTracePaths("workbuddy", root).eventsJsonl("fallback-session"), "utf8"));
  }
  for (const overrides of [
    { MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID: undefined },
    { MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT: "unknown" },
    { MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT: undefined, MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID: undefined, CODEBUDDY_SESSION_ID: "missing-native" },
  ]) {
    assert.equal((await runMemoryCli(args, { ...options, env: { ...env, ...overrides } })).ok, true);
    assert.equal(requests.at(-1).content_type, "code");
  }
  for (const override of [
    { args: [...args, "--content-type", "code"], env },
    { args, env: { ...env, MEMORAX_CODE_MEMORAX_ADD_CONTENT_TYPE: "code" } },
  ]) {
    assert.equal((await runMemoryCli(override.args, { ...options, env: override.env })).ok, true);
    assert.equal(requests.at(-1).content_type, "code");
  }
});

test("memory CLI keeps same-ID client bindings separate from an inherited Codex thread", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-code-cli-general-client-trace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sessionId = "shared-cli-session";
  const clients = [
    { client: "opencode", workspace: join(root, "Default Project"), turnId: "opencode-user-message", paths: openCodeTracePaths },
    { client: "workbuddy", workspace: join(root, "WorkBuddy"), turnId: "workbuddy-turn", paths: (home) => clientTracePaths("workbuddy", home) },
    { client: "codex", workspace: join(root, "new-chat"), turnId: "codex-turn", paths: tracePaths },
    { client: "codebuddy", workspace: join(root, "cli-workspace"), turnId: "codebuddy-turn", paths: codeBuddyTracePaths },
    { client: "cursor", workspace: join(root, "cursor-workspace"), turnId: "cursor-turn", paths: (home) => clientTracePaths("cursor", home) },
  ];
  for (const { workspace } of clients) await mkdir(join(workspace, "work"), { recursive: true });
  await writeCurrentCodexTurn(traceContextFromHookBody({
    session_id: sessionId,
    turn_id: "codex-turn",
    cwd: clients[2].workspace,
    workspace_kind: "projectless",
  }), { memoraxCodeHome: root });
  for (const { client, workspace, turnId } of [clients[1], clients[3]]) {
    await writeCurrentTraceTurn(traceContextFromCodeBuddyHookBody({
      client,
      session_id: sessionId,
      turn_id: turnId,
      cwd: workspace,
      ...(client === "workbuddy" ? { workspace_kind: "projectless" } : {}),
    }), { client, memoraxCodeHome: root });
  }
  await writeCurrentTraceTurn(traceContextFromOpenCodeHookBody({
    sessionId,
    userMessageId: "opencode-user-message",
    cwd: clients[0].workspace,
    workspaceKind: "projectless",
  }), { client: "opencode", memoraxCodeHome: root });
  await writeCurrentTraceTurn(traceContextFromCursorHookBody({
    sessionId,
    turnId: "cursor-turn",
    cwd: clients[4].workspace,
  }), { client: "cursor", memoraxCodeHome: root });
  const requests = [];
  const fetchImpl = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ success: true, data: { data: [] } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  for (const [index, { client, workspace, turnId, paths }] of clients.entries()) {
    const options = {
      env: {
        CODEX_THREAD_ID: sessionId,
        ...(client === "codex" ? {} : (client === "codebuddy" || client === "workbuddy") ? {
          CODEBUDDY_SESSION_ID: sessionId,
        } : {
          MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT: client,
          MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID: sessionId,
        }),
        MEMORAX_CODE_HOME: root,
        MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
        MEMORAX_CODE_MEMORAX_API_KEY: "secret",
        MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
      },
      cwd: join(workspace, "work"),
      fetchImpl,
    };
    const result = await runMemoryCli(["search", "--query", "shared general preference"], options);
    assert.equal(result.ok, true, client);
    assert.equal(result.scopeKind, ["codebuddy", "cursor"].includes(client) ? "local-directory" : "general", client);
    assert.equal(requests.length, index + 1);
    assert.equal(requests[index].user_id, client === "cursor" ? "user-1@cursor-workspace" : client === "codebuddy" ? "user-1@cli-workspace" : "user-1@General", client);
    const events = (await readFile(paths(root).eventsJsonl(sessionId), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(events.length, 1, client);
    assert.equal(events[0].type, "memory_cli_search");
    assert.equal(events[0].trace.client, client);
    assert.equal(events[0].trace.session_id, sessionId);
    assert.equal(events[0].trace.turn_id, turnId);
    assert.equal(events[0].trace.context_origin, "current-turn-file");
    if (index === 0) {
      await assert.rejects(readFile(tracePaths(root).eventsJsonl(sessionId), "utf8"));
      await assert.rejects(readFile(codeBuddyTracePaths(root).eventsJsonl(sessionId), "utf8"));
    }
    const rejected = await runMemoryCli(["search", "--query", "must stay in the current workspace"], {
      ...options,
      cwd: clients[(index + 1) % clients.length].workspace,
    });
    assert.equal(rejected.ok, false, client);
    assert.equal(rejected.workspaceScopeReason, "workspace_scope_mismatch", client);
    assert.equal(requests.length, index + 1, "shared remote identity must not permit a different local workspace");
  }
  const workBuddyWorkspace = clients[1].workspace;
  await writeCurrentCodeBuddyTurn(traceContextFromCodeBuddyHookBody({
    session_id: sessionId,
    turn_id: "codebuddy-shared-workspace",
    cwd: workBuddyWorkspace,
  }), { memoraxCodeHome: root });
  const nativeOptions = {
    cwd: join(workBuddyWorkspace, "work"),
    env: {
      CODEBUDDY_SESSION_ID: sessionId,
      MEMORAX_CODE_HOME: root,
      MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
      MEMORAX_CODE_MEMORAX_API_KEY: "secret",
      MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
    },
    fetchImpl,
  };
  const ambiguous = await runMemoryCli(["search", "--query", "ambiguous native client"], nativeOptions);
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.error, /cannot uniquely bind/);
  assert.equal(requests.length, clients.length);
  for (const client of ["workbuddy", "codebuddy"]) {
    const explicit = await runMemoryCli(["search", "--query", "explicit native client"], {
      ...nativeOptions,
      env: {
        ...nativeOptions.env,
        MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT: client,
        MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID: sessionId,
      },
    });
    assert.equal(explicit.ok, true, client);
    assert.equal(explicit.scopeKind, client === "workbuddy" ? "general" : "local-directory", client);
  }
  for (const scenario of ["missing", "stale"]) {
    const fallbackSessionId = `${scenario}-native-session`;
    if (scenario === "stale") {
      for (const client of ["codebuddy", "workbuddy"]) {
        await writeCurrentTraceTurn(traceContextFromCodeBuddyHookBody({
          client,
          session_id: fallbackSessionId,
          turn_id: "expired-turn",
          cwd: workBuddyWorkspace,
          workspace_kind: "projectless",
        }), { client, memoraxCodeHome: root, now: () => new Date(0) });
      }
    }
    const previousRequests = requests.length;
    const fallback = await runMemoryCli(["search", "--query", `${scenario} native turn uses cwd`], {
      ...nativeOptions,
      cwd: clients[3].workspace,
      env: { ...nativeOptions.env, CODEBUDDY_SESSION_ID: fallbackSessionId },
    });
    assert.equal(fallback.ok, true, scenario);
    assert.equal(fallback.scopeKind, "local-directory", scenario);
    assert.equal(fallback.effectiveUserId, "user-1@cli-workspace", scenario);
    assert.equal(requests.length, previousRequests + 1, scenario);
    assert.equal(requests.at(-1).user_id, "user-1@cli-workspace", scenario);
    for (const client of ["codebuddy", "workbuddy"]) {
      await assert.rejects(readFile(clientTracePaths(client, root).eventsJsonl(fallbackSessionId), "utf8"));
    }
  }
});

test("memory CLI binds DSH search and add to the current turn scope", async () => {
  const requests = [];
  const fetchImpl = async (url) => {
    requests.push(new URL(String(url)).pathname);
    return new Response(
      JSON.stringify({ success: true, data: { task_id: "dsh-task", status: "queued", data: [] } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const root = await mkdtemp(join(tmpdir(), "memorax-code-cli-dsh-trace-"));
  const workspace = join(root, "workspace");
  const nested = join(workspace, "src");
  const otherWorkspace = join(root, "other");
  const sessionId = "session-dsh-cli";
  await Promise.all([
    mkdir(nested, { recursive: true }),
    mkdir(otherWorkspace, { recursive: true }),
  ]);
  await writeCurrentTraceTurn(traceContextFromDshTurnStart({
    sessionId,
    turn: 4,
    cwd: workspace,
  }), { client: "dsh", memoraxCodeHome: root });
  await writeCurrentClaudeTurn(traceContextFromClaudeHookBody({
    session_id: "unrelated-claude-session",
    prompt_id: "unrelated-claude-turn",
    cwd: workspace,
  }), { memoraxCodeHome: root });
  const env = {
    CODEX_THREAD_ID: "unrelated-codex-session",
    DSH_SHELL: "1",
    DSH_SESSION_ID: sessionId,
    MEMORAX_CODE_MEMORY_CLI_TRACE_CLIENT: "claude",
    MEMORAX_CODE_MEMORY_CLI_TRACE_SESSION_ID: "unrelated-claude-session",
    MEMORAX_CODE_HOME: root,
    MEMORAX_CODE_MEMORY_CLI_ADD_ENABLED: "true",
    MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
    MEMORAX_CODE_MEMORAX_API_KEY: "secret",
    MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
  };
  const run = (args, cwd) => runMemoryCli(args, { cwd, env, fetchImpl });

  const missingSession = await runMemoryCli(["search", "--query", "missing DSH session"], {
    cwd: nested,
    env: { ...env, DSH_SESSION_ID: "" },
    fetchImpl,
  });
  assert.equal(missingSession.ok, true);
  await assert.rejects(readFile(claudeTracePaths(root).eventsJsonl("unrelated-claude-session"), "utf8"));

  const rejected = await run(["search", "--query", "must not cross workspaces"], otherWorkspace);
  assert.equal(rejected.ok, false);
  assert.match(rejected.error, /does not match the current DSH turn repository\/workspace scope/);
  assert.equal(rejected.workspaceScopeReason, "workspace_scope_mismatch");
  assert.equal(requests.length, 1);

  const search = await run(["search", "--query", "DSH trace bridge"], nested);
  const add = await run([
    "add",
    "--memory",
    "DSH manual memory.",
    "--type",
    "procedural",
    "--reason",
    "Verify DSH manual memory binding.",
  ], nested);

  assert.equal(search.ok, true);
  assert.equal(add.ok, true);
  assert.deepEqual(requests, ["/v1/memories/search", "/v1/memories/search", "/v1/memories/add"]);
  const events = (await readFile(dshTracePaths(root).eventsJsonl(sessionId), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => ({
    type: event.type,
    source: event.source,
    client: event.trace.client,
    sessionId: event.trace.session_id,
    turnId: event.trace.turn_id,
  })), [
    { type: "memory_cli_search", source: "memory_cli", client: "dsh", sessionId, turnId: "4" },
    { type: "memory_cli_add", source: "memory_cli", client: "dsh", sessionId, turnId: "4" },
  ]);
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

test("memory CLI search tolerates missing or stale current-turn state", async () => {
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


test("memory CLI work routing preserves legacy code mode and idempotency while honoring type precedence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "memorax-cli-routing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  await mkdir(home);
  const requests = [];
  const options = { cwd: root, env: {
    MEMORAX_CODE_HOME: home, MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
    MEMORAX_CODE_MEMORAX_API_KEY: "secret", MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
  }, fetchImpl: async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ success: true, data: { task_id: "routing", status: "queued" } }));
  } };
  const args = ["add", "--memory", "Verified fact", "--type", "semantic", "--reason", "Retain evidence", "--session-id", "routing-session"];
  const legacyKey = `memory-cli:routing-session:${createHash("sha256").update("semantic\nRetain evidence\nVerified fact").digest("hex").slice(0, 16)}`;
  for (const config of ["", '[memory.add]\ncontent_type = "code"\nmode = "default"\n']) {
    await writeFile(join(home, "config.toml"), config);
    const result = await runMemoryCli(args, options);
    assert.equal(result.ok, true, result.error);
    assert.equal(requests.at(-1).content_type, "code");
    assert.equal(requests.at(-1).mode, "pre_summarized");
    assert.equal(requests.at(-1).metadata.idempotency_key, legacyKey);
  }
  await writeFile(join(home, "config.toml"), '[memory.add]\ncontent_type = "dialogue"\n');
  assert.equal((await runMemoryCli(args, options)).ok, true);
  assert.equal(requests.at(-1).content_type, "dialogue");
  assert.equal(requests.at(-1).mode, "default");
  assert.equal(requests.at(-1).metadata.idempotency_key, `${legacyKey}:dialogue`);
  const envOverride = { ...options, env: { ...options.env, MEMORAX_CODE_MEMORAX_ADD_CONTENT_TYPE: "code" } };
  assert.equal((await runMemoryCli(args, envOverride)).ok, true);
  assert.equal(requests.at(-1).content_type, "code");
  assert.equal((await runMemoryCli([...args, "--content-type", "dialogue"], envOverride)).ok, true);
  assert.equal(requests.at(-1).content_type, "dialogue");
  const count = requests.length;
  for (const invalid of [
    ["--content-type", "document"], ["--content-type", "work"],
    ["--content-type", "dialogue", "--mode", "pre_summarized"],
  ]) assert.equal((await runMemoryCli([...args, ...invalid], options)).ok, false);
  assert.equal(requests.length, count);
});
