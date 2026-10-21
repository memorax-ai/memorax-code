import { execFile } from "node:child_process";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, delimiter, dirname, join } from "node:path";
import { promisify } from "node:util";
import { check, createNativeHarness, fixtureModel, waitFor } from "./claude-native-support.mjs";
import { selectNativeMemoraxPlugin, selectNativeTurnContent } from "./claude-native-content-check.mjs";
import { assertBackgroundJob, assertBackgroundModelRequests, assertBackgroundNoopResult, backgroundInputText,
  backgroundProcessesExited, workerPromptMarker, foregroundPrompt, foregroundAnswer, backgroundAnswer,
} from "./claude-background-assertions.mjs";

const execFileAsync = promisify(execFile);

export async function verifyBackgroundGlobalConfiguration(parent, result) {
  let harness, repository, snapshotHead, stage = "harness creation", primaryError;
  let foregroundStarted = false, foregroundFinished = false;
  const requests = { foreground: 0, background: 0 };
  Object.assign(result, { status: "FAIL", repoMemoryBuildValidated: false, modelOverrideInheritanceValidated: false,
    permissionInheritanceValidated: false, backgroundNativeSessionIdentityValidated: false, fixtureArtifactsInjected: false });
  const jobs = async () => {
    const jobsRoot = join(harness.stateHome, "repo-memory-jobs");
    const files = await readdir(jobsRoot, { recursive: true }).catch((error) => {
      if (error.code === "ENOENT") return []; throw error;
    });
    const entries = [];
    for (const file of files.filter((file) => basename(file) === "job.json")) {
      const jobPath = join(jobsRoot, file);
      const job = JSON.parse(await readFile(jobPath, "utf8"));
      assertBackgroundJob(job, { jobPath, repository, snapshotHead, claudeCommand: harness.claudeCommand });
      entries.push(job);
    }
    return entries;
  };
  try {
    harness = await createNativeHarness({ packageRoot: parent.packageRoot, claudeCommand: parent.claudeCommand,
      expectedVersion: parent.claudeVersion, label: "background", writeback: false });
    repository = await realpath(harness.workspace);
    harness.setBeforeClose(async () => {
      if (!foregroundStarted) return;
      // The product bounds its detached worker. Do not signal potentially reused
      // PIDs from old records; uncertain shutdown keeps the isolated root intact.
      await waitFor(async () => {
        const observed = await jobs();
        return observed.length > 0 && backgroundProcessesExited(observed, processPresent);
      }, "BACKGROUND_PROCESS_CLEANUP_UNVERIFIED", 35_000);
      check(foregroundFinished, "BACKGROUND_FOREGROUND_CLEANUP_UNVERIFIED");
    });
    for (const name of Object.keys(harness.env).filter((name) => name.startsWith("ANTHROPIC_"))) delete harness.env[name];
    Object.assign(harness.env, { MEMORAX_CODE_REPO_MEMORY_JOB_TIMEOUT_MS: "30000", MEMORAX_CODE_REPO_MEMORY_JOB_KILL_GRACE_MS: "1000",
      GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.multiPackIndex", GIT_CONFIG_VALUE_0: "false" });
    stage = "repository setup";
    const gitName = process.platform === "win32" ? "git.exe" : "git";
    let gitCommand;
    for (const directory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
      const candidate = join(directory, gitName);
      if (await stat(candidate).then((info) => info.isFile(), () => false)) { gitCommand = candidate; break; }
    }
    check(gitCommand, "BACKGROUND_FIXTURE_REQUIRES_GIT");
    harness.env.PATH += `${delimiter}${dirname(gitCommand)}`;
    const git = (args) => execFileAsync(gitCommand, ["-c", "core.multiPackIndex=false", ...args],
      { cwd: repository, env: harness.env, timeout: 10_000, windowsHide: true });
    await git(["init", "--quiet"]);
    await git(["-c", "user.name=Native Fixture", "-c", "user.email=native@example.invalid", "commit", "--allow-empty",
      "--no-gpg-sign", "--quiet", "-m", "test: native global configuration fixture"]);
    await git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    await git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    snapshotHead = (await git(["rev-parse", "HEAD"])).stdout.trim();
    stage = "installed plugin setup";
    await harness.setup();
    harness.setModelHandler((body) => {
      const kind = backgroundInputText(body).includes(workerPromptMarker) ? "background" : "foreground";
      requests[kind]++;
      check(requests[kind] === 1, "UNEXPECTED_BACKGROUND_MODEL_CONTINUATION");
      return { text: kind === "background" ? backgroundAnswer : foregroundAnswer };
    });
    stage = "native foreground without model overrides";
    foregroundStarted = true;
    const output = await harness.runClaude(["-p", foregroundPrompt, "--output-format", "stream-json", "--verbose",
      "--permission-mode", "dontAsk", "--setting-sources", "user", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}']);
    foregroundFinished = true;
    const events = output.stdout.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const init = events.filter((event) => event.type === "system" && event.subtype === "init");
    const completed = events.filter((event) => event.type === "result");
    check(init.length === 1 && init[0].model === fixtureModel && completed.length === 1
      && completed[0].subtype === "success" && completed[0].is_error === false
      && completed[0].result === foregroundAnswer && completed[0].session_id === init[0].session_id,
    "BACKGROUND_FOREGROUND_CONFIGURATION_MISMATCH");
    selectNativeMemoraxPlugin(init[0].plugins);
    const final = events.filter((event) => event.type === "assistant" && event.parent_tool_use_id === null
      && event.session_id === init[0].session_id && event.message?.model === fixtureModel
      && event.message.content?.filter((part) => part.type === "text").map((part) => part.text).join("\n\n") === foregroundAnswer);
    check(final.length === 1 && typeof final[0].uuid === "string", "BACKGROUND_FOREGROUND_FINAL_IDENTITY_MISSING");
    stage = "native foreground transcript";
    await waitFor(async () => {
      const projects = join(harness.claudeHome, "projects");
      const paths = (await readdir(projects, { recursive: true })).filter((file) => basename(file) === `${init[0].session_id}.jsonl`);
      check(paths.length <= 1, "BACKGROUND_FOREGROUND_TRANSCRIPT_NOT_UNIQUE");
      if (!paths.length) return false;
      const records = (await readFile(join(projects, paths[0]), "utf8")).trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);
      if (!records.some((record) => record.uuid === final[0].uuid)) return false;
      const selected = selectNativeTurnContent(records, { sessionId: init[0].session_id, assistantUuid: final[0].uuid,
        prompt: foregroundPrompt, answer: foregroundAnswer });
      for (const record of selected.lineage) check(await realpath(record.cwd) === repository, "BACKGROUND_NATIVE_WORKSPACE_MISMATCH");
      return true;
    }, "BACKGROUND_FOREGROUND_TRANSCRIPT_MISSING");
    stage = "background worker result";
    const [job] = await waitFor(async () => {
      const observed = await jobs();
      check(observed.length <= 1, "BACKGROUND_JOB_NOT_UNIQUE");
      return observed.length === 1 && ["failed", "succeeded"].includes(observed[0].status) ? observed : false;
    }, "BACKGROUND_JOB_DID_NOT_FINISH", 45_000);
    assertBackgroundNoopResult(job, await readFile(job.finalMessagePath, "utf8"));
    assertBackgroundModelRequests(harness.modelRequests, job.prompt);
    check(harness.memoryRequests.length === 0 && harness.serverErrors.length === 0, "BACKGROUND_UNEXPECTED_RECEIVER_ACTIVITY");
    check(await stat(join(repository, ".repo_memory", "PROFILE.md")).then(() => false,
      (error) => { if (error.code === "ENOENT") return true; throw error; }), "BACKGROUND_UNEXPECTED_PROFILE_ARTIFACT");
    stage = "detached process exit";
    await waitFor(() => backgroundProcessesExited([job], processPresent), "BACKGROUND_PROCESS_REMAINS");
    Object.assign(result, { status: "PASS", model: fixtureModel, provider: "local_anthropic_messages",
      globalSettingsOnly: true, foregroundRequests: 1, backgroundRequests: 1, foregroundNativeTranscriptValidated: true,
      backgroundOutputSource: "native Claude stdout", jobStatus: "failed", expectedFailure: "artifact_validation_failed" });
  } catch (error) {
    primaryError = error;
    Object.assign(result, { stage, error: error.nativeCode ?? "BACKGROUND_CHECK_FAILED_PRIVATE_OUTPUT_SUPPRESSED",
      foregroundRequests: requests.foreground, backgroundRequests: requests.background, receiverErrors: harness?.serverErrors ?? [] });
    throw error;
  } finally {
    try { await harness?.close(); result.cleanup = "PASS"; }
    catch (error) {
      result.status = "FAIL";
      result.cleanup = error.nativeCode ?? "BACKGROUND_CLEANUP_FAILED";
      if (!primaryError) throw error;
    }
  }
}

function processPresent(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; if (error.code === "EPERM") return true; throw error; }
}
