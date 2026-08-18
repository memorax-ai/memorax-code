import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { resolveMemoryProject } from "../../../dist/memory/project.js";
import { authorized, memoryViewerSessionCookieHeader } from "../../../dist/transport/http/request.js";
import { handleMemoryViewerRequest } from "../../../dist/viewer/http/public-routes.js";
import { memoryViewerObservabilityHook } from "../../../dist/viewer/projection/observability.js";
import {
  clearMemoryViewerEvents,
  recordMemoryViewerEvent,
} from "../../../dist/viewer/store.js";

test.beforeEach(() => clearMemoryViewerEvents());

test("memory viewer user route renders the compact summary surface", async () => {
  const { url, close } = await viewerServer();
  try {
    const response = await fetch(`${url}/memory-viewer?client=opencode&token=viewer-token`);
    const html = await response.text();
    assert.equal(response.status, 200);
    assert.match(html, /<html lang="en" data-theme="light">/);
    assert.match(html, /Memory at a glance/);
    assert.match(html, /id="client-select"/);
    assert.match(html, /<option value="codex">Codex<\/option>/);
    assert.match(html, /<option value="claude-code">Claude Code<\/option>/);
    assert.match(html, /<option value="dsh">DeepSeek<\/option>/);
    assert.match(html, /<option value="opencode">OpenCode<\/option>/);
    assert.match(html, /id="language-toggle"/);
    assert.match(html, /id="theme-toggle"/);
    assert.match(html, /LANGUAGE_STORAGE_KEY,\['zh','en'\],'en'/);
    assert.match(html, /memorax-code-memory-viewer-language/);
    assert.match(html, /memorax-code-memory-viewer-theme/);
    assert.match(html, /rel="icon" type="image\/png" sizes="64x64" href="\/memory-viewer\/favicon\.png"/);
    assert.match(html, /params\.has\('token'\)/);
    assert.match(html, /bootstrapUrl\.searchParams\.delete\('token'\)/);
    assert.match(html, /history\.replaceState\(null,'',bootstrapUrl\)/);
    assert.match(html, /memory-viewer\/api\/summary/);
    assert.match(html, /async function poll\(\)/);
    assert.match(html, /setTimeout\(poll,10000\)/);
    assert.match(html, /preparing:'Generating'/);
    assert.match(html, /preparing:'生成中'/);
    assert.match(html, /bundle_missing:'Generating repository knowledge'/);
    assert.match(html, /bundle_missing:'正在生成仓库知识'/);
    assert.match(html, /bundle_missing_idle:'Repository knowledge has not been initialized'/);
    assert.match(html, /bundle_missing_idle:'仓库知识尚未初始化'/);
    assert.match(html, /idleOpenCodeBundle=client==='opencode'&&state\.reason==='bundle_missing'/);
    assert.match(html, /className='state-dot '\+displayStatus/);
    assert.match(html, /current\.repoStates\[displayStatus\]/);
    assert.ok(Buffer.byteLength(html) < 64 * 1024);
    const script = html.match(/<script>([\s\S]+)<\/script>/)?.[1];
    assert.ok(script);
    assert.doesNotThrow(() => new Function(script));
    assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);

    const logo = await fetch(`${url}/memory-viewer/logo`);
    assert.equal(logo.status, 200);
    assert.equal(logo.headers.get("content-type"), "image/png");
    assert.deepEqual(
      [...new Uint8Array(await logo.arrayBuffer()).subarray(0, 8)],
      [137, 80, 78, 71, 13, 10, 26, 10],
    );

    const favicon = await fetch(`${url}/memory-viewer/favicon.png`);
    assert.equal(favicon.status, 200);
    assert.equal(favicon.headers.get("content-type"), "image/png");
    assert.deepEqual(
      [...new Uint8Array(await favicon.arrayBuffer()).subarray(0, 24)],
      [137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 64, 0, 0, 0, 64],
    );
  } finally {
    await close();
  }
});

test("memory viewer user API isolates clients and never returns private event content", async () => {
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-viewer-user-api-"));
  const repo = join(memoraxCodeHome, "Primary-Repo");
  const otherRepo = join(memoraxCodeHome, "Other-Repo");
  await Promise.all([
    mkdir(join(repo, ".git"), { recursive: true }),
    mkdir(join(otherRepo, ".git"), { recursive: true }),
  ]);
  const primary = resolveMemoryProject(repo);
  assert.ok(primary);
  recordMemoryViewerEvent({
    source: "memory_cli",
    operation: "query",
    ok: true,
    traceContext: { client: "codex", sessionId: "codex-session", cwd: repo },
    request: { payload: { query: "codex private query" } },
    response: { items: [{ memory: "codex private memory" }] },
  });
  recordMemoryViewerEvent({
    source: "memory_cli",
    operation: "query",
    ok: true,
    traceContext: { client: "codex", sessionId: "other-session", cwd: otherRepo },
    request: { payload: { query: "other private query" } },
    response: { items: [{ memory: "other private memory" }] },
  });
  recordMemoryViewerEvent({
    source: "memory_cli",
    operation: "query",
    ok: true,
    traceContext: { client: "claude", sessionId: "claude-session", cwd: repo },
    request: { payload: { query: "claude private query" } },
    response: { items: [{ memory: "claude private one" }, { memory: "claude private two" }] },
  });
  recordMemoryViewerEvent({
    source: "memory_cli",
    operation: "query",
    ok: true,
    traceContext: { client: "opencode", sessionId: "opencode-session", cwd: repo },
    request: { payload: { query: "opencode private query" } },
    response: { items: [{ memory: "opencode private memory" }] },
  });
  memoryViewerObservabilityHook().recordEvent?.({
    source: "automatic_retrieval",
    operation: "retrieve",
    ok: true,
    traceContext: { client: "dsh", sessionId: "dsh-session", turnId: "1", cwd: repo },
    request: { payload: { query: "dsh private query" } },
    response: { items: [{ memory: "dsh private memory" }] },
  });
  memoryViewerObservabilityHook().recordEvent?.({
    source: "dsh_native_writeback",
    operation: "writeback",
    ok: true,
    traceContext: { client: "dsh", sessionId: "dsh-session", turnId: "1", cwd: repo },
    request: { payload: { messages: [{ role: "user", content: "dsh private writeback" }] } },
    response: { raw: { data: { task_id: "dsh-private-task", status: "queued" } } },
  });
  memoryViewerObservabilityHook().recordEvent?.({
    source: "dsh_native_writeback",
    operation: "writeback",
    ok: true,
    request: { payload: { messages: [{ role: "user", content: "dsh unscoped private writeback" }] } },
    response: { raw: { data: { task_id: "dsh-unscoped-task", status: "queued" } } },
  });

  const { url, close } = await viewerServer(memoraxCodeHome, {
    repoMemoryReadiness: async () => ({ status: "not_ready", reason: "bundle_missing" }),
  });
  try {
    const codexResponse = await fetch(
      `${url}/memory-viewer/api/summary?projectId=${encodeURIComponent(primary.projectId)}`,
    );
    const codexText = await codexResponse.text();
    const codex = JSON.parse(codexText);
    assert.equal(codex.selectedClient, "codex");
    assert.deepEqual(codex.availableClients, ["codex", "claude-code", "dsh", "opencode"]);
    assert.equal(codex.summary.searchOperationCount, 1);
    assert.equal(codex.summary.searchedMemoryCount, 1);
    assert.equal(codex.activities.length, 1);
    assert.deepEqual(codex.projects.map((project) => project.projectLabel).sort(), [
      "Other-Repo",
      "Primary-Repo",
    ]);
    assert.equal(codex.projects.every((project) => (
      project.repoMemory.status === "not_ready" && project.repoMemory.reason === "bundle_missing"
    )), true);
    assert.doesNotMatch(codexText, /codex private|other private|claude private|opencode private|dsh private/i);
    for (const field of ["prompt", "answer", "query", "results", "details", "sessionId", "turnId"]) {
      assert.equal(codexText.includes(`"${field}"`), false);
    }

    const claude = await (await fetch(
      `${url}/memory-viewer/api/summary?client=claude-code`,
    )).json();
    assert.equal(claude.selectedClient, "claude-code");
    assert.equal(claude.summary.searchOperationCount, 1);
    assert.equal(claude.summary.searchedMemoryCount, 2);

    const dshResponse = await fetch(`${url}/memory-viewer/api/summary?client=dsh`);
    const dshText = await dshResponse.text();
    const dsh = JSON.parse(dshText);
    assert.equal(dsh.selectedClient, "dsh");
    assert.deepEqual(dsh.availableClients, ["codex", "claude-code", "dsh", "opencode"]);
    assert.equal(dsh.summary.searchOperationCount, 1);
    assert.equal(dsh.summary.searchedMemoryCount, 1);
    assert.equal(dsh.summary.addOperationCount, 1);
    assert.equal(dsh.summary.processingCount, 1);
    assert.equal(dsh.activities.length, 2);
    assert.deepEqual(dsh.projects.map((project) => project.projectLabel), ["Primary-Repo"]);
    assert.doesNotMatch(
      dshText,
      /dsh private|dsh unscoped|dsh-session|dsh-private-task|dsh-unscoped-task/i,
    );
    for (const field of [
      "prompt",
      "answer",
      "query",
      "results",
      "details",
      "sessionId",
      "turnId",
      "taskId",
      "eventId",
      "content",
      "error",
      "savedMemories",
      "savedMemoryIds",
    ]) {
      assert.equal(dshText.includes(`"${field}"`), false);
    }

    const opencode = await (await fetch(
      `${url}/memory-viewer/api/summary?client=opencode`,
    )).json();
    assert.equal(opencode.selectedClient, "opencode");
    assert.equal(opencode.summary.searchOperationCount, 1);
    assert.equal(opencode.summary.searchedMemoryCount, 1);
    assert.doesNotMatch(JSON.stringify(opencode), /opencode private/i);
  } finally {
    await close();
    await rm(memoraxCodeHome, { recursive: true, force: true });
  }
});

test("memory viewer user summary counts full filtered history before limiting activities", async () => {
  const memoraxCodeHome = await mkdtemp(join(tmpdir(), "memorax-code-viewer-user-window-"));
  const sessionDir = join(
    memoraxCodeHome,
    "debug",
    "traces",
    "codex",
    "sessions",
    "user-summary-window",
  );
  await mkdir(sessionDir, { recursive: true });
  const events = Array.from({ length: 205 }, (_, index) => ({
    type: "memory_cli_search",
    event_id: `user-summary-search-${index}`,
    timestamp: new Date(Date.parse("2026-07-15T08:00:00.000Z") + index * 1_000).toISOString(),
    trace: { client: "codex", session_id: "user-summary-window" },
    source: "memory_cli",
    operation: "query",
    ok: true,
    response: { items: [{ memory: `private result ${index}` }] },
  }));
  await writeFile(
    join(sessionDir, "events.jsonl"),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );

  const { url, close } = await viewerServer(memoraxCodeHome);
  try {
    const body = await (await fetch(`${url}/memory-viewer/api/summary`)).json();
    assert.equal(body.summary.searchOperationCount, 205);
    assert.equal(body.summary.searchedMemoryCount, 205);
    assert.equal(body.activities.length, 100);
    assert.doesNotMatch(JSON.stringify(body), /private result/);
  } finally {
    await close();
    await rm(memoraxCodeHome, { recursive: true, force: true });
  }
});

test("memory viewer user routes reject explicit invalid clients", async () => {
  const { url, close } = await viewerServer();
  try {
    assert.equal((await fetch(`${url}/memory-viewer?client=unknown`)).status, 400);
    assert.equal(
      (await fetch(`${url}/memory-viewer/api/summary?client=unknown`)).status,
      400,
    );
    assert.equal((await fetch(`${url}/memory-viewer?client=dsh`)).status, 200);
    assert.equal(
      (await fetch(`${url}/memory-viewer/api/summary?client=dsh`)).status,
      200,
    );
  } finally {
    await close();
  }
});

test("memory viewer user summary supports conditional requests", async () => {
  const { url, close } = await viewerServer();
  try {
    const first = await fetch(`${url}/memory-viewer/api/summary`);
    assert.equal(first.status, 200);
    const etag = first.headers.get("etag");
    assert.ok(etag);
    const unchanged = await fetch(`${url}/memory-viewer/api/summary`, {
      headers: { "if-none-match": etag },
    });
    assert.equal(unchanged.status, 304);
  } finally {
    await close();
  }
});

test("memory viewer auth cookie is scoped to the user surface", () => {
  const state = { authToken: "viewer-token" };
  const entryUrl = new URL("http://127.0.0.1:8787/memory-viewer?token=viewer-token");
  const cookie = memoryViewerSessionCookieHeader(
    state,
    { method: "GET", headers: {}, socket: {} },
    entryUrl,
  );
  assert.match(cookie, /^memorax_code_memory_viewer_session=viewer-token;/);
  assert.match(cookie, /Path=\/memory-viewer/);
  assert.equal(
    memoryViewerSessionCookieHeader(
      state,
      { method: "GET", headers: {}, socket: {} },
      new URL("http://127.0.0.1:8787/memory-viewer/api/summary"),
    ),
    undefined,
  );
  const cookieRequest = {
    headers: { cookie: "memorax_code_memory_viewer_session=viewer-token" },
  };
  assert.equal(
    authorized(
      state,
      cookieRequest,
      new URL("http://127.0.0.1:8787/memory-viewer/api/summary"),
    ),
    true,
  );
  assert.equal(
    authorized(
      state,
      cookieRequest,
      new URL("http://127.0.0.1:8787/memory/turn-start"),
    ),
    false,
  );
});

async function viewerServer(memoraxCodeHome, options = {}) {
  const ownsHome = !memoraxCodeHome;
  memoraxCodeHome ??= await mkdtemp(join(tmpdir(), "memorax-code-viewer-routes-"));
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (!await handleMemoryViewerRequest(url, req, res, {
      ...options,
      env: {
        HOME: memoraxCodeHome,
        CODEX_HOME: join(memoraxCodeHome, "codex-home"),
        ...options.env,
        MEMORAX_CODE_HOME: memoraxCodeHome,
      },
      memoraxCodeHome,
      now: options.now ?? (() => Date.parse("2026-07-15T12:00:00.000Z")),
    })) res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolve, reject) => (
        server.close((error) => error ? reject(error) : resolve())
      ));
      if (ownsHome) await rm(memoraxCodeHome, { recursive: true, force: true });
    },
  };
}
