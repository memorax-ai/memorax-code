import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  OPENCODE_REPO_MEMORY_AGENT,
  runOpenCodeRepoMemory,
} from "../src/repo-memory-server-runner.mjs";

test("OpenCode repo memory runner creates, prompts, and deletes a background session", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-repo-memory-runner-"));
  const requests = [];
  const authorization = `Basic ${Buffer.from("memorax-user: secret ").toString("base64")}`;
  const server = await startServer(async (request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      body: await requestBody(request),
    });
    if (request.headers.authorization !== authorization) {
      return json(response, 401, { message: "unauthorized" });
    }
    if (request.method === "POST" && request.url.startsWith("/session?")) {
      return json(response, 200, { id: "session-repo-memory" });
    }
    if (request.method === "POST" && request.url.startsWith("/session/session-repo-memory/message?")) {
      return json(response, 200, {
        info: { role: "assistant" },
        parts: [
          { type: "text", text: "Repo Memory updated." },
          { type: "tool", tool: "write" },
          { type: "text", text: "Validation passed." },
        ],
      });
    }
    if (request.method === "DELETE") return json(response, 200, true);
    return json(response, 404, { message: "not found" });
  });
  try {
    const result = await runOpenCodeRepoMemory({
      serverUrl: server.url,
      repo: root,
      prompt: "Build Repo Memory.",
    }, {
      env: {
        MEMORAX_CODE_MEMORY_CLI_SESSION_ID: "parent-session",
        MEMORAX_CODE_OPENCODE_SERVER_URL: server.url,
        OPENCODE_SERVER_USERNAME: "memorax-user",
        OPENCODE_SERVER_PASSWORD: " secret ",
      },
    });

    assert.equal(result, "Repo Memory updated.\n\nValidation passed.");
    assert.equal(requests.length, 3);
    assert.deepEqual(requests.map((request) => request.method), ["POST", "POST", "DELETE"]);
    assert.deepEqual(requests.map((request) => request.authorization), [
      authorization,
      authorization,
      authorization,
    ]);
    for (const request of requests) {
      assert.equal(new URL(request.url, server.url).searchParams.get("directory"), root);
    }
    assert.deepEqual(JSON.parse(requests[0].body), {
      parentID: "parent-session",
      title: "MemoraX Code Repo Memory",
      permission: [
        { permission: "edit", pattern: "*", action: "allow" },
        { permission: "bash", pattern: "*", action: "allow" },
        { permission: "webfetch", pattern: "*", action: "allow" },
        { permission: "doom_loop", pattern: "*", action: "allow" },
        { permission: "external_directory", pattern: "*", action: "allow" },
      ],
    });
    assert.deepEqual(JSON.parse(requests[1].body), {
      agent: OPENCODE_REPO_MEMORY_AGENT,
      parts: [{ type: "text", text: "Build Repo Memory." }],
    });
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode repo memory runner preserves prompt failures and still deletes the session", async () => {
  const root = await mkdtemp(join(tmpdir(), "opencode-repo-memory-failure-"));
  let deleted = false;
  const server = await startServer(async (request, response) => {
    if (request.method === "POST" && request.url.startsWith("/session?")) {
      return json(response, 200, { id: "session-failure" });
    }
    if (request.method === "POST") {
      return json(response, 500, { message: "model unavailable" });
    }
    deleted = true;
    return json(response, 500, { message: "cleanup failed" });
  });
  try {
    await assert.rejects(
      runOpenCodeRepoMemory({
        serverUrl: server.url,
        repo: root,
        prompt: "Build Repo Memory.",
      }),
      /OpenCode blocking prompt failed with HTTP 500: model unavailable/,
    );
    assert.equal(deleted, true);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function startServer(handler) {
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

function requestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
