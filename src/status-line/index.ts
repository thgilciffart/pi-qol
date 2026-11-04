import { join } from 'node:path';
import {
  getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext,
} from '@earendil-works/pi-coding-agent';
import { errorMessage } from '../shared.ts';
import { parseStatusLineArgs, statusLineCompletions } from './commands.ts';
import {
  cloneConfig, defaultConfig, extensionKey, loadConfig, saveConfig, type StatusLineConfig,
} from './config.ts';
import { StatusData } from './data.ts';
import { StatusLineEditor } from './editor.ts';
import { StatusFooter } from './footer.ts';

export interface StatusLineOptions {
  /** Settings file. Defaults to `<agent dir>/pi-qol/status-line.json`. */
  configPath?: string;
}

function canMountFooter(ctx: ExtensionContext): boolean {
  return ctx.hasUI && ctx.mode === 'tui';
}

function describe(config: StatusLineConfig, path: string): string {
  const shown = config.items.filter(item => item.enabled).map(item => item.id);
  const hidden = config.items.filter(item => !item.enabled && extensionKey(item.id) !== undefined).length;
  return `Status line: ${config.enabled ? 'on' : 'off (Pi built-in footer)'}\nColour: ${config.colorMode}` +
    `\nModules: ${shown.join(', ') || 'none'}` + (hidden ? `\nHidden extension statuses: ${hidden}` : '') +
    `\nNew extension statuses: ${config.showNewExtensionStatuses ? 'shown' : 'hidden'}\nSettings: ${path}`;
}

export default function statusLine(pi: ExtensionAPI, options: StatusLineOptions = {}): void {
  const configPath = options.configPath ?? join(getAgentDir(), 'pi-qol', 'status-line.json');
  const data = new StatusData();
  let config = defaultConfig();
  let loadError: string | undefined;
  let errorReported = false;
  let activeCtx: ExtensionContext | undefined;
  let footer: StatusFooter | undefined;

  const footerDependencies = {
    context: () => activeCtx,
    config: () => config,
    data,
    pi,
    onDispose: (disposed: StatusFooter) => { if (footer === disposed) footer = undefined; },
  };

  async function load(): Promise<void> {
    const result = await loadConfig(configPath);
    const error = result.status === 'invalid' ? result.error : undefined;
    if (loadError !== error) errorReported = false;
    config = result.config;
    loadError = error;
  }

  function reportLoadError(ctx: ExtensionContext): void {
    if (!loadError || errorReported || !ctx.hasUI) return;
    errorReported = true;
    ctx.ui.notify(`${loadError}\nUsing default status line settings. The file was not changed; fix it or run /status-line reset.`, 'warning');
  }

  function apply(ctx: ExtensionContext): void {
    if (!canMountFooter(ctx)) return;
    if (!config.enabled) {
      // Only remove our own footer, so a footer set by another extension stays in place.
      if (footer) ctx.ui.setFooter(undefined);
      return;
    }
    if (footer) { footer.requestRender(); return; }
    ctx.ui.setFooter((tui, theme, footerData) => (footer = new StatusFooter(tui, theme, footerData, footerDependencies)));
  }

  async function persist(update: (latest: StatusLineConfig) => StatusLineConfig, ctx: ExtensionCommandContext,
    expected?: StatusLineConfig): Promise<void> {
    // Another Pi process or a manual repair may have updated the shared file.
    const current = await loadConfig(configPath);
    if (expected && JSON.stringify(current.config) !== JSON.stringify(expected)) {
      throw new Error('Settings changed while the editor was open. Your saved settings were kept. Open /status-line again to edit the latest layout.');
    }
    const next = update(cloneConfig(current.config));
    const backup = await saveConfig(configPath, next, { backupExisting: current.status === 'invalid' });
    config = cloneConfig(next);
    loadError = undefined;
    if (backup) ctx.ui.notify(`Kept a copy of the previous invalid settings at ${backup}.`, 'info');
    apply(ctx);
  }

  async function openEditor(ctx: ExtensionCommandContext): Promise<void> {
    const base = cloneConfig(config);
    const result = await ctx.ui.custom<StatusLineConfig | undefined>((tui, theme, _keybindings, done) =>
      new StatusLineEditor(tui, theme, {
        config: base,
        liveSnapshot: () => data.snapshot(ctx, pi, footer?.footerData),
        discoveryAvailable: footer !== undefined,
      }, done));
    if (!result) { ctx.ui.notify('Status line changes discarded.', 'info'); return; }
    await persist(() => result, ctx, base);
    ctx.ui.notify(result.enabled ? 'Status line saved.' : 'Status line saved. The pi-qol footer is disabled.', 'info');
  }

  async function command(args: string, ctx: ExtensionCommandContext): Promise<void> {
    const action = parseStatusLineArgs(args);
    if (action.kind === 'reset') {
      await persist(() => defaultConfig(), ctx);
      ctx.ui.notify('Status line reset to defaults.', 'info');
      return;
    }
    await load();
    reportLoadError(ctx);
    switch (action.kind) {
      case 'editor':
        if (canMountFooter(ctx)) { apply(ctx); await openEditor(ctx); return; }
        ctx.ui.notify(`${describe(config, configPath)}\nThe interactive editor needs the terminal UI.`, 'info');
        return;
      case 'status':
        ctx.ui.notify(describe(config, configPath), 'info');
        return;
      case 'enabled':
        await persist(latest => ({ ...latest, enabled: action.enabled }), ctx);
        ctx.ui.notify(action.enabled ? 'Status line on.' : 'Status line off. The pi-qol footer is disabled.', 'info');
        return;
      case 'color':
        await persist(latest => ({ ...latest, colorMode: action.mode }), ctx);
        ctx.ui.notify(`Status line colour: ${action.mode}.`, 'info');
    }
  }

  pi.registerCommand('status-line', {
    description: 'Configure the pi-qol status line (footer)',
    getArgumentCompletions: statusLineCompletions,
    handler: async (args, ctx) => {
      try { await command(args, ctx); }
      catch (error) { ctx.ui.notify(`Status line: ${errorMessage(error)}`, 'error'); }
    },
  });

  pi.on('session_start', async (_event, ctx) => {
    activeCtx = ctx;
    // Pi also disposes custom footers when resetting its UI. Cleanup is idempotent.
    footer?.dispose();
    data.invalidate();
    if (!canMountFooter(ctx)) return;
    await load();
    reportLoadError(ctx);
    if (activeCtx === ctx) apply(ctx);
  });

  pi.on('session_shutdown', async () => {
    activeCtx = undefined;
    footer?.dispose();
    data.invalidate();
  });

  const refresh = (invalidate: boolean) => () => {
    if (invalidate) data.invalidate();
    footer?.requestRender();
  };
  pi.on('agent_start', refresh(false));
  pi.on('thinking_level_select', refresh(false));
  pi.on('session_info_changed', refresh(false));
  pi.on('agent_end', refresh(true));
  pi.on('turn_end', refresh(true));
  pi.on('message_end', refresh(true));
  pi.on('model_select', refresh(true));
  pi.on('session_compact', refresh(true));
  pi.on('session_tree', refresh(true));
}
