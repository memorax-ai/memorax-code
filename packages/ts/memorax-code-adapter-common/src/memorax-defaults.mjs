export const MEMORAX_DEFAULT_BASE_URL = "http://preview.memorax.net";
export const MEMORAX_ACCOUNT_URL = "http://preview.memorax.net/";
export const MEMORAX_DEFAULT_MEMORY_OUTPUT_LANGUAGE = "zh";

export function normalizeMemoraxBaseUrl(value) {
  return String(value ?? "").trim().replace(/\/+$/, "");
}

export function normalizeMemoraxMemoryOutputLanguage(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return normalized === "zh" || normalized === "en" ? normalized : undefined;
}
