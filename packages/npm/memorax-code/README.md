# @memorax/memorax-code

MemoraX Code adds persistent coding memory to Codex and Claude Code.

## Requirements

- Node.js 24 or newer and npm.
- Codex or Claude Code.
- A MemoraX account, Base User ID, and API key for memory features.
- Python 3 only for Repo Memory operations.

## Install

Create an API key in
[MemoraX Console](https://platform.memorax.net/), then run:

```bash
npm install -g @memorax/memorax-code --foreground-scripts
```

Keep `--foreground-scripts` so npm displays the complete setup.

The installer automatically detects the Codex and Claude Code clients available
on the machine and configures each client it finds. Follow the prompts to enter
your MemoraX Base User ID, preferred language, and API key. When Codex is
detected, review and approve its Hook activation.

Entering the MemoraX credentials after the installer's disclosure enables the
core memory features and automatic writeback. If setup is skipped or cannot
prompt, the package remains installed, but MemoraX-backed memory is not
configured.

After the first installation, restart or refresh the detected clients before
opening a new session. In Codex, enable **MemoraX Code Codex Adapter** from
Plugins or `/plugins` if it is not already enabled.

On the first eligible prompt in a Git worktree, the client Hook checks for
`.repo_memory/PROFILE.md`. If it is missing, MemoraX Code starts the initial
Repo Memory build in the background without blocking the prompt. Non-Git and
Codex projectless workspaces are skipped, and active jobs are deduplicated.

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
