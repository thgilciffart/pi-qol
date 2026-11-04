import { join } from 'node:path';
import {
  getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext,
  type ReadonlyFooterDataProvider, type Theme,
} from '@earendil-works/pi-coding-agent';
import type { Component, TUI } from '@earendil-works/pi-tui';
import {
  COLOR_MODES, cloneConfig, defaultConfig, extensionKey, loadConfig, saveConfig,
  type ColorMode, type StatusLineConfig,
} from './config.ts';
import { StatusData } from './data.ts';
import { StatusLineEditor } from './editor.ts';
import { renderStatusLine } from './render.ts';

export interface StatusLineOptions {
  /** Settings file. Defaults to `<agent dir>/pi-qol/status-line.json`. */
  configPath?: string;
}

const COMMANDS = ['on', 'off', 'reset', 'status', 'colorful', 'theme', 'mono'];
const COLOR_ALIASES: Record<string, ColorMode> = {
  colorful: 'colorful', colourful: 'colorful', color: 'colorful', colour: 'colorful',
  theme: 'theme', mono: 'mono', monochrome: 'mono', plain: 'mono',
};

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

  class StatusFooter implements Component {
    private readonly unsubscribe: () => void;
    private disposed = false;

    constructor(private readonly tui: TUI, private readonly theme: Theme, readonly footerData: ReadonlyFooterDataProvider) {
      this.unsubscribe = footerData.onBranchChange(() => tui.requestRender());
    }

    requestRender(): void { this.tui.requestRender(); }

    render(width: number): string[] {
      const ctx = activeCtx;
      if (!ctx || this.disposed) return [];
      try {
        let theme = this.theme;
        try { theme = ctx.ui.theme ?? this.theme; } catch { /* keep the factory theme */ }
        return renderStatusLine(data.snapshot(ctx, pi, this.footerData), config, theme, width);
      } catch { return []; }
    }

    invalidate(): void { data.invalidate(); }

    dispose(): void {
      if (this.disposed) return;
      this.disposed = true;
      this.unsubscribe();
      if (footer === this) footer = undefined;
    }
  }

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
    ctx.ui.setFooter((tui, theme, footerData) => (footer = new StatusFooter(tui, theme, footerData)));
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
    const words = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const action = words[0] === 'color' || words[0] === 'colour' ? words[1] ?? '' : words[0] ?? '';
    if (words.length > (words[0] === 'color' || words[0] === 'colour' ? 2 : 1)) {
      throw new Error('Too many arguments. Use /status-line [on|off|reset|status|colorful|theme|mono].');
    }
    if (action === 'reset') {
      await persist(() => defaultConfig(), ctx);
      ctx.ui.notify('Status line reset to defaults.', 'info');
      return;
    }
    await load();
    reportLoadError(ctx);
    if (!action) {
      if (canMountFooter(ctx)) { apply(ctx); await openEditor(ctx); return; }
      ctx.ui.notify(`${describe(config, configPath)}\nThe interactive editor needs the terminal UI.`, 'info');
      return;
    }
    if (action === 'status') { ctx.ui.notify(describe(config, configPath), 'info'); return; }
    if (action === 'on' || action === 'off') {
      await persist(latest => ({ ...latest, enabled: action === 'on' }), ctx);
      ctx.ui.notify(action === 'on' ? 'Status line on.' : 'Status line off. The pi-qol footer is disabled.', 'info');
      return;
    }
    const mode = COLOR_ALIASES[action];
    if (!mode) throw new Error(`Unknown option "${action}". Use on, off, reset, status, or a colour mode: ${COLOR_MODES.join(', ')}.`);
    await persist(latest => ({ ...latest, colorMode: mode }), ctx);
    ctx.ui.notify(`Status line colour: ${mode}.`, 'info');
  }

  pi.registerCommand('status-line', {
    description: 'Configure the pi-qol status line (footer)',
    getArgumentCompletions: (prefix) => {
      const matches = COMMANDS.filter(value => value.startsWith(prefix.trim().toLowerCase()));
      return matches.length ? matches.map(value => ({ value, label: value })) : null;
    },
    handler: async (args, ctx) => {
      try { await command(args, ctx); }
      catch (error) { ctx.ui.notify(`Status line: ${error instanceof Error ? error.message : String(error)}`, 'error'); }
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
