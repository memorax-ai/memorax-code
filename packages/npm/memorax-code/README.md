# @memorax/memorax-code

MemoraX Code adds persistent coding memory to Codex, Claude Code,
CodeBuddy CLI, WorkBuddy, DeepSeek Harness, OpenCode, Trae, and Cursor.

## Requirements

- Node.js 20 or newer (Node.js 24 LTS recommended) and npm.
- At least one of Codex, Claude Code, CodeBuddy CLI, WorkBuddy, DeepSeek Harness,
  OpenCode Desktop or CLI, Trae, or Cursor.

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

For an agent without an interactive terminal, supply the key through stdin.
This example assumes the caller already provided `MEMORAX_SETUP_API_KEY`:

```bash
printf '%s\n' "$MEMORAX_SETUP_API_KEY" | memorax-code setup --existing-account --non-interactive
```

In Windows PowerShell, use
`$env:MEMORAX_SETUP_API_KEY | memorax-code.cmd setup --existing-account --non-interactive`.
This command replaces the saved key, detects the local username and language,
and checks the saved key without printing it. `API Key match: true` reports a
local match, not cloud authentication. Input requirements and reuse behavior
are described in `docs/configuration.md`.

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

Both account and guest setup automatically detect supported coding agents.
Default setup reuses a complete saved configuration; use
`memorax-code setup --reconfigure` to replace it.

On Windows, setup also verifies npm's global command directory and
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
For Trae, open Settings and enable **Global Hooks** once before starting a new
Trae session; setup installs the managed Hooks and Skill but cannot switch that
Trae setting reliably.
Cursor installs native user Hooks and the shared Skill under `~/.cursor`,
independently of Claude Code; `CURSOR_HOME` overrides that root. Restart or
refresh Cursor and open a new conversation. Use the Skill for CLI Search and
manual Add. Automatic Add uses verified completed turns from Cursor's native
SQLite database. Automatic prompt retrieval is not enabled for Cursor. See the
Cursor section in
`docs/configuration.md` for writeback conditions.

## Verify

```bash
memorax-code --version
memorax-code status
memorax-cli status
```

In Windows PowerShell, use `memorax-cli.cmd status`.

For configuration or troubleshooting, see the documentation shipped with the
package:

- `docs/configuration.md`
- `docs/troubleshooting.md`

## License

MIT
