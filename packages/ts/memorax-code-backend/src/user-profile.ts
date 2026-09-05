#!/usr/bin/env node
import { runUserProfileCli } from "./personal-memory/cli.js";

const offset = process.argv[2] === "user-profile" ? 3 : 2;
process.exitCode = await runUserProfileCli(process.argv.slice(offset));
