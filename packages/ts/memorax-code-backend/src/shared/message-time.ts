// Native records use epoch milliseconds or ISO timestamps with an explicit
// timezone. Reject seconds and locale-dependent strings rather than guessing.
export function parseNativeMessageTimestamp(value: unknown): number | undefined {
  const timestamp = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)
      ? Date.parse(value)
      : NaN;
  return Number.isSafeInteger(timestamp) && timestamp >= 10_000_000_000 && timestamp <= 8_640_000_000_000_000
    ? timestamp
    : undefined;
}
