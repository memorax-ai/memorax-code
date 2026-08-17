export const DEFAULT_MEMORY_SKILL_REMINDER_INTERVAL_TURNS = 5;
const DEFAULT_MEMORY_SKILL_INVOCATION = "$memorax-code";

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
