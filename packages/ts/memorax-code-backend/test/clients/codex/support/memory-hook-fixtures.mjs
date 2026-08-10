import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
export async function writeRollout(root, sessionId, turns, options = {}) {
  const transcriptPath = join(root, `${sessionId}.jsonl`);
  const records = [{
    timestamp: "2026-07-16T00:00:00.000Z",
    type: "session_meta",
    payload: {
      id: sessionId,
      ...(options.headerSource ? { source: options.headerSource } : {}),
    },
  }, ...(options.prefixRecords ?? [])];
  for (const [index, turn] of turns.entries()) {
    records.push(
      {
        timestamp: `2026-07-16T00:00:${String(index * 3 + 1).padStart(2, "0")}.000Z`,
        type: "event_msg",
        payload: { type: "task_started", turn_id: turn.turnId },
      },
      {
        timestamp: `2026-07-16T00:00:${String(index * 3 + 1).padStart(2, "0")}.001Z`,
        type: "turn_context",
        payload: { turn_id: turn.turnId },
      },
      {
        timestamp: `2026-07-16T00:00:${String(index * 3 + 2).padStart(2, "0")}.000Z`,
        type: "event_msg",
        payload: { type: "user_message", message: turn.prompt },
      },
    );
    for (const [toolIndex, input] of (turn.toolCalls ?? []).entries()) {
      records.push({
        timestamp: `2026-07-16T00:00:${String(index * 3 + 2).padStart(2, "0")}.${String(toolIndex + 1).padStart(3, "0")}Z`,
        type: "response_item",
        payload: { type: "custom_tool_call", name: "exec", input },
      });
    }
    for (const [commentaryIndex, message] of (turn.commentaries ?? []).entries()) {
      records.push({
        timestamp: `2026-07-16T00:00:${String(index * 3 + 2).padStart(2, "0")}.${String(commentaryIndex + 100).padStart(3, "0")}Z`,
        type: "event_msg",
        payload: { type: "agent_message", message, phase: "commentary" },
      });
    }
    if (turn.tokenUsage) {
      records.push({
        timestamp: `2026-07-16T00:00:${String(index * 3 + 3).padStart(2, "0")}.500Z`,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { total_token_usage: turn.tokenUsage },
        },
      });
    }
    if (turn.interrupted) {
      records.push({
        timestamp: `2026-07-16T00:00:${String(index * 3 + 3).padStart(2, "0")}.750Z`,
        type: "event_msg",
        payload: { type: "turn_aborted", turn_id: turn.turnId, reason: "interrupted" },
      });
      if (turn.rolledBack) {
        records.push({
          timestamp: `2026-07-16T00:00:${String(index * 3 + 3).padStart(2, "0")}.900Z`,
          type: "event_msg",
          payload: { type: "thread_rolled_back", num_turns: 1 },
        });
      }
    } else {
      records.push({
        timestamp: `2026-07-16T00:00:${String(index * 3 + 3).padStart(2, "0")}.000Z`,
        type: "event_msg",
        payload: { type: "agent_message", message: turn.reply, phase: "final_answer" },
      });
    }
  }
  await writeFile(transcriptPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, "utf8");
  return transcriptPath;
}

export function memoraxAddFetch() {
  const requests = [];
  return {
    requests,
    fetchImpl: async (url, init) => {
      requests.push({
        url: String(url),
        body: JSON.parse(init.body),
      });
      return new Response(JSON.stringify({ success: true, data: { task_id: "hook-memory-add", status: "queued" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

export function memoraxSearchFetch(memoryText) {
  const requests = [];
  return {
    requests,
    fetchImpl: async (url, init) => {
      requests.push({
        url: String(url),
        body: JSON.parse(init.body),
      });
      return new Response(JSON.stringify({
        success: true,
        data: {
          task_id: "hook-memory-search",
          status: "completed",
          data: [{
            id: "memory-1",
            memory: memoryText,
            score: 0.95,
            metadata: { memory_type: "core" },
          }],
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

export async function waitFor(predicate, message) {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

export async function waitForFile(path, pattern, message) {
  await waitFor(async () => {
    try {
      return pattern.test(await readFile(path, "utf8"));
    } catch {
      return false;
    }
  }, message);
}

export function withEnv(updates) {
  const previous = new Map(Object.keys(updates).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

export function captureUnhandledRejections() {
  const errors = [];
  const handler = (error) => {
    errors.push(error);
  };
  process.on("unhandledRejection", handler);
  return {
    errors,
    restore() {
      process.off("unhandledRejection", handler);
    },
  };
}

export async function delay(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
