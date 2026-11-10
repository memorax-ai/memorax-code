#!/usr/bin/env node
import { runDeepAgentsHookComponent } from "./hook-launcher.mjs";

await runDeepAgentsHookComponent(process.argv[2]);
