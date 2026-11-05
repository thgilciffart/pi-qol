import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getPackageDir, type ExtensionCommandContext, type ResolvedPaths, type SettingsManager } from '@earendil-works/pi-coding-agent';
import { matchesKey, truncateToWidth, type Component, type Focusable } from '@earendil-works/pi-tui';
import { keyHints, pickerHeader, scopeState } from '../picker-header.ts';
import { compactResourceList, type NativeResourceList } from './compact-list.ts';

export type PluginScope = 'global' | 'project';
export type PluginPaths = Record<PluginScope, ResolvedPaths>;
type PickerResult = PluginScope | 'save' | 'cancel';

interface NativeSelector extends Component, Focusable {
  getResourceList(): NativeResourceList;
}

// Pi 1.3 does not publicly export its resource picker. Keep that dependency here.
type SelectorConstructor = new (
  paths: PluginPaths, settings: SettingsManager, cwd: string, agentDir: string,
  close: () => void, exit: () => void, render: () => void, height: number,
  scope: PluginScope, projectAvailable: boolean,
) => NativeSelector;

export async function pickPlugins(ctx: ExtensionCommandContext, paths: PluginPaths, settings: SettingsManager,
  agentDir: string, scope: PluginScope, changed = () => false): Promise<PickerResult> {
  const moduleUrl = pathToFileURL(join(getPackageDir(), 'dist/modes/interactive/components/config-selector.js')).href;
  const { ConfigSelectorComponent } = await import(moduleUrl) as { ConfigSelectorComponent: SelectorConstructor };
  // Treat plain project paths as discovery entries, not explicit load overrides.
  // Otherwise a configured file cycles to inherit by deleting its discovery path.
  const pickerSettings = new Proxy(settings, {
    get(target, key) {
      if (key === 'getProjectSettings') return () => {
        const current = target.getProjectSettings();
        return { ...current, extensions: current.extensions?.filter(path => /^[!+-]/.test(path) || /[*?]/.test(path)) };
      };
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return ctx.ui.custom<PickerResult>((tui, theme, keys, done) => {
    let closed = false;
    const finish = (result: PickerResult) => { if (!closed) { closed = true; done(result); } };
    const close = () => finish('cancel');
    const selector = new ConfigSelectorComponent(paths, pickerSettings, ctx.cwd, agentDir, close, close,
      () => tui.requestRender(), tui.terminal.rows, scope, settings.isProjectTrusted());
    compactResourceList(selector.getResourceList(), theme, scope === 'project');
    selector.render = width => {
      const title = scope === 'project' ? 'Project plugins' : 'Global plugins';
      const path = scope === 'project' ? join(ctx.cwd, '.pi/settings.json') : join(agentDir, 'settings.json');
      const trusted = settings.isProjectTrusted();
      // Tab only switches scope in trusted projects, so the scope toggle appears only then.
      const state = [trusted ? scopeState(theme, ['Global', 'Project'], scope === 'global' ? 0 : 1) : '',
        changed() ? theme.fg('warning', 'Unsaved changes') : ''];
      const hints: [string, string][] = [['space', 'toggle'], ['ctrl+s', 'save'], ['esc', 'cancel']];
      if (trusted) hints.unshift(['tab', 'scope']);
      return [
        ...pickerHeader(theme.bold(title), state, width),
        truncateToWidth(theme.fg('muted', path), width, '…'),
        keyHints(theme, hints, width),
        '', ...selector.getResourceList().render(width),
      ];
    };
    // The CLI focuses the resource list itself. Custom dialogs focus their root.
    selector.handleInput = data => {
      if (closed) return;
      if (matchesKey(data, 'ctrl+s')) finish('save');
      else if (settings.isProjectTrusted() && keys.matches(data, 'tui.input.tab')) {
        // Re-resolve from the draft so inherited choices reflect global edits.
        finish(scope === 'global' ? 'project' : 'global');
      } else selector.getResourceList().handleInput?.(data);
    };
    return selector;
  });
}
