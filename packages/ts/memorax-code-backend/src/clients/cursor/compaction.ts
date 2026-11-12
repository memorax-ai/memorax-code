import { isAbsolute } from "node:path";
import type { CursorCompactionSnapshot } from "./database-snapshot.js";

type Baseline = { rootMessageIds: string[]; archiveIds: string[] };
export type CursorCompactionState = {
  version: 1;
  databasePath: string;
  databaseIdentity: string;
  cwd: string;
  scopeKey: string;
  processedArchiveIds: string[];
  baseline?: Baseline;
};
export type CursorCompactionBinding = Pick<CursorCompactionState, "databasePath" | "cwd" | "scopeKey">;

// A preCompact observation only arms a comparison. It is never evidence that
// the native context was replaced, and contains no summary or Hook text.
export function captureCursorCompaction(
  previous: CursorCompactionState | undefined,
  binding: CursorCompactionBinding,
  snapshot: CursorCompactionSnapshot,
): CursorCompactionState {
  const state: CursorCompactionState = previous && matches(previous, binding, snapshot)
    ? previous
    : { version: 1, ...binding, databaseIdentity: snapshot.databaseIdentity, processedArchiveIds: [] };
  // Preserve the earliest applicable baseline through consecutive compactions,
  // including a successful replacement followed by an aborted attempt.
  if (!state.baseline || appliedArchives(state.baseline, snapshot) === undefined) {
    state.baseline = {
      rootMessageIds: [...snapshot.rootMessageIds],
      archiveIds: snapshot.archives.map(({ id }) => id),
    };
  }
  return state;
}

export function consumeCursorCompaction(
  state: CursorCompactionState,
  binding: CursorCompactionBinding,
  snapshot: CursorCompactionSnapshot,
): boolean {
  if (!matches(state, binding, snapshot)) {
    delete state.baseline;
    return false;
  }
  if (!state.baseline) return false;
  const applied = appliedArchives(state.baseline, snapshot);
  if (applied?.length === 0) return false;
  // Replaced branches and archive rollback invalidate pending observations.
  delete state.baseline;
  if (!applied) return false;
  const unseen = applied.filter((id) => !state.processedArchiveIds.includes(id));
  if (!unseen.length || state.processedArchiveIds.length + unseen.length > 1024) return false;
  state.processedArchiveIds.push(...unseen);
  return true;
}

function matches(
  state: CursorCompactionState | undefined,
  binding: CursorCompactionBinding,
  snapshot: CursorCompactionSnapshot,
): boolean {
  return state !== undefined && state.databasePath === binding.databasePath
    && state.cwd === binding.cwd && state.scopeKey === binding.scopeKey
    && state.databaseIdentity === snapshot.databaseIdentity;
}

function appliedArchives(baseline: Baseline, snapshot: CursorCompactionSnapshot): string[] | undefined {
  if (!baseline.rootMessageIds.length || baseline.archiveIds.length > snapshot.archives.length
    || baseline.archiveIds.some((id, index) => snapshot.archives[index].id !== id)) return undefined;
  const added = snapshot.archives.slice(baseline.archiveIds.length);
  const summarizedIds = new Set<string>();
  let roots = baseline.rootMessageIds;
  for (const archive of added) {
    const summarized = new Set(archive.summarizedMessageIds);
    for (const id of summarized) summarizedIds.add(id);
    const first = roots.findIndex((id) => summarized.has(id));
    if (first < 0 || roots.includes(archive.summaryMessageId)) return undefined;
    // Keep every observed root not accounted for by the archive. Concurrently
    // appended messages need not have been present in our earlier checkpoint.
    roots = roots.flatMap((id, index) => [
      ...(index === first ? [archive.summaryMessageId] : []),
      ...(summarized.has(id) ? [] : [id]),
    ]);
  }
  let index = 0;
  for (const id of snapshot.rootMessageIds) if (id === roots[index]) index += 1;
  if (index !== roots.length) return undefined;
  // A compatible partial replacement is still pending. Keep the checkpoint
  // until summarized roots, including superseded summaries, have all left.
  if (snapshot.rootMessageIds.some((id) => summarizedIds.has(id))) return [];
  return added.map(({ id }) => id);
}

export function validCursorCompactionState(value: unknown): value is CursorCompactionState {
  if (!record(value) || !keys(value, ["version", "databasePath", "databaseIdentity", "cwd", "scopeKey", "processedArchiveIds", "baseline"])
    || value.version !== 1 || !absolutePath(value.databasePath) || !absolutePath(value.cwd)
    || !digest(value.databaseIdentity) || !digest(value.scopeKey) || !refs(value.processedArchiveIds, 1024)) return false;
  return value.baseline === undefined || (record(value.baseline)
    && keys(value.baseline, ["rootMessageIds", "archiveIds"])
    && refs(value.baseline.rootMessageIds, 4096) && value.baseline.rootMessageIds.length > 0
    && refs(value.baseline.archiveIds, 1024));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function digest(value: unknown): boolean { return typeof value === "string" && /^[a-f0-9]{64}$/.test(value); }
function absolutePath(value: unknown): boolean {
  return typeof value === "string" && isAbsolute(value) && !/[\0\r\n]/.test(value);
}
function refs(value: unknown, limit: number): value is string[] {
  return Array.isArray(value) && value.length <= limit && new Set(value).size === value.length
    && value.every((id) => typeof id === "string" && /^(?:[a-f0-9]{2}){1,64}$/.test(id));
}
