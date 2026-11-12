import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function nativeVarint(value) {
  let rest = BigInt(value);
  const bytes = [];
  do {
    const byte = Number(rest & 127n);
    rest >>= 7n;
    bytes.push(rest ? byte | 128 : byte);
  } while (rest);
  return Buffer.from(bytes);
}

export function nativeField(number, value) {
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return Buffer.concat([nativeVarint(number * 8), nativeVarint(Number(value))]);
  }
  const bytes = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
  return Buffer.concat([nativeVarint(number * 8 + 2), nativeVarint(bytes.length), bytes]);
}

export const nativeMessage = (...fields) => Buffer.concat(fields.flat());

export function nativeCompactionFields({ rootMessageRefs = [], archiveRefs = [] } = {}) {
  return [
    ...rootMessageRefs.map((ref) => nativeField(1, ref)),
    ...archiveRefs.map((ref) => nativeField(13, ref)),
  ];
}

// Synthetic native records only. No installed Cursor state or credentials are read.
export async function databaseFixture(options = {}) {
  const ownedDirectory = options.databasePath ? undefined : await mkdtemp(join(tmpdir(), "memorax-cursor-database-test-"));
  const databasePath = options.databasePath ?? join(ownedDirectory, "state.vscdb");
  const directory = dirname(databasePath);
  await mkdir(directory, { recursive: true });
  const sessionId = options.sessionId ?? randomUUID();
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB)");
  const setRow = (key, value) => database.prepare("INSERT OR REPLACE INTO cursorDiskKV(key,value) VALUES(?,?)").run(key, value);
  const blob = (bytes, { storage = "hex", ref } = {}) => {
    const id = ref ?? createHash("sha256").update(bytes).digest();
    setRow(`agentKv:blob:${id.toString("hex")}`, storage === "hex" ? bytes.toString("hex") : bytes);
    return id;
  };
  const user = ({ text = "Synthetic question", messageId = randomUUID(), simulated = false, steer = false, extra = [] } = {}) => blob(nativeMessage(
    nativeField(1, text), nativeField(2, messageId),
    ...(simulated ? [nativeField(5, true)] : []), ...(steer ? [nativeField(24, true)] : []), extra,
  ));
  const step = ({ type = "assistantMessage", text = "Synthetic answer", extra = [] } = {}) => {
    const kind = { assistantMessage: 1, toolCall: 2, thinkingMessage: 3 }[type] ?? 9;
    return blob(nativeField(kind, nativeMessage(nativeField(1, text), extra)));
  };
  const turn = ({ requestId = randomUUID(), userRef = user(), stepRefs = [step()], extra = [] } = {}) => blob(nativeField(1, nativeMessage(
    nativeField(1, userRef), stepRefs.map((ref) => nativeField(2, ref)), nativeField(3, requestId), extra,
  )));
  const summaryArchive = ({ summarizedMessageRefs = [], summaryMessageRef, summary = "Synthetic summary text", extra = [], ref } = {}) => blob(nativeMessage(
    summarizedMessageRefs.map((ref) => nativeField(1, ref)), nativeField(2, summary),
    ...(summaryMessageRef === undefined ? [] : [nativeField(4, summaryMessageRef)]), extra,
  ), { ref });
  const writeComposer = (composer) => setRow(`composerData:${sessionId}`, JSON.stringify(composer));
  const write = ({ latestGenerationId, turns = [], stateExtra = [], encoding = "base64" } = {}) => {
    const turnRefs = [], userRefs = [], stepRefs = [];
    for (const item of turns) {
      if (Buffer.isBuffer(item)) { turnRefs.push(item); continue; }
      const userRef = item.userRef ?? user({ text: item.userPrompt ?? item.prompt, messageId: item.userMessageId, ...item.user });
      const steps = item.stepRefs ?? (item.steps ?? [{}]).map(step);
      userRefs.push(userRef); stepRefs.push(steps);
      turnRefs.push(turn({ requestId: item.requestId, userRef, stepRefs: steps, extra: item.extra }));
    }
    const state = nativeMessage(turnRefs.map((ref) => nativeField(8, ref)), stateExtra);
    writeComposer({ composerId: sessionId,
      ...(latestGenerationId === undefined ? {} : { latestChatGenerationUUID: latestGenerationId }),
      conversationState: encoding === "base64" ? `~${state.toString("base64")}` : state.toString("hex"),
    });
    return { turnRefs, userRefs, stepRefs, state };
  };
  const writeCompaction = ({ rootMessageIds = [], archives = [], stateExtra = [], ...options } = {}) => {
    const archiveRefs = archives.map((archive) => typeof archive === "string" ? Buffer.from(archive, "hex") : summaryArchive({
      summaryMessageRef: Buffer.from(archive.summaryMessageId, "hex"),
      summarizedMessageRefs: archive.summarizedMessageIds.map((id) => Buffer.from(id, "hex")),
      ...(archive.id === undefined ? {} : { ref: Buffer.from(archive.id, "hex") }),
    }));
    const native = write({ ...options, stateExtra: [...nativeCompactionFields({
      rootMessageRefs: rootMessageIds.map((id) => Buffer.from(id, "hex")), archiveRefs,
    }), ...stateExtra] });
    return { ...native, rootMessageIds, archiveIds: archiveRefs.map((ref) => ref.toString("hex")) };
  };
  return {
    databasePath, sessionId, directory, database, setRow, blob, user, step, turn, summaryArchive, write, writeCompaction, writeComposer,
    deleteBlob(ref) { database.prepare("DELETE FROM cursorDiskKV WHERE key = ?").run(`agentKv:blob:${ref.toString("hex")}`); },
    async cleanup() { database.close(); if (ownedDirectory) await rm(ownedDirectory, { recursive: true, force: true }); },
  };
}

export async function createDatabaseFixture(databasePath, options = {}) {
  const fixture = await databaseFixture({ databasePath, sessionId: options.sessionId });
  fixture.write(options);
  return fixture;
}
