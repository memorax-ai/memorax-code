<h1 align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/memorax-code-lockup-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/memorax-code-lockup-light.svg">
    <img src="docs/assets/memorax-code-lockup-light.svg" alt="MemoraX Code" width="420">
  </picture>
</h1>

<h2 align="center">Never lose context. Never start over.</h2>

<p align="center">
  <sub>Beyond code, it remembers how your architecture evolves and how your engineering unfolds.</sub>
</p>

<p align="center">
  <a href="https://code.memorax.net/"><img src="https://img.shields.io/badge/website-code.memorax.net-2563eb" alt="MemoraX Code website"></a>
  <a href="https://www.npmjs.com/package/@memorax/memorax-code"><img src="https://img.shields.io/npm/v/@memorax/memorax-code.svg" alt="npm version"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D24-339933?logo=node.js&logoColor=white" alt="Node.js 24 or newer">
</p>

<p align="center">
  <strong>English</strong> · <a href="README.zh.md">简体中文</a>
</p>

## Start the Next Task with What You Already Learned

Coding agents are effective in the current conversation, but a new session can
lose the architecture, failed attempts, repository knowledge, working
procedures, and communication preferences established earlier.

MemoraX Code gives Codex and Claude Code a shared memory for that context. It
helps future sessions recall relevant engineering lessons, understand the
current repository sooner, and continue working in the way you prefer.

With MemoraX Code, you can:

- carry useful engineering knowledge across sessions;
- keep repository context available to Codex and Claude Code;
- reuse your preferred procedures and collaboration style; and
- inspect local activity through Memory Viewer.

## Quick Start

You need Node.js 24 or newer and either Codex or Claude Code. Python 3 is needed
only when you use Repo Memory features.

Run:

```bash
npm install -g @memorax/memorax-code
memorax-code setup
```

Setup automatically configures your memory preferences; no account or API key
is required beforehand. Run `memorax-code setup` again whenever you need to
reuse, reconfigure, or repair the installation. After setup, `memorax-code`
shows the current status.

## Try Cross-Session Memory

Open Codex or Claude Code in a project and complete a real coding task. In
Codex, invoke `$memorax-code`; in Claude Code, invoke `/memorax-code`.

Ask the agent to remember a verified engineering lesson, start a new session in
the same repository, and ask it to recall that lesson. MemoraX Code should bring
back the relevant context for the new task.

## Common Commands

```bash
memorax-code status
memorax-code update
memorax-code setup
memorax-code uninstall
```

## Learn More

- [Installation](INSTALL.md)
- [Configuration](docs/configuration.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Security](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## License

MemoraX Code is available under the [MIT License](LICENSE).
