export interface SharedRepoMemory {
  head: string;
  path: string;
  publishedAt?: string;
}
export function readSharedRepoMemory(home: string, repo: string): SharedRepoMemory | undefined;
export function bundleHeadMatches(repo: string, root: string, head: string): boolean;
