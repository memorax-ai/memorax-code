# @memorax/memorax-code

MemoraX Code adds one shared persistent coding memory layer to Codex, Claude
Code, and DeepSeek Harness (DSH).

## Requirements

- Node.js 24 or newer and npm.
- Codex, Claude Code, or DSH.
- A MemoraX account, Base User ID, and API key for memory features.
- Python 3 only for Repo Memory operations.
- `pnpm` on `PATH` when managing the profile-local DSH plugin.

## Install

Create an API key in
[MemoraX Console](https://platform.memorax.net/), then run:

```bash
npm install -g @memorax/memorax-code --foreground-scripts
```

Keep `--foreground-scripts` so npm displays the complete setup.

The installer automatically detects Codex and Claude Code plus existing valid
DSH profiles, then configures every harness it finds. It does not create DSH
profiles. Follow the prompts to enter your MemoraX Base User ID, preferred
language, and API key. When Codex is detected, review and approve its Hook
activation.

DSH Search, Add, automatic retrieval, and writeback work in every integrated
profile. Building or maintaining Repo Memory from DSH additionally requires an
existing profile that includes `@deepseek-ai/dsh-headless`; initialize that
profile through DSH, then rerun `memorax-code start`.

Entering the MemoraX credentials after the installer's disclosure enables the
core memory features and automatic writeback. If setup is skipped or cannot
prompt, the package remains installed, but MemoraX-backed memory is not
configured.

After the first installation, restart or refresh the detected harnesses before
opening a new session. In Codex, enable **MemoraX Code Codex Adapter** from
Plugins or `/plugins` if it is not already enabled. In DSH, invoke the bundled
skill as `/memorax-code`.

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
