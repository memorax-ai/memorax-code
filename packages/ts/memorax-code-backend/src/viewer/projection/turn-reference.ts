export type MemoryViewerTurnReferenceLike = Readonly<{
  turnId?: string;
}>;

export type MemoryViewerTurnReferencedEvent = Readonly<{
  turnId?: string;
  turnReferences?: readonly MemoryViewerTurnReferenceLike[];
}>;

export function memoryViewerEventTurnIds(event: MemoryViewerTurnReferencedEvent): string[] {
  return [...new Set([
    safeTurnId(event.turnId),
    ...(event.turnReferences ?? []).map((reference) => safeTurnId(reference.turnId)),
  ].filter(Boolean))];
}

function safeTurnId(value: unknown): string {
  const candidate = typeof value === "string" ? value.trim() : "";
  if (!candidate || candidate.length > 512 || /[\u0000-\u001f\u007f\\/]/.test(candidate)) return "";
  return candidate;
}
