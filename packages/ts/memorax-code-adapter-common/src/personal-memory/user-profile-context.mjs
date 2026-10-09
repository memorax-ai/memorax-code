import { existsSync, lstatSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { stringOption } from "../config-utils.mjs";

const MAX_CONTEXT_CHARS = 4000;
const MAX_PREFERENCES_BYTES = 64 * 1024;
const PREFERENCES_RELATIVE_PATH = join("personal-memory", "user-profile", "preferences.md");
const PREFERENCES_SCHEMA = "user_profile_memory.v0.1";
const PREFERENCES_OWNER = "user-profile-memory";
const ALLOWED_TYPES = new Set(["communication", "workflow", "environment", "profile"]);
const ALLOWED_STATUSES = new Set(["active", "superseded", "deleted"]);

export function buildUserProfilePreferencesContext(options = {}) {
  const home = resolvePersonalMemoryHome(options);
  const preferences = readTrustedPreferences(home, options);
  if (!preferences || preferences.length === 0) return undefined;
  return renderContext(preferences);
}

function readTrustedPreferences(home, options) {
  const path = join(home, PREFERENCES_RELATIVE_PATH);
  if (!existsSync(path)) return undefined;
  try {
    for (const directory of [dirname(path), dirname(dirname(path))]) {
      const directoryStat = lstatSync(directory);
      if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
        debug(options, "Skipping untrusted personal user-profile directory");
        return undefined;
      }
    }
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_PREFERENCES_BYTES) {
      debug(options, "Skipping untrusted personal user-profile file");
      return undefined;
    }
    return parseActivePreferences(readFileSync(path, "utf8"));
  } catch (error) {
    debug(options, error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

function parseActivePreferences(text) {
  if (text.includes("\0")) return undefined;
  const metadata = parseFrontmatter(text);
  if (
    !metadata
    || metadata.schema !== PREFERENCES_SCHEMA
    || metadata.scope !== "user"
    || metadata.owner !== PREFERENCES_OWNER
    || metadata.trust_state !== "user_stated"
  ) {
    return undefined;
  }
  const declaredActive = nonNegativeInteger(metadata.active_count);
  const declaredTotal = nonNegativeInteger(metadata.total_count);
  if (declaredActive === undefined || declaredTotal === undefined) return undefined;

  const matches = [...text.matchAll(/^## Preference (?<id>pref_[^\s]+)\s*$/gm)];
  if (matches.length !== declaredTotal) return undefined;
  const preferences = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const start = match.index + match[0].length;
    const end = matches[index + 1]?.index ?? text.length;
    const block = text.slice(start, end);
    const status = stripTicks(field(block, "Status")).toLowerCase();
    const type = stripTicks(field(block, "Type"));
    if (!ALLOWED_STATUSES.has(status) || !ALLOWED_TYPES.has(type)) return undefined;
    if (
      !stripTicks(field(block, "Confidence"))
      || !stripTicks(field(block, "Created"))
      || !stripTicks(field(block, "Updated"))
    ) {
      return undefined;
    }
    if (status !== "active") continue;
    const description = normalizeField(field(block, "Description"));
    if (!description) return undefined;
    preferences.push({
      description,
      appliesWhen: normalizeField(field(block, "Applies when")),
      doNotApplyWhen: normalizeField(field(block, "Do not apply when")),
    });
  }
  return preferences.length === declaredActive ? preferences : undefined;
}

function parseFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return undefined;
  const metadata = {};
  for (const rawLine of match[1].split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const fieldMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!fieldMatch) return undefined;
    metadata[fieldMatch[1]] = stripYamlScalar(fieldMatch[2]);
  }
  return metadata;
}

function stripYamlScalar(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed[0] === trimmed.at(-1) && ["\"", "'"].includes(trimmed[0])) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function nonNegativeInteger(value) {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replaceAll("_", "");
  if (!/^\d+$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function field(block, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // An empty value must not borrow the following field's line.
  const match = block.match(new RegExp(`^- ${escaped}:[ \\t]*(.*)$`, "m"));
  return match?.[1]?.trim() ?? "";
}

function stripTicks(value) {
  return String(value ?? "").trim().replace(/^`|`$/g, "").trim();
}

function normalizeField(value) {
  const normalized = stripTicks(value).replace(/\s+/g, " ").trim();
  return normalized === "-" ? "" : normalized;
}

function renderContext(preferences) {
  let context = [
    "Active user-scoped preferences explicitly saved by the user:",
    "Stored preferences are fallback guidance, not facts about current code behavior.",
    "Instruction priority: system/developer/AGENTS.md > current user > stored preference.",
    "Apply each preference only when relevant and not overridden by higher-priority instructions.",
  ].join("\n");
  let omitted = false;
  for (const preference of preferences) {
    const entry = [
      `- Description: ${preference.description}`,
      `  Applies when: ${preference.appliesWhen || "-"}`,
      `  Do not apply when: ${preference.doNotApplyWhen || "-"}`,
    ].join("\n");
    if (`${context}\n\n${entry}`.length > MAX_CONTEXT_CHARS) {
      omitted = true;
      break;
    }
    context += `\n\n${entry}`;
  }
  if (omitted) {
    const notice = "\n\n[Additional user preferences were omitted.]";
    context = `${context.slice(0, MAX_CONTEXT_CHARS - notice.length).trimEnd()}${notice}`;
  }
  return context;
}

function resolvePersonalMemoryHome(options) {
  return stringOption(options?.memoraxCodeHome)
    ?? stringOption(process.env.MEMORAX_CODE_HOME)
    ?? join(homedir(), ".memorax-code");
}

function debug(options, message) {
  if (process.env[options.debugEnv] === "1") console.error(message);
}
