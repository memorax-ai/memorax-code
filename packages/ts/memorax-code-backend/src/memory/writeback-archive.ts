import { codingSessionAttachment, materializePendingCodingSessionTurn } from "../coding-sessions/attachment.js";
import type { PreparedSessionTurn } from "../coding-sessions/coding-turn.js";
import { CODING_SESSION_BATCH_MAX_BYTES, type CodingSessionAttachment, type CodingSessionTurnReader, type PendingCodingSessionTurn } from "../coding-sessions/contracts.js";
import { codingSessionsEnabled, loadMemoraxCodeConfig } from "../config/memorax-code.js";
import type { RepositoryMemoryScope } from "../repository/scope.js";
import type { MemoryDiagnosticLogger } from "./observability.js";
import type { MemoryWritebackSourceTurn } from "./writeback-buffer.js";
import { memoryWritebackAddParts, type MemoryWritebackAddPart, type WritebackMessage } from "./writeback-chunk.js";

export type CombinedWritebackPart = MemoryWritebackAddPart & { dreaming?: CodingSessionAttachment };
type MaterializedTurn = { index: number; messages: WritebackMessage[]; archive?: PreparedSessionTurn };

export async function combinedMemoryWritebackParts(
  decision: {
    idempotencyKey: string;
    messages: WritebackMessage[];
    codingTurn?: PendingCodingSessionTurn;
    sourceTurns?: MemoryWritebackSourceTurn[];
  },
  options: {
    repositoryScope: RepositoryMemoryScope;
    env: Record<string, string | undefined>;
    readCodingSessionTurn?: CodingSessionTurnReader;
    diagnosticLogger: MemoryDiagnosticLogger;
  },
): Promise<CombinedWritebackPart[]> {
  const { repositoryScope: scope, env } = options;
  if (!codingSessionsEnabled(env, loadMemoraxCodeConfig(env.MEMORAX_CODE_HOME))) {
    return memoryWritebackAddParts(decision, env);
  }
  const turns: MaterializedTurn[] = [];
  for (const [index, source] of (decision.sourceTurns ?? [decision]).entries()) {
    let archive: PreparedSessionTurn | undefined;
    if (source.codingTurn) {
      try {
        archive = await materializePendingCodingSessionTurn(source.codingTurn, scope, options.readCodingSessionTurn);
      } catch { /* Missing or changed native files do not invalidate accepted QA. */ }
      if (!archive) options.diagnosticLogger("coding_sessions.attachment_skipped", { reason: "source_unavailable_or_changed" });
    }
    turns.push({ index, messages: source.messages, ...(archive ? { archive } : {}) });
  }
  if (!turns.some((turn) => turn.archive)) return memoryWritebackAddParts(decision, env);

  function partsFor(group: MaterializedTurn[]): CombinedWritebackPart[] {
    const attached = new Set<string>();
    const byId = new Map(group.map((turn) => [String(turn.index), turn]));
    const parts = memoryWritebackAddParts({
      idempotencyKey: `${decision.idempotencyKey}:source:${group[0].index}`,
      messages: group.flatMap((turn) => turn.messages.map((message) => ({ ...message, sourceTurnId: String(turn.index) }))),
    }, env);
    return parts.map((part) => {
      const archives: PreparedSessionTurn[] = [];
      for (const message of part.messages) {
        const id = message.sourceTurnId!;
        const archive = byId.get(id)?.archive;
        if (!archive || attached.has(id)) continue;
        archives.push(archive);
        attached.add(id);
      }
      return { ...part, ...(archives.length ? { dreaming: codingSessionAttachment(archives, scope) } : {}) };
    });
  }

  function fits(parts: CombinedWritebackPart[]): boolean {
    return parts.every((part) => !part.dreaming
      || Buffer.byteLength(JSON.stringify(part.dreaming), "utf8") <= CODING_SESSION_BATCH_MAX_BYTES);
  }

  const result: CombinedWritebackPart[] = [];
  let group: MaterializedTurn[] = [];
  for (let turn of turns) {
    if (group.length && !fits(partsFor([...group, turn]))) {
      result.push(...partsFor(group));
      group = [];
    }
    if (!fits(partsFor([turn]))) {
      // No independent archive queue or extra QA request: a single oversized
      // attachment is skipped explicitly while the original QA still proceeds.
      options.diagnosticLogger("coding_sessions.attachment_skipped", { reason: "turn_exceeds_archive_limit" });
      turn = { index: turn.index, messages: turn.messages };
    }
    group.push(turn);
  }
  if (group.length) result.push(...partsFor(group));
  return result;
}
