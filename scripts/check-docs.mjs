#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import {
  dirname,
  extname,
  join,
  normalize,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_MARKDOWN_FILES = [
  "README.md",
  "README.zh.md",
  "INSTALL.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "AGENTS.md",
  "ARCHITECTURE.md",
];
const NPM_README = join("packages", "npm", "memorax-code", "README.md");
const SHIPPED_DOCS_MANIFEST = join(
  "packages",
  "npm",
  "memorax-code",
  "shipped-docs.json",
);

export function checkDocumentation(repositoryRoot = process.cwd()) {
  const root = resolve(repositoryRoot);
  const errors = [];
  const docsRoot = join(root, "docs");
  const publicMarkdown = [
    ...ROOT_MARKDOWN_FILES
      .map((path) => join(root, path))
      .filter(existsSync),
    ...(existsSync(docsRoot) ? markdownFiles(docsRoot) : []),
    ...[join(root, NPM_README)].filter(existsSync),
  ];

  for (const path of publicMarkdown) {
    const text = readFileSync(path, "utf8");
    checkPersonalPaths(root, path, text, errors);
    checkRelativeLinks(root, path, text, errors);
  }

  checkShippedDocs(root, errors);
  return errors;
}

function markdownFiles(directory) {
  const paths = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...markdownFiles(path));
    else if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
      paths.push(path);
    }
  }
  return paths;
}

function checkPersonalPaths(root, path, text, errors) {
  const patterns = [
    /\/Users\/[^/\s]+\/[^\s]*/g,
    /\b[A-Za-z]:\\Users\\[^\\\s]+\\[^\s]*/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      errors.push(
        `${displayPath(root, path)}:${lineNumber(text, match.index)} `
        + `contains a personal absolute path: ${match[0]}`,
      );
    }
  }
}

function checkRelativeLinks(root, path, text, errors) {
  let fenced = false;
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    for (const match of line.matchAll(/!?\[[^\]]*]\(([^)\n]+)\)/g)) {
      const rawTarget = linkTarget(match[1]);
      if (!rawTarget || ignoredLink(rawTarget)) continue;
      if (rawTarget.startsWith("/")) {
        errors.push(
          `${displayPath(root, path)}:${index + 1} `
          + `uses an absolute local Markdown link: ${rawTarget}`,
        );
        continue;
      }
      const targetWithoutSuffix = rawTarget.split("#", 1)[0].split("?", 1)[0];
      if (!targetWithoutSuffix) continue;
      let decoded;
      try {
        decoded = decodeURIComponent(targetWithoutSuffix);
      } catch {
        errors.push(
          `${displayPath(root, path)}:${index + 1} `
          + `contains an invalid encoded Markdown link: ${rawTarget}`,
        );
        continue;
      }
      const resolved = normalize(resolve(dirname(path), decoded));
      if (!existsSync(resolved)) {
        errors.push(
          `${displayPath(root, path)}:${index + 1} `
          + `links to missing path: ${rawTarget}`,
        );
      }
    }
  }
}

function linkTarget(raw) {
  const value = String(raw).trim();
  if (!value) return "";
  if (value.startsWith("<")) {
    const end = value.indexOf(">");
    return end > 0 ? value.slice(1, end) : value;
  }
  return value.split(/\s+/, 1)[0];
}

function ignoredLink(target) {
  return target.startsWith("#")
    || /^(?:https?:|mailto:|data:|app:)/i.test(target);
}

function checkShippedDocs(root, errors) {
  const manifestPath = join(root, SHIPPED_DOCS_MANIFEST);
  const readmePath = join(root, NPM_README);
  if (!existsSync(manifestPath)) {
    errors.push(`${SHIPPED_DOCS_MANIFEST} is missing`);
    return;
  }
  if (!existsSync(readmePath)) {
    errors.push(`${NPM_README} is missing`);
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    errors.push(`${SHIPPED_DOCS_MANIFEST} is invalid JSON: ${error.message}`);
    return;
  }
  if (!Array.isArray(manifest)
    || manifest.some((name) => typeof name !== "string"
      || !/^(?:[a-z0-9][a-z0-9.-]*\/)*[a-z0-9][a-z0-9.-]*\.md$/i.test(name)
      || name.split("/").some((part) => part === "." || part === ".."))
    || new Set(manifest).size !== manifest.length) {
    errors.push(`${SHIPPED_DOCS_MANIFEST} is not a unique relative Markdown path list`);
    return;
  }

  const sorted = [...manifest].sort((left, right) => left.localeCompare(right));
  if (manifest.some((name, index) => name !== sorted[index])) {
    errors.push(`${SHIPPED_DOCS_MANIFEST} must be sorted`);
  }
  for (const name of manifest) {
    if (!existsSync(join(root, "docs", name))) {
      errors.push(`npm shipped doc is missing from docs/: ${name}`);
    }
  }

  const readme = readFileSync(readmePath, "utf8");
  const referenced = [
    ...new Set(
      [...readme.matchAll(/\bdocs\/((?:[a-z0-9][a-z0-9.-]*\/)*[a-z0-9][a-z0-9.-]*\.md)\b/gi)]
        .map((match) => match[1]),
    ),
  ].sort((left, right) => left.localeCompare(right));
  if (JSON.stringify(referenced) !== JSON.stringify(sorted)) {
    errors.push(
      `${NPM_README} docs references must exactly match `
      + `${SHIPPED_DOCS_MANIFEST}: expected [${sorted.join(", ")}], `
      + `found [${referenced.join(", ")}]`,
    );
  }

  const shipped = new Set(manifest);
  const docsRoot = join(root, "docs");
  for (const name of manifest) {
    const sourcePath = join(docsRoot, name);
    if (!existsSync(sourcePath)) continue;
    const text = readFileSync(sourcePath, "utf8");
    for (const { rawTarget, line } of markdownLinks(text)) {
      const target = linkTarget(rawTarget);
      if (!target || ignoredLink(target)) continue;
      const targetWithoutSuffix = target.split("#", 1)[0].split("?", 1)[0];
      if (!targetWithoutSuffix) continue;
      let decoded;
      try {
        decoded = decodeURIComponent(targetWithoutSuffix);
      } catch {
        continue;
      }
      const resolved = normalize(resolve(dirname(sourcePath), decoded));
      const packagedTarget = relative(docsRoot, resolved).replaceAll("\\", "/");
      if (packagedTarget === ".." || packagedTarget.startsWith("../")) {
        errors.push(
          `npm shipped doc ${name}:${line} links outside the packaged docs: ${target}`,
        );
      } else if (extname(packagedTarget).toLowerCase() === ".md"
        && !shipped.has(packagedTarget)) {
        errors.push(
          `npm shipped doc ${name}:${line} links to an unshipped document: ${packagedTarget}`,
        );
      }
    }
  }
}

function markdownLinks(text) {
  const links = [];
  let fenced = false;
  const lines = text.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (/^\s*(?:```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    for (const match of line.matchAll(/!?\[[^\]]*]\(([^)\n]+)\)/g)) {
      links.push({ rawTarget: match[1], line: index + 1 });
    }
  }
  return links;
}

function lineNumber(text, offset = 0) {
  return text.slice(0, offset).split(/\r?\n/).length;
}

function displayPath(root, path) {
  return relative(root, path).replaceAll("\\", "/");
}

function isMainModule() {
  return process.argv[1]
    && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const errors = checkDocumentation();
  if (errors.length > 0) {
    console.error("Documentation contract check failed:");
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
  } else {
    console.log("Documentation contract check passed.");
  }
}
