import type { CodingSessionClient, NormalizedCodingTurn } from "./coding-turn.js";

export const CODING_SESSION_EVENT = "coding_session";
export const CODING_SESSION_BATCH_MAX_BYTES = 20 * 1024 * 1024;

export type CodingSessionBatch = Readonly<{
  event: typeof CODING_SESSION_EVENT;
  batch_id: string;
  user_id: string;
  client: CodingSessionClient;
  session_id: string;
  coding_turns: readonly NormalizedCodingTurn[];
}>;
