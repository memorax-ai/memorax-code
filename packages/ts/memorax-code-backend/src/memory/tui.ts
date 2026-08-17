import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { stdin, stdout } from "node:process";
import { resolveRepositoryWorkspaceRoot } from "../repository/scope.js";
import { runMemoryCli } from "./cli.js";

type MemoryTuiItem = {
  text: string;
  type: string;
  timestamp: string;
  id?: string;
};

type RepoMemoryDocument = {
  title: string;
  description: string;
  path: string;
};

type RepoMemoryWorkspace = {
  name: string;
  path: string;
  documents: RepoMemoryDocument[];
};

type RepoMemoryRecord = {
  id: string;
  title: string;
  content: string;
};

type DetailRecordKind = "commit" | "section" | undefined;
type RepoHomeMode = "documents" | "workspaces";

type Screen = "home" | "search" | "results" | "detail" | "draft";
type HomeTab = "repo" | "cloud";

const MEMORY_TYPES = ["core", "episodic", "semantic", "procedural", "unclassified"] as const;
const ANSI = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  bold: "\u001b[1m",
  blue: "\u001b[38;5;75m",
  cyan: "\u001b[38;5;81m",
  green: "\u001b[38;5;114m",
  yellow: "\u001b[38;5;221m",
  magenta: "\u001b[38;5;213m",
  violet: "\u001b[38;5;141m",
  navy: "\u001b[48;5;24m",
  cyanPanel: "\u001b[48;5;30m",
  violetPanel: "\u001b[48;5;54m",
  selected: "\u001b[48;5;31m\u001b[97m",
};

export async function runMemoryTui(): Promise<number> {
  if (!stdin.isTTY || !stdout.isTTY) {
    console.error("memorax-cli tui requires an interactive terminal");
    return 1;
  }

  const tui = new MemoryTui();
  return await tui.run();
}

export function memoryTuiItemFromUnknown(value: unknown): MemoryTuiItem {
  const item = isRecord(value) ? value : {};
  const text = firstText(item, ["memory", "summary", "content", "text"]);
  const metadata = isRecord(item.metadata) ? item.metadata : {};
  return {
    text,
    type: firstText(metadata, ["memory_type"]) || "unclassified",
    timestamp: firstText(item, ["updated_at", "created_at"]),
    ...(firstText(item, ["id", "memory_id"]) ? { id: firstText(item, ["id", "memory_id"]) } : {}),
  };
}

export function memoryTuiReplacementReason(item: MemoryTuiItem | undefined): string {
  return item?.id
    ? `Manual replacement for memory ${item.id} from terminal TUI.`
    : "Manual replacement from terminal TUI.";
}

export function memoryTuiAddReason(): string {
  return "Manual addition from terminal TUI.";
}

export function memoryTuiDraftType(value: string | undefined): string {
  return value && (MEMORY_TYPES as readonly string[]).includes(value) ? value : MEMORY_TYPES[0];
}

export async function repoMemoryDocuments(workspace = process.cwd()): Promise<RepoMemoryDocument[]> {
  const repositoryRoot = await resolveRepositoryWorkspaceRoot(workspace);
  return repositoryRoot ? await repoMemoryDocumentsAt(repositoryRoot) : [];
}

export async function repoMemoryWorkspaces(root = process.cwd()): Promise<RepoMemoryWorkspace[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const workspaces = await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
      const path = join(root, entry.name);
      const repositoryRoot = await resolveRepositoryWorkspaceRoot(path);
      if (!repositoryRoot || basename(repositoryRoot) !== entry.name) return undefined;
      const documents = await repoMemoryDocumentsAt(repositoryRoot);
      return documents.length ? { name: entry.name, path: repositoryRoot, documents } : undefined;
    }));
    return workspaces.filter((workspace): workspace is RepoMemoryWorkspace => workspace !== undefined)
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

class MemoryTui {
  private screen: Screen = "home";
  private query = "";
  private results: MemoryTuiItem[] = [];
  private selected = 0;
  private repoDocuments: RepoMemoryDocument[] = [];
  private repoWorkspaces: RepoMemoryWorkspace[] = [];
  private repoWorkspaceSelected = 0;
  private repoHomeMode: RepoHomeMode = "documents";
  private repoSelected = 0;
  private homeTab: HomeTab = "repo";
  private repoPreview = "";
  private repoSourceLabel = "Local Repo Memory";
  private documentContent = "";
  private documentScroll = 0;
  private detailRecords: RepoMemoryRecord[] = [];
  private detailRecordSelected = 0;
  private detailRecordKind: DetailRecordKind;
  private draft = "";
  private draftType: string = MEMORY_TYPES[0];
  private replacing: MemoryTuiItem | undefined;
  private keypressListener: ((character: string, key: { name?: string; ctrl?: boolean }) => void) | undefined;
  private notice = "Type a query and press Enter.";

  async run(): Promise<number> {
    this.repoDocuments = await repoMemoryDocuments();
    if (this.repoDocuments.length) {
      await this.refreshRepoPreview();
      this.notice = "Select a repository memory and press Enter.";
    } else {
      this.repoWorkspaces = await repoMemoryWorkspaces();
      this.repoHomeMode = this.repoWorkspaces.length ? "workspaces" : "documents";
      this.notice = this.repoWorkspaces.length
        ? "Select a folder to browse its Repo Memory."
        : "No local Repo Memory bundle found. Press s to search cloud memories.";
    }
    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdout.write("\u001b[?1049h\u001b[?25l");
    this.render();

    return await new Promise((resolve) => {
      let handling = false;
      const onKeypress = (character: string, key: { name?: string; ctrl?: boolean }) => {
        if (handling) return;
        handling = true;
        void (async () => {
          if (key.ctrl && key.name === "c") return finish(0);
          if (key.name === "q" && this.screen !== "search") return finish(0);
          if (this.screen === "home") await this.handleHomeKey(character, key);
          else if (this.screen === "search") await this.handleSearchKey(character, key);
          else if (this.screen === "results") await this.handleResultsKey(character, key);
          else if (this.screen === "detail") await this.handleDetailKey(character, key);
          else await this.handleDraftKey(character, key);
          this.render();
        })().catch((error) => {
          this.notice = `TUI action failed: ${error instanceof Error ? error.message : String(error)}`;
          this.render();
        }).finally(() => {
          handling = false;
        });
      };

      const finish = (code: number) => {
        if (this.keypressListener) stdin.off("keypress", this.keypressListener);
        this.keypressListener = undefined;
        stdin.setRawMode(false);
        stdin.pause();
        stdout.write("\u001b[?25h\u001b[?1049l");
        resolve(code);
      };

      this.keypressListener = onKeypress;
      stdin.on("keypress", onKeypress);
    });
  }

  private async handleHomeKey(character: string, key: { name?: string }): Promise<void> {
    if (key.name === "tab" || character === "1" || character === "2") {
      this.homeTab = character === "2" || (key.name === "tab" && this.homeTab === "repo") ? "cloud" : "repo";
      return;
    }
    if (this.homeTab === "cloud") {
      if (key.name === "return" || character === "s") this.screen = "search";
      return;
    }
    if (this.repoHomeMode === "workspaces") {
      if (key.name === "up" || character === "k") this.repoWorkspaceSelected = Math.max(0, this.repoWorkspaceSelected - 1);
      else if (key.name === "down" || character === "j") this.repoWorkspaceSelected = Math.min(this.repoWorkspaces.length - 1, this.repoWorkspaceSelected + 1);
      else if (character === "s") this.homeTab = "cloud";
      else if (key.name === "return" && this.repoWorkspaces[this.repoWorkspaceSelected]) await this.openWorkspace(this.repoWorkspaces[this.repoWorkspaceSelected]);
      return;
    }
    if (key.name === "up" || character === "k") {
      this.repoSelected = Math.max(0, this.repoSelected - 1);
      await this.refreshRepoPreview();
    } else if (key.name === "down" || character === "j") {
      this.repoSelected = Math.min(this.repoDocuments.length - 1, this.repoSelected + 1);
      await this.refreshRepoPreview();
    } else if (character === "b" && this.repoWorkspaces.length) {
      this.repoHomeMode = "workspaces";
      this.notice = "Select a folder to browse its Repo Memory.";
    } else if (character === "s") this.homeTab = "cloud";
    else if (key.name === "return" && this.repoDocuments[this.repoSelected]) await this.openDocument(this.repoDocuments[this.repoSelected]);
  }

  private async handleSearchKey(character: string, key: { name?: string }): Promise<void> {
    if (key.name === "return") {
      await this.search();
    } else if (key.name === "backspace") {
      this.query = this.query.slice(0, -1);
    } else if (key.name === "escape") {
      this.screen = "home";
    } else if (character && !key.name?.startsWith("f")) {
      this.query += character;
    }
  }

  private async handleDetailKey(character: string, key: { name?: string }): Promise<void> {
    if (character === "e") {
      await this.editDocument();
      return;
    }
    if (this.detailRecords.length > 1) {
      if (key.name === "up" || character === "k") {
        this.detailRecordSelected = Math.max(0, this.detailRecordSelected - 1);
        this.documentScroll = 0;
      } else if (key.name === "down" || character === "j") {
        this.detailRecordSelected = Math.min(this.detailRecords.length - 1, this.detailRecordSelected + 1);
        this.documentScroll = 0;
      } else if (key.name === "pageup") {
        this.documentScroll = Math.max(0, this.documentScroll - 12);
      } else if (key.name === "pagedown") {
        const maxScroll = Math.max(0, this.detailLines().length - this.recordVisibleRows());
        this.documentScroll = Math.min(maxScroll, this.documentScroll + 12);
      } else if (key.name === "escape" || character === "b") this.screen = "home";
      return;
    }
    const lines = this.detailLines();
    const maxScroll = Math.max(0, lines.length - this.detailVisibleRows());
    if (key.name === "up" || character === "k") this.documentScroll = Math.max(0, this.documentScroll - 1);
    else if (key.name === "down" || character === "j") this.documentScroll = Math.min(maxScroll, this.documentScroll + 1);
    else if (key.name === "pageup") this.documentScroll = Math.max(0, this.documentScroll - 12);
    else if (key.name === "pagedown") this.documentScroll = Math.min(maxScroll, this.documentScroll + 12);
    else if (character === "]") this.documentScroll = nextSection(lines, this.documentScroll, 1);
    else if (character === "[") this.documentScroll = nextSection(lines, this.documentScroll, -1);
    else if (key.name === "escape" || character === "b") this.screen = "home";
  }

  private async handleResultsKey(character: string, key: { name?: string }): Promise<void> {
    if (key.name === "up" || character === "k") this.selected = Math.max(0, this.selected - 1);
    else if (key.name === "down" || character === "j") this.selected = Math.min(this.results.length - 1, this.selected + 1);
    else if (character === "s" || key.name === "escape") this.screen = "search";
    else if (character === "a") await this.startDraft();
    else if (character === "e" && this.results[this.selected]) await this.startDraft(this.results[this.selected]);
  }

  private async handleDraftKey(character: string, key: { name?: string }): Promise<void> {
    if (key.name === "escape") {
      this.screen = "results";
      this.notice = "Draft discarded.";
    } else if (character === "e") {
      await this.editDraft();
    } else if (character === "t") {
      const next = ((MEMORY_TYPES as readonly string[]).indexOf(this.draftType) + 1) % MEMORY_TYPES.length;
      this.draftType = MEMORY_TYPES[next];
    } else if (key.name === "return") {
      await this.saveDraft();
    }
  }

  private async search(): Promise<void> {
    const query = this.query.trim();
    if (!query) {
      this.notice = "A search query is required.";
      return;
    }
    this.notice = "Searching...";
    this.render();
    const result = await runMemoryCli(["search", "--query", query, "--limit", "20"]);
    if (!result.ok) {
      this.notice = result.error ?? "Search failed.";
      return;
    }
    this.results = (result.items ?? []).map(memoryTuiItemFromUnknown).filter((item) => item.text);
    this.selected = 0;
    this.screen = "results";
    const status = this.results.length ? `${this.results.length} memory result(s).` : "No matching memories.";
    this.notice = result.userNotice ? `${result.userNotice} ${status}` : status;
  }

  private async startDraft(replacing?: MemoryTuiItem): Promise<void> {
    this.replacing = replacing;
    this.draft = replacing?.text ?? "";
    this.draftType = memoryTuiDraftType(replacing?.type);
    this.screen = "draft";
    await this.editDraft();
  }

  private async openDocument(document: RepoMemoryDocument): Promise<void> {
    try {
      this.documentContent = await readFile(document.path, "utf8");
      this.documentScroll = 0;
      this.detailRecordSelected = 0;
      this.detailRecordKind = document.title === "Recent commits"
        ? "commit"
        : document.title === "Repository profile" ? "section" : undefined;
      this.detailRecords = this.detailRecordKind === "commit"
        ? parseRepoMemoryRecords(this.documentContent)
        : this.detailRecordKind === "section" ? parseMarkdownSections(this.documentContent) : [];
      this.screen = "detail";
      this.notice = document.title;
    } catch (error) {
      this.notice = `Could not open ${document.title}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async refreshRepoPreview(): Promise<void> {
    const document = this.repoDocuments[this.repoSelected];
    if (!document) return;
    try {
      this.repoPreview = await readFile(document.path, "utf8");
      if (document.title === "Repository profile") {
        const repoName = yamlValue(this.repoPreview, "repo_name");
        const sourcePath = yamlValue(this.repoPreview, "source_repo_path");
        this.repoSourceLabel = sourcePath && sourcePath !== process.cwd()
          ? `Imported sample: ${repoName || "repository"} (${sourcePath})`
          : `${repoName || "Current"} Repo Memory`;
      }
    } catch {
      this.repoPreview = "Could not load this local Repo Memory document.";
    }
  }

  private async openWorkspace(workspace: RepoMemoryWorkspace): Promise<void> {
    this.repoDocuments = workspace.documents;
    this.repoSelected = 0;
    this.repoSourceLabel = `Workspace: ${basename(workspace.path)}`;
    await this.refreshRepoPreview();
    this.repoHomeMode = "documents";
    this.notice = `Browsing ${workspace.name}. Press b to return to folders.`;
  }

  private async editDocument(): Promise<void> {
    const document = this.repoDocuments[this.repoSelected];
    if (!document) return;
    const editor = process.env.VISUAL || process.env.EDITOR || "nano";
    try {
      this.suspend();
      await runEditor(editor, document.path);
      this.resume();
      await this.openDocument(document);
      this.notice = `Saved local Markdown: ${relativeRepoMemoryPath(document.path)}`;
    } catch (error) {
      this.resume();
      this.notice = `Editor failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  private async editDraft(): Promise<void> {
    const editor = process.env.VISUAL || process.env.EDITOR || "nano";
    const directory = await mkdtemp(join(tmpdir(), "memorax-memory-"));
    const file = join(directory, "memory.md");
    try {
      await writeFile(file, this.draft, "utf8");
      this.suspend();
      await runEditor(editor, file);
      this.resume();
      this.draft = (await readFile(file, "utf8")).trim();
      this.notice = this.draft ? "Draft ready. Enter saves it as a new memory." : "Draft is empty.";
    } catch (error) {
      this.resume();
      this.notice = `Editor failed: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  private async saveDraft(): Promise<void> {
    if (!this.draft.trim()) {
      this.notice = "Draft is empty. Press e to edit it.";
      return;
    }
    this.notice = "Saving...";
    this.render();
    const result = await runMemoryCli([
      "add",
      "--memory", this.draft,
      "--type", this.draftType,
      "--reason", this.replacing ? memoryTuiReplacementReason(this.replacing) : memoryTuiAddReason(),
      "--content-type", "code",
      "--mode", "pre_summarized",
    ]);
    if (!result.ok) {
      this.notice = result.error ?? "Save failed.";
      return;
    }
    this.screen = "results";
    const status = this.replacing
      ? "Replacement memory queued. The original memory remains unchanged."
      : "New memory queued.";
    this.notice = result.userNotice ? `${result.userNotice} ${status}` : status;
  }

  private suspend(): void {
    if (this.keypressListener) stdin.off("keypress", this.keypressListener);
    stdin.pause();
    stdin.setRawMode(false);
    stdout.write("\u001b[?25h\u001b[?1049l");
  }

  private resume(): void {
    stdin.setRawMode(true);
    stdin.resume();
    if (this.keypressListener) stdin.on("keypress", this.keypressListener);
    stdout.write("\u001b[?1049h\u001b[?25l");
  }

  private render(): void {
    const rows = this.contentRows();
    const width = Math.max(40, stdout.columns || 100);
    const context = this.screen === "home" ? (this.homeTab === "repo" ? "Repository Memory" : "Cloud Memory")
      : this.screen === "detail" ? "Repository Memory / Reading"
        : this.screen === "search" || this.screen === "results" ? "Cloud Memory"
          : "Cloud Memory / Draft";
    const titleText = ` MEMORAX  ${context.toUpperCase()} `;
    const title = ` ${ANSI.navy}${ANSI.bold}${ANSI.magenta} MEMORAX ${ANSI.reset}${ANSI.blue}${ANSI.bold}  ${context.toUpperCase()} ${ANSI.reset}`;
    const line = "─".repeat(Math.max(0, width - titleText.length));
    const body = this.screen === "home"
      ? this.homeView(rows)
      : this.screen === "search"
        ? this.searchView(rows)
        : this.screen === "results"
          ? this.resultsView(rows)
          : this.screen === "detail"
            ? this.detailView(rows)
            : this.draftView(rows);
    stdout.write(`\u001b[2J\u001b[H${title}${ANSI.dim}${ANSI.blue}${line}${ANSI.reset}\n${body}\n${ANSI.yellow}${clip(this.notice, width)}${ANSI.reset}\n${ANSI.dim}${this.footer()}${ANSI.reset}`);
  }

  private homeView(rows: number): string {
    const tabs = `  ${this.homeTab === "repo" ? `${ANSI.cyanPanel}${ANSI.bold} 1 REPO MEMORY ${ANSI.reset}` : `${ANSI.dim}${ANSI.cyan} 1 Repo Memory ${ANSI.reset}`}  ${this.homeTab === "cloud" ? `${ANSI.violetPanel}${ANSI.bold} 2 CLOUD MEMORY ${ANSI.reset}` : `${ANSI.dim}${ANSI.magenta} 2 Cloud Memory ${ANSI.reset}`}`;
    if (this.homeTab === "cloud") return this.cloudHomeView(rows, tabs);
    if (this.repoHomeMode === "workspaces") return this.workspaceHomeView(rows, tabs);
    if (!this.repoDocuments.length) {
      return ["", tabs, "", "  No .repo_memory/PROFILE.md or resources found.", "", "  Switch to Cloud Memory to search saved memories.", ...Array.from({ length: rows - 6 }, () => "")].join("\n");
    }
    const width = Math.max(40, stdout.columns || 100);
    if (width < 100) return this.compactRepoHome(rows, tabs);
    const leftWidth = Math.max(24, Math.min(34, Math.floor(width * 0.34)));
    const previewWidth = Math.max(12, width - leftWidth - 5);
    const left = [`${ANSI.yellow}${ANSI.bold}REPOSITORY MAP${ANSI.reset}`, ...this.repoDocuments.map((document, index) => {
      const label = `${index === this.repoSelected ? ">" : " "} ${document.title}`;
      return index === this.repoSelected ? `${ANSI.selected}${label.padEnd(leftWidth)}${ANSI.reset}` : `${ANSI.cyan}${label.padEnd(leftWidth)}${ANSI.reset}`;
    }), "", `${ANSI.green}ENTER${ANSI.reset}  Read full document`];
    const preview = [
      `${ANSI.yellow}${ANSI.bold}${clip(this.repoSourceLabel, previewWidth)}${ANSI.reset}`,
      "",
      ...previewLines(this.repoPreview, Math.max(3, rows - 5)).map((line) => formatDocumentLine(line, previewWidth)),
    ];
    const contentRows = Math.max(left.length, preview.length);
    const columns = Array.from({ length: contentRows }, (_, index) => {
      const leftText = left[index] ?? "";
      const rightText = preview[index] ?? "";
      return `  ${padTerminal(leftText, leftWidth)} \u001b[90m│\u001b[0m ${rightText}`;
    });
    return ["", tabs, "", ...columns.slice(0, rows)].join("\n");
  }

  private workspaceHomeView(rows: number, tabs: string): string {
    const width = Math.max(40, stdout.columns || 100);
    const entries = this.repoWorkspaces.map((workspace, index) => {
      const label = `${index === this.repoWorkspaceSelected ? ">" : " "} ${workspace.name}  ${workspace.documents.length} resource${workspace.documents.length === 1 ? "" : "s"}`;
      return index === this.repoWorkspaceSelected
        ? `${ANSI.selected}${clip(label, width - 4)}${ANSI.reset}`
        : `${ANSI.cyan}${clip(label, width - 4)}${ANSI.reset}`;
    });
    return [
      "",
      tabs,
      "",
      `  ${ANSI.yellow}${ANSI.bold}MEMORY ROOT${ANSI.reset}`,
      `  ${ANSI.dim}${process.cwd()}${ANSI.reset}`,
      "",
      ...entries,
      "",
      `  ${ANSI.green}ENTER${ANSI.reset} Open selected folder`,
      ...Array.from({ length: Math.max(0, rows - entries.length - 8) }, () => ""),
    ].join("\n");
  }

  private compactRepoHome(rows: number, tabs: string): string {
    const selected = this.repoDocuments[this.repoSelected];
    const entries = this.repoDocuments.map((document, index) => {
      const label = `${index === this.repoSelected ? ">" : " "} ${document.title}`;
      return index === this.repoSelected
        ? `${ANSI.selected}${label}${ANSI.reset}`
        : `${ANSI.cyan}${label}${ANSI.reset}`;
    });
    return [
      "",
      tabs,
      "",
      `  ${ANSI.yellow}${ANSI.bold}REPOSITORY MAP${ANSI.reset}`,
      ...entries,
      "",
      `  ${ANSI.yellow}${ANSI.bold}${selected?.title ?? "No document"}${ANSI.reset}`,
      `  ${ANSI.dim}${selected?.description ?? ""}${ANSI.reset}`,
      `  ${ANSI.dim}${clip(this.repoSourceLabel, (stdout.columns || 100) - 4)}${ANSI.reset}`,
      "",
      `  ${ANSI.green}ENTER${ANSI.reset} Read selected document`,
      ...Array.from({ length: Math.max(0, rows - entries.length - 9) }, () => ""),
    ].join("\n");
  }

  private cloudHomeView(rows: number, tabs: string): string {
    return [
      "",
      tabs,
      "",
      `  ${ANSI.magenta}${ANSI.bold}CLOUD MEMORY${ANSI.reset}`,
      `  ${ANSI.violet}Search saved coding memories within the current workspace scope.${ANSI.reset}`,
      "",
      `  ${ANSI.violetPanel}${ANSI.bold} ENTER  SEARCH MEMORIES ${ANSI.reset}`,
      "",
      `  ${ANSI.yellow}Editing creates a replacement. The original record stays unchanged.${ANSI.reset}`,
      ...Array.from({ length: Math.max(0, rows - 9) }, () => ""),
    ].join("\n");
  }

  private searchView(rows: number): string {
    return ["", `  ${ANSI.magenta}${ANSI.bold}SEARCH CLOUD MEMORIES${ANSI.reset}`, "", `  ${ANSI.violetPanel}${ANSI.bold} QUERY ${ANSI.reset}  ${ANSI.bold}${this.query}█${ANSI.reset}`, "", `${ANSI.dim}  Results stay inside the current repository/workspace scope.${ANSI.reset}`, ...Array.from({ length: rows - 5 }, () => "")].join("\n");
  }

  private resultsView(rows: number): string {
    if (!this.results.length) return ["", "  \u001b[1mNo matching cloud memories\u001b[0m", "", "  Press s to adjust the query.", ...Array.from({ length: rows - 3 }, () => "")].join("\n");
    const listRows = Math.max(2, rows - 4);
    const start = Math.max(0, Math.min(this.selected - Math.floor(listRows / 2), this.results.length - listRows));
    const entries = this.results.slice(start, start + listRows).map((item, index) => {
      const selected = start + index === this.selected;
      const prefix = selected ? "\u001b[7m>" : " ";
      return `${prefix} ${memoryTypeStyle(item.type)}${clip(item.type, 12).padEnd(12)}${ANSI.reset}  ${clip(item.text, Math.max(12, (stdout.columns || 100) - 28))}${ANSI.reset}`;
    });
    const active = this.results[this.selected];
    return ["", `  \u001b[1m${this.results.length} cloud memory result(s)\u001b[0m  \u001b[90mQuery: ${clip(this.query, 45)}\u001b[0m`, "", ...entries, "", `  ${this.selected + 1}/${this.results.length}  ${clip(active?.timestamp || "No timestamp", 30)}${active?.id ? `  id: ${clip(active.id, 40)}` : ""}`].join("\n");
  }

  private detailView(rows: number): string {
    if (this.detailRecords.length > 1) return this.recordDetailView(rows);
    const lines = this.detailLines();
    const document = this.repoDocuments[this.repoSelected];
    const visible = lines.slice(this.documentScroll, this.documentScroll + this.detailVisibleRows())
      .map((line) => `  ${formatDocumentLine(line, (stdout.columns || 100) - 4)}`);
    const first = Math.min(this.documentScroll + 1, Math.max(1, lines.length));
    const last = Math.min(lines.length, this.documentScroll + this.detailVisibleRows());
    return ["", `  ${ANSI.cyanPanel}${ANSI.bold} ${document?.title ?? "Repository memory"} ${ANSI.reset}`, `  ${ANSI.dim}${document ? relativeRepoMemoryPath(document.path) : ""}${ANSI.reset}`, "", ...visible, "", `  ${ANSI.yellow}Lines ${first}-${last} of ${lines.length}${ANSI.reset}`].join("\n");
  }

  private recordDetailView(rows: number): string {
    const width = Math.max(40, stdout.columns || 100);
    const leftWidth = Math.max(28, Math.min(38, Math.floor(width * 0.38)));
    const rightWidth = Math.max(20, width - leftWidth - 5);
    const active = this.detailRecords[this.detailRecordSelected];
    const itemName = this.detailRecordKind === "commit" ? "commit" : "section";
    const heading = this.detailRecordKind === "commit" ? "COMMITS" : "PROFILE";
    const left = [
      `${ANSI.yellow}${ANSI.bold}${heading}${ANSI.reset}  ${ANSI.dim}${this.detailRecords.length} ${itemName}s${ANSI.reset}`,
      ...this.detailRecords.map((record, index) => {
        const label = `${index === this.detailRecordSelected ? ">" : " "} ${record.title}`;
        return index === this.detailRecordSelected
          ? `${ANSI.selected}${clip(label, leftWidth)}${ANSI.reset}`
          : `${ANSI.cyan}${clip(label, leftWidth)}${ANSI.reset}`;
      }),
    ];
    const detailLines = wrapDocument(stripFrontMatter(active?.content ?? ""), rightWidth);
    const visible = detailLines.slice(this.documentScroll, this.documentScroll + rows - 3);
    const right = [
      `${ANSI.magenta}${ANSI.bold}${clip(active?.title ?? "Commit", rightWidth)}${ANSI.reset}`,
      `${ANSI.dim}${clip(active?.id ?? "", rightWidth)}${ANSI.reset}`,
      "",
      ...visible.map((line) => formatDocumentLine(line, rightWidth)),
    ];
    const lineCount = Math.max(left.length, right.length);
    const columns = Array.from({ length: lineCount }, (_, index) => `  ${padTerminal(left[index] ?? "", leftWidth)} ${ANSI.dim}│${ANSI.reset} ${right[index] ?? ""}`);
    return ["", ...columns.slice(0, rows), "", `  ${ANSI.yellow}${this.detailRecordSelected + 1}/${this.detailRecords.length}${ANSI.reset}  ${ANSI.dim}j/k switches ${itemName}${ANSI.reset}`].join("\n");
  }

  private draftView(rows: number): string {
    const preview = this.draft ? this.draft.split(/\r?\n/).slice(0, rows - 4).map((line) => `  ${clip(line, (stdout.columns || 100) - 4)}`) : ["  (empty draft)"];
    return ["", `  Type: ${this.draftType}${this.replacing ? "  |  replacement" : "  |  new memory"}`, "", ...preview].join("\n");
  }

  private footer(): string {
    if (this.screen === "home") return this.homeTab === "repo"
      ? this.repoHomeMode === "workspaces"
        ? `${ANSI.cyan}1/2 TAB${ANSI.reset} switch   ${ANSI.cyan}j/k${ANSI.reset} select folder   ${ANSI.green}ENTER${ANSI.reset} open   ${ANSI.yellow}q${ANSI.reset} quit`
        : `${ANSI.cyan}1/2 TAB${ANSI.reset} switch   ${ANSI.cyan}j/k${ANSI.reset} select   ${ANSI.green}ENTER${ANSI.reset} read${this.repoWorkspaces.length ? `   ${ANSI.green}b${ANSI.reset} folders` : ""}   ${ANSI.yellow}q${ANSI.reset} quit`
      : `${ANSI.cyan}1/2 TAB${ANSI.reset} switch   ${ANSI.violet}ENTER${ANSI.reset} search   ${ANSI.yellow}q${ANSI.reset} quit`;
    if (this.screen === "search") return `${ANSI.violet}ENTER${ANSI.reset} search   ${ANSI.yellow}ESC${ANSI.reset} back   ${ANSI.yellow}Ctrl-C${ANSI.reset} quit`;
    if (this.screen === "results") return `${ANSI.cyan}j/k${ANSI.reset} move   ${ANSI.magenta}e${ANSI.reset} replace   ${ANSI.green}a${ANSI.reset} add   ${ANSI.violet}s${ANSI.reset} search   ${ANSI.yellow}q${ANSI.reset} quit`;
    if (this.screen === "detail") return this.detailRecords.length > 1
      ? `${ANSI.cyan}j/k${ANSI.reset} switch ${this.detailRecordKind === "commit" ? "commit" : "section"}   ${ANSI.cyan}PGUP/PGDN${ANSI.reset} scroll   ${ANSI.magenta}e${ANSI.reset} edit Markdown   ${ANSI.green}b${ANSI.reset} back   ${ANSI.yellow}q${ANSI.reset} quit`
      : `${ANSI.cyan}j/k${ANSI.reset} scroll   ${ANSI.magenta}[ / ]${ANSI.reset} sections   ${ANSI.magenta}e${ANSI.reset} edit Markdown   ${ANSI.green}b${ANSI.reset} back   ${ANSI.yellow}q${ANSI.reset} quit`;
    return `${ANSI.magenta}e${ANSI.reset} edit   ${ANSI.violet}t${ANSI.reset} type   ${ANSI.green}ENTER${ANSI.reset} save   ${ANSI.yellow}ESC${ANSI.reset} cancel`;
  }

  private contentRows(): number {
    return Math.max(8, (stdout.rows || 24) - 5);
  }

  private detailVisibleRows(): number {
    return Math.max(1, this.contentRows() - 4);
  }

  private recordVisibleRows(): number {
    return Math.max(1, this.contentRows() - 3);
  }

  private detailLines(): string[] {
    const content = this.detailRecords[this.detailRecordSelected]?.content ?? this.documentContent;
    return wrapDocument(stripFrontMatter(content), Math.max(20, (stdout.columns || 100) - 4));
  }
}

async function runEditor(editor: string, file: string): Promise<void> {
  const [command, ...args] = editor.trim().split(/\s+/);
  if (!command) throw new Error("$VISUAL or $EDITOR is empty");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [...args, file], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code ?? "unknown"}`)));
  });
}

function firstText(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clip(value: string, width: number): string {
  const safe = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return safe.length <= width ? safe : `${safe.slice(0, Math.max(0, width - 3))}...`;
}

function padTerminal(value: string, width: number): string {
  const visibleLength = value.replace(/\u001b\[[0-9;]*m/g, "").length;
  return `${value}${" ".repeat(Math.max(0, width - visibleLength))}`;
}

function formatDocumentLine(line: string, width: number): string {
  const text = clip(line, width);
  return /^#{1,6}\s/.test(text) ? `${ANSI.magenta}${ANSI.bold}${text}${ANSI.reset}` : text;
}

function memoryTypeStyle(type: string): string {
  if (type === "coding") return ANSI.magenta;
  if (type === "procedural") return ANSI.yellow;
  if (type === "repository") return ANSI.cyan;
  if (type === "personal") return ANSI.green;
  return ANSI.violet;
}

function wrapDocument(content: string, width: number): string[] {
  const lines = content.split(/\r?\n/);
  const output: string[] = [];
  for (const line of lines) {
    const wrapped = wrapLine(line, width);
    if (/^#{1,6}\s/.test(line.trim()) && output.length > 0 && output[output.length - 1] !== "") output.push("");
    output.push(...wrapped);
    if (/^#{1,6}\s/.test(line.trim())) output.push("");
  }
  return output;
}

function stripFrontMatter(content: string): string {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return content;
  const end = lines.slice(1).findIndex((line) => line.trim() === "---");
  return end >= 0 ? lines.slice(end + 2).join("\n") : content;
}

export function parseRepoMemoryRecords(content: string): RepoMemoryRecord[] {
  const lines = stripFrontMatter(content).split(/\r?\n/);
  const starts: Array<{ index: number; id: string; title: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^##\s+Commit\s+([^:]+):\s*(.+)$/i);
    if (match) starts.push({ index, id: match[1].trim(), title: match[2].trim() });
  }
  return starts.map((record, index) => ({
    id: record.id,
    title: record.title,
    content: lines.slice(record.index + 1, starts[index + 1]?.index).join("\n").trim(),
  }));
}

export function parseMarkdownSections(content: string): RepoMemoryRecord[] {
  const lines = stripFrontMatter(content).split(/\r?\n/);
  const starts: Array<{ index: number; title: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(/^#{2,6}\s+(.+)$/);
    if (match) starts.push({ index, title: match[1].trim() });
  }
  return starts.map((section, index) => ({
    id: "",
    title: section.title,
    content: lines.slice(section.index + 1, starts[index + 1]?.index).join("\n").trim(),
  }));
}

function wrapLine(line: string, width: number): string[] {
  const text = line.replace(/[\u0000-\u001f\u007f]/g, " ").trimEnd();
  if (!text.trim()) return [""];
  if (/^#{1,6}\s/.test(text)) return [text];
  const bullet = text.match(/^(\s*[-*]\s+)(.*)$/);
  const prefix = bullet?.[1] ?? "";
  const words = (bullet?.[2] ?? text.trim()).split(/\s+/);
  const lineWidth = Math.max(12, width - prefix.length);
  const wrapped: string[] = [];
  let current = "";
  for (const word of words) {
    if (current && current.length + word.length + 1 > lineWidth) {
      wrapped.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) wrapped.push(current);
  if (!prefix) return wrapped;
  return wrapped.map((value, index) => `${index === 0 ? prefix : " ".repeat(prefix.length)}${value}`);
}

function nextSection(lines: string[], current: number, direction: 1 | -1): number {
  for (let index = current + direction; index >= 0 && index < lines.length; index += direction) {
    if (/^#{1,6}\s/.test(lines[index])) return index;
  }
  return current;
}

function relativeRepoMemoryPath(path: string): string {
  const marker = "/.repo_memory/";
  const index = path.indexOf(marker);
  return index >= 0 ? `.repo_memory/${path.slice(index + marker.length)}` : path;
}

function previewLines(content: string, limit: number): string[] {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() === "---") {
    const end = lines.slice(1).findIndex((line) => line.trim() === "---");
    if (end >= 0) return lines.slice(end + 2, end + 2 + limit);
  }
  return lines.slice(0, limit);
}

function yamlValue(content: string, key: string): string {
  const match = content.match(new RegExp(`^${key}:\\s*["']?([^"'\\n]+)`, "m"));
  return match?.[1]?.trim() ?? "";
}

async function repoMemoryDocumentsAt(workspace: string): Promise<RepoMemoryDocument[]> {
  const memoryRoot = join(workspace, ".repo_memory");
  const candidates = [
    ["Repository profile", "Architecture, ownership, and operating rules.", "PROFILE.md"],
    ["Recent commits", "Historical changes and affected modules.", "resources/commits.md"],
    ["Pull requests", "Design decisions and change intent.", "resources/prs.md"],
    ["Issues", "Known problems, requests, and investigation context.", "resources/issues.md"],
  ] as const;
  const documents: Array<RepoMemoryDocument | undefined> = await Promise.all(candidates.map(async ([title, description, relative]) => {
    const path = join(memoryRoot, relative);
    return await exists(path) ? { title, description, path } : undefined;
  }));
  return documents.filter((document): document is RepoMemoryDocument => document !== undefined);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
