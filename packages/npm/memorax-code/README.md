# @memorax/memorax-code

MemoraX Code adds persistent coding memory to Codex, Claude Code, DeepSeek
Harness, and OpenCode.

## Quick Start

- Node.js 20 or newer (Node.js 24 LTS recommended) and npm.
- At least one of Codex, Claude Code, DeepSeek Harness, OpenCode Desktop, or
  the OpenCode CLI.
- Python 3 only for Repo Memory operations.

## Install

Run:

```bash
npm install -g @memorax/memorax-code
memorax-code setup
```

Setup automatically detects your User ID and language; no account or API key
is required beforehand. If you already have a MemoraX account, run
`memorax-code setup --existing-account` instead. Later setup runs reuse a saved
configuration automatically; use `memorax-code setup --reconfigure` to replace
it.

Setup detects supported Codex, Claude Code, DeepSeek Harness, and OpenCode
installations. Restart or refresh each detected coding agent after setup.

To check the installation or reconfigure later:

```bash
memorax-code status
memorax-code setup
```

For more help, see `docs/configuration.md` and `docs/troubleshooting.md` in the
installed package.

## License

MIT
