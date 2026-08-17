#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import {
  setTomlField,
  updateConfigFileAtomically,
} from "../lib/memorax-code-adapter-common/src/memorax-code-config-file.mjs";
import {
  MEMORAX_ACCOUNT_URL,
  MEMORAX_DEFAULT_BASE_URL,
  MEMORAX_DEFAULT_MEMORY_OUTPUT_LANGUAGE,
  normalizeMemoraxBaseUrl,
  normalizeMemoraxMemoryOutputLanguage,
} from "../lib/memorax-code-adapter-common/src/memorax-defaults.mjs";
import { stagePackagedClientHookRuntime } from "../lib/client-hook-runtime.mjs";
import { discoverDshProfiles } from "../lib/dsh-plugin-install.mjs";
import { ensureClaudeCommandEnv } from "../lib/resolve-claude-command.mjs";
import { ensureCodexCommandEnv } from "../lib/resolve-codex-command.mjs";
import { commandOnPath } from "../lib/vscode-extension-command.mjs";
import { resolveWindowsCliInvocation } from "../lib/windows-cli-invocation.mjs";

const PLUGIN_NAME = "memorax-code-codex-adapter";
const CLI_MARKETPLACE_NAME = "memorax-code";
const PERSONAL_MARKETPLACE_NAME = "personal";
const PREVIOUS_HOOKS_ENV = "MEMORAX_CODE_CODEX_PREVIOUS_HOOKS_JSON";
const HOOK_TRUST_SELECTION_ENV = "MEMORAX_CODE_CODEX_HOOK_TRUST_SELECTION_JSON";
const PREFIX = "[MemoraX Code Install]:";
const BACKEND_PREFIX = "[MemoraX Code Backend]:";
const GREEN = "\x1b[32m";
const BLUE = "\x1b[34m";
const RED = "\x1b[31m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

if (truthyEnv(process.env.MEMORAX_CODE_SKIP_POSTINSTALL)) process.exit(0);
const skipCodexPluginInstall = truthyEnv(process.env.MEMORAX_CODE_SKIP_CODEX_PLUGIN_INSTALL);
const skipClaudeAdapterInstall = truthyEnv(process.env.MEMORAX_CODE_SKIP_CLAUDE_ADAPTER_INSTALL);
const skipOpenCodeAdapterInstall = truthyEnv(process.env.MEMORAX_CODE_SKIP_OPENCODE_ADAPTER_INSTALL);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const memoraxCodeBin = join(scriptDir, "memorax-code.mjs");
const memoraxCliBin = join(scriptDir, "memorax-cli.mjs");
const verbose = process.env.MEMORAX_CODE_NPM_POSTINSTALL_VERBOSE === "1";
const codexRuntime = ensureCodexCommandEnv();
const codexCommand = codexRuntime.command;
const claudeRuntime = ensureClaudeCommandEnv();
const claudeCommand = claudeRuntime.command;
const updatePostinstall = postinstallUpdateMode();
const scriptedAnswers = (canPrompt() || canPromptForUpdate()) && process.stdin.isTTY !== true
  ? parseScriptedAnswers(readFileSync(0, "utf8"))
  : undefined;
const previousClients = readPersistedClientSelection();
const persistedDshSelection = readPersistedDshSelection();
let dshProfiles = [];
let dshProfilesVerified = true;
try {
  dshProfiles = discoverDshProfiles();
} catch (error) {
  dshProfilesVerified = false;
  const code = typeof error?.code === "string" ? ` (${error.code})` : "";
  logRed(`DeepSeek Harness Profile discovery could not be verified${code}; DSH setup was skipped, but other client setup will continue.`);
}
const dshSelected = dshProfilesVerified
  && dshProfiles.length > 0
  && persistedDshSelection !== false;
if (seedMissingMemoraxCodeConfig() === "failed") {
  printPostinstallSummary("not-verified");
  process.exit(0);
}
let stagedHookRuntime;
try {
  stagedHookRuntime = await stagePackagedClientHookRuntime({
    packageRoot: dirname(scriptDir),
    memoraxCodeHome: memoraxCodeHome(),
  });
  process.env.MEMORAX_CODE_DEFER_CLIENT_HOOK_RUNTIME_ACTIVATION = "1";
} catch (error) {
  logRed(`Client Hook runtime staging failed: ${error instanceof Error ? error.message : String(error)}`);
  logRed("Backend and plugin mutation were skipped; the previously active runtime remains authoritative.");
  printPostinstallSummary("not-verified");
  process.exit(0);
}
runCommonPreflight();
const requestedClients = ["codex", "claude", "opencode"];
const codexPreflight = requestedClients.includes("codex") && !skipCodexPluginInstall
  ? runCodexPreflight({
      integrationSelected: !updatePostinstall
        || previousClients === undefined
        || previousClients.includes("codex"),
    })
  : { ok: true, pluginCache: { marketplaceName: CLI_MARKETPLACE_NAME, versions: [] } };
const claudePreflight = requestedClients.includes("claude") && !skipClaudeAdapterInstall
  ? runClaudePreflight({
      integrationSelected: !updatePostinstall
        || previousClients === undefined
        || previousClients.includes("claude"),
    })
  : { ok: true };
const opencodePreflight = requestedClients.includes("opencode") && !skipOpenCodeAdapterInstall
  ? runOpenCodePreflight({
      integrationSelected: !updatePostinstall
        || previousClients === undefined
        || previousClients.includes("opencode"),
    })
  : { ok: true };
const detectedClients = requestedClients.filter((client) => {
  if (client === "codex") return !skipCodexPluginInstall && codexPreflight.ok;
  if (client === "claude") return !skipClaudeAdapterInstall && claudePreflight.ok;
  return !skipOpenCodeAdapterInstall && opencodePreflight.ok;
});
const selectedClients = updatePostinstall && previousClients !== undefined
  ? await chooseUpdateClients(previousClients, detectedClients, scriptedAnswers)
  : detectedClients;
const installClients = detectedClients.filter((client) => selectedClients.includes(client));
if (updatePostinstall && previousClients !== undefined) {
  log(clientSelectionMessage(selectedClients, { dshSelected }));
} else {
  log(detectedClientMessage(installClients, dshSelected ? dshProfiles : []));
}
if (dshSelected) {
  log(`DeepSeek Harness profiles: found (${dshProfiles.map((profile) => profile.name).join(", ")}); supported profiles will be reconciled by \`memorax-code start\`.`);
} else if (dshProfiles.length > 0) {
  log("DeepSeek Harness profiles were detected, but the DSH integration is disabled by [clients].dsh.");
}
if (requestedClients.includes("codex") && !skipCodexPluginInstall && !codexPreflight.ok) {
  log("Codex runtime was not detected; skipping its adapter setup.");
}
if (requestedClients.includes("claude") && !skipClaudeAdapterInstall && !claudePreflight.ok) {
  log("Claude Code runtime was not detected; skipping its adapter setup.");
}
if (requestedClients.includes("opencode") && !skipOpenCodeAdapterInstall && !opencodePreflight.ok) {
  log("OpenCode runtime or configuration was not detected; skipping its adapter setup.");
}
if (writeClientSelectionConfig(selectedClients) === "failed") {
  printPostinstallSummary("not-verified");
  process.exit(0);
}
const clientMode = clientModeFor(installClients, {
  includeDsh: dshProfilesVerified && persistedDshSelection !== false,
});
let memoraxConfigResult = "skipped";
if (installClients.length > 0 || dshSelected) {
  memoraxConfigResult = await maybeConfigureMemoraxMemory(scriptedAnswers);
}
if (memoraxConfigResult === "configured") {
  if (seedMissingMemoraxCodeConfig() === "failed") {
    printPostinstallSummary("not-verified");
    process.exit(0);
  }
}
const codexClientEnabled = installClients.includes("codex");
const claudeClientEnabled = installClients.includes("claude");
const opencodeClientEnabled = installClients.includes("opencode");
const codexClientNewlyEnabled = codexClientEnabled
  && updatePostinstall
  && previousClients !== undefined
  && !previousClients.includes("codex");
const codexHooksBeforeUpdate = codexClientEnabled && updatePostinstall && !codexClientNewlyEnabled
  ? inspectCodexPluginHooksForUpdate()
  : undefined;
const result = codexClientEnabled
  ? runNodeMemoraxCodeCommand(["codex-plugin", "install", "--json"], { print: verbose })
  : { status: 0 };

if (codexClientEnabled && result.status !== 0 && process.env.npm_lifecycle_event) {
  logRed("MemoraX Code Codex plugin registration was skipped or failed. Run `memorax-code codex-plugin install` after installation.");
}

if (codexClientEnabled && result.status === 0) {
  if (codexClientNewlyEnabled) {
    await maybeActivateCodexPluginHooks(scriptedAnswers, { updatePrompt: true });
  } else if (updatePostinstall) {
    await maybeTrustUpdatedCodexPluginHooks(scriptedAnswers, codexHooksBeforeUpdate);
  } else {
    await maybeActivateCodexPluginHooks(scriptedAnswers);
  }
}
const skipCodexAdapter = !codexClientEnabled;
const skipClaudeAdapter = !claudeClientEnabled;
const skipOpenCodeAdapter = !opencodeClientEnabled;
const codexSkipReason = postinstallClientSkipReason({
  explicitlySkipped: skipCodexPluginInstall,
  selected: selectedClients.includes("codex"),
  enabled: codexClientEnabled,
});
const claudeSkipReason = postinstallClientSkipReason({
  explicitlySkipped: skipClaudeAdapterInstall,
  selected: selectedClients.includes("claude"),
  enabled: claudeClientEnabled,
});
const opencodeSkipReason = postinstallClientSkipReason({
  explicitlySkipped: skipOpenCodeAdapterInstall,
  selected: selectedClients.includes("opencode"),
  enabled: opencodeClientEnabled,
});

const backendAndAdapters = startBackendAndCheck({
  skipCodexAdapter,
  clientMode,
  codexSkipReason,
  skipClaudeAdapter,
  claudeAdapterRequired: !skipClaudeAdapter,
  claudeSkipReason,
  skipOpenCodeAdapter,
  opencodeAdapterRequired: !skipOpenCodeAdapter,
  opencodeSkipReason,
});
const backendAndAdaptersStatus = backendAndAdapters.status;
if (backendAndAdaptersStatus === "enabled") {
  logGreen(`Client Hook runtime ${stagedHookRuntime.generationId} activated.`);
}
if (backendAndAdaptersStatus === "enabled") {
  printNextSteps({
    codexAdapterEnabled: !skipCodexAdapter,
    claudeAdapterEnabled: !skipClaudeAdapter,
    dshAdapterEnabled: backendAndAdapters.dshAdapterEnabled,
    opencodeAdapterEnabled: !skipOpenCodeAdapter,
  });
  printCommonCommands({
    codexAdapterEnabled: !skipCodexAdapter,
    claudeAdapterEnabled: !skipClaudeAdapter,
    opencodeAdapterEnabled: !skipOpenCodeAdapter,
  });
}
printPostinstallSummary(backendAndAdaptersStatus);
if (backendAndAdaptersStatus === "enabled") {
  log("View local memory activity: http://127.0.0.1:8787/memory-viewer");
}

// Do not fail npm installation: users can register the plugin explicitly later.
process.exit(0);

async function maybeConfigureMemoraxMemory(scriptedAnswers) {
  printMemoraxDisclosure();
  if (!canPrompt()) {
    log(`This install cannot prompt for a MemoraX ID and key. Register at ${MEMORAX_ACCOUNT_URL}, then edit \`~/.memorax-code/config.toml\` or rerun interactively with \`--foreground-scripts\`.`);
    return "skipped";
  }
  if (scriptedAnswers) {
    return await configureMemoraxMemoryFromAnswers(scriptedAnswers);
  }
  let rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const configureNow = await rl.question(`${PREFIX} Connect MemoraX Code to MemoraX now? [Y/n] `);
    if (/^n(?:o)?$/i.test(configureNow.trim())) {
      log("MemoraX connection skipped. MemoraX Code memory is not fully configured until valid credentials are supplied.");
      return "skipped";
    }
    log(`If you do not have a MemoraX account/API key, register at ${MEMORAX_ACCOUNT_URL}.`);
    const userId = (await rl.question(`${PREFIX} MemoraX base user ID: `)).trim();
    const outputLanguage = await questionPreferredLanguage(rl);
    rl.close();
    rl = undefined;
    const apiKey = (await questionMasked(`${PREFIX} MemoraX API key: `)).trim();
    return await writeMemoraxConfigFromInput({
      userId,
      apiKey,
      endpoint: memoraxInstallEndpoint(),
      outputLanguage,
    });
  } finally {
    rl?.close();
  }
}

async function chooseUpdateClients(previousClients, detectedClients, scriptedAnswers) {
  const selected = new Set(previousClients);
  const availableDisabledClients = detectedClients.filter((client) => !selected.has(client));
  if (availableDisabledClients.length === 0) return [...previousClients];

  if (!canPromptForUpdate()) {
    for (const client of availableDisabledClients) {
      const label = clientLabel(client);
      log(`${label} runtime is available, but its integration remains disabled because this update cannot prompt. Rerun \`memorax-code update\` from an interactive terminal to choose whether to enable it.`);
    }
    return [...previousClients];
  }

  let rl;
  try {
    for (const client of availableDisabledClients) {
      const label = clientLabel(client);
      const question = `${label} runtime is available, but its integration is disabled in [clients]. Enable it now? [Y/n]`;
      let answer;
      if (scriptedAnswers) {
        log(question);
        answer = String(scriptedAnswers.shift() ?? "").trim();
      } else {
        rl ??= createInterface({ input: process.stdin, output: process.stderr });
        answer = (await rl.question(`${PREFIX} ${question} `)).trim();
      }
      if (/^n(?:o)?$/i.test(answer)) {
        log(`Keeping the ${label} integration disabled.`);
      } else {
        selected.add(client);
        logGreen(`Enabling the ${label} integration.`);
      }
    }
  } finally {
    rl?.close();
  }
  return ["codex", "claude", "opencode"].filter((client) => selected.has(client));
}

async function configureMemoraxMemoryFromAnswers(answers) {
  if (answers.length === 0) {
    log(`No MemoraX connection response was received. Register at ${MEMORAX_ACCOUNT_URL}, then edit \`~/.memorax-code/config.toml\` or rerun interactively with \`--foreground-scripts\`.`);
    return "skipped";
  }
  log("Connect MemoraX Code to MemoraX now? [Y/n]");
  const configureNow = String(answers.shift() ?? "").trim();
  if (/^n(?:o)?$/i.test(configureNow)) {
    log("MemoraX connection skipped. MemoraX Code memory is not fully configured until valid credentials are supplied.");
    return "skipped";
  }
  log(`If you do not have a MemoraX account/API key, register at ${MEMORAX_ACCOUNT_URL}.`);
  log("MemoraX base user ID: <provided>");
  const userId = String(answers.shift() ?? "").trim();
  const outputLanguageAnswer = String(answers.shift() ?? "").trim();
  log(`Preferred language [ZH/en] (used for Memory extraction): ${outputLanguageAnswer ? "<provided>" : "<default>"}`);
  log("MemoraX API key: <provided>");
  const apiKey = String(answers.shift() ?? "").trim();
  return await writeMemoraxConfigFromInput({
    userId,
    apiKey,
    endpoint: memoraxInstallEndpoint(),
    outputLanguage: preferredLanguage(outputLanguageAnswer),
  });
}

function printMemoraxDisclosure() {
  log("MemoraX Code requires MemoraX for its core remote-memory functionality.");
  log("After connection, trusted repository sessions automatically send selected user prompts and final assistant answers to MemoraX after replies.");
  log("Newly generated configuration enables automatic writeback. Existing configuration is never enabled implicitly; disable it with `[memory.writeback] enabled = false` or `MEMORAX_CODE_MEMORAX_WRITEBACK_ENABLED=false`.");
}

async function writeMemoraxConfigFromInput({ userId, apiKey, endpoint, outputLanguage }) {
  if (!userId || !apiKey) {
    logRed("MemoraX config was not written because base user ID or API key was empty.");
    return "skipped";
  }
  if (!outputLanguage) {
    logRed("MemoraX config was not written because preferred language must be zh or en.");
    return "skipped";
  }
  if (writeMemoraxConfig({ userId, apiKey, endpoint, outputLanguage }) === "failed") {
    logRed("MemoraX config was not written because the existing config could not be safely updated.");
    return "skipped";
  }
  logGreen(`MemoraX config written to ${memoraxCodeConfigPath()}.`);
  log("MemoraX network access will be checked by the first workspace-scoped memory request from a trusted workspace.");
  return "configured";
}

async function questionPreferredLanguage(rl) {
  while (true) {
    const answer = await rl.question(`${PREFIX} Preferred language [ZH/en] (used for Memory extraction): `);
    const language = preferredLanguage(answer);
    if (language) return language;
    logRed("Preferred language must be zh or en.");
  }
}

function preferredLanguage(value) {
  const trimmed = String(value ?? "").trim();
  return trimmed
    ? normalizeMemoraxMemoryOutputLanguage(trimmed)
    : MEMORAX_DEFAULT_MEMORY_OUTPUT_LANGUAGE;
}

function memoraxInstallEndpoint() {
  return normalizeMemoraxBaseUrl(process.env.MEMORAX_CODE_MEMORAX_ENDPOINT) || MEMORAX_DEFAULT_BASE_URL;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function questionMasked(prompt) {
  if (process.stdin.isTTY !== true || typeof process.stdin.setRawMode !== "function") {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      return await rl.question(prompt);
    } finally {
      rl.close();
    }
  }
  process.stderr.write(prompt);
  const wasRaw = process.stdin.isRaw === true;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return await new Promise((resolve, reject) => {
    let answer = "";
    const cleanup = () => {
      process.stdin.off("data", onData);
      process.stdin.setRawMode(wasRaw);
      if (!wasRaw) process.stdin.pause();
    };
    const finish = () => {
      cleanup();
      process.stderr.write("\n");
      resolve(answer);
    };
    const onData = (chunk) => {
      for (const char of String(chunk)) {
        if (char === "\u0003") {
          cleanup();
          process.stderr.write("\n");
          reject(new Error("Interrupted"));
          return;
        }
        if (char === "\r" || char === "\n") {
          finish();
          return;
        }
        if (char === "\u0008" || char === "\u007f") {
          if (answer.length > 0) {
            answer = answer.slice(0, -1);
            process.stderr.write("\b \b");
          }
          continue;
        }
        if (char >= " " && char !== "\u007f") {
          answer += char;
          process.stderr.write("*");
        }
      }
    };
    process.stdin.on("data", onData);
  });
}

function inspectCodexPluginHooksForUpdate() {
  const result = runNodeMemoraxCodeCommand(codexPluginHookArgs("hooks"), { print: false });
  const report = parseCodexPluginHookReport(result, "codex-plugin-hooks");
  return report?.hooks;
}

async function maybeTrustUpdatedCodexPluginHooks(scriptedAnswers, previousHooks) {
  if (!previousHooks) {
    warnUpdatedHookTrustSkipped("Existing Codex hooks could not be inspected before the plugin cache refresh.");
    return "skipped";
  }
  const checkEnv = hookTrustCommandEnv(PREVIOUS_HOOKS_ENV, previousHooks);
  const checked = runNodeMemoraxCodeCommand(codexPluginHookArgs("trust-hooks", ["--check"]), {
    env: checkEnv,
    print: false,
  });
  const report = parseCodexPluginHookReport(checked, "codex-plugin-trust-hooks");
  if (!report) {
    warnUpdatedHookTrustSkipped("Updated Codex hooks could not be inspected after the plugin cache refresh.");
    return "skipped";
  }
  if (report.requiresFullReview) {
    warnUpdatedHookTrustSkipped("The MemoraX Code Codex plugin marketplace identity changed during the update, so incremental Hook authorization was not applied.");
    return "skipped";
  }
  if (report.hooks.length === 0) return "unchanged";

  printUpdatedCodexHooks(report.hooks, previousHooks);
  if (!canPromptForUpdate()) {
    warnUpdatedHookTrustSkipped("This update is running without an interactive terminal, so the new or changed Hooks remain untrusted.");
    return "skipped";
  }
  const answer = await updatedHookTrustAnswer(scriptedAnswers);
  if (answer === undefined) {
    warnUpdatedHookTrustSkipped("No Hook authorization response was received, so the new or changed Hooks remain untrusted.");
    return "skipped";
  }
  const normalizedAnswer = answer.trim();
  if (normalizedAnswer && !/^y(?:es)?$/i.test(normalizedAnswer)) {
    warnUpdatedHookTrustSkipped("Hook authorization was declined, so the new or changed Hooks remain untrusted.");
    return "skipped";
  }

  const trustEnv = hookTrustCommandEnv(HOOK_TRUST_SELECTION_ENV, report.hooks);
  const trusted = runNodeMemoraxCodeCommand(codexPluginHookArgs("trust-hooks", ["--yes"]), {
    env: trustEnv,
    print: verbose,
  });
  if (trusted.status === 0) {
    logGreen(`Trusted ${report.hooks.length} new or changed MemoraX Code Codex Hook${report.hooks.length === 1 ? "" : "s"}.`);
    return "trusted";
  }
  warnUpdatedHookTrustSkipped("The reviewed Hooks changed again or could not be written to Codex config.");
  return "failed";
}

function parseCodexPluginHookReport(result, action) {
  if (result.status !== 0) return undefined;
  try {
    const report = JSON.parse(String(result.stdout ?? ""));
    if (!report || report.ok !== true || report.action !== action || !Array.isArray(report.hooks)) return undefined;
    if (!report.hooks.every((hook) => hook
      && typeof hook === "object"
      && typeof hook.key === "string"
      && typeof hook.currentHash === "string"
      && hook.handlerType === "command"
      && typeof hook.eventName === "string"
      && hook.eventName.length > 0
      && typeof hook.command === "string"
      && hook.command.length > 0
      && isCodexHookTrustStatus(hook.trustStatus))) return undefined;
    if (action === "codex-plugin-trust-hooks"
      && (typeof report.requiresFullReview !== "boolean"
        || !report.hooks.every((hook) => hook.trustStatus === "untrusted" || hook.trustStatus === "modified"))) {
      return undefined;
    }
    return report;
  } catch {
    return undefined;
  }
}

function isCodexHookTrustStatus(value) {
  return value === "managed" || value === "untrusted" || value === "trusted" || value === "modified";
}

function codexPluginHookArgs(subcommand, extraArgs = []) {
  const args = ["codex-plugin", subcommand, ...extraArgs];
  const codexCommand = stringOption(process.env.MEMORAX_CODE_CODEX_COMMAND);
  if (codexCommand) args.push("--codex-command", codexCommand);
  const workspace = codexHookInspectionWorkspace();
  if (workspace) args.push("--workspace", workspace);
  args.push("--json");
  return args;
}

function codexHookInspectionWorkspace() {
  for (const candidate of [process.env.INIT_CWD, process.env.HOME, homedir(), process.cwd()]) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return undefined;
}

function hookTrustCommandEnv(name, hooks) {
  const env = { ...process.env };
  delete env[PREVIOUS_HOOKS_ENV];
  delete env[HOOK_TRUST_SELECTION_ENV];
  env[name] = JSON.stringify(hooks);
  return env;
}

function printUpdatedCodexHooks(hooks, previousHooks) {
  const previousByKey = new Map(previousHooks.map((hook) => [hook.key, hook.currentHash]));
  log("This MemoraX Code update includes new or changed Codex Hooks that require authorization:");
  for (const hook of hooks) {
    const change = previousByKey.has(hook.key) ? "changed" : "new";
    const label = hook.statusMessage ? ` (${hook.statusMessage})` : "";
    log(`- ${change}: ${hook.key}${label}`);
    if (hook.eventName) log(`  event: ${hook.eventName}`);
    if (hook.command) log(`  command: ${hook.command}`);
  }
}

async function updatedHookTrustAnswer(scriptedAnswers) {
  if (scriptedAnswers) {
    log("Trust these new or changed Codex Hooks? [Y/n]");
    return scriptedAnswers.shift();
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(`${PREFIX} Trust these new or changed Codex Hooks? [Y/n] `);
  } finally {
    rl.close();
  }
}

function parseScriptedAnswers(input) {
  if (input.length === 0) return [];
  const answers = input.split(/\r?\n/);
  if (answers.at(-1) === "") answers.pop();
  return answers;
}

function warnUpdatedHookTrustSkipped(message) {
  logRed(message);
  logRed("Review and authorize the current MemoraX Code Codex Hooks with `memorax-code codex-plugin trust-hooks`.");
}

async function maybeActivateCodexPluginHooks(scriptedAnswers, { updatePrompt = false } = {}) {
  if (!(updatePrompt ? canPromptForUpdate() : canPrompt())) {
    log("Codex hook activation was not prompted. Run `memorax-code codex-plugin activate --yes` later to activate and trust MemoraX Code Codex Adapter hooks.");
    return "skipped";
  }
  if (scriptedAnswers) {
    return activateCodexPluginHooksFromAnswers(scriptedAnswers);
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const activateNow = await rl.question(`${PREFIX} Activate and trust MemoraX Code Codex Adapter hooks now? [Y/n] `);
    return activateCodexPluginHooksFromAnswer(activateNow);
  } finally {
    rl.close();
  }
}

function activateCodexPluginHooksFromAnswers(answers) {
  log("Activate and trust MemoraX Code Codex Adapter hooks now? [Y/n]");
  const activateNow = String(answers.shift() ?? "").trim();
  return activateCodexPluginHooksFromAnswer(activateNow);
}

function activateCodexPluginHooksFromAnswer(answer) {
  if (/^n(?:o)?$/i.test(String(answer ?? "").trim())) {
    log("Codex hook activation skipped; run `memorax-code codex-plugin activate --yes` later if needed.");
    return "skipped";
  }
  const activated = runNodeMemoraxCodeCommand(["codex-plugin", "activate", "--yes"], { print: verbose });
  if (activated.status === 0) {
    logGreen("MemoraX Code Codex Adapter hooks activated and trusted.");
    return "activated";
  }
  logRed("Codex hook activation failed; run `memorax-code codex-plugin activate --yes` after installation.");
  return "failed";
}

function canPrompt() {
  if (updatePostinstall) return false;
  return canPromptOnStderr();
}

function canPromptForUpdate() {
  return updatePostinstall && canPromptOnStderr();
}

function canPromptOnStderr() {
  return process.env.MEMORAX_CODE_NPM_POSTINSTALL_ASSUME_INTERACTIVE === "1"
    || (process.stdin.isTTY === true && process.stderr.isTTY === true);
}

function postinstallUpdateMode() {
  return truthyEnv(process.env.MEMORAX_CODE_NPM_POSTINSTALL_UPDATE) || process.env.npm_command === "update";
}

function truthyEnv(value) {
  return ["1", "true", "yes"].includes(String(value ?? "").toLowerCase());
}

function memoraxCodeHome() {
  return process.env.MEMORAX_CODE_HOME || join(homedir(), ".memorax-code");
}

function memoraxCodeConfigPath() {
  return join(memoraxCodeHome(), "config.toml");
}

function readPersistedClientSelection() {
  const path = memoraxCodeConfigPath();
  if (!existsSync(path)) return undefined;
  try {
    const clients = parse(readFileSync(path, "utf8"))?.clients;
    if (!clients || typeof clients !== "object" || typeof clients.codex !== "boolean" || typeof clients.claude !== "boolean") return undefined;
    return [
      clients.codex ? "codex" : undefined,
      clients.claude ? "claude" : undefined,
      clients.opencode === true ? "opencode" : undefined,
    ].filter(Boolean);
  } catch {
    return undefined;
  }
}

function readPersistedDshSelection() {
  const path = memoraxCodeConfigPath();
  if (!existsSync(path)) return undefined;
  try {
    const value = parse(readFileSync(path, "utf8"))?.clients?.dsh;
    return typeof value === "boolean" ? value : undefined;
  } catch {
    return undefined;
  }
}

function writeClientSelectionConfig(clients) {
  const path = memoraxCodeConfigPath();
  return updateConfigFileAtomically({
    path,
    defaultText: setManagedClientSelection(defaultMemoraxCodeConfig(), clients),
    transform: (text) => setManagedClientSelection(text, clients),
    parseToml: parse,
    warn: (message) => log(message),
  });
}

function setManagedClientSelection(text, clients) {
  const withOpenCode = setTomlField(text, "clients", "opencode", String(clients.includes("opencode")));
  const withClaude = setTomlField(withOpenCode, "clients", "claude", String(clients.includes("claude")));
  return setTomlField(withClaude, "clients", "codex", String(clients.includes("codex")));
}

function writeMemoraxConfig({ userId, apiKey, endpoint, outputLanguage }) {
  const path = memoraxCodeConfigPath();
  const fields = [
    {
      key: "endpoint",
      line: `endpoint = "${tomlString(endpoint || MEMORAX_DEFAULT_BASE_URL)}" # MemoraX service URL.`,
    },
    {
      key: "api_key",
      line: `api_key = "${tomlString(apiKey)}" # MemoraX API key used by the local Backend.`,
    },
    {
      key: "user_id",
      line: `user_id = "${tomlString(userId)}" # MemoraX base user ID; requests derive a workspace-scoped namespace.`,
    },
  ];
  const addFields = [{
    key: "output_language",
    line: `output_language = "${outputLanguage}" # Language for newly generated MemoraX memories.`,
  }];
  const applyFields = (text) => setTomlSectionFields(
    setTomlSectionFields(text, "memorax", fields),
    "memory.add",
    addFields,
  );
  return updateConfigFileAtomically({
    path,
    defaultText: applyFields(defaultMemoraxCodeConfig()),
    transform: applyFields,
    parseToml: parse,
    warn: (message) => log(message),
  });
}

function defaultMemoraxCodeConfig() {
  return [
    "# MemoraX Code local config.",
    "# This file is read from $MEMORAX_CODE_HOME/config.toml.",
    "# Environment variables still override values written here.",
    "# See docs/configuration.md for advanced tuning fields and effective defaults.",
    "",
    "[clients]",
    "codex = true # Manage the Codex adapter.",
    "claude = true # Manage the Claude adapter.",
    "dsh = true # Manage the DeepSeek Harness adapter when Profiles exist.",
    "opencode = true # Manage the OpenCode adapter.",
    "",
    "# MemoraX remote-memory connection. Credentials may also come from the environment.",
    "[memorax]",
    `# endpoint = "${MEMORAX_DEFAULT_BASE_URL}" # MemoraX service URL.`,
    '# api_key = "" # MemoraX API key used by the local Backend.',
    '# user_id = "" # MemoraX base user ID; requests derive a workspace-scoped namespace.',
    "",
    "# Automatic Hook retrieval is opt-in.",
    "[memory.retrieval]",
    "enabled = false # Auto-inject retrieved memories into supported client prompts.",
    "",
    "# Automatic writeback sends selected prompts and final answers to MemoraX.",
    "[memory.writeback]",
    "enabled = true # Allow supported client sessions to write memories after replies.",
    "",
    "# Preferred language for newly generated MemoraX memories.",
    "[memory.add]",
    `output_language = "${MEMORAX_DEFAULT_MEMORY_OUTPUT_LANGUAGE}" # Language for newly generated MemoraX memories.`,
    "",
    "# Controls how often supported native client sessions see the MemoraX Code skill reminder.",
    "[memory.skill_reminder]",
    "interval_turns = 5 # Show the MemoraX Code skill reminder every N native client turns, starting on the first turn.",
    "",
    "# Relevant repo reads batch generated repo-memory updates by commit count or elapsed time.",
    "[memory.repo_update]",
    'policy = "adaptive" # every-commit / commit-count / daily / pull-request / pull-request-or-daily / adaptive.',
    "commit_threshold = 5 # Pending local commits needed by commit-count and adaptive.",
    "cooldown_hours = 24 # Pending-commit age used by daily, pull-request-or-daily, and adaptive.",
    "",
    "# Local traces may contain prompts, responses, recalled memories, and local paths.",
    "[trace.codex]",
    "enabled = true # Enable local Codex session memory trace collection.",
    "capture_content = true # Store content in local Codex trace events.",
    "",
    "[trace.claude]",
    "enabled = true # Enable local Claude session memory trace collection.",
    "capture_content = true # Store content in local Claude trace events.",
    "",
    "[trace.dsh]",
    "enabled = true # Enable local DSH session memory trace collection.",
    "capture_content = true # Store content in local DSH trace events.",
    "",
    "[trace.opencode]",
    "enabled = true # Enable local OpenCode session memory trace collection.",
    "capture_content = true # Store content in local OpenCode trace events.",
    "",
  ].join("\n");
}

function seedMissingMemoraxCodeConfig() {
  const path = memoraxCodeConfigPath();
  return updateConfigFileAtomically({
    path,
    defaultText: defaultMemoraxCodeConfig(),
    transform: (text) => text,
    parseToml: parse,
    warn: (message) => log(message),
  });
}

function setTomlSectionFields(text, section, fields) {
  const source = String(text ?? "");
  const newline = source.includes("\r\n") ? "\r\n" : "\n";
  const lines = source.split(/\r?\n/);
  const escaped = section.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const header = new RegExp(`^\\s*\\[(?:${escaped}|"${escaped}"|'${escaped}')\\]\\s*(?:#.*)?$`);
  const start = lines.findIndex((line) => header.test(line));
  if (start === -1) {
    const separator = source.length === 0
      ? ""
      : source.endsWith(`${newline}${newline}`)
        ? ""
        : source.endsWith(newline)
          ? newline
          : `${newline}${newline}`;
    return `${source}${separator}[${section}]${newline}${fields.map((field) => field.line).join(newline)}${newline}`;
  }

  const nextHeader = lines.findIndex((line, index) => index > start && /^\s*\[/.test(line));
  const end = nextHeader === -1 ? lines.length : nextHeader;
  const keys = fields
    .map(({ key }) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .flatMap((key) => [key, `"${key}"`, `'${key}'`])
    .join("|");
  const assignment = new RegExp(`^\\s*#?\\s*(?:${keys})\\s*=`);
  const preservedBody = lines
    .slice(start + 1, end)
    .filter((line) => !assignment.test(line));
  lines.splice(
    start + 1,
    end - start - 1,
    ...fields.map((field) => field.line),
    ...preservedBody,
  );
  return lines.join(newline);
}

function tomlString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function runCommonPreflight() {
  log("Checking local install state...");
  if (updatePostinstall) {
    log("Package update detected; refreshing MemoraX Code assets and checking client availability.");
  }
  const memoraxCodeVersion = runNodeMemoraxCodeCommand(["--version"], { print: false });
  log(`MemoraX Code backend package: ${commandSummary(memoraxCodeVersion) ?? packageVersionSummary()}`);
  if (skipCodexPluginInstall) {
    log("Codex plugin registration is disabled for this npm postinstall; other client setup can still continue.");
  }
  if (skipClaudeAdapterInstall) {
    log("Claude Code adapter setup is disabled for this npm postinstall; other client setup can still continue.");
  }
  if (skipOpenCodeAdapterInstall) {
    log("OpenCode adapter setup is disabled for this npm postinstall; other client setup can still continue.");
  }
  return {};
}

function runCodexPreflight({ integrationSelected = true } = {}) {
  const version = runExternalCommand(codexCommand, ["--version"], { print: false, timeout: 10_000 });
  const runtimeLabel = codexRuntime.source === "app-bundled"
    ? "Codex App runtime"
    : codexRuntime.source === "vscode-bundled"
      ? "Codex VS Code runtime"
      : "Codex CLI";
  log(`${runtimeLabel}: ${commandSummary(version) ?? "not runnable"}`);
  if (version.status !== 0) {
    return { ok: false, pluginCache: { marketplaceName: CLI_MARKETPLACE_NAME, versions: [] } };
  }
  const pluginCache = installedPluginCache();
  log(`Existing Codex plugin cache: ${pluginCache.versions.length > 0 ? `found (${pluginCache.versions.join(", ")})` : "not installed"}`);
  log(`Codex client process: ${codexClientRunning() ? "running" : "not detected"}`);
  log(integrationSelected
    ? "Keeping Codex provider config unchanged and enabling the shared memory hook integration."
    : "Keeping Codex provider config unchanged while checking whether to enable its integration.");
  return { ok: true, pluginCache };
}

function runClaudePreflight({ integrationSelected = true } = {}) {
  const version = runExternalCommand(claudeCommand, ["--version"], { print: false, timeout: 10_000 });
  const runtimeLabel = claudeRuntime.source === "app-bundled"
    ? "Claude Code App runtime"
    : claudeRuntime.source === "vscode-bundled"
      ? "Claude VS Code runtime"
      : "Claude CLI";
  log(`${runtimeLabel}: ${commandSummary(version) ?? "not runnable"}`);
  if (version.status !== 0) return { ok: false };
  log(integrationSelected
    ? "Keeping Claude Code provider config unchanged and enabling the shared memory Hook integration."
    : "Keeping Claude Code provider config unchanged while checking whether to enable its integration.");
  return { ok: true };
}

function runOpenCodePreflight({ integrationSelected = true } = {}) {
  const explicitConfigDir = stringOption(process.env.OPENCODE_CONFIG_DIR);
  const configHome = stringOption(process.env.XDG_CONFIG_HOME) ?? join(homedir(), ".config");
  const configDir = resolve(explicitConfigDir ?? join(configHome, "opencode"));
  const configDetected = explicitConfigDir !== undefined || existsSync(configDir);
  const cliDetected = commandOnPath(
    "opencode",
    process.env.PATH,
    process.platform,
    process.env.PATHEXT,
  );
  const detected = configDetected || cliDetected;
  log(`OpenCode configuration: ${configDetected ? `found (${configDir})` : "not detected"}`);
  log(`OpenCode CLI: ${cliDetected ? "found in PATH" : "not detected"}`);
  if (!detected) return { ok: false };
  log(integrationSelected
    ? "Keeping OpenCode provider config unchanged and enabling the shared memory plugin integration."
    : "Keeping OpenCode provider config unchanged while checking whether to enable its integration.");
  return { ok: true };
}

function installedPluginCache() {
  for (const marketplaceName of [CLI_MARKETPLACE_NAME, PERSONAL_MARKETPLACE_NAME]) {
    const versions = installedPluginCacheVersions(marketplaceName);
    if (versions.length > 0) {
      return { marketplaceName, versions };
    }
  }
  return { marketplaceName: CLI_MARKETPLACE_NAME, versions: [] };
}

function installedPluginCacheVersions(marketplaceName) {
  const cacheRoot = join(codexHome(), "plugins", "cache", marketplaceName, PLUGIN_NAME);
  if (!existsSync(cacheRoot)) return [];
  try {
    return readdirSync(cacheRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function startBackendAndCheck({
  skipCodexAdapter = false,
  clientMode = "all",
  codexSkipReason,
  skipClaudeAdapter = false,
  claudeAdapterRequired = !skipClaudeAdapter,
  claudeSkipReason,
  skipOpenCodeAdapter = false,
  opencodeAdapterRequired = !skipOpenCodeAdapter,
  opencodeSkipReason,
} = {}) {
  logGreen("Starting backend with `memorax-code start`...");
  const adapterFlags = clientLifecycleFlags({ clientMode });
  const startArgs = ["start", ...adapterFlags];
  const statusArgs = ["status", ...adapterFlags];
  let started = runMemoraxCodeCommand(startArgs, pendingClientHookRuntimeEnv());
  let recovered = false;
  if (started.status !== 0) {
    logRed("Backend start failed during npm postinstall.");
    if (clientHookRuntimeActivationFailed(started)) {
      logRed("Client Hook runtime activation failed; automatic lifecycle recovery was skipped.");
      logRed("The previously active runtime remains authoritative.");
      return { status: "not-verified", dshAdapterEnabled: false };
    }
    if (lifecycleLockFailureCode(started)) {
      logRed("Automatic stop/start recovery is skipped because another MemoraX Code lifecycle command still owns the Backend authority.");
      printLifecycleLockFailureSuggestions();
      return { status: "not-verified", dshAdapterEnabled: false };
    }
    const runtimeAuthorityFailure = runtimeAuthorityFailureCode(started);
    if (runtimeAuthorityFailure) {
      logRed("Automatic stop/start recovery is skipped because persisted Backend runtime authority requires explicit repair.");
      printRuntimeAuthorityFailureSuggestions(runtimeAuthorityFailure);
      return { status: "not-verified", dshAdapterEnabled: false };
    }
    logRed("Attempting automatic recovery: `memorax-code stop` then `memorax-code start`...");
    runMemoraxCodeCommand(["stop", ...adapterFlags]);
    started = runMemoraxCodeCommand(startArgs, pendingClientHookRuntimeEnv());
    recovered = started.status === 0;
    if (!recovered) {
      logRed("Automatic recovery did not start the backend.");
      logRed("Diagnostic: running `memorax-code status` so the failure is visible.");
      runMemoraxCodeCommand(statusArgs);
      printFailureSuggestions();
      return { status: "not-verified", dshAdapterEnabled: false };
    }
  }
  logGreen(recovered ? "Backend start completed after automatic recovery." : "Backend start completed.");
  log("Checking backend status with `memorax-code status`...");
  const checked = runMemoraxCodeCommand(statusArgs);
  if (checked.status !== 0) {
    logRed("Backend status check failed during npm postinstall.");
    printFailureSuggestions();
    return { status: "not-verified", dshAdapterEnabled: false };
  }
  logGreen("Backend status check completed.");
  const enabled = memoraxCodeEnabled(checked, {
    codexAdapterRequired: !skipCodexAdapter,
    claudeAdapterRequired,
    opencodeAdapterRequired,
  });
  if (!enabled) {
    printUnavailableDiagnostics({ codexSkipReason, claudeSkipReason, opencodeSkipReason });
    return { status: "unavailable", dshAdapterEnabled: false };
  }
  return {
    status: "enabled",
    dshAdapterEnabled: dshAdapterReady(checked),
  };
}

function dshAdapterReady(statusResult) {
  const output = `${statusResult.stdout ?? ""}\n${statusResult.stderr ?? ""}`;
  return /\bDSH adapter:\s*ok\b[^\r\n]*\bintegration=plugin\b/im.test(stripAnsi(output));
}

function pendingClientHookRuntimeEnv() {
  return {
    MEMORAX_CODE_PENDING_CLIENT_HOOK_RUNTIME_V1: JSON.stringify({
      version: 1,
      memoraxCodeHome: resolve(memoraxCodeHome()),
      generation: {
        version: stagedHookRuntime.version,
        runtimeAbi: stagedHookRuntime.runtimeAbi,
        generationId: stagedHookRuntime.generationId,
        packageVersion: stagedHookRuntime.packageVersion,
        contentDigest: stagedHookRuntime.contentDigest,
        createdAt: stagedHookRuntime.createdAt,
      },
    }),
  };
}

function runtimeAuthorityFailureCode(result) {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return output.match(/\b(BACKEND_(?:(?:CONNECTION_AUTHORITY|TOKEN_RECORD|SERVICE_STATE)_(?:ABSENT|INVALID|UNSUPPORTED)|SERVICE_STATE_CLEANUP_FAILED))\b/)?.[1];
}

function lifecycleLockFailureCode(result) {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return output.match(/\bBACKEND_LIFECYCLE_LOCK_TIMEOUT\b/)?.[0];
}

function clientHookRuntimeActivationFailed(result) {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return /client Hook runtime activation failed:/i.test(output);
}

function clientLifecycleFlags({ clientMode = "all" } = {}) {
  return ["--clients", clientMode];
}

function clientModeFor(clients, { includeDsh = false } = {}) {
  const selected = ["codex", "claude", "dsh", "opencode"].filter((client) => (
    client === "dsh" ? includeDsh : clients.includes(client)
  ));
  if (selected.length === 4) return "all";
  return selected.length > 0 ? selected.join(",") : "none";
}

function postinstallClientSkipReason({ explicitlySkipped, selected, enabled }) {
  if (explicitlySkipped) return "postinstall-skip";
  if (selected && !enabled) return "client-not-detected";
  return enabled ? undefined : "client-selection";
}

function clientSelectionMessage(clients, { dshSelected = false } = {}) {
  if (dshSelected) {
    const labels = [
      clients.includes("codex") ? "Codex" : undefined,
      clients.includes("claude") ? "Claude Code" : undefined,
      "DeepSeek Harness",
      clients.includes("opencode") ? "OpenCode" : undefined,
    ].filter(Boolean);
    return `Configuring MemoraX Code for ${joinedLabels(labels)}.`;
  }
  const hasCodex = clients.includes("codex");
  const hasClaude = clients.includes("claude");
  const hasOpenCode = clients.includes("opencode");
  if (hasCodex && hasClaude && hasOpenCode) return "Configuring MemoraX Code for Codex, Claude Code, and OpenCode.";
  if (hasCodex && hasClaude) return "Configuring MemoraX Code for Codex and Claude Code.";
  if (hasCodex && hasOpenCode) return "Configuring MemoraX Code for Codex and OpenCode.";
  if (hasClaude && hasOpenCode) return "Configuring MemoraX Code for Claude Code and OpenCode.";
  if (hasCodex) return "Configuring MemoraX Code for Codex only.";
  if (hasClaude) return "Configuring MemoraX Code for Claude Code only.";
  if (hasOpenCode) return "Configuring MemoraX Code for OpenCode only.";
  return "Skipping client adapter setup for this npm postinstall.";
}

function clientLabel(client) {
  if (client === "codex") return "Codex";
  if (client === "claude") return "Claude Code";
  return "OpenCode";
}

function detectedClientMessage(clients, dshProfiles = []) {
  if (clients.length === 0 && dshProfiles.length === 0) {
    return "No supported client runtime was detected; starting the shared Backend without client adapters.";
  }
  if (clients.length === 0) {
    return "Detected existing DeepSeek Harness profiles; configuring the native DSH plugin and shared Backend.";
  }
  return `Detected supported client runtimes. ${clientSelectionMessage(clients)}`;
}

function joinedLabels(labels) {
  if (labels.length < 2) return labels[0] ?? "";
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, and ${labels.at(-1)}`;
}

function codexHome() {
  return process.env.CODEX_HOME || join(homedir(), ".codex");
}

function stringOption(value) {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function runMemoraxCodeCommand(args, extraEnv = {}) {
  return runNodeMemoraxCodeCommand(args, {
    env: { ...process.env, ...extraEnv, MEMORAX_CODE_BACKEND_SUPPRESS_GUIDANCE: "1" },
    outputPrefix: BACKEND_PREFIX,
  });
}

function runNodeMemoraxCodeCommand(args, {
  env = process.env,
  print = true,
  outputPrefix = PREFIX,
  timeout,
} = {}) {
  return runNodeCliCommand(memoraxCodeBin, args, {
    env,
    print,
    outputPrefix,
    timeout,
  });
}

function runNodeMemoraxCliCommand(args, {
  env = process.env,
  print = true,
  outputPrefix = PREFIX,
  timeout,
} = {}) {
  return runNodeCliCommand(memoraxCliBin, args, {
    env,
    print,
    outputPrefix,
    timeout,
  });
}

function runNodeCliCommand(bin, args, options) {
  return runCommand(process.execPath, [bin, ...args], options);
}

function runExternalCommand(command, args, { env = process.env, print = true, outputPrefix = PREFIX, timeout } = {}) {
  return runCommand(command, args, { env, print, outputPrefix, timeout });
}

function runCommand(command, args, { env = process.env, print = true, outputPrefix = PREFIX, timeout } = {}) {
  let invocation;
  try {
    invocation = resolveWindowsCliInvocation(command, args, { env });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (print) logRed(message);
    return { status: 1, stdout: "", stderr: message, error };
  }
  const result = spawnSync(invocation.command, invocation.args, {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...(timeout ? { timeout } : {}),
  });
  if (print) {
    printCommandOutput(result.stdout, outputPrefix);
    printCommandOutput(result.stderr, outputPrefix);
  }
  if (result.error && print) logRed(`Failed to run \`${[command, ...args].join(" ")}\`: ${result.error.message}`);
  return result;
}

function printCommandOutput(output, outputPrefix) {
  for (const line of String(output ?? "").split(/\r?\n/)) {
    if (!line) continue;
    if (hasMemoraxCodePrefix(line)) console.warn(line);
    else logWithPrefix(outputPrefix, line);
  }
}

function hasMemoraxCodePrefix(line) {
  return /^\[MemoraX Code (?:Install|Backend)\]: /.test(stripAnsi(line));
}

function stripAnsi(value) {
  return String(value).replace(/\x1b\[[0-9;]*m/g, "");
}

function firstOutputLine(result) {
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  return output || undefined;
}

function commandSummary(result) {
  if (result.status !== 0) return undefined;
  return firstOutputLine(result);
}

function packageVersionSummary() {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(scriptDir), "package.json"), "utf8"));
    if (typeof pkg.version === "string" && pkg.version) return `installed (${pkg.version}), command version unavailable`;
  } catch {
    // Ignore package metadata errors; this is a best-effort install preflight.
  }
  return "installed, version unavailable";
}

function codexClientRunning() {
  const result = process.platform === "win32"
    ? runExternalCommand("tasklist.exe", ["/FO", "CSV", "/NH"], { print: false })
    : runExternalCommand("ps", ["-axo", "comm=,args="], { print: false });
  if (result.status !== 0) return false;
  return String(result.stdout ?? "").split(/\r?\n/).some((line) => {
    const lower = line.toLowerCase();
    if (!lower.includes("codex")) return false;
    if (lower.includes("memorax-code-plugin-postinstall")) return false;
    return process.platform === "win32"
      ? /"codex(?:\.exe)?"/i.test(line)
      : lower.includes("codex.app") || /(^|[/\s])codex(\s|$)/i.test(line);
  });
}

function printNextSteps({
  codexAdapterEnabled = true,
  claudeAdapterEnabled = true,
  dshAdapterEnabled = false,
  opencodeAdapterEnabled = true,
} = {}) {
  const hookClientText = enabledClientText({
    codexAdapterEnabled,
    claudeAdapterEnabled,
    opencodeAdapterEnabled,
  });
  if (hookClientText && updatePostinstall) {
    logGreen(`${bold("The new Hook runtime is active")}; existing sessions with the stable shell select it on their next user prompt.`);
    log(`Restart or refresh ${hookClientText} only if its plugin shell was installed, changed, or newly enabled, or if MemoraX Code is not active on the next prompt.`);
  } else if (hookClientText) {
    logGreen(`${bold(`Restart or refresh ${hookClientText}`)} before opening a new MemoraX Code session.`);
  }
  if (dshAdapterEnabled) {
    logGreen(`${bold("Restart or refresh DeepSeek Harness")} so its Profiles load the installed MemoraX Code plugin.`);
  } else if (!hookClientText) {
    logGreen(`${bold("MemoraX Code backend is running")}; client adapters were skipped for this install.`);
  }
  if (codexAdapterEnabled && !updatePostinstall) {
    logGreen(`After restart, ${bold("enable the MemoraX Code Codex Adapter plugin")} from Codex Plugins or CLI \`/plugins\` if it is not already enabled.`);
  }
  const statusCommands = statusCommandText({ codexAdapterEnabled, claudeAdapterEnabled, opencodeAdapterEnabled });
  if (hookClientText || !dshAdapterEnabled) {
    log(`If MemoraX Code is not active ${updatePostinstall ? "on the next prompt" : "in new sessions"}, run ${statusCommands}.`);
  }
  if (dshAdapterEnabled) {
    log("If MemoraX Code is not active after restarting or refreshing DeepSeek Harness, run `memorax-code status`.");
  }
  log("If npm hides install details, reinstall with `--foreground-scripts`.");
}

function enabledClientText({
  codexAdapterEnabled = true,
  claudeAdapterEnabled = true,
  opencodeAdapterEnabled = true,
} = {}) {
  const labels = [
    codexAdapterEnabled ? "Codex" : undefined,
    claudeAdapterEnabled ? "Claude Code" : undefined,
    opencodeAdapterEnabled ? "OpenCode" : undefined,
  ].filter(Boolean);
  if (labels.length < 2) return labels[0] ?? "";
  if (labels.length === 2) return `${labels[0]} or ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")}, or ${labels.at(-1)}`;
}

function statusCommandText({
  codexAdapterEnabled = true,
  claudeAdapterEnabled = true,
  opencodeAdapterEnabled = true,
} = {}) {
  const commands = ["`memorax-code status`"];
  if (codexAdapterEnabled) commands.push("`memorax-code-codex status`");
  if (claudeAdapterEnabled) commands.push("`memorax-code-claude status`");
  if (opencodeAdapterEnabled) commands.push("`memorax-code-opencode status`");
  if (commands.length === 1) return commands[0];
  if (commands.length === 2) return `${commands[0]} and ${commands[1]}`;
  return `${commands.slice(0, -1).join(", ")}, and ${commands.at(-1)}`;
}

function printPostinstallSummary(backendAndAdaptersStatus) {
  log("Package: Installed");
  const backendStatusLabel = backendAndAdaptersStatus === "enabled"
    ? blueBold("Enabled")
    : backendAndAdaptersStatus === "unavailable"
      ? redBold("Unavailable")
      : "Not verified";
  log(`Backend and selected adapters: ${backendStatusLabel}`);
  const memoraxStatus = readMemoraxInstallStatus();
  if (!memoraxStatus) {
    logRed("MemoraX memory: Status unavailable");
    log("Run `memorax-cli status` after installation to inspect the effective configuration.");
    return;
  }
  if (!memoraxStatus.configured) {
    log("MemoraX memory: Not configured");
    log(`Package installed, MemoraX not configured. MemoraX Code memory remains unavailable until you connect an account from ${MEMORAX_ACCOUNT_URL}.`);
    return;
  }
  log(`MemoraX memory: ${blueBold("Configured")}`);
  if (memoraxStatus.writebackEnabled) {
    log(`Automatic writeback: ${blueBold("Enabled")}`);
  } else if (!memoraxStatus.globalWritebackEnabled) {
    log("Automatic writeback: Disabled by the global kill switch");
  } else {
    log("Automatic writeback: Disabled by effective configuration");
  }
}

function readMemoraxInstallStatus() {
  const result = runNodeMemoraxCliCommand(
    ["status", "--json", "--config-only"],
    { print: false, timeout: 10_000 },
  );
  if (result.error || result.signal || (result.status !== 0 && result.status !== 1)) {
    return undefined;
  }
  try {
    const report = JSON.parse(String(result.stdout ?? ""));
    if (!isRecord(report)
      || report.action !== "memory.status"
      || report.provider !== "memory.memorax"
      || typeof report.ok !== "boolean"
      || !isRecord(report.config)
      || typeof report.config.configured !== "boolean") {
      return undefined;
    }
    const configuredResult = result.status === 0
      && report.ok === true
      && report.config.configured === true;
    const unconfiguredResult = result.status === 1
      && report.ok === false
      && report.config.configured === false;
    if (!configuredResult && !unconfiguredResult) {
      return undefined;
    }
    if (unconfiguredResult) {
      return { configured: false };
    }
    if (!isRecord(report.config.writeback)
      || typeof report.config.writeback.globalEnabled !== "boolean"
      || typeof report.config.writeback.writebackEnabled !== "boolean") {
      return undefined;
    }
    return {
      configured: true,
      globalWritebackEnabled: report.config.writeback.globalEnabled,
      writebackEnabled: report.config.writeback.writebackEnabled,
    };
  } catch {
    return undefined;
  }
}

function printUnavailableDiagnostics({ codexSkipReason, claudeSkipReason, opencodeSkipReason } = {}) {
  logRed("MemoraX Code is not enabled for new client sessions.");
  logRed("Check `memorax-code status`, `memorax-code-codex status`, `memorax-code-claude status`, and `memorax-code-opencode status` for Backend and adapter details.");
  logRed("If Codex, Claude Code, or OpenCode is open, restart or refresh it after fixing the reported status.");
  if (codexSkipReason) printCodexSkippedDiagnostics(codexSkipReason);
  if (claudeSkipReason) printClaudeSkippedDiagnostics(claudeSkipReason);
  if (opencodeSkipReason) printOpenCodeSkippedDiagnostics(opencodeSkipReason);
  printCommonCommands({
    codexAdapterEnabled: !codexSkipReason,
    claudeAdapterEnabled: !claudeSkipReason,
    opencodeAdapterEnabled: !opencodeSkipReason,
  });
}

function printCodexSkippedDiagnostics(reason) {
  logRed("Codex plugin registration was skipped for this npm postinstall, so MemoraX Code left the Codex plugin unchanged.");
  log("Claude Code can still use MemoraX Code when `memorax-code-claude status` reports the Hook integration is enabled.");
  log("Run `memorax-code start` after installing the Codex plugin, then restart or refresh Codex.");
}

function printClaudeSkippedDiagnostics() {
  logRed("Claude Code adapter setup was skipped for this npm postinstall, so MemoraX Code left the Claude integration unchanged.");
  log("Codex can still use MemoraX Code when `memorax-code-codex status` reports the adapter is enabled.");
  log("Run `memorax-code start` after installing Claude Code, then restart or refresh Claude Code.");
}

function printOpenCodeSkippedDiagnostics() {
  logRed("OpenCode adapter setup was skipped for this npm postinstall, so MemoraX Code left the OpenCode integration unchanged.");
  log("Run `memorax-code start --clients opencode` after installing OpenCode, then restart or refresh OpenCode.");
}

function printFailureSuggestions() {
  logRed("Suggested recovery: run `memorax-code stop`, then `memorax-code start`, then `memorax-code status`.");
  logRed("If the Backend port is busy, stop the process using 127.0.0.1:8787 and retry `memorax-code start`.");
  logRed("If client sessions still bypass MemoraX Code, restart or refresh the affected client and verify the relevant adapter status.");
  printCommonCommands();
}

function printRuntimeAuthorityFailureSuggestions(code) {
  if (code.startsWith("BACKEND_CONNECTION_AUTHORITY_")) {
    logRed("Confirm the intended local Backend bind, then run `memorax-code start --host 127.0.0.1 --port <intended-port>`.");
    logRed("The connection authority is replaced only after that Backend starts successfully; then run `memorax-code status`.");
  } else if (code.startsWith("BACKEND_TOKEN_RECORD_")) {
    logRed("Inspect `memorax-code status`; after safely stopping the managed Backend, run `memorax-code token --rotate`, then `memorax-code start`.");
  } else {
    logRed("Inspect `memorax-code status` and the reported backend.pid.json path; confirm process ownership before repairing or removing that state file.");
  }
  printCommonCommands();
}

function printLifecycleLockFailureSuggestions() {
  logRed("Let the existing lifecycle command finish, then run `memorax-code status`.");
  logRed("If MemoraX Code is not ready, retry `memorax-code start`; do not stop a Backend started by the concurrent owner.");
  printCommonCommands();
}

function printCommonCommands({
  codexAdapterEnabled = true,
  claudeAdapterEnabled = true,
  opencodeAdapterEnabled = true,
} = {}) {
  log("Common commands:");
  log("- `memorax-code status`: check the local backend and adapter state.");
  log("- `memorax-cli status`: check required MemoraX configuration and effective memory switches.");
  log("- `memorax-code start`: start or refresh the local memory backend and client integrations.");
  log("- `memorax-code stop`: stop the local memory backend and disable managed client integrations.");
  if (codexAdapterEnabled) log("- `memorax-code-codex sessions`: verify recent native Codex session registration.");
  if (claudeAdapterEnabled) log("- `memorax-code-claude sessions`: verify recent native Claude Code session registration.");
  if (opencodeAdapterEnabled) log("- `memorax-code-opencode doctor`: verify the managed OpenCode plugin, runtime evidence, and Backend health.");
}

function memoraxCodeEnabled(statusResult, {
  codexAdapterRequired = true,
  claudeAdapterRequired = true,
  opencodeAdapterRequired = true,
} = {}) {
  const output = `${statusResult.stdout ?? ""}\n${statusResult.stderr ?? ""}`;
  const normalized = stripAnsi(output);
  const backendOk = /MemoraX Code Backend status:\s*Enabled\b/im.test(normalized)
    || /MemoraX Code status:\s*Enabled\b/im.test(normalized)
    || /memorax-code:\s*ok\b/im.test(normalized);
  const serviceOk = /Backend status:\s*Enabled\b/im.test(normalized)
    || /Backend:\s*(?:running|ok)\b/im.test(normalized);
  const codexAdapterOk = /Codex adapter:\s*ok\b/im.test(normalized);
  const claudeAdapterOk = /Claude adapter:\s*ok\b/im.test(normalized);
  const opencodeAdapterOk = /OpenCode adapter:\s*ok\b/im.test(normalized);
  return backendOk
    && serviceOk
    && (!codexAdapterRequired || codexAdapterOk)
    && (!claudeAdapterRequired || claudeAdapterOk)
    && (!opencodeAdapterRequired || opencodeAdapterOk);
}

function log(message) {
  logWithPrefix(PREFIX, message);
}

function logGreen(message) {
  console.warn(`${GREEN}${PREFIX} ${message}${RESET}`);
}

function logRed(message) {
  console.warn(`${RED}${PREFIX} ${message}${RESET}`);
}

function logWithPrefix(prefix, message) {
  console.warn(`${prefix} ${message}`);
}

function bold(message) {
  return `${BOLD}${message}\x1b[22m`;
}

function blueBold(message) {
  return `${BLUE}${bold(message)}${RESET}`;
}

function redBold(message) {
  return `${RED}${bold(message)}${RESET}`;
}
