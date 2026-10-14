#!/usr/bin/env node
import { runNativeMemoryCheck } from "./codebuddy-native-memory-support.mjs";

const report = await runNativeMemoryCheck({ client: "workbuddy", args: process.argv.slice(2) });
console.log(JSON.stringify(report, null, 2));
if (report.status !== "PASS") process.exitCode = 1;
