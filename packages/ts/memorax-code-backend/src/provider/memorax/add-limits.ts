export const MEMORAX_DIALOGUE_MAX_MESSAGE_CHARS = 12_000;
export const MEMORAX_AUTO_MAX_TEXT_CHARS = 128_000;

// The Add API counts Unicode code points, as Python's len() does.
export function countAddTextChars(text: string): number {
  let count = 0;
  for (const _ of text) count++;
  return count;
}
