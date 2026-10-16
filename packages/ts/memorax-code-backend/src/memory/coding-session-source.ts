import type { CodingSessionNativeSource, CodingSessionSourceTurn } from "../coding-sessions/coding-turn.js";
import { readClaudeArchiveSource } from "../clients/claude/transcript-turn.js";
import { readCodeBuddyArchiveSource } from "../clients/codebuddy/jsonl-history.js";
import { readCodexArchiveSource } from "../clients/codex/rollout-turn.js";

export async function readCodingSessionSourceTurn(
  ref: Omit<CodingSessionSourceTurn, "items" | "repositorySlug"> & { source: CodingSessionNativeSource },
): Promise<CodingSessionSourceTurn | undefined> {
  // Client readers preserve the completion observation frozen at registration.
  return ref.client === "codex" ? readCodexArchiveSource(ref)
    : ref.client === "claude-code" ? readClaudeArchiveSource(ref)
    : ref.client === "codebuddy" || ref.client === "workbuddy"
      ? readCodeBuddyArchiveSource(ref)
      : undefined;
}
