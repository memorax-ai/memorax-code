#!/usr/bin/env node
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  collectDeepAgentsPluginArtifactSources,
  describeDeepAgentsPluginArtifactProblems,
  inspectDeepAgentsPluginArtifact,
} from "../src/plugin-artifact-contract.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ADAPTER_ROOT = resolve(SCRIPT_DIR, "..");
const PLUGIN_NAME = "memorax-code-deepagents-adapter";

export async function buildDeepAgentsMarketplace({ outputDir, adapterRoot = ADAPTER_ROOT } = {}) {
  if (!outputDir) throw new Error("outputDir is required");
  const marketplaceRoot = resolve(outputDir);
  const pluginRoot = join(marketplaceRoot, "plugins", PLUGIN_NAME);
  const artifactSources = collectDeepAgentsPluginArtifactSources({ adapterRoot });

  await rm(marketplaceRoot, { recursive: true, force: true });
  await mkdir(join(marketplaceRoot, ".claude-plugin"), { recursive: true });
  await mkdir(pluginRoot, { recursive: true });

  await writeFile(
    join(marketplaceRoot, ".claude-plugin", "marketplace.json"),
    `${JSON.stringify({
      name: "memorax-code-deepagents-local",
      description: "MemoraX Code integration for Deep Agents Code (dcode).",
      owner: {
        name: "MemoraX Code Local",
      },
      plugins: [
        {
          name: PLUGIN_NAME,
          displayName: "MemoraX Code",
          source: `./plugins/${PLUGIN_NAME}`,
          description: "Connect Deep Agents Code to MemoraX Code memory.",
        },
      ],
    }, null, 2)}\n`
  );

  for (const source of artifactSources) {
    const destination = join(pluginRoot, ...source.relativePath.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await cp(source.sourcePath, destination, { force: true });
  }
  await rewriteAdapterCommonImports(pluginRoot);
  const inspection = inspectDeepAgentsPluginArtifact(pluginRoot, artifactSources);
  if (!inspection.ok) {
    throw new Error(
      `generated Deep Agents plugin violates its artifact contract: ${describeDeepAgentsPluginArtifactProblems(inspection)}`,
    );
  }

  return {
    ok: true,
    marketplaceRoot,
    pluginName: PLUGIN_NAME,
    pluginRoot,
  };
}

async function rewriteAdapterCommonImports(pluginRoot) {
  for (const dir of ["hooks", "runtime-hooks", "src"]) {
    for (const path of await mjsFiles(join(pluginRoot, dir))) {
      const text = await readFile(path, "utf8");
      const next = text.replaceAll("../../memorax-code-adapter-common/src/", "../memorax-code-adapter-common/src/");
      if (next !== text) await writeFile(path, next, "utf8");
    }
  }
}

async function mjsFiles(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...await mjsFiles(path));
    else if (entry.isFile() && entry.name.endsWith(".mjs")) files.push(path);
  }
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const outputDir = process.argv[2];
    const adapterRoot = process.argv[3];
    if (!outputDir) throw new Error("usage: build-marketplace.mjs <output-dir> [adapter-root]");
    const result = await buildDeepAgentsMarketplace({
      outputDir,
      ...(adapterRoot ? { adapterRoot } : {}),
    });
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
