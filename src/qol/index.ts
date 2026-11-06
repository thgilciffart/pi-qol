import { join } from 'node:path';
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from '@earendil-works/pi-coding-agent';
import { errorMessage } from '../shared.ts';
import { parseQolArgs, qolCompletions, targetLabel } from './commands.ts';
import {
  cloneQolConfig, defaultQolConfig, describeFeatures, expandFeatures, loadQolConfig, sameFeatures, saveQolConfig,
  setDomainEnabled, setFeatureEnabled, storeFeatures, type QolConfig,
} from './config.ts';
import { QolEditor, type QolEditorResult } from './editor.ts';
import type { QolTarget } from './features.ts';
import { createCommandRegistry, type CommandRegistry } from './registry.ts';

export interface QolCommandOptions {
  /** Settings file. Defaults to `<agent dir>/pi-qol/qol.json`. */
  configPath?: string;
  /** Handlers collected while enabled features registered; opens their settings UIs. */
  registry?: CommandRegistry;
  /** Problem found in the settings file at extension load, reported once per session. */
  loadError?: string;
}

export { describeFeatures, loadQolConfig, loadQolConfigSync, saveQolConfig, validateQolConfig } from './config.ts';
export { DOMAINS, FEATURES, featuresForDomain } from './features.ts';
export { createCommandRegistry, wrapCommandRegistration } from './registry.ts';

/**
 * The /qol command: tabbed settings for the bundled features, plus headless
 * /qol status and /qol on|off so a broken setup can be recovered without the
 * editor. Always registered, even when every feature is off.
 */
export default function qolCommand(pi: ExtensionAPI, options: QolCommandOptions = {}): void {
  const configPath = options.configPath ?? join(getAgentDir(), 'pi-qol', 'qol.json');
  const registry = options.registry ?? createCommandRegistry();
  let errorReported = false;

  function reportLoadError(ctx: ExtensionContext): void {
    if (!options.loadError || errorReported || !ctx.hasUI) return;
    errorReported = true;
    ctx.ui.notify(`${options.loadError}\nEvery bundled feature is on. The file was not changed; fix it or run /qol reset.`, 'warning');
  }

  pi.on('session_start', (_event, ctx) => reportLoadError(ctx));

  async function persist(next: QolConfig, ctx: ExtensionCommandContext, backupExisting: boolean): Promise<void> {
    const backup = await saveQolConfig(configPath, next, { backupExisting });
    if (backup) ctx.ui.notify(`Kept a copy of the previous invalid settings at ${backup}.`, 'info');
  }

  /** Saved settings only take effect when features register again at load. */
  async function reload(ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.isIdle() || ctx.hasPendingMessages()) {
      ctx.ui.notify('pi-qol settings saved. Run /reload when Pi is idle to apply them.', 'info');
      return;
    }
    try {
      await ctx.reload();
    } catch (error) {
      ctx.ui.notify(`pi-qol settings saved, but reload failed: ${errorMessage(error)} Run /reload to retry.`, 'error');
    }
  }

  async function toggle(enabled: boolean, target: QolTarget, ctx: ExtensionCommandContext): Promise<void> {
    const loaded = await loadQolConfig(configPath);
    const config = cloneQolConfig(loaded.config);
    const changed = target.kind === 'domain'
      ? setDomainEnabled(config, target.id, enabled)
      : setFeatureEnabled(config, target.id, enabled);
    const label = targetLabel(target);
    if (!changed) {
      ctx.ui.notify(`${label} is already ${enabled ? 'on' : 'off'}.`, 'info');
      return;
    }
    await persist(config, ctx, loaded.status === 'invalid');
    ctx.ui.notify(`${label} ${enabled ? 'on' : 'off'}.`, 'info');
    await reload(ctx);
  }

  async function reset(ctx: ExtensionCommandContext): Promise<void> {
    const loaded = await loadQolConfig(configPath);
    if (loaded.status !== 'invalid' && sameFeatures(loaded.config, defaultQolConfig())) {
      ctx.ui.notify('Every bundled feature is already on.', 'info');
      return;
    }
    await persist(defaultQolConfig(), ctx, loaded.status === 'invalid');
    ctx.ui.notify('All bundled features on.', 'info');
    await reload(ctx);
  }

  async function openEditor(ctx: ExtensionCommandContext): Promise<void> {
    const loaded = await loadQolConfig(configPath);
    const draft = expandFeatures(loaded.config);
    const initial = { ...draft };
    let selection = { tab: 0, cursor: 0 };
    let settingsReloadPending = false;
    while (true) {
      const result = await ctx.ui.custom<QolEditorResult>((tui, theme, _keybindings, done) =>
        new QolEditor(tui, theme, {
          draft,
          initial,
          selection,
          loadError: loaded.status === 'invalid' ? loaded.error : undefined,
          settingsAvailable: feature =>
            feature.settingsCommand !== undefined && registry.command(feature.id, feature.settingsCommand) !== undefined,
        }, done));
      if (result.kind === 'cancel') {
        ctx.ui.notify('pi-qol feature changes discarded.', 'info');
        if (settingsReloadPending) await reload(ctx);
        return;
      }
      if (result.kind === 'edit') {
        selection = result.selection;
        const command = result.feature.settingsCommand
          ? registry.command(result.feature.id, result.feature.settingsCommand) : undefined;
        if (!command) {
          ctx.ui.notify(`The ${result.feature.label} settings open when the feature is enabled and reloaded.`, 'info');
          continue;
        }
        // Reuse the feature's own settings UI rather than duplicating its config.
        // A nested plugin picker can request a reload. Defer it until this
        // editor closes so its context and unsaved feature choices stay valid.
        const nestedContext = new Proxy(ctx, {
          get(target, property, receiver) {
            if (property === 'reload') return async () => { settingsReloadPending = true; };
            return Reflect.get(target, property, receiver);
          },
        });
        try { await command.handler('', nestedContext); }
        catch (error) { ctx.ui.notify(`${result.feature.label}: ${errorMessage(error)}`, 'error'); }
        continue;
      }
      const next = storeFeatures(result.features);
      if (loaded.status !== 'invalid' && sameFeatures(loaded.config, next)) {
        ctx.ui.notify('pi-qol settings unchanged.', 'info');
        if (settingsReloadPending) await reload(ctx);
        return;
      }
      await persist(next, ctx, loaded.status === 'invalid');
      ctx.ui.notify('pi-qol settings saved.', 'info');
      await reload(ctx);
      return;
    }
  }

  async function command(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const action = parseQolArgs(args);
    switch (action.kind) {
      case 'reset': return reset(ctx);
      case 'set': return toggle(action.enabled, action.target, ctx);
      case 'status': {
        const loaded = await loadQolConfig(configPath);
        ctx.ui.notify(describeFeatures(loaded.config, configPath, loaded.status === 'invalid' ? loaded.error : undefined), 'info');
        return;
      }
      case 'editor': {
        if (ctx.hasUI && ctx.mode === 'tui') return openEditor(ctx);
        const loaded = await loadQolConfig(configPath);
        ctx.ui.notify(
          `${describeFeatures(loaded.config, configPath, loaded.status === 'invalid' ? loaded.error : undefined)}\nThe settings editor needs the terminal UI.`,
          'info',
        );
      }
    }
  }

  pi.registerCommand('qol', {
    description: 'Configure pi-qol bundled features',
    getArgumentCompletions: qolCompletions,
    handler: async (args, ctx) => {
      try { await command(args, ctx); }
      catch (error) { ctx.ui.notify(`pi-qol: ${errorMessage(error)}`, 'error'); }
    },
  });
}
