const MAX_API_KEY_BYTES = 16 * 1024;

// Both setup processes read the same bounded, single-value stdin contract.
// Never include input or underlying read errors in diagnostics.
export async function readSetupApiKey() {
  if (process.stdin.isTTY === true) {
    throw new Error("--non-interactive requires an API Key piped to stdin followed by EOF");
  }
  const chunks = [];
  let size = 0;
  try {
    // A pipe may deliver the key in delayed chunks; wait for EOF, not a TTY.
    for await (const chunk of process.stdin) {
      size += chunk.length;
      if (size > MAX_API_KEY_BYTES) break;
      chunks.push(chunk);
    }
  } catch {
    throw new Error("unable to read API Key from stdin");
  }
  if (size > MAX_API_KEY_BYTES) throw new Error("API Key input exceeds 16 KiB");
  const apiKey = Buffer.concat(chunks).toString("utf8").trim();
  if (!apiKey || /[\0\r\n]/.test(apiKey)) {
    throw new Error("stdin must contain one non-empty API Key");
  }
  const override = process.env.MEMORAX_CODE_MEMORAX_API_KEY?.trim();
  if (override && override !== apiKey) {
    throw new Error("MEMORAX_CODE_MEMORAX_API_KEY conflicts with the supplied API Key");
  }
  return apiKey;
}
