import { createHash } from "node:crypto";
import type { CursorDatabaseSnapshot, CursorDatabaseTurn } from "./database-snapshot.js";

export type CursorContinuationBaseline = Readonly<{
  requestId: string;
  userMessageId: string;
  userMessageRef: string;
  promptDigest: string;
  precedingTurnIds: readonly string[];
  steps: readonly Readonly<{ id: string; contentHash: string }>[];
}>;

type Failure = Readonly<{ ok: false; reason: string; retryable?: boolean }>;
export type CursorDatabaseTurnResult =
  | Readonly<{ ok: true; userPrompt: string; assistantReply: string }>
  | Failure;

export function cursorTextDigest(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function captureCursorContinuation(input: {
  snapshot: CursorDatabaseSnapshot;
  generationId: string;
  previousGenerationId: string;
  requestId: string;
  promptDigest: string;
}): Readonly<{ ok: true; baseline: CursorContinuationBaseline }> | Failure {
  const { snapshot } = input;
  if (snapshot.latestGenerationId !== input.generationId
    && snapshot.latestGenerationId !== input.previousGenerationId) {
    return failure("native_generation_pending", true);
  }
  const selected = matchingTurn(snapshot, input.requestId, input.promptDigest);
  if (!selected.ok) return selected;
  const { turn } = selected;
  return {
    ok: true,
    baseline: {
      requestId: input.requestId,
      userMessageId: turn.userMessageId!,
      userMessageRef: turn.userMessageRef!,
      promptDigest: input.promptDigest,
      precedingTurnIds: snapshot.turns.slice(0, -1).map((item) => item.id),
      steps: turn.steps.map(({ id, contentHash }) => ({ id, contentHash })),
    },
  };
}

export function selectCursorDatabaseTurn(input: {
  snapshot: CursorDatabaseSnapshot;
  generationId: string;
  promptDigest: string;
  responseDigest: string;
  continuation?: CursorContinuationBaseline;
}): CursorDatabaseTurnResult {
  const { snapshot, continuation } = input;
  if (snapshot.latestGenerationId !== input.generationId) return failure("native_generation_pending", true);
  const selected = matchingTurn(
    snapshot,
    continuation?.requestId ?? input.generationId,
    continuation?.promptDigest ?? input.promptDigest,
  );
  if (!selected.ok) return selected;
  const { turn } = selected;
  let steps = turn.steps;
  if (continuation) {
    if (turn.userMessageId !== continuation.userMessageId
      || turn.userMessageRef !== continuation.userMessageRef
      || snapshot.turns.length !== continuation.precedingTurnIds.length + 1
      || continuation.precedingTurnIds.some((id, index) => snapshot.turns[index].id !== id)) {
      return failure("native_continuation_replaced");
    }
    if (steps.length < continuation.steps.length
      || continuation.steps.some((step, index) => (
        steps[index].id !== step.id || steps[index].contentHash !== step.contentHash
      ))) return failure("native_continuation_prefix_changed");
    steps = steps.slice(continuation.steps.length);
  }
  // The caller must require a completed Stop. Neither a stable DB snapshot nor
  // an assistant step alone establishes completion of a native generation.
  const final = steps.at(-1);
  if (!final || final.type !== "assistantMessage" || !final.text?.trim()) {
    return failure("native_final_response_pending", true);
  }
  if (cursorTextDigest(final.text) !== input.responseDigest) {
    return failure("native_final_response_pending", true);
  }
  const matches = steps.filter((step) => step.type === "assistantMessage"
    && step.text !== undefined && cursorTextDigest(step.text) === input.responseDigest);
  if (matches.length !== 1) return failure("native_response_ambiguous");
  return { ok: true, userPrompt: turn.userPrompt!, assistantReply: final.text };
}

function matchingTurn(
  snapshot: CursorDatabaseSnapshot,
  requestId: string,
  promptDigest: string,
): Readonly<{ ok: true; turn: CursorDatabaseTurn }> | Failure {
  const matches = snapshot.turns.filter((turn) => turn.type === "agent" && turn.requestId === requestId);
  if (matches.length === 0) return failure("native_turn_pending", true);
  if (matches.length !== 1) return failure("native_turn_ambiguous");
  const turn = matches[0];
  if (snapshot.turns.at(-1) !== turn) return failure("native_turn_replaced");
  if (turn.reason) return failure(turn.reason);
  if (!turn.userMessageId || !turn.userMessageRef || !turn.userPrompt?.trim()) {
    return failure("native_user_unavailable");
  }
  if (cursorTextDigest(turn.userPrompt) !== promptDigest) return failure("native_prompt_mismatch");
  if (turn.steps.some((step) => step.type === "unknown")) return failure("native_step_unsupported");
  return { ok: true, turn };
}

function failure(reason: string, retryable = false): Failure {
  return retryable ? { ok: false, reason, retryable: true } : { ok: false, reason };
}
