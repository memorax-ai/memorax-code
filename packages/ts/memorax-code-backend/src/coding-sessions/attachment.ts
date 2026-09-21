import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { RepositoryMemoryScope } from "../repository/scope.js";
import { prepareCodingSessionTurn, type CodingSessionSourceTurn, type PreparedSessionTurn } from "./coding-turn.js";
import type { CodingSessionAttachment, CodingSessionTurnReader, PendingCodingSessionTurn } from "./contracts.js";

export function preparePendingCodingSessionTurn(
  source: CodingSessionSourceTurn,
  scope: RepositoryMemoryScope,
): PendingCodingSessionTurn | undefined {
  const prepared = prepareCodingSessionTurn({ ...source, repositorySlug: scope.repositorySlug });
  if (!prepared) return undefined;
  if (!source.source) {
    // OpenCode's validated SDK records have no file-backed read authority.
    return source.client === "opencode" ? { prepared } : undefined;
  }
  if (!isAbsolute(source.source.transcriptPath)
    || !Number.isSafeInteger(source.source.endBytes) || source.source.endBytes < 1) return undefined;
  return {
    reference: {
      client: source.client, sessionId: source.sessionId, turnId: source.turnId,
      turnIndex: source.turnIndex, closedAt: source.closedAt, outcome: "completed",
      source: { ...source.source }, projectionVersion: 2,
    },
    digest: digest(prepared),
  };
}

export async function materializePendingCodingSessionTurn(
  pending: PendingCodingSessionTurn,
  scope: RepositoryMemoryScope,
  readTurn?: CodingSessionTurnReader,
): Promise<PreparedSessionTurn | undefined> {
  if ("prepared" in pending) return pending.prepared;
  const source = await readTurn?.(pending.reference);
  if (!source) return undefined;
  const prepared = prepareCodingSessionTurn({ ...source, repositorySlug: scope.repositorySlug });
  return prepared && digest(prepared) === pending.digest ? prepared : undefined;
}

export function codingSessionAttachment(
  turns: readonly PreparedSessionTurn[],
  scope: RepositoryMemoryScope,
): CodingSessionAttachment {
  const sorted = [...turns].sort((left, right) => left.turn_index - right.turn_index);
  const first = sorted[0];
  if (!first || sorted.some((turn, index) => turn.client !== first.client
    || turn.session_id !== first.session_id || turn.repository_slug !== scope.repositorySlug
    || (index > 0 && turn.turn_index === sorted[index - 1].turn_index))
    || new Set(sorted.map((turn) => turn.turn_id)).size !== sorted.length) {
    throw new Error("Archive Turns must belong to one session and scope");
  }
  const content = {
    schema_version: 2 as const, redaction_version: 1 as const,
    client: first.client, session_id: first.session_id, repository_slug: scope.repositorySlug,
    turns: sorted.map((turn) => ({
      turn_id: turn.turn_id, turn_index: turn.turn_index, closed_at: turn.closed_at,
      item_count: turn.items.length, ...(turn.truncation ? { truncation: turn.truncation } : {}),
    })),
    items: sorted.flatMap((turn) => turn.items),
  };
  // Identity describes the exact redacted attachment, not an attempt or QA
  // fragment. Replays carry the same ID without claiming OSS persistence.
  return { ...content, batch_id: digest([scope.effectiveUserId, content]) };
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
