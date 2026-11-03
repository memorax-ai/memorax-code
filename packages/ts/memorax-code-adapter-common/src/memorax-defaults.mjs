export const MEMORAX_DEFAULT_BASE_URL = "https://platform.memoraxai.com";
export const MEMORAX_ACCOUNT_URL = "https://platform.memoraxai.com/";
export const MEMORAX_DEFAULT_MEMORY_OUTPUT_LANGUAGE = "zh";

export function normalizeMemoraxBaseUrl(value) {
  const normalized = String(value ?? "").trim().replace(/\/+$/, "");
  // Bypass the legacy domain's cross-origin redirect before sending credentials.
  return /^https:\/\/platform\.memorax\.net(?::443)?$/i.test(normalized)
    ? MEMORAX_DEFAULT_BASE_URL
    : normalized;
}

export function normalizeMemoraxMemoryOutputLanguage(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "zh" || normalized === "en" ? normalized : undefined;
}
