import path from "node:path";

export function createInitializationLayoutPlan(osOwnedRoot, runnerOwnedRoot, pathApi = path) {
  const roots = [osOwnedRoot, runnerOwnedRoot].map((root) => {
    if (typeof root !== "string" || !pathApi.isAbsolute(root)) {
      throw Object.assign(new Error("INIT_DIAG_LAYOUT_ROOT_NOT_ABSOLUTE"),
        { nativeCode: "INIT_DIAG_LAYOUT_ROOT_NOT_ABSOLUTE" });
    }
    return pathApi.resolve(root);
  });
  const comparable = roots.map((root) => pathApi.sep === "\\" ? root.toLowerCase() : root);
  if (comparable[0] === comparable[1]) {
    throw Object.assign(new Error("INIT_DIAG_LAYOUT_ROOTS_NOT_DISTINCT"),
      { nativeCode: "INIT_DIAG_LAYOUT_ROOTS_NOT_DISTINCT" });
  }
  const short = Math.max(76, ...roots.map((root) => root.length + 2));
  const layouts = [
    { id: "os-short", root: roots[0], length: short },
    { id: "os-long", root: roots[0], length: short + 29 },
    { id: "runner-short", root: roots[1], length: short },
    { id: "runner-long", root: roots[1], length: short + 29 },
  ].map(({ id, root, length }) => ({ id, root, tempDirectory: pathApi.join(root, "p").padEnd(length, "p") }));
  // Each layout occupies every position; each ordered pair occurs once within rounds.
  const rounds = [[0, 1, 3, 2], [1, 2, 0, 3], [2, 3, 1, 0], [3, 0, 2, 1]]
    .map((round) => round.map((index) => layouts[index]));
  return { layouts, rounds };
}
