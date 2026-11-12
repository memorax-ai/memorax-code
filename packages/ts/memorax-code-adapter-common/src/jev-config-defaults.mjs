export const DEFAULT_JEV_CONFIG_TEXT = [
  "# Optional Jev connection. Enabling allows bounded task context to be sent to TypeSafe.",
  "[jev]",
  "enabled = false # A configured API key does not enable Jev by itself.",
  'api_key = "" # TypeSafe API key; never include it in shared diagnostics.',
  "",
].join("\n");

export function appendMissingJevConfig(text, parsed) {
  // Presence is decided by TOML parsing, including inline, dotted, and quoted keys.
  if (Object.hasOwn(parsed, "jev")) return text;
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const separator = text.length === 0 ? "" : text.endsWith("\n") ? newline : newline + newline;
  return text + separator + DEFAULT_JEV_CONFIG_TEXT.replaceAll("\n", newline);
}
