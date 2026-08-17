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
  MEMORAX_DEFAULT_BASE_URL,
  MEMORAX_DEFAULT_MEMORY_OUTPUT_LANGUAGE,
  normalizeMemoraxBaseUrl,
  normalizeMemoraxMemoryOutputLanguage,
} from "../lib/memorax-code-adapter-common/src/memorax-defaults.mjs";
import { writeSetupCompletionRecord } from "../lib/memorax-code-adapter-common/src/setup-completion.mjs";
import { stagePackagedClientHookRuntime } from "../lib/client-hook-runtime.mjs";
import { ensureClaudeCommandEnv } from "../lib/resolve-claude-command.mjs";
import { ensureCodexCommandEnv } from "../lib/resolve-codex-command.mjs";
import { reconcileSetup } from "../lib/setup-reconcile.mjs";
import { ensureTrialSetupCredential } from "../lib/trial-setup.mjs";
import { resolveWindowsCliInvocation } from "../lib/windows-cli-invocation.mjs";

const PLUGIN_NAME = "memorax-code-codex-adapter";
const CLI_MARKETPLACE_NAME = "memorax-code";
const PERSONAL_MARKETPLACE_NAME = "personal";
const PREVIOUS_HOOKS_ENV = "MEMORAX_CODE_CODEX_PREVIOUS_HOOKS_JSON";
const HOOK_TRUST_SELECTION_ENV = "MEMORAX_CODE_CODEX_HOOK_TRUST_SELECTION_JSON";
const PREFIX = "[MemoraX Code Setup]:";
const BACKEND_PREFIX = "[MemoraX Code Backend]:";
const GREEN = "\x1b[32m";
const BLUE = "\x1b[34m";
const RED = "\x1b[31m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const skipCodexPluginInstall = truthyEnv(process.env.MEMORAX_CODE_SKIP_CODEX_PLUGIN_INSTALL);
const skipClaudeAdapterInstall = truthyEnv(process.env.MEMORAX_CODE_SKIP_CLAUDE_ADAPTER_INSTALL);
const updateMode = truthyEnv(process.env.MEMORAX_CODE_SETUP_UPDATE);
const reuseExistingMemorax = truthyEnv(process.env.MEMORAX_CODE_SETUP_REUSE_EXISTING_MEMORAX);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const memoraxCodeBin = join(scriptDir, "memorax-code.mjs");
const memoraxCliBin = join(scriptDir, "memorax-cli.mjs");
const verbose = process.env.MEMORAX_CODE_SETUP_VERBOSE === "1";
const codexRuntime = ensureCodexCommandEnv();
const codexCommand = codexRuntime.command;
const claudeRuntime = ensureClaudeCommandEnv();
const claudeCommand = claudeRuntime.command;
const previousClients = readPersistedClientSelection();
const existingSetup = previousClients !== undefined;
if (!canPromptOnStderr()) {
  logRed("Setup requires an interactive terminal.");
  log("Run `memorax-code setup` from a terminal, or use `memorax-code status` to inspect an existing setup.");
  process.exit(1);
}
const scriptedAnswers = process.stdin.isTTY !== true
  ? parseScriptedAnswers(readFileSync(0, "utf8"))
  : undefined;
if (seedMissingMemoraxCodeConfig() === "failed") {
  printPostinstallSummary("not-verified");
  process.exit(1);
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
  process.exit(1);
}
runCommonPreflight();
const requestedClients = ["codex", "claude"];
const codexPreflight = requestedClients.includes("codex") && !skipCodexPluginInstall
  ? runCodexPreflight({
      integrationSelected: !existingSetup || previousClients.includes("codex"),
    })
  : { ok: true, pluginCache: { marketplaceName: CLI_MARKETPLACE_NAME, versions: [] } };
const claudePreflight = requestedClients.includes("claude") && !skipClaudeAdapterInstall
  ? runClaudePreflight({
      integrationSelected: !existingSetup || previousClients.includes("claude"),
    })
  : { ok: true };
const detectedClients = requestedClients.filter((client) => {
  if (client === "codex") return !skipCodexPluginInstall && codexPreflight.ok;
  return !skipClaudeAdapterInstall && claudePreflight.ok;
});
const selectedClients = existingSetup
  ? await chooseUpdateClients(previousClients, detectedClients, scriptedAnswers)
  : detectedClients;
const installClients = detectedClients.filter((client) => selectedClients.includes(client));
if (existingSetup) {
  log(clientSelectionMessage(selectedClients));
} else {
  log(detectedClientMessage(installClients));
}
if (requestedClients.includes("codex") && !skipCodexPluginInstall && !codexPreflight.ok) {
  log("Codex runtime was not detected; skipping its adapter setup.");
}
if (requestedClients.includes("claude") && !skipClaudeAdapterInstall && !claudePreflight.ok) {
  log("Claude Code runtime was not detected; skipping its adapter setup.");
}
if (writeClientSelectionConfig(selectedClients) === "failed") {
  printPostinstallSummary("not-verified");
  process.exit(1);
}
const clientMode = clientModeFor(installClients);
let memoraxConfigResult = "skipped";
if (!updateMode) {
  const existingMemoraxStatus = reuseExistingMemorax
    ? readMemoraxInstallStatus()
    : undefined;
  if (existingMemoraxStatus?.configured) {
    printMemoraxDisclosure();
    if (await shouldReuseExistingMemoraxConfiguration(scriptedAnswers)) {
      memoraxConfigResult = "preserved";
    } else {
      memoraxConfigResult = await maybeConfigureMemoraxMemory(scriptedAnswers, { showDisclosure: false });
    }
  } else {
    memoraxConfigResult = await maybeConfigureMemoraxMemory(scriptedAnswers);
  }
}
if (!updateMode && memoraxConfigResult !== "configured" && memoraxConfigResult !== "preserved") {
  printPostinstallSummary("not-verified");
  process.exit(1);
}
if (memoraxConfigResult === "configured") {
  if (seedMissingMemoraxCodeConfig() === "failed") {
    printPostinstallSummary("not-verified");
    process.exit(1);
  }
}
const codexClientEnabled = installClients.includes("codex");
const claudeClientEnabled = installClients.includes("claude");
const codexClientNewlyEnabled = codexClientEnabled
  && existingSetup
  && !previousClients.includes("codex");
const codexPluginRequiresActivation = codexClientEnabled
  && codexPreflight.pluginCache.versions.length === 0;
const codexHooksBeforeUpdate = codexClientEnabled
  && existingSetup
  && !codexClientNewlyEnabled
  && !codexPluginRequiresActivation
  ? inspectCodexPluginHooksForUpdate()
  : undefined;
const result = codexClientEnabled
  ? runNodeMemoraxCodeCommand(["codex-plugin", "install", "--json"], { print: verbose })
  : { status: 0 };

if (codexClientEnabled && result.status !== 0) {
  logRed("MemoraX Code Codex plugin registration failed. Run `memorax-code setup` again after correcting the reported problem.");
  printPostinstallSummary("not-verified");
  process.exit(1);
}

if (codexClientEnabled && result.status === 0) {
  if (existingSetup && (codexClientNewlyEnabled || codexPluginRequiresActivation)) {
    activateCodexPluginHooks();
  } else if (existingSetup) {
    await maybeTrustUpdatedCodexPluginHooks(scriptedAnswers, codexHooksBeforeUpdate);
  } else {
    activateCodexPluginHooks();
  }
}
const skipCodexAdapter = !codexClientEnabled;
const skipClaudeAdapter = !claudeClientEnabled;
const codexSkipReason = setupClientSkipReason({
  explicitlySkipped: skipCodexPluginInstall,
  selected: selectedClients.includes("codex"),
  enabled: codexClientEnabled,
});
const claudeSkipReason = setupClientSkipReason({
  explicitlySkipped: skipClaudeAdapterInstall,
  selected: selectedClients.includes("claude"),
  enabled: claudeClientEnabled,
});

const backendAndAdaptersStatus = await startBackendAndCheck({
  skipCodexAdapter,
  clientMode,
  codexSkipReason,
  skipClaudeAdapter,
  claudeAdapterRequired: !skipClaudeAdapter,
  claudeSkipReason,
});
if (backendAndAdaptersStatus === "enabled") {
  logGreen(`Client Hook runtime ${stagedHookRuntime.generationId} activated.`);
}
if (backendAndAdaptersStatus === "enabled") {
  printNextSteps({ codexAdapterEnabled: !skipCodexAdapter, claudeAdapterEnabled: !skipClaudeAdapter });
  printCommonCommands({ codexAdapterEnabled: !skipCodexAdapter, claudeAdapterEnabled: !skipClaudeAdapter });
}
printPostinstallSummary(backendAndAdaptersStatus);
if (backendAndAdaptersStatus === "enabled") {
  log("View local memory activity: http://127.0.0.1:8787/memory-viewer");
}
if (backendAndAdaptersStatus !== "enabled") process.exit(1);
if (!updateMode && readMemoraxInstallStatus()?.configured !== true) {
  logRed("Setup could not verify a ready MemoraX connection after Backend reconciliation.");
  process.exit(1);
}
try {
  const completion = writeSetupCompletionRecord({
    memoraxCodeHome: memoraxCodeHome(),
    completedAt: new Date().toISOString(),
    completedByVersion: packageVersion(),
  });
  if (completion.durability === "uncertain") {
    logRed("Setup completed, but durable persistence of the completion record could not be confirmed.");
  }
} catch (error) {
  logRed(`Setup completion could not be recorded: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
logGreen("Setup completed successfully.");
process.exit(0);

async function shouldReuseExistingMemoraxConfiguration(scriptedAnswers) {
  const question = "Existing MemoraX configuration detected. Use the saved connection and memory preferences? [Y/n]";
  let answer;
  if (scriptedAnswers) {
    log(question);
    answer = String(scriptedAnswers.shift() ?? "").trim();
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      answer = (await rl.question(`${PREFIX} ${question} `)).trim();
    } finally {
      rl.close();
    }
  }
  if (/^n(?:o)?$/i.test(answer)) {
    log("Existing MemoraX configuration was not selected; continuing with MemoraX reconfiguration.");
    return false;
  }
  logGreen("Reusing the existing MemoraX connection and memory preferences.");
  return true;
}

async function maybeConfigureMemoraxMemory(scriptedAnswers, { showDisclosure = true } = {}) {
  if (showDisclosure) printMemoraxDisclosure();
  if (scriptedAnswers) {
    return await configureMemoraxMemoryFromAnswers(scriptedAnswers);
  }
  let rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const userId = (await rl.question(`${PREFIX} User ID (used for your memories): `)).trim();
    const outputLanguage = await questionPreferredLanguage(rl);
    const existingAccount = await questionExistingMemoraxAccount(rl);
    if (existingAccount) {
      rl.close();
      rl = undefined;
      const apiKey = (await questionMasked(`${PREFIX} MemoraX API key: `)).trim();
      return await writeMemoraxConfigFromInput({
        userId,
        endpoint: memoraxInstallEndpoint(),
        outputLanguage,
        existingAccount,
        apiKey,
      });
    }
    return await writeMemoraxConfigFromInput({
      userId,
      endpoint: memoraxInstallEndpoint(),
      outputLanguage,
      existingAccount,
    });
  } finally {
    rl?.close();
  }
}

async function chooseUpdateClients(previousClients, detectedClients, scriptedAnswers) {
  const selected = new Set(previousClients);
  const availableDisabledClients = detectedClients.filter((client) => !selected.has(client));
  if (availableDisabledClients.length === 0) return [...previousClients];

  let rl;
  try {
    for (const client of availableDisabledClients) {
      const label = client === "codex" ? "Codex" : "Claude Code";
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
  return ["codex", "claude"].filter((client) => selected.has(client));
}

async function configureMemoraxMemoryFromAnswers(answers) {
  const userId = String(answers.shift() ?? "").trim();
  log(`User ID: ${userId ? "<provided>" : "<missing>"}`);
  const outputLanguageAnswer = String(answers.shift() ?? "").trim();
  log(`Preferred language [ZH/en] (used for Memory extraction): ${outputLanguageAnswer ? "<provided>" : "<default>"}`);
  log("Do you already have a MemoraX account? [y/N]");
  const existingAccount = /^y(?:es)?$/i.test(String(answers.shift() ?? "").trim());
  const apiKey = existingAccount
    ? String(answers.shift() ?? "").trim()
    : undefined;
  if (existingAccount) log(`MemoraX API key: ${apiKey ? "<provided>" : "<missing>"}`);
  return await writeMemoraxConfigFromInput({
    userId,
    endpoint: memoraxInstallEndpoint(),
    outputLanguage: preferredLanguage(outputLanguageAnswer),
    existingAccount,
    apiKey,
  });
}

function printMemoraxDisclosure() {
  log("MemoraX Code requires MemoraX for its core remote-memory functionality.");
  log("After connection, trusted repository sessions automatically send selected user prompts and final assistant answers to MemoraX after replies.");
  log("Newly generated configuration enables automatic writeback. Existing configuration is never enabled implicitly; disable it with `[memory.writeback] enabled = false` or `MEMORAX_CODE_MEMORAX_WRITEBACK_ENABLED=false`.");
}

async function writeMemoraxConfigFromInput({
  userId,
  endpoint,
  outputLanguage,
  existingAccount,
  apiKey,
}) {
  if (!userId) {
    logRed("MemoraX config was not written because User ID was empty.");
    return "failed";
  }
  if (!outputLanguage) {
    logRed("MemoraX config was not written because preferred language must be zh or en.");
    return "failed";
  }
  if (existingAccount) {
    if (!apiKey) {
      logRed("MemoraX config was not written because API key was empty.");
      return "failed";
    }
    if (writeMemoraxConfig({ userId, endpoint, outputLanguage, apiKey }) === "failed") {
      logRed("MemoraX config was not written because the existing config could not be safely updated.");
      return "failed";
    }
    logGreen("Existing MemoraX account connection configured.");
    logGreen(`MemoraX config written to ${memoraxCodeConfigPath()}.`);
    log("MemoraX network access will be checked by the first workspace-scoped memory request from a trusted workspace.");
    return "configured";
  }
  log("Creating or restoring a secure MemoraX trial credential...");
  try {
    await ensureTrialSetupCredential({
      memoraxCodeHome: memoraxCodeHome(),
      env: process.env,
    });
  } catch (error) {
    const reason = typeof error?.reason === "string" ? error.reason : "credential_unavailable";
    logRed(`Secure MemoraX trial setup failed (${reason}).`);
    return "failed";
  }
  if (writeMemoraxConfig({ userId, endpoint, outputLanguage }) === "failed") {
    logRed("MemoraX config was not written because the existing config could not be safely updated.");
    return "failed";
  }
  logGreen("Secure MemoraX trial credential is ready.");
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

async function questionExistingMemoraxAccount(rl) {
  const answer = await rl.question(`${PREFIX} Do you already have a MemoraX account? [y/N] `);
  return /^y(?:es)?$/i.test(answer.trim());
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

function activateCodexPluginHooks() {
  const activated = runNodeMemoraxCodeCommand(["codex-plugin", "activate", "--yes"], { print: verbose });
  if (activated.status === 0) {
    logGreen("MemoraX Code Codex Adapter hooks activated and trusted.");
    return "activated";
  }
  logRed("Codex hook activation failed; run `memorax-code codex-plugin activate --yes` after installation.");
  return "failed";
}

function canPromptForUpdate() {
  return canPromptOnStderr();
}

function canPromptOnStderr() {
  return process.env.MEMORAX_CODE_SETUP_ASSUME_INTERACTIVE === "1"
    || (process.stdin.isTTY === true && process.stderr.isTTY === true);
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
    return [clients.codex ? "codex" : undefined, clients.claude ? "claude" : undefined].filter(Boolean);
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
  const withClaude = setTomlField(text, "clients", "claude", String(clients.includes("claude")));
  return setTomlField(withClaude, "clients", "codex", String(clients.includes("codex")));
}

function writeMemoraxConfig({ userId, endpoint, outputLanguage, apiKey }) {
  const path = memoraxCodeConfigPath();
  const fields = [
    {
      key: "endpoint",
      line: `endpoint = "${tomlString(endpoint || MEMORAX_DEFAULT_BASE_URL)}" # MemoraX service URL.`,
    },
    {
      key: "user_id",
      line: `user_id = "${tomlString(userId)}" # Stable User ID; requests derive a workspace-scoped namespace.`,
    },
  ];
  const addFields = [{
    key: "output_language",
    line: `output_language = "${outputLanguage}" # Language for newly generated MemoraX memories.`,
  }];
  const applyFields = (text) => {
    const withSelectedApiKey = apiKey
      ? setTomlSectionFields(text, "memorax", [{
        key: "api_key",
        line: `api_key = "${tomlString(apiKey)}" # MemoraX API key used by the local Backend.`,
      }])
      : setTomlField(text, "memorax", "api_key", undefined);
    return setTomlSectionFields(
      setTomlSectionFields(withSelectedApiKey, "memorax", fields),
      "memory.add",
      addFields,
    );
  };
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
    "",
    "# MemoraX remote-memory connection.",
    "[memorax]",
    `# endpoint = "${MEMORAX_DEFAULT_BASE_URL}" # MemoraX service URL.`,
    '# user_id = "" # Stable User ID; requests derive a workspace-scoped namespace.',
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
    "# Controls how often Codex and Claude Code native client sessions see the MemoraX Code skill reminder.",
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
  log("Checking local setup state...");
  if (existingSetup) log("Existing setup detected; preserving configured client intent while checking availability.");
  const memoraxCodeVersion = runNodeMemoraxCodeCommand(["--version"], { print: false });
  log(`MemoraX Code backend package: ${commandSummary(memoraxCodeVersion) ?? packageVersionSummary()}`);
  if (skipCodexPluginInstall) {
    log("Codex plugin registration is disabled for this setup; Backend and Claude Code setup can still continue.");
  }
  if (skipClaudeAdapterInstall) {
    log("Claude Code adapter setup is disabled for this setup; Backend and Codex setup can still continue.");
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

async function startBackendAndCheck({ skipCodexAdapter = false, clientMode = "all", codexSkipReason, skipClaudeAdapter = false, claudeAdapterRequired = !skipClaudeAdapter, claudeSkipReason } = {}) {
  const adapterFlags = clientLifecycleFlags({ clientMode });
  const startArgs = ["start", ...adapterFlags];
  const statusArgs = ["status", ...adapterFlags];
  const result = await reconcileSetup({
    start: () => runMemoraxCodeCommand(startArgs, pendingClientHookRuntimeEnv()),
    stop: () => runMemoraxCodeCommand(["stop", ...adapterFlags]),
    status: () => runMemoraxCodeCommand(statusArgs),
    isReady: (checked) => memoraxCodeEnabled(checked, {
      codexAdapterRequired: !skipCodexAdapter,
      claudeAdapterRequired,
    }),
    onEvent: (event) => {
      if (event.type === "start" && event.attempt === 1) {
        logGreen("Starting backend with `memorax-code start`...");
      } else if (event.type === "start-failed" && event.attempt === 1) {
        logRed("Backend start failed during setup.");
      } else if (event.type === "stop") {
        logRed("Attempting automatic recovery: `memorax-code stop` then `memorax-code start`...");
      } else if (event.type === "diagnostic-status") {
        logRed("Automatic recovery did not start the backend.");
        logRed("Diagnostic: running `memorax-code status` so the failure is visible.");
      } else if (event.type === "start-succeeded") {
        logGreen(event.recovered
          ? "Backend start completed after automatic recovery."
          : "Backend start completed.");
      } else if (event.type === "status") {
        log("Checking backend status with `memorax-code status`...");
      } else if (event.type === "status-failed") {
        logRed("Backend status check failed during setup.");
        printFailureSuggestions();
      } else if (event.type === "status-succeeded") {
        logGreen("Backend status check completed.");
      } else if (event.type === "complete") {
        printReconcileFailure(event, { skipCodexAdapter, codexSkipReason, skipClaudeAdapter, claudeSkipReason });
      }
    },
  });
  return result.status;
}

function printReconcileFailure(result, { skipCodexAdapter, codexSkipReason, skipClaudeAdapter, claudeSkipReason }) {
  if (result.reason === "hook-runtime-activation-failed") {
    logRed("Client Hook runtime activation failed; automatic lifecycle recovery was skipped.");
    logRed("The previously active runtime remains authoritative.");
  } else if (result.reason === "lifecycle-lock-timeout") {
    logRed("Automatic stop/start recovery is skipped because another MemoraX Code lifecycle command still owns the Backend authority.");
    printLifecycleLockFailureSuggestions();
  } else if (result.reason === "runtime-authority-failed") {
    logRed("Automatic stop/start recovery is skipped because persisted Backend runtime authority requires explicit repair.");
    printRuntimeAuthorityFailureSuggestions(result.code);
  } else if (result.reason === "start-failed-after-recovery") {
    printFailureSuggestions();
  } else if (result.reason === "not-ready") {
    if (skipCodexAdapter || skipClaudeAdapter) {
      printSkippedAdapterDiagnostics({ codexSkipReason, claudeSkipReason });
    } else {
      printUnavailableDiagnostics();
    }
  }
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

function clientLifecycleFlags({ clientMode = "all" } = {}) {
  return ["--clients", clientMode];
}

function clientModeFor(clients) {
  const hasCodex = clients.includes("codex");
  const hasClaude = clients.includes("claude");
  if (hasCodex && hasClaude) return "all";
  if (hasCodex) return "codex";
  if (hasClaude) return "claude";
  return "none";
}

function setupClientSkipReason({ explicitlySkipped, selected, enabled }) {
  if (explicitlySkipped) return "setup-skip";
  if (selected && !enabled) return "client-not-detected";
  return enabled ? undefined : "client-selection";
}

function clientSelectionMessage(clients) {
  const hasCodex = clients.includes("codex");
  const hasClaude = clients.includes("claude");
  if (hasCodex && hasClaude) return "Configuring MemoraX Code for Codex and Claude Code.";
  if (hasCodex) return "Configuring MemoraX Code for Codex only.";
  if (hasClaude) return "Configuring MemoraX Code for Claude Code only.";
  return "Skipping client adapter setup for this setup.";
}

function detectedClientMessage(clients) {
  if (clients.length === 0) {
    return "No supported client runtime was detected; starting the shared Backend without client adapters.";
  }
  return `Detected supported client runtimes. ${clientSelectionMessage(clients)}`;
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
  const version = packageVersion();
  return version === "unknown"
    ? "installed, version unavailable"
    : `installed (${version}), command version unavailable`;
}

function packageVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(dirname(scriptDir), "package.json"), "utf8"));
    if (typeof pkg.version === "string" && pkg.version.trim()) return pkg.version.trim();
  } catch {
    // Ignore package metadata errors; this is a best-effort install preflight.
  }
  return "unknown";
}

function codexClientRunning() {
  const result = process.platform === "win32"
    ? runExternalCommand("tasklist.exe", ["/FO", "CSV", "/NH"], { print: false })
    : runExternalCommand("ps", ["-axo", "comm=,args="], { print: false });
  if (result.status !== 0) return false;
  return String(result.stdout ?? "").split(/\r?\n/).some((line) => {
    const lower = line.toLowerCase();
    if (!lower.includes("codex")) return false;
    if (lower.includes("memorax-code-setup")) return false;
    return process.platform === "win32"
      ? /"codex(?:\.exe)?"/i.test(line)
      : lower.includes("codex.app") || /(^|[/\s])codex(\s|$)/i.test(line);
  });
}

function printNextSteps({ codexAdapterEnabled = true, claudeAdapterEnabled = true } = {}) {
  const clientText = enabledClientText({ codexAdapterEnabled, claudeAdapterEnabled });
  if (clientText && existingSetup) {
    logGreen(`${bold("The new Hook runtime is active")}; existing sessions with the stable shell select it on their next user prompt.`);
    log(`Restart or refresh ${clientText} only if its plugin shell was installed, changed, or newly enabled, or if MemoraX Code is not active on the next prompt.`);
  } else if (clientText) {
    logGreen(`${bold(`Restart or refresh ${clientText}`)} before opening a new MemoraX Code session.`);
  } else {
    logGreen(`${bold("MemoraX Code backend is running")}; client adapters were skipped for this install.`);
  }
  if (codexAdapterEnabled && !existingSetup) {
    logGreen(`After restart, ${bold("enable the MemoraX Code Codex Adapter plugin")} from Codex Plugins or CLI \`/plugins\` if it is not already enabled.`);
  }
  const statusCommands = statusCommandText({ codexAdapterEnabled, claudeAdapterEnabled });
  log(`If MemoraX Code is not active ${existingSetup ? "on the next prompt" : "in new sessions"}, run ${statusCommands}.`);
}

function enabledClientText({ codexAdapterEnabled = true, claudeAdapterEnabled = true } = {}) {
  if (codexAdapterEnabled && claudeAdapterEnabled) return "Codex or Claude Code";
  if (codexAdapterEnabled) return "Codex";
  if (claudeAdapterEnabled) return "Claude Code";
  return "";
}

function statusCommandText({ codexAdapterEnabled = true, claudeAdapterEnabled = true } = {}) {
  const commands = ["`memorax-code status`"];
  if (codexAdapterEnabled) commands.push("`memorax-code-codex status`");
  if (claudeAdapterEnabled) commands.push("`memorax-code-claude status`");
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
    log("Package installed, MemoraX not configured. Run `memorax-code setup` from a terminal to finish setup.");
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

function printUnavailableDiagnostics() {
  logRed("MemoraX Code is not enabled for new client sessions.");
  logRed("Check `memorax-code status`, `memorax-code-codex status`, and `memorax-code-claude status` for Backend and adapter details.");
  logRed("If Codex or Claude Code is open, restart or refresh it after fixing the reported status.");
  printCommonCommands();
}

function printSkippedAdapterDiagnostics({ codexSkipReason, claudeSkipReason } = {}) {
  if (codexSkipReason) printCodexSkippedDiagnostics(codexSkipReason);
  if (claudeSkipReason) printClaudeSkippedDiagnostics(claudeSkipReason);
  printCommonCommands({
    codexAdapterEnabled: !codexSkipReason,
    claudeAdapterEnabled: !claudeSkipReason,
  });
}

function printCodexSkippedDiagnostics(reason) {
  logRed("Codex plugin registration was skipped for this setup, so MemoraX Code left the Codex plugin unchanged.");
  log("Claude Code can still use MemoraX Code when `memorax-code-claude status` reports the Hook integration is enabled.");
  log("Run `memorax-code start` after installing the Codex plugin, then restart or refresh Codex.");
}

function printClaudeSkippedDiagnostics() {
  logRed("Claude Code adapter setup was skipped for this setup, so MemoraX Code left the Claude integration unchanged.");
  log("Codex can still use MemoraX Code when `memorax-code-codex status` reports the adapter is enabled.");
  log("Run `memorax-code start` after installing Claude Code, then restart or refresh Claude Code.");
}

function printFailureSuggestions() {
  logRed("Suggested recovery: run `memorax-code stop`, then `memorax-code start`, then `memorax-code status`.");
  logRed("If the Backend port is busy, stop the process using 127.0.0.1:8787 and retry `memorax-code start`.");
  logRed("If client sessions still bypass MemoraX Code, restart or refresh Codex or Claude Code and verify the relevant adapter status.");
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

function printCommonCommands({ codexAdapterEnabled = true, claudeAdapterEnabled = true } = {}) {
  log("Common commands:");
  log("- `memorax-code status`: check the local backend and adapter state.");
  log("- `memorax-cli status`: check required MemoraX configuration and effective memory switches.");
  log("- `memorax-code start`: start or refresh the local memory backend and client integrations.");
  log("- `memorax-code stop`: stop the local memory backend and disable managed client integrations.");
  if (codexAdapterEnabled) log("- `memorax-code-codex sessions`: verify recent native Codex session registration.");
  if (claudeAdapterEnabled) log("- `memorax-code-claude sessions`: verify recent native Claude Code session registration.");
}

function memoraxCodeEnabled(statusResult, { codexAdapterRequired = true, claudeAdapterRequired = true } = {}) {
  const output = `${statusResult.stdout ?? ""}\n${statusResult.stderr ?? ""}`;
  const normalized = stripAnsi(output);
  const backendOk = /MemoraX Code Backend status:\s*Enabled\b/im.test(normalized)
    || /MemoraX Code status:\s*Enabled\b/im.test(normalized)
    || /memorax-code:\s*ok\b/im.test(normalized);
  const serviceOk = /Backend status:\s*Enabled\b/im.test(normalized)
    || /Backend:\s*(?:running|ok)\b/im.test(normalized);
  const codexAdapterOk = /Codex adapter:\s*ok\b/im.test(normalized);
  const claudeAdapterOk = /Claude adapter:\s*ok\b/im.test(normalized);
  return backendOk
    && serviceOk
    && (!codexAdapterRequired || codexAdapterOk)
    && (!claudeAdapterRequired || claudeAdapterOk);
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
