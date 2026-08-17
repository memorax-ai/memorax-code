export type MemoraxQuotaSnapshot = Readonly<{
  remaining: number;
  limit: number;
}>;

export function memoraxQuotaFromHeaders(headers: Headers): MemoraxQuotaSnapshot | undefined {
  const remaining = nonNegativeSafeInteger(headers.get("x-memorax-quota-remaining"));
  const limit = nonNegativeSafeInteger(headers.get("x-memorax-quota-limit"));
  if (remaining === undefined || limit === undefined || remaining > limit) return undefined;
  return { remaining, limit };
}

function nonNegativeSafeInteger(value: string | null): number | undefined {
  const text = value?.trim();
  if (!text || !/^\d+$/.test(text)) return undefined;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}
