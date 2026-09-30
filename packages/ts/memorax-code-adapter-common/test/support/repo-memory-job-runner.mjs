import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [repo, finalMessagePath, memoryRoot = repo] = process.argv.slice(2);
const behavior = process.env.REPO_MEMORY_TEST_BEHAVIOR || "complete";

switch (behavior) {
  case "wait":
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    break;
  case "complete":
  case "complete-dirty":
  case "complete-move-origin":
  case "complete-change-branch": {
    const memory = join(memoryRoot, ".repo_memory");
    mkdirSync(memory, { recursive: true });
    const head = process.env.MEMORAX_CODE_REPO_MEMORY_SNAPSHOT_HEAD;
    writeFileSync(join(memory, "PROFILE.md"), `---\nfixture_valid: true\nlocal_head: "${head}"\n---\n# Profile\n`);
    if (behavior === "complete-dirty") writeFileSync(join(repo, "during-job.txt"), "source changed\n");
    if (behavior === "complete-move-origin") execFileSync("git", ["update-ref", "refs/remotes/origin/trunk", "HEAD^"], { cwd: repo });
    if (behavior === "complete-change-branch") execFileSync("git", ["switch", "-c", "during-job"], { cwd: repo });
    break;
  }
  case "change-head":
    appendFileSync(join(repo, "README.md"), "\nchanged during memory build\n");
    execFileSync("git", ["add", "README.md"], { cwd: repo });
    execFileSync("git", ["commit", "-m", "change during memory build"], { cwd: repo });
    break;
  case "break-git":
    rmSync(join(repo, ".git", "HEAD"));
    break;
  case "invalid-profile":
    writeFileSync(join(memoryRoot, ".repo_memory/PROFILE.md"), "invalid profile\n");
    break;
  case "final-only":
    break;
  default:
    throw new Error(`unknown fixture behavior: ${behavior}`);
}

writeFileSync(finalMessagePath, "Fixture runner completed.\n");
if (process.env.REPO_MEMORY_TEST_ENV_LOG) {
  writeFileSync(process.env.REPO_MEMORY_TEST_ENV_LOG, JSON.stringify({
    memoraxCodeHome: process.env.MEMORAX_CODE_HOME,
    kind: process.env.MEMORAX_CODE_REPO_MEMORY_JOB_KIND,
    jobId: process.env.MEMORAX_CODE_REPO_MEMORY_JOB_ID,
    runId: process.env.MEMORAX_CODE_REPO_MEMORY_JOB_RUN_ID,
    snapshotHead: process.env.MEMORAX_CODE_REPO_MEMORY_SNAPSHOT_HEAD,
    mode: process.env.MEMORAX_CODE_REPO_MEMORY_JOB_MODE,
  }));
}
