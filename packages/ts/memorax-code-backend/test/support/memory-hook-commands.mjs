import { createHash } from "node:crypto";

export function contentTurnId(sessionId, boundary, prompt) {
  return `${sessionId}:${boundary}:${createHash("sha256").update(prompt.trim()).digest("hex")}`;
}

export function memoryHookCommands() {
  const base = (client) => ({ version: 1, client, sessionId: `session-${client}` });
  const transcriptPath = "/tmp/transcript.jsonl";
  const cwd = "/workspace/repo";
  const prompt = "Hook prompt.";
  const lastAssistantMessage = "Hook answer.";
  const codebuddy = {
    ...base("codebuddy"),
    turnId: contentTurnId("session-codebuddy", 0, prompt),
    transcriptPath,
  };
  const trae = {
    ...base("trae"),
    turnId: contentTurnId("session-trae", 1_700_000_000_000, prompt),
    prompt: `  ${prompt}  `,
    cwd,
    workspaceKind: "project",
  };
  return [
    {
      start: { ...base("codex"), prompt, transcriptPath },
      writeback: { ...base("codex"), lastAssistantMessage },
    },
    {
      start: { ...base("claude-code"), promptId: "prompt-1", prompt, transcriptPath },
      writeback: { ...base("claude-code"), promptId: "prompt-1", lastAssistantMessage, transcriptPath },
    },
    {
      start: { ...base("opencode"), userMessageId: "user-1", prompt, cwd },
      writeback: { ...base("opencode"), userMessageId: "user-1", assistantMessageId: "assistant-1", messages: [] },
    },
    {
      start: { ...base("dsh"), turn: 1, startSeq: 0, cwd, prompt },
      writeback: { ...base("dsh"), turn: 1, startSeq: 0, endSeq: 1, cwd, sessionHeader: {}, events: [] },
    },
    { start: { ...codebuddy, prompt }, writeback: codebuddy },
    { start: trae, writeback: { ...trae, lastAssistantMessage: `  ${lastAssistantMessage}  ` } },
  ];
}
