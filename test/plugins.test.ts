import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DefaultResourceLoader, initTheme, SettingsManager } from '@earendil-works/pi-coding-agent';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
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
  let script: (component: any) => void | Promise<void> = () => {};
  let exit = '\x13';
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
      custom: (factory: any) => new Promise((resolve, reject) => {
        picker = factory({ terminal: { rows: 40 }, requestRender: () => {} },
          { fg: (_color: string, text: string) => text, bold: (text: string) => text },
          { matches: (data: string, action: string) => action === 'tui.input.tab' && data === '\t' }, resolve);
        picker.focused = true;
        frames.push(stripTerminalSequences(picker.render(130).join('\n')));
        Promise.resolve(script(picker)).then(() => picker.handleInput(exit), reject);
      }),
    },
  };
  plugins({ registerCommand: (_name, value) => { command = value; } } as never, { agentDir });
  return { cwd, agentDir, pkg, ctx, notices, frames,
    run: (args = '', action: (component: any) => void | Promise<void> = () => {}, close = '\x13') => {
      script = action; exit = close; return command.handler(args, ctx);
    },
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

function text(component: any, width = 130): string {
  return stripTerminalSequences(component.render(width).join('\n'));
}

function selectedLine(component: any): string | undefined {
  return text(component).split('\n').find(line => line.startsWith('> ') && /\[[x +\-]?\]/.test(line));
}

describe('/plugins', () => {
  test('configured extensions with the same filename retain their folders and independent toggles', async () => {
    for (const directoryEntry of [true, false]) {
      const h = await fixture({ global: { packages: [], extensions: directoryEntry
        ? ['../exts'] : ['../exts/foo/index.ts', '../exts/bar/index.ts'] } });
      const root = join(dirname(h.agentDir), 'exts');
      for (const name of ['foo', 'bar']) {
        await mkdir(join(root, name), { recursive: true });
        await writeFile(join(root, name, 'index.ts'), 'export default function() {}');
      }
      await h.run('', component => {
        component.handleInput('exts');
        const frame = text(component);
        expect(frame).toContain('exts');
        expect(frame).toContain('├─ bar');
        expect(frame).toContain('└─ foo');
        expect(frame.match(/\[x\] index\.ts/g)).toHaveLength(2);
        component.handleInput(' ');
        expect(text(component)).toContain('[ ] index.ts');
        expect(selectedLine(component)).toContain('[x] index.ts');
        component.handleInput(' ');
        expect(text(component).match(/\[ \] index\.ts/g)).toHaveLength(2);
      });
      const state = await h.discover();
      const configured = state.paths.global.extensions.filter(item => item.path.startsWith(root));
      expect(configured).toHaveLength(2);
      expect(configured.every(item => !item.enabled)).toBe(true);
      await h.run('', component => {
        component.handleInput('bar/index.ts');
        expect(text(component)).toContain('bar');
        expect(text(component)).not.toContain('foo');
        component.handleInput(' ');
      });
      const enabled = (await h.discover()).paths.global.extensions.filter(item => item.path.startsWith(root) && item.enabled);
      expect(enabled.map(item => item.path)).toEqual([join(root, 'bar/index.ts')]);
    }
  });

  test('a lone auto-discovered directory extension keeps its folder context', async () => {
    const h = await fixture({ global: { packages: [] } });
    await rm(join(h.agentDir, 'extensions/auto.ts'));
    await mkdir(join(h.agentDir, 'extensions/my-ext'), { recursive: true });
    await writeFile(join(h.agentDir, 'extensions/my-ext/index.ts'), 'export default function() {}');
    await h.run('', component => {
      expect(text(component)).toContain('User (');
      expect(text(component)).toContain('└─ extensions');
      expect(text(component)).toContain('└─ my-ext');
      expect(selectedLine(component)).toContain('[x] index.ts');
      component.handleInput(' ');
    });
    expect((await h.discover()).paths.global.extensions.find(item => item.path.endsWith('/my-ext/index.ts'))?.enabled).toBe(false);
  });

  test('top-level resources are not matched by their internal discovery source names', async () => {
    const h = await fixture({ global: { packages: [], extensions: ['custom.ts'] } });
    await rm(join(h.agentDir, 'extensions/auto.ts'));
    await writeFile(join(h.agentDir, 'extensions/one.ts'), 'export default function() {}');
    await writeFile(join(h.agentDir, 'extensions/two.ts'), 'export default function() {}');
    for (const query of ['auto', 'local']) {
      await h.run('', component => {
        component.handleInput(query);
        expect(text(component)).toContain('No extensions found');
      });
    }
  });

  test('single-extension packages use one checkbox row and remain searchable by their hidden filename', async () => {
    const h = await fixture();
    await writeFile(join(h.pkg, 'package.json'), JSON.stringify({ pi: { extensions: ['alpha.ts'] } }));
    await h.run('', component => {
      const frame = text(component);
      expect(frame.split('\n').filter(line => line.includes(h.pkg))).toEqual([`> [x] ${h.pkg} (user)`]);
      expect(frame).not.toContain('alpha.ts');
      expect(frame).not.toMatch(/^\s+Extensions$/m);
      component.handleInput('alpha.ts');
      expect(selectedLine(component)).toContain(h.pkg);
      component.handleInput(' ');
      expect(selectedLine(component)).toContain('[ ]');
    });
    expect((await h.global()).packages[0].extensions).toEqual(['-alpha.ts']);
  });

  test('multi-extension packages show their folder tree and advance through files across packages', async () => {
    const h = await fixture();
    const extensions = ['src/zeta.ts', 'src/commands/one.ts', 'src/commands/two.ts', 'root.ts'];
    for (const path of extensions) {
      await mkdir(dirname(join(h.pkg, path)), { recursive: true });
      await writeFile(join(h.pkg, path), 'export default function() {}');
    }
    await writeFile(join(h.pkg, 'package.json'), JSON.stringify({ pi: { extensions } }));
    await h.run('', component => {
      const frame = text(component);
      expect(frame).toContain('├─ [x] root.ts');
      expect(frame).toContain('└─ src');
      expect(frame).toContain('   ├─ commands');
      expect(frame).toContain('   │  ├─ [x] one.ts');
      expect(frame).toContain('   │  └─ [x] two.ts');
      expect(frame).toContain('   └─ [x] zeta.ts');
      expect(frame).not.toContain('src/zeta.ts');
      expect(selectedLine(component)).toContain('root.ts');
      for (const next of ['one.ts', 'two.ts', 'zeta.ts', 'auto.ts']) {
        component.handleInput(' ');
        expect(selectedLine(component)).toContain(next);
      }
      // The final toggle stays on the last target rather than wrapping.
      component.handleInput('\r');
      expect(selectedLine(component)).toContain('auto.ts');
      expect(selectedLine(component)).toContain('[ ]');
    });
    expect((await h.global()).packages[0].extensions).toEqual(extensions.map(path => `-${path}`).sort());
  });

  test('filtering a multi-extension package keeps its tree and advances only through matches', async () => {
    const h = await fixture();
    await h.run('', component => {
      component.handleInput(h.pkg);
      expect(selectedLine(component)).toContain('alpha.ts');
      expect(text(component)).toContain('├─ [x] alpha.ts');
      component.handleInput('\r');
      expect(selectedLine(component)).toContain('beta.ts');
      component.handleInput(' ');
      expect(selectedLine(component)).toContain('beta.ts');
      expect(text(component)).not.toContain('auto.ts');
    });
    const alpha = await fixture();
    await alpha.run('', component => {
      component.handleInput('alpha.ts');
      expect(text(component)).toContain(alpha.pkg);
      expect(text(component)).toContain('└─ [x] alpha.ts');
      component.handleInput(' ');
      expect(selectedLine(component)).toContain('alpha.ts');
      component.handleInput('\x15');
      component.handleInput('nothing-matches');
      expect(text(component)).toContain('No extensions found');
    });
  });

  test('tree navigation skips directories and keeps selection visible while scrolling', async () => {
    const h = await fixture();
    const extensions = Array.from({ length: 45 }, (_, index) => `src/commands/file-${String(index).padStart(2, '0')}.ts`);
    await mkdir(join(h.pkg, 'src/commands'), { recursive: true });
    await Promise.all(extensions.map(path => writeFile(join(h.pkg, path), 'export default function() {}')));
    await writeFile(join(h.pkg, 'package.json'), JSON.stringify({ pi: { extensions } }));
    await h.run('', component => {
      for (let index = 0; index < 38; index++) component.handleInput('\x1b[B');
      expect(selectedLine(component)).toContain('file-38.ts');
      expect(text(component)).toContain(h.pkg);
      expect(text(component)).toContain('src');
      expect(text(component)).toContain('commands');
      component.handleInput(' ');
      expect(selectedLine(component)).toContain('file-39.ts');
      component.handleInput('\x1b[A');
      expect(selectedLine(component)).toContain('file-38.ts');
      expect(selectedLine(component)).toContain('[ ]');
      for (const width of [25, 55, 100]) {
        expect(component.render(width).every((line: string) => visibleWidth(line) <= width)).toBe(true);
      }
    });
    expect((await h.global()).packages[0].extensions).toEqual(['-src/commands/file-38.ts']);
  });

  test('project overrides keep their indicators and advance after a toggle', async () => {
    const h = await fixture();
    await h.run('project', component => {
      component.handleInput(h.pkg);
      expect(text(component)).toContain(`${h.pkg} (user) · inherited global`);
      expect(selectedLine(component)).toContain('alpha.ts');
      component.handleInput(' ');
      expect(selectedLine(component)).toContain('beta.ts');
      component.handleInput('\x1b[A');
      expect(selectedLine(component)).toContain('[-]');
      expect(selectedLine(component)).toContain('project unload');
      component.handleInput(' ');
      expect(selectedLine(component)).toContain('beta.ts');
      component.handleInput('\x1b[A');
      expect(selectedLine(component)).toContain('[+]');
      expect(selectedLine(component)).toContain('project load');
      component.handleInput(' ');
      expect(selectedLine(component)).toContain('beta.ts');
      component.handleInput('\x1b[A');
      expect(selectedLine(component)).toContain('[x]');
      expect(selectedLine(component)).toContain('inherited global');
    });
  });

  test('lists only extensions, including disabled package entries, and cancelling leaves settings unchanged', async () => {
    const h = await fixture({ global: { packages: [] } });
    const original = await h.global();
    await h.run('', () => {}, '\x1b');
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

  test('toggles stay in memory until Ctrl+S saves, preserving unrelated settings before reload', async () => {
    const h = await fixture();
    const before = await h.global();
    await h.run('', async component => {
      expect(text(component)).toContain('ctrl+s save');
      const header = () => text(component).split('\n')[0];
      expect(header()).toMatch(/^Global plugins +◉ Global \| ○ Project$/);
      toggle(component, 'auto.ts');
      expect(header()).toMatch(/^Global plugins +◉ Global \| ○ Project {2}Unsaved changes$/);
      expect(text(component, 40).split('\n').slice(0, 2)).toEqual(['Global plugins', '   ◉ Global | ○ Project  Unsaved changes']);
      expect(await h.global()).toEqual(before);
      expect(h.reloads()).toBe(0);
      await writeFile(join(h.agentDir, 'settings.json'), JSON.stringify({ ...before, defaultProvider: 'edited-elsewhere' }));
    });
    expect(h.notices).toEqual([]);
    expect(h.reloads()).toBe(1);
    expect(h.afterSave().extensions).toContain('-extensions/auto.ts');
    let state = await h.discover();
    expect(state.paths.global.extensions.find(item => item.path.endsWith('auto.ts'))?.enabled).toBe(false);
    await h.run('', component => toggle(component, 'auto.ts'));
    state = await h.discover();
    expect(state.paths.global.extensions.find(item => item.path.endsWith('auto.ts'))?.enabled).toBe(true);
    expect((await h.global()).defaultProvider).toBe('edited-elsewhere');
    expect(h.reloads()).toBe(2);
  });

  test('Escape and Ctrl+C discard drafts in both scopes, including after switching scope', async () => {
    for (const close of ['\x1b', '\x03']) {
      const h = await fixture();
      const global = await h.global();
      const project = await h.project();
      let opens = 0;
      await h.run('', async component => {
        if (opens++ === 0) {
          toggle(component, 'auto.ts');
          expect(await h.global()).toEqual(global);
          component.handleInput('\t');
        } else {
          toggle(component, 'project.ts');
          expect(text(component).split('\n')[0]).toMatch(/^Project plugins +○ Global \| ◉ Project {2}Unsaved changes$/);
          expect(await h.global()).toEqual(global);
          expect(await h.project()).toEqual(project);
        }
      }, close);
      expect(await h.global()).toEqual(global);
      expect(await h.project()).toEqual(project);
      expect(h.reloads()).toBe(0);
      expect(h.notices).toEqual([]);
    }
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
    const globalBefore = await h.global();
    const projectBefore = await h.project();
    let opens = 0;
    await h.run('', async component => {
      toggle(component, 'auto.ts');
      expect(await h.global()).toEqual(globalBefore);
      expect(await h.project()).toEqual(projectBefore);
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
