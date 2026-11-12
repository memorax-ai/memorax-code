import childProcess from "node:child_process";
import { existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";

const bin = process.env.MEMORAX_TEST_PROVIDER_BIN;
const bash = process.env.MEMORAX_TEST_PROVIDER_BASH;
if (process.platform === "win32" && bin && bash) {
  for (const method of ["spawnSync", "execFile"]) {
    const original = childProcess[method];
    childProcess[method] = (command, args, ...rest) => {
      const fixture = ["gh", "glab"].includes(command) ? join(bin, command) : undefined;
      return fixture && existsSync(fixture)
        ? original(bash, [fixture, ...args], ...rest)
        : original(command, args, ...rest);
    };
  }
  syncBuiltinESMExports();
}
