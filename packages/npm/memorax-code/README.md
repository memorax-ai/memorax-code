# @memorax/memorax-code

MemoraX Code adds persistent coding memory to Codex, Claude Code, and OpenCode.

## Requirements

- Node.js 24 or newer and npm.
- Codex, Claude Code, or OpenCode Desktop.
- A MemoraX account, Base User ID, and API key for memory features.
- Python 3 only for Repo Memory operations.

## Install

Create an API key in
[MemoraX Console](https://platform.memorax.net/), then run:

```bash
npm install -g @memorax/memorax-code --foreground-scripts
```

Keep `--foreground-scripts` so npm displays the complete setup.

The installer automatically detects available Codex, Claude Code, and OpenCode
clients and configures each client it finds. Follow the prompts to
enter your MemoraX Base User ID, preferred language, and API key. When Codex is
detected, review and approve its Hook activation.

Entering the MemoraX credentials after the installer's disclosure enables the
core memory features and automatic writeback. If setup is skipped or cannot
prompt, the package remains installed, but MemoraX-backed memory is not
configured.

After the first installation, restart or refresh the detected clients before
opening a new session. In Codex, enable **MemoraX Code Codex Adapter** from
Plugins or `/plugins` if it is not already enabled.

OpenCode is detected through its shared configuration directory or an
`opencode` CLI in `PATH`; Desktop-only installations do not require the CLI.
The default managed discovery paths are `~/.config/opencode/plugins/memorax-code.js` and
`~/.config/opencode/skills/memorax-code/`. The installer does not modify
`opencode.json` or `opencode.jsonc`.

OpenCode support covers the shared skill, Search/Add, automatic retrieval when
enabled, completed-turn writeback, supervised background Repo Memory
maintenance during repo-read, and automatic background initialization of a
missing Repo Memory bundle on the first eligible prompt.

## Verify

```bash
memorax-code --version
memorax-code status
memorax-cli status
memorax-code-opencode doctor
```

For configuration or troubleshooting, see the documentation shipped with the
package:

- `docs/configuration.md`
- `docs/troubleshooting.md`

## License

MIT
