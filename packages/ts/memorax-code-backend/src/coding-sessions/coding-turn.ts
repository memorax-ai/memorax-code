import { homedir } from "node:os";
import type { MemoryDiagnosticLogger } from "../memory/observability.js";
import { redactMemoryPayloadText } from "../memory/payload-redaction.js";

export type CodingSessionClient = "codex" | "claude-code" | "opencode" | "codebuddy" | "workbuddy";

// Local recovery authority only; never included in an archive payload.
export type CodingSessionNativeSource = Readonly<{ transcriptPath: string; endBytes: number }>;

export type ResponseJsonValue = null | boolean | number | string | readonly ResponseJsonValue[] | ResponseJsonObject;
export type ResponseJsonObject = { readonly [key: string]: ResponseJsonValue };
type ToolSearchIdentity = Readonly<{ execution?: "server" | "client"; call_id?: string | null; status?: string }>;

// This is the collected text/tool subset, not a complete Responses API request.
export type ResponseItem = Readonly<{ id?: string }> & (
  | Readonly<{ type: "message"; role: "user"; content: readonly Readonly<{ type: "input_text"; text: string }>[] }>
  | Readonly<{ type: "message"; role: "assistant"; phase: "commentary" | "final_answer"; content: readonly Readonly<{ type: "output_text"; text: string }>[] }>
  | Readonly<{ type: "function_call"; call_id: string; name: string; arguments: string; namespace?: string }>
  | Readonly<{ type: "custom_tool_call"; call_id: string; name: string; input: string }>
  | Readonly<{ type: "function_call_output" | "custom_tool_call_output"; call_id: string; output: string }>
  | Readonly<{ type: "web_search_call"; status?: string; action: ResponseJsonObject }>
  | (ToolSearchIdentity & Readonly<{ type: "tool_search_call"; arguments: ResponseJsonValue }>)
  | (ToolSearchIdentity & Readonly<{ type: "tool_search_output"; tools: readonly ResponseJsonObject[] }>)
);

export type CodingSessionSourceTurn = Readonly<{
  client: CodingSessionClient;
  sessionId: string;
  turnId: string;
  turnIndex: number;
  items: readonly ResponseItem[];
  outcome: "completed";
  closedAt: string;
  repositorySlug?: string;
  source?: CodingSessionNativeSource;
}>;

export type PreparedSessionTurn = Readonly<{
  client: CodingSessionClient;
  session_id: string;
  turn_id: string;
  turn_index: number;
  items: readonly ResponseItem[];
  closed_at: string;
  repository_slug?: string;
  truncation?: Readonly<{
    original_item_count: number;
    truncated_text_fields: number;
  }>;
}>;

export const CODING_TURN_MAX_BYTES = 2 * 1024 * 1024;
const CODING_TURN_TEXT_MAX_CHARS = 128_000;
const CODING_TURN_MAX_ITEMS = 512;
const BINARY_CONTENT_OMITTED = "[BINARY_CONTENT_OMITTED]";

export function prepareCodingSessionTurn(
  turn: CodingSessionSourceTurn,
  diagnosticLogger?: MemoryDiagnosticLogger,
): PreparedSessionTurn | undefined {
  if (!Number.isSafeInteger(turn.turnIndex) || turn.turnIndex < 1) return undefined;
  const sessionId = boundedIdentifier(turn.sessionId);
  const turnId = boundedIdentifier(turn.turnId);
  const closedAt = normalizedTimestamp(turn.closedAt);
  if (!sessionId || !turnId || !closedAt || turn.outcome !== "completed") return undefined;

  const truncatedFields = new Set<string>();
  const markTruncated = (sourceIndex: number) => (fieldIndex: number) => {
    truncatedFields.add(`${sourceIndex}:${fieldIndex}`);
  };
  type Candidate = { item: ResponseItem; sourceIndex: number };
  const grouped = new Map<string, { items: Candidate[]; invalid: boolean }>();
  turn.items.forEach((item, sourceIndex) => {
    // Native tool groups may be interleaved; bounds must not split a selected pair.
    const family = item.type === "function_call" || item.type === "function_call_output" ? "function"
      : item.type === "custom_tool_call" || item.type === "custom_tool_call_output" ? "custom"
        : item.type === "tool_search_call" || item.type === "tool_search_output" ? "search" : undefined;
    const key = family && "call_id" in item && item.call_id
      ? `${family}:${item.call_id.trim()}` : family === "search" ? "hosted-search" : `item:${sourceIndex}`;
    const group = grouped.get(key) ?? { items: [], invalid: false };
    const normalized = prepareItem(item, markTruncated(sourceIndex));
    if (normalized) group.items.push({ item: normalized, sourceIndex });
    else group.invalid = true;
    grouped.set(key, group);
  });
  const groups = [...grouped.values()].filter((group) => !group.invalid).map((group) => group.items);
  const required = groups.flat().filter(({ item }) => (
    item.type === "message" && (item.role === "user" || item.phase === "final_answer")
  ));
  if (!required.some(({ item }) => item.type === "message" && item.role === "user")
    || !required.some(({ item }) => item.type === "message" && item.role === "assistant")
    || required.length > CODING_TURN_MAX_ITEMS) return undefined;
  const repositorySlug = boundedIdentifier(turn.repositorySlug);
  const envelope = {
    client: turn.client,
    session_id: sessionId,
    turn_id: turnId,
    turn_index: turn.turnIndex,
    closed_at: closedAt,
    ...(repositorySlug ? { repository_slug: repositorySlug } : {}),
  };
  // Budget the complete single-Turn wire attachment, including the loss marker.
  let remaining = CODING_TURN_MAX_BYTES - jsonBytes({
    schema_version: 1, redaction_version: 1, batch_id: "0".repeat(64),
    client: turn.client, session_id: sessionId, repository_slug: repositorySlug ?? "",
    turns: [{
      turn_id: turnId, turn_index: turn.turnIndex, closed_at: closedAt,
      item_count: CODING_TURN_MAX_ITEMS,
      truncation: {
        original_item_count: turn.items.length,
        // Structured search items can contain many independently bounded strings.
        truncated_text_fields: turn.items.some(isSearchToolItem) ? Number.MAX_SAFE_INTEGER
          : turn.items.reduce((count, item) => count + (item.type === "message" ? item.content.length : 1), 0),
      },
    }],
    items: [],
  });
  const kept: Candidate[] = [];
  let requiredBytes = required.reduce((total, { item }) => total + itemBytes(item), 0);
  for (const [index, candidate] of required.entries()) {
    requiredBytes -= itemBytes(candidate.item);
    const budget = Math.min(itemBytes(candidate.item), Math.max(
      remaining - requiredBytes, Math.floor(remaining / (required.length - index)),
    ));
    const item = fitItem(candidate.item, budget, markTruncated(candidate.sourceIndex));
    if (!item) return undefined;
    kept.push({ ...candidate, item });
    remaining -= itemBytes(item);
  }
  const requiredIndexes = new Set(required.map(({ sourceIndex }) => sourceIndex));
  for (const group of groups.reverse()) {
    if (requiredIndexes.has(group[0].sourceIndex) || kept.length + group.length > CODING_TURN_MAX_ITEMS) continue;
    const fitted: Candidate[] = [];
    let groupBudget = remaining;
    for (const candidate of group) {
      const item = fitItem(candidate.item, groupBudget, markTruncated(candidate.sourceIndex));
      if (!item) break;
      fitted.push({ ...candidate, item });
      groupBudget -= itemBytes(item);
    }
    if (fitted.length !== group.length) continue;
    kept.push(...fitted);
    remaining = groupBudget;
  }
  const items = kept.sort((left, right) => left.sourceIndex - right.sourceIndex).map(({ item }) => item);
  const truncation = items.length < turn.items.length || truncatedFields.size > 0
    ? { original_item_count: turn.items.length, truncated_text_fields: truncatedFields.size }
    : undefined;
  if (truncation) {
    diagnosticLogger?.("coding_turn.truncated", {
      originalItems: truncation.original_item_count,
      keptItems: items.length,
      truncatedTextFields: truncation.truncated_text_fields,
    });
  }
  return {
    ...envelope,
    items,
    ...(truncation ? { truncation } : {}),
  };
}

export function codingEventText(value: unknown): string {
  if (typeof value === "string") return omitBinaryText(value);
  if (value === undefined) return "";
  return stableJson(value);
}

export function codingToolOutputText(value: unknown): string {
  return codingEventText(value);
}

function prepareItem(
  item: ResponseItem,
  onTruncated: (fieldIndex: number) => void,
): ResponseItem | undefined {
  const id = item.id && boundedEventIdentifier(item.id, 512);
  const identity = id ? { id } : {};
  if (item.type === "message") {
    const texts = item.content.flatMap((part, fieldIndex) => {
      if (part.type !== (item.role === "user" ? "input_text" : "output_text")) return [];
      return [redactSourceText(part.text, () => onTruncated(fieldIndex))];
    });
    // Archive messages require text blocks, not QA content eligibility.
    if (texts.length === 0) return undefined;
    if (item.role === "user") return { type: "message", ...identity, role: "user", content: texts.map((text) => ({ type: "input_text", text })) };
    if (item.role !== "assistant" || (item.phase !== "commentary" && item.phase !== "final_answer")) return undefined;
    return { type: "message", ...identity, role: "assistant", phase: item.phase, content: texts.map((text) => ({ type: "output_text", text })) };
  }
  if (isSearchToolItem(item)) {
    const status = item.status && boundedEventIdentifier(item.status, 32);
    const metadata = { ...identity, ...(status ? { status } : {}) };
    if (item.type === "web_search_call") {
      const action = redactToolJson(item.action, onTruncated) as ResponseJsonObject;
      return toolJsonStringsFit(action) ? { type: item.type, ...metadata, action } : undefined;
    }
    const execution = item.execution;
    if (execution !== undefined && execution !== "server" && execution !== "client") return undefined;
    const callId = typeof item.call_id === "string" ? boundedEventIdentifier(item.call_id, 512) : undefined;
    if ((execution === "client" || typeof item.call_id === "string") && !callId) return undefined;
    const searchIdentity = {
      ...metadata,
      ...(execution ? { execution } : {}),
      ...(callId ? { call_id: callId } : item.call_id === null ? { call_id: null } : {}),
    };
    const value = redactToolJson(item.type === "tool_search_call" ? item.arguments : item.tools, onTruncated);
    if (!toolJsonStringsFit(value)) return undefined;
    return item.type === "tool_search_call"
      ? { type: item.type, ...searchIdentity, arguments: value }
      : { type: item.type, ...searchIdentity, tools: value as readonly ResponseJsonObject[] };
  }
  if (!["function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output"].includes(item.type)) return undefined;
  const callId = boundedEventIdentifier(item.call_id, 512);
  if (!callId) return undefined;
  if (item.type === "function_call" || item.type === "custom_tool_call") {
    const name = boundedEventIdentifier(item.name, 255);
    if (!name) return undefined;
    if (item.type === "custom_tool_call") {
      const input = redactToolText(item.input, () => onTruncated(0));
      return input === undefined ? undefined : { type: item.type, ...identity, call_id: callId, name, input };
    }
    const namespace = item.namespace && boundedEventIdentifier(item.namespace, 255);
    const argumentsText = redactToolText(item.arguments, () => onTruncated(0));
    return argumentsText === undefined ? undefined
      : { type: item.type, ...identity, call_id: callId, name, arguments: argumentsText, ...(namespace ? { namespace } : {}) };
  }
  const output = redactToolText(item.output, () => onTruncated(0));
  return output === undefined ? undefined : { type: item.type, ...identity, call_id: callId, output };
}

function isSearchToolItem(item: ResponseItem): item is Extract<ResponseItem, { type: "web_search_call" | "tool_search_call" | "tool_search_output" }> {
  return item.type === "web_search_call" || item.type === "tool_search_call" || item.type === "tool_search_output";
}

function redactToolText(value: string, onTruncated: () => void): string | undefined {
  const redacted = redactJsonText(value, onTruncated);
  if (redacted.length <= CODING_TURN_TEXT_MAX_CHARS) return redacted;
  onTruncated();
  return undefined;
}

function redactJsonText(value: string, onTruncated: () => void): string {
  let parsed: ResponseJsonValue;
  try {
    parsed = JSON.parse(value) as ResponseJsonValue;
  } catch {
    // Native non-JSON text stays text; valid JSON is never redacted as punctuation.
    return redactSourceText(value, onTruncated);
  }
  const serialized = JSON.stringify(redactToolJson(parsed, onTruncated));
  // Discarded duplicate values and numeric parsing must not bypass raw redaction.
  return value.length <= CODING_TURN_TEXT_MAX_CHARS && JSON.stringify(parsed) === serialized
    && redactSourceText(value, () => {}) === value ? value : serialized;
}

function redactToolJson(value: ResponseJsonValue, onTruncated: (fieldIndex: number) => void): ResponseJsonValue {
  let fieldIndex = 0;
  const text = (value: string, structured = false): string => {
    const index = fieldIndex++;
    const redacted = structured ? redactJsonText(value, () => onTruncated(index))
      : redactSourceText(value, () => onTruncated(index));
    if (redacted.length > CODING_TURN_TEXT_MAX_CHARS) onTruncated(index);
    return redacted;
  };
  const visit = (item: ResponseJsonValue, key?: string): ResponseJsonValue => {
    if (key && typeof item === "string" && /^(?:(?:proxy-)?authorization|(?:set-)?cookie)$/iu.test(key)) {
      const prefix = `${key}: `;
      return text(redactMemoryPayloadText(prefix + item).text.slice(prefix.length));
    }
    if (key && !Array.isArray(item)) {
      // Apply the existing key-sensitive rule without replacing JSON punctuation.
      const prefix = `${JSON.stringify(key)}:`;
      const redactedPrefix = redactMemoryPayloadText(prefix).text;
      if (redactMemoryPayloadText(prefix + JSON.stringify(item)).text.startsWith(`${redactedPrefix}[REDACTED:CREDENTIAL]`)) {
        return "[REDACTED:CREDENTIAL]";
      }
    }
    if (typeof item === "string") return text(item, true);
    if (typeof item === "number") {
      // Parsing large integer literals can turn their digits into exponent notation.
      if (!Number.isFinite(item) || (Number.isInteger(item) && Math.abs(item) >= 1e21)) return "[REDACTED:LONG_NUMBER]";
      const redacted = redactMemoryPayloadText(String(item));
      return redacted.redacted ? redacted.text : item;
    }
    if (Array.isArray(item)) return item.map((part) => visit(part, key));
    if (item === null || typeof item !== "object") return item;
    if (isSerializedBuffer(item)) return BINARY_CONTENT_OMITTED;
    const object = item as ResponseJsonObject;
    return Object.fromEntries(Object.entries(object).map(([key, part]) => [
      text(key), isBinaryPayloadField(object, key)
        ? BINARY_CONTENT_OMITTED : visit(part, key),
    ]));
  };
  return visit(value);
}

function toolJsonStringsFit(value: ResponseJsonValue): boolean {
  if (typeof value === "string") return value.length <= CODING_TURN_TEXT_MAX_CHARS;
  if (Array.isArray(value)) return value.every(toolJsonStringsFit);
  return value === null || typeof value !== "object" || Object.values(value).every(toolJsonStringsFit);
}

function redactSourceText(value: string, onTruncated: () => void): string {
  const withoutHome = redactHomePath(omitBinaryText(value));
  const text = redactMemoryPayloadText(withoutHome).text;
  const bounded = truncateText(text);
  if (bounded.length < text.length) onTruncated();
  return bounded;
}

function omitBinaryText(value: string): string {
  if (isBinaryDataUri(value.trim())) return BINARY_CONTENT_OMITTED;
  try {
    let omitted = false;
    const sanitized = sortJsonValue(JSON.parse(value), () => { omitted = true; });
    // Native tool strings retain whitespace and key order unless binary data is removed.
    return omitted ? JSON.stringify(sanitized) : value;
  } catch {
    return value;
  }
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function itemBytes(item: ResponseItem): number {
  return jsonBytes(item) + 1;
}

function fitItem(
  item: ResponseItem,
  budget: number,
  onTruncated: (fieldIndex: number) => void,
): ResponseItem | undefined {
  if (itemBytes(item) <= budget) return item;
  // Keep structured tool records valid; omit an oversized record atomically.
  if (isSearchToolItem(item) || item.type === "function_call") return undefined;
  if (item.type === "message") {
    let remaining = budget - itemBytes({ ...item, content: [] });
    const content = item.content.flatMap((part, fieldIndex) => {
      const textBudget = remaining - jsonBytes({ type: part.type, text: "" }) - 1;
      if (textBudget < 0) {
        onTruncated(fieldIndex);
        return [];
      }
      const text = fitText(part.text, textBudget);
      if (text.length < part.text.length) onTruncated(fieldIndex);
      const kept = { type: part.type, text };
      remaining -= jsonBytes(kept) + 1;
      return [kept];
    });
    if (content.length === 0) return undefined;
    return { ...item, content } as ResponseItem;
  }
  const text = "input" in item ? item.input : item.output;
  // JSON tool text must remain parseable even when the remaining byte budget is small.
  try {
    JSON.parse(text);
    return undefined;
  } catch { /* Non-JSON tool text can be shortened. */ }
  const textBudget = budget - itemBytes(item) + jsonBytes(text) - 2;
  if (textBudget < 0) return undefined;
  const bounded = fitText(text, textBudget);
  onTruncated(0);
  return "input" in item ? { ...item, input: bounded } : { ...item, output: bounded };
}

function fitText(text: string, textBudget: number): string {
  // Count JSON string bytes once, including escaping and surrogate pairs.
  let used = 0;
  let end = 0;
  for (const character of text) {
    const point = character.codePointAt(0)!;
    const cost = point < 0x20
      ? ([8, 9, 10, 12, 13].includes(point) ? 2 : 6)
      : point === 0x22 || point === 0x5c ? 2
        : point >= 0xd800 && point <= 0xdfff ? 6
          : Buffer.byteLength(character, "utf8");
    if (used + cost > textBudget) break;
    used += cost;
    end += character.length;
  }
  return text.slice(0, end);
}

function redactHomePath(value: string): string {
  const homes = new Set([
    homedir(),
    process.env.USERPROFILE,
    process.env.HOME,
  ].map((item) => item?.trim()).filter((item): item is string => Boolean(item)));
  let redacted = value;
  for (const home of homes) {
    redacted = redacted.replaceAll(home, "[REDACTED:LOCAL_PATH]");
    redacted = redacted.replaceAll(home.replaceAll("\\", "/"), "[REDACTED:LOCAL_PATH]");
  }
  return redacted;
}

function stableJson(value: unknown): string {
  try {
    return JSON.stringify(sortJsonValue(value));
  } catch {
    return String(value ?? "");
  }
}

function sortJsonValue(value: unknown, onBinaryOmitted?: () => void): unknown {
  if (Array.isArray(value)) return value.map((item) => sortJsonValue(item, onBinaryOmitted));
  if (typeof value === "string" && isBinaryDataUri(value)) {
    onBinaryOmitted?.();
    return BINARY_CONTENT_OMITTED;
  }
  if (value === null || typeof value !== "object") return value;
  if (isSerializedBuffer(value)) {
    onBinaryOmitted?.();
    return BINARY_CONTENT_OMITTED;
  }
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(record)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => {
        if (isBinaryPayloadField(record, key)) {
          onBinaryOmitted?.();
          return [key, BINARY_CONTENT_OMITTED];
        }
        return [key, sortJsonValue(item, onBinaryOmitted)];
      }),
  );
}

function isBinaryPayloadField(record: Readonly<Record<string, unknown>>, key: string): boolean {
  if (typeof record.type !== "string") return false;
  const type = record.type.toLowerCase();
  const field = key.toLowerCase();
  return type === "base64" && field === "data"
    || ["audio", "image", "video"].includes(type) && ["base64", "blob", "data"].includes(field);
}

function isBinaryDataUri(value: string): boolean {
  return /^data:(?:application\/octet-stream|audio\/|image\/|video\/)[^,]*;base64,/iu.test(value);
}

function isSerializedBuffer(value: object): boolean {
  const record = value as Record<string, unknown>;
  return record.type === "Buffer" && Array.isArray(record.data);
}

function truncateText(value: string): string {
  const truncated = value.slice(0, CODING_TURN_TEXT_MAX_CHARS);
  return /[\uD800-\uDBFF]$/u.test(truncated) ? truncated.slice(0, -1) : truncated;
}

function boundedIdentifier(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? truncateText(normalized).slice(0, 255) : undefined;
}

function boundedEventIdentifier(value: string, maximum: number): string | undefined {
  const normalized = value.trim();
  return normalized && normalized.length <= maximum ? normalized : undefined;
}

function normalizedTimestamp(value: string): string | undefined {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}
