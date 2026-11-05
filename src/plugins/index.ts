import { DefaultPackageManager, getAgentDir, SettingsManager,
  type ExtensionAPI, type ResolvedPaths } from '@earendil-works/pi-coding-agent';
import { completions, errorMessage } from '../shared.ts';
import { pickPlugins, type PluginScope } from './native-picker.ts';
import { createPluginDraft } from './draft.ts';

function checkSettings(settings: SettingsManager): void {
  const errors = settings.drainErrors();
  if (errors.length) throw new Error(errors.map(({ scope, error }) => `${scope} settings: ${error.message}`).join('\n'));
}

function extensionsOnly(paths: ResolvedPaths): ResolvedPaths {
  return { extensions: paths.extensions, skills: [], prompts: [], themes: [] };
}

function preserveDiscoveryEntries(current: string[], next: string[], inherited = new Set<string>()): string[] {
  // Native toggles can replace an exact relative discovery path with a -pattern.
  // Keep the discovery path so a disabled, explicitly configured file stays listed.
  const plain = current.filter(path => !/^[!+-]/.test(path) && !/[*?]/.test(path) && !inherited.has(path));
  return [...new Set([...plain, ...next])];
}

export async function discoverPlugins(cwd: string, agentDir: string, projectTrusted: boolean,
  settings = SettingsManager.create(cwd, agentDir, { projectTrusted })) {
  const globalSettings = SettingsManager.fromStorage({
    withLock(scope, read) { read(scope === 'global' ? JSON.stringify(settings.getGlobalSettings()) : undefined); },
  }, { projectTrusted: false });
  checkSettings(settings);
  checkSettings(globalSettings);
  const resolve = (manager: SettingsManager) => new DefaultPackageManager({ cwd, agentDir, settingsManager: manager })
    .resolve(async () => 'skip');
  const [global, project] = await Promise.all([resolve(globalSettings), projectTrusted ? resolve(settings) : Promise.resolve(undefined)]);

  return { settings, paths: { global: extensionsOnly(global), project: extensionsOnly(project ?? global) } };
}

export default function plugins(pi: ExtensionAPI, options: { agentDir?: string } = {}): void {
  pi.registerCommand('plugins', {
    description: 'Enable or disable installed Pi extensions',
    getArgumentCompletions: prefix => completions(['global', 'project'], prefix),
    handler: async (args, ctx) => {
      try {
        const scope = args.trim() || 'global';
        if (scope !== 'global' && scope !== 'project') throw new Error('Usage: /plugins [global|project]');
        if (!ctx.hasUI || ctx.mode !== 'tui') throw new Error('/plugins requires the interactive terminal UI. Use pi config from a terminal.');
        if (!ctx.isIdle() || ctx.hasPendingMessages()) {
          ctx.ui.notify('Pi is working or has queued messages. Pause work before changing plugins.', 'info');
          return;
        }
        if (scope === 'project' && !ctx.isProjectTrusted()) throw new Error('Trust this project in Pi before changing its plugins.');
        const agentDir = options.agentDir ?? getAgentDir();
        const source = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() });
        checkSettings(source);
        const draft = createPluginDraft(source);
        const settings = draft.settings;
        let { paths } = await discoverPlugins(ctx.cwd, agentDir, ctx.isProjectTrusted(), settings);
        if (!paths.global.extensions.length && !paths.project.extensions.length) {
          ctx.ui.notify('No installed Pi extensions found.', 'info');
          return;
        }
        const setGlobalPaths = settings.setExtensionPaths.bind(settings);
        const setProjectPaths = settings.setProjectExtensionPaths.bind(settings);
        const inherited = new Set(paths.global.extensions.map(item => item.path));
        settings.setExtensionPaths = paths => setGlobalPaths(preserveDiscoveryEntries(settings.getGlobalSettings().extensions ?? [], paths));
        settings.setProjectExtensionPaths = paths => setProjectPaths(preserveDiscoveryEntries(settings.getProjectSettings().extensions ?? [], paths, inherited));
        let writeScope: PluginScope = scope;
        while (true) {
          const result = await pickPlugins(ctx, paths, settings, agentDir, writeScope, draft.changed);
          await settings.flush();
          checkSettings(settings);
          if (result === 'cancel') return;
          if (result === 'save') break;
          writeScope = result;
          ({ paths } = await discoverPlugins(ctx.cwd, agentDir, ctx.isProjectTrusted(), settings));
        }
        if (!draft.changed()) return;
        await draft.save(ctx.cwd, agentDir);
        if (!ctx.isIdle() || ctx.hasPendingMessages()) {
          ctx.ui.notify('Plugin settings saved. Run /reload when Pi is idle to apply them.', 'info');
          return;
        }
        try {
          await ctx.reload();
        } catch (error) {
          throw new Error(`Plugin settings saved, but reload failed: ${errorMessage(error)} Run /reload to retry.`);
        }
      } catch (error) {
        ctx.ui.notify(errorMessage(error), 'error');
      }
    },
  });
}
