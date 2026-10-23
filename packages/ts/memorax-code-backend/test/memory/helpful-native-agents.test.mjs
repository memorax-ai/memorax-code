import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryService } from "../../dist/memory/service.js";
import { writeRollout } from "../clients/codex/support/memory-hook-fixtures.mjs";
import { userRecord, assistantRecord } from "../clients/claude/support/claude-transcript-fixtures.mjs";
import { dshTurnInterval } from "../clients/dsh/support/dsh-session-fixtures.mjs";
import { databaseFixture } from "../clients/cursor/support/database-fixtures.mjs";

const digest = text => createHash("sha256").update(text).digest("hex");

for (const captureCodingTurns of [false, true]) {
for (const client of ["codex", "claude-code", "codebuddy", "workbuddy", "dsh", "opencode", "cursor", "trae"]) {
  test(`${client}: native authority -> service -> Add Helpful attachment (coding context=${captureCodingTurns})`, async (t) => {
    const home = await mkdtemp(join(tmpdir(), "helpful-native-"));
    t.after(() => rm(home, { recursive: true, force: true }));
    const database = client === "cursor" ? await databaseFixture() : undefined;
    if (database) t.after(() => database.cleanup());
    const sessionId = database?.sessionId ?? randomUUID(), sent = [], records = [];
    const searchId = randomUUID();
    const env = {
      MEMORAX_CODE_HOME: home, MEMORAX_CODE_MEMORAX_API_KEY: "synthetic",
      MEMORAX_CODE_MEMORAX_USER_ID: "synthetic", MEMORAX_CODE_MEMORAX_ENDPOINT: "http://synthetic.invalid",
      MEMORAX_CODE_MEMORY_WRITEBACK_ENABLED: "true",
      MEMORAX_CODE_CODING_SESSIONS_ENABLED: String(captureCodingTurns),
      MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_TURNS: "8",
      MEMORAX_CODE_MEMORY_WRITEBACK_BUFFER_MAX_AGE_MS: "60000",
    };
    const service = createMemoryService({
      memoraxCodeHome: home, env,
      fetchImpl: async (url, init) => {
        assert.equal(new URL(url).pathname, "/v1/memories/add");
        sent.push(JSON.parse(init.body));
        return Response.json({ success: true, data: { task_id: randomUUID(), status: "accepted" } }, { status: 202 });
      },
    });
    t.after(() => service.close());
    const transcriptPath = join(home, "native.jsonl");
    for (let i = 1; i <= 3; i++) {
      const prompt = `Synthetic ${client} question ${i}`, answer = `Synthetic ${client} answer ${i}`;
      const base = { version: 1, client, sessionId, cwd: home, prompt };
      let start, end, turnId, afterStart;
      if (client === "codex") {
        turnId = `t${i}`;
        records.push({ turnId, prompt, reply: answer });
        const path = await writeRollout(home, sessionId, records);
        start = { ...base, turnId, transcriptPath: path };
        end = { ...start, lastAssistantMessage: answer };
      } else if (client === "claude-code") {
        turnId = `prompt-${i}`;
        records.push(
          userRecord({ uuid: `u${i}`, parentUuid: i > 1 ? `a${i - 1}` : null, promptId: turnId, sessionId, content: prompt }),
        );
        await writeFile(transcriptPath, records.map(r => JSON.stringify(r)).join("\n") + "\n");
        start = { ...base, promptId: turnId, transcriptPath };
        end = { ...start, lastAssistantMessage: answer };
        afterStart = async () => {
          records.push(assistantRecord({ uuid: `a${i}`, parentUuid: `u${i}`, sessionId,
            timestamp: new Date(1700000001000 + i).toISOString(),
            content: [{ type: "text", text: answer }], stopReason: "end_turn" }));
          await writeFile(transcriptPath, records.map(r => JSON.stringify(r)).join("\n") + "\n");
        };
      } else if (client === "codebuddy" || client === "workbuddy") {
        turnId = `${sessionId}:0:${digest(prompt)}`;
        records.push(
          { id: `u${i}`, type: "message", role: "user", sessionId,
            content: [{ type: "input_text", text: `<user_query>${prompt}</user_query>` }] },
          { id: `a${i}`, type: "message", role: "assistant", parentId: `u${i}`, status: "completed",
            content: [{ type: "output_text", text: answer }] },
        );
        await writeFile(transcriptPath, records.map(r => JSON.stringify(r)).join("\n") + "\n");
        start = end = { ...base, turnId, transcriptPath };
      } else if (client === "dsh") {
        turnId = String(i);
        const interval = dshTurnInterval({ sessionId, cwd: home, turn: i, startSeq: (i - 1) * 11 });
        interval.events[1].data.content[0].text = prompt;
        interval.events[7].data.message.content[0].text = answer;
        start = { ...base, turn: i, startSeq: interval.startSeq };
        end = { ...base, ...interval };
      } else if (client === "opencode") {
        turnId = `u${i}`;
        const part = (id, text) => ({ type: "text", sessionID: sessionId, messageID: id, text });
        records.push(
          { info: { id: turnId, sessionID: sessionId, role: "user", time: { created: 1700000000000 + i } },
            parts: [part(turnId, prompt)] },
          { info: { id: `a${i}`, sessionID: sessionId, role: "assistant", parentID: turnId,
            time: { created: 1700000000000 + i, completed: 1700000001000 + i } },
            parts: [part(`a${i}`, answer)] },
        );
        start = { ...base, userMessageId: turnId };
        end = { ...start, assistantMessageId: `a${i}`, turnIndex: i, messages: [...records] };
      } else if (client === "cursor") {
        turnId = randomUUID();
        records.push({ requestId: turnId, userPrompt: prompt, userMessageId: randomUUID(),
          steps: [{ type: "assistantMessage", text: answer }] });
        start = { ...base, turnId, databasePath: database.databasePath };
        afterStart = async () => {
          database.write({ latestGenerationId: turnId, turns: records });
          await service.writebackTurn({ ...start, phase: "response", responseDigest: digest(answer) });
        };
        end = { ...start, phase: "stop", status: "completed" };
      } else {
        turnId = `${sessionId}:${Date.now() + i}:${digest(prompt)}`;
        start = { ...base, turnId };
        end = { ...start, lastAssistantMessage: answer };
      }
      const started = await service.recordTurnStart(start);
      if (i === 1) {
        assert.equal(service.registerHelpfulSearch({
          version: 1, client, sessionId, clientTurnId: started.claudeTurnKey ?? turnId,
          search_id: searchId, context_turns_k: 2,
        }).accepted, true);
      }
      await afterStart?.();
      const completed = await service.writebackTurn(end);
      assert.equal(completed.scheduled, true, JSON.stringify(completed));
      assert.equal(sent.length, 0);
    }
    await service.drain();
    assert.equal(sent.length, 1);
    const supportsCodingContext = ["codex", "claude-code", "codebuddy", "workbuddy", "opencode"].includes(client);
    if (captureCodingTurns && supportsCodingContext) {
      assert.equal(sent[0].coding_context.turns.length, 3);
      assert.ok(sent[0].coding_context.items.length > 0);
    } else {
      assert.equal(sent[0].coding_context, undefined);
    }
    if (client === "trae") {
      assert.equal(sent[0].helpful_evaluations, undefined, "no native ordinal: do not invent continuity");
    } else {
      const [evaluation] = sent[0].helpful_evaluations;
      assert.equal(evaluation.search_id, searchId);
      assert.equal(evaluation.client, client);
      assert.equal(evaluation.turns.length, 3);
      assert.equal(evaluation.turns[2].assistant_message, "");
      assert.match(evaluation.turns[0].user_message, new RegExp(`Synthetic ${client} question 1`));
      if (client === "claude-code") {
        assert.equal(evaluation.source_turn_id, "u1");
        assert.deepEqual(evaluation.turns.map(turn => turn.turn_id), ["u1", "u2", "u3"]);
      }
    }
  });
}
}
