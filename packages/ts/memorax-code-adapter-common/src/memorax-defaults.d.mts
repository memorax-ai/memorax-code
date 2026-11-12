export const MEMORAX_DEFAULT_BASE_URL: "https://platform.memoraxai.com";
export const MEMORAX_ACCOUNT_URL: "https://platform.memoraxai.com/";
export const MEMORAX_DEFAULT_MEMORY_OUTPUT_LANGUAGE: "zh";

export type MemoraxMemoryOutputLanguage = "zh" | "en";

export function normalizeMemoraxBaseUrl(value: unknown): string;
export function normalizeMemoraxMemoryOutputLanguage(
  value: unknown,
): MemoraxMemoryOutputLanguage | undefined;
