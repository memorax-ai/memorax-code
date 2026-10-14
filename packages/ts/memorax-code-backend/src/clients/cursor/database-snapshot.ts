import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute } from "node:path";
import { TextDecoder } from "node:util";

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const MAX_ROW_BYTES = 16 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_FIELDS = 200_000;
const MAX_TURNS = 4096;
const MAX_STEPS = 32_768;
const MAX_COMPACTION_MESSAGES = 32_768;
const MAX_ROOT_MESSAGES = 4096;
const MAX_SUMMARY_ARCHIVES = 1024;
const require = createRequire(import.meta.url);

export type CursorDatabaseFailureReason =
  | "database_runtime_unavailable" | "database_path_invalid" | "database_unavailable"
  | "database_replaced" | "database_snapshot_too_large" | "database_session_missing"
  | "database_state_missing" | "database_native_format_invalid" | "database_blob_missing";
export type CursorDatabaseTurnFailureReason =
  | "native_turn_unsupported" | "native_user_unsupported" | "native_user_simulated"
  | "native_user_steer" | "native_user_external_text" | "native_user_empty"
  | "native_step_unsupported";
export type CursorDatabaseStep = Readonly<{
  id: string;
  contentHash: string;
  type: "assistantMessage" | "toolCall" | "thinkingMessage" | "unknown";
  text?: string;
}>;
export type CursorDatabaseTurn = Readonly<{
  id: string;
  type: "agent" | "shell" | "unknown";
  requestId?: string;
  userMessageRef?: string;
  userMessageId?: string;
  userPrompt?: string;
  steps: readonly CursorDatabaseStep[];
  reason?: CursorDatabaseTurnFailureReason;
}>;
export type CursorDatabaseSnapshot = Readonly<{
  stateHash: string;
  latestGenerationId?: string;
  turns: readonly CursorDatabaseTurn[];
}>;
export type CursorDatabaseSnapshotResult =
  | Readonly<{ ok: true; snapshot: CursorDatabaseSnapshot }>
  | CursorDatabaseFailure;
export type CursorCompactionSnapshot = Readonly<{
  databaseIdentity: string;
  rootMessageIds: readonly string[];
  archives: readonly Readonly<{
    id: string;
    summaryMessageId: string;
    summarizedMessageIds: readonly string[];
  }>[];
}>;
export type CursorCompactionSnapshotResult =
  | Readonly<{ ok: true; snapshot: CursorCompactionSnapshot }>
  | CursorDatabaseFailure;

type CursorDatabaseFailure = Readonly<{ ok: false; reason: CursorDatabaseFailureReason; retryable: boolean }>;
type SnapshotInput = { databasePath: string; sessionId: string };

type SqliteDatabase = {
  exec(sql: string): unknown;
  prepare(sql: string): { all(key: string): Record<string, unknown>[]; get(key: string): Record<string, unknown> | undefined };
  close(): void;
};
type Field = { wire: number; value: bigint | Buffer };
type Fields = Map<number, Field[]>;
type Budget = { bytes: number; fields: number; steps: number };

// These field numbers describe Cursor's native agent.v1 messages. Unknown
// content variants remain opaque; UI bubbles and Hook text are not fallbacks.
const USER_FIELDS = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 24, 25, 26]);

// Session classification needs only composer metadata: a newly created child
// may not have persisted conversationState yet. Any child marker, including
// malformed or contradictory metadata, excludes ordinary user authority.
export async function readCursorSessionKind(input: SnapshotInput) {
  return readNativeSnapshot<"root" | "subagent">(input, () => "root", (composer) => (
    Object.hasOwn(composer, "subagentInfo") ? "subagent" : "root"
  ));
}

export async function readCursorDatabaseSnapshot(input: SnapshotInput): Promise<CursorDatabaseSnapshotResult> {
  return readNativeSnapshot(input, ({ composer, stateBytes, state, blob, budget }) => {
    const latestGenerationId = composer.latestChatGenerationUUID;
    if (latestGenerationId !== undefined && (typeof latestGenerationId !== "string" || !UUID.test(latestGenerationId))) fail("database_native_format_invalid");
    // Only the native active branch's explicit turn refs are content. Other
    // state fields, including summary archives and additive metadata, are not.
    const refs = repeatedBytes(state, 8);
    if (refs.length > MAX_TURNS) fail("database_snapshot_too_large");
    return {
      stateHash: hash(stateBytes),
      ...(latestGenerationId === undefined ? {} : { latestGenerationId }),
      turns: refs.map((ref) => {
        const turn = decodeTurn(ref, blob, budget);
        if (!Object.hasOwn(composer, "subagentInfo")) return turn;
        // Child metadata may become visible after an early Hook registered.
        // It also excludes apparently ordinary user records from writeback.
        const { userPrompt: _prompt, ...excluded } = turn;
        return { ...excluded, reason: "native_user_unsupported" as const };
      }),
    };
  });
}

export async function readCursorCompactionSnapshot(input: SnapshotInput): Promise<CursorCompactionSnapshotResult> {
  return readNativeSnapshot(input, ({ databaseIdentity, state, blob, budget }) => {
    // ConversationStateStructure fields 1 and 13 reference prompt messages and
    // ConversationSummaryArchive blobs. Archive field 2 is summary text and is
    // deliberately ignored; message blobs are never loaded by this projection.
    const rootMessageIds = uniqueReferences(repeatedBytes(state, 1), MAX_ROOT_MESSAGES);
    const archiveRefs = repeatedBytes(state, 13);
    const archiveIds = uniqueReferences(archiveRefs, MAX_SUMMARY_ARCHIVES);
    const summaryIds = new Set<string>();
    let messageCount = 0;
    const archives = archiveRefs.map((ref, index) => {
      const archive = wire(blob(ref), budget);
      const summaryMessageId = reference(requiredBytes(archive, 4));
      const summarizedMessageIds = uniqueReferences(repeatedBytes(archive, 1), MAX_COMPACTION_MESSAGES);
      if ((messageCount += summarizedMessageIds.length) > MAX_COMPACTION_MESSAGES) fail("database_snapshot_too_large");
      if (summaryIds.has(summaryMessageId) || summarizedMessageIds.length === 0
        || summarizedMessageIds.includes(summaryMessageId)) fail("database_native_format_invalid");
      summaryIds.add(summaryMessageId);
      return { id: archiveIds[index], summaryMessageId, summarizedMessageIds };
    });
    return { databaseIdentity, rootMessageIds, archives };
  });
}

async function readNativeSnapshot<Snapshot>(input: SnapshotInput, decode: (native: {
  databaseIdentity: string;
  composer: Record<string, unknown>;
  stateBytes: Buffer;
  state: Fields;
  blob: (ref: Buffer) => Buffer;
  budget: Budget;
}) => Snapshot, decodeComposer?: (composer: Record<string, unknown>) => Snapshot): Promise<Readonly<{ ok: true; snapshot: Snapshot }> | CursorDatabaseFailure> {
  if (!isAbsolute(input.databasePath) || /[\0\r\n]/.test(input.databasePath) || !UUID.test(input.sessionId)) {
    return failure("database_path_invalid");
  }
  let DatabaseSync: new (path: string, options: { readOnly: boolean }) => SqliteDatabase;
  try {
    // The rest of MemoraX Code still supports Node 20. Load SQLite only when
    // this reader is used, so older Node versions skip this capability safely.
    ({ DatabaseSync } = require("node:sqlite"));
    if (typeof DatabaseSync !== "function") fail("database_runtime_unavailable");
  } catch { return failure("database_runtime_unavailable"); }
  let db: SqliteDatabase | undefined;
  try {
    const path = realpathSync(input.databasePath);
    const before = statSync(path, { bigint: true });
    if (!before.isFile()) fail("database_path_invalid");
    db = new DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 250; BEGIN");
    const budget: Budget = { bytes: 0, fields: 0, steps: 0 };
    const sizes = db.prepare("SELECT length(CAST(value AS BLOB)) AS bytes FROM cursorDiskKV WHERE key = ? LIMIT 2");
    const values = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?");
    function row(key: string, missing: CursorDatabaseFailureReason): unknown {
      const lengths = sizes.all(key);
      if (!lengths.length) fail(missing);
      if (lengths.length !== 1 || typeof lengths[0].bytes !== "number") fail("database_native_format_invalid");
      const size = lengths[0].bytes;
      if (!Number.isSafeInteger(size) || size < 0) fail("database_native_format_invalid");
      if (size > MAX_ROW_BYTES || (budget.bytes += size) > MAX_SNAPSHOT_BYTES) fail("database_snapshot_too_large");
      return values.get(key)?.value;
    }
    const composerValue = row(`composerData:${input.sessionId}`, "database_session_missing");
    let composer: unknown;
    try { composer = JSON.parse(typeof composerValue === "string" ? composerValue : utf8(binary(composerValue))); }
    catch { fail("database_native_format_invalid"); }
    if (!isRecord(composer)) fail("database_native_format_invalid");
    if (composer.composerId !== undefined && composer.composerId !== input.sessionId) fail("database_native_format_invalid");
    if (decodeComposer) {
      const snapshot = decodeComposer(composer);
      const after = statSync(path, { bigint: true });
      if (after.dev !== before.dev || after.ino !== before.ino || realpathSync(input.databasePath) !== path) fail("database_replaced");
      return { ok: true, snapshot };
    }
    if (composer.conversationState === undefined || composer.conversationState === null) fail("database_state_missing");
    const stateBytes = encodedState(composer.conversationState);
    const state = wire(stateBytes, budget);
    const cache = new Map<string, Buffer>();
    function blob(ref: Buffer): Buffer {
      const id = reference(ref);
      const cached = cache.get(id);
      if (cached) return cached;
      const value = row(`agentKv:blob:${id}`, "database_blob_missing");
      const bytes = typeof value === "string" ? hex(value) : binary(value);
      const content = bytes.length === 1 && bytes[0] === 0 ? Buffer.alloc(0) : bytes;
      cache.set(id, content);
      return content;
    }
    const databaseIdentity = hash(Buffer.from(JSON.stringify([path, String(before.dev), String(before.ino)])));
    const snapshot = decode({ databaseIdentity, composer, stateBytes, state, blob, budget });
    const after = statSync(path, { bigint: true });
    if (after.dev !== before.dev || after.ino !== before.ino || realpathSync(input.databasePath) !== path) fail("database_replaced");
    return { ok: true, snapshot };
  } catch (error) {
    if (error instanceof SnapshotFailure) return failure(error.reason);
    if (isRecord(error) && error.code === "ERR_SQLITE_ERROR"
      && [1, 11, 26].includes(Number(error.errcode))) return failure("database_native_format_invalid");
    return failure("database_unavailable");
  } finally {
    try { db?.close(); } catch { /* A read-only snapshot never publishes state. */ }
  }
}

function decodeTurn(ref: Buffer, blob: (ref: Buffer) => Buffer, budget: Budget): CursorDatabaseTurn {
  const id = reference(ref);
  const outer = wire(blob(ref), budget);
  if (outer.size !== 1 || !outer.has(1)) {
    const shell = outer.size === 1 && outer.has(2);
    for (const field of outer.values()) if (field.length !== 1 || field[0].wire !== 2) fail("database_native_format_invalid");
    return { id, type: shell ? "shell" : "unknown", steps: [], reason: "native_turn_unsupported" };
  }
  const turn = wire(requiredBytes(outer, 1), budget);
  const requestId = optionalIdentity(turn, 3);
  const userRef = requiredBytes(turn, 1);
  const userMessageRef = reference(userRef);
  const user = wire(blob(userRef), budget);
  const userMessageId = optionalIdentity(user, 2);
  const prompt = optionalText(user, 1) ?? "";
  let reason: CursorDatabaseTurnFailureReason | undefined;
  // This structure is not a content oneof. Cursor preserves server extension
  // fields outside its desktop descriptor; only its explicit user/step refs
  // define the content projection. Never interpret those extensions as text.
  if (!requestId) reason = "native_turn_unsupported";
  else if ([...user.keys()].some((number) => !USER_FIELDS.has(number)) || !userMessageId) reason = "native_user_unsupported";
  else if (optionalBoolean(user, 5)) reason = "native_user_simulated";
  else if (optionalBoolean(user, 24)) reason = "native_user_steer";
  else if (user.has(18) || user.has(19)) reason = "native_user_external_text";
  else if (!prompt.trim()) reason = "native_user_empty";
  const stepRefs = repeatedBytes(turn, 2);
  if ((budget.steps += stepRefs.length) > MAX_STEPS) fail("database_snapshot_too_large");
  const steps = stepRefs.map((stepRef): CursorDatabaseStep => {
    const id = reference(stepRef), raw = blob(stepRef), step = wire(raw, budget);
    const base = { id, contentHash: hash(raw) };
    if (step.size !== 1 || ![1, 2, 3].some((number) => step.has(number))) {
      reason ??= "native_step_unsupported";
      return { ...base, type: "unknown" };
    }
    const number = [...step.keys()][0];
    const body = requiredBytes(step, number);
    if (number === 2) return { ...base, type: "toolCall" };
    const message = wire(body, budget);
    const known = number === 1 ? [1, 2, 3] : [1, 2, 3, 4];
    if ([...message.keys()].some((field) => !known.includes(field))) {
      reason ??= "native_step_unsupported";
      return { ...base, type: "unknown" };
    }
    if (number === 3) return { ...base, type: "thinkingMessage" };
    return { ...base, type: "assistantMessage", text: optionalText(message, 1) ?? "" };
  });
  return {
    id, type: "agent", ...(requestId ? { requestId } : {}), userMessageRef,
    ...(userMessageId ? { userMessageId } : {}), steps,
    ...(reason ? { reason } : { userPrompt: prompt }),
  };
}

function wire(data: Buffer, budget: Budget): Fields {
  const fields: Fields = new Map();
  let offset = 0;
  function varint(): bigint {
    let value = 0n;
    for (let index = 0; index < 10; index++) {
      if (offset >= data.length) fail("database_native_format_invalid");
      const byte = data[offset++];
      if (index === 9 && byte > 1) fail("database_native_format_invalid");
      value |= BigInt(byte & 127) << BigInt(index * 7);
      if (!(byte & 128)) return value;
    }
    return fail("database_native_format_invalid");
  }
  while (offset < data.length) {
    if (++budget.fields > MAX_FIELDS) fail("database_snapshot_too_large");
    const tag = varint();
    if (tag > 0xffff_ffffn) fail("database_native_format_invalid");
    const number = Number(tag >> 3n), type = Number(tag & 7n);
    if (number === 0) fail("database_native_format_invalid");
    let value: bigint | Buffer;
    if (type === 0) value = varint();
    else if (type === 1 || type === 2 || type === 5) {
      const size = type === 2 ? Number(varint()) : type === 1 ? 8 : 4;
      if (!Number.isSafeInteger(size) || size < 0 || size > data.length - offset) fail("database_native_format_invalid");
      value = data.subarray(offset, offset + size);
      offset += size;
    } else fail("database_native_format_invalid");
    const list = fields.get(number) ?? [];
    list.push({ wire: type, value }); fields.set(number, list);
  }
  return fields;
}

function repeatedBytes(fields: Fields, number: number): Buffer[] {
  return (fields.get(number) ?? []).map((field) => {
    if (field.wire !== 2 || !Buffer.isBuffer(field.value)) fail("database_native_format_invalid");
    return field.value;
  });
}
function optionalBytes(fields: Fields, number: number): Buffer | undefined {
  const values = repeatedBytes(fields, number);
  if (values.length > 1) fail("database_native_format_invalid");
  return values[0];
}
function requiredBytes(fields: Fields, number: number): Buffer {
  const value = optionalBytes(fields, number);
  if (value === undefined) fail("database_native_format_invalid");
  return value;
}
function optionalText(fields: Fields, number: number): string | undefined {
  const value = optionalBytes(fields, number);
  return value === undefined ? undefined : utf8(value);
}
function optionalIdentity(fields: Fields, number: number): string | undefined {
  const value = optionalText(fields, number);
  return value !== undefined && UUID.test(value) ? value : undefined;
}
function optionalBoolean(fields: Fields, number: number): boolean {
  const values = fields.get(number);
  if (!values) return false;
  if (values.length !== 1 || values[0].wire !== 0 || (values[0].value !== 0n && values[0].value !== 1n)) fail("database_native_format_invalid");
  return values[0].value === 1n;
}
function reference(value: Buffer): string {
  if (value.length < 1 || value.length > 64) fail("database_native_format_invalid");
  return value.toString("hex");
}
function uniqueReferences(values: Buffer[], limit: number): string[] {
  if (values.length > limit) fail("database_snapshot_too_large");
  const ids = values.map(reference);
  if (new Set(ids).size !== ids.length) fail("database_native_format_invalid");
  return ids;
}
function encodedState(value: unknown): Buffer {
  if (typeof value !== "string") return fail("database_native_format_invalid");
  if (!value.startsWith("~")) return hex(value);
  const text = value.slice(1);
  if (!/^(?:[a-zA-Z0-9+/]{4})*(?:[a-zA-Z0-9+/]{2}==|[a-zA-Z0-9+/]{3}=)?$/.test(text)) fail("database_native_format_invalid");
  return Buffer.from(text, "base64");
}
function hex(value: string): Buffer {
  if (!/^(?:[a-f0-9]{2})*$/i.test(value)) fail("database_native_format_invalid");
  return Buffer.from(value, "hex");
}
function binary(value: unknown): Buffer {
  if (!(value instanceof Uint8Array)) return fail("database_native_format_invalid");
  return Buffer.from(value);
}
function utf8(value: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value); }
  catch { return fail("database_native_format_invalid"); }
}
function hash(value: Uint8Array): string { return createHash("sha256").update(value).digest("hex"); }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
class SnapshotFailure extends Error {
  constructor(readonly reason: CursorDatabaseFailureReason) { super(reason); }
}
function fail(reason: CursorDatabaseFailureReason): never { throw new SnapshotFailure(reason); }
function failure(reason: CursorDatabaseFailureReason): CursorDatabaseFailure {
  return { ok: false, reason, retryable: ["database_unavailable", "database_session_missing", "database_state_missing", "database_blob_missing"].includes(reason) };
}
