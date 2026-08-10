import assert from "node:assert/strict";
import { test } from "node:test";
import {
  stripCodexPreambleSegments,
} from "../dist/clients/codex/effective-prompt.js";

const AGENTS_BLOCK = [
  "# AGENTS.md instructions for /repo",
  "",
  "<INSTRUCTIONS>",
  "Use rg before grep.",
  "</INSTRUCTIONS>",
].join("\n");

const ENV_BLOCK = [
  "<environment_context>",
  "  <cwd>/repo</cwd>",
  "  <shell>zsh</shell>",
  "</environment_context>",
].join("\n");

const SKILL_BLOCK = [
  "<skill>",
  "<name>openai-docs</name>",
  "<path>/Users/example/.codex/skills/.system/openai-docs/SKILL.md</path>",
  "---",
  'name: "openai-docs"',
  'description: "Use for OpenAI docs questions."',
  "---",
  "",
  "# OpenAI Docs",
  "",
  "Use official docs before fallback sources.",
  "</skill>",
].join("\n");

const AMBIENT_BROWSER_BLOCK = [
  '<in-app-browser-context source="ambient-ui-state">',
  "This block is automatically supplied ambient UI state, not part of the user's request.",
  "# In app browser:",
  "- Current URL: http://127.0.0.1:8787/memory-viewer",
  "</in-app-browser-context>",
].join("\n");

test("stripCodexPreambleSegments removes leading Codex preamble and preserves the prompt suffix", () => {
  const text = [
    AGENTS_BLOCK,
    "",
    ENV_BLOCK,
    "",
    "Implement the memory filter.",
  ].join("\n");

  assert.equal(stripCodexPreambleSegments(text), "Implement the memory filter.");
});

test("stripCodexPreambleSegments preserves embedded environment context text", () => {
  const text = "Please explain <environment_context><cwd>/repo</cwd></environment_context> literally.";

  assert.equal(stripCodexPreambleSegments(text), text);
});

test("stripCodexPreambleSegments removes standalone Codex skill blocks after the user prompt", () => {
  const text = [
    "$openai-docs Explain the latest Responses API behavior.",
    SKILL_BLOCK,
  ].join("\n");

  assert.equal(
    stripCodexPreambleSegments(text),
    "$openai-docs Explain the latest Responses API behavior.",
  );
});

test("stripCodexPreambleSegments preserves non-Codex skill-like user text", () => {
  const text = "Please document this literal <skill><name>demo</name></skill> XML snippet.";

  assert.equal(stripCodexPreambleSegments(text), text);
});

test("stripCodexPreambleSegments removes ambient browser context and request wrapper headings", () => {
  const text = [
    AMBIENT_BROWSER_BLOCK,
    "",
    "## My request for Codex:",
    "Remember the distinction between hooks and model calls.",
    AMBIENT_BROWSER_BLOCK,
    "",
    "## My request for Codex:",
    "Can the ambient context be removed?",
  ].join("\n");

  assert.equal(
    stripCodexPreambleSegments(text),
    "Remember the distinction between hooks and model calls.\n\nCan the ambient context be removed?",
  );
});

test("stripCodexPreambleSegments preserves literal ambient context discussed by the user", () => {
  const text = "Please explain <in-app-browser-context>this literal tag</in-app-browser-context>.";

  assert.equal(stripCodexPreambleSegments(text), text);
});

test("stripCodexPreambleSegments handles session preamble boundaries conservatively", () => {
  assert.equal(
    stripCodexPreambleSegments("You are Claude Code, based on GPT-5.\n\nReview the diff."),
    "Review the diff.",
  );
  assert.equal(
    stripCodexPreambleSegments("You are Claude Code, based on GPT-5."),
    "",
  );
});
