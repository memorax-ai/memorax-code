import type { RepositoryMemoryScope } from "../repository/scope.js";
import type { CodingSessionClient, CodingSessionNativeSource, CodingSessionSourceTurn, PreparedSessionTurn, ResponseItem } from "./coding-turn.js";

export type CodingSessionUploadInput = {
  turn: CodingSessionSourceTurn;
  repositoryScope: RepositoryMemoryScope;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
};
export type CodingSessionUploadResult = { accepted: true } | { accepted: false; reason: string };
export type CodingSessionUploadEnqueue = (input: CodingSessionUploadInput) => CodingSessionUploadResult | Promise<CodingSessionUploadResult>;
export type NativeCodingSessionTurnRef = Omit<CodingSessionSourceTurn, "items" | "repositorySlug"> & { source: CodingSessionNativeSource };
export type CodingSessionInteraction = {
  client: CodingSessionClient;
  sessionId: string;
  repositoryScope: RepositoryMemoryScope;
};

export const CODING_SESSION_EVENT = "dreaming";
export const CODING_SESSION_BATCH_MAX_BYTES = 20 * 1024 * 1024;

// Counts partition the flat Items array in source-Turn order. Native Turn indexes
// remain meaningful across Backend restarts; batch IDs remain unique on replay.
export type SessionTurnMetadata = Readonly<{
  turn_id: string;
  turn_index: number;
  closed_at: string;
  item_count: number;
  truncation?: PreparedSessionTurn["truncation"];
}>;

export type CodingSessionBatch = Readonly<{
  event: typeof CODING_SESSION_EVENT;
  schema_version: 2;
  redaction_version: 1;
  batch_id: string;
  user_id: string;
  client: CodingSessionClient;
  session_id: string;
  repository_slug: string;
  turns: readonly SessionTurnMetadata[];
  items: readonly ResponseItem[];
}>;
