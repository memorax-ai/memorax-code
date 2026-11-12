import { existsSync } from "node:fs";
import { delimiter, resolve } from "node:path";

export function providerFixtureEnv(bin) {
  const env = { ...process.env, PATH: [bin, process.env.PATH ?? ""].join(delimiter) };
  if (process.platform !== "win32") return env;
  // Git for Windows supplies Bash for the existing shell response fixtures.
  // The preload redirects only gh/glab in this fixture directory; Git and Node stay native.
  const bash = (process.env.PATH ?? "").split(delimiter)
    .map((directory) => resolve(directory, "../bin/bash.exe"))
    .find((candidate) => existsSync(candidate));
  if (!bash) throw new Error("Provider fixtures require Git for Windows with Bash on PATH");
  env.MEMORAX_TEST_PROVIDER_BIN = bin;
  env.MEMORAX_TEST_PROVIDER_BASH = bash;
  env.NODE_OPTIONS = [process.env.NODE_OPTIONS, "--import=" + new URL("./provider-cli-preload.mjs", import.meta.url).href]
    .filter(Boolean).join(" ");
  return env;
}
