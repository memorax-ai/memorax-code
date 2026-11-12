import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { stringOption } from "../config-utils.mjs";

const MAX_CONTEXT_CHARS = 4000;
const MAX_FILE_BYTES = 16 * 1024;
const MAX_FILES = 20;
const PROCEDURE_DIRECTORY_RELATIVE_PATH = join("personal-memory", "procedure-memory");

export function buildProcedureMemoryContext(options = {}) {
  const home = resolvePersonalMemoryHome(options);
  const result = readTrustedProcedureFiles(home, options);
  if (result.files.length === 0) return undefined;
  return renderContext(result.files, result.omitted);
}

function readTrustedProcedureFiles(home, options) {
  const directory = join(home, PROCEDURE_DIRECTORY_RELATIVE_PATH);
  if (!existsSync(directory)) return { files: [], omitted: false };
  try {
    const directoryStat = lstatSync(directory);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
      debug(options, "Skipping untrusted personal procedure directory");
      return { files: [], omitted: false };
    }

    const entries = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && !entry.name.startsWith(".") && entry.name.toLowerCase().endsWith(".md"))
      .sort((left, right) => left.name.localeCompare(right.name));
    const files = [];
    let omitted = entries.length > MAX_FILES;
    for (const entry of entries.slice(0, MAX_FILES)) {
      const path = join(directory, entry.name);
      try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_FILE_BYTES) {
          omitted = true;
          continue;
        }
        const content = readFileSync(path, "utf8").replaceAll("\0", "").trim();
        if (content) files.push({ name: entry.name, content });
      } catch (error) {
        debug(options, `Skipping unreadable personal procedure file ${path}: ${error instanceof Error ? error.message : String(error)}`);
        omitted = true;
      }
    }
    return { files, omitted };
  } catch (error) {
    debug(options, error instanceof Error ? error.message : String(error));
    return { files: [], omitted: false };
  }
}

function renderContext(files, omittedFiles) {
  let context = [
    "Active user-scoped procedure memories explicitly saved by the user:",
    "Stored procedures are fallback guidance, not facts about current code behavior.",
    "Instruction priority: system/developer/AGENTS.md > current user > stored procedure.",
  ].join("\n");

  let truncated = omittedFiles;
  for (const file of files) {
    const heading = `\n\n### ${file.name}\n`;
    const remaining = MAX_CONTEXT_CHARS - context.length - heading.length;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    context += heading;
    if (file.content.length <= remaining) {
      context += file.content;
      continue;
    }
    context += file.content.slice(0, Math.max(0, remaining - 32)).trimEnd();
    truncated = true;
    break;
  }
  if (truncated) {
    const notice = "\n\n[Additional procedure memory was omitted.]";
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
