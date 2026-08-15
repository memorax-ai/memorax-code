# @memorax/memorax-code

MemoraX Code adds one shared persistent coding memory layer to supported coding
agent harnesses, including Codex, Claude Code, and DeepSeek Harness (DSH).

## Requirements

- Node.js 24 or newer and npm.
- At least one supported coding agent harness.
- A MemoraX account, Base User ID, and API key for memory features.
- Python 3 only for Repo Memory operations.

## Install

Create an API key in
[MemoraX Console](https://platform.memorax.net/), then run:

```bash
npm install -g @memorax/memorax-code --foreground-scripts
```

Keep `--foreground-scripts` so npm displays the complete setup.

The installer automatically detects supported harnesses and configures every
one it finds. Follow the prompts to enter your MemoraX Base User ID, preferred
language, and API key, and complete any harness-native approval it requests.

Entering the MemoraX credentials after the installer's disclosure enables the
core memory features and automatic writeback. If setup is skipped or cannot
prompt, the package remains installed, but MemoraX-backed memory is not
configured.

After the first installation, restart or refresh the detected harnesses before
opening a new session.

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
