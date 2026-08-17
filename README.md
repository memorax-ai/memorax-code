<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/memorax-code-lockup-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/memorax-code-lockup-light.svg">
    <img src="docs/assets/memorax-code-lockup-light.svg" alt="MemoraX Code" width="420">
  </picture>
</h1>

<p align="center">
  <a href="https://trendshift.io/repositories/105791?utm_source=trendshift-badge&amp;utm_medium=badge&amp;utm_campaign=badge-trendshift-105791" target="_blank" rel="noopener noreferrer"><img src="https://trendshift.io/api/badge/trendshift/repositories/105791/daily?language=JavaScript" alt="memorax-ai/memorax-code | Trendshift" width="250" height="55" /></a>
</p>

<h2 align="center">Never lose context. Never start over.</h2>

<p align="center">
  <sub>
    Beyond code, it remembers how your architecture evolves and how your engineering unfolds.
  </sub>
</p>

<p align="center">
  <a href="https://code.memorax.net/"><img src="https://img.shields.io/badge/website-code.memorax.net-2563eb" alt="MemoraX Code website"></a>
  <a href="https://www.npmjs.com/package/@memorax/memorax-code"><img src="https://img.shields.io/npm/v/@memorax/memorax-code.svg" alt="npm version"></a>
  <img src="https://img.shields.io/npm/v/@memorax/memorax-code.svg?label=version&color=f59e0b" alt="npm package version">
  <img src="https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white" alt="Node.js 24 or newer">
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh.md">简体中文</a>
</p>

## Make Every Interaction the Starting Point for the Next

Coding agents are good at the task in front of them, but a new session often
starts without the architecture, failed attempts, repository rules, or working
preferences established before it.

MemoraX Code gives Codex, Claude Code, DeepSeek Harness, and OpenCode a shared
memory layer for that context.
It can recall prior engineering knowledge, capture reusable lessons from
completed work, maintain repository knowledge, and carry your procedures and
preferences into future sessions.

The goal is not to remember everything. It is to bring back the small amount of
memory relevant to the current task so the agent can reach useful investigation
and validation sooner.

## Quick Start

Prepare Node.js 24+ and at least one of Codex, Claude Code, DeepSeek Harness,
or OpenCode. Python 3 is required for Repo Memory operations.

### Install and Connect

#### 1. Get a MemoraX Memory Key

Sign up at [MemoraX Console](https://platform.memorax.net/) and create an API
key. Enter the key only in your local installation terminal; do not paste it
into chats or public issues.

#### 2. Install and Follow the Prompts

```bash
npm install -g @memorax/memorax-code --foreground-scripts
```

Keep `--foreground-scripts` so the complete setup remains visible. The
installer automatically detects available Codex, Claude Code, DeepSeek
Harness, and OpenCode installations and connects those it finds. Follow the
prompts to enter your Base User ID, preferred language, and API key. Codex
users must also approve Hook activation and trust when prompted. Restart or
refresh every detected coding agent after installation before starting a new
session.

If setup is skipped or cannot prompt, the package remains installed but
MemoraX-backed search, retrieval, and writeback remain unavailable.

### Try Cross-Session Memory

Clone the example repository from the product website, then open Codex, Claude
Code, DeepSeek Harness, or OpenCode in the project directory:

```bash
git clone https://github.com/SWE-agent/test-repo.git
cd test-repo
```

Invoke the Skill as `$memorax-code` in Codex or `/memorax-code` in Claude Code
or DeepSeek Harness. In OpenCode, ask the agent to use the `memorax-code` skill
by name. The prompts below use its product name and work in all four clients.

Send these prompts in order in the same session:

> 1. Use the MemoraX Code skill to build Repo
>    Memory, retrieving only the latest 3 issues, pull requests, and commits.
> 2. Review the recent Repo Memory issue: the zeroth number was once calculated
>    incorrectly. Avoid repeating the same problem now.
> 3. Use the MemoraX Code skill to remember the
>    engineering lesson from this coding task.

Close the current conversation, start a new session in the same repository,
and send:

> Use the MemoraX Code skill to recall the earlier
> engineering lesson and suggest what to check.

The agent should retrieve the saved lesson and use it to make suggestions for
the current repository.

> [!TIP]
> The prompts above are only for quick verification. In normal use, you do not
> need to invoke the MemoraX Code skill to add memory manually. It writes
> relevant memory in the background and guides agents to search when useful.
> You can view content-free local activity and status in the
> [Memory Viewer](http://127.0.0.1:8787/memory-viewer).

## Four Clear Memory Boundaries

| Memory | The question it answers | Examples |
| --- | --- | --- |
| **Coding&nbsp;Memory** | What engineering lessons should carry into the next task? | Verified fixes, failed approaches, design rationale, pitfalls, and regression checks |
| **Repo&nbsp;Memory** | What should an agent know about this repository? | Architecture maps, module ownership, entry points, and commit/PR/MR/issue evidence |
| **Personal&nbsp;Memory** | How should the agent communicate and collaborate with you? | User Profile preferences such as language, tone, explanation depth, and result format |
| **Procedure&nbsp;Memory** | How should this kind of task be carried out? | Reusable steps, checklists, prerequisites, exceptions, and validation gates |

## Product Capabilities

| Capability | What it does |
| --- | --- |
| **Background memory writeback** | Extracts reusable knowledge from completed turns and writes it to Coding Memory in the background. |
| **Preference continuity** | Records User Profile preferences and injects them into future tasks on a configured cadence. |
| **Procedure reuse** | Records reusable task procedures and reminds future agents to apply them. |
| **Background Repo Memory maintenance** | Automatically organizes repository structure, entry points, and history evidence in the background, then updates them according to policy to reduce repeated searching and summarization. |
| **Active memory control** | Lets you search and add memory through the bundled MemoraX Code skill or the CLI. |
| **Client integration** | Integrates with Codex, Claude Code, DeepSeek Harness, and OpenCode to trigger memory retrieval, reminders, and writeback. |
| **Local visualization** | Uses the local Memory Viewer to summarize activity counts, retrieval, and writeback status. |

## Your Memory, Your Control

MemoraX is required for cloud-backed memory. Entering a Base User ID and API
key after the installer's disclosure activates MemoraX search/add and the
generated configuration's automatic writeback; there is no second writeback
confirmation. Automatic retrieval remains off until explicitly enabled.

Local trace capture is enabled by default for supported clients. Depending on
client capabilities, retained traces under `MEMORAX_CODE_HOME` may contain
prompts, responses, recalled memory, reminder text, and local paths. Use the
[local trace settings](docs/configuration.md#local-traces) to switch to
metadata-only capture or disable a client's trace.

Active memory operations send their query or selected content to MemoraX.
Automatic writeback sends selected user instructions and the matching final
Agent response from trusted workspace turns for extraction and storage. It
does not upload the complete retained client trace artifact or local trace
path.

Sign in to [MemoraX Console](https://platform.memorax.net/) at any time to view,
edit, or delete saved memories. MemoraX Cloud does not receive model-provider
credentials or local Backend tokens.

Read [Configuration](docs/configuration.md) for all settings and
[Security](SECURITY.md) for network, local-data, and retention boundaries.

## Update

For a global npm installation:

```bash
memorax-code update
```

The command follows the installed release channel and preserves configuration.
Restart or refresh Codex, Claude Code, DeepSeek Harness, and OpenCode when a
release changes installed integration assets.

## Uninstall

Run the product lifecycle before removing the npm package:

```bash
memorax-code uninstall
```

This removes managed integrations and the global package while retaining
`MEMORAX_CODE_HOME` (default `~/.memorax-code`), Claude plugin data, provider
configuration, and memories stored in MemoraX. Remove retained local or cloud
data separately only after reviewing what you still need.

## Documentation

- [Installation](INSTALL.md)
- [Configuration](docs/configuration.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)

## Develop and Contribute

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md)
before making a change, and never include API keys, raw transcripts, private
memory, or local trace artifacts in a public report.

## License

MemoraX Code is available under the [MIT License](LICENSE).
