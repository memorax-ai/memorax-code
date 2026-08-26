# @memorax/memorax-code

MemoraX Code adds persistent coding memory to Codex, Claude Code, DeepSeek
Harness, OpenCode, and Kimi Code.

## Requirements

- Node.js 20 or newer (Node.js 24 LTS recommended) and npm.
- At least one of Codex, Claude Code, DeepSeek Harness, OpenCode Desktop, Kimi Code, or
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

After setup, enable Kimi explicitly with `memorax-code start --clients kimi`
because its native Hook config is shared with other local Kimi customizations.

After the first installation, restart or refresh the detected coding agents
before opening a new session. In Codex, enable **MemoraX Code Codex Adapter**
from Plugins or `/plugins` if it is not already enabled.

Kimi Code receives the shared `memorax-code` Skill under its managed user skill
directory. In Kimi, invoke it as `/memorax-code`; its explicit `search` and `add`
operations use the configured MemoraX service through `memorax-cli`.

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
