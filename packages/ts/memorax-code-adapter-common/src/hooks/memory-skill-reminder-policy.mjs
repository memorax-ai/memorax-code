export const DEFAULT_MEMORY_SKILL_REMINDER_INTERVAL_TURNS = 5;

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
