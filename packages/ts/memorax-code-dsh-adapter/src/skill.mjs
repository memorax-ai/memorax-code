import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFINITION_VERSION = 1;
const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Register the package-local materialization of the canonical memorax-code skill. */
export function registerBundledMemoraxSkill(ctx, options = {}) {
  if (typeof ctx?.skills?.register !== "function") {
    throw new TypeError("memorax-code DSH plugin requires skills");
  }
  const root = resolve(options.pluginRoot ?? pluginRoot);
  const definition = options.definition ?? readDefinition(root);
  assertDefinition(definition);
  return ctx.skills.register({
    name: definition.name,
    description: definition.description,
    ...(definition.whenToUse === undefined ? {} : { whenToUse: definition.whenToUse }),
    invocation: { ...definition.invocation },
    source: definition.source,
    content: definition.content,
    resourceBase: {
      kind: "directory",
      path: join(root, "skills", "memorax-code"),
    },
  });
}

function readDefinition(root) {
  const path = join(root, "skills", "memorax-code", "dsh-definition.json");
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("memorax-code DSH skill definition is unavailable");
  }
}

function assertDefinition(value) {
  if (value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || value.version !== DEFINITION_VERSION
    || value.name !== "memorax-code"
    || !nonEmptyString(value.description)
    || value.source !== "bundled"
    || value.invocation?.modelInvocable !== true
    || value.invocation?.userInvocable !== true
    || !nonEmptyString(value.content)
    || (value.whenToUse !== undefined && !nonEmptyString(value.whenToUse))) {
    throw new Error("memorax-code DSH skill definition is invalid");
  }
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
