import type { CodingSessionClient, CodingSessionNativeSource, CodingSessionSourceTurn, PreparedSessionTurn, ResponseItem } from "./coding-turn.js";

export type NativeCodingSessionTurnRef = Omit<CodingSessionSourceTurn, "items" | "repositorySlug"> & {
  source: CodingSessionNativeSource;
};
// Compact UTF-8 JSON for the archive object only, excluding QA and Add fields.
export const CODING_SESSION_BATCH_MAX_BYTES = 2 * 1024 * 1024;

// Counts partition the flat Items array in native Turn order. These fields are
// archive metadata, separate from the QA messages sent for memory extraction.
export type SessionTurnMetadata = Readonly<{
  turn_id: string;
  turn_index: number;
  closed_at: string;
  item_count: number;
  truncation?: PreparedSessionTurn["truncation"];
}>;

export type CodingSessionAttachment = Readonly<{
  schema_version: 1;
  redaction_version: 1;
  batch_id: string;
  client: CodingSessionClient;
  session_id: string;
  repository_slug: string;
  turns: readonly SessionTurnMetadata[];
  items: readonly ResponseItem[];
}>;

export type PendingCodingSessionTurn =
  | Readonly<{ reference: NativeCodingSessionTurnRef; digest: string }>
  | Readonly<{ prepared: PreparedSessionTurn }>;

export type CodingSessionTurnReader = (ref: NativeCodingSessionTurnRef) => Promise<CodingSessionSourceTurn | undefined>;
