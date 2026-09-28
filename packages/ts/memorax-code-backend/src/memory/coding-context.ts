import { readFile, stat } from "node:fs/promises";
import { codexHelpfulPromptFromJsonLines } from "../clients/codex/session-turn-index.js";
import { claudeHelpfulPromptFromJsonLines } from "../clients/claude/transcript-turn.js";
import { codeBuddyHelpfulPromptFromJsonLines } from "../clients/codebuddy/jsonl-history.js";
import type { TraceContext } from "../trace/context.js";

export type CodingSearchContext = Readonly<{
  client: "codex" | "claude-code" | "opencode" | "codebuddy" | "workbuddy";
  session_id: string;
  turn_id: string;
  agent_role?: "main" | "subagent";
  prompt_origin?: "end_user" | "system";
}>;

type CodingSearchContextLimits = Readonly<{
  maxTranscriptBytes: number;
  timeoutMs: number;
}>;

const DEFAULT_CODING_CONTEXT_LIMITS: CodingSearchContextLimits = {
  maxTranscriptBytes: 16 * 1024 * 1024,
  timeoutMs: 250,
};

/** Operational identity selects the file/Turn; native content verifies eligibility. */
export async function resolveCodingSearchContext(
  trace?: TraceContext,
  limits: CodingSearchContextLimits = DEFAULT_CODING_CONTEXT_LIMITS,
): Promise<CodingSearchContext | undefined> {
  if (trace?.client === "opencode") {
    return trace.sessionId.trim() && trace.turnId?.trim()
      && trace.sessionId.length <= 255 && trace.turnId.length <= 255
      && trace.nativePromptVerified === true
      ? { client: "opencode", session_id: trace.sessionId, turn_id: trace.turnId,
        ...(trace.agentRole ? { agent_role: trace.agentRole } : {}),
        ...(trace.promptOrigin ? { prompt_origin: trace.promptOrigin } : {}) } : undefined;
  }
  if (!trace?.turnId || !trace.transcriptPath || !trace.sessionId
    || !["codex", "claude", "codebuddy", "workbuddy"].includes(trace.client)
    || trace.turnId.length > 255 || trace.sessionId.length > 255
    || limits.maxTranscriptBytes < 1 || limits.timeoutMs < 1) return undefined;
  const { client, sessionId, transcriptPath, turnId } = trace;
  const startedAt = Date.now();
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const info = await stat(transcriptPath);
        if (!info.isFile() || info.size > limits.maxTranscriptBytes
          || Date.now() - startedAt >= limits.timeoutMs) return undefined;
        const transcript = await readFile(transcriptPath, {
          encoding: "utf8",
          signal: controller.signal,
        });
        const input = { sessionId, turnId };
        const buddy = client === "codebuddy" || client === "workbuddy"
          ? codeBuddyHelpfulPromptFromJsonLines(transcript, input) : undefined;
        const provenance = client === "codex"
          ? codexHelpfulPromptFromJsonLines(transcript, input)
          : client === "claude" ? claudeHelpfulPromptFromJsonLines(transcript, input) : buddy;
        if (!provenance || Date.now() - startedAt >= limits.timeoutMs) return undefined;
        return {
          client: client === "claude" ? "claude-code" as const : client as "codex" | "codebuddy" | "workbuddy",
          session_id: sessionId, turn_id: buddy?.turnId ?? turnId,
          ...(provenance.agent_role ? { agent_role: provenance.agent_role } : {}),
          ...(provenance.prompt_origin ? { prompt_origin: provenance.prompt_origin } : {}),
        };
      })(),
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => {
          controller.abort();
          resolve(undefined);
        }, limits.timeoutMs);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
