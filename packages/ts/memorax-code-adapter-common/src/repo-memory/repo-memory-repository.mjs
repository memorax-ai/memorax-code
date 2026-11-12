import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

// Only local Git metadata defines sharing; remote URLs and branch names do not.
export function repoMemoryRepositoryPath(repo) {
  const root = realpathSync(repo);
  const marker = join(root, ".git");
  if (!existsSync(marker)) return root;
  const kind = lstatSync(marker);
  let gitDir;
  if (kind.isDirectory()) gitDir = realpathSync(marker);
  else if (kind.isFile()) {
    const match = /^gitdir: (.+)$/.exec(readPointer(marker));
    if (!match) throw new Error("invalid Repo Memory Git directory pointer");
    gitDir = realpathSync(resolve(root, match[1]));
  } else throw new Error("invalid Repo Memory Git marker");
  const commonPointer = join(gitDir, "commondir");
  const commonDir = existsSync(commonPointer)
    ? realpathSync(resolve(gitDir, readPointer(commonPointer))) : gitDir;
  if (!statSync(join(commonDir, "objects")).isDirectory()
    || (!existsSync(join(commonDir, "refs")) && !existsSync(join(commonDir, "reftable")))) {
    throw new Error("invalid Repo Memory Git common directory");
  }
  if (commonDir !== gitDir) {
    const child = relative(join(commonDir, "worktrees"), gitDir);
    if (!child || child === ".." || child.startsWith(`..${sep}`) || child.includes(sep)
      || realpathSync(resolve(gitDir, readPointer(join(gitDir, "gitdir")))) !== realpathSync(marker)) {
      throw new Error("invalid Repo Memory linked worktree metadata");
    }
  }
  return commonDir;
}

function readPointer(path) {
  const info = lstatSync(path);
  if (!info.isFile() || info.size > 4096) throw new Error("invalid Repo Memory Git pointer");
  const text = readFileSync(path, "utf8").trim();
  if (!text || /[\r\n\0]/.test(text)) throw new Error("invalid Repo Memory Git pointer");
  return text;
}
