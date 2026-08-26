# Install MemoraX Code

The public MemoraX Code release is distributed as one platform-neutral npm
package for macOS, Linux, and Windows. This guide covers the normal end-user
installation. For a source checkout and contributor setup, see
[CONTRIBUTING.md](CONTRIBUTING.md).

## Requirements

- Node.js 20 or newer (Node.js 24 LTS recommended) and npm.
- At least one of Codex, Claude Code, DeepSeek Harness (DSH), OpenCode Desktop,
  or the OpenCode CLI available in the environment where MemoraX Code will
  run. DSH must already be installed globally or initialized through its
  official `npx` workflow; MemoraX Code does not install or update it. DSH
  integration requires at least one existing Profile and `pnpm` on `PATH`
  because DSH's native Profile plugin manager delegates package changes to it.
  The tested DSH baseline is `0.1.0-rc.6`; other valid semantic versions are
  reported as untested rather than rejected automatically.
- Python 3 only when using Repo Memory operations.
- On Linux, `/usr/bin/secret-tool` from libsecret and an available Secret
  Service in the current user session for setup-managed credentials.

MemoraX-backed search, retrieval, and writeback require network access.
Connecting a MemoraX account is recommended. A 90-day account-free guest mode
is also available if you want to try MemoraX Code before creating an account.

For Remote SSH, WSL, or Dev Container use, install MemoraX Code inside the same
remote environment as the client runtime.

## 1. Install the Package

```bash
npm install -g @memorax/memorax-code
```

This command installs or replaces package files. It does not run interactive
setup, ask for credentials, authorize Hooks, or start a fresh installation.
When replacing a running managed Backend, npm lifecycle scripts briefly stop
it, install the new package, and restore it with the retained client selection.
An installation that was already stopped remains stopped.

Do not use `--ignore-scripts` for a normal install or update. It skips the
safe retirement and restoration of a running managed Backend.

## 2. Connect a MemoraX Account (Recommended)

[Create a MemoraX account](https://platform.memorax.net/) or use an existing
one, then run this command from a normal interactive terminal:

```bash
memorax-code setup --existing-account
```

This mode asks for the username used by the existing MemoraX Code connection
and accepts the API key through masked local terminal input. Never paste an API
key into a chat, repository, screenshot, or public issue.

### Or Try Without an Account (90-Day Guest Mode)

To start immediately and connect an account later, run:

```bash
memorax-code setup
```

Default setup automatically reuses a complete existing configuration. If no
ready connection exists, it detects the local username and preferred language,
asks only when either value cannot be detected safely, and creates or restores
an account-free credential. The resulting API key is written to the private
configuration together with the selected memory preferences.

To activate your guest account, first run this command directly in your local
terminal:

```bash
memorax-code account --show-mark-id
```

After obtaining the Mark ID, create your MemoraX account. The platform does
not currently support attaching a Mark ID to an account that has already been
registered.

Use `memorax-code setup --reconfigure` to replace an automatically reusable
connection and re-detect its preferences. Setup detects supported clients,
installs or refreshes their integrations, starts the local Backend, verifies
status, and records completion only after the final checks succeed.

Running `memorax-code` with no command reports setup guidance until completion
is recorded; afterward it shows status. Setup requires an interactive terminal
and exits without recording completion when stdin or stderr is detached or
redirected.

During setup, MemoraX Code explains that automatic writeback from trusted
workspace sessions sends selected user prompts and matching final assistant
answers to MemoraX for extraction and storage. New configuration enables
automatic writeback, leaves automatic retrieval disabled, and enables
content-bearing local client traces. Review [SECURITY.md](SECURITY.md) for the
network, local-data, credential-storage, and retention boundaries.

MemoraX Code does not read or change the clients' model-provider URL,
credentials, model, or login mode.

## 3. Finish Client Setup

After the first installation, restart or refresh every detected client before
opening a new MemoraX Code session.

For Codex, enable **MemoraX Code Codex Adapter** from Plugins or `/plugins` if
it is not already enabled. Claude Code registration is handled by the
installer.

OpenCode registration uses its plugin and skill auto-discovery. Restart or
refresh OpenCode after installation so the managed integration is loaded.

DSH registration is applied to the existing Profiles found under `DSH_HOME`
(`~/.dsh` by default). Restart or refresh DSH after installation so those
Profiles load the managed integration. MemoraX Code does not replace the
Profiles or their session data. If no global `dsh` command is available,
MemoraX Code can use the DSH runtime already linked into the existing Profile
dependency tree. It never invokes `npx` or installs or updates DSH.
If automatically discovered DSH is unavailable, setup keeps the Backend and
other detected clients running and reports the DSH integration as degraded.
After repairing DSH, run `memorax-code start --clients dsh` to reconcile it;
explicit DSH selection reports failure until the integration is ready.

Open the client in a real project directory and submit at least one prompt
before using the client doctor as the final verification. Until the Hooks have
observed a workspace session, workspace capture can correctly report that it
still needs attention.

## 4. Verify the Installation

Run the common checks:

```bash
memorax-code --version
memorax-code status
memorax-cli status
```

Codex, Claude Code, and OpenCode also provide client-specific doctor commands:

```bash
memorax-code-codex doctor
memorax-code-claude doctor
memorax-code-opencode doctor
```

`memorax-code status` checks the local Backend and selected client
integrations, including DSH Profile and OpenCode plugin status. DSH uses this
shared status command rather than a separate doctor binary. `memorax-cli status`
checks whether the local MemoraX configuration, workspace scope, and
memory switches resolve without printing the API key. It does not send a test
request to MemoraX; the first real search or write verifies remote connectivity
and credentials.

## Incomplete Setup

Package installation can succeed while setup remains incomplete. Resume or
repair it from an interactive terminal:

```bash
memorax-code setup
memorax-code status
memorax-cli status
```

Default setup reuses a complete retained connection. Use
`memorax-code setup --reconfigure` to replace it, or
`memorax-code setup --existing-account` to enter an existing account.

See [Configuration](docs/configuration.md) for the supported fields and
environment variables.

## Update

Update through the product command so the installed release channel, managed
home, client selection, and lifecycle hooks are handled consistently:

```bash
memorax-code update
```

For a custom state root, pass its absolute path explicitly:

```bash
memorax-code update --home /absolute/path/to/memorax-code-home
```

The updater uses the standard npm install command. If the managed Backend is
running, package replacement briefly stops it, starts the new version with the
retained client selection, and verifies status. A stopped installation remains
stopped.

After npm succeeds, an interactive product update reviews newly available
clients and changed Codex Hooks in foreground setup, but only after setup has
previously completed. Without that completion, or in a non-interactive update,
package replacement still completes and the updater tells you to run
`memorax-code setup` explicitly. Direct npm updates perform only package
replacement.

## Uninstall

Run the product lifecycle before removing package files:

```bash
memorax-code uninstall
```

Do not start with `npm uninstall -g`. npm does not provide MemoraX Code with an
uninstall lifecycle in which to remove managed client integrations and stop
the Backend.
The product command removes the managed integrations and global package while
retaining `$MEMORAX_CODE_HOME` configuration and local traces, Claude plugin
data, DSH Profiles and session data, client provider configuration, secure
account-free credentials, and memories stored in MemoraX. Review and remove
retained local or cloud data separately only when it is no longer needed.

A complete product uninstall clears the setup-completion marker but preserves
the retained configuration. After reinstalling, run `memorax-code setup`;
default setup reuses a complete retained connection automatically. A normal
`memorax-code stop` and a partial client uninstall preserve setup completion.

## Troubleshooting

Start with:

```bash
memorax-code status
memorax-cli status
memorax-code-codex doctor
memorax-code-claude doctor
memorax-code status --clients dsh
memorax-code-opencode doctor
memorax-code logs
```

See [Troubleshooting](docs/troubleshooting.md) for recovery steps and safe issue
reporting guidance.
