# @memorax/memorax-code

MemoraX Code gives Codex and Claude Code shared, persistent memory across
coding sessions.

## Quick Start

You need Node.js 24 or newer and either Codex or Claude Code. Create an API key
in [MemoraX Console](https://platform.memorax.net/), then run:

```bash
npm install -g @memorax/memorax-code
memorax-code
```

The first launch completes any setup that is still needed. If MemoraX has not
been configured yet, enter your Base User ID, preferred memory language, and
API key when prompted.

To check the installation or reconfigure later:

```bash
memorax-code status
memorax-code setup
```

For more help, see `docs/configuration.md` and `docs/troubleshooting.md` in the
installed package.

## License

MIT
