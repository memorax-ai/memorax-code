# Install MemoraX Code

The public MemoraX Code release is distributed as one platform-neutral npm
package for macOS, Linux, and Windows. This guide covers the normal end-user
installation. For a source checkout and contributor setup, see
[CONTRIBUTING.md](CONTRIBUTING.md).

## Requirements

- Node.js 24 or newer and npm.
- At least one of Codex or Claude Code installed in the environment where
  MemoraX Code will run.
- Python 3 only when using Repo Memory operations.

MemoraX-backed search, retrieval, and writeback additionally require a MemoraX
account, Base User ID, API key, and network access. The package, local Backend,
and client adapters can be installed without credentials, but the core memory
features remain unavailable until the account is connected.

For Remote SSH, WSL, or Dev Container use, install MemoraX Code inside the same
remote environment as the client runtime.

## 1. Create a MemoraX Key

Sign in to
[MemoraX Console](https://platform.memorax.net/) and create an API key.
Keep the key private and enter it only in your local installation terminal.
Never paste it into a chat, repository, or public issue.

During setup, MemoraX Code explains that automatic writeback from trusted
workspace sessions sends selected user prompts and matching final assistant
answers to MemoraX for extraction and storage. Entering your Base User ID,
preferred language, and API key after that disclosure enables the core
MemoraX-backed memory features. New configuration enables automatic writeback,
leaves automatic retrieval disabled, and enables content-bearing local client
traces. Review
[SECURITY.md](SECURITY.md) for the network, local-data, and retention
boundaries.

## 2. Install the Package

```bash
npm install -g @memorax/memorax-code
```

This command installs package files. npm lifecycle scripts do not ask setup
questions, inspect new clients, or request Hook authorization.

On a fresh install, or when the managed Backend is already stopped, package
installation does not start the Backend. When replacing a package while its
managed Backend is running, the lifecycle scripts perform only a bounded,
non-interactive package transition:

1. preinstall records that the live Backend must be restored and stops only
   that Backend, without changing the persisted client selection;
2. postinstall starts the new package with the persisted `[clients]` selection
   and verifies `memorax-code status`; and
3. the transition record is consumed only after the replacement is healthy.

If the previous PID authority is absent, dead, or cannot prove a live managed
Backend, installation does not schedule a later restart. Failed or incomplete
transitions fail closed and retain their private recovery record instead of
claiming that the new Backend is healthy.

Do not use `--ignore-scripts` for a normal install or update. It bypasses the
safe retirement and restoration of a running managed Backend.

## 3. Run Setup

Run the installed command from an interactive terminal:

```bash
memorax-code
```

With no arguments, `memorax-code` reads a private setup-completion record. If
the record is absent, it starts interactive setup. After a successful setup,
the same no-argument command routes to `memorax-code status`. Invalid or newer
unsupported completion records fail closed instead of guessing whether setup
finished.

Automatic setup reuses a locally valid effective MemoraX connection, including
configuration retained across a product uninstall, without asking again for
the Base User ID, preferred language, or API key. If the effective connection
is incomplete or invalid, setup asks for replacement connection values. This
local check does not contact MemoraX; remote connectivity and credentials are
still verified by the first real memory request.

Setup:

1. detects runnable Codex and Claude Code clients independently;
2. enables every detected client on a fresh setup and preserves existing
   client intent on later runs;
3. reuses a locally valid MemoraX connection during automatic setup and prompts
   when the effective connection is incomplete or invalid;
4. activates the bundled Codex Hooks when first enabling that integration and
   requests review for new or changed Hooks on later updates;
5. stages the packaged Hook runtime, starts the selected integrations, and
   verifies their status; and
6. writes setup completion only after the final readiness check succeeds.

Starting interactive setup is the consent boundary for initial Codex Hook
activation. When no active MemoraX Code Codex plugin exists, setup activates
the bundled plugin and trusts its current Hook command hashes without a second
confirmation. New or changed Hook command hashes in later updates still
require foreground review.

To deliberately reconfigure the MemoraX connection, or to rerun or repair setup
even when completion is already recorded, use:

```bash
memorax-code setup
```

Setup requires terminal input and terminal-visible diagnostics. A first launch
whose stdin or stderr is piped, redirected, or detached exits without creating
setup completion and tells you to rerun `memorax-code setup` in a terminal.
MemoraX Code does not read or change either client's model-provider URL,
credentials, model, or login mode.

## 4. Finish Client Setup

After successful setup, restart or refresh every detected client before
opening a new MemoraX Code session.

For Codex, enable **MemoraX Code Codex Adapter** from Plugins or `/plugins` if
it is not already enabled. Claude Code registration is handled by the
setup flow.

Open the client in a real project directory and submit at least one prompt
before using the client doctor as the final verification. Until the Hooks have
observed a workspace session, workspace capture can correctly report that it
still needs attention.

## 5. Verify the Installation

Run the common checks:

```bash
memorax-code --version
memorax-code status
memorax-cli status
```

Then run the doctor command for each installed client:

```bash
memorax-code-codex doctor
memorax-code-claude doctor
```

`memorax-code status` checks the local Backend and selected client
integrations. `memorax-cli status` checks whether the local MemoraX
configuration, workspace scope, and memory switches resolve without printing
the API key. It does not send a test request to MemoraX; the first real search
or write verifies remote connectivity and credentials.

## Incomplete Setup

Package installation can succeed while setup remains incomplete. Run
`memorax-code setup` from an interactive terminal to resume or repair client,
Hook, Backend, and MemoraX configuration.

During automatic setup, the absence of MemoraX credential questions is
expected when the existing effective connection is locally valid. Run explicit
`memorax-code setup` when you want to replace those retained values.

If you intentionally manage configuration without the setup prompts, add the
required MemoraX values to
`$MEMORAX_CODE_HOME/config.toml`—`~/.memorax-code/config.toml` by default—or
provide the documented environment variables. Then run explicit setup so the
selected integrations are reconciled, readiness is verified, and setup
completion is recorded:

```bash
memorax-code setup
memorax-code status
memorax-cli status
```

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

The updater invokes the standard npm install command without an interactive
npm postinstall. If the managed Backend was running, the package transition
briefly stops it, starts the new version with the persisted client selection,
and verifies status. A Backend that was already stopped remains stopped.

After npm succeeds, an interactive `memorax-code update` runs setup in update
mode for a running managed home so newly available clients and changed Codex
Hooks can be reviewed in the foreground. A non-interactive update completes
the package replacement but tells you to run `memorax-code setup` later. A
direct `npm install -g @memorax/memorax-code` update performs only the package
transition; run explicit setup when client or Hook assets need review. Initial
activation does not weaken this later changed-Hook review.

For a runtime-only update with the stable plugin shell, an in-flight turn can
finish on its loaded generation and the same session's next user prompt can
select the newly activated Hook runtime. Restart or refresh the client when a
release changes its plugin shell, manifest, or bundled skill.

## Uninstall

Run the product lifecycle before removing package files:

```bash
memorax-code uninstall
```

Do not start with `npm uninstall -g`. npm does not provide MemoraX Code with an
uninstall lifecycle in which to disable managed Hooks and stop the Backend.
The product command removes the managed integrations and global package while
retaining `$MEMORAX_CODE_HOME` configuration and local traces, Claude plugin
data, client provider configuration, and memories stored in MemoraX. Review
and remove retained local or cloud data separately only when it is no longer
needed.

A complete product uninstall clears the setup-completion routing marker without
deleting the retained configuration. After reinstalling, the next no-argument
`memorax-code` runs automatic setup, restores the integrations, and reuses a
locally valid MemoraX connection. A normal `memorax-code stop` and a partial
client uninstall do not clear setup completion.

## Troubleshooting

Start with:

```bash
memorax-code status
memorax-cli status
memorax-code-codex doctor
memorax-code-claude doctor
memorax-code logs
```

See [Troubleshooting](docs/troubleshooting.md) for recovery steps and safe issue
reporting guidance.
