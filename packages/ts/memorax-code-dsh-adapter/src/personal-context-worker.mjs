import { buildRepoProcedureMemoryContext } from "../memorax-code-adapter-common/src/repo-memory/repo-procedure-memory-context.mjs";
import { buildRepoUserProfilePreferencesContext } from "../memorax-code-adapter-common/src/repo-memory/repo-user-profile-context.mjs";

const MAX_INPUT_BYTES = 16 * 1024;
const contextOptions = {
  adapterDir: "dsh",
  debugEnv: "MEMORAX_CODE_DSH_DEBUG",
  sessionKeyPrefix: "dsh",
};

try {
  const input = await readInput();
  const profileContext = input.includeProfile
    ? buildRepoUserProfilePreferencesContext({ cwd: input.cwd }, contextOptions)
    : undefined;
  const procedureContext = input.includeProcedure
    ? buildRepoProcedureMemoryContext({ cwd: input.cwd }, contextOptions)
    : undefined;
  process.stdout.write(`${JSON.stringify({
    ...(profileContext ? { profileContext } : {}),
    ...(procedureContext ? { procedureContext } : {}),
  })}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

async function readInput() {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > MAX_INPUT_BYTES) throw new Error("DSH personal context worker input exceeded its limit");
    chunks.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const cwd = nonEmptyString(value?.cwd);
  const includeProfile = value?.includeProfile === true;
  const includeProcedure = value?.includeProcedure === true;
  if (!cwd || (!includeProfile && !includeProcedure)) {
    throw new Error("DSH personal context worker received invalid input");
  }
  return { cwd, includeProfile, includeProcedure };
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
