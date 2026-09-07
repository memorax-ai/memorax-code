export const DEFAULT_MEMORY_SKILL_REMINDER_INTERVAL_TURNS = 5;
const DEFAULT_MEMORY_SKILL_INVOCATION = "$memorax-code";

export const MEMORY_IMPACT_REMINDER_CONTEXT = [
  "Natural final-answer mention for supported coding agents:",
  "Only when an accepted Coding Memory result from a successful explicit `memorax-cli search`, a relevant Repo Memory read, applied Procedure Memory, or applied Profile Memory materially changes localization, a decision, implementation, validation, or the delivered answer, begin the final answer with one brief opening paragraph before the normal result.",
  "A Search or read alone is insufficient; omit it for empty, unrelated, stale, rejected, merely confirmatory, or unused memory.",
  "Treat accepted memory as materially helpful when the answer uses it to recover or substantiate historical intent, rationale, a prior decision, a constraint, or a reusable lesson, even when live code independently confirms the conclusion.",
  "Merely confirmatory means the answer does not rely on the memory for a claim and the memory changes neither its framing, scope, nor confidence.",
  "Put a blank line after this opening paragraph, keep the entire paragraph under 600 characters, and match the answer's language and tone. Prefer one sentence; use a second sentence only when two independent memory points each materially affected the task.",
  "The paragraph must literally include `MemoraX Code` and the generic label `Memory`. Do not name or enumerate the specific source type in the opening paragraph.",
  "Describe only the smallest useful change Memory caused, such as what it helped choose, check, or avoid. For example: `这次我参考了 MemoraX Code 的 Memory，用 PASS/FAIL 矩阵汇报验证结果。`",
  "Use direct task attribution such as `这次我参考了 MemoraX Code 的 Memory...`, `I used MemoraX Code Memory...`, or `Memory from MemoraX Code helped...`.",
  "Do not repeat the task or result, reproduce the memory, or narrate the full execution steps or reasoning.",
  "Do not report a routine language or tone preference.",
  "Do not report active Add, automatic writeback, Repo Memory build or update, or automatic Coding Memory retrieval as memory that helped the current turn.",
  "Do not add a heading, card, label, or colon-led report, and do not open with stock wording such as `MemoraX Code 的 Memory 提示：`, `本轮借助...`, `Memory impact:`, or `The memory said...`.",
  "Use only normal visible prose. Do not include HTML or XML comments, Markdown markers, tags, zero-width text, hidden control text, or metadata.",
].join(" ");

export function memorySkillReminderContext(memorySkillInvocation) {
  const invocation = nonEmptyString(memorySkillInvocation) ?? DEFAULT_MEMORY_SKILL_INVOCATION;
  return `MemoraX Code reminder: proactively invoke ${invocation} whenever coding memory might help, even when uncertain; follow the skill's router to decide whether any memory operation is needed. Also use ${invocation} for repository-scoped personal memory, and classify the authority before reading or writing.`;
}

export function personalMemoryReminderContext(memorySkillInvocation) {
  const invocation = nonEmptyString(memorySkillInvocation) ?? DEFAULT_MEMORY_SKILL_INVOCATION;
  return [
    `MemoraX Code personal-memory reminder: Use ${invocation} when the user states a durable current-repo identity or interaction preference, asks to list or recall stored personal memory, or explicitly asks to save, update, forget, or delete it.`,
    "Route reusable action sequences and work rules to procedure memory; do not store repository facts, one-off task details, or secrets.",
  ].join(" ");
}

export function resolveMemorySkillReminderIntervalTurns(input = {}) {
  return positiveInteger(input.environmentValue)
    ?? parseMemorySkillReminderIntervalTurns(input.configText)
    ?? DEFAULT_MEMORY_SKILL_REMINDER_INTERVAL_TURNS;
}

export function isMemorySkillReminderDue(turnCount, intervalTurns, remindOnFirstTurn = true) {
  if (!Number.isInteger(turnCount) || turnCount <= 0) return false;
  if (!Number.isInteger(intervalTurns) || intervalTurns <= 0) return false;
  if (remindOnFirstTurn) return (turnCount - 1) % intervalTurns === 0;
  return turnCount > intervalTurns && (turnCount - 1) % intervalTurns === 0;
}

export function parseMemorySkillReminderIntervalTurns(text) {
  if (typeof text !== "string") return undefined;
  let section = "";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#", 1)[0].trim();
    if (!line) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    if (section !== "memory.skill_reminder") continue;
    const fieldMatch = line.match(/^interval_turns\s*=\s*(.+)$/);
    if (fieldMatch) return positiveInteger(fieldMatch[1]);
  }
  return undefined;
}

function positiveInteger(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replaceAll("_", "");
  if (!/^[1-9]\d*$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
