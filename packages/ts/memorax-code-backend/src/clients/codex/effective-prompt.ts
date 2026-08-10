import { isRecord } from "../../shared/record.js";

export function stripCodexPreambleSegments(text: string): string {
  let remaining = text;
  for (;;) {
    const next = stripOneLeadingCodexPreambleSegment(remaining);
    if (next === remaining) {
      return stripCodexSkillSegments(stripCodexAmbientUiSegments(remaining)).trim();
    }
    remaining = next.trimStart();
  }
}

function stripOneLeadingCodexPreambleSegment(text: string): string {
  return stripLeadingEnvironmentContext(text)
    ?? stripLeadingInstructionsBlock(text)
    ?? stripLeadingSessionPreamble(text)
    ?? text;
}

function stripCodexSkillSegments(text: string): string {
  return text.replace(/(^|\n)[^\S\n]*<skill\b[\s\S]*?<\/skill>[^\S\n]*(?=\n|$)/gi, (match, prefix: string) => {
    const block = match.slice(prefix.length).trim();
    return isCodexSkillSegment(block) ? prefix : match;
  });
}

function stripCodexAmbientUiSegments(text: string): string {
  let removedAmbientContext = false;
  const withoutAmbientContext = text.replace(
    /(^|\n)[^\S\n]*<in-app-browser-context\b[\s\S]*?<\/in-app-browser-context>[^\S\n]*(?=\n|$)/gi,
    (_match, prefix: string) => {
      removedAmbientContext = true;
      return prefix;
    },
  );
  if (!removedAmbientContext) return text;
  return withoutAmbientContext
    .replace(
      /(^|\n)[^\S\n]*##\s+My request for Codex:[^\S\n]*(?=\n|$)/gi,
      "$1",
    )
    .replace(/\n[^\S\n]*(?:\n[^\S\n]*){2,}/g, "\n\n");
}

function isCodexSkillSegment(text: string): boolean {
  return /^<skill\b/i.test(text)
    && /<name>[^<\n]+<\/name>/i.test(text)
    && /<path>[\s\S]*?SKILL\.md[\s\S]*?<\/path>/i.test(text);
}

function stripLeadingEnvironmentContext(text: string): string | undefined {
  const match = text.match(/^\s*<environment_context\b[\s\S]*?<\/environment_context>\s*/);
  return match ? text.slice(match[0].length) : undefined;
}

function stripLeadingInstructionsBlock(text: string): string | undefined {
  const match = text.match(/^\s*#\s+(?:AGENTS|CLAUDE)\.md[^\n]*[\s\S]*?<\/INSTRUCTIONS>\s*/i);
  return match ? text.slice(match[0].length) : undefined;
}

function stripLeadingSessionPreamble(text: string): string | undefined {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("You are Claude Code")) return undefined;
  const boundary = trimmed.indexOf("\n\n");
  return boundary >= 0 ? trimmed.slice(boundary + 2) : "";
}
