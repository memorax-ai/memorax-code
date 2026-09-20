import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parse } from "smol-toml";

export const SEARCH_EXPERIMENT_FORMULA_IDS = [
  "semantic_decay_plus_helpful",
  "joint_decay_semantic_helpful",
  "geometric_semantic_decay_helpful",
  "linear_semantic_decay_helpful",
  "semantic_gate_decay_plus_helpful",
] as const;

export type SearchExperimentFormulaId = typeof SEARCH_EXPERIMENT_FORMULA_IDS[number];

export type SearchExperimentConfig = Readonly<{
  formula?: SearchExperimentFormulaId;
  staleDays?: number;
  maxUsage?: number;
}>;

export type SearchExperimentConfigResult =
  | { ok: true; config: SearchExperimentConfig }
  | { ok: false; error: string };

const FORMULA_ID_SET = new Set<string>(SEARCH_EXPERIMENT_FORMULA_IDS);

export async function searchExperimentConfigFromArgs(
  args: string[],
  cwd = process.cwd(),
): Promise<SearchExperimentConfigResult> {
  const filePath = argValue(args, "--experiment-config");
  if (args.includes("--experiment-config") && filePath === undefined) {
    return { ok: false, error: "--experiment-config requires a file path" };
  }
  let fileConfig: SearchExperimentConfig = {};
  if (filePath !== undefined) {
    const loaded = await loadSearchExperimentConfig(filePath, cwd);
    if (!loaded.ok) return loaded;
    fileConfig = loaded.config;
  }

  const formulaRaw = argValue(args, "--formula");
  const staleRaw = argValue(args, "--stale-days");
  const maxUsageRaw = argValue(args, "--max-usage");
  if (args.includes("--formula") && formulaRaw === undefined) {
    return { ok: false, error: "--formula requires a formula ID" };
  }
  if (args.includes("--stale-days") && staleRaw === undefined) {
    return { ok: false, error: "--stale-days requires an integer" };
  }
  if (args.includes("--max-usage") && maxUsageRaw === undefined) {
    return { ok: false, error: "--max-usage requires an integer" };
  }
  if ((staleRaw === undefined) !== (maxUsageRaw === undefined)) {
    return { ok: false, error: "--stale-days and --max-usage must be provided together" };
  }

  const cliConfig: { formula?: SearchExperimentFormulaId; staleDays?: number; maxUsage?: number } = {};
  if (formulaRaw !== undefined) {
    const formula = validateFormulaId(formulaRaw);
    if (!formula.ok) return formula;
    cliConfig.formula = formula.value;
  }
  if (staleRaw !== undefined && maxUsageRaw !== undefined) {
    const staleDays = parseNonNegativeInteger(staleRaw, "--stale-days");
    if (!staleDays.ok) return staleDays;
    const maxUsage = parseNonNegativeInteger(maxUsageRaw, "--max-usage");
    if (!maxUsage.ok) return maxUsage;
    cliConfig.staleDays = staleDays.value;
    cliConfig.maxUsage = maxUsage.value;
  }
  return validateSearchExperimentConfig({ ...fileConfig, ...cliConfig });
}

export async function loadSearchExperimentConfig(
  filePath: string,
  cwd = process.cwd(),
): Promise<SearchExperimentConfigResult> {
  const resolvedPath = isAbsolute(filePath) ? filePath : resolve(cwd, filePath);
  let text: string;
  try {
    text = await readFile(resolvedPath, "utf8");
  } catch (error) {
    return { ok: false, error: `failed to read --experiment-config ${filePath}: ${error instanceof Error ? error.message : String(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (error) {
    return { ok: false, error: `failed to parse --experiment-config ${filePath}: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!isRecord(parsed)) return { ok: false, error: "--experiment-config must contain a TOML table" };
  const allowedKeys = new Set(["formula", "stale_days", "max_usage"]);
  const unknown = Object.keys(parsed).find((key) => !allowedKeys.has(key));
  if (unknown) return { ok: false, error: `unknown experiment config field: ${unknown}` };
  const formula = parsed.formula === undefined ? undefined : validateFormulaId(parsed.formula);
  if (formula && !formula.ok) return formula;
  const staleDays = parsed.stale_days === undefined ? undefined : parseNonNegativeIntegerValue(parsed.stale_days, "stale_days");
  if (staleDays && !staleDays.ok) return staleDays;
  const maxUsage = parsed.max_usage === undefined ? undefined : parseNonNegativeIntegerValue(parsed.max_usage, "max_usage");
  if (maxUsage && !maxUsage.ok) return maxUsage;
  return validateSearchExperimentConfig({
    ...(formula ? { formula: formula.value } : {}),
    ...(staleDays ? { staleDays: staleDays.value } : {}),
    ...(maxUsage ? { maxUsage: maxUsage.value } : {}),
  });
}

export function validateSearchExperimentConfig(config: SearchExperimentConfig): SearchExperimentConfigResult {
  if ((config.staleDays === undefined) !== (config.maxUsage === undefined)) {
    return { ok: false, error: "stale_days and max_usage must be provided together" };
  }
  if (config.staleDays !== undefined && (!Number.isSafeInteger(config.staleDays) || config.staleDays < 1 || config.staleDays > 36_500)) {
    return { ok: false, error: "stale_days must be an integer from 1 to 36500" };
  }
  if (config.maxUsage !== undefined && (!Number.isSafeInteger(config.maxUsage) || config.maxUsage < 0 || config.maxUsage > 2_147_483_647)) {
    return { ok: false, error: "max_usage must be an integer from 0 to 2147483647" };
  }
  if (config.formula !== undefined && !FORMULA_ID_SET.has(config.formula)) {
    return { ok: false, error: `unsupported formula: ${config.formula}` };
  }
  return { ok: true, config };
}

function validateFormulaId(value: unknown): { ok: true; value: SearchExperimentFormulaId } | { ok: false; error: string } {
  if (typeof value !== "string" || !FORMULA_ID_SET.has(value.trim())) return { ok: false, error: `unsupported formula: ${String(value)}` };
  return { ok: true, value: value.trim() as SearchExperimentFormulaId };
}

function parseNonNegativeInteger(value: string, label: string): { ok: true; value: number } | { ok: false; error: string } {
  return parseNonNegativeIntegerValue(Number(value), label);
}

function parseNonNegativeIntegerValue(value: unknown, label: string): { ok: true; value: number } | { ok: false; error: string } {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return { ok: false, error: `${label} must be a non-negative integer` };
  return { ok: true, value };
}

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
