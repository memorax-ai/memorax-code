import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { pathToFileURL } from "node:url";

const runtimeRoot = mkdtempSync(join(tmpdir(), "memorax-code-dsh-http-client-"));
after(() => rmSync(runtimeRoot, { recursive: true, force: true }));
mkdirSync(join(runtimeRoot, "src"));
mkdirSync(join(runtimeRoot, "memorax-code-adapter-common", "src"), { recursive: true });
copyFileSync(new URL("../src/http-client.mjs", import.meta.url), join(runtimeRoot, "src", "http-client.mjs"));
copyFileSync(
  new URL("../../memorax-code-adapter-common/src/backend-command.mjs", import.meta.url),
  join(runtimeRoot, "memorax-code-adapter-common", "src", "backend-command.mjs"),
);
const { createHttpBackendClient } = await import(pathToFileURL(join(runtimeRoot, "src", "http-client.mjs")));

test("DSH Backend requests resolve current connection authority for each command", async () => {
  const requests = [];
  let connection = { url: "http://127.0.0.1:8787", token: "first-test-token" };
  const client = createHttpBackendClient({
    env: {},
    resolveConnection: () => connection,
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), options });
      return Response.json({ ok: true });
    },
  });
  const command = { version: 1, client: "dsh", sessionId: "session-1", turn: 1 };
  assert.deepEqual(await client.recordTurnStart(command), { ok: true });
  connection = { url: "http://127.0.0.1:8788", token: "rotated-test-token" };
  await client.recordSkillReminder(command);
  await client.writebackTurn(command);
  assert.deepEqual(requests.map(({ url }) => url), [
    "http://127.0.0.1:8787/memory/turn-start",
    "http://127.0.0.1:8788/memory/skill-reminder",
    "http://127.0.0.1:8788/memory/writeback",
  ]);
  assert.deepEqual(requests.map(({ options }) => options.headers["x-memorax-code-backend-token"]), [
    "first-test-token", "rotated-test-token", "rotated-test-token",
  ]);
  assert.deepEqual(requests.map(({ options }) => JSON.parse(options.body)), [command, command, command]);
});

test("DSH Backend client retains caller cancellation for every command", async () => {
  for (const method of ["recordTurnStart", "recordSkillReminder", "writebackTurn"]) {
    const controller = new AbortController();
    const reason = new Error("native DSH turn cancelled");
    let requestSignal;
    const client = createHttpBackendClient({
      env: {},
      resolveConnection: () => ({ url: "http://127.0.0.1:8787" }),
      fetchImpl: async (_url, { signal }) => {
        requestSignal = signal;
        return await new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    });
    const pending = client[method]({ client: "dsh" }, { signal: controller.signal });
    controller.abort(reason);
    await assert.rejects(pending, (error) => error === reason);
    assert.equal(requestSignal.aborted, true);
  }
});

test("DSH Backend client drains HTTP failures and tolerates successful non-JSON responses", async () => {
  const rejected = new Response("rejected", { status: 413 });
  const malformed = new Response("invalid JSON", { status: 200 });
  const responses = [rejected, malformed];
  let attempts = 0;
  const client = createHttpBackendClient({
    env: {},
    resolveConnection: () => ({ url: "http://127.0.0.1:8787" }),
    fetchImpl: async () => {
      attempts += 1;
      return responses.shift();
    },
  });
  await assert.rejects(client.writebackTurn({ client: "dsh" }), /Backend \/memory\/writeback returned HTTP 413/);
  assert.equal(rejected.bodyUsed, true);
  assert.equal(attempts, 1, "transport failure must not trigger a retry");
  assert.equal(await client.recordTurnStart({ client: "dsh" }), undefined);
  assert.equal(attempts, 2);
});
