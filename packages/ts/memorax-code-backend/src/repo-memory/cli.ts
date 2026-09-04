import { executeCollectAll, collectAllUsage } from "./collect-all.js";
import { executeDetectUpdates, detectUpdatesUsage } from "./detect-updates.js";
import { executeGitCommitFacets, gitCommitFacetsUsage } from "./git-commit-facets.js";
import { executeGithubFacets, githubFacetsUsage } from "./github-resource-facets.js";
import { executeGitlabFacets, gitlabFacetsUsage } from "./gitlab-resource-facets.js";
import { executePrepare, prepareUsage } from "./prepare.js";
import type { CommandOutput, RepoMemoryContext } from "./shared.js";
import { executeValidate, validateUsage } from "./validate.js";

export async function runRepoMemoryCli(args: string[], context: RepoMemoryContext): Promise<number> {
  const [command, ...rawCommandArgs] = args;
  const commandArgs = expandInlineLongOptions(rawCommandArgs);
  let output: CommandOutput;
  if (command === "prepare") output = executePrepare(commandArgs);
  else if (command === "git-commits") output = executeGitCommitFacets(commandArgs);
  else if (command === "github-facets") output = await executeGithubFacets(commandArgs);
  else if (command === "gitlab-facets") output = await executeGitlabFacets(commandArgs);
  else if (command === "collect") output = await executeCollectAll(commandArgs, context);
  else if (command === "detect-updates") output = await executeDetectUpdates(commandArgs, context);
  else if (command === "validate") output = executeValidate(commandArgs);
  else if (command === "--help" || command === "-h") {
    output = { exitCode: 0, stdout: `${usage()}\n`, stderr: "" };
  } else {
    output = {
      exitCode: 2,
      stdout: "",
      stderr: `${command ? `memorax-code repo-memory: unknown command '${command}'\n` : ""}${usage()}\n`,
    };
  }
  if (output.stdout) process.stdout.write(output.stdout);
  if (output.stderr) process.stderr.write(output.stderr);
  return output.exitCode;
}

function expandInlineLongOptions(args: string[]): string[] {
  return args.flatMap((arg) => {
    const separator = arg.startsWith("--") ? arg.indexOf("=") : -1;
    return separator >= 3 ? [arg.slice(0, separator), arg.slice(separator + 1)] : [arg];
  });
}

function usage(): string {
  return [
    "Usage: memorax-code repo-memory <command> [options]",
    "",
    "Commands:",
    `  ${prepareUsage()}`,
    `  ${gitCommitFacetsUsage()}`,
    `  ${githubFacetsUsage()}`,
    `  ${gitlabFacetsUsage()}`,
    `  ${collectAllUsage()}`,
    `  ${detectUpdatesUsage()}`,
    `  ${validateUsage()}`,
  ].join("\n");
}
