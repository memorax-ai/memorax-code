# @memorax/memorax-code

MemoraX Code adds persistent coding memory to Codex, Claude Code, DeepSeek
Harness, and OpenCode.

## Requirements

- Node.js 20 or newer (Node.js 24 LTS recommended) and npm.
- At least one of Codex, Claude Code, DeepSeek Harness, OpenCode Desktop, or
  the OpenCode CLI.
- Python 3 only for Repo Memory operations.

## Install

```bash
npm install -g @memorax/memorax-code
```

### Connect a MemoraX Account (Recommended)

[Create a MemoraX account](https://platform.memorax.net/) or use an existing
one, then run:

```bash
memorax-code setup --existing-account
```

> Using MemoraX Code across devices? Find the MemoraX username and API key
> needed by setup in the MemoraX Code configuration file on a configured device
> (normally `~/.memorax-code/config.toml`), then enter them locally during setup
> on another device. This file contains your API key—keep it private and never
> paste it into chats or public issues.

### Or Try Without an Account (90-Day Guest Mode)

To start immediately and connect an account later, run:

```bash
memorax-code setup
```

To activate your guest account, first run this command directly in your local
terminal:

```bash
memorax-code account --show-mark-id
```

After obtaining the Mark ID, create your MemoraX account. The platform does
not currently support attaching a Mark ID to an account that has already been
registered.

Both setup paths automatically detect supported coding agents. Later setup
runs reuse a complete saved configuration; use
`memorax-code setup --reconfigure` to replace it.

On Windows, interactive setup also verifies npm's global command directory and
adds it to the current setup process and the Windows user `PATH` when needed.
If the current shell cannot find `memorax-code`, bootstrap setup with:

```powershell
$NpmGlobalBin = (npm prefix -g).Trim()
$env:Path = "$NpmGlobalBin;$env:Path"
& (Join-Path $NpmGlobalBin "memorax-code.cmd") setup
```

After the first installation, restart or refresh the detected coding agents
before opening a new session. In Codex, enable **MemoraX Code Codex Adapter**
from Plugins or `/plugins` if it is not already enabled.

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
