import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readClaudeCodingSessionTurn } from "../../dist/clients/claude/transcript-turn.js";
import { readCodeBuddyTranscriptTurn } from "../../dist/clients/codebuddy/jsonl-history.js";
import { readCodexCodingSessionTurn, readCodexRolloutTurn } from "../../dist/clients/codex/rollout-turn.js";
import { readCodingSessionSourceTurn } from "../../dist/memory/coding-session-source.js";

const sessionId = "native-session";
const closedAt = "2026-09-20T01:00:00.000Z";
const prompt = "Repeat this 中文 prompt.";
const lines = (records) => records.map(JSON.stringify).join("\n") + "\n";
const message = (role, text) => ({ type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] });
const event = (type, fields) => ({ type: "event_msg", payload: { type, ...fields } });

const cases = [
  {
    client: "codex", turnId: "native-turn",
    records: [
      { type: "session_meta", payload: { id: sessionId } },
      event("task_started", { turn_id: "native-turn" }),
      { type: "turn_context", payload: { turn_id: "native-turn" } },
      { type: "response_item", payload: message("user", prompt) },
      { type: "response_item", payload: { ...message("assistant", "First answer."), phase: "final_answer" } },
      event("task_complete", { turn_id: "native-turn", last_agent_message: "First answer." }),
    ],
    appended: [
      event("task_started", { turn_id: "later-turn" }),
      { type: "response_item", payload: message("user", prompt) },
      { type: "response_item", payload: { ...message("assistant", "Later answer."), phase: "final_answer" } },
      event("task_complete", { turn_id: "later-turn", last_agent_message: "Later answer." }),
    ],
    read: readCodexCodingSessionTurn,
  },
  {
    client: "claude-code", turnId: "native-prompt",
    records: [
      { type: "user", uuid: "user-1", sessionId, promptId: "native-prompt", userType: "external", message: { role: "user", content: prompt } },
      { type: "assistant", uuid: "answer-1", parentUuid: "user-1", sessionId, timestamp: closedAt,
        message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "First answer." }] } },
    ],
    // A later sibling must not change the already accepted native snapshot.
    appended: [{ type: "assistant", uuid: "answer-2", parentUuid: "user-1", sessionId,
      message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Later answer." }] } }],
    read: (input) => readClaudeCodingSessionTurn({ ...input, promptId: input.turnId }),
  },
  ...["codebuddy", "workbuddy"].map((client) => ({
    client, turnId: `${sessionId}:0:${createHash("sha256").update(prompt).digest("hex")}`,
    records: [
      { ...message("user", prompt), id: "user-1", sessionId },
      { ...message("assistant", "First answer."), id: "answer-1", parentId: "user-1", status: "completed" },
    ],
    appended: [
      { ...message("user", prompt), id: "user-2", sessionId },
      { ...message("assistant", "Later answer."), id: "answer-2", parentId: "user-2", status: "completed" },
    ],
    read: (input) => readCodeBuddyTranscriptTurn({ ...input, captureCodingItems: true }),
  })),
];

for (const fixture of cases) {
  test(`${fixture.client} archive rereads its frozen native snapshot and rejects changed identity or truncation`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "memorax-native-source-"));
    const transcriptPath = join(directory, "session.jsonl");
    try {
      const original = lines(fixture.records);
      await writeFile(transcriptPath, original);
      const input = { transcriptPath, sessionId, turnId: fixture.turnId };
      const first = await fixture.read(input);
      assert.equal(first.ok, true);
      assert.deepEqual(first.turn.source, { transcriptPath, endBytes: Buffer.byteLength(original) });
      const ref = {
        client: fixture.client, sessionId, turnId: fixture.turnId, turnIndex: 1,
        outcome: "completed", closedAt, source: first.turn.source,
      };
      await appendFile(transcriptPath, lines(fixture.appended));
      const reread = await readCodingSessionSourceTurn(ref);
      assert.deepEqual(reread, { ...ref, items: first.turn.items });
      if (fixture.client !== "codex") assert.equal((await fixture.read(input)).reason, "turn_ambiguous");
      assert.equal(await readCodingSessionSourceTurn({ ...ref, sessionId: "other-session" }), undefined);
      assert.equal(await readCodingSessionSourceTurn({ ...ref, turnId: "other-turn" }), undefined);
      assert.equal(await readCodingSessionSourceTurn({ ...ref, turnIndex: 2 }), undefined);
      await truncate(transcriptPath, first.turn.source.endBytes - 1);
      assert.equal(await readCodingSessionSourceTurn(ref), undefined);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
}

test("native archive readers reject invalid byte bounds without changing the QA-only default", async () => {
  const directory = await mkdtemp(join(tmpdir(), "memorax-native-boundary-"));
  const transcriptPath = join(directory, "session.jsonl");
  try {
    const fixture = cases[0];
    const original = lines(fixture.records);
    await writeFile(transcriptPath, original);
    const qa = await readCodexRolloutTurn({ transcriptPath, sessionId, turnId: fixture.turnId });
    assert.equal(qa.ok, true);
    assert.equal(qa.turn.source, undefined);
    const chineseByte = Buffer.byteLength(original.slice(0, original.indexOf("中")));
    for (const endBytes of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER, chineseByte + 1]) {
      const result = await fixture.read({ transcriptPath, sessionId, turnId: fixture.turnId, endBytes });
      assert.equal(result.ok, false);
      assert.equal(result.reason, "transcript_unavailable");
    }
    assert.equal(await readCodingSessionSourceTurn({
      client: "opencode", sessionId, turnId: "user-message", turnIndex: 1,
      outcome: "completed", closedAt, source: { transcriptPath, endBytes: Buffer.byteLength(original) },
    }), undefined, "SDK message authority must not fall back to a transcript file");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
