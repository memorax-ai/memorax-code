# @memorax/memorax-code

MemoraX Code adds persistent coding memory to Codex, Claude Code, DeepSeek
Harness, and OpenCode.

## Requirements

- Node.js 20 or newer (Node.js 24 LTS recommended) and npm.
- At least one of Codex, Claude Code, DeepSeek Harness, OpenCode Desktop, or
  the OpenCode CLI.
- Python 3 only for Repo Memory operations.

## Install

Install the package, then run setup from a normal interactive terminal:

```bash
npm install -g @memorax/memorax-code
memorax-code setup
```

Setup automatically detects your username and language; no account or API key
is required beforehand. If you already have a MemoraX account, run
`memorax-code setup --existing-account` instead. Later setup runs reuse a saved
configuration automatically; use `memorax-code setup --reconfigure` to replace
it.

Setup detects supported Codex, Claude Code, DeepSeek Harness, and OpenCode
installations and configures those it finds. Completing setup after its data
disclosure enables the core memory features and automatic writeback. Restart or
refresh each detected coding agent after setup. In Codex, enable **MemoraX Code
Codex Adapter** from Plugins or `/plugins` if it is not already enabled.

## Verify

```bash
memorax-code --version
memorax-code status
memorax-cli status
```

For configuration or troubleshooting, see the documentation shipped with the
package:

- `docs/configuration.md`
- `docs/troubleshooting.md`

## License

MIT
