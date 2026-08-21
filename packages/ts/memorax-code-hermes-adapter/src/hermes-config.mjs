import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export const HOOK_EVENTS = Object.freeze(["pre_llm_call", "on_session_end"]);

export function readConfigText(path) {
  if (!existsSync(path)) return { missing: true };
  try {
    return { text: readFileSync(path, "utf8") };
  } catch {
    return { unreadable: true };
  }
}

export function writeConfigText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Best-effort cleanup of a failed temporary write.
    }
    throw error;
  }
}

export function configContainsCommand(text, command) {
  return Boolean(findCommandEntryLines(text, command).length > 0);
}

/**
 * Install the adapter hook entries into the config.yaml ``hooks:`` section.
 * The operation is a conservative line-level edit: user entries are left
 * untouched, and the adapter entries are only added for the standard
 * 2-space-indented Hermes hooks layout. Any other layout fails with an
 * explicit reason instead of rewriting the user's file.
 */
export function installHookEntries(text, command) {
  const lines = splitLines(text);
  const section = findHooksSection(lines);
  if (section === undefined) {
    const hookBlock = `hooks:\n  pre_llm_call:\n    - command: ${singleQuote(command)}\n  on_session_end:\n    - command: ${singleQuote(command)}\n`;
    const trimmedEnd = trailingNonEmptyEnd(lines);
    const body = joinLines(lines.slice(0, trimmedEnd));
    return {
      changed: true,
      text: body ? `${body}\n${hookBlock}` : hookBlock,
    };
  }

  let changed = false;
  const out = [...lines];
  const eventIndex = new Map();
  for (let index = section.start + 1; index < section.end; index += 1) {
    const event = eventKeyLine(out[index]);
    if (event) eventIndex.set(event, index);
  }
  for (const event of HOOK_EVENTS) {
    if (entryLinesForEvent(out, section, event).some((index) => entryCommand(out[index]) === command)) {
      continue;
    }
    const keyIndex = eventIndex.get(event);
    if (keyIndex === undefined) {
      const nonstandardKey = looseEventKeyLine(out, section, event);
      if (nonstandardKey) return hooksFormatFailure();
    }
    if (keyIndex !== undefined) {
      const blockEnd = eventBlockEnd(out, section, keyIndex);
      if (blockEnd.unsupported) return hooksFormatFailure();
      out.splice(blockEnd.end, 0, `    - command: ${singleQuote(command)}`);
      changed = true;
      section.end += 1;
      bumpEventIndices(eventIndex, blockEnd.end);
      continue;
    }
    const insertAt = sectionEndIn(out, section);
    out.splice(insertAt, 0, `  ${event}:`, `    - command: ${singleQuote(command)}`);
    changed = true;
    section.end += 2;
  }
  return changed ? { changed, text: joinLines(out) } : { changed: false, text };
}

export function removeHookEntries(text, command) {
  const lines = splitLines(text);
  const section = findHooksSection(lines);
  if (section === undefined) return { changed: false, text };

  const out = [...lines];
  const removedEntryLines = new Set();
  let changed = false;
  for (const event of HOOK_EVENTS) {
    const entryLines = entryLinesForEvent(out, section, event);
    for (const index of entryLines) {
      if (entryCommand(out[index]) !== command) continue;
      const blockEnd = entryBlockEnd(out, section, index);
      if (blockEnd.unsupported) continue;
      for (let remove = index; remove < blockEnd.end; remove += 1) {
        removedEntryLines.add(remove);
      }
      changed = true;
    }
  }
  if (!changed) return { changed: false, text };

  const compacted = [];
  for (let index = section.start; index < section.end; index += 1) {
    if (removedEntryLines.has(index)) continue;
    const event = eventKeyLine(out[index]);
    if (event && entryLinesForEvent(out, section, event).every((entry) => removedEntryLines.has(entry))) {
      continue;
    }
    compacted.push(out[index]);
  }

  const retained = compacted.some((line) => line.trim());
  if (!retained) {
    return {
      changed: true,
      text: joinLines([...lines.slice(0, section.start), ...lines.slice(section.end)]),
    };
  }
  return {
    changed: true,
    text: joinLines([...lines.slice(0, section.start), ...compacted, ...lines.slice(section.end)]),
  };
}

export function readAllowlistApprovals(path) {
  if (!existsSync(path)) return [];
  try {
    const value = JSON.parse(readFileSync(path, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const approvals = value.approvals;
    return Array.isArray(approvals) ? approvals : [];
  } catch {
    return [];
  }
}

export function allowlistContains(approvals, event, command) {
  return approvals.some((entry) => (
    entry !== null
    && typeof entry === "object"
    && entry.event === event
    && entry.command === command
  ));
}

export function listEntryCommands(text) {
  const lines = splitLines(text);
  const section = findHooksSection(lines);
  if (section === undefined) return [];
  const seen = new Set();
  for (const event of HOOK_EVENTS) {
    for (const index of entryLinesForEvent(lines, section, event)) {
      const command = entryCommand(lines[index]);
      if (command !== undefined) seen.add(command);
    }
  }
  return [...seen];
}

export function writeAllowlistApprovals(path, approvals) {
  mkdirSync(dirname(path), { recursive: true });
  const value = JSON.stringify({ approvals }, null, 2);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, `${value}\n`);
    renameSync(tmp, path);
  } catch (error) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Best-effort cleanup of a failed temporary write.
    }
    throw error;
  }
}

function findHooksSection(lines) {
  for (let index = 0; index < lines.length; index += 1) {
    if (!topLevelKeyLine(lines[index])) continue;
    if (!lines[index].trimStart().startsWith("hooks:")) continue;
    let end = index + 1;
    while (end < lines.length && !topLevelKeyLine(lines[end])) end += 1;
    return { start: index, end };
  }
  return undefined;
}

function findCommandEntryLines(text, command) {
  const lines = splitLines(text);
  const section = findHooksSection(lines);
  if (section === undefined) return [];
  const matches = [];
  for (const event of HOOK_EVENTS) {
    for (const index of entryLinesForEvent(lines, section, event)) {
      if (entryCommand(lines[index]) === command) matches.push(index);
    }
  }
  return matches;
}

function entryLinesForEvent(lines, section, event) {
  const entries = [];
  let inEvent = false;
  for (let index = section.start + 1; index < section.end; index += 1) {
    const line = lines[index];
    if (indentOf(line) === 2 && eventKeyLine(line)) {
      inEvent = eventKeyLine(line) === event;
      continue;
    }
    if (indentOf(line) <= 2 && line.trim()) {
      inEvent = false;
      continue;
    }
    if (inEvent && entryLine(line)) entries.push(index);
  }
  return entries;
}

function eventBlockEnd(lines, section, keyIndex) {
  let end = keyIndex + 1;
  while (end < section.end) {
    const line = lines[end];
    if (indentOf(line) < 2) break;
    if (indentOf(line) === 2 && eventKeyLine(line) && end !== keyIndex) break;
    if (indentOf(line) === 2 && !eventKeyLine(line) && line.trim()) return { unsupported: true };
    if (indentOf(line) === 1 || indentOf(line) === 3) return { unsupported: true };
    end += 1;
  }
  return { end };
}

function entryBlockEnd(lines, section, entryIndex) {
  let end = entryIndex + 1;
  while (end < section.end && indentOf(lines[end]) > 4) {
    if (indentOf(lines[end]) === 5 || indentOf(lines[end]) > 6) return { unsupported: true };
    end += 1;
  }
  return { end };
}

function sectionEndIn(lines, section) {
  let end = section.end;
  while (end > section.start + 1 && lines[end - 1].trim() === "") end -= 1;
  return end;
}

function bumpEventIndices(eventIndex, from) {
  for (const [event, index] of eventIndex) {
    if (index >= from) eventIndex.set(event, index + 1);
  }
}

function entryLine(line) {
  return /^    - [A-Za-z0-9_]+:/.test(line);
}

function entryCommand(line) {
  const match = /^    - command:\s*(\S.*)$/.exec(line);
  if (!match) return undefined;
  return unquoteYamlScalar(match[1]);
}

function eventKeyLine(line) {
  if (indentOf(line) !== 2) return undefined;
  const match = /^  ([A-Za-z0-9_][A-Za-z0-9_-]*):\s*(#.*)?$/.exec(line);
  return match ? match[1] : undefined;
}

function looseEventKeyLine(lines, section, event) {
  const prefix = `  ${event}:`;
  for (let index = section.start + 1; index < section.end; index += 1) {
    if (lines[index].startsWith(prefix)) return index;
  }
  return undefined;
}

function topLevelKeyLine(line) {
  return /^[A-Za-z0-9_][A-Za-z0-9_-]*:\s*(#.*)?$/.test(line);
}

function indentOf(line) {
  return /^ */.exec(line)?.[0].length ?? 0;
}

function unquoteYamlScalar(value) {
  const single = /^'((?:''|[^'])*)'\s*(#.*)?$/.exec(value);
  if (single) return single[1].replace(/''/g, "'");
  const double = /^"((?:[^"\\]|\\.)*)"\s*(#.*)?$/.exec(value);
  if (double) {
    return double[1]
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\")
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t");
  }
  return value.trim();
}

export function singleQuote(value) {
  return `'${value.replace(/'/g, "''")}'`;
}

function splitLines(text) {
  return text.split("\n");
}

function joinLines(lines) {
  return lines.join("\n");
}

function trailingNonEmptyEnd(lines) {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end -= 1;
  return end;
}

function hooksFormatFailure() {
  return {
    changed: false,
    error: "hermes_hooks_unexpected_format",
  };
}
