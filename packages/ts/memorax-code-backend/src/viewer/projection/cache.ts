export const MEMORY_VIEWER_DATA_PROJECTION_CAPACITY = 64;

type MemoryViewerDataProjection = {
  historical: unknown;
  liveVersion: number;
  data: unknown;
};

type SharedMemoryViewerDataProjection = {
  historical: unknown;
  liveVersion: number;
  value: unknown;
};

const dataProjections = new Map<string, Map<string, MemoryViewerDataProjection>>();
const sharedDataProjections = new Map<string, Map<string, SharedMemoryViewerDataProjection>>();
const projectionHistories = new Map<string, unknown>();

export function prepareMemoryViewerDataProjectionHistory(projectionKey: string, historical: unknown): void {
  if (projectionHistories.get(projectionKey) === historical) return;
  dataProjections.delete(projectionKey);
  sharedDataProjections.delete(projectionKey);
  projectionHistories.set(projectionKey, historical);
}

export function shareMemoryViewerDataProjectionValue<T>(
  projectionKey: string,
  valueKey: string,
  historical: unknown,
  liveVersion: number,
  create: () => T,
): T {
  let projections = sharedDataProjections.get(projectionKey);
  if (!projections) {
    projections = new Map();
    sharedDataProjections.set(projectionKey, projections);
  }
  const cached = projections.get(valueKey);
  if (cached && cached.historical === historical && cached.liveVersion === liveVersion) return cached.value as T;
  const value = create();
  projections.set(valueKey, { historical, liveVersion, value });
  return value;
}

export function readMemoryViewerDataProjection<T>(
  projectionKey: string,
  filterKey: string,
  historical: unknown,
  liveVersion: number,
): T | undefined {
  const projections = dataProjections.get(projectionKey);
  const cached = projections?.get(filterKey);
  if (!cached || cached.historical !== historical || cached.liveVersion !== liveVersion) return undefined;
  projections?.delete(filterKey);
  projections?.set(filterKey, cached);
  return cached.data as T;
}

export function writeMemoryViewerDataProjection<T>(
  projectionKey: string,
  filterKey: string,
  historical: unknown,
  liveVersion: number,
  data: T,
): void {
  let projections = dataProjections.get(projectionKey);
  if (!projections) {
    projections = new Map();
    dataProjections.set(projectionKey, projections);
  }
  projections.set(filterKey, { historical, liveVersion, data });
  while (projections.size > MEMORY_VIEWER_DATA_PROJECTION_CAPACITY) {
    const oldestKey = projections.keys().next().value as string | undefined;
    if (!oldestKey) break;
    projections.delete(oldestKey);
  }
}

export function clearMemoryViewerDataProjections(): void {
  dataProjections.clear();
  sharedDataProjections.clear();
}

export function clearMemoryViewerDataProjectionCache(): void {
  dataProjections.clear();
  sharedDataProjections.clear();
  projectionHistories.clear();
}

export function memoryViewerDataProjectionCacheSize(projectionKey: string): number {
  return dataProjections.get(projectionKey)?.size ?? 0;
}

export function memoryViewerSharedDataProjectionCacheSize(projectionKey: string): number {
  return sharedDataProjections.get(projectionKey)?.size ?? 0;
}

export function shouldCacheMemoryViewerDataProjection(
  filter: { sessionId?: string; projectId?: string },
  data: {
    projectSessions: ReadonlyArray<{ sessionId?: string }>;
    projectFilterStatus?: string;
  },
): boolean {
  if (filter.sessionId && !data.projectSessions.some((entry) => entry.sessionId === filter.sessionId)) return false;
  if (filter.projectId && data.projectFilterStatus !== "resolved") return false;
  return true;
}
