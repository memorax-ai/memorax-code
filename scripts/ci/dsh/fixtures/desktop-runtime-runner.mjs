import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { USER_PROMPT, VISIBLE_REPLY } from '../dsh-desktop-native-support.mjs';

// Run by the official app's Electron binary with ELECTRON_RUN_AS_NODE=1.
// This exercises the Desktop profile and its host runtime, not the GUI shell.
const [mode, runtimeDirectory, reportPath] = process.argv.slice(2);
assert.ok(['init', 'boot', 'turn'].includes(mode), 'expected init, boot, or turn');
assert.ok(process.versions.electron, 'the official Electron Node runtime is required');
assert.ok(process.env.DSH_HOME && process.env.HOME, 'isolated homes are required');
const runtimeDir = resolve(runtimeDirectory);
const installAnchor = join(runtimeDir, 'node_modules/@deepseek-ai/dsh/package.json');
const runtimeRequire = createRequire(installAnchor);
const fromRuntime = async (specifier) => import(pathToFileURL(runtimeRequire.resolve(specifier)));
const { initProfile, resolveProfileDir, PROFILE_TEMPLATES, loadProfileDirectory, loadLayeredEnv } = await fromRuntime('@deepseek-ai/dsh-app-boot');
const profileDir = resolveProfileDir('desktop');
const identity = JSON.parse(await readFile(installAnchor, 'utf8'));
const result = {
  mode, validationSurface: 'official Electron Node runtime with reserved desktop profile; GUI not exercised',
  dshVersion: identity.version, electron: process.versions.electron, node: process.versions.node,
  profileDir, runtimeDir, stages: [],
};
let application;
let handle;
async function save() {
  if (reportPath) await writeFile(reportPath, JSON.stringify(result, null, 2) + '\n');
}
try {
  await mkdir(profileDir, { recursive: true });
  initProfile(profileDir, PROFILE_TEMPLATES.web.bundles);
  result.bundles = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')).dsh.profile.bundles;
  result.stages.push('initProfile(web template)');
  if (mode !== 'init') {
    const { runProfile } = await fromRuntime('@deepseek-ai/dsh/profile-boot');
    const profile = loadProfileDirectory('dsh', profileDir, installAnchor);
    application = await runProfile({
      environment: loadLayeredEnv('dsh'),
      profile: 'desktop',
      resolvedProfile: { profile, installAnchor },
      patchFiles: [],
      args: ['--no-open', '--host', '127.0.0.1', '--port', '0'],
    });
    const { ctx } = application;
    result.stages.push('runProfile(desktop)');
    assert.equal(ctx.profileContext.name, 'desktop');
    result.profileName = ctx.profileContext.name;
    result.webPort = ctx.webServer.port;
    result.presets = await ctx.agentPresets.list();
    const inventory = await ctx.pluginInventory.list();
    result.memoraxEntries = inventory.entries.filter((entry) => entry.moduleName === '@memorax-code/dsh-memorax-code');
    result.providers = ctx.llm.listProviders().map(({ id }) => id);
    if (mode === 'turn') {
      assert.ok(result.memoraxEntries.some((entry) => entry.enabled && entry.fiberPhase === 'active'), 'MemoraX plugin must be active in the Desktop profile');
      const { createUserMessage } = await fromRuntime('@deepseek-ai/dsh-llm');
      const { SessionId } = await fromRuntime('@deepseek-ai/dsh-session');
      const preset = await ctx.agentPresets.resolve('standard');
      assert.equal(preset.broken, undefined, 'standard preset must activate');
      handle = await ctx.agents.create({
        sessionId: SessionId(`memorax-desktop-compat-${Date.now()}`),
        meta: { cwd: process.cwd(), agentPreset: preset.id },
        agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash' },
        setup: (agentCtx) => ctx.agentPresets.mount(agentCtx, preset.id).then(() => undefined),
      });
      result.sessionId = handle.agent.session.id;
      const idle = new Promise((resolveIdle, reject) => {
        const timer = setTimeout(() => { dispose(); reject(new Error('native Desktop turn did not settle in 60 seconds')); }, 60_000);
        const dispose = ctx.on('agent/status', ({ agent, status }) => {
          if (agent !== handle.agent || status !== 'idle') return;
          clearTimeout(timer);
          dispose();
          resolveIdle();
        });
      });
      handle.agent.followup(createUserMessage({
        content: [{ type: 'text', text: USER_PROMPT }],
        source: { kind: 'user' },
      }));
      await idle;
      await ctx.sessions.flush(handle.agent.session);
      const events = handle.agent.session.snapshotEvents();
      result.sessionVersion = handle.agent.session.header.version;
      result.eventTypes = events.map((event) => event.type);
      result.turnEnds = events.filter((event) => event.type === 'turn/end').map((event) => event.data);
      result.reminderSources = events.filter((event) => event.type === 'user/message' && event.data.source?.kind === 'plugin:memorax-code-dsh').map((event) => event.data.source);
      result.replyObserved = events.some((event) => event.type === 'assistant/message' && JSON.stringify(event.data).includes(VISIBLE_REPLY));
      assert.equal(result.sessionVersion, 4);
      assert.ok(result.replyObserved, 'local model fixture response must be present in native Session events');
      assert.ok(result.turnEnds.some((end) => end.reason?.kind === 'completed'), 'native turn must complete');
      assert.ok(result.reminderSources.length > 0, 'MemoraX context must pass the native v4 message writer');
      await handle.dispose();
      handle = undefined;
      result.stages.push('native agent completed and disposed');
    }
  }
  result.ok = true;
} catch (error) {
  result.ok = false;
  result.error = error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
  process.exitCode = 1;
} finally {
  if (handle) await handle.dispose().catch((error) => { result.disposeError = String(error); });
  await save();
  process.stdout.write(JSON.stringify({ ok: result.ok, mode, profileName: result.profileName, stages: result.stages, error: result.error?.message }) + '\n');
  if (application) await application.shutdown.shutdown(process.exitCode ?? 0);
}
