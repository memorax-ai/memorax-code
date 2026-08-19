# @memorax/memorax-code

MemoraX Code gives Codex and Claude Code shared, persistent memory across
coding sessions.

## Quick Start

You need Node.js 24 or newer and either Codex or Claude Code. Then run:

```bash
npm install -g @memorax/memorax-code
memorax-code setup
```

Setup automatically detects your User ID and language; no account or API key
is required beforehand. If you already have a MemoraX account, run
`memorax-code setup --existing-account` instead. Later setup runs reuse a saved
configuration automatically; use `memorax-code setup --reconfigure` to replace
it.

To check the installation or reconfigure later:

```bash
memorax-code status
memorax-code setup
```

For more help, see `docs/configuration.md` and `docs/troubleshooting.md` in the
installed package.

## License

MIT
