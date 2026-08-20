export type MemoraxQuotaSnapshot = Readonly<{
  featureCode: "memory_write" | "memory_search";
  remaining: number;
  limit: number;
}>;

export function memoraxQuotaFromResponse(
  body: unknown,
  featureCode: MemoraxQuotaSnapshot["featureCode"],
): MemoraxQuotaSnapshot | undefined {
  if (!isRecord(body) || !isRecord(body.data) || !Array.isArray(body.data.balances)) {
    return undefined;
  }
  for (const balance of body.data.balances) {
    if (!isRecord(balance)
      || balance.product_code !== "memory_api"
      || balance.feature_code !== featureCode
      || balance.spec_key !== "calls"
      || balance.quota_unit !== "times") {
      continue;
    }
    const remaining = nonNegativeSafeInteger(balance.remaining);
    const limit = nonNegativeSafeInteger(balance.quota_limit);
    if (remaining !== undefined && limit !== undefined && remaining <= limit) {
      return { featureCode, remaining, limit };
    }
  }
  return undefined;
}

function nonNegativeSafeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
