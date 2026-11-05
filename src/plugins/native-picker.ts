import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getPackageDir, type ExtensionCommandContext, type ResolvedPaths, type SettingsManager } from '@earendil-works/pi-coding-agent';
import type { Component, Focusable } from '@earendil-works/pi-tui';

export type PluginScope = 'global' | 'project';
export type PluginPaths = Record<PluginScope, ResolvedPaths>;

interface NativeSelector extends Component, Focusable {
  getResourceList(): Component;
}

// Pi 1.3 does not publicly export its resource picker. Keep that dependency here.
type SelectorConstructor = new (
  paths: PluginPaths, settings: SettingsManager, cwd: string, agentDir: string,
  close: () => void, exit: () => void, render: () => void, height: number,
  scope: PluginScope, projectAvailable: boolean,
) => NativeSelector;

export async function pickPlugins(ctx: ExtensionCommandContext, paths: PluginPaths, settings: SettingsManager,
  agentDir: string, scope: PluginScope): Promise<PluginScope | undefined> {
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
  return ctx.ui.custom<PluginScope | undefined>((tui, _theme, keys, done) => {
    const close = () => done(undefined);
    const selector = new ConfigSelectorComponent(paths, pickerSettings, ctx.cwd, agentDir, close, close,
      () => tui.requestRender(), tui.terminal.rows, scope, settings.isProjectTrusted());
    // The CLI focuses the resource list itself. Custom dialogs focus their root.
    selector.handleInput = data => {
      if (settings.isProjectTrusted() && keys.matches(data, 'tui.input.tab')) {
        // Re-resolve after flushing so inherited choices reflect global edits.
        done(scope === 'global' ? 'project' : 'global');
      } else selector.getResourceList().handleInput?.(data);
    };
    return selector;
  });
}
