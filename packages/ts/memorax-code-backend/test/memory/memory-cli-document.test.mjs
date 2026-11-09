import assert from "node:assert/strict";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runMemoryCli } from "../../dist/memory/cli.js";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "memorax-document-cli-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, "workspace");
  await mkdir(cwd);
  const requests = [];
  return {
    root, requests,
    options: {
      cwd,
      env: {
        MEMORAX_CODE_HOME: join(root, "state"),
        MEMORAX_CODE_MEMORAX_ENDPOINT: "http://memorax.test",
        MEMORAX_CODE_MEMORAX_API_KEY: "fixture-secret",
        MEMORAX_CODE_MEMORAX_USER_ID: "user-1",
      },
      fetchImpl: async (url, init) => {
        requests.push(JSON.parse(init.body));
        return new Response(JSON.stringify({ success: true, data: {
          task_id: "test-task", status: String(url).endsWith("/add") ? "accepted" : "completed",
          data: [{ id: "chunk-1", content_type: "document", memory: "# Pricing\n\n| Plan | Price |\n| --- | --- |\n| Pro | 20 |",
            metadata: { document_id: "doc-1", input_id: "input-1", chunk_index: 0, heading_path: ["Pricing"] },
            score_details: { rank_method: "system_one", system_one: 0.9 } }],
        } }), { status: 200, headers: { "content-type": "application/json" } });
      },
    },
  };
}

test("document Search CLI forwards source and document scope and returns evidence to the agent", async (t) => {
  const { options, requests } = await fixture(t);
  const result = await runMemoryCli(["search", "--query", "Pro price", "--sources", "document", "--document-ids", "doc-1,doc-2", "--limit", "4"], options);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(requests[0].sources, ["document"]);
  assert.deepEqual(requests[0].document_ids, ["doc-1", "doc-2"]);
  assert.equal(requests[0].mode, "fast");
  assert.equal(requests[0].output_mode, "facts");
  assert.equal(requests[0].top_k, 4);
  assert.equal(requests[0].user_id, "user-1@workspace");
  assert.match(result.answer, /doc-1/);
  assert.match(result.answer, /\n\| Plan \| Price \|/);
  assert.equal(result.items[0].id, "chunk-1");
  assert.equal(result.items[0].score_details.system_one, 0.9);
});

test("document Search CLI rejects incomplete and ambiguous scope flags without sending a broader query", async (t) => {
  const { options, requests } = await fixture(t);
  for (const flags of [
    ["--sources"], ["--sources", ""], ["--sources", "document", "--sources", "dialogue"],
    ["--document-ids", "doc-1"], ["--sources", "document", "--document-ids"],
    ["--sources", "document,dialogue", "--document-ids", "doc-1"],
  ]) {
    const result = await runMemoryCli(["search", "--query", "price", ...flags], options);
    assert.equal(result.ok, false, JSON.stringify(flags));
  }
  assert.equal(requests.length, 0);
});

test("messages-file Add preserves multimodal parts and submits asynchronous auto routing", async (t) => {
  const { root, options, requests } = await fixture(t);
  const path = join(root, "messages.json");
  const messages = [{ role: "user", content: [
    { type: "text", text: "Remember this report." },
    { type: "file", file: { filename: "report.pdf", file_data: "JVBERi0xLjQ=" } },
  ], timestamp: 1793779200000 }];
  await writeFile(path, JSON.stringify(messages));
  const result = await runMemoryCli(["add", "--messages-file", path, "--type", "semantic", "--reason", "User requested document storage"], options);
  assert.equal(result.ok, true, result.error);
  assert.deepEqual(requests[0].messages, messages);
  assert.equal(requests[0].content_type, "auto");
  assert.equal(requests[0].mode, "default");
  assert.equal(requests[0].async_mode, true);
  assert.equal(requests[0].metadata.source, "memorax-code");
  assert.equal(requests[0].user_id, "user-1@workspace");
  assert.ok(requests[0].session_id);
  assert.match(JSON.stringify(result.receipt), /test-task/);
});

test("messages-file input failures remain local and do not expose JSON contents", async (t) => {
  const { root, options, requests } = await fixture(t);
  const path = join(root, "bad.json");
  const base = ["add", "--messages-file", path, "--type", "semantic", "--reason", "test"];
  await writeFile(path, '{"private_payload":');
  const malformed = await runMemoryCli(base, options);
  assert.equal(malformed.ok, false);
  assert.doesNotMatch(JSON.stringify(malformed), /private_payload/);
  for (const payload of [{ messages: [] }, [], [{ role: "user", content: "a".repeat(2001) }]]) {
    await writeFile(path, JSON.stringify(payload));
    assert.equal((await runMemoryCli(base, options)).ok, false);
  }
  await writeFile(path, JSON.stringify([{ role: "user", content: "small" }]));
  assert.equal((await runMemoryCli([...base, "--memory", "ambiguous"], options)).ok, false);
  const file = await open(path, "w");
  await file.truncate(32 * 1024 * 1024 + 1);
  await file.close();
  assert.equal((await runMemoryCli(base, options)).ok, false);
  assert.equal(requests.length, 0);
});
