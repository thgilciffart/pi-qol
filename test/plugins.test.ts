import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultResourceLoader, initTheme, SettingsManager } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences } from '@earendil-works/pi-tui';
import plugins, { discoverPlugins } from '../src/plugins/index.ts';

initTheme('dark');
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

async function fixture(options: { trusted?: boolean; idle?: boolean; pending?: boolean; mode?: string; hasUI?: boolean;
  global?: Record<string, unknown>; project?: Record<string, unknown>; reloadError?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-qol-plugins-'));
  roots.push(root);
  const cwd = join(root, 'project');
  const agentDir = join(root, 'agent');
  const pkg = join(root, 'package');
  const files: Record<string, string> = {
    [join(agentDir, 'extensions', 'auto.ts')]: 'export default function(pi) { pi.registerCommand("auto-fixture", {handler: async () => {}}); }',
    [join(agentDir, 'custom.ts')]: 'export default function() {}',
    [join(cwd, '.pi', 'extensions', 'project.ts')]: 'export default function() {}',
    [join(cwd, '.pi', 'project-custom.ts')]: 'export default function() {}',
    [join(pkg, 'package.json')]: JSON.stringify({ name: 'fixture-plugins', pi: { extensions: ['alpha.ts', 'beta.ts'], skills: ['SKILL.md'], prompts: ['prompt.md'], themes: ['theme.json'] } }),
    [join(pkg, 'alpha.ts')]: 'export default function() {}',
    [join(pkg, 'beta.ts')]: 'export default function() {}',
    [join(pkg, 'SKILL.md')]: '---\nname: fixture\ndescription: Fixture\n---\nFixture',
    [join(pkg, 'prompt.md')]: 'Fixture prompt',
    [join(pkg, 'theme.json')]: '{}',
    [join(agentDir, 'settings.json')]: JSON.stringify({ defaultProvider: 'fixture', packages: [pkg], ...options.global }),
    [join(cwd, '.pi', 'settings.json')]: JSON.stringify(options.project ?? {}),
  };
  await Promise.all(Object.entries(files).map(async ([path, content]) => {
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, content);
  }));
  const notices: { message: string; type?: string }[] = [];
  const frames: string[] = [];
  let command: any;
  let reloads = 0;
  let afterSave: any;
  let picker: any;
  let script = (_component: any) => {};
  const ctx: any = {
    cwd, mode: options.mode ?? 'tui', hasUI: options.hasUI ?? true,
    isIdle: () => options.idle ?? true, hasPendingMessages: () => options.pending ?? false,
    isProjectTrusted: () => options.trusted ?? true,
    reload: async () => {
      reloads++;
      afterSave = JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8'));
      if (options.reloadError) throw new Error(options.reloadError);
    },
    ui: {
      notify: (message: string, type?: string) => notices.push({ message, type }),
      custom: (factory: any) => new Promise(resolve => {
        picker = factory({ terminal: { rows: 40 }, requestRender: () => {} }, {},
          { matches: (data: string, action: string) => action === 'tui.input.tab' && data === '\t' }, resolve);
        picker.focused = true;
        frames.push(stripTerminalSequences(picker.render(130).join('\n')));
        script(picker);
        picker.handleInput('\x1b');
      }),
    },
  };
  plugins({ registerCommand: (_name, value) => { command = value; } } as never, { agentDir });
  return { cwd, agentDir, pkg, ctx, notices, frames,
    run: (args = '', action = (_component: any) => {}) => { script = action; return command.handler(args, ctx); },
    reloads: () => reloads, afterSave: () => afterSave, picker: () => picker,
    discover: () => discoverPlugins(cwd, agentDir, options.trusted ?? true),
    global: async () => JSON.parse(await readFile(join(agentDir, 'settings.json'), 'utf8')),
    project: async () => JSON.parse(await readFile(join(cwd, '.pi', 'settings.json'), 'utf8')),
  };
}

function toggle(component: any, query: string) {
  component.handleInput(query);
  component.handleInput(' ');
}

describe('/plugins', () => {
  test('lists only extensions, including disabled package entries, and cancelling leaves settings unchanged', async () => {
    const h = await fixture({ global: { packages: [] } });
    const original = await h.global();
    await h.run();
    expect(h.frames[0]).toContain('auto.ts');
    expect(h.frames[0]).not.toContain('project.ts');
    expect(h.reloads()).toBe(0);
    expect(await h.global()).toEqual(original);
    expect(h.notices).toEqual([]);

    const other = await fixture();
    const { paths } = await other.discover();
    expect(paths.global.extensions.some(item => item.path.endsWith('alpha.ts'))).toBe(true);
    for (const scope of ['global', 'project'] as const) {
      expect(paths[scope].skills).toEqual([]);
      expect(paths[scope].prompts).toEqual([]);
      expect(paths[scope].themes).toEqual([]);
    }
    await other.run();
    expect(other.frames[0]).not.toContain('SKILL.md');
    expect(other.frames[0]).not.toContain('prompt.md');
  });

  test('disables and re-enables a discovered extension and flushes settings before reload', async () => {
    const h = await fixture();
    await h.run('', component => toggle(component, 'auto.ts'));
    expect(h.notices).toEqual([]);
    expect(h.reloads()).toBe(1);
    expect(h.afterSave().extensions).toContain('-extensions/auto.ts');
    let state = await h.discover();
    expect(state.paths.global.extensions.find(item => item.path.endsWith('auto.ts'))?.enabled).toBe(false);
    await h.run('', component => toggle(component, 'auto.ts'));
    state = await h.discover();
    expect(state.paths.global.extensions.find(item => item.path.endsWith('auto.ts'))?.enabled).toBe(true);
    expect((await h.global()).defaultProvider).toBe('fixture');
    expect(h.reloads()).toBe(2);
  });

  test('disabled explicitly configured files remain discoverable across picker openings', async () => {
    const h = await fixture({ global: { extensions: ['custom.ts'] } });
    await h.run('', component => toggle(component, 'custom.ts'));
    expect((await h.global()).extensions).toEqual(['custom.ts', '-custom.ts']);
    let state = await h.discover();
    expect(state.paths.global.extensions.find(item => item.path.endsWith('/custom.ts'))?.enabled).toBe(false);
    await h.run('', component => toggle(component, 'custom.ts'));
    state = await h.discover();
    expect(state.paths.global.extensions.find(item => item.path.endsWith('/custom.ts'))?.enabled).toBe(true);
  });

  test('package toggles preserve other extensions and resource filters', async () => {
    const h = await fixture();
    const filters = { skills: [], prompts: ['prompt.md'], themes: ['theme.json'] };
    await writeFile(join(h.agentDir, 'settings.json'), JSON.stringify({ packages: [{ source: h.pkg, ...filters }] }));
    await h.run('', component => toggle(component, 'alpha.ts'));
    expect((await h.global()).packages).toEqual([{ source: h.pkg, ...filters, extensions: ['-alpha.ts'] }]);
    let state = await h.discover();
    expect(state.paths.global.extensions.find(item => item.path.endsWith('/alpha.ts'))?.enabled).toBe(false);
    expect(state.paths.global.extensions.find(item => item.path.endsWith('/beta.ts'))?.enabled).toBe(true);
    await h.run('', component => toggle(component, 'alpha.ts'));
    state = await h.discover();
    expect(state.paths.global.extensions.find(item => item.path.endsWith('/alpha.ts'))?.enabled).toBe(true);
    expect((await h.global()).packages[0]).toMatchObject(filters);
  });

  test('explicit project extension paths stay discoverable after disabling', async () => {
    const h = await fixture({ project: { extensions: ['project-custom.ts'] } });
    await h.run('project', component => toggle(component, 'project-custom.ts'));
    expect((await h.project()).extensions).toEqual(['project-custom.ts', '-project-custom.ts']);
    let state = await h.discover();
    expect(state.paths.project.extensions.find(item => item.path.endsWith('/project-custom.ts'))?.enabled).toBe(false);
    await h.run('project', component => toggle(component, 'project-custom.ts'));
    state = await h.discover();
    expect(state.paths.project.extensions.find(item => item.path.endsWith('/project-custom.ts'))?.enabled).toBe(true);
  });

  test('project mode toggles local extensions without modifying global settings', async () => {
    const h = await fixture();
    const original = await h.global();
    await h.run('project', component => toggle(component, 'project.ts'));
    expect(await h.global()).toEqual(original);
    expect((await h.project()).extensions).toContain('-extensions/project.ts');
    const { paths } = await h.discover();
    expect(paths.project.extensions.find(item => item.path.endsWith('/project.ts'))?.enabled).toBe(false);
  });

  test('Tab switches scope and inherited extensions cycle through project overrides', async () => {
    const h = await fixture();
    let opens = 0;
    await h.run('', component => {
      if (opens++ === 0) component.handleInput('\t');
      else toggle(component, 'auto.ts');
    });
    expect((await h.global()).extensions).toBeUndefined();
    let state = await h.discover();
    expect(state.paths.global.extensions.find(item => item.path.endsWith('/auto.ts'))?.enabled).toBe(true);
    expect(state.paths.project.extensions.find(item => item.path.endsWith('/auto.ts'))?.enabled).toBe(false);
    await h.run('project', component => toggle(component, 'auto.ts'));
    state = await h.discover();
    expect(state.paths.project.extensions.find(item => item.path.endsWith('/auto.ts'))?.enabled).toBe(true);
    await h.run('project', component => toggle(component, 'auto.ts'));
    expect((await h.project()).extensions).toEqual([]);
  });

  test('switching scope refreshes inherited choices after a global toggle', async () => {
    const h = await fixture();
    let opens = 0;
    await h.run('', component => {
      toggle(component, 'auto.ts');
      if (opens++ === 0) component.handleInput('\t');
    });
    const { paths } = await h.discover();
    // Project inherit starts disabled after the global toggle, then cycles to load.
    expect(paths.global.extensions.find(item => item.path.endsWith('/auto.ts'))?.enabled).toBe(false);
    expect(paths.project.extensions.find(item => item.path.endsWith('/auto.ts'))?.enabled).toBe(true);
    expect((await h.project()).extensions).toContain(`+${join(h.agentDir, 'extensions', 'auto.ts')}`);
    expect(h.reloads()).toBe(1);
  });

  test('project package overrides do not modify global package configuration', async () => {
    const h = await fixture();
    await h.run('project', component => toggle(component, 'alpha.ts'));
    expect((await h.global()).packages).toEqual([h.pkg]);
    expect((await h.project()).packages[0]).toMatchObject({ autoload: false, extensions: ['-alpha.ts'] });
    const { paths } = await h.discover();
    expect(paths.global.extensions.find(item => item.path.endsWith('/alpha.ts'))?.enabled).toBe(true);
    expect(paths.project.extensions.find(item => item.path.endsWith('/alpha.ts'))?.enabled).toBe(false);
    expect(paths.project.extensions.find(item => item.path.endsWith('/beta.ts'))?.enabled).toBe(true);
  });

  test('untrusted projects expose global resources without allowing project writes', async () => {
    const h = await fixture({ trusted: false });
    const { paths } = await h.discover();
    expect(paths.project.extensions.some(item => item.path.endsWith('/project.ts'))).toBe(false);
    await h.run('project');
    expect(h.notices.at(-1)?.message).toContain('Trust this project');
    expect(h.frames).toEqual([]);
    await h.run('', component => { component.handleInput('\t'); toggle(component, 'auto.ts'); });
    expect((await h.global()).extensions).toContain('-extensions/auto.ts');
    expect(await h.project()).toEqual({});
  });

  test('busy or queued work and unsupported interfaces do not open the picker', async () => {
    for (const options of [{ idle: false }, { pending: true }, { mode: 'rpc' }, { hasUI: false }]) {
      const h = await fixture(options);
      await h.run();
      expect(h.frames).toEqual([]);
      expect(h.reloads()).toBe(0);
      expect(h.notices).toHaveLength(1);
    }
  });

  test('new work during the picker defers reload but retains the saved setting', async () => {
    const h = await fixture();
    await h.run('', component => { toggle(component, 'auto.ts'); h.ctx.isIdle = () => false; });
    expect(h.reloads()).toBe(0);
    expect((await h.global()).extensions).toContain('-extensions/auto.ts');
    expect(h.notices.at(-1)?.message).toContain('Run /reload');
  });

  test('settings errors and reload failures explain recovery without losing preferences', async () => {
    const h = await fixture({ reloadError: 'fixture reload failed' });
    await h.run('', component => toggle(component, 'auto.ts'));
    expect(h.notices.at(-1)).toMatchObject({ type: 'error' });
    expect(h.notices.at(-1)?.message).toContain('settings saved, but reload failed');
    expect((await h.global()).extensions).toContain('-extensions/auto.ts');
    await writeFile(join(h.agentDir, 'settings.json'), '{invalid');
    await h.run();
    expect(h.notices.at(-1)?.message).toContain('global settings:');
    expect(await readFile(join(h.agentDir, 'settings.json'), 'utf8')).toBe('{invalid');
  });

  test('invalid arguments leave settings untouched', async () => {
    const h = await fixture();
    await h.run('off');
    expect(h.notices.at(-1)).toEqual({ message: 'Usage: /plugins [global|project]', type: 'error' });
    expect(h.frames).toEqual([]);
  });

  test('no installed extensions produces a notice without opening or reloading', async () => {
    const h = await fixture({ global: { packages: [] } });
    await rm(join(h.agentDir, 'extensions'), { recursive: true });
    await rm(join(h.cwd, '.pi', 'extensions'), { recursive: true });
    await h.run();
    expect(h.notices.at(-1)?.message).toBe('No installed Pi extensions found.');
    expect(h.frames).toEqual([]);
    expect(h.reloads()).toBe(0);
  });

  test('Pi actually unloads and reloads a toggled extension', async () => {
    const h = await fixture({ global: { packages: [] } });
    const settingsManager = SettingsManager.create(h.cwd, h.agentDir);
    const loader = new DefaultResourceLoader({ cwd: h.cwd, agentDir: h.agentDir, settingsManager });
    const loaded = () => loader.getExtensions().extensions.some(extension => extension.commands.has('auto-fixture'));
    await loader.reload();
    expect(loaded()).toBe(true);
    await h.run('', component => toggle(component, 'auto.ts'));
    await loader.reload();
    expect(loaded()).toBe(false);
    await h.run('', component => toggle(component, 'auto.ts'));
    await loader.reload();
    expect(loaded()).toBe(true);
  });
});
