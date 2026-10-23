import { loadLifecycleMemoraxCodeConfig } from "../config/memorax-code.js";
import type { WritebackMessage } from "./writeback-chunk.js";

export type HelpfulSearch = {
  search_id: string;
  context_turns_k: number;
  release: () => void;
};
export type HelpfulTurn = {
  turnId: string;
  index?: number;
  complete: boolean;
  searches: HelpfulSearch[];
};
export type HelpfulEvaluation = {
  search_id: string;
  client: string;
  session_id: string;
  source_turn_id: string;
  source_turn_index: number;
  context_turns_k: number;
  turns: {
    turn_id: string;
    turn_index: number;
    user_message: string;
    assistant_message: string;
  }[];
};
export function helpfulSettings(home?: string) {
  try {
    const config = loadLifecycleMemoraxCodeConfig(home).helpful;
    return { enabled: config?.enabled ?? true, k: config?.context_turns_k ?? 2 };
  } catch {
    return { enabled: false, k: 2 };
  }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const helpfulBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

/** Counters only. Metadata is owned by the existing turn state or Add buffer. */
export function createHelpfulBudget(maxEntries = 256, maxBytes = 32 * 1024 * 1024) {
  let entries = 0;
  let bytes = 0;
  return {
    reserve(searchId: unknown, k: unknown): HelpfulSearch | undefined {
      if (typeof searchId !== "string" || !uuid.test(searchId)
        || typeof k !== "number" || !Number.isSafeInteger(k) || k < 2) {
        return;
      }
      const size = helpfulBytes({ search_id: searchId, context_turns_k: k });
      if (entries >= maxEntries || bytes + size > maxBytes) {
        return;
      }
      entries++;
      bytes += size;
      let released = false;
      return {
        search_id: searchId,
        context_turns_k: k,
        release() {
          if (released) {
            return;
          }
          released = true;
          entries--;
          bytes -= size;
        },
      };
    },
    size: () => ({ entries, bytes }),
  };
}
export function releaseHelpfulSearches(searches: HelpfulSearch[] | undefined) {
  for (const search of searches?.splice(0) ?? []) {
    search.release();
  }
}

/** Only complete native windows in this batch qualify; never infer adjacency. */
export function buildHelpfulEvaluations(
  client: string,
  sessionId: string,
  buffered: { helpfulTurn?: HelpfulTurn; messages: WritebackMessage[] }[],
  skip: (reason: string) => void = () => {},
  maxBytes = 1024 * 1024,
): HelpfulEvaluation[] {
  // An unnumbered native continuation could sit inside any apparent window.
  // Do not bridge across it by simply ignoring it in the index.
  if (buffered.some(turn => turn.helpfulTurn?.index === undefined
    || !Number.isSafeInteger(turn.helpfulTurn.index) || turn.helpfulTurn.index < 0)) {
    for (const turn of buffered) {
      for (const _search of turn.helpfulTurn?.searches ?? []) {
        skip("unverifiable_order");
      }
    }
    return [];
  }
  const indexed = new Map<number, typeof buffered>();
  for (const turn of buffered) {
    const index = turn.helpfulTurn?.index;
    if (index === undefined || !Number.isSafeInteger(index) || index < 0) {
      continue;
    }
    indexed.set(index, [...(indexed.get(index) ?? []), turn]);
  }
  const result: HelpfulEvaluation[] = [];
  const seen = new Set<string>();
  let bytes = 2;
  const ordered = [...buffered].sort((a, b) =>
    (a.helpfulTurn?.index ?? Infinity) - (b.helpfulTurn?.index ?? Infinity));
  for (const source of ordered) {
    const meta = source.helpfulTurn;
    if (!meta) {
      continue;
    }
    for (const search of meta.searches) {
      if (seen.has(search.search_id)) {
        continue;
      }
      seen.add(search.search_id);
      if (meta.index === undefined || search.context_turns_k >= buffered.length) {
        skip("incomplete_window");
        continue;
      }
      const turns: HelpfulEvaluation["turns"] = [];
      for (let offset = 0; offset <= search.context_turns_k; offset++) {
        const matches = indexed.get(meta.index + offset);
        const turn = matches?.length === 1 ? matches[0] : undefined;
        const user = turn?.messages.find(m => m.role === "user")?.content;
        const assistant = turn?.messages.find(m => m.role === "assistant")?.content;
        if (!turn?.helpfulTurn?.complete || !user || !assistant
          || user.length > 65536 || (offset < search.context_turns_k && assistant.length > 65536)) {
          break;
        }
        turns.push({
          turn_id: turn.helpfulTurn.turnId,
          turn_index: meta.index + offset,
          user_message: user,
          assistant_message: offset === search.context_turns_k ? "" : assistant,
        });
      }
      if (turns.length !== search.context_turns_k + 1
        || new Set(turns.map(t => t.turn_id)).size !== turns.length) {
        skip("incomplete_window");
        continue;
      }
      const item: HelpfulEvaluation = {
        search_id: search.search_id,
        client,
        session_id: sessionId,
        source_turn_id: meta.turnId,
        source_turn_index: meta.index,
        context_turns_k: search.context_turns_k,
        turns,
      };
      const size = helpfulBytes(item) + (result.length ? 1 : 0);
      if (result.length >= 256 || bytes + size > maxBytes) {
        skip("attachment_budget");
        continue;
      }
      result.push(item);
      bytes += size;
    }
  }
  return result;
}
