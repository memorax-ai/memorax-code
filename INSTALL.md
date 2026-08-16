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
- On Linux, `/usr/bin/secret-tool` from libsecret and an available Secret
  Service in the current user session for setup-managed trial credentials.

MemoraX-backed search, retrieval, and writeback additionally require network
access. First-time setup creates or restores a trial connection after you
choose a Memory ID and preferred memory language. You do not need to register
an account or create an API key beforehand. Existing manually managed MemoraX
connections remain supported through configuration or environment variables.

For Remote SSH, WSL, or Dev Container use, install MemoraX Code inside the same
remote environment as the client runtime. On Linux, that environment must also
have access to the same user's Secret Service; MemoraX Code does not fall back
to plaintext credential storage.

## 1. Choose a Memory ID

Setup asks for a stable Memory ID and a preferred memory language. The Memory
ID becomes the base of each workspace-scoped memory namespace. Choose an ID
you intend to keep: changing it later starts using a different namespace.

During setup, MemoraX Code explains that automatic writeback from trusted
workspace sessions sends selected user prompts and matching final assistant
answers to MemoraX for extraction and storage. Completing trial provisioning
after that disclosure enables the core MemoraX-backed memory features. New
configuration enables automatic writeback, leaves automatic retrieval
disabled, and enables content-bearing local client traces. Review
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

Automatic setup first checks for a locally ready MemoraX connection, including
configuration and secure trial credentials retained across a product
uninstall. When one is found, setup asks whether to reuse the saved connection
and memory preferences. Accepting keeps the existing Memory ID, language, and
credential without asking for them again.

If no ready connection exists, or you decline reuse, setup asks only for a
Memory ID and preferred language. It then creates or restores a trial
credential, stores the trial secret outside `config.toml`, and writes the
endpoint, Memory ID, and language preference to configuration. The initial
local reuse check does not contact MemoraX; trial provisioning does, and the
first workspace-scoped memory request verifies use of the connection by the
memory API.

Setup:

1. detects runnable Codex and Claude Code clients independently;
2. enables every detected client on a fresh setup and preserves existing
   client intent on later runs;
3. offers to reuse a locally ready connection during automatic setup, or asks
   for a Memory ID and language before creating or restoring a trial
   credential;
4. applies the selected Memory ID and language only after trial credential
   provisioning succeeds;
5. activates the bundled Codex Hooks when first enabling that integration and
   requests review for new or changed Hooks on later updates;
6. stages the packaged Hook runtime, starts the selected integrations, and
   verifies their status; and
7. writes setup completion only after a final local MemoraX readiness check
   succeeds.

Starting interactive setup is the consent boundary for initial Codex Hook
activation. When no active MemoraX Code Codex plugin exists, setup activates
the bundled plugin and trusts its current Hook command hashes without a second
confirmation. New or changed Hook command hashes in later updates still
require foreground review.

To replace the Memory ID or language preference, switch from a manually stored
`config.toml` API key to the setup-managed trial connection, or rerun or repair
setup even when completion is already recorded, use:

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
configuration, effective credential, workspace scope, and memory switches
resolve without printing the API key. It does not send a test request to the
memory API; the first real search or write verifies that connection.

## Incomplete Setup

Package installation can succeed while setup remains incomplete. Run
`memorax-code setup` from an interactive terminal to resume or repair client,
Hook, Backend, and MemoraX configuration.

During automatic setup, accepting the saved connection avoids asking for the
Memory ID and language again. Run explicit `memorax-code setup` when you want
to replace those retained preferences or move to the setup-managed trial
connection.

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
retaining `$MEMORAX_CODE_HOME` configuration and local traces, the secure trial
credential, Claude plugin data, client provider configuration, and memories
stored in MemoraX. Review and remove retained local or cloud data separately
only when it is no longer needed.

A complete product uninstall clears the setup-completion routing marker without
deleting the retained configuration. After reinstalling, the next no-argument
`memorax-code` runs automatic setup, restores the integrations, and offers to
reuse a locally ready MemoraX connection. A normal `memorax-code stop` and a
partial client uninstall do not clear setup completion.

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
