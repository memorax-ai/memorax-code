import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

// Compare installed artifacts without staging a disposable copy. Read failures
// propagate so an unreadable installation is not mistaken for one to replace.
export async function fileTreeMatches(source, target, { ignore = () => false, transform = (_path, content) => content } = {}) {
  async function compare(sourcePath, targetPath, relativePath) {
    const sourceStat = await lstat(sourcePath);
    let targetStat;
    try {
      targetStat = await lstat(targetPath);
    } catch (error) {
      if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
      throw error;
    }
    if (sourceStat.isSymbolicLink() || targetStat.isSymbolicLink()) return false;
    if (sourceStat.isFile()) {
      return targetStat.isFile() && transform(relativePath, await readFile(sourcePath)).equals(await readFile(targetPath));
    }
    if (!sourceStat.isDirectory() || !targetStat.isDirectory()) return false;
    const childPath = (name) => relativePath ? `${relativePath}/${name}` : name;
    const included = (name) => !ignore(childPath(name));
    const expected = (await readdir(sourcePath)).filter(included).sort();
    const actual = (await readdir(targetPath)).filter(included).sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual)) return false;
    for (const name of expected) {
      if (!await compare(join(sourcePath, name), join(targetPath, name), childPath(name))) return false;
    }
    return true;
  }
  return compare(source, target, "");
}
