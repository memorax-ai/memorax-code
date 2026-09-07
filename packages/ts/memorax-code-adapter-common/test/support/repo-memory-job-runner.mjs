import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [repo, finalMessagePath] = process.argv.slice(2);
const behavior = process.env.REPO_MEMORY_TEST_BEHAVIOR || "complete";

switch (behavior) {
  case "wait":
    await new Promise((resolve) => setTimeout(resolve, 30_000));
    break;
  case "complete": {
    const memory = join(repo, ".repo_memory");
    mkdirSync(memory, { recursive: true });
    const head = process.env.MEMORAX_CODE_REPO_MEMORY_SNAPSHOT_HEAD;
    writeFileSync(join(memory, "PROFILE.md"), `---\nfixture_valid: true\nlocal_head: "${head}"\n---\n# Profile\n`);
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
  case "final-only":
    break;
  default:
    throw new Error(`unknown fixture behavior: ${behavior}`);
}

writeFileSync(finalMessagePath, "Fixture runner completed.\n");
if (process.env.REPO_MEMORY_TEST_ENV_LOG) {
  writeFileSync(process.env.REPO_MEMORY_TEST_ENV_LOG, JSON.stringify({
    kind: process.env.MEMORAX_CODE_REPO_MEMORY_JOB_KIND,
    jobId: process.env.MEMORAX_CODE_REPO_MEMORY_JOB_ID,
    runId: process.env.MEMORAX_CODE_REPO_MEMORY_JOB_RUN_ID,
    snapshotHead: process.env.MEMORAX_CODE_REPO_MEMORY_SNAPSHOT_HEAD,
    mode: process.env.MEMORAX_CODE_REPO_MEMORY_JOB_MODE,
  }));
}
