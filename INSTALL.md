# Install MemoraX Code

The public MemoraX Code release is distributed as one platform-neutral npm
package for macOS, Linux, and Windows. This guide covers the normal end-user
installation. For a source checkout and contributor setup, see
[CONTRIBUTING.md](CONTRIBUTING.md).

## Requirements

- Node.js 24 or newer and npm.
- At least one of Codex, Claude Code, or DeepSeek Harness (DSH) installed in
  the environment where MemoraX Code will run.
- `pnpm` on `PATH` when managing the profile-local DSH plugin.
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
npm install -g @memorax/memorax-code --foreground-scripts
```

Keep `--foreground-scripts`. It makes the setup prompts, Hook authorization,
Backend status, and client guidance visible.

The installer:

1. Detects runnable Codex and Claude Code clients plus every existing valid
   DSH profile. It never creates a DSH profile during installation.
2. Enables every detected harness without asking for a selector.
3. Prompts for the MemoraX connection and preferred language when at least one
   supported harness was detected, including a DSH-only installation.
4. Requests Codex Hook activation and trust when Codex is detected.
5. Installs the package-local DSH Cordis bundle into each detected profile.
6. Starts the local Backend and prints the final status.

Read the final summary. npm can finish installing the package even when a
client integration or MemoraX configuration still needs attention.
MemoraX Code does not read or change any harness's model-provider URL,
credentials, model, or login mode.

Do not use `--ignore-scripts` for a normal install or update. It skips the
managed Backend retirement, interactive setup, adapter reconciliation, and
final health check.

## 3. Finish Client Setup

After the first installation, restart or refresh every detected harness before
opening a new MemoraX Code session.

For Codex, enable **MemoraX Code Codex Adapter** from Plugins or `/plugins` if
it is not already enabled. Claude Code registration is handled by the
installer. DSH registration is profile-local; invoke the shared skill as
`/memorax-code` after restarting that profile.

Search, Add, automatic retrieval, and writeback do not require a particular
DSH profile type. DSH Repo Memory build and maintenance additionally require an
existing profile containing `@deepseek-ai/dsh-headless`. Create or initialize
that profile with DSH, then rerun `memorax-code start`; the installer never
creates one.

Open the harness in a real project directory and submit at least one prompt
before using its diagnostics as the final verification. Until Codex or Claude
Code Hooks have observed a workspace session, their workspace capture can
correctly report that it still needs attention.

## 4. Verify the Installation

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

`memorax-code status` checks the local Backend and selected harness
integrations, including a content-free DSH adapter and profile summary.
`memorax-cli status` checks whether the local MemoraX configuration, workspace
scope, and memory switches resolve without printing the API key. It does not
send a test request to MemoraX; the first real search or write verifies remote
connectivity and credentials.

## Skipped or Non-Interactive Setup

If setup was skipped or could not prompt, the package may be installed while
MemoraX remains unconfigured. In that state, the local Backend and adapters can
run, but MemoraX-backed search, retrieval, and writeback are unavailable.

Add the required MemoraX values to
`$MEMORAX_CODE_HOME/config.toml`—`~/.memorax-code/config.toml` by default—or
provide the documented environment variables. Then reconcile and verify:

```bash
memorax-code start
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

Follow any Hook review or harness refresh guidance printed by the updater. An
update briefly stops the managed Backend before postinstall starts the new
version. For a runtime-only update with the stable plugin shell, an in-flight
turn can finish on its loaded generation and the same session's next user
prompt can select the newly activated Hook runtime. Restart or refresh the
harness when a release changes its plugin shell, manifest, or bundled skill.
The updater also discovers and reconciles DSH profiles created since the last
installation.

## Uninstall

Run the product lifecycle before removing package files:

```bash
memorax-code uninstall
```

Do not start with `npm uninstall -g`. npm does not provide MemoraX Code with an
uninstall lifecycle in which to disable managed Hooks and stop the Backend.
The product command removes the managed integrations and global package while
retaining `$MEMORAX_CODE_HOME` configuration and local traces, Claude and DSH
user data, harness provider configuration, and memories stored in MemoraX. Review
and remove retained local or cloud data separately only when it is no longer
needed.

## Troubleshooting

Start with:

```bash
memorax-code status
memorax-cli status
memorax-code-codex doctor
memorax-code-claude doctor
dsh plugin --profile <profile> why @memorax-code/dsh-adapter
memorax-code logs
```

See [Troubleshooting](docs/troubleshooting.md) for recovery steps and safe issue
reporting guidance.
