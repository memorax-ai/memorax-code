import { buildProcedureMemoryContext } from "../memorax-code-adapter-common/src/personal-memory/procedure-memory-context.mjs";
import { buildUserProfilePreferencesContext } from "../memorax-code-adapter-common/src/personal-memory/user-profile-context.mjs";

const MAX_INPUT_BYTES = 16 * 1024;
const contextOptions = {
  adapterDir: "dsh",
  debugEnv: "MEMORAX_CODE_DSH_DEBUG",
};

try {
  const input = await readInput();
  const profileContext = input.includeProfile
    ? buildUserProfilePreferencesContext({ ...contextOptions, memoraxCodeHome: input.memoraxCodeHome })
    : undefined;
  const procedureContext = input.includeProcedure
    ? buildProcedureMemoryContext({ ...contextOptions, memoraxCodeHome: input.memoraxCodeHome })
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
  const memoraxCodeHome = nonEmptyString(value?.memoraxCodeHome);
  const includeProfile = value?.includeProfile === true;
  const includeProcedure = value?.includeProcedure === true;
  if (!memoraxCodeHome || (!includeProfile && !includeProcedure)) {
    throw new Error("DSH personal context worker received invalid input");
  }
  return { memoraxCodeHome, includeProfile, includeProcedure };
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
